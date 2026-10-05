import json
import math
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Writer
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer

from reader3d.analyze import analyze_file
from reader3d.cad import _compound
from reader3d.model import Body, summarize
from reader3d.server import app

GENERATED = Path(__file__).parent / "fixtures" / "generated"


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
    assert client.get("/app.js").status_code == 200
    assert client.get("/config.json").json()["server"] is True
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


def test_surface_model_is_sewn_into_a_solid(tmp_path):
    """A closed box exported as loose faces (one "part" per face after import)."""
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    faces = []
    exp = TopExp_Explorer(BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape(), TopAbs_FACE)
    while exp.More():
        faces.append(exp.Current())
        exp.Next()
    r = analyze_file(write_step(_compound(faces), tmp_path / "surfaces.step"))
    assert r["summary"]["volume"] == pytest.approx(6000, rel=1e-9)
    assert r["summary"]["open_bodies"] == 0
    assert "sewing" in r["bodies"][0]["notes"][0]


def test_oriented_envelope_never_exceeds_axis_aligned(tmp_path):
    # An L-shaped assembly where a heuristic oriented box is worse than the AABB.
    box = BRepPrimAPI_MakeBox(40.0, 30.0, 5.0).Shape()
    pin = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20, 15, 5), gp_Dir(0, 0, 1)), 4.0, 25.0).Shape()
    s = analyze_file(write_step(_compound([box, pin]), tmp_path / "l.step"))["summary"]
    assert s["obb"]["volume"] <= s["bbox"]["volume"] * (1 + 1e-9)


