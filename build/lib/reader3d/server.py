"""FastAPI web server: serves the viewer and the analysis API."""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
import threading
from pathlib import Path

import anyio
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .analyze import SUPPORTED_EXTENSIONS
from .isolate import AnalysisCancelled, AnalysisCrashed, analyze_isolated

STATIC_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MULTIPART_OVERHEAD = 64 * 1024  # form fields and part headers around the file
MAX_NAME_BYTES = 150  # of the stem of the temporary copy of an upload (file systems allow 255)
DISCONNECT_POLL_S = 0.5
# Each analysis runs in its own process (see isolate.py); bound how many run at once.
# Requests wait for a slot in the event loop: a thread is only taken while one runs.
_ANALYSIS_SLOTS = anyio.Semaphore(max(1, min(4, os.cpu_count() or 1)))
# Control characters, path separators and characters Windows does not allow in file names.
_UNSAFE_NAME_CHARS = re.compile(r'[\x00-\x1f\x7f/\\:*?"<>|]')

app = FastAPI(title="3D Reader")


def _too_large() -> str:
    return f"File too large: the limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB"


class _UploadLimit:
    """Refuse request bodies above the upload limit while they arrive. Starlette
    would otherwise spool the whole body to disk before the handler sees it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD
        length = dict(scope["headers"]).get(b"content-length", b"")
        if length.isdigit() and int(length) > limit:
            return await JSONResponse({"detail": _too_large()}, status_code=413)(scope, receive, send)
        received = 0

        async def receive_limited():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:  # chunked upload, or a Content-Length that lied
                    raise HTTPException(413, _too_large())  # FastAPI re-raises it from the body parser
            return message

        await self.app(scope, receive_limited, send)


app.add_middleware(_UploadLimit)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/config.json")
def config():
    # Overrides web/config.json: tells the page that the Python engine is available.
    return {"server": True, "extensions": SUPPORTED_EXTENSIONS}


@app.get("/api/formats")
def formats():
    return {"extensions": SUPPORTED_EXTENSIONS}


@app.post("/api/analyze")
async def analyze(
    request: Request,
    file: UploadFile = File(...),
    unit: str = Form("auto"),
    quality: str = Form("normal"),
):
    name = Path(file.filename or "").name
    suffix = Path(name).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{suffix}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")

    with tempfile.TemporaryDirectory() as tmp:
        # Keep the original name: some readers (glTF, OBJ) derive part names from it.
        target = Path(tmp) / _safe_name(name)
        size = 0
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, _too_large())
                out.write(chunk)
        try:
            result = await _analyze(request, target, unit, quality)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except AnalysisCancelled as exc:  # nobody reads this answer
            raise HTTPException(499, "The client closed the connection") from exc
        except AnalysisCrashed as exc:  # malformed files can crash or hang OpenCascade
            raise HTTPException(422, f"Could not read the file: {exc}") from exc
    result["file"] = name
    return result


def _safe_name(name: str) -> str:
    """`name` made valid on any disk: unsafe characters replaced and the stem cut
    to MAX_NAME_BYTES of UTF-8, keeping the extension the reader is chosen by."""
    path = Path(name)
    stem = _UNSAFE_NAME_CHARS.sub("_", path.stem)
    stem = stem.encode("utf-8", "ignore")[:MAX_NAME_BYTES].decode("utf-8", "ignore").strip(" .")
    return (stem or "upload") + path.suffix


async def _analyze(request: Request, path: Path, unit: str, quality: str) -> dict:
    """analyze_isolated in one of the analysis slots. When the client disconnects
    (the page's Cancel button aborts the request), a request still waiting for a
    slot leaves the queue and a running analysis has its process killed."""
    cancel = threading.Event()
    running = False

    async def run() -> dict:
        nonlocal running
        async with _ANALYSIS_SLOTS:
            running = True
            return await run_in_threadpool(analyze_isolated, path, unit, quality, cancel=cancel)

    job = asyncio.ensure_future(run())
    try:
        while not job.done():
            await asyncio.wait({job}, timeout=DISCONNECT_POLL_S)
            if not job.done() and await request.is_disconnected():
                break
    finally:
        if not job.done():  # the client left, or the server is stopping
            cancel.set()  # analyze_isolated kills the child within a poll interval
            if not running:
                job.cancel()  # still waiting for a slot
            job.add_done_callback(lambda done: done.cancelled() or done.exception())  # not awaited when stopping
    await asyncio.wait({job})
    if job.cancelled():
        raise AnalysisCancelled("The client closed the connection")
    return job.result()


app.mount("/", StaticFiles(directory=STATIC_DIR), name="web")
