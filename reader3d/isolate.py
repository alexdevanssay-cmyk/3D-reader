"""Run an analysis in a child process.

OpenCascade is native code: some malformed files (for instance truncated IGES)
crash it with a segmentation fault, and others make it loop forever. Running
each analysis of the web server in its own process turns both cases into a
normal error instead of taking the whole server down.
"""

from __future__ import annotations

import multiprocessing as mp
from pathlib import Path

ANALYSIS_TIMEOUT_S = 600

# "forkserver" starts every analysis from a process that has already imported
# OpenCascade, so the isolation costs milliseconds instead of a full start-up.
if "forkserver" in mp.get_all_start_methods():
    _CTX = mp.get_context("forkserver")
    _CTX.set_forkserver_preload(["reader3d.analyze"])
else:  # Windows
    _CTX = mp.get_context("spawn")


class AnalysisCrashed(RuntimeError):
    """The reader died or did not finish in time."""


def _run(conn, path: str, unit: str, quality: str) -> None:
    from .analyze import analyze_file

    try:
        conn.send(("ok", analyze_file(path, unit, quality)))
    except ValueError as exc:
        conn.send(("value_error", str(exc)))
    except Exception as exc:  # noqa: BLE001 - reported to the client
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def analyze_isolated(path: str | Path, unit: str = "auto", quality: str = "normal", timeout: float = ANALYSIS_TIMEOUT_S) -> dict:
    """Same as analyze_file, in a child process.

    Raises ValueError for unreadable or unsupported files (like analyze_file)
    and AnalysisCrashed when the reader crashes or exceeds `timeout` seconds.
    """
    receiver, sender = _CTX.Pipe(duplex=False)
    proc = _CTX.Process(target=_run, args=(sender, str(path), unit, quality), daemon=True)
    proc.start()
    sender.close()  # only the child writes; EOF then means the child is gone
    try:
        if not receiver.poll(timeout):
            raise AnalysisCrashed(f"The analysis did not finish within {timeout:.0f} s")
        try:
            status, payload = receiver.recv()  # read before join(): large results fill the pipe
        except EOFError:
            proc.join(5)
            raise AnalysisCrashed(f"The reader crashed on this file (exit code {proc.exitcode})") from None
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
