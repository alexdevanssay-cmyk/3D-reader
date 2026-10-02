import math

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Writer
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

from reader3d.analyze import analyze_file
from reader3d.cad import _compound
from reader3d.server import app


def write_step(shape, path, unit="MM"):
    Interface_Static.SetCVal_s("write.step.unit", unit)
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    assert writer.Write(str(path)) == IFSelect_RetDone
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    return path


def holed_block():
    """100 x 60 x 20 block with a through hole of radius 10: a part whose real
    volume is far from its bounding box volume."""
    block = BRepPrimAPI_MakeBox(100.0, 60.0, 20.0).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(50, 30, -1), gp_Dir(0, 0, 1)), 10.0, 22.0).Shape()
    return BRepAlgoAPI_Cut(block, hole).Shape()


HOLED_VOLUME = 100 * 60 * 20 - math.pi * 10**2 * 20


def test_step_exact_volume_of_curved_part(tmp_path):
    r = analyze_file(write_step(holed_block(), tmp_path / "block.step"))
    s = r["summary"]
    # Exact B-rep volume: not affected by the tessellation of the hole.
    assert s["volume"] == pytest.approx(HOLED_VOLUME, rel=1e-9)
    assert s["bbox"]["size"] == pytest.approx([100, 60, 20], abs=1e-6)
    assert s["bbox"]["volume"] == pytest.approx(120000, rel=1e-9)
    assert s["fill_ratio"] == pytest.approx(HOLED_VOLUME / 120000)
    expected_area = 2 * (100 * 60 + 100 * 20 + 60 * 20) - 2 * math.pi * 100 + 2 * math.pi * 10 * 20
    assert s["area"] == pytest.approx(expected_area, rel=1e-9)
    assert s["centroid"] == pytest.approx([50, 30, 10], abs=1e-6)


def test_volume_independent_of_display_quality(tmp_path):
    path = write_step(BRepPrimAPI_MakeSphere(7.0).Shape(), tmp_path / "sphere.stp")
    exact = 4 / 3 * math.pi * 7**3
    for quality in ("coarse", "normal", "fine"):
        b = analyze_file(path, quality=quality)["bodies"][0]
        assert b["volume"] == pytest.approx(exact, rel=1e-9)
        # The display mesh only approximates it, and gets closer when finer.
        assert b["mesh_volume"] == pytest.approx(exact, rel=0.02)


def test_step_in_metres_is_converted_to_mm(tmp_path):
    path = write_step(BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape(), tmp_path / "box_m.step", unit="M")
    s = analyze_file(path)["summary"]
    assert s["volume"] == pytest.approx(6000, rel=1e-9)
    assert s["bbox"]["size"] == pytest.approx([10, 20, 30], abs=1e-6)


def test_multiple_solids_are_listed_and_summed(tmp_path):
    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(50, 0, 0), gp_Dir(0, 0, 1)), 5.0, 10.0).Shape()
    r = analyze_file(write_step(_compound([box, cyl]), tmp_path / "two.step"))
    vols = sorted(b["volume"] for b in r["bodies"])
    assert vols == pytest.approx(sorted([1000, math.pi * 25 * 10]), rel=1e-9)
    assert r["summary"]["volume"] == pytest.approx(1000 + math.pi * 250, rel=1e-9)
    assert r["summary"]["solids"] == 2


def test_iges_and_brep(tmp_path):
    shape = holed_block()
    iges = tmp_path / "block.igs"
    writer = IGESControl_Writer("MM", 1)
    writer.AddShape(shape)
    writer.ComputeModel()
    assert writer.Write(str(iges))
    brep = tmp_path / "block.brep"
    assert BRepTools.Write_s(shape, str(brep))

    assert analyze_file(brep)["summary"]["volume"] == pytest.approx(HOLED_VOLUME, rel=1e-9)
    # IGES usually stores trimmed surfaces only: the solid is rebuilt by sewing.
    assert analyze_file(iges)["summary"]["volume"] == pytest.approx(HOLED_VOLUME, rel=1e-6)


def test_stl_closed_mesh(tmp_path):
    path = tmp_path / "box.stl"
    trimesh.creation.box((10, 20, 30)).export(path)
    s = analyze_file(path)["summary"]
    assert s["volume"] == pytest.approx(6000)
    assert s["area"] == pytest.approx(2 * (200 + 300 + 600))


def test_mesh_units(tmp_path):
    path = tmp_path / "box.stl"
    trimesh.creation.box((1, 2, 3)).export(path)
    assert analyze_file(path, unit="cm")["summary"]["volume"] == pytest.approx(6000)
    assert analyze_file(path, unit="in")["summary"]["volume"] == pytest.approx(6 * 25.4**3)

    glb = tmp_path / "box.glb"
    trimesh.creation.box((0.01, 0.02, 0.03)).export(glb)  # glTF is in metres
    assert analyze_file(glb)["summary"]["volume"] == pytest.approx(6000)


def test_inverted_mesh_gives_positive_volume(tmp_path):
    mesh = trimesh.creation.box((10, 10, 10))
    mesh.invert()
    path = tmp_path / "inv.obj"
    mesh.export(path)
    r = analyze_file(path)
    assert r["summary"]["volume"] == pytest.approx(1000)
    assert any("inwards" in n for n in r["bodies"][0]["notes"])


def test_open_mesh_has_no_volume(tmp_path):
    # A flat sheet has no enclosed volume and cannot be closed by filling holes.
    sheet = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces=[[0, 1, 2], [0, 2, 3]])
    sheet = trimesh.util.concatenate([sheet, sheet.copy().apply_translation([0, 0, 1])])
    path = tmp_path / "sheet.ply"
    sheet.export(path)
    r = analyze_file(path)
    assert r["summary"]["volume"] is None
    assert r["bodies"][0]["closed"] is False


def test_mesh_payload_roundtrip(tmp_path):
    import base64

    path = tmp_path / "box.stl"
    trimesh.creation.box((1, 1, 1)).export(path)
    b = analyze_file(path)["bodies"][0]
    pos = np.frombuffer(base64.b64decode(b["mesh"]["positions"]), dtype="<f4").reshape(-1, 3)
    idx = np.frombuffer(base64.b64decode(b["mesh"]["indices"]), dtype="<u4").reshape(-1, 3)
    assert len(idx) == b["triangles"] == 12
    assert idx.max() < len(pos)


def test_api(tmp_path):
    client = TestClient(app)
    assert client.get("/").status_code == 200
    assert ".step" in client.get("/api/formats").json()["extensions"]

    path = write_step(holed_block(), tmp_path / "block.step")
    with path.open("rb") as f:
        res = client.post("/api/analyze", files={"file": ("block.step", f)}, data={"quality": "coarse"})
    assert res.status_code == 200
    assert res.json()["summary"]["volume"] == pytest.approx(HOLED_VOLUME, rel=1e-9)

    res = client.post("/api/analyze", files={"file": ("notes.txt", b"hello")})
    assert res.status_code == 400
    res = client.post("/api/analyze", files={"file": ("broken.step", b"not a step file")})
    assert res.status_code == 422
