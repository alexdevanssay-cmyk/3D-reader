"""Entry point: read any supported 3D file and compute its geometric properties."""

from __future__ import annotations

import time
from pathlib import Path

from .cad import CAD_EXTENSIONS, QUALITY, read_cad
from .mesh import MESH_EXTENSIONS, UNITS, read_mesh
from .model import summarize

SUPPORTED_EXTENSIONS = sorted(set(CAD_EXTENSIONS) | MESH_EXTENSIONS)


def analyze_file(path: str | Path, unit: str = "auto", quality: str = "normal", include_mesh: bool = True) -> dict:
    """Analyse a 3D file. All results are in mm, mm² and mm³.

    unit    -- source unit for mesh formats ("auto", "mm", "cm", "m", "in", "ft").
               CAD files carry their own unit and are always converted to mm.
    quality -- display tessellation for CAD files ("coarse", "normal", "fine").
    """
    path = Path(path)
    ext = path.suffix.lower()
    if unit != "auto" and unit not in UNITS:
        raise ValueError(f"Unknown unit '{unit}'")
    if quality not in QUALITY:
        raise ValueError(f"Unknown quality '{quality}'")

    start = time.perf_counter()
    if ext in CAD_EXTENSIONS:
        bodies = read_cad(path, CAD_EXTENSIONS[ext], quality)
        kind, unit_used = "cad", "mm"
    elif ext in MESH_EXTENSIONS:
        bodies, unit_used = read_mesh(path, unit)
        kind = "mesh"
    else:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")

    return {
        "file": path.name,
        "kind": kind,
        "source_unit": unit_used,
        "units": {"length": "mm", "area": "mm2", "volume": "mm3"},
        "summary": summarize(bodies),
        "bodies": [b.to_dict(include_mesh) for b in bodies],
        "elapsed_s": round(time.perf_counter() - start, 3),
    }
