"""Run an analysis in a child process.

OpenCascade is native code: some malformed files (for instance truncated IGES)
crash it with a segmentation fault, and others make it loop forever. Running
each analysis of the web server in its own process turns both cases into a
normal error instead of taking the whole server down. The child can also be
stopped at any time (the client went away), and its memory is bounded.
"""

from __future__ import annotations

import math
import multiprocessing as mp
import os
import sys
import threading
import time
from pathlib import Path

ANALYSIS_TIMEOUT_S = 600
POLL_S = 0.5  # how often a running analysis checks its cancel event and memory
# Memory an analysis may use on top of the loaded reader, unless READER3D_MAX_MEMORY says otherwise.
DEFAULT_MAX_MEMORY = 3 << 30

# "forkserver" starts every analysis from a process that has already imported
# OpenCascade, so the isolation costs milliseconds instead of a full start-up.
if "forkserver" in mp.get_all_start_methods():
    # The forkserver is a new interpreter: Python 3.10-3.12 ignore the parent's
    # sys.path there and silently skip a preload that fails to import, so make
    # reader3d importable through PYTHONPATH wherever the server was started.
    _ROOT = str(Path(__file__).resolve().parent.parent)
    _PATHS = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    if _ROOT not in _PATHS:
        os.environ["PYTHONPATH"] = os.pathsep.join([_ROOT, *_PATHS])
    _CTX = mp.get_context("forkserver")
    _CTX.set_forkserver_preload(["reader3d.analyze"])
else:  # Windows
    _CTX = mp.get_context("spawn")


class AnalysisCrashed(RuntimeError):
    """The reader died or did not finish in time."""


class AnalysisCancelled(AnalysisCrashed):
    """The analysis was stopped through its cancel event."""


def max_memory() -> int | None:
    """Bytes of memory an analysis may use (READER3D_MAX_MEMORY, e.g. 3G; 0 for no limit)."""
    value = os.environ.get("READER3D_MAX_MEMORY", "").strip()
    if not value:
        return DEFAULT_MAX_MEMORY
    scale = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30}.get(value[-1].upper(), 1)
    try:
        limit = float(value[:-1] if scale > 1 else value) * scale
    except ValueError:
        limit = math.nan
    if not 0 <= limit < math.inf:
        raise ValueError(f"READER3D_MAX_MEMORY must be a number of bytes, optionally followed by K, M or G (got '{value}')")
    return int(limit) or None


def _out_of_memory(memory: int | None) -> str:
    size = f"{memory / 2**30:g} GiB" if memory and memory >= 1 << 30 else f"{(memory or 0) / 2**20:g} MiB"
    limit = f"its memory limit of {size} (READER3D_MAX_MEMORY)" if memory else "the available memory"
    return f"The file is too large or too complex to analyse: the analysis used up {limit}"


def _address_space(pid: int | str) -> tuple[int, float]:
    """Address space of a running process and its limit, in bytes (Linux only, else (0, inf))."""
    try:
        with open(f"/proc/{pid}/statm") as f:
            size = int(f.read().split()[0]) * os.sysconf("SC_PAGE_SIZE")
        with open(f"/proc/{pid}/limits") as f:
            soft = next(line.split()[3] for line in f if line.startswith("Max address space"))
        return size, math.inf if soft == "unlimited" else int(soft)
    except (OSError, ValueError, StopIteration, AttributeError):
        return 0, math.inf


def _limit_memory(memory: int | None) -> None:
    """Cap the address space of this (child) process at what it maps now plus
    `memory`, so that a runaway analysis fails instead of exhausting the host."""
    if memory is None:
        return
    try:
        import resource
    except ImportError:  # Windows
        return
    limit = memory + _address_space("self")[0]  # the loaded reader already maps ~1 GB of libraries
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    if hard != resource.RLIM_INFINITY:
        limit = min(limit, hard)
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit, hard))
    except (ValueError, OSError):  # not supported (macOS)
        pass


def _finite(value):
    """`value` with NaN and infinities replaced by None: results end up as JSON."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def _run(conn, path: str, unit: str, quality: str, include_mesh: bool, memory: int | None) -> None:
    # OpenCascade prints messages on stdout (e.g. "Total number of loaded
    # entities" for IGES): keep stdout for the results, as `analyze --json` prints.
    try:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    except (OSError, ValueError, AttributeError):
        pass
    _limit_memory(memory)
    from .analyze import analyze_file

    try:
        conn.send(("ok", _finite(analyze_file(path, unit, quality, include_mesh=include_mesh))))
    except ValueError as exc:
        conn.send(("value_error", str(exc)))
    except MemoryError:
        conn.send(("value_error", _out_of_memory(memory)))
    except Exception as exc:  # noqa: BLE001 - reported to the client
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def analyze_isolated(
    path: str | Path,
    unit: str = "auto",
    quality: str = "normal",
    timeout: float = ANALYSIS_TIMEOUT_S,
    cancel: threading.Event | None = None,
    include_mesh: bool = True,
) -> dict:
    """Same as analyze_file, in a child process (non-finite numbers come back as None).

    Raises ValueError for unreadable or unsupported files (like analyze_file)
    and for files that need more memory than READER3D_MAX_MEMORY, and
    AnalysisCrashed when the reader crashes or exceeds `timeout` seconds.
    Setting `cancel` kills the child within POLL_S and raises AnalysisCancelled.
    """
    memory = max_memory()
    if cancel is not None and cancel.is_set():
        raise AnalysisCancelled("The analysis was cancelled")
    receiver, sender = _CTX.Pipe(duplex=False)
    proc = _CTX.Process(target=_run, args=(sender, str(path), unit, quality, include_mesh, memory), daemon=True)
    proc.start()
    sender.close()  # only the child writes; EOF then means the child is gone
    deadline = time.monotonic() + timeout
    # Highest share of its address-space limit the child was seen using: when
    # memory runs out, Python or OpenCascade may abort instead of raising MemoryError.
    peak = 0.0
    try:
        while not receiver.poll(max(0.0, min(POLL_S, deadline - time.monotonic()))):
            size, limit = _address_space(proc.pid)
            peak = max(peak, size / limit)
            if cancel is not None and cancel.is_set():
                raise AnalysisCancelled("The analysis was cancelled")
            if time.monotonic() >= deadline:
                raise AnalysisCrashed(f"The analysis did not finish within {timeout:.0f} s")
        try:
            status, payload = receiver.recv()  # read before join(): large results fill the pipe
        except EOFError:
            status, payload = "crashed", None
        if status in ("crashed", "error") and peak > 0.9:
            status, payload = "value_error", _out_of_memory(memory)
        if status == "crashed":
            proc.join(5)
            raise AnalysisCrashed(f"The reader crashed on this file (exit code {proc.exitcode})")
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join()
        receiver.close()

    if status == "ok":
        return payload
    if status == "value_error":
        raise ValueError(payload)
    raise AnalysisCrashed(payload)
