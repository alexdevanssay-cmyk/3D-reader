"""Web server and command line: cancellation, limits and error handling."""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import reader3d
from reader3d import server
from reader3d.isolate import AnalysisCancelled, AnalysisCrashed, _finite, analyze_isolated, max_memory
from reader3d.server import app

ROOT = Path(reader3d.__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "generated"
BOX = FIXTURES / "box.stl"  # 10 x 20 x 30 mm
LINUX = pytest.mark.skipif(not Path("/proc/self/stat").exists(), reason="reads /proc to find the analysis processes")


def expo_dae(levels: int) -> str:
    """A few-KB COLLADA file whose node n_i instances n_(i-1) twice: 2**levels
    triangles. With 20 levels or more the reader works on it for minutes."""
    nodes = ['<node id="n0"><instance_geometry url="#g"/></node>']
    for i in range(1, levels + 1):
        nodes.append(f'<node id="n{i}"><node><instance_node url="#n{i - 1}"/></node>'
                     f'<node><translate>1 0 0</translate><instance_node url="#n{i - 1}"/></node></node>')
    return ('<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
            '<library_geometries><geometry id="g"><mesh><source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0'
            '</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/>'
            '<param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>'
            '<vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1">'
            '<input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries>'
            f'<library_nodes>{"".join(nodes)}</library_nodes><library_visual_scenes><visual_scene id="s"><node>'
            f'<instance_node url="#n{levels}"/></node></visual_scene></library_visual_scenes>'
            '<scene><instance_visual_scene url="#s"/></scene></COLLADA>')


def wait_for(condition, timeout: float, interval: float = 0.1):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if value := condition():
            return value
        time.sleep(interval)
    return condition()


# --- analyze_isolated -------------------------------------------------------------------------------------------


def test_cancel_and_timeout_stop_the_child(tmp_path):
    slow = tmp_path / "slow.dae"
    slow.write_text(expo_dae(20))
    cancel = threading.Event()
    threading.Timer(1.0, cancel.set).start()
    start = time.monotonic()
    with pytest.raises(AnalysisCancelled):
        analyze_isolated(slow, cancel=cancel)
    # The child was killed and joined within a poll interval of the cancel.
    assert time.monotonic() - start < 3.5

    start = time.monotonic()
    with pytest.raises(AnalysisCrashed, match="did not finish within 1 s"):
        analyze_isolated(slow, timeout=1)
    assert time.monotonic() - start < 3.5


def test_memory_limit_gives_a_clear_error(tmp_path, monkeypatch):
    """A 6 KB file that makes the reader allocate without bound (about 80 MB/s).
    Python or OpenCascade may abort rather than raise MemoryError: same message."""
    bomb = tmp_path / "bomb.dae"
    bomb.write_text(expo_dae(40))
    monkeypatch.setenv("READER3D_MAX_MEMORY", "256M")
    start = time.monotonic()
    with pytest.raises(ValueError, match=r"memory limit of 256 MiB \(READER3D_MAX_MEMORY\)"):  # the server answers 422
        analyze_isolated(bomb, timeout=30)
    assert time.monotonic() - start < 20
    # Normal files are not affected by the limit.
    assert analyze_isolated(BOX)["summary"]["volume"] == pytest.approx(6000)


def test_memory_limit_setting(monkeypatch):
    for value, expected in [("", 3 << 30), ("2G", 2 << 30), ("512m", 512 << 20), ("1000000", 10**6), ("0", None)]:
        monkeypatch.setenv("READER3D_MAX_MEMORY", value)
        assert max_memory() == expected
    for value in ("lots", "-1G", "inf"):
        monkeypatch.setenv("READER3D_MAX_MEMORY", value)
        with pytest.raises(ValueError, match="READER3D_MAX_MEMORY"):
            max_memory()


def test_results_never_contain_nan():
    # Starlette refuses NaN in JSON (HTTP 500) and `analyze --json` would print invalid JSON.
    result = _finite({"centroid": [float("nan"), float("inf"), 1.5], "volume": -float("inf"), "n": 3, "name": "a"})
    assert result == {"centroid": [None, None, 1.5], "volume": None, "n": 3, "name": "a"}


@LINUX
def test_forkserver_preloads_the_reader_from_any_directory(tmp_path):
    """Python 3.10-3.12 ignore sys.path in the forkserver: without PYTHONPATH the
    preload failed silently and every analysis imported OpenCascade again."""
    code = (f"import sys; sys.path.insert(0, {str(ROOT)!r})\n"
            "import multiprocessing.forkserver as fs\n"
            "from reader3d.isolate import analyze_isolated\n"
            f"assert analyze_isolated({str(BOX)!r})['summary']['volume'] > 0\n"
            "maps = open(f'/proc/{fs._forkserver._forkserver_pid}/maps').read()\n"
            "print('libTKernel' in maps)")
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    proc = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "True"


# --- web server, in process -------------------------------------------------------------------------------------


def test_upload_names_that_the_disk_refuses(tmp_path):
    client = TestClient(app)
    data = BOX.read_bytes()
    for name in ["零件" * 45 + ".stl", "a" * 300 + ".stl", "é" * 130 + ".STL", "bad:*?<>|name.stl", "C:\\parts\\box.stl"]:
        res = client.post("/api/analyze", files={"file": (name, data)})
        assert res.status_code == 200, (name, res.text)
        assert res.json()["summary"]["volume"] == pytest.approx(6000)
        # The name the user knows, not the shortened copy (the multipart parser drops a Windows path).
        assert res.json()["file"] == name.rsplit("\\", 1)[-1]

    # A NUL byte (httpx would escape it, so build the multipart body by hand).
    body = (b'--B\r\nContent-Disposition: form-data; name="file"; filename="a\x00b.stl"\r\n'
            b"Content-Type: application/octet-stream\r\n\r\n" + data + b"\r\n--B--\r\n")
    res = client.post("/api/analyze", content=body, headers={"Content-Type": "multipart/form-data; boundary=B"})
    assert res.status_code == 200, res.text
    assert res.json()["summary"]["volume"] == pytest.approx(6000)


def test_upload_size_limit(monkeypatch):
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 2000)
    client = TestClient(app)
    data = BOX.read_bytes()
    assert len(data) < 2000
    assert client.post("/api/analyze", files={"file": ("box.stl", data)}).status_code == 200
    # Just over the limit: refused by the handler...
    res = client.post("/api/analyze", files={"file": ("big.stl", b"x" * 2001)})
    assert res.status_code == 413
    assert res.json()["detail"].startswith("File too large")
    # ...far over: refused while the body arrives, before the form is parsed.
    res = client.post("/api/analyze", files={"file": ("big.stl", b"x" * (server.MULTIPART_OVERHEAD + 10_000))})
    assert res.status_code == 413
    assert res.json()["detail"].startswith("File too large")