def test_solid_with_missing_faces_has_no_volume(tmp_path):
    """A SOLID whose shell is open (a face is missing) must not get an 'exact' volume."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    sewing = BRepBuilderAPI_Sewing(1e-6)
    exp = TopExp_Explorer(BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape(), TopAbs_FACE)
    for _ in range(5):  # leave one face out
        sewing.Add(exp.Current())
        exp.Next()
    sewing.Perform()
    shell = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL).Current()
    solid = BRepBuilderAPI_MakeSolid(TopoDS.Shell(shell)).Solid()
    path = tmp_path / "open_solid.brep"
    assert BRepTools.Write_s(solid, str(path))

    r = analyze_file(path)
    assert r["summary"]["volume"] is None
    assert r["bodies"][0]["closed"] is False
    assert r["bodies"][0]["area"] == pytest.approx(2 * (10 * 20 + 10 * 30 + 20 * 30) - 10 * 20, rel=1e-9)


def test_instance_colour_overrides_part_colour(tmp_path):
    from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    assembly = shapes.NewShape()
    part = shapes.AddShape(BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape(), False)
    colors.SetColor(part, Quantity_Color(0.0, 0.0, 1.0, Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    instance = shapes.AddComponent(assembly, part, TopLoc_Location())
    colors.SetColor(instance, Quantity_Color(1.0, 0.0, 0.0, Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    assert writer.Transfer(doc, STEPControl_AsIs)
    path = tmp_path / "coloured.step"
    assert writer.Write(str(path)) == IFSelect_RetDone

    body = analyze_file(path)["bodies"][0]
    assert body["color"] == pytest.approx([1.0, 0.0, 0.0], abs=1e-3)


def test_server_survives_a_crashing_file(tmp_path):
    """Some truncated IGES files crash OpenCascade natively (segmentation fault):
    the server isolates each analysis in a child process and answers 422."""
    import subprocess
    import sys

    iges = tmp_path / "block.igs"
    writer = IGESControl_Writer("MM", 1)
    writer.AddShape(holed_block())
    writer.ComputeModel()
    assert writer.Write(str(iges))
    data = iges.read_bytes()

    # Find a truncation that crashes the reader when run in-process.
    probe = "import sys; from reader3d.analyze import analyze_file\ntry: analyze_file(sys.argv[1])\nexcept Exception: pass"
    crashing = None
    for size in range(len(data) // 2, len(data), 491):
        cut = tmp_path / f"cut_{size}.igs"
        cut.write_bytes(data[:size])
        proc = subprocess.run([sys.executable, "-c", probe, str(cut)], capture_output=True, timeout=120)
        if proc.returncode < 0:  # killed by a signal
            crashing = cut
            break
    if crashing is None:
        pytest.skip("this OpenCascade build does not crash on truncated IGES files")

    client = TestClient(app)
    with crashing.open("rb") as f:
        res = client.post("/api/analyze", files={"file": ("cut.igs", f)})
    assert res.status_code == 422
    assert "crashed" in res.json()["detail"]
    # ...and the server still works afterwards.
    with (tmp_path / "block.igs").open("rb") as f:
        res = client.post("/api/analyze", files={"file": ("block.igs", f)})
    assert res.status_code == 200
    assert res.json()["summary"]["volume"] == pytest.approx(HOLED_VOLUME, rel=1e-6)


# --------------------------------------------------------------------------- review fixes


def boxes(*specs):
    """One mesh made of several boxes: (size, centre, inverted)."""
    parts = []
    for size, centre, inverted in specs:
        m = trimesh.creation.box(size)
        m.apply_translation(centre)
        if inverted:
            m.invert()
        parts.append(m)
    return trimesh.util.concatenate(parts)


def test_each_shell_of_a_mesh_is_oriented_on_its_own(tmp_path):
    """Separate bodies in one STL, some inside out: their volumes add up (they used to be
    subtracted, giving 0, 7000 or 1000 instead of 2000, 9000 or 3000)."""
    cases = [
        # two 10 mm cubes, the second inside out
        (boxes(((10, 10, 10), (0, 0, 0), False), ((10, 10, 10), (30, 0, 0), True)), 2000, [15, 0, 0]),
        # small cube inside out next to a correct 20 mm cube
        (boxes(((10, 10, 10), (0, 0, 0), True), ((20, 20, 20), (50, 0, 0), False)), 9000, [50 * 8000 / 9000, 0, 0]),
        # cube plus an inside-out 20 x 10 x 10 bar
        (boxes(((10, 10, 10), (0, 0, 0), False), ((20, 10, 10), (30, 0, 0), True)), 3000, [20, 0, 0]),
        # both inside out
        (boxes(((10, 10, 10), (0, 0, 0), True), ((20, 20, 20), (50, 0, 0), True)), 9000, [50 * 8000 / 9000, 0, 0]),
    ]
    for i, (mesh, volume, centroid) in enumerate(cases):
        path = tmp_path / f"shells_{i}.stl"
        mesh.export(path)
        r = analyze_file(path)
        b = r["bodies"][0]
        assert b["closed"] is True
        assert b["volume"] == pytest.approx(volume, rel=1e-12)
        assert b["centroid"] == pytest.approx(centroid, abs=1e-9)
        assert b["notes"] == ["Normals pointed inwards; volume sign corrected"]


def test_nested_shells_are_voids_and_islands(tmp_path):
    """A shell inside an odd number of others is a void, inside an even number material,
    whatever the orientation it was written with."""
    for flip_void, flip_island in ((True, False), (False, True), (False, False), (True, True)):
        mesh = boxes(
            ((20, 20, 20), (0, 0, 0), False),
            ((10, 10, 10), (2, 0, 0), flip_void),  # void (correct when inverted)
            ((4, 4, 4), (3, 0, 0), flip_island),  # island inside the void
        )
        path = tmp_path / "nested.stl"
        mesh.export(path)
        b = analyze_file(path)["bodies"][0]
        assert b["volume"] == pytest.approx(8000 - 1000 + 64, rel=1e-12)
        assert b["centroid"] == pytest.approx([(-1000 * 2 + 64 * 3) / 7064, 0, 0], abs=1e-9)
        corrected = not flip_void or flip_island
        assert b["notes"] == (["Normals pointed inwards; volume sign corrected"] if corrected else [])


def test_fixture_shells_match_analytic_volumes():
    for name, volume in (("two_cubes_one_inverted.stl", 2000), ("small_cube_inverted.stl", 9000), ("cube_with_void.stl", 7875)):
        assert analyze_file(GENERATED / name)["summary"]["volume"] == pytest.approx(volume, rel=1e-12), name


def test_python_reference_cases_of_the_browser_tests():
    """tests/js/mesh.test.mjs PYTHON_CASES (results and notes the browser engine must
    reproduce: trimesh.creation.box((10, 20, 30)) with faces flipped or removed), plus an
    inside-out box with a hole."""
    from reader3d.mesh import _mesh_body

    box = trimesh.creation.box((10, 20, 30))
    v, f = box.vertices, box.faces

    def flip(which):
        g = f.copy()
        g[which] = g[which][:, ::-1]
        return g

    cases = [
        (flip([0, 5]), 6000, ["Inconsistent triangle orientation was repaired", "Normals pointed inwards; volume sign corrected"]),
        (flip([1, 2, 3, 7]), 6000, ["Inconsistent triangle orientation was repaired"]),
        (np.delete(f, [0, 1], axis=0), 6000, ["Mesh was not closed (4 open edges); volume estimated after filling the holes"]),
        (np.delete(f, [0, 11], axis=0), 6000, ["Mesh was not closed (6 open edges); volume estimated after filling the holes"]),
        # inside out with a hole: oriented like a closed mesh before the estimate
        (
            np.delete(f, [0, 1], axis=0)[:, ::-1],
            6000,
            ["Normals pointed inwards; volume sign corrected", "Mesh was not closed (4 open edges); volume estimated after filling the holes"],
        ),
    ]
    for faces, volume, notes in cases:
        b = _mesh_body("m", trimesh.Trimesh(v, faces, process=False), None)
        assert b.notes == notes
        assert b.volume == pytest.approx(volume, rel=1e-9)
        assert b.centroid == pytest.approx([0, 0, 0], abs=1e-9)


def test_unwelded_triangle_soup_stays_open(tmp_path):
    """Facets whose corners do not weld: hole filling would cap every triangle with a
    reversed twin, a 'solid' of volume ~0. It is reported as open instead."""
    rng = np.random.RandomState(0)
    cube = trimesh.creation.box((10, 10, 10))
    tris = cube.triangles + rng.uniform(-1e-6, 1e-6, cube.triangles.shape)
    soup = trimesh.Trimesh(vertices=tris.reshape(-1, 3), faces=np.arange(36).reshape(-1, 3), process=False)
    path = tmp_path / "soup.stl"
    path.write_bytes(trimesh.exchange.stl.export_stl_ascii(soup).encode())
    r = analyze_file(path)
    b = r["bodies"][0]
    assert b["volume"] is None and b["centroid"] is None and b["closed"] is False
    assert b["notes"] == ["Mesh is not closed (36 open edges): the enclosed volume is undefined"]
    assert r["summary"]["volume"] is None and r["summary"]["centroid"] is None
    assert analyze_file(GENERATED / "unwelded_cube.stl")["summary"]["volume"] is None


# A closed surface that encloses nothing: a tetrahedron flattened into a plane.
FLAT_TETRA = (np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0], [3, 3, 0]], dtype=float), np.array([[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]))


def test_hole_filling_enclosing_nothing_is_rejected():
    """The flat tetrahedron with a face missing: filling closes it, but the 'solid' has
    no volume, so the mesh stays open."""
    from reader3d.mesh import _mesh_body

    v, faces = FLAT_TETRA
    b = _mesh_body("flat", trimesh.Trimesh(v, faces[1:], process=False), None)
    assert b.volume is None and b.centroid is None
    assert b.notes == ["Mesh is not closed (3 open edges): the enclosed volume is undefined"]
    # A real hole is still filled.
    box = trimesh.creation.box((10, 10, 10))
    b = _mesh_body("box", trimesh.Trimesh(box.vertices, box.faces[1:], process=False), None)
    assert b.volume == pytest.approx(1000) and b.centroid == pytest.approx([0, 0, 0], abs=1e-9)


def test_closed_mesh_of_zero_volume_gives_valid_json(tmp_path):
    """A closed surface enclosing nothing: the centroid used to be NaN, which made the
    server answer 500 (JSON has no NaN)."""
    path = tmp_path / "flat.obj"
    trimesh.Trimesh(*FLAT_TETRA, process=False).export(path)
    r = analyze_file(path)
    json.dumps(r, allow_nan=False)
    assert r["bodies"][0]["closed"] is True
    assert r["bodies"][0]["volume"] == 0.0
    assert r["bodies"][0]["centroid"] is None and r["summary"]["centroid"] is None

    client = TestClient(app)
    res = client.post("/api/analyze", files={"file": ("flat.obj", path.read_bytes())})
    assert res.status_code == 200
    assert res.json()["bodies"][0]["centroid"] is None


def test_non_finite_numbers_never_reach_the_result():
    from reader3d.analyze import _finite

    assert _finite({"a": [1.0, float("nan"), (float("inf"), -float("inf"))], "b": "x", "c": None, "d": 3}) == {
        "a": [1.0, None, [None, None]],
        "b": "x",
        "c": None,
        "d": 3,
    }


def _body(volume, centroid, lo=(0, 0, 0), hi=(10, 10, 10)):
    return Body("b", np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64), volume, 1.0, lo, hi, centroid, volume is not None, "mesh")


def test_summary_centroid_uses_the_bodies_that_have_one():
    s = summarize([_body(1000.0, (5, 5, 5)), _body(0.0, None), _body(None, None), _body(3000.0, (1, 1, 1))])
    assert s["volume"] == 4000.0
    assert s["centroid"] == pytest.approx([2, 2, 2])
    # Only zero-volume solids (or a total that is ~0 for the size of the model): no centroid.
    assert summarize([_body(0.0, None)])["centroid"] is None
    assert summarize([_body(1e-13, None)])["centroid"] is None
    assert summarize([_body(1e-10, (1, 2, 3)), _body(-1e-10 + 1e-25, (4, 5, 6))])["centroid"] is None
    s = summarize([_body(1e-8, (1, 2, 3))])  # tiny but meaningful
    assert s["centroid"] == pytest.approx([1, 2, 3])


# Six points whose minimal oriented box (224.2324377, also found by 3000 Nelder-Mead
# searches over rotations) trimesh.bounds.oriented_bounds misses (521.5).
OBB_POINTS = [
    [-2.8271, 9.4872, 1.6911], [1.4465, -0.7664, 0.2046], [0.7569, 0.7191, -2.1387],
    [1.3817, 1.8075, -0.4151], [-1.6167, -3.2411, -3.5382], [0.6218, -1.2933, 3.0574],
]


def _brute_force_box(pts):
    """Independent check: every hull face normal, every pair of points giving the
    in-plane direction (O(f n^3), fine for a few points)."""
    from scipy.spatial import ConvexHull

    best = np.inf
    for n in ConvexHull(pts).equations[:, :3]:
        u = np.cross(n, [1, 0, 0] if abs(n[0]) < 0.9 else [0, 1, 0])
        u /= np.linalg.norm(u)
        w = np.cross(n, u)
        xy = np.stack([pts @ u, pts @ w], axis=1)
        for i in range(len(xy)):
            for j in range(len(xy)):
                d = xy[j] - xy[i]
                if np.linalg.norm(d) == 0:
                    continue
                d /= np.linalg.norm(d)
                rect = np.ptp(xy @ d) * np.ptp(xy @ [-d[1], d[0]])
                best = min(best, rect * np.ptp(pts @ n))
    return best


def test_oriented_envelope_is_the_minimum_over_hull_faces(tmp_path):
    pts = np.array(OBB_POINTS)
    hull = trimesh.convex.convex_hull(pts)
    b = _body(1.0, (0, 0, 0), *hull.bounds)
    b.vertices, b.faces = hull.vertices, hull.faces
    s = summarize([b])
    assert s["obb"]["volume"] == pytest.approx(224.23243765731297, rel=1e-9)
    assert s["obb"]["volume"] == pytest.approx(_brute_force_box(pts), rel=1e-12)
    assert s["obb"]["size"] == sorted(s["obb"]["size"], reverse=True)
    assert s["obb"]["volume"] == pytest.approx(np.prod(s["obb"]["size"]), rel=1e-12)
    # Through a file (float32 STL coordinates): same as the exhaustive search on them.
    path = tmp_path / "hull.stl"
    hull.export(path)
    rounded = np.unique(trimesh.load(path).vertices, axis=0)
    assert analyze_file(path)["summary"]["obb"]["volume"] == pytest.approx(_brute_force_box(rounded), rel=1e-9)


def test_oriented_envelope_of_rotated_boxes():
    for seed in range(5):
        rng = np.random.default_rng(seed)
        dims = np.sort(rng.uniform(1, 50, 3))[::-1]
        box = trimesh.creation.box(dims)
        box.apply_transform(trimesh.transformations.random_rotation_matrix(rng.random(3)))
        box.apply_translation(rng.uniform(-1e3, 1e3, 3))
        b = _body(1.0, (0, 0, 0), *box.bounds)
        b.vertices, b.faces = box.vertices, box.faces
        assert summarize([b])["obb"]["size"] == pytest.approx(dims, rel=1e-9)


def test_oriented_envelope_ignores_unused_vertices(tmp_path):
    """glTF keeps vertices no face uses: a stray one used to inflate the envelope (to
    the axis-aligned box)."""
    cube = trimesh.creation.box((10, 10, 10))
    cube.apply_transform(trimesh.transformations.euler_matrix(0.4, 0.2, 0.9))
    b = _body(1000.0, (0, 0, 0), *cube.bounds)
    b.vertices = np.vstack([cube.vertices, [[40.0, 40.0, 40.0]]])
    b.faces = cube.faces
    s = summarize([b])
    assert s["obb"]["volume"] == pytest.approx(1000, rel=1e-9)
    # the same through a file
    path = tmp_path / "stray.gltf"
    trimesh.Trimesh(b.vertices, b.faces, process=False).export(path)
    assert analyze_file(path, unit="mm")["summary"]["obb"]["volume"] == pytest.approx(1000, rel=1e-6)


def test_oriented_envelope_of_a_flat_part_is_the_axis_aligned_box():
    sheet = _body(None, None, (0, 0, 0), (10, 10, 0))
    sheet.vertices = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], dtype=float)
    sheet.faces = np.array([[0, 1, 2], [0, 2, 3]])
    assert summarize([sheet])["obb"] == {"size": [10.0, 10.0, 0.0], "volume": 0.0}


def test_nurbs_volume_and_area_are_exact(tmp_path):
    """Exact rational NURBS versions of a torus and a cylinder: the fixed-order Gauss
    integration was off by 0.2 % - 0.9 %."""
    torus = BRepBuilderAPI_NurbsConvert(BRepPrimAPI_MakeTorus(10.0, 3.0).Shape(), True).Shape()
    cylinder = BRepBuilderAPI_NurbsConvert(BRepPrimAPI_MakeCylinder(5.0, 20.0).Shape(), True).Shape()
    cases = [
        (torus, 2 * math.pi**2 * 10 * 9, 4 * math.pi**2 * 10 * 3, [0, 0, 0]),
        (cylinder, math.pi * 25 * 20, 2 * math.pi * 5 * 20 + 2 * math.pi * 25, [0, 0, 10]),
    ]
    for i, (shape, volume, area, centroid) in enumerate(cases):
        b = analyze_file(write_step(shape, tmp_path / f"nurbs_{i}.step"))["bodies"][0]
        # BRepGProp with Eps = 1e-10 converges to about 2e-8 on these surfaces (1e-9: 2e-7).
        assert b["volume"] == pytest.approx(volume, rel=1e-7)
        assert b["area"] == pytest.approx(area, rel=1e-7)
        assert b["centroid"] == pytest.approx(centroid, abs=1e-6)


def _faces(shape):
    exp, out = TopExp_Explorer(shape, TopAbs_FACE), []
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def test_closed_single_face_surface_becomes_a_solid(tmp_path):
    """Sphere and torus surface models: one closed face each, left free by sewing."""
    for name, shape, volume in (
        ("sphere", BRepPrimAPI_MakeSphere(5.0).Shape(), 4 / 3 * math.pi * 125),
        ("torus", BRepPrimAPI_MakeTorus(10.0, 3.0).Shape(), 2 * math.pi**2 * 10 * 9),
    ):
        r = analyze_file(write_step(_compound(_faces(shape)), tmp_path / f"{name}_face.step"))
        b = r["bodies"][0]
        assert r["summary"]["solids"] == 1 and r["summary"]["open_bodies"] == 0
        assert b["volume"] == pytest.approx(volume, rel=1e-9)
        assert b["closed"] is True
        assert "Solid rebuilt by sewing the surfaces of the file" in b["notes"]
    assert analyze_file(GENERATED / "sphere_face.step")["summary"]["volume"] == pytest.approx(4 / 3 * math.pi * 125, rel=1e-9)


def test_open_single_face_stays_open(tmp_path):
    """A half cylinder surface (one open face) is not turned into a solid."""
    lateral = _faces(BRepPrimAPI_MakeCylinder(5.0, 10.0, math.pi).Shape())[0]
    r = analyze_file(write_step(_compound([lateral]), tmp_path / "half.step"))
    assert r["summary"]["volume"] is None and r["bodies"][0]["closed"] is False


def test_cad_bounding_box_of_revolved_and_nurbs_faces(tmp_path):
    """The box must enclose the part and not exceed it: compared with the nodes of a
    fine tessellation (all on the surfaces). BRepBndLib.AddOptimal of OpenCascade 8 gives
    a box twice too big for a revolved B-spline, and one too small for a NURBS sphere."""
    from make_fixtures import revolved_spline
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    sphere = BRepBuilderAPI_NurbsConvert(BRepPrimAPI_MakeSphere(5.0).Shape(), True).Shape()
    for name, shape in (("revolved", revolved_spline()), ("sphere", sphere)):
        b = analyze_file(write_step(shape, tmp_path / f"{name}.step"))["bodies"][0]
        BRepMesh_IncrementalMesh(shape, 1e-3, False, 0.05, True)
        nodes = []
        for f in _faces(shape):
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(TopoDS.Face(f), loc)
            nodes += [tri.Node(i).Transformed(loc.Transformation()).Coord() for i in range(1, tri.NbNodes() + 1)]
        nodes = np.array(nodes)
        size = np.ptp(nodes, axis=0).max()
        assert np.all(np.array(b["bbox"]["min"]) <= nodes.min(axis=0) + 1e-9 * size), name
        assert np.all(np.array(b["bbox"]["max"]) >= nodes.max(axis=0) - 1e-9 * size), name
        assert np.array(b["bbox"]["min"]) == pytest.approx(nodes.min(axis=0), abs=2e-3), name
        assert np.array(b["bbox"]["max"]) == pytest.approx(nodes.max(axis=0), abs=2e-3), name
        if name == "sphere":  # the browser engine (OpenCascade 7.6) gives -5.0000001 .. 5.0000001
            assert b["bbox"]["min"] == pytest.approx([-5.0000001] * 3, abs=1e-9)
            assert b["bbox"]["max"] == pytest.approx([5.0000001] * 3, abs=1e-9)

    # Same box as OpenCascade 7 (cadquery-ocp 7.9 and the browser's 7.6) on the fixture.
    box = analyze_file(GENERATED / "revolved_spline.step")["summary"]["bbox"]
    assert box["min"] == pytest.approx([-25.629627544193934, -59.79878862883504, -12.40345039717097], abs=1e-9)
    assert box["max"] == pytest.approx([0.7652399651084721, -33.749542956718216, 13.799991746538586], abs=1e-9)


def test_cad_reader_works_without_ocp_collections(tmp_path):
    """cadquery-ocp 7.x (the only version on Python 3.10) has no OCP.collections."""
    import subprocess
    import sys

    path = write_step(holed_block(), tmp_path / "block.step")
    probe = (
        "import sys, OCP.TDF\n"
        "try:  # cadquery-ocp 8: make it look like 7.x, where the sequence is in OCP.TDF\n"
        "    from OCP.collections import Sequence_TDF_Label\n"
        "    OCP.TDF.TDF_LabelSequence = Sequence_TDF_Label\n"
        "except ImportError:\n"
        "    pass\n"
        "sys.modules['OCP.collections'] = None\n"
        "from reader3d.analyze import analyze_file\n"
        "print(analyze_file(sys.argv[1], include_mesh=False)['summary']['volume'])"
    )
    root = Path(__file__).resolve().parent.parent
    proc = subprocess.run([sys.executable, "-c", probe, str(path)], capture_output=True, text=True, cwd=root, timeout=300)
    assert proc.returncode == 0, proc.stderr
    assert float(proc.stdout.strip().splitlines()[-1]) == pytest.approx(HOLED_VOLUME, rel=1e-9)


def test_text_meshes_that_are_not_utf8(tmp_path):
    """Latin-1 names and comments (common from European software) are read; undecodable
    bytes become U+FFFD like in the browser."""
    box = trimesh.creation.box((10, 20, 30))
    obj = trimesh.exchange.obj.export_obj(box).replace("# https://github.com/mikedh/trimesh", "# Pièce créée par Logiciel")
    (tmp_path / "piece.obj").write_bytes(("o pièce\n" + obj).encode("latin-1"))
    stl = trimesh.exchange.stl.export_stl_ascii(box).replace("solid", "solid pièce", 1)
    (tmp_path / "piece.stl").write_bytes(stl.encode("latin-1"))
    for encoding in ("ascii", "binary_little_endian"):
        ply = trimesh.exchange.ply.export_ply(box, encoding=encoding.split("_")[0])
        head, sep, data = ply.partition(b"end_header\n")
        head = head.replace(b"comment https://github.com/mikedh/trimesh", "comment créé par Logiciel".encode("latin-1"))
        (tmp_path / f"piece_{encoding}.ply").write_bytes(head + sep + data)
    for name in ("piece.obj", "piece.stl", "piece_ascii.ply", "piece_binary_little_endian.ply"):
        r = analyze_file(tmp_path / name)
        assert r["summary"]["volume"] == pytest.approx(6000), name
    # Object names: "pièce" and "écrou".
    nut = trimesh.creation.box((1, 1, 1))
    nut.apply_translation([20, 0, 0])
    two = "o pièce\n" + "\n".join(f"v {x} {y} {z}" for x, y, z in box.vertices) + "\n"
    two += "\n".join(f"f {a + 1} {b + 1} {c + 1}" for a, b, c in box.faces) + "\no écrou\n"
    two += "\n".join(f"v {x} {y} {z}" for x, y, z in nut.vertices) + "\n"
    two += "\n".join(f"f {a + 9} {b + 9} {c + 9}" for a, b, c in nut.faces) + "\n"
    (tmp_path / "two.obj").write_bytes(two.encode("latin-1"))
    assert analyze_file(tmp_path / "two.obj")["summary"]["volume"] == pytest.approx(6001)

    # OBJ materials are still found next to the file.
    mtl = "newmtl red\nKd 1.0 0.0 0.0\n"
    (tmp_path / "red.mtl").write_text(mtl)
    text = "mtllib red.mtl\no pièce\nusemtl red\n" + "\n".join(line for line in obj.splitlines() if not line.startswith("o "))
    (tmp_path / "red.obj").write_bytes(text.encode("latin-1"))
    body = analyze_file(tmp_path / "red.obj")["bodies"][0]
    assert body["volume"] == pytest.approx(6000)
    assert body["color"] == pytest.approx([1, 0, 0], abs=0.01)


def test_binary_stl_with_trailing_bytes_fails_cleanly(tmp_path):
    path = tmp_path / "padded.stl"
    trimesh.creation.box((10, 20, 30)).export(path)
    raw = path.read_bytes()
    path.write_bytes(raw[:80].replace(b"\0", "é".encode("latin-1"), 1) + raw[80:])
    assert analyze_file(path)["summary"]["volume"] == pytest.approx(6000)  # binary header bytes are free
    path.write_bytes(raw + b"\0" * 7)
    with pytest.raises(ValueError, match="does not contain any triangle geometry"):
        analyze_file(path)


def test_3mf_in_microns_is_labelled_micron(tmp_path):
    import zipfile

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="micron" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        '<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1000" y="0" z="0"/>'
        '<vertex x="0" y="1000" z="0"/><vertex x="0" y="0" z="1000"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/>'
        '<triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh>'
        '</object></resources><build><item objectid="1"/></build></model>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
    )
    types = (
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
    )
    path = tmp_path / "tetra.3mf"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
    r = analyze_file(path)
    assert r["source_unit"] == "micron"
    assert r["summary"]["volume"] == pytest.approx(1 / 6)
