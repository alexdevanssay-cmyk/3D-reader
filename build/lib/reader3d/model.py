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

    # Centre of mass of the bodies that have one (a body of zero volume has none).
    centroid = None
    massive = [b for b in solids if b.centroid is not None]
    weight = sum(b.volume for b in massive)
    if massive and abs(weight) > 1e-12 * float(size.max()) ** 3:
        c = sum(np.array(b.centroid) * b.volume for b in massive) / weight
        if np.all(np.isfinite(c)):
            centroid = c.tolist()

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
        "obb": _oriented_box(bodies, size),
        # Share of the axis-aligned envelope actually filled with material.
        "fill_ratio": (volume / envelope_volume) if volume and envelope_volume > 0 else None,
    }


# Most hull face directions tried by the oriented envelope search (the ones carrying
# the largest hull area first).
OBB_MAX_DIRECTIONS = 2000


def _oriented_box(bodies: list[Body], aabb_size: np.ndarray) -> dict:
    """Smallest-volume oriented bounding box of the vertices used by the bodies' faces.

    Candidates: boxes with one face flush with a face of the convex hull (for every
    distinct hull face direction, the minimum-area rectangle of the hull projected on
    that plane), and the axis-aligned box. Same algorithm as web/engine/summary.js.
    """
    best = np.sort(np.asarray(aabb_size, dtype=float))[::-1]
    pts = [np.asarray(b.vertices, dtype=np.float64)[np.unique(b.faces)] for b in bodies if len(b.faces)]
    pts = np.vstack(pts) if pts else np.zeros((0, 3))
    pts = pts[np.all(np.isfinite(pts), axis=1)]
    if len(pts) >= 4:
        try:
            found = _min_volume_box(pts - (pts.min(axis=0) + pts.max(axis=0)) / 2)
        except Exception:  # noqa: BLE001 - a secondary measure: keep the axis-aligned box
            found = None
        if found is not None and np.prod(found) < np.prod(best):
            best = found
    return {"size": best.tolist(), "volume": float(np.prod(best))}


def _min_volume_box(pts: np.ndarray) -> np.ndarray | None:
    """Extents (decreasing) of the smallest box flush with a hull face, or None for a flat
    or degenerate point set."""
    from scipy.spatial import ConvexHull, QhullError

    try:
        hull = ConvexHull(pts)
    except (QhullError, ValueError):
        return None  # flat (coplanar or collinear) points
    simplices, normals = hull.simplices, hull.equations[:, :3]
    tri = pts[simplices]
    areas = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) / 2
    verts = pts[hull.vertices]
    support = _Support(pts, simplices, normals) if len(verts) > 20000 else None
    # Hull edges, with their two faces and their two vertices.
    face = np.repeat(np.arange(len(simplices)), 3)
    other = hull.neighbors.ravel()
    corner = np.tile([1, 2, 0, 2, 0, 1], len(simplices)).reshape(-1, 2)
    once = face < other
    silhouettes = _Silhouettes(normals[face[once]], normals[other[once]])
    edge_verts = simplices[face[once, None], corner[once]]

    # (np.einsum rather than BLAS for these thin products: same order of the operations
    # as summary.js, and no thread start-up on every one of the 2000 directions.)
    best, best_volume = None, np.inf
    for n in _hull_directions(normals, areas)[:OBB_MAX_DIRECTIONS]:
        if support is None:
            along = np.einsum("ij,j->i", verts, n)
            height = along.max() - along.min()
        else:
            height = support.extent(n) + support.extent(-n)
        # The outline of the hull projected along n is the projection of its silhouette.
        outline = edge_verts[silhouettes.edges(n)]
        p = pts[np.unique(outline)] if len(outline) >= 3 else verts
        # Plane basis: u = n x e with e the coordinate axis the most perpendicular to n.
        e = np.eye(3)[np.argmin(np.abs(n))]
        u = np.array([n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]])
        u /= np.sqrt(u @ u)
        v = np.array([n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]])
        width, depth = _min_area_rectangle(np.einsum("ij,kj->ik", p, np.stack([u, v])))
        if width * depth * height < best_volume:
            best, best_volume = np.array([width, depth, height]), width * depth * height
    return None if best is None else np.sort(best)[::-1]


class _Support:
    """Largest p . w over the hull vertices p, for a unit direction w.

    The farthest vertex v has w in its normal cone, spanned by the normals of its
    faces: with a the normal of one of them, |a - w| <= max |a - N_f| (when every
    a . N_f >= 0). Vertices where that radius is small (smooth parts of dense hulls) are
    found with a k-d tree on a; the others (sharp corners) are always measured.
    """

    SMOOTH = 0.1

    def __init__(self, pts: np.ndarray, simplices: np.ndarray, normals: np.ndarray):
        from scipy.spatial import cKDTree

        vert, face = simplices.ravel(), np.repeat(np.arange(len(simplices)), 3)
        first = np.full(len(pts), len(simplices))
        np.minimum.at(first, vert, face)
        ids = np.unique(vert)
        a = normals[np.minimum(first, len(simplices) - 1)]
        radius = np.zeros(len(pts))
        np.maximum.at(radius, vert, np.linalg.norm(normals[face] - a[vert], axis=1))
        smooth = ids[radius[ids] <= self.SMOOTH]
        self.pts = pts
        self.sharp = ids[radius[ids] > self.SMOOTH]
        self.smooth = smooth
        self.tree = cKDTree(a[smooth]) if len(smooth) else None

    def extent(self, w: np.ndarray) -> float:
        cand = self.sharp
        if self.tree is not None:
            cand = np.concatenate([cand, self.smooth[self.tree.query_ball_point(w, self.SMOOTH + 1e-9)]])
        return float(np.einsum("ij,j->i", self.pts[cand], w).max())


