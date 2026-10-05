"""Reading of triangle-mesh formats (STL, OBJ, PLY, glTF/GLB, 3MF, OFF, DAE...).

For a mesh the "real" volume is the volume enclosed by its triangles, computed
with the divergence theorem (sum of signed tetrahedra). This is exact for the
mesh, but it is only meaningful when the surface is closed (watertight), so
open meshes are reported without a volume.
"""

from __future__ import annotations

import codecs
import io
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
    utf8 = _as_utf8(path, ext) if ext in (".obj", ".off", ".stl", ".ply") else None
    if utf8 is None:
        scene = trimesh.load(str(path), file_type=ext.lstrip("."), force="scene")
    else:
        resolver = trimesh.resolvers.FilePathResolver(str(path))  # OBJ materials next to the file
        scene = trimesh.load(io.BytesIO(utf8), file_type=ext.lstrip("."), force="scene", resolver=resolver)

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


def _as_utf8(path: Path, ext: str) -> bytes | None:
    """The content of a text mesh file made valid UTF-8, or None when it already is.

    Names and comments written in Latin-1 / cp1252 are common in OBJ, ASCII STL and
    PLY headers; trimesh only reads UTF-8. Undecodable bytes become U+FFFD, like the
    browser's TextDecoder. A binary STL and the binary data of a PLY are left as is.
    """
    with path.open("rb") as f:
        if ext == ".stl":
            head = f.read(84)
            if len(head) == 84 and path.stat().st_size == 84 + 50 * int.from_bytes(head[80:84], "little"):
                return None  # binary STL: its 80-byte header is free text that trimesh tolerates
            f.seek(0)
        if ext == ".ply":
            header = b""
            for line in f:
                header += line
                if b"end_header" in line.split() or len(header) > 1 << 20:
                    break
            try:
                header.decode("utf-8")
                return None
            except UnicodeDecodeError:
                return header.decode("utf-8", errors="replace").encode("utf-8") + f.read()
        decoder = codecs.getincrementaldecoder("utf-8")()
        try:
            while chunk := f.read(1 << 20):
                decoder.decode(chunk)
            decoder.decode(b"", final=True)
            return None
        except UnicodeDecodeError:
            f.seek(0)
            return f.read().decode("utf-8", errors="replace").encode("utf-8")


def _auto_unit(scene: trimesh.Scene, ext: str) -> tuple[str, float]:
    units = (scene.units or "").lower() if getattr(scene, "units", None) else ""
    factor = _parse_units(units)
    if factor is not None:
        name = next((k for k, v in UNITS.items() if abs(v - factor) <= 1e-9 * v), None)
        # A declared unit that is not one of UNITS keeps its own name ("micron"); only
        # scaled COLLADA units ("1e-06 * meters") are named by their size in metres.
        return name or (units if units in _TRIMESH_UNITS else f"{factor / 1000:g} m"), factor
    if ext in (".glb", ".gltf"):
        return "m", UNITS["m"]  # glTF is metres by specification
    return "mm", 1.0  # STL/OBJ/PLY have no unit; mm is the usual CAD/3D-printing convention


def _parse_units(units: str) -> float | None:
    """mm per file unit for trimesh's unit strings: "millimeters", or "0.01 * meters"
    for a COLLADA document declaring <unit meter="0.01"/>."""
    if units in _TRIMESH_UNITS:
        return _TRIMESH_UNITS[units]
    scale, sep, base = units.partition("*")
    if sep and base.strip() in _TRIMESH_UNITS:
        try:
            value = float(scale) * _TRIMESH_UNITS[base.strip()]
        except ValueError:
            return None
        return value if value > 0 else None
    return None


def _mesh_body(name: str, mesh: trimesh.Trimesh, color) -> Body:
    notes: list[str] = []
    display_vertices, display_faces = mesh.vertices.copy(), mesh.faces.copy()
    bmin, bmax = mesh.bounds
    size = float(np.max(bmax - bmin))

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
        volume, centroid, flipped = _shell_volume(work.vertices, work.faces, size)
        if flipped:
            notes.append("Normals pointed inwards; volume sign corrected")
    else:
        open_edges = _boundary_edge_count(work)
        repaired = work.copy()
        if open_edges and trimesh.repair.fill_holes(repaired) and repaired.is_watertight:
            # Small holes (missing triangles) could be closed: give an estimate, unless
            # the filling made up most of the surface (a soup of unwelded triangles
            # "closed" by a reversed twin each) or encloses nothing.
            trimesh.repair.fix_winding(repaired)
            filled, filled_centroid, flipped = _shell_volume(repaired.vertices, repaired.faces, size)
            if len(repaired.faces) - len(work.faces) < len(work.faces) and abs(filled) > 1e-9 * size**3:
                volume, centroid = filled, filled_centroid
                if flipped:
                    notes.append("Normals pointed inwards; volume sign corrected")
                notes.append(f"Mesh was not closed ({open_edges} open edges); volume estimated after filling the holes")
        if volume is None:
            notes.append(
                f"Mesh is not closed ({open_edges} open edges): the enclosed volume is undefined"
                if open_edges
                else "Mesh has non-manifold edges: the enclosed volume is undefined"
            )

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


