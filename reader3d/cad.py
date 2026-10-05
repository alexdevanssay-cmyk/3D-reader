"""Exact (B-rep) reading of CAD files: STEP, IGES and BREP, via OpenCascade.

Volumes, areas and centres of mass come from OpenCascade's BRepGProp, which
integrates over the real NURBS/analytic surfaces of the solid. They do not
depend on the display tessellation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.GeomAbs import GeomAbs_CurveType, GeomAbs_SurfaceType
from OCP.gp import gp_Pnt, gp_Vec
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESCAFControl import IGESCAFControl_Reader
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape, TopoDS_Shell
from OCP.UnitsMethods import UnitsMethods_LengthUnit_Millimeter
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

try:
    from OCP.collections import Sequence_TDF_Label
except ImportError:  # cadquery-ocp < 8 (the only choice on Python 3.10)
    from OCP.TDF import TDF_LabelSequence as Sequence_TDF_Label

from .model import Body

CAD_EXTENSIONS = {".step": "step", ".stp": "step", ".p21": "step", ".iges": "iges", ".igs": "iges", ".brep": "brep", ".brp": "brep"}

# Display tessellation presets: (linear deflection as a fraction of the model
# diagonal, angular deflection in radians). They only affect the 3D view and
# the mesh cross-check; the reported volume is exact whatever the preset.
QUALITY = {
    "coarse": (2e-3, 0.5),
    "normal": (5e-4, 0.3),
    "fine": (1e-4, 0.1),
}

# Relative accuracy of BRepGProp's adaptive integration. The default (fixed Gauss
# order) is exact on planes and quadrics but off by up to a few tenths of a percent
# on rational NURBS surfaces; with Eps the integration is refined until it converges.
# Eps is an estimate: 1e-9 still left 2e-7 on a NURBS torus, 1e-10 leaves 2e-8 (for
# about 20 % more integration time). Same value in web/engine/cad.js.
GPROP_EPS = 1e-10


# Names some CAD systems give to the shape itself instead of the product.
_GENERIC_NAMES = {"SOLID", "COMPOUND", "SHELL", "BODY", "FACE", "OPEN SHELL", "CLOSED SHELL", "MANIFOLD_SOLID_BREP", "BREP", "NONE", "UNNAMED"}


@dataclass
class _Part:
    name: str
    shape: TopoDS_Shape
    color: tuple[float, float, float] | None


def read_cad(path: str | Path, fmt: str | None = None, quality: str = "normal") -> list[Body]:
    path = Path(path)
    fmt = fmt or CAD_EXTENSIONS[path.suffix.lower()]
    parts = _read_brep(path) if fmt == "brep" else _read_xcaf(path, fmt)
    if not parts:
        raise ValueError("The file does not contain any geometry")

    root = _compound([p.shape for p in parts])
    lin, ang = QUALITY.get(quality, QUALITY["normal"])
    deflection = max(_bbox_diagonal(root) * lin, 1e-6)
    BRepMesh_IncrementalMesh(root, deflection, False, ang, True)

    bodies: list[Body] = []
    open_parts: list[tuple[_Part, list[TopoDS_Shape], bool]] = []
    for part in parts:
        solids, open_shapes = [], []
        for solid in _children(part.shape, TopAbs_SOLID):
            # A solid bounded by an open shell (faces missing) has no meaningful
            # volume: its shells are handled like the loose surfaces of the file.
            shells = _children(solid, TopAbs_SHELL)
            if all(BRep_Tool.IsClosed_s(shell) for shell in shells):
                solids.append(solid)
            else:
                open_shapes += shells
        for i, solid in enumerate(solids):
            name = part.name if len(solids) == 1 else f"{part.name} [{i + 1}]"
            bodies.append(_solid_body(name, solid, part.color, []))
        open_shapes += _children(part.shape, TopAbs_SHELL, avoid=TopAbs_SOLID)
        open_shapes += _children(part.shape, TopAbs_FACE, avoid=TopAbs_SHELL)
        if open_shapes:
            open_parts.append((part, open_shapes, bool(solids)))

    if open_parts:
        bodies.extend(_surface_bodies(open_parts, path.stem, deflection, ang))
    return [b for b in bodies if len(b.faces)]


# --------------------------------------------------------------------------- readers


def _read_brep(path: Path) -> list[_Part]:
    shape = TopoDS_Shape()
    if not BRepTools.Read_s(shape, str(path), BRep_Builder()):
        raise ValueError("Unable to read BREP file")
    return [_Part(path.stem, shape, None)]


def _read_xcaf(path: Path, fmt: str) -> list[_Part]:
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    # Ask OpenCascade to convert everything to millimetres whatever the file unit.
    XCAFDoc_DocumentTool.SetLengthUnit_s(doc, 1.0, UnitsMethods_LengthUnit_Millimeter)

    reader = STEPCAFControl_Reader() if fmt == "step" else IGESCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"Unable to read {fmt.upper()} file")
    if not reader.Transfer(doc):
        raise ValueError(f"Unable to transfer {fmt.upper()} geometry")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    parts: list[_Part] = []

    # Colour precedence of XCAF (as displayed by XCAFPrs_DocumentExplorer): the
    # colour set on the instance (component), then the label's own colour, then
    # the colour inherited from the enclosing assembly instance.
    def walk(label: TDF_Label, loc: TopLoc_Location, inherited_name: str | None, inherited_color, instance_color=None):
        color = instance_color or _label_color(label) or inherited_color
        own_name = _label_name(label)
        if XCAFDoc_ShapeTool.IsAssembly_s(label):
            # Assembly / product labels carry the meaningful part names (PLATE, BOLT...)
            inherited_name = own_name or inherited_name
            comps = Sequence_TDF_Label()
            XCAFDoc_ShapeTool.GetComponents_s(label, comps)
            for i in range(1, comps.Length() + 1):
                comp = comps.Value(i)
                ref = TDF_Label()
                XCAFDoc_ShapeTool.GetReferredShape_s(comp, ref)
                walk(ref, loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(comp)), _label_name(comp) or inherited_name, color, _label_color(comp))
        else:
            shape = XCAFDoc_ShapeTool.GetShape_s(label)
            if shape.IsNull():
                return
            if own_name and own_name.upper() in _GENERIC_NAMES:
                own_name = None
            name = own_name or inherited_name or f"Part {len(parts) + 1}"
            if color is None:
                color = _shape_color(color_tool, shape)
            parts.append(_Part(name, shape.Moved(loc), color))

    free = Sequence_TDF_Label()
    shape_tool.GetFreeShapes(free)
    for i in range(1, free.Length() + 1):
        walk(free.Value(i), TopLoc_Location(), None, None)
    return parts


def _label_name(label: TDF_Label) -> str | None:
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        name = attr.Get().ToExtString().strip()
        # OpenCascade names unnamed instances like "=>[0:1:1:3]"; ignore those.
        if name and not name.startswith("=>"):
            return name
    return None


def _label_color(label: TDF_Label):
    for ctype in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        color_label = TDF_Label()
        if XCAFDoc_ColorTool.GetColor_s(label, ctype, color_label):
            col = Quantity_Color()
            if XCAFDoc_ColorTool.GetColor_s(color_label, col):
                return _rgb(col)
    return None


def _shape_color(color_tool, shape: TopoDS_Shape):
    for ctype in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        col = Quantity_Color()
        if color_tool.GetColor(shape, ctype, col):
            return _rgb(col)
    return None


def _rgb(col: Quantity_Color) -> tuple[float, float, float]:
    r, g, b = col.Values(Quantity_TOC_sRGB)
    return (float(r), float(g), float(b))


# --------------------------------------------------------------------------- bodies


def _surface_bodies(open_parts, file_name: str, deflection: float, ang: float) -> list[Body]:
    """Bodies for the geometry that is not inside a solid.

    Surface models are often exported with every face as its own "part", so the
    loose surfaces of the whole file are sewn together; the closed shells that
    result become solids whose volume can be computed.
    """
    all_open = [shape for _, shapes, _ in open_parts for shape in shapes]
    sewn_solids, remaining = _sew_to_solids(all_open, deflection, ang)
    if not sewn_solids:
        bodies = []
        for part, shapes, has_solids in open_parts:
            name = f"{part.name} (surfaces)" if has_solids else part.name
            bodies.append(_open_body(name, _compound(shapes), part.color))
        return bodies

    single = len(open_parts) == 1
    base = open_parts[0][0].name if single else file_name
    color = open_parts[0][0].color if single else None
    bodies = []
    for i, solid in enumerate(sewn_solids):
        name = base if len(sewn_solids) == 1 else f"{base} [{i + 1}]"
        bodies.append(_solid_body(name, solid, color, ["Solid rebuilt by sewing the surfaces of the file"]))
    if remaining:
        bodies.append(_open_body(f"{base} (surfaces)", _compound(remaining), color))
    return bodies


def _solid_body(name: str, solid: TopoDS_Shape, color, notes: list[str]) -> Body:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props, GPROP_EPS)
    volume = props.Mass()
    if volume < 0:
        notes.append("Solid had inverted orientation; volume sign corrected")
        volume = -volume
    com = props.CentreOfMass()

    verts, faces = _triangulate(solid)
    mesh_volume = abs(_mesh_signed_volume(verts, faces)) if len(faces) else None
    bmin, bmax = _bbox(solid)
    return Body(
        name=name,
        vertices=verts,
        faces=faces,
        volume=float(volume),
        area=_area(solid),
        bbox_min=bmin,
        bbox_max=bmax,
        centroid=(com.X(), com.Y(), com.Z()),
        closed=True,
        method="brep",
        mesh_volume=mesh_volume,
        color=color,
        notes=notes,
    )


def _open_body(name: str, shape: TopoDS_Shape, color) -> Body:
    verts, faces = _triangulate(shape)
    bmin, bmax = _bbox(shape)
    return Body(
        name=name,
        vertices=verts,
        faces=faces,
        volume=None,
        area=_area(shape),
        bbox_min=bmin,
        bbox_max=bmax,
        centroid=None,
        closed=False,
        method="brep",
        color=color,
        notes=["Open surfaces (not a closed solid): no volume can be computed"],
    )


def _sew_to_solids(shapes: list[TopoDS_Shape], deflection: float, ang: float):
    sewing = BRepBuilderAPI_Sewing(1e-3)
    for s in shapes:
        sewing.Add(s)
    sewing.Perform()
    sewn = sewing.SewedShape()
    # A closed surface made of a single face (sphere, torus...) is left by sewing as a
    # free face: wrap it in a shell of its own, which may be closed like the others.
    shells = _children(sewn, TopAbs_SHELL) + [_shell(f) for f in _children(sewn, TopAbs_FACE, avoid=TopAbs_SHELL)]
    solids, remaining = [], []
    for shell in shells:
        if BRep_Tool.IsClosed_s(shell):
            maker = BRepBuilderAPI_MakeSolid(TopoDS.Shell(shell))
            if maker.IsDone():
                solids.append(maker.Solid())
                continue
        remaining.append(shell)
    if solids:
        # Sewing creates new faces without triangulation: mesh them like the originals.
        BRepMesh_IncrementalMesh(_compound(solids + remaining), deflection, False, ang, True)
    return solids, remaining


# --------------------------------------------------------------------------- helpers


def _children(shape: TopoDS_Shape, kind, avoid=None) -> list[TopoDS_Shape]:
    exp = TopExp_Explorer(shape, kind, avoid) if avoid is not None else TopExp_Explorer(shape, kind)
    out = []
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def _compound(shapes: list[TopoDS_Shape]) -> TopoDS_Compound:
    comp = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(comp)
    for s in shapes:
        builder.Add(comp, s)
    return comp


def _shell(face: TopoDS_Shape) -> TopoDS_Shell:
    shell = TopoDS_Shell()
    builder = BRep_Builder()
    builder.MakeShell(shell)
    builder.Add(shell, face)
    return shell


def _area(shape: TopoDS_Shape) -> float:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props, GPROP_EPS)
    return float(props.Mass())


# Faces whose exact box BRepBndLib.AddOptimal finds in every OpenCascade version:
# planes, quadrics, tori and the ruled surfaces (their extremes lie on the edges).
# OpenCascade 8.0 gets the other ones wrong: a surface of revolution of a curve gets a
# box up to twice too large, some B-spline surfaces one that is too small.
_EXACT_BOX_SURFACES = {
    GeomAbs_SurfaceType.GeomAbs_Plane,
    GeomAbs_SurfaceType.GeomAbs_Cylinder,
    GeomAbs_SurfaceType.GeomAbs_Cone,
    GeomAbs_SurfaceType.GeomAbs_Sphere,
    GeomAbs_SurfaceType.GeomAbs_Torus,
    GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion,
}


def _bbox(shape: TopoDS_Shape):
    """Exact axis-aligned box, as BRepBndLib.AddOptimal of OpenCascade 7 (the browser
    engine) computes it: free-form faces are measured by _add_surface_box."""
    box = Bnd_Box()
    for f in _children(shape, TopAbs_FACE):
        face = TopoDS.Face(f)
        surface = BRepAdaptor_Surface(face) if BRep_Tool.Surface_s(face) is not None else None
        exact = surface is None or surface.GetType() in _EXACT_BOX_SURFACES or _is_ruled(surface)
        if exact or not _add_surface_box(surface, face, box):
            BRepBndLib.AddOptimal_s(face, box, False, False)
    for item in _children(shape, TopAbs_EDGE, avoid=TopAbs_FACE) + _children(shape, TopAbs_VERTEX, avoid=TopAbs_EDGE):
        BRepBndLib.AddOptimal_s(item, box, False, False)
    if box.IsVoid():
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    lo, hi = box.CornerMin(), box.CornerMax()
    return (lo.X(), lo.Y(), lo.Z()), (hi.X(), hi.Y(), hi.Z())


def _is_ruled(surface: BRepAdaptor_Surface) -> bool:
    """Surfaces with straight lines in one direction (OpenCascade's CanUseEdges)."""
    kind = surface.GetType()
    if kind == GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution:
        return surface.BasisCurve().GetType() == GeomAbs_CurveType.GeomAbs_Line
    if kind == GeomAbs_SurfaceType.GeomAbs_BSplineSurface:
        b = surface.BSpline()
        return (b.UDegree() == 1 and b.NbUKnots() == 2) or (b.VDegree() == 1 and b.NbVKnots() == 2)
    if kind == GeomAbs_SurfaceType.GeomAbs_BezierSurface:
        b = surface.Bezier()
        return b.UDegree() == 1 or b.VDegree() == 1
    return False


def _add_surface_box(surface: BRepAdaptor_Surface, face, box: Bnd_Box) -> bool:
    """Add the box of a free-form face: the extremes of x, y and z over the parameter
    range of the face, sampled on a grid (and on every knot span) then refined by
    Newton's method from the best samples, plus the boxes of its edges. Returns False
    when the face cannot be measured this way."""
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    if not np.all(np.isfinite([u0, u1, v0, v1])) or u1 <= u0 or v1 <= v0:
        return False
    knots_u = knots_v = None
    if surface.GetType() == GeomAbs_SurfaceType.GeomAbs_BSplineSurface:
        b = surface.BSpline()
        knots_u = [b.UKnot(i) for i in range(1, b.NbUKnots() + 1)]
        knots_v = [b.VKnot(i) for i in range(1, b.NbVKnots() + 1)]
    us, vs = _samples(u0, u1, knots_u), _samples(v0, v1, knots_v)
    try:
        pts = np.array([[surface.Value(u, v).Coord() for v in vs] for u in us])
    except Exception:  # noqa: BLE001 - singular surface: OpenCascade's own box
        return False
    lo, hi = pts.min(axis=(0, 1)), pts.max(axis=(0, 1))
    domain = np.array([[u0, u1], [v0, v1]])
    for k in range(3):
        for sign in (1.0, -1.0):
            f = sign * pts[:, :, k]
            for flat in np.argsort(f, axis=None)[-3:]:
                i, j = np.unravel_index(flat, f.shape)
                best = _surface_extreme(surface, k, sign, np.array([us[i], vs[j]]), f[i, j], domain)
                lo[k], hi[k] = (lo[k], max(hi[k], best)) if sign > 0 else (min(lo[k], -best), hi[k])
    # Same enlargement as OpenCascade's optimal box of a surface (Precision::Confusion).
    local = Bnd_Box()
    local.Update(*(lo - 1e-7), *(hi + 1e-7))
    box.Add(local)
    for edge in _children(face, TopAbs_EDGE):
        BRepBndLib.AddOptimal_s(edge, box, False, False)
    return True


def _samples(lo: float, hi: float, knots) -> np.ndarray:
    """Sample parameters: 21 over the range, or a few in every B-spline knot span (at
    most 61)."""
    inner = [] if knots is None else [k for k in knots if lo < k < hi]
    if not inner:
        return np.linspace(lo, hi, 21)
    ends = [lo, *inner, hi]
    per = max(2, min(8, 60 // len(ends)))
    out = np.unique(np.concatenate([np.linspace(a, b, per + 1) for a, b in zip(ends[:-1], ends[1:])]))
    return out[np.round(np.linspace(0, len(out) - 1, 61)).astype(int)] if len(out) > 61 else out


def _surface_extreme(surface: BRepAdaptor_Surface, k: int, sign: float, x: np.ndarray, fx: float, domain: np.ndarray) -> float:
    """Local maximum of sign * coordinate k of the surface over the parameter rectangle,
    from (u, v) = x: Newton steps (gradient steps where the surface is not concave),
    on the free parameters (those not held at a bound), with backtracking."""
    p, du, dv, duu, dvv, duv = gp_Pnt(), gp_Vec(), gp_Vec(), gp_Vec(), gp_Vec(), gp_Vec()
    span = domain[:, 1] - domain[:, 0]
    for _ in range(40):
        try:
            surface.D2(x[0], x[1], p, du, dv, duu, dvv, duv)
        except Exception:  # noqa: BLE001 - not C2 here: keep the best value found
            break
        g = sign * np.array([du.Coord()[k], dv.Coord()[k]])
        h = sign * np.array([[duu.Coord()[k], duv.Coord()[k]], [duv.Coord()[k], dvv.Coord()[k]]])
        free = ~(((x <= domain[:, 0]) & (g < 0)) | ((x >= domain[:, 1]) & (g > 0)))
        if not free.any() or not np.any(g[free]):
            break
        step = np.zeros(2)
        hf, gf = h[np.ix_(free, free)], g[free]
        if np.all(np.linalg.eigvalsh(hf) < 0):
            step[free] = -np.linalg.solve(hf, gf)
        else:
            step[free] = 0.05 * gf / np.linalg.norm(gf / span[free])  # 5 % of the range uphill
        for _ in range(30):
            y = np.clip(x + step, domain[:, 0], domain[:, 1])
            fy = sign * surface.Value(y[0], y[1]).Coord()[k]
            if fy > fx:
                break
            step /= 2
        else:
            break
        moved = np.abs(y - x).max() / span.max()
        x, fx = y, fy
        if moved < 1e-15:
            break
    return fx


def _bbox_diagonal(shape: TopoDS_Shape) -> float:
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, False)
    if box.IsVoid():
        return 1.0
    return float(np.sqrt(box.SquareExtent()))


def _triangulate(shape: TopoDS_Shape) -> tuple[np.ndarray, np.ndarray]:
    all_verts, all_faces, offset = [], [], 0
    for f in _children(shape, TopAbs_FACE):
        face = TopoDS.Face(f)
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        trsf = loc.Transformation()
        n = tri.NbNodes()
        verts = np.empty((n, 3))
        for i in range(n):
            p = tri.Node(i + 1).Transformed(trsf)
            verts[i] = (p.X(), p.Y(), p.Z())
        m = tri.NbTriangles()
        faces = np.empty((m, 3), dtype=np.int64)
        for i in range(m):
            faces[i] = tri.Triangle(i + 1).Get()
        faces -= 1
        if face.Orientation() == TopAbs_REVERSED:
            faces = faces[:, [0, 2, 1]]
        all_verts.append(verts)
        all_faces.append(faces + offset)
        offset += n
    if not all_verts:
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    return np.vstack(all_verts), np.vstack(all_faces)


def _mesh_signed_volume(verts: np.ndarray, faces: np.ndarray) -> float:
    tri = verts[faces]
    tri = tri - verts.mean(axis=0)  # better numerical conditioning far from the origin
    return float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6.0)