class _Silhouettes:
    """Silhouette edges of a convex hull seen along n: the edges between a face turned
    towards n (normal . n > -1e-10) and a face turned away.

    Dense hulls have hundreds of thousands of edges and few of them on a silhouette:
    the edges are bucketed by the normal `a` of their first face. If the normals a, b of
    an edge are on either side, |a . n| <= |a - b| + 1e-10, so only the buckets whose
    centre c has |c . n| <= max |a - c| + max |a - b| (+ slack) need to be tested.
    """

    def __init__(self, a: np.ndarray, b: np.ndarray, step: float = 0.02):
        self.a, self.b = a, b
        cell = np.floor((a + 1) / step).astype(np.int64) @ np.array([1 << 20, 1 << 10, 1])
        _, bucket = np.unique(cell, return_inverse=True)
        count = np.bincount(bucket)
        self.order = np.argsort(bucket, kind="stable")
        self.start = np.concatenate([[0], np.cumsum(count)])
        self.centre = np.stack([np.bincount(bucket, weights=a[:, k]) for k in range(3)], axis=1) / count[:, None]
        reach = np.zeros(len(count))
        np.maximum.at(reach, bucket, np.linalg.norm(a - self.centre[bucket], axis=1))
        spread = np.zeros(len(count))
        np.maximum.at(spread, bucket, np.linalg.norm(a - b, axis=1))
        self.reach = reach + spread + 1e-9

    def edges(self, n: np.ndarray) -> np.ndarray:
        near = np.nonzero(np.abs(np.einsum("ij,j->i", self.centre, n)) <= self.reach)[0]
        size = self.start[near + 1] - self.start[near]
        cand = self.order[np.repeat(self.start[near] - np.cumsum(size) + size, size) + np.arange(size.sum())]
        return cand[(np.einsum("ij,j->i", self.a[cand], n) > -1e-10) != (np.einsum("ij,j->i", self.b[cand], n) > -1e-10)]


def _hull_directions(normals: np.ndarray, areas: np.ndarray) -> np.ndarray:
    """Distinct directions of the hull face normals, by decreasing hull area.

    Two normals are the same direction when |n1 . n2| > 1 - 1e-9 (opposite ones too);
    a direction is represented by the normal of its largest face.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    n = len(normals)
    # |n1 - n2|^2 = 2 - 2 n1.n2: within this radius of n2 or of -n2.
    pairs = cKDTree(np.vstack([normals, -normals])).query_pairs(np.sqrt(2e-9), output_type="ndarray") % n
    graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, group = connected_components(graph, directed=False)
    total = np.bincount(group, weights=areas)
    # Representative: the largest face of the group (the first one on ties).
    order = np.lexsort((np.arange(n), -areas, group))
    rep = order[np.r_[True, group[order][1:] != group[order][:-1]]]
    ranked = np.lexsort((rep, -total))
    return normals[rep[ranked]]


def _min_area_rectangle(xy: np.ndarray) -> tuple[float, float]:
    """Sides of the minimum-area rectangle enclosing 2-D points: one side lies along an
    edge of their convex hull (rotating calipers)."""
    ring = _convex_ring(xy)
    if ring is None:
        return 0.0, float(np.ptp(xy, axis=0).max())  # collinear: a segment
    edges = np.concatenate((ring[1:], ring[:1])) - ring
    d = edges / np.hypot(edges[:, 0], edges[:, 1])[:, None]  # unit edge directions
    m = np.stack([-d[:, 1], d[:, 0]], axis=1)  # inward normals
    if len(ring) <= 512:  # every edge against every vertex: fewer steps than the calipers
        width, height = np.ptp(np.einsum("ij,kj->ik", d, ring), axis=1), np.ptp(np.einsum("ij,kj->ik", m, ring), axis=1)
    else:
        angle = np.arctan2(d[:, 1], d[:, 0])
        angle = angle[0] + np.mod(angle - angle[0], 2 * np.pi)  # increasing around the ring

        def extreme(direction, offset):
            """max of ring . direction, the direction being at angle `angle + offset`:
            vertex j + 1 is the farthest along the angles between the outward normals of
            edges j and j + 1. Its neighbours are checked too (rounding of nearly
            collinear edges)."""
            target = angle[0] + np.mod(angle + offset - (angle[0] - np.pi / 2), 2 * np.pi) - np.pi / 2
            j = np.searchsorted(angle - np.pi / 2, target, side="right")
            idx = (j[:, None] + np.array([-1, 0, 1])) % len(ring)
            return np.einsum("kij,kj->ki", ring[idx], direction).max(axis=1)

        width = extreme(d, 0.0) + extreme(-d, np.pi)
        height = extreme(m, np.pi / 2) - np.einsum("ij,ij->i", ring, m)
    k = np.argmin(width * height)
    return float(width[k]), float(height[k])


def _convex_ring(xy: np.ndarray) -> np.ndarray | None:
    """Vertices of the convex hull of 2-D points, counter-clockwise (None if collinear).

    The points of a projected silhouette usually all lie on the outline: sorted by angle
    around their mean they already form a strictly convex polygon, which is checked;
    Qhull is the fallback.
    """
    from scipy.spatial import ConvexHull, QhullError

    c = xy.mean(axis=0)
    ring = xy[np.argsort(np.arctan2(xy[:, 1] - c[1], xy[:, 0] - c[0]))]
    e = np.concatenate((ring[1:], ring[:1])) - ring
    f = np.concatenate((e[1:], e[:1]))
    turn = e[:, 0] * f[:, 1] - e[:, 1] * f[:, 0]
    if len(ring) >= 3 and np.all(turn > 0):
        return ring
    try:
        return xy[ConvexHull(xy).vertices]
    except (QhullError, ValueError):
        return None