# --- web server, real uvicorn (TestClient cannot disconnect, nor send a body slowly) ------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(port: int, path: str, timeout: float = 5) -> int:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as res:
        return res.status


def _multipart(name: str, data: bytes) -> tuple[bytes, bytes]:
    head = (f'--B\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n").encode()
    return head, b"\r\n--B--\r\n"


def _post(port: int, name: str, data: bytes) -> socket.socket:
    """Send a complete upload and return the socket without reading the answer."""
    head, tail = _multipart(name, data)
    sock = socket.create_connection(("127.0.0.1", port))
    sock.sendall(b"POST /api/analyze HTTP/1.1\r\nHost: test\r\nContent-Type: multipart/form-data; boundary=B\r\n"
                 + f"Content-Length: {len(head) + len(data) + len(tail)}\r\n\r\n".encode() + head + data + tail)
    return sock


def _status(sock: socket.socket, timeout: float = 10) -> int:
    sock.settimeout(timeout)
    try:
        return int(sock.recv(64).split()[1])
    finally:
        sock.close()


def _children(pid: int) -> list[int]:
    found = []
    for entry in os.listdir("/proc"):
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except (OSError, ValueError):
            continue
        if int(stat.rsplit(")", 1)[1].split()[1]) == pid:
            found.append(int(entry))
    return found


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """`python -m reader3d serve` with one analysis slot and a 1 MB upload limit."""
    port = _free_port()
    code = ("import uvicorn\n"
            "from reader3d import server\n"
            "server.MAX_UPLOAD_BYTES = 1 << 20\n"
            "server._ANALYSIS_SLOTS = type(server._ANALYSIS_SLOTS)(1)\n"
            f"uvicorn.run(server.app, host='127.0.0.1', port={port}, log_level='warning')\n")
    proc = subprocess.Popen([sys.executable, "-c", code], cwd=tmp_path_factory.mktemp("cwd"),
                            env={**os.environ, "PYTHONPATH": str(ROOT)}, stderr=subprocess.DEVNULL)

    def ready():
        try:
            return _get(port, "/api/formats", timeout=1) == 200
        except OSError:
            return False

    try:
        assert wait_for(ready, 60, 0.2), "the server did not start"
        assert _status(_post(port, "box.stl", BOX.read_bytes()), 60) == 200  # starts the forkserver
        forkserver = next(p for p in _children(proc.pid) if b"forkserver" in Path(f"/proc/{p}/cmdline").read_bytes())
        yield port, forkserver
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:  # uvicorn waits for the requests in progress
            proc.kill()
            proc.wait()


def _box_analysis_time(port: int) -> float:
    start = time.monotonic()
    assert _status(_post(port, "box.stl", BOX.read_bytes()), 30) == 200
    return time.monotonic() - start


@LINUX
def test_disconnect_kills_the_running_analysis(live_server):
    """The page's Cancel button aborts the request: the analysis must stop and
    free its slot, instead of running on for up to ANALYSIS_TIMEOUT_S."""
    port, forkserver = live_server
    sock = _post(port, "slow.dae", expo_dae(20).encode())
    assert wait_for(lambda: len(_children(forkserver)) == 1, 10), "the analysis did not start"
    sock.close()
    assert wait_for(lambda: not _children(forkserver), 3), "the analysis kept running after the client left"
    assert _box_analysis_time(port) < 5  # the only slot is free again


@LINUX
def test_waiting_requests_neither_block_the_server_nor_outlive_their_client(live_server):
    port, forkserver = live_server
    busy = _post(port, "slow.dae", expo_dae(20).encode())  # takes the only slot
    assert wait_for(lambda: len(_children(forkserver)) == 1, 10)
    # More waiting requests than anyio has worker threads (40)...
    waiting = [_post(port, "box.stl", BOX.read_bytes()) for _ in range(45)]
    time.sleep(1)
    # ...and the page still loads (static files and sync routes use those threads).
    for path in ("/config.json", "/", "/app.js"):
        assert _get(port, path, timeout=5) == 200
    for sock in [busy, *waiting]:
        sock.close()
    # Every client left: the queue empties at once and the running analysis is killed.
    assert wait_for(lambda: not _children(forkserver), 3)
    assert _box_analysis_time(port) < 5


def test_upload_limit_is_enforced_while_the_body_arrives(live_server):
    port, _ = live_server
    head, _ = _multipart("big.stl", b"")
    # A declared length over the limit is refused before the body is read.
    sock = socket.create_connection(("127.0.0.1", port))
    sock.sendall(b"POST /api/analyze HTTP/1.1\r\nHost: test\r\nContent-Type: multipart/form-data; boundary=B\r\n"
                 + f"Content-Length: {10 << 30}\r\n\r\n".encode() + head)
    assert _status(sock, 5) == 413
    # A chunked body is refused as soon as it passes the limit, not once complete.
    sock = socket.create_connection(("127.0.0.1", port))
    sock.sendall(b"POST /api/analyze HTTP/1.1\r\nHost: test\r\nContent-Type: multipart/form-data; boundary=B\r\n"
                 b"Transfer-Encoding: chunked\r\n\r\n" + f"{len(head):x}\r\n".encode() + head + b"\r\n")
    chunk = b"\0" * 65536
    for _ in range(40):  # 2.5 MB, never terminated
        sock.sendall(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
    assert _status(sock, 5) == 413


# --- command line -----------------------------------------------------------------------------------------------


def run_cli(*args, env=None):
    return subprocess.run([sys.executable, "-m", "reader3d", *map(str, args)], cwd=ROOT, capture_output=True, text=True,
                          timeout=120, env=env)


def test_cli_json_is_valid_for_iges():
    """OpenCascade prints 'Total number of loaded entities' on stdout for IGES files."""
    proc = run_cli("analyze", FIXTURES / "holed_block.igs", "--json")
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["summary"]["volume"] == pytest.approx(100 * 60 * 20 - 3.141592653589793 * 10**2 * 20, rel=1e-6)
    assert "mesh" not in result["bodies"][0]


def test_cli_report_and_errors(tmp_path):
    proc = run_cli("analyze", BOX)
    assert proc.returncode == 0, proc.stderr
    assert "Total real volume : 6,000.000 mm3" in proc.stdout

    notes = tmp_path / "notes.txt"
    notes.write_text("hello")
    for args, message in [
        (["analyze", tmp_path / "missing.stl"], "no such file"),
        (["analyze", notes], "Unsupported file type '.txt'"),
        (["analyze", BOX, "--unit", "furlong"], "invalid choice: 'furlong'"),
    ]:
        proc = run_cli(*args)
        assert proc.returncode in (1, 2), (args, proc.returncode)  # 2: argparse usage error
        assert message in proc.stderr
        assert "Traceback" not in proc.stderr


def test_cli_survives_a_crashing_file(tmp_path):
    """This truncation of holed_block.igs crashes OpenCascade (SIGSEGV) in-process."""
    cut = tmp_path / "cut.igs"
    cut.write_bytes((FIXTURES / "holed_block.igs").read_bytes()[:11896])
    proc = run_cli("analyze", cut)
    assert proc.returncode in (0, 1), proc.returncode  # never killed by a signal
    assert "Traceback" not in proc.stderr
    if proc.returncode == 1:
        assert "reader3d: error: " in proc.stderr