# Direction of the rays of the inside test: not along an axis nor a diagonal, so that it
# rarely grazes the edges of axis-aligned meshes.
_RAY = np.array([1.0, np.sqrt(2.0), np.sqrt(3.0)]) / np.sqrt(6.0)


def _shell_volume(vertices: np.ndarray, faces: np.ndarray, size: float):
    """Volume and centre of mass of a closed, consistently wound triangle mesh.

    Every shell (set of faces connected through their edges) is oriented on its own:
    the winding repair keeps whatever orientation each shell started with, so one
    inside-out shell would otherwise be subtracted from the others. A shell is
    material when it lies inside an even number of other shells and a void (negative
    volume) when the number is odd. Returns (volume, centroid or None, any flipped).
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    origin = (vertices.min(axis=0) + vertices.max(axis=0)) / 2  # better conditioning
    tri = vertices[faces] - origin
    tet = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])) / 6.0
    labels, first = _face_components(faces)
    count = len(first)
    vol = np.bincount(labels, weights=tet, minlength=count)
    moment = np.stack([np.bincount(labels, weights=tet * tri[:, :, k].sum(axis=1) / 4.0, minlength=count) for k in range(3)], axis=1)

    depth = _nesting_depth(tri, labels, first) if count > 1 else np.zeros(1, dtype=np.int64)
    wanted = np.where(depth % 2 == 0, 1.0, -1.0)
    flip = (vol != 0) & (np.sign(vol) != wanted)
    vol[flip] *= -1
    moment[flip] *= -1

    volume = float(vol.sum())
    centroid = None
    with np.errstate(divide="ignore", invalid="ignore"):
        c = origin + moment.sum(axis=0) / volume
    if np.all(np.isfinite(c)) and abs(volume) > 1e-12 * size**3:
        centroid = tuple(float(x) for x in c)
    return volume, centroid, bool(flip.any())


def _face_components(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Label of every face (faces connected through a shared edge), the components being
    numbered in the order of their lowest face index, and that lowest face of each."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n = len(faces)
    edges = np.sort(faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    owner = np.repeat(np.arange(n), 3)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    same = np.all(edges[order][1:] == edges[order][:-1], axis=1)
    a, b = owner[order][:-1][same], owner[order][1:][same]
    graph = coo_matrix((np.ones(len(a)), (a, b)), shape=(n, n))
    _, raw = connected_components(graph, directed=False)
    first = np.full(raw.max() + 1, n)
    np.minimum.at(first, raw, np.arange(n))
    rank = np.empty(len(first), dtype=np.int64)
    rank[np.argsort(first)] = np.arange(len(first))
    return rank[raw], np.sort(first)


def _nesting_depth(tri: np.ndarray, labels: np.ndarray, first: np.ndarray) -> np.ndarray:
    """For every shell, the number of other shells containing it (its test point, the
    centroid of its lowest face): point in the other shell's box, then an odd number of
    crossings of the ray p + t * _RAY (t > 0) with its triangles."""
    count = len(first)
    points = tri[first].mean(axis=1)
    lo = np.full((count, 3), np.inf)
    hi = np.full((count, 3), -np.inf)
    corners = tri.reshape(-1, 3)
    np.minimum.at(lo, np.repeat(labels, 3), corners)
    np.maximum.at(hi, np.repeat(labels, 3), corners)

    by_x = np.argsort(points[:, 0], kind="stable")
    xs = points[by_x, 0]
    order = np.argsort(labels, kind="stable")
    bounds = np.searchsorted(labels[order], np.arange(count + 1))
    depth = np.zeros(count, dtype=np.int64)
    for j in range(count):
        cand = by_x[np.searchsorted(xs, lo[j, 0], "left") : np.searchsorted(xs, hi[j, 0], "right")]
        cand = cand[(cand != j) & np.all((points[cand] >= lo[j]) & (points[cand] <= hi[j]), axis=1)]
        if len(cand):
            hits = _ray_crossings(points[cand], tri[order[bounds[j] : bounds[j + 1]]])
            depth[cand[hits % 2 == 1]] += 1
    return depth


def _ray_crossings(points: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Number of triangles crossed by the ray p + t * _RAY (t > 0) of every point
    (Möller–Trumbore, triangles parallel to the ray skipped)."""
    a = tri[:, 0]
    e1 = tri[:, 1] - a
    e2 = tri[:, 2] - a
    pvec = np.cross(_RAY, e2)
    det = np.einsum("ij,ij->i", e1, pvec)
    keep = np.abs(det) > 1e-12 * np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1)
    a, e1, e2, pvec, inv = a[keep], e1[keep], e2[keep], pvec[keep], 1.0 / det[keep]
    out = np.zeros(len(points), dtype=np.int64)
    step = max(1, 1_000_000 // max(len(a), 1))  # points per batch: bounded temporary arrays
    for s in range(0, len(points), step):
        tvec = points[s : s + step, None, :] - a[None]
        u = np.einsum("kmi,mi->km", tvec, pvec) * inv
        qvec = np.cross(tvec, e1[None])
        v = (qvec @ _RAY) * inv
        t = np.einsum("kmi,mi->km", qvec, e2) * inv
        out[s : s + step] = ((t > 0) & (u >= 0) & (v >= 0) & (u + v <= 1)).sum(axis=1)
    return out


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
