"""Reading of triangle-mesh formats (STL, OBJ, PLY, glTF/GLB, 3MF, OFF, DAE...).

For a mesh the "real" volume is the volume enclosed by its triangles, computed
with the divergence theorem (sum of signed tetrahedra). This is exact for the
mesh, but it is only meaningful when the surface is closed (watertight), so
open meshes are reported without a volume.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh

from .model import Body

MESH_EXTENSIONS = {".stl", ".obj", ".ply", ".off", ".glb", ".gltf", ".3mf", ".dae", ".zae", ".3dxml"}

# Conversion factors to millimetres.
UNITS = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8}

# Units trimesh may report from the file itself (3MF, DAE, glTF).
_TRIMESH_UNITS = {
    "millimeters": 1.0, "millimeter": 1.0, "mm": 1.0,
    "centimeters": 10.0, "centimeter": 10.0, "cm": 10.0,
    "meters": 1000.0, "meter": 1000.0, "m": 1000.0,
    "inches": 25.4, "inch": 25.4, "in": 25.4,
    "feet": 304.8, "foot": 304.8, "ft": 304.8,
    "microns": 1e-3, "micron": 1e-3,
}


def read_mesh(path: str | Path, unit: str = "auto") -> tuple[list[Body], str]:
    """Return the bodies of the file (in mm) and the source unit that was applied."""
    path = Path(path)
    ext = path.suffix.lower()
    scene = trimesh.load(str(path), file_type=ext.lstrip("."), force="scene")

    if unit == "auto":
        unit_used, scale = _auto_unit(scene, ext)
    else:
        unit_used, scale = unit, UNITS[unit]

    bodies: list[Body] = []
    for node in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node]
        geom = scene.geometry[geom_name]
        if not isinstance(geom, trimesh.Trimesh) or len(geom.faces) == 0:
            continue
        mesh = trimesh.Trimesh(vertices=geom.vertices, faces=geom.faces, process=False)
        mesh.apply_transform(transform)
        mesh.apply_scale(scale)
        name = node if node != geom_name or len(scene.geometry) > 1 else path.stem
        bodies.append(_mesh_body(str(name), mesh, _mesh_color(geom)))

    if not bodies:
        raise ValueError("The file does not contain any triangle geometry")
    return bodies, unit_used


def _auto_unit(scene: trimesh.Scene, ext: str) -> tuple[str, float]:
    units = (scene.units or "").lower() if getattr(scene, "units", None) else ""
    if units in _TRIMESH_UNITS:
        factor = _TRIMESH_UNITS[units]
        name = next((k for k, v in UNITS.items() if v == factor), units)
        return name, factor
    if ext in (".glb", ".gltf"):
        return "m", UNITS["m"]  # glTF is metres by specification
    return "mm", 1.0  # STL/OBJ/PLY have no unit; mm is the usual CAD/3D-printing convention


def _mesh_body(name: str, mesh: trimesh.Trimesh, color) -> Body:
    notes: list[str] = []
    display_vertices, display_faces = mesh.vertices.copy(), mesh.faces.copy()

    # Analysis copy: weld coincident vertices (STL stores every triangle separately,
    # OBJ splits vertices on UV seams) so that the topology can be checked.
    work = mesh.copy()
    work.merge_vertices(merge_tex=True, merge_norm=True)
    work.update_faces(work.nondegenerate_faces())
    work.update_faces(work.unique_faces())
    work.remove_unreferenced_vertices()

    closed = bool(work.is_watertight)
    volume = None
    centroid = None
    if closed:
        if not work.is_winding_consistent:
            trimesh.repair.fix_winding(work)
            notes.append("Inconsistent triangle orientation was repaired")
        signed = float(work.volume)
        if signed < 0:
            notes.append("Normals pointed inwards; volume sign corrected")
            work.invert()
            signed = -signed
        volume = signed
        centroid = tuple(float(x) for x in work.center_mass)
    else:
        open_edges = _boundary_edge_count(work)
        repaired = work.copy()
        if open_edges and trimesh.repair.fill_holes(repaired) and repaired.is_watertight:
            # Small holes (missing triangles) could be closed: give an estimate.
            trimesh.repair.fix_winding(repaired)
            volume = abs(float(repaired.volume))
            centroid = tuple(float(x) for x in repaired.center_mass)
            notes.append(f"Mesh was not closed ({open_edges} open edges); volume estimated after filling the holes")
        else:
            notes.append(
                f"Mesh is not closed ({open_edges} open edges): the enclosed volume is undefined"
                if open_edges
                else "Mesh has non-manifold edges: the enclosed volume is undefined"
            )

    bmin, bmax = mesh.bounds
    return Body(
        name=name,
        vertices=display_vertices,
        faces=display_faces,
        volume=volume,
        area=float(work.area),
        bbox_min=tuple(float(x) for x in bmin),
        bbox_max=tuple(float(x) for x in bmax),
        centroid=centroid,
        closed=closed,
        method="mesh",
        mesh_volume=volume,
        color=color,
        notes=notes,
    )


def _boundary_edge_count(mesh: trimesh.Trimesh) -> int:
    edges = mesh.edges_sorted
    if len(edges) == 0:
        return 0
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int((counts == 1).sum())


def _mesh_color(geom: trimesh.Trimesh):
    try:
        visual = geom.visual
        if visual.kind == "face" or visual.kind == "vertex":
            rgba = visual.main_color
        elif visual.kind == "texture" and hasattr(visual.material, "main_color"):
            rgba = visual.material.main_color
        else:
            return None
        r, g, b = (np.asarray(rgba[:3], dtype=float) / 255.0).tolist()
        return (r, g, b)
    except Exception:
        return None
