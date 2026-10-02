"""FastAPI web server: serves the viewer and the analysis API."""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .analyze import SUPPORTED_EXTENSIONS
from .isolate import AnalysisCrashed, analyze_isolated

STATIC_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
# Each analysis runs in its own process (see isolate.py); bound how many run at once.
_ANALYSIS_SLOTS = threading.BoundedSemaphore(max(1, min(4, os.cpu_count() or 1)))

app = FastAPI(title="3D Reader")


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
    file: UploadFile = File(...),
    unit: str = Form("auto"),
    quality: str = Form("normal"),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type '{suffix}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")

    with tempfile.TemporaryDirectory() as tmp:
        # Keep the original name: some readers (glTF, OBJ) derive part names from it.
        target = Path(tmp) / Path(file.filename).name
        size = 0
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File too large")
                out.write(chunk)
        try:
            return await run_in_threadpool(_analyze, target, unit, quality)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except AnalysisCrashed as exc:  # malformed files can crash or hang OpenCascade
            raise HTTPException(422, f"Could not read the file: {exc}") from exc


def _analyze(path: Path, unit: str, quality: str) -> dict:
    with _ANALYSIS_SLOTS:
        return analyze_isolated(path, unit, quality)


app.mount("/", StaticFiles(directory=STATIC_DIR), name="web")
