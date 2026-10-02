"""Generate the cross-engine fixture set.

Writes 3D files with known geometry into OUTDIR, plus ``expected.json`` holding
the Python engine's results for each of them. The browser (WebAssembly) engine
tests load the same files and must reproduce these numbers.

    python tests/make_fixtures.py tests/fixtures/generated
"""

from __future__ import annotations

import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
import trimesh
from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Writer
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS_Compound
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from reader3d.analyze import analyze_file  # noqa: E402

SAMPLES = ROOT / "tests" / "fixtures" / "samples"


# --------------------------------------------------------------------------- CAD


def holed_block():
    block = BRepPrimAPI_MakeBox(100.0, 60.0, 20.0).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(50, 30, -1), gp_Dir(0, 0, 1)), 10.0, 22.0).Shape()
    return BRepAlgoAPI_Cut(block, hole).Shape()


def compound(shapes):
    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    for s in shapes:
        b.Add(comp, s)
    return comp


def write_step(shape, path, unit="MM"):
    Interface_Static.SetCVal_s("write.step.unit", unit)
    w = STEPControl_Writer()
    w.Transfer(shape, STEPControl_AsIs)
    assert w.Write(str(path)) == IFSelect_RetDone
    Interface_Static.SetCVal_s("write.step.unit", "MM")


def write_named_assembly(path):
    """Two parts with names (one non-ASCII) and colours, the second one placed
    with a translation, written through XCAF like a real CAD export."""
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    assembly = shapes.NewShape()
    TDataStd_Name.Set_s(assembly, TCollection_ExtendedString("Assemblage", True))

    bracket = shapes.AddShape(BRepPrimAPI_MakeBox(40.0, 30.0, 5.0).Shape(), False)
    TDataStd_Name.Set_s(bracket, TCollection_ExtendedString("Équerre", True))
    colors.SetColor(bracket, Quantity_Color(0.8, 0.2, 0.1, Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    pin = shapes.AddShape(BRepPrimAPI_MakeCylinder(4.0, 25.0).Shape(), False)
    TDataStd_Name.Set_s(pin, TCollection_ExtendedString("Pin", True))
    colors.SetColor(pin, Quantity_Color(0.1, 0.3, 0.9, Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorSurf)

    shapes.AddComponent(assembly, bracket, TopLoc_Location())
    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(20, 15, 5))
    shapes.AddComponent(assembly, pin, TopLoc_Location(trsf))
    shapes.UpdateAssemblies()

    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    assert writer.Transfer(doc, STEPControl_AsIs)
    assert writer.Write(str(path)) == IFSelect_RetDone


def write_surface_model(path):
    """A closed box exported as loose faces (no solid): must be sewn back."""
    box = BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape()
    faces = []
    exp = TopExp_Explorer(box, TopAbs_FACE)
    while exp.More():
        faces.append(exp.Current())
        exp.Next()
    write_step(compound(faces), path)


def make_cad(out: Path):
    write_step(holed_block(), out / "holed_block.step")
    write_step(BRepPrimAPI_MakeSphere(7.0).Shape(), out / "sphere.stp")
    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(50, 0, 0), gp_Dir(0, 0, 1)), 5.0, 10.0).Shape()
    write_step(compound([box, cyl]), out / "two_solids.step")
    write_step(BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape(), out / "box_in_metres.step", unit="M")
    write_named_assembly(out / "named_assembly.step")
    write_surface_model(out / "surface_box.step")

    w = IGESControl_Writer("MM", 1)
    w.AddShape(holed_block())
    w.ComputeModel()
    assert w.Write(str(out / "holed_block.igs"))
    assert BRepTools.Write_s(holed_block(), str(out / "holed_block.brep"))

    for sample in SAMPLES.glob("*.stp"):
        shutil.copy(sample, out / sample.name)


# --------------------------------------------------------------------------- meshes


def make_meshes(out: Path):
    box = trimesh.creation.box((10, 20, 30))
    box.export(out / "box.stl")
    (out / "box_ascii.stl").write_bytes(trimesh.exchange.stl.export_stl_ascii(box).encode())
    trimesh.creation.icosphere(subdivisions=4, radius=10).export(out / "sphere.stl")

    inverted = box.copy()
    inverted.invert()
    inverted.export(out / "inverted.obj")

    # Missing one triangle: a single triangular hole that can be filled.
    holed = trimesh.creation.box((10, 10, 10))
    holed = trimesh.Trimesh(holed.vertices, holed.faces[:-1], process=False)
    holed.export(out / "missing_triangle.obj")

    sheet = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces=[[0, 1, 2], [0, 2, 3]])
    trimesh.util.concatenate([sheet, sheet.copy().apply_translation([0, 0, 1])]).export(out / "open_sheet.ply")

    # Two separate closed objects in one file, one of them off the origin.
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.creation.box((10, 10, 10)), node_name="cube", geom_name="cube")
    cyl = trimesh.creation.cylinder(radius=5, height=20, sections=48)
    scene.add_geometry(cyl, node_name="cylinder", geom_name="cylinder", transform=trimesh.transformations.translation_matrix([30, 0, 0]))
    scene.export(out / "two_objects.obj")
    scene.export(out / "two_objects.glb")  # glTF: interpreted as metres

    # XML-based formats (parsed with DOMParser in the browser engine: end-to-end tests only).
    trimesh.creation.box((10, 20, 30)).export(out / "box.3mf")  # 3MF default unit: millimetre
    trimesh.creation.box((10, 20, 30)).export(out / "box.dae")  # COLLADA default unit: metre

    trimesh.creation.box((10, 20, 30)).export(out / "box.off")
    trimesh.creation.box((10, 20, 30)).export(out / "box.ply")

    # A rotated box: its minimal oriented envelope is smaller than the axis-aligned one.
    rot = trimesh.creation.box((40, 10, 5))
    rot.apply_transform(trimesh.transformations.euler_matrix(0.3, 0.5, 0.7))
    rot.export(out / "rotated_box.stl")


# --------------------------------------------------------------------------- expected

ANALYTIC = {
    "holed_block.step": 100 * 60 * 20 - math.pi * 100 * 20,
    "holed_block.igs": 100 * 60 * 20 - math.pi * 100 * 20,
    "holed_block.brep": 100 * 60 * 20 - math.pi * 100 * 20,
    "sphere.stp": 4 / 3 * math.pi * 7**3,
    "two_solids.step": 1000 + math.pi * 25 * 10,
    "box_in_metres.step": 6000.0,
    "named_assembly.step": 40 * 30 * 5 + math.pi * 16 * 25,
    "surface_box.step": 6000.0,
    "box.stl": 6000.0,
    "box_ascii.stl": 6000.0,
    "inverted.obj": 6000.0,
    "missing_triangle.obj": 1000.0,
    "box.off": 6000.0,
    "box.3mf": 6000.0,
    "box.dae": 6000.0 * 1e9,
    "box.ply": 6000.0,
    "rotated_box.stl": 2000.0,
}


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    make_cad(out)
    make_meshes(out)
    expected = {}
    for path in sorted(out.iterdir()):
        if path.name == "expected.json":
            continue
        result = analyze_file(path, include_mesh=False)
        result.pop("elapsed_s", None)
        result["analytic_volume"] = ANALYTIC.get(path.name)
        expected[path.name] = result
        vol = result["summary"]["volume"]
        print(f"{path.name:24} volume={vol!r:>24}  analytic={ANALYTIC.get(path.name)!r}")
    (out / "expected.json").write_text(json.dumps(expected, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "tests" / "fixtures" / "generated"))
