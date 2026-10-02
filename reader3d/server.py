"""FastAPI web server: serves the viewer and the analysis API."""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .analyze import SUPPORTED_EXTENSIONS, analyze_file

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024

app = FastAPI(title="3D Reader")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


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
            return await run_in_threadpool(analyze_file, target, unit, quality)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except Exception as exc:  # reader crashes on malformed files
            raise HTTPException(422, f"Could not read the file: {exc}") from exc


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
