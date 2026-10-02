"""Common result types shared by the CAD (B-rep) and mesh readers.

All lengths are expressed in millimetres, areas in mm² and volumes in mm³.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Body:
    name: str
    # Triangulation used for display (and for the "mesh volume" cross-check).
    vertices: np.ndarray  # (n, 3) float
    faces: np.ndarray  # (m, 3) int
    # Real volume of the body; None when the body is not a closed solid.
    volume: float | None
    area: float
    bbox_min: tuple[float, float, float]
    bbox_max: tuple[float, float, float]
    centroid: tuple[float, float, float] | None
    closed: bool
    # "brep" = exact volume from the CAD geometry, "mesh" = from a closed triangle mesh.
    method: str
    mesh_volume: float | None = None
    color: tuple[float, float, float] | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def size(self) -> tuple[float, float, float]:
        return tuple(float(b - a) for a, b in zip(self.bbox_min, self.bbox_max))

    def to_dict(self, include_mesh: bool = True) -> dict:
        d = {
            "name": self.name,
            "volume": self.volume,
            "mesh_volume": self.mesh_volume,
            "area": self.area,
            "bbox": {"min": list(self.bbox_min), "max": list(self.bbox_max), "size": list(self.size)},
            "centroid": list(self.centroid) if self.centroid is not None else None,
            "closed": self.closed,
            "method": self.method,
            "color": list(self.color) if self.color is not None else None,
            "triangles": int(len(self.faces)),
            "notes": self.notes,
        }
        if include_mesh:
            d["mesh"] = {
                "positions": _b64(np.ascontiguousarray(self.vertices, dtype="<f4")),
                "indices": _b64(np.ascontiguousarray(self.faces, dtype="<u4")),
            }
        return d


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(a.tobytes()).decode("ascii")


def summarize(bodies: list[Body]) -> dict:
    """Totals and overall envelope ("encombrement") for a set of bodies."""
    if not bodies:
        raise ValueError("No geometry found in file")

    mins = np.array([b.bbox_min for b in bodies]).min(axis=0)
    maxs = np.array([b.bbox_max for b in bodies]).max(axis=0)
    size = maxs - mins
    solids = [b for b in bodies if b.volume is not None]
    volume = sum(b.volume for b in solids) if solids else None

    centroid = None
    if solids and volume:
        centroid = (sum(np.array(b.centroid) * b.volume for b in solids) / volume).tolist()

    envelope_volume = float(np.prod(size))
    return {
        "volume": volume,
        "area": sum(b.area for b in bodies),
        "centroid": centroid,
        "bodies": len(bodies),
        "solids": len(solids),
        "open_bodies": len(bodies) - len(solids),
        "triangles": int(sum(len(b.faces) for b in bodies)),
        "bbox": {"min": mins.tolist(), "max": maxs.tolist(), "size": size.tolist(), "volume": envelope_volume},
        "obb": _oriented_box(bodies),
        # Share of the axis-aligned envelope actually filled with material.
        "fill_ratio": (volume / envelope_volume) if volume and envelope_volume > 0 else None,
    }


def _oriented_box(bodies: list[Body]) -> dict | None:
    """Minimum-volume oriented bounding box over all vertices."""
    try:
        import trimesh

        pts = np.vstack([b.vertices for b in bodies if len(b.vertices)])
        if len(pts) < 4:
            return None
        transform, extents = trimesh.bounds.oriented_bounds(pts)
        extents = np.sort(np.asarray(extents))[::-1]
        return {"size": extents.tolist(), "volume": float(np.prod(extents))}
    except Exception:
        return None
