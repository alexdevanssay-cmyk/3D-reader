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
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.collections import Sequence_TDF_Label
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESCAFControl import IGESCAFControl_Reader
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape
from OCP.UnitsMethods import UnitsMethods_LengthUnit_Millimeter
from OCP.XCAFDoc import XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

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
    diag = _bbox_diagonal(root)
    BRepMesh_IncrementalMesh(root, max(diag * lin, 1e-6), False, ang, True)

    bodies: list[Body] = []
    for part in parts:
        bodies.extend(_part_bodies(part))
    return bodies


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

    def walk(label: TDF_Label, loc: TopLoc_Location, inherited_name: str | None, inherited_color):
        color = _label_color(label) or inherited_color
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
                walk(ref, loc.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(comp)), _label_name(comp) or inherited_name, _label_color(comp) or color)
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


def _part_bodies(part: _Part) -> list[Body]:
    solids = _children(part.shape, TopAbs_SOLID)
    bodies: list[Body] = []

    open_shapes: list[TopoDS_Shape] = []
    open_shapes += _children(part.shape, TopAbs_SHELL, avoid=TopAbs_SOLID)
    open_shapes += _children(part.shape, TopAbs_FACE, avoid=TopAbs_SHELL)

    notes: list[str] = []
    if open_shapes and not solids:
        # Surface model: try to sew the faces into closed shells and make solids of them.
        sewn_solids, remaining = _sew_to_solids(open_shapes)
        if sewn_solids:
            notes.append("Solid rebuilt by sewing the surfaces of the file")
            solids = sewn_solids
            open_shapes = remaining

    for i, solid in enumerate(solids):
        name = part.name if len(solids) == 1 else f"{part.name} [{i + 1}]"
        bodies.append(_solid_body(name, solid, part.color, list(notes)))

    if open_shapes:
        name = part.name if not bodies else f"{part.name} (surfaces)"
        bodies.append(_open_body(name, _compound(open_shapes), part.color))
    return [b for b in bodies if len(b.faces)]


def _solid_body(name: str, solid: TopoDS_Shape, color, notes: list[str]) -> Body:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
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


def _sew_to_solids(shapes: list[TopoDS_Shape]):
    sewing = BRepBuilderAPI_Sewing(1e-3)
    for s in shapes:
        sewing.Add(s)
    sewing.Perform()
    sewn = sewing.SewedShape()
    solids, remaining = [], []
    for shell in _children(sewn, TopAbs_SHELL):
        if BRep_Tool.IsClosed_s(shell):
            maker = BRepBuilderAPI_MakeSolid(TopoDS.Shell(shell))
            if maker.IsDone():
                solids.append(maker.Solid())
                continue
        remaining.append(shell)
    remaining += _children(sewn, TopAbs_FACE, avoid=TopAbs_SHELL)
    if solids:
        # The sewn shapes were never meshed; mesh them like the originals.
        root = _compound(solids + remaining)
        BRepMesh_IncrementalMesh(root, max(_bbox_diagonal(root) * QUALITY["normal"][0], 1e-6), False, QUALITY["normal"][1], True)
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


def _area(shape: TopoDS_Shape) -> float:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return float(props.Mass())


def _bbox(shape: TopoDS_Shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    lo, hi = box.CornerMin(), box.CornerMax()
    return (lo.X(), lo.Y(), lo.Z()), (hi.X(), hi.Y(), hi.Z())


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
