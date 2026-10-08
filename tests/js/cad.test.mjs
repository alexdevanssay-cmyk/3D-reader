// CAD (B-rep) engine tests: web/engine/cad.js running OpenCascade (WebAssembly)
// must reproduce the Python engine (reader3d/cad.py) results stored in
// tests/fixtures/generated/expected.json.
//
//   node --test tests/js/cad.test.mjs
//
// OpenCascade is loaded once (about 5 s) and shared by every test, which also
// exercises the reuse of one module instance across many files.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { analyzeCad, CAD_EXTENSIONS, QUALITY } from '../../web/engine/cad.js';
import { loadOcctNode } from '../../web/engine/occt.js';
import { ROOT, approx, approxVec, fixtureBytes, loadExpected } from './helpers.mjs';

// Parity tolerances (see the shared spec).
const EXACT = 1e-7; // volume, area, centroid: exact B-rep integrals on both sides
// Analytic volume of rational NURBS solids: BRepGProp's adaptive integration
// (Eps 1e-10 in both engines) converges to about 2e-8 of the true value there.
const NURBS = 1e-7;
const BBOX = 1e-6; // bounding boxes, relative to the model size
const OBB = 1e-6; // oriented envelope of one and the same tessellation (R4 parity target)
// Mesh volume of one and the same tessellation (same triangle count) in both
// engines: only the summation order differs (observed: below 1e-14).
const SAME_MESH = 1e-9;
const OTHER_MESH = 1e-2; // oriented envelope of another tessellation of the model
const COLOR = 1e-3;

const expected = loadExpected();
const cadFiles = Object.keys(expected).filter((name) => extension(name) in CAD_EXTENSIONS);

let oc;
const timings = [];
const parityResults = new Map(); // file name -> result of the parity test, reused for the envelopes

before(async () => {
  const t0 = performance.now();
  oc = await loadOcctNode();
  timings.push(['(load OpenCascade)', performance.now() - t0]);
});

after(() => {
  if (!timings.length) return;
  const width = Math.max(...timings.map(([name]) => name.length));
  const lines = timings.map(([name, ms]) => `  ${name.padEnd(width)}  ${ms.toFixed(0).padStart(7)} ms`);
  console.log(`\nCAD engine timings (Node ${process.version}):\n${lines.join('\n')}`);
});

function extension(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/** analyzeCad() with its duration recorded and reported. */
function timedAnalyze(t, name, bytes, options, label = name) {
  const t0 = performance.now();
  const result = analyzeCad(oc, bytes ?? fixtureBytes(name), name, options);
  const ms = performance.now() - t0;
  timings.push([label, ms]);
  t.diagnostic(`${label}: ${ms.toFixed(0)} ms`);
  return result;
}

/** Largest dimension of the model, used to scale absolute tolerances. */
function modelSize(exp) {
  return Math.max(...exp.summary.bbox.size, 1e-9);
}

/** Structural checks of a body against the result contract. */
function checkBodyShape(body, label) {
  assert.equal(typeof body.name, 'string', `${label}: name`);
  assert.equal(body.method, 'brep', `${label}: method`);
  assert.ok(body.triangles > 0, `${label}: bodies without triangles are dropped`);
  const { positions, indices } = body.mesh;
  assert.ok(positions instanceof Float32Array, `${label}: positions is a Float32Array`);
  assert.ok(indices instanceof Uint32Array, `${label}: indices is a Uint32Array`);
  assert.equal(positions.length % 3, 0, `${label}: positions length`);
  assert.equal(indices.length, body.triangles * 3, `${label}: indices length`);
  const nverts = positions.length / 3;
  assert.ok(indices.every((i) => i < nverts), `${label}: indices in range`);
  assert.ok(positions.every(Number.isFinite), `${label}: finite positions`);
  // Display mesh inside the (exact) bounding box, up to the mesh deflection.
  const slack = 1e-3 * Math.max(...body.bbox.size, 1);
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    assert.ok(
      positions[i] >= body.bbox.min[axis] - slack && positions[i] <= body.bbox.max[axis] + slack,
      `${label}: vertex outside the bounding box`,
    );
  }
}

/** Per-body and total comparison with the Python engine result `exp`. */
function checkParity(result, exp, name) {
  const size = modelSize(exp);
  assert.equal(result.source_unit, exp.source_unit, `${name}: source_unit`);
  assert.deepEqual(
    result.bodies.map((b) => b.name),
    exp.bodies.map((b) => b.name),
    `${name}: body names (and order)`,
  );

  result.bodies.forEach((body, i) => {
    const eb = exp.bodies[i];
    const label = `${name} body ${i} "${eb.name}"`;
    checkBodyShape(body, label);
    assert.equal(body.closed, eb.closed, `${label}: closed`);
    assert.equal(body.method, eb.method, `${label}: method`);
    assert.equal(body.notes.length, eb.notes.length, `${label}: number of notes`);
    assert.deepEqual(body.notes, eb.notes, `${label}: notes`);
    approx(body.volume, eb.volume, EXACT, 0, `${label}: volume`);
    approx(body.area, eb.area, EXACT, 0, `${label}: area`);
    approxVec(body.centroid, eb.centroid, EXACT, EXACT * size, `${label}: centroid`);
    approxVec(body.bbox.min, eb.bbox.min, 0, BBOX * size, `${label}: bbox.min`);
    approxVec(body.bbox.max, eb.bbox.max, 0, BBOX * size, `${label}: bbox.max`);
    approxVec(body.bbox.size, eb.bbox.size, 0, BBOX * size, `${label}: bbox.size`);
    checkMeshVolume(body, eb, label);
    approxVec(body.color, eb.color, 0, COLOR, `${label}: color`);
    // Topology for the semantic layer (no Python counterpart): the welded mesh
    // of a solid closes like the solid.
    assert.equal(body.topology.watertight, body.closed, `${label}: topology.watertight`);
    assert.equal(body.topology.triangles, body.triangles, `${label}: topology.triangles`);
  });
  checkTessellationError(result, name);

  // Totals, computed like reader3d/model.py::summarize (envelopes are checked below).
  const s = exp.summary;
  const solids = result.bodies.filter((b) => b.volume !== null);
  assert.equal(result.bodies.length, s.bodies, `${name}: bodies`);
  assert.equal(solids.length, s.solids, `${name}: solids`);
  assert.equal(result.bodies.length - solids.length, s.open_bodies, `${name}: open bodies`);
  const volume = solids.length ? solids.reduce((sum, b) => sum + b.volume, 0) : null;
  approx(volume, s.volume, EXACT, 0, `${name}: total volume`);
  approx(result.bodies.reduce((sum, b) => sum + b.area, 0), s.area, EXACT, 0, `${name}: total area`);
  if (volume) {
    const centroid = [0, 1, 2].map((k) => solids.reduce((sum, b) => sum + b.centroid[k] * b.volume, 0) / volume);
    approxVec(centroid, s.centroid, EXACT, EXACT * size, `${name}: centroid`);
  }
  const min = [0, 1, 2].map((k) => Math.min(...result.bodies.map((b) => b.bbox.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...result.bodies.map((b) => b.bbox.max[k])));
  approxVec(min, s.bbox.min, 0, BBOX * size, `${name}: bbox.min`);
  approxVec(max, s.bbox.max, 0, BBOX * size, `${name}: bbox.max`);
}

/**
 * Mesh volume (volume of the display tessellation) against the Python engine.
 *
 * Both engines tessellate with a deflection taken from OpenCascade's rough
 * bounding box of the model. Where it is the same, so is the tessellation (same
 * triangle count) and the mesh volumes agree to rounding. OpenCascade 8 makes
 * that box up to 2.5 times larger than 7.6 on surfaces of revolution
 * (revolved_spline.step): the two meshes then differ by up to 0.25 %, as much
 * as the coarser of them differs from the exact volume, and no more.
 */
function checkMeshVolume(body, eb, label) {
  if (eb.mesh_volume == null || body.triangles === eb.triangles) {
    approx(body.mesh_volume, eb.mesh_volume, SAME_MESH, 0, `${label}: mesh_volume (same tessellation)`);
    return;
  }
  const tessellationError = Math.max(Math.abs(eb.mesh_volume - eb.volume), Math.abs(body.mesh_volume - body.volume));
  approx(body.mesh_volume, eb.mesh_volume, 0, tessellationError, `${label}: mesh_volume (other tessellation)`);
}

/**
 * Mesh volume against the exact volume: the display mesh lies within the
 * linear deflection (QUALITY[quality][0] x model diagonal) of the surfaces, so
 * the volumes differ by less than area x deflection. A face lost, flipped or
 * misplaced by the tessellation reader does not fit in that bound.
 */
function checkTessellationError(result, name, quality = 'normal') {
  const min = [0, 1, 2].map((k) => Math.min(...result.bodies.map((b) => b.bbox.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...result.bodies.map((b) => b.bbox.max[k])));
  const deflection = QUALITY[quality][0] * Math.hypot(...max.map((v, k) => v - min[k]));
  for (const b of result.bodies) {
    if (b.volume == null) continue;
    approx(b.mesh_volume, b.volume, 0, b.area * deflection, `${name} "${b.name}": mesh_volume vs exact volume (${quality})`);
  }
}

const totalVolume = (result) => result.bodies.reduce((sum, b) => sum + (b.volume ?? 0), 0);
const totalTriangles = (result) => result.bodies.reduce((sum, b) => sum + b.triangles, 0);

const NOTE_OPEN = 'Open surfaces (not a closed solid): no volume can be computed';
const NOTE_SEWN = 'Solid rebuilt by sewing the surfaces of the file';
const NOTE_INVERTED = 'Solid had inverted orientation; volume sign corrected';

// ------------------------------------------------------------------ test models
// Models built with OpenCascade itself and written to the emscripten file system.

/** Bytes of a file written by `write(path)` in the emscripten file system. */
function writtenBytes(name, write) {
  const path = `/test-${name}`;
  try {
    assert.ok(write(path), `${name} could not be written`);
    return oc.FS.readFile(path);
  } finally {
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
  }
}

const brepBytes = (name, shape) =>
  writtenBytes(name, (path) => oc.BRepTools.Write_3(shape, path, new oc.Message_ProgressRange_1()));

const box = (x, y, z, dx, dy, dz) => new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(x, y, z), dx, dy, dz).Shape();

function translation(dx, dy, dz) {
  const trsf = new oc.gp_Trsf_1();
  trsf.SetTranslation_1(new oc.gp_Vec_4(dx, dy, dz));
  return trsf;
}

/** Rigid placement: rows of the rotation and translation. */
function placement([r1, r2, r3], [tx, ty, tz]) {
  const trsf = new oc.gp_Trsf_1();
  trsf.SetValues(...r1, tx, ...r2, ty, ...r3, tz);
  return new oc.TopLoc_Location_2(trsf);
}

function faces(shape) {
  const out = [];
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) out.push(oc.TopoDS.Face_1(exp.Current()));
  return out;
}

function edges(shape) {
  const out = [];
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) out.push(oc.TopoDS.Edge_1(exp.Current()));
  return out;
}

/** Compound, shell or solid made of `shapes`. */
function assemble(kind, shapes) {
  const builder = new oc.BRep_Builder();
  const result = new oc[`TopoDS_${kind}`]();
  builder[`Make${kind}`](result);
  for (const s of shapes) builder.Add(result, s);
  return result;
}

/**
 * STEP file of an XCAF document. build(tools) fills the document; tools gives
 * the shape and colour tools and helpers to name and colour labels.
 */
function xcafStep(name, build) {
  const doc = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2('XmlOcaf', false));
  const hdoc = new oc.Handle_TDocStd_Document_2(doc);
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main()).get();
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(doc.Main()).get();
  build({
    shapeTool,
    named: (label, text) => (oc.TDataStd_Name.Set_1(label, new oc.TCollection_ExtendedString_2(text, true)), label),
    colored: (label, [r, g, b]) => {
      const color = new oc.Quantity_Color_3(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_sRGB);
      colorTool.SetColor_2(label, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
      return label;
    },
  });
  shapeTool.UpdateAssemblies();
  const writer = new oc.STEPCAFControl_Writer_1();
  writer.SetNameMode(true);
  writer.SetColorMode(true);
  const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
  assert.ok(writer.Transfer_1(hdoc, mode, null, new oc.Message_ProgressRange_1()), `${name}: transfer`);
  const bytes = writtenBytes(name, (path) => writer.Write(path) === oc.IFSelect_ReturnStatus.IFSelect_RetDone);
  writer.delete();
  hdoc.delete();
  return bytes;
}

// --------------------------------------------------------------------------- parity

describe('CAD parity with the Python engine', () => {
  test('the fixture set contains the expected CAD files', () => {
    for (const name of [
      'holed_block.step', 'holed_block.igs', 'holed_block.brep', 'sphere.stp', 'two_solids.step',
      'box_in_metres.step', 'named_assembly.step', 'surface_box.step', 'as1_pe_203.stp', 'io1-cm-214.stp',
      'nurbs_torus.step', 'nurbs_cylinder.step', 'sphere_face.step', 'revolved_spline.step',
      'mirror_halfturn.step', 'pointmirror_identity.step',
    ]) {
      assert.ok(cadFiles.includes(name), `${name} missing from expected.json`);
    }
  });

  for (const name of cadFiles) {
    test(name, (t) => {
      const result = timedAnalyze(t, name);
      parityResults.set(name, result);
      checkParity(result, expected[name], name);
      const analytic = expected[name].analytic_volume;
      const tol = name.startsWith('nurbs_') ? NURBS : EXACT;
      if (analytic != null) approx(totalVolume(result), analytic, tol, 0, `${name}: analytic volume`);
    });
  }
});

describe('CAD specifics', () => {
  test('named assembly: UTF-8 names, colours and component placement', (t) => {
    const { bodies } = timedAnalyze(t, 'named_assembly.step', undefined, undefined, 'named_assembly.step (again)');
    const [bracket, pin] = bodies;
    assert.equal(bracket.name, 'Équerre');
    assert.equal(pin.name, 'Pin');
    approxVec(bracket.color, [0.8, 0.2, 0.1], 0, COLOR, 'bracket colour (sRGB)');
    approxVec(pin.color, [0.1, 0.3, 0.9], 0, COLOR, 'pin colour (sRGB)');
    approx(bracket.volume, 40 * 30 * 5, 1e-12, 0, 'bracket volume');
    approx(pin.volume, Math.PI * 16 * 25, 1e-12, 0, 'pin volume');
    // The pin is placed with a (20, 15, 5) translation in the assembly.
    approxVec(pin.centroid, [20, 15, 17.5], 0, 1e-9, 'pin centroid');
    approxVec(pin.bbox.min, [16, 11, 5], 0, 1e-6, 'pin bbox.min');
  });

  test('surface model: loose faces are sewn into a solid named after the file', (t) => {
    const { bodies } = timedAnalyze(t, 'surface_box.step', undefined, undefined, 'surface_box.step (again)');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].name, 'surface_box');
    assert.equal(bodies[0].closed, true);
    assert.deepEqual(bodies[0].notes, ['Solid rebuilt by sewing the surfaces of the file']);
    approx(bodies[0].volume, 6000, 1e-12, 0, 'sewn volume');
  });

  test('STEP written in metres is converted to millimetres', (t) => {
    const { bodies, source_unit } = timedAnalyze(t, 'box_in_metres.step', undefined, undefined, 'box_in_metres.step (again)');
    assert.equal(source_unit, 'mm');
    approxVec(bodies[0].bbox.size, [10, 20, 30], 0, 1e-9, 'size in mm');
  });

  test('analytic surfaces for the semantic layer: orientation, outward normal, centre on the face, bounding edges', (t) => {
    // Block (0, 0, 0) + (100, 60, 20) with a through hole of radius 10 along z
    // at (50, 30). Structured clone: the result comes from the engine worker.
    const [block] = structuredClone(timedAnalyze(t, 'holed_block.step', undefined, undefined, 'holed_block.step (surfaces)')).bodies;
    const surfaces = block.geometric_surfaces;
    assert.ok(surfaces.every((s) => s.orientation === 'forward' || s.orientation === 'reversed'), 'orientation as a string');
    // Each face of the block once, its normal out of the material, its centre in its middle.
    const faces = [
      [[0, 0, -1], [50, 30, 0]], [[0, 0, 1], [50, 30, 20]],
      [[-1, 0, 0], [0, 30, 10]], [[1, 0, 0], [100, 30, 10]],
      [[0, -1, 0], [50, 0, 10]], [[0, 1, 0], [50, 60, 10]],
    ];
    const planes = surfaces.filter((s) => s.type === 'plane');
    assert.equal(planes.length, faces.length);
    for (const [normal, centre] of faces) {
      const plane = planes.find((s) => s.normal.every((x, i) => Math.abs(x - normal[i]) < 1e-12));
      assert.ok(plane, `a face with the normal ${normal}`);
      approxVec(plane.center_mm, centre, 0, 1e-9, `centre of the face ${normal}`);
    }
    // The hole: the material around it (reversed), its two circles and not the
    // seam, its centre on the axis half way through the block.
    const [hole] = surfaces.filter((s) => s.type === 'cylinder');
    assert.equal(hole.orientation, 'reversed');
    assert.equal(hole.edge_count, 2);
    approxVec(hole.axis.map(Math.abs), [0, 0, 1], 0, 1e-12, 'hole axis');
    approxVec(hole.center_mm, [50, 30, 10], 0, 1e-9, 'hole centre');
  });

  test('quality presets change the tessellation, not the volume', (t) => {
    const name = 'sphere.stp';
    const bytes = fixtureBytes(name);
    const runs = Object.fromEntries(
      Object.keys(QUALITY).map((q) => [q, timedAnalyze(t, name, bytes, { quality: q }, `${name} (${q})`)]),
    );
    const tris = Object.fromEntries(Object.entries(runs).map(([q, r]) => [q, totalTriangles(r)]));
    t.diagnostic(`triangles: ${JSON.stringify(tris)}`);
    assert.ok(tris.coarse < tris.normal && tris.normal < tris.fine, `triangles grow with quality: ${JSON.stringify(tris)}`);
    assert.equal(tris.normal, expected[name].summary.triangles, 'default preset is "normal"');
    for (const q of Object.keys(QUALITY)) {
      approx(totalVolume(runs[q]), totalVolume(runs.normal), 1e-12, 0, `volume with quality ${q}`);
      approx(runs[q].bodies[0].area, runs.normal.bodies[0].area, 1e-12, 0, `area with quality ${q}`);
    }
    // A finer mesh approximates the exact volume better, within its deflection.
    for (const q of Object.keys(QUALITY)) checkTessellationError(runs[q], name, q);
    const err = (q) => Math.abs(runs[q].bodies[0].mesh_volume - runs[q].bodies[0].volume);
    assert.ok(err('fine') < err('normal') && err('normal') < err('coarse'), 'mesh volume converges');
    // Unknown presets fall back to "normal", like read_cad.
    const unknown = timedAnalyze(t, name, bytes, { quality: 'bogus' }, `${name} (bogus quality)`);
    assert.equal(totalTriangles(unknown), tris.normal);
  });

  test('every solid is tessellated on its own (bounded memory on large models)', (t) => {
    // One BRepMesh call on the whole model needs about 70 kB of wasm heap per
    // face at once: 10 000 boxes exhausted the 4 GB heap and lost every triangle.
    const Mesher = oc.BRepMesh_IncrementalMesh_2;
    const solidsPerCall = [];
    oc.BRepMesh_IncrementalMesh_2 = function (shape, ...args) {
      const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      let solids = 0;
      for (; exp.More(); exp.Next()) solids++;
      exp.delete();
      solidsPerCall.push(solids);
      return new Mesher(shape, ...args);
    };
    let result;
    try {
      result = timedAnalyze(t, 'as1_pe_203.stp', undefined, undefined, 'as1_pe_203.stp (mesher calls)');
    } finally {
      oc.BRepMesh_IncrementalMesh_2 = Mesher;
    }
    t.diagnostic(`${solidsPerCall.length} mesher calls for ${result.bodies.length} bodies`);
    assert.ok(solidsPerCall.length > 1, 'several mesher calls');
    assert.ok(solidsPerCall.every((n) => n <= 1), `solids per call: ${solidsPerCall}`);
    // Instances of one part share their geometry, tessellated once.
    assert.ok(solidsPerCall.length < result.bodies.length, 'shared geometry tessellated once');
    assert.equal(totalTriangles(result), expected['as1_pe_203.stp'].summary.triangles, 'same tessellation as one call');
  });

  test('a colour set on an assembly instance overrides the part colour', () => {
    // XCAF precedence (XCAFPrs_DocumentExplorer): instance colour, then the
    // part's own colour, then the colour of the enclosing instance.
    const [GREEN, RED, BLUE] = [[0.2, 0.6, 0.2], [0.9, 0.1, 0.1], [0.1, 0.1, 0.9]];
    const bytes = xcafStep('instance_colours.step', ({ shapeTool: st, named, colored }) => {
      const top = named(st.NewShape(), 'Top');
      const sub = named(st.NewShape(), 'Sub');
      const plate = colored(named(st.AddShape(box(0, 0, 0, 10, 5, 2), false, true), 'Plate'), GREEN);
      const rod = named(st.AddShape(new oc.BRepPrimAPI_MakeCylinder_1(1, 4).Shape(), false, true), 'Rod');
      st.AddComponent_1(sub, plate, new oc.TopLoc_Location_2(translation(0, 0, 0)));
      colored(st.AddComponent_1(sub, plate, new oc.TopLoc_Location_2(translation(20, 0, 0))), RED);
      st.AddComponent_1(sub, rod, new oc.TopLoc_Location_2(translation(40, 0, 0)));
      colored(st.AddComponent_1(top, sub, new oc.TopLoc_Location_2(translation(0, 0, 0))), BLUE);
      st.AddComponent_1(top, sub, new oc.TopLoc_Location_2(translation(0, 50, 0)));
    });
    const { bodies } = analyzeCad(oc, bytes, 'instance_colours.step');
    assert.deepEqual(bodies.map((b) => b.name), ['Plate', 'Plate', 'Rod', 'Plate', 'Plate', 'Rod']);
    [GREEN, RED, BLUE, GREEN, RED, null].forEach((color, i) => approxVec(bodies[i].color, color, 0, COLOR, `body ${i} colour`));
    approxVec(bodies[4].bbox.min, [20, 50, 0], 0, 1e-9, 'placement of the red plate in the 2nd sub-assembly');
  });

  test('a solid whose shell is open has no volume', () => {
    // A solid bounded by 5 of the 6 faces of a 10 x 20 x 30 box (the missing
    // one is its x = 0 side): BRepGProp would integrate a meaningless "volume".
    const [missing, ...kept] = faces(box(0, 0, 0, 10, 20, 30));
    const openSolid = assemble('Solid', [assemble('Shell', kept)]);
    const [body, ...others] = analyzeCad(oc, brepBytes('open_solid.brep', openSolid), 'open_solid.brep').bodies;
    assert.equal(others.length, 0);
    assert.equal(body.name, 'open_solid');
    assert.equal(body.closed, false);
    assert.equal(body.volume, null);
    assert.equal(body.mesh_volume, null);
    assert.equal(body.centroid, null);
    assert.deepEqual(body.notes, [NOTE_OPEN]);
    approx(body.area, 2200 - 20 * 30, 1e-12, 0, 'area of the 5 faces');

    // With the missing face elsewhere in the file, sewing closes it.
    const both = assemble('Compound', [openSolid, missing]);
    const { bodies } = analyzeCad(oc, brepBytes('open_solid_and_face.brep', both), 'open_solid_and_face.brep');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].closed, true);
    assert.deepEqual(bodies[0].notes, [NOTE_SEWN]);
    approx(bodies[0].volume, 6000, 1e-9, 0, 'sewn volume');
  });

  test('mirrored assembly instances are placed like OpenCascade 8 does', () => {
    // OpenCascade 8 writes a mirrored instance as a CARTESIAN_TRANSFORMATION_OPERATOR_3D
    // with scale -1 and reads it as the rigid placement of its origin and axes
    // followed by a reflection through the origin. Here the rigid placement
    // (x, -y, -z) + (10, 0, 0) of the second instance becomes such an operator;
    // the third instance has the same rotation, but is not mirrored.
    const flip = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const written = xcafStep('mirrored.step', ({ shapeTool: st, named }) => {
      const top = named(st.NewShape(), 'Mirror');
      const plate = named(st.AddShape(box(0, 0, 0, 10, 5, 2), false, true), 'Plate');
      st.AddComponent_1(top, plate, new oc.TopLoc_Location_1());
      st.AddComponent_1(top, plate, placement(flip, [10, 0, 0]));
      st.AddComponent_1(top, plate, placement(flip, [0, 30, 0]));
    });
    const bytes = new TextEncoder().encode(mirrorStepInstance(new TextDecoder().decode(written), [10, 0, 0]));
    const { bodies } = analyzeCad(oc, bytes, 'mirrored.step');
    assert.equal(bodies.length, 3);
    const [plain, mirrored, rotated] = bodies;
    assert.deepEqual(plain.notes, []);
    approxVec(plain.bbox.min, [0, 0, 0], 0, 1e-9, 'plain bbox.min');
    // (x, y, z) -> -((10, 0, 0) + (x, -y, -z)): the mirror image about the plane x = -5.
    approxVec(mirrored.bbox.min, [-20, 0, 0], 0, 1e-9, 'mirrored bbox.min');
    approxVec(mirrored.bbox.max, [-10, 5, 2], 0, 1e-9, 'mirrored bbox.max');
    approxVec(mirrored.centroid, [-15, 2.5, 1], 0, 1e-9, 'mirrored centroid');
    approx(mirrored.volume, 100, 1e-12, 0, 'mirrored volume');
    assert.deepEqual(mirrored.notes, [NOTE_INVERTED], 'mirroring inverts the solid, like in cad.py');
    approxVec(rotated.bbox.min, [0, 25, -2], 0, 1e-9, 'rotated bbox.min');
    assert.deepEqual(rotated.notes, []);
  });

  test('only the mirrored occurrence is mirrored, not the others placed the same way', () => {
    // Every component whose placement was the rigid part of a mirroring
    // operator used to be mirrored: here all three. Only "Right" uses the operator.
    const halfTurn = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
    const written = xcafStep('mirrored_twins.step', ({ shapeTool: st, named }) => {
      const top = named(st.NewShape(), 'Twins');
      const plate = named(st.AddShape(box(0, 0, 0, 10, 5, 2), false, true), 'Plate');
      const pin = named(st.AddShape(new oc.BRepPrimAPI_MakeCylinder_1(1, 4).Shape(), false, true), 'Pin');
      named(st.AddComponent_1(top, plate, placement(halfTurn, [0, 0, 0])), 'Left');
      named(st.AddComponent_1(top, plate, placement(halfTurn, [0, 0, 0])), 'Right');
      named(st.AddComponent_1(top, pin, placement(halfTurn, [0, 0, 0])), 'Axle');
    });
    const bytes = new TextEncoder().encode(mirrorStepInstance(new TextDecoder().decode(written), [0, 0, 0], 'Right'));
    const { bodies } = analyzeCad(oc, bytes, 'mirrored_twins.step');
    // Parts are named after the part, then the instance: in component order.
    assert.deepEqual(bodies.map((b) => b.name), ['Plate', 'Plate', 'Pin']);
    const [left, right, axle] = bodies;
    // Half a turn about z: (x, y, z) -> (-x, -y, z).
    approxVec(left.bbox.min, [-10, -5, 0], 0, 1e-9, 'left bbox.min');
    approxVec(left.bbox.max, [0, 0, 2], 0, 1e-9, 'left bbox.max');
    assert.deepEqual(left.notes, []);
    // Then the reflection through the origin: (x, y, z) -> (x, y, -z).
    approxVec(right.bbox.min, [0, 0, -2], 0, 1e-9, 'right bbox.min');
    approxVec(right.bbox.max, [10, 5, 0], 0, 1e-9, 'right bbox.max');
    approxVec(right.centroid, [5, 2.5, -1], 0, 1e-9, 'right centroid');
    assert.deepEqual(right.notes, [NOTE_INVERTED]);
    approxVec(axle.bbox.min, [-1, -1, 0], 0, 1e-6, 'axle bbox.min');
    approxVec(axle.centroid, [0, 0, 2], 0, 1e-9, 'axle centroid');
    assert.deepEqual(axle.notes, []);

    // A reflection through the origin is written with an identity rigid part:
    // the other part, placed as is, has that same (identity) placement.
    const pointMirror = xcafStep('point_mirror.step', ({ shapeTool: st, named }) => {
      const top = named(st.NewShape(), 'Pair');
      const a = named(st.AddShape(box(2, 3, 4, 6, 7, 8), false, true), 'A');
      const b = named(st.AddShape(box(10, 0, 0, 5, 5, 5), false, true), 'B');
      named(st.AddComponent_1(top, a, placement([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0])), 'Mirrored');
      named(st.AddComponent_1(top, b, placement([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0])), 'AsIs');
    });
    const text = mirrorStepInstance(new TextDecoder().decode(pointMirror), [0, 0, 0], 'Mirrored');
    const [a, b] = analyzeCad(oc, new TextEncoder().encode(text), 'point_mirror.step').bodies;
    approxVec(a.bbox.min, [-8, -10, -12], 0, 1e-9, 'point-mirrored bbox.min');
    approxVec(a.bbox.max, [-2, -3, -4], 0, 1e-9, 'point-mirrored bbox.max');
    assert.deepEqual(a.notes, [NOTE_INVERTED]);
    approxVec(b.bbox.min, [10, 0, 0], 0, 1e-9, 'unmoved bbox.min');
    approxVec(b.bbox.max, [15, 5, 5], 0, 1e-9, 'unmoved bbox.max');
    assert.deepEqual(b.notes, []);
  });

  test('mirrored instance next to a half turn and to an identity placement (fixtures)', (t) => {
    // Box (2, 3, 4) + (6, 7, 8) mirrored through the XY plane (written as half a
    // turn about z and a scale of -1), then through the origin; box (10, 0, 0) +
    // (5, 5, 5) turned half a turn about z, then left in place.
    const cases = {
      'mirror_halfturn.step': [[[2, 3, -12], [8, 10, -4], [5, 6.5, -8]], [[-15, -5, 0], [-10, 0, 5], [-12.5, -2.5, 2.5]]],
      'pointmirror_identity.step': [[[-8, -10, -12], [-2, -3, -4], [-5, -6.5, -8]], [[10, 0, 0], [15, 5, 5], [12.5, 2.5, 2.5]]],
    };
    // OpenCascade < 8 (cadquery-ocp 7.x running make_fixtures.py) writes the
    // mirrored instance without its reflection: nothing to check then.
    const mirroring = /CARTESIAN_TRANSFORMATION_OPERATOR_3D\s*\([^;]*,\s*-1\.\s*,[^,;]*\)\s*;/;
    const written = Object.keys(cases).filter((name) => mirroring.test(new TextDecoder().decode(fixtureBytes(name))));
    if (!written.length) {
      t.skip('fixtures written without mirroring operators (OpenCascade < 8)');
      return;
    }
    for (const [name, [mirrored, other]] of Object.entries(cases)) {
      assert.ok(written.includes(name), `${name}: no mirroring operator`);
      const { bodies } = timedAnalyze(t, name, undefined, undefined, `${name} (placements)`);
      assert.deepEqual(bodies.map((b) => b.name), ['MirroredPart', 'OtherPart'], name);
      bodies.forEach((b, i) => {
        const [min, max, centroid] = [mirrored, other][i];
        approxVec(b.bbox.min, min, 0, 1e-9, `${name} ${b.name} bbox.min`);
        approxVec(b.bbox.max, max, 0, 1e-9, `${name} ${b.name} bbox.max`);
        approxVec(b.centroid, centroid, 0, 1e-9, `${name} ${b.name} centroid`);
        assert.deepEqual(b.notes, i ? [] : [NOTE_INVERTED], `${name} ${b.name} notes`);
        // The normals of the faces point out of the box, mirrored or not.
        for (const s of b.geometric_surfaces) {
          const out = s.normal.reduce((n, x, k) => n + x * (s.center_mm[k] - centroid[k]), 0);
          assert.ok(out > 0, `${name} ${b.name} face ${s.index}: normal into the box`);
        }
      });
      approx(totalVolume({ bodies }), 6 * 7 * 8 + 125, 1e-12, 0, `${name} volume`);
    }
  });

  test('NURBS solids: volume, area and centre of mass are exact', (t) => {
    // Exact rational NURBS conversions of a torus (R 10, r 3), a cylinder (r 5,
    // h 20) and a sphere (r 5). BRepGProp's default fixed-order integration was
    // off by +0.21 %, +0.86 % and -0.04 % in volume (+0.50 %, +0.18 %, +0.37 % in area).
    const sphere = new oc.BRepBuilderAPI_NurbsConvert_2(new oc.BRepPrimAPI_MakeSphere_1(5).Shape(), true).Shape();
    const cases = [
      ['nurbs_torus.step', null, 2 * Math.PI ** 2 * 10 * 9, 4 * Math.PI ** 2 * 10 * 3, [0, 0, 0]],
      ['nurbs_cylinder.step', null, Math.PI * 25 * 20, 2 * Math.PI * 5 * 20 + 2 * Math.PI * 25, [0, 0, 10]],
      ['nurbs_sphere.brep', brepBytes('nurbs_sphere.brep', sphere), (4 / 3) * Math.PI * 125, 4 * Math.PI * 25, [0, 0, 0]],
    ];
    for (const [name, bytes, volume, surface, centroid] of cases) {
      const { bodies } = timedAnalyze(t, name, bytes, undefined, `${name} (NURBS)`);
      assert.equal(bodies.length, 1, name);
      const [b] = bodies;
      assert.equal(b.closed, true, name);
      assert.deepEqual(b.notes, [], name);
      approx(b.volume, volume, NURBS, 0, `${name}: volume`);
      approx(b.area, surface, NURBS, 0, `${name}: area`);
      approxVec(b.centroid, centroid, 0, 1e-6, `${name}: centroid`);
    }
  });

  test('closing on request: a missing chamfer between two contours is filled by a ring, not two caps', () => {
    // A cylinder r 45 x 50 mm chamfered 4 mm at the top, given without its chamfer:
    // two holes, the circle of the side (r 45) and the one of the top face (r 41), 4 mm apart.
    const cylinder = new oc.BRepPrimAPI_MakeCylinder_1(45, 50).Shape();
    const chamfer = new oc.BRepFilletAPI_MakeChamfer(cylinder);
    const top = edges(cylinder).find((e) => {
      const curve = new oc.BRepAdaptor_Curve_2(e);
      return curve.Value(curve.FirstParameter()).Z() > 49;
    });
    chamfer.Add_2(4, top);
    const solid = chamfer.Shape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
    const kept = faces(solid).filter((f) => oc.BRep_Tool.Surface_2(f).get().DynamicType().get().Name() !== 'Geom_ConicalSurface');
    assert.equal(kept.length, 3);
    const bytes = brepBytes('no_chamfer.brep', assemble('Compound', kept));
    const [open] = analyzeCad(oc, bytes, 'no_chamfer.brep').bodies;
    assert.equal(open.closed, false);
    const [body, ...others] = analyzeCad(oc, bytes, 'no_chamfer.brep', { close: true }).bodies;
    assert.deepEqual(others, []);
    assert.equal(body.closed, true);
    // The ruled ring between the two circles is the chamfer itself: the volume of the chamfered cylinder.
    approx(body.volume, props.Mass(), 1e-6, 0, 'closed volume');
  });

  test('a closed surface made of a single face becomes a solid', (t) => {
    // Sewing leaves a lone closed face (sphere, torus) as a face, not a shell.
    const sphereFace = timedAnalyze(t, 'sphere_face.step', undefined, undefined, 'sphere_face.step (single face)').bodies;
    assert.equal(sphereFace.length, 1);
    assert.equal(sphereFace[0].closed, true);
    assert.deepEqual(sphereFace[0].notes, [NOTE_SEWN]);
    approx(sphereFace[0].volume, (4 / 3) * Math.PI * 125, 1e-9, 0, 'sphere surface volume');
    approx(sphereFace[0].area, 4 * Math.PI * 25, 1e-9, 0, 'sphere surface area');
    approxVec(sphereFace[0].centroid, [0, 0, 0], 0, 1e-9, 'sphere surface centroid');

    // A torus face, and an open face (side of a cylinder) that stays open.
    const [torusFace] = faces(new oc.BRepPrimAPI_MakeTorus_1(10, 3).Shape());
    const side = faces(new oc.BRepPrimAPI_MakeCylinder_1(2, 5).Shape()).find((f) => {
      const surface = oc.BRep_Tool.Surface_2(f);
      return surface.get().DynamicType().get().Name() === 'Geom_CylindricalSurface';
    });
    const moved = side.Moved(new oc.TopLoc_Location_2(translation(30, 0, 0)), false);
    const { bodies } = analyzeCad(oc, brepBytes('faces.brep', assemble('Compound', [torusFace, moved])), 'faces.brep');
    assert.deepEqual(bodies.map((b) => b.name), ['faces', 'faces (surfaces)']);
    const [torus, open] = bodies;
    assert.equal(torus.closed, true);
    assert.deepEqual(torus.notes, [NOTE_SEWN]);
    approx(torus.volume, 2 * Math.PI ** 2 * 10 * 9, 1e-9, 0, 'torus surface volume');
    assert.equal(open.closed, false);
    assert.equal(open.volume, null);
    assert.deepEqual(open.notes, [NOTE_OPEN]);
    approx(open.area, 2 * Math.PI * 2 * 5, 1e-9, 0, 'open face area');
  });
});

/**
 * Rewrite the STEP text so that the instance placed at `origin` (the one named
 * `occurrence` if given) is placed by a CARTESIAN_TRANSFORMATION_OPERATOR_3D
 * with scale -1 and the same origin and axes as its rigid placement, the way
 * OpenCascade 8 writes a mirrored instance.
 */
function mirrorStepInstance(text, origin, occurrence = null) {
  const record = (id) => text.match(new RegExp(`${id}\\s*=\\s*(\\w+)\\s*\\(([^;]*)\\);`));
  const refs = (args) => args.match(/#\d+/g);
  const point = (args) => args.match(/\(([^()]*)\)\s*\)?$/)[1].split(',').map(Number);
  // NEXT_ASSEMBLY_USAGE_OCCURRENCE <- PRODUCT_DEFINITION_SHAPE <- CONTEXT_DEPENDENT_SHAPE_REPRESENTATION
  // -> representation relationship -> its ITEM_DEFINED_TRANSFORMATION.
  const referrer = (pattern) => text.match(new RegExp(pattern))?.[1];
  let only = null;
  if (occurrence) {
    const nauo = referrer(`(#\\d+)\\s*=\\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\\s*\\('[^']*','${occurrence}'`);
    const shape = referrer(`(#\\d+)\\s*=\\s*PRODUCT_DEFINITION_SHAPE\\s*\\([^;]*${nauo}\\s*\\)`);
    const rel = referrer(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION\\s*\\(\\s*(#\\d+)\\s*,\\s*${shape}\\s*\\)`);
    only = referrer(`${rel}\\s*=[^;]*REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\\s*\\(\\s*(#\\d+)`);
    assert.ok(nauo && shape && rel && only, `occurrence ${occurrence} not found`);
  }
  let found = null;
  for (const [all, id, args] of text.matchAll(/(#\d+)\s*=\s*ITEM_DEFINED_TRANSFORMATION\s*\(([^;]*)\);/g)) {
    if (only && id !== only) continue;
    const target = refs(args)[1]; // AXIS2_PLACEMENT_3D(name, location, axis, ref_direction)
    const [loc, axis, refDir] = refs(record(target)[2]);
    if (point(record(loc)[2]).every((v, i) => v === origin[i])) found = { all, id, loc, axis, refDir };
  }
  assert.ok(found, 'placement to mirror');
  // axis1 = ref_direction (x), axis3 = axis (z), axis2 = z ^ x.
  const x = point(record(found.refDir)[2]);
  const z = point(record(found.axis)[2]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const next = 1 + Math.max(...[...text.matchAll(/#(\d+)\s*=/g)].map((m) => Number(m[1])));
  const num = (v) => (Number.isInteger(v) ? `${v}.` : String(v));
  const dir = (v) => `DIRECTION('',(${v.map(num).join(',')}))`;
  const added = [
    `#${next} = ${dir(x)};`,
    `#${next + 1} = ${dir(y)};`,
    `#${next + 2} = ${dir(z)};`,
    `${found.id} = CARTESIAN_TRANSFORMATION_OPERATOR_3D('','','',#${next},#${next + 1},${found.loc},-1.,#${next + 2});`,
  ];
  const at = text.indexOf('ENDSEC;', text.indexOf('DATA;'));
  return (text.slice(0, at) + added.join('\n') + '\n' + text.slice(at)).replace(found.all, '');
}

// --------------------------------------------------------------------------- errors

describe('CAD progress', () => {
  test('progress is reported while OpenCascade reads and converts the file', () => {
    assert.ok(oc.work, 'the work meter is installed');
    const reports = [];
    const interval = oc.work.interval;
    oc.work.interval = 0; // a beat at every check, so that a small file gives several
    try {
      analyzeCad(oc, fixtureBytes('as1_pe_203.stp'), 'as1_pe_203.stp', { onProgress: (p) => reports.push(p) });
    } finally {
      oc.work.interval = interval;
    }
    assert.equal(oc.work.onBeat, null, 'the beat callback is removed after the analysis');
    const steps = [...new Set(reports.map((p) => p.step))];
    assert.deepEqual(steps, ['read', 'transfer', 'mesh', 'measure']);
    for (let i = 1; i < reports.length; i++) {
      assert.ok(reports[i].percent >= reports[i - 1].percent, `progress never goes back: ${reports.map((p) => p.percent)}`);
    }
    assert.equal(reports[0].percent, 0);
    assert.equal(reports.at(-1).percent, 100);
    // Inside the two long OpenCascade calls, not only at their ends.
    const inside = (step, from, to) => reports.filter((p) => p.step === step && p.beat && p.percent > from && p.percent < to);
    assert.ok(inside('read', 0, 15).length >= 3, `parsing: ${reports.map((p) => p.step + p.percent)}`);
    assert.ok(inside('transfer', 15, 50).length >= 3, `conversion: ${reports.map((p) => p.step + p.percent)}`);
    assert.ok(reports.filter((p) => p.step === 'transfer').every((p) => p.approximate), 'the conversion is marked approximate');
    assert.ok(reports.filter((p) => p.step === 'read').every((p) => !p.approximate), 'the STEP parsing is measured');
  });
});

describe('CAD errors', () => {
  // Deterministic pseudo-random bytes.
  const garbage = new Uint8Array(4096).map((_, i) => (Math.imul(i + 1, 2654435761) >>> 13) & 0xff);
  const readable = (pattern) => (err) => {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err} ${err}`);
    assert.match(err.message, pattern);
    return true;
  };

  test('garbage bytes give the Python error messages', () => {
    assert.throws(() => analyzeCad(oc, garbage, 'garbage.step'), readable(/^Unable to read STEP file$/));
    assert.throws(() => analyzeCad(oc, garbage, 'garbage.stp'), readable(/^Unable to read STEP file$/));
    assert.throws(() => analyzeCad(oc, garbage, 'garbage.igs'), readable(/^Unable to read IGES file$/));
    assert.throws(() => analyzeCad(oc, garbage, 'garbage.brep'), readable(/^Unable to read BREP file$/));
    assert.throws(() => analyzeCad(oc, new Uint8Array(0), 'empty.step'), readable(/^Unable to read STEP file$/));
  });

  test('a STEP file without any entity cannot be transferred', () => {
    const text = [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('empty'),'2;1');",
      "FILE_NAME('empty.step','2026-01-01T00:00:00',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', 'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    assert.throws(
      () => analyzeCad(oc, new TextEncoder().encode(text), 'empty.step'),
      readable(/^Unable to transfer STEP geometry$/),
    );
  });

  test('a truncated BREP file fails instead of hanging OpenCascade', () => {
    // BRepTools::Read loops forever on this one (OCCT 8 under Python too).
    const truncated = fixtureBytes('holed_block.brep').slice(0, 1500);
    assert.throws(() => analyzeCad(oc, truncated, 'holed_block.brep'), readable(/^Unable to read BREP file$/));
  });

  test('C++ exceptions do not leave the emscripten stack pointer moved', () => {
    // A C++ exception that unwinds into JavaScript skips the code popping the
    // shadow stack: without a restore, every failed file lowered the stack
    // pointer until the stack overwrote the module's static data.
    const full = fixtureBytes('holed_block.brep');
    const sp = oc.stackSave();
    const messages = new Set();
    for (let cut = 1; cut <= 16; cut++) {
      try {
        analyzeCad(oc, full.slice(0, full.length - cut), 'holed_block.brep');
      } catch (err) {
        messages.add(err.message);
      }
    }
    assert.ok([...messages].some((m) => m.startsWith('OpenCascade could not process the file')), [...messages].join('; '));
    assert.equal(oc.stackSave(), sp, 'stack pointer after the failures');
  });

  test('unsupported extensions are rejected', () => {
    assert.throws(() => analyzeCad(oc, garbage, 'model.xyz'), readable(/^Unsupported file type '\.xyz'$/));
  });

  test('the module still works after errors', (t) => {
    const result = timedAnalyze(t, 'holed_block.step', undefined, undefined, 'holed_block.step (after errors)');
    checkParity(result, expected['holed_block.step'], 'holed_block.step');
  });
});

// --------------------------------------------------------------------------- state

/**
 * Bytes in use in the wasm heap: its size minus what can still be allocated
 * in it (blocks of decreasing sizes, so that the holes left between live
 * objects are counted too; a few bytes per hole are missed). Unlike the
 * address of a new block, this does not depend on how fragmented the heap is.
 */
function usedHeapBytes() {
  const chunk = (size) => Math.max(16, (size + 11) & ~7); // dlmalloc block for a request (wasm32)
  const heapSize = oc.HEAPU8.length;
  const blocks = [];
  let free = 0;
  for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16, 8]) {
    for (;;) {
      const p = oc._malloc(size) >>> 0;
      if (!p) break;
      blocks.push(p);
      if (p + size > heapSize) break; // the heap had to grow: no more room of this size
      free += chunk(size);
    }
  }
  for (const p of blocks) oc._free(p);
  return heapSize - free;
}

describe('CAD state between analyses', () => {
  test('consecutive analyses in the same module give identical results', (t) => {
    const names = ['named_assembly.step', 'as1_pe_203.stp', 'surface_box.step', 'holed_block.igs'];
    const first = names.map((n) => timedAnalyze(t, n, undefined, undefined, `${n} (run 1)`));
    // Other work in between, including a failure.
    assert.throws(() => analyzeCad(oc, new Uint8Array(100), 'noise.step'));
    timedAnalyze(t, 'io1-cm-214.stp', undefined, { quality: 'fine' }, 'io1-cm-214.stp (fine)');
    const second = names.map((n) => timedAnalyze(t, n, undefined, undefined, `${n} (run 2)`));
    names.forEach((n, i) => assert.deepStrictEqual(second[i], first[i], `${n}: second run differs`));
  });

  test('ArrayBuffer input and the file name extension case are accepted', (t) => {
    const bytes = fixtureBytes('holed_block.brep');
    const result = timedAnalyze(t, 'HOLED_BLOCK.BREP', bytes.buffer, undefined, 'HOLED_BLOCK.BREP (ArrayBuffer)');
    assert.equal(result.bodies[0].name, 'HOLED_BLOCK');
    approx(result.bodies[0].volume, expected['holed_block.brep'].summary.volume, EXACT, 0, 'volume');
  });

  test('the wasm heap does not grow from one analysis to the next', (t) => {
    // mirror_halfturn.step: read with a work session of the engine's own.
    const files = ['as1_pe_203.stp', 'io1-cm-214.stp', 'surface_box.step', 'mirror_halfturn.step', 'sphere_face.step'];
    const bytes = files.map((f) => fixtureBytes(f));
    const runAll = () => files.forEach((f, i) => analyzeCad(oc, bytes[i], f));
    runAll(); // warm-up: allocator caches and heap layout settle
    const before = usedHeapBytes();
    const runs = 4;
    for (let i = 0; i < runs; i++) runAll();
    const growth = usedHeapBytes() - before;
    t.diagnostic(`heap growth over ${runs} runs of ${files.join(', ')}: ${(growth / 1024).toFixed(0)} kB`);
    // Without the release of shapes this was about 5 MB: whole models leaked.
    assert.ok(growth < 128 * 1024, `heap grew by ${(growth / 1024).toFixed(0)} kB`);
  });

  test('the wasm heap does not grow either with a many-instance assembly', (t) => {
    // Per instance and per face, OpenCascade hands over locations, shapes,
    // points... by value: objects that delete() alone did not free.
    const instances = 300;
    const bytes = xcafStep('instances.step', ({ shapeTool: st, named }) => {
      const top = named(st.NewShape(), 'Rack');
      const pin = named(st.AddShape(new oc.BRepPrimAPI_MakeCylinder_1(1, 4).Shape(), false, true), 'Pin');
      for (let i = 0; i < instances; i++) {
        const angle = (2 * Math.PI * i) / instances;
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        st.AddComponent_1(top, pin, placement([[c, -s, 0], [s, c, 0], [0, 0, 1]], [i % 20, Math.floor(i / 20), 0]));
      }
    });
    const first = analyzeCad(oc, bytes, 'instances.step');
    assert.equal(first.bodies.length, instances);
    // The memory in use fluctuates by a few hundred kB from one analysis to
    // the next (OpenCascade caches): compare the lowest values of 3 runs.
    const used = [];
    for (let i = 0; i < 6; i++) {
      analyzeCad(oc, bytes, 'instances.step');
      used.push(usedHeapBytes());
    }
    const growth = Math.min(...used.slice(3)) - Math.min(...used.slice(0, 3));
    t.diagnostic(`heap growth over 3 runs of ${instances} instances: ${(growth / 1024).toFixed(0)} kB`);
    // About 1.5 kB per instance and run when they were only deleted (1.4 MB here).
    assert.ok(growth < 768 * 1024, `heap grew by ${(growth / 1024).toFixed(0)} kB`);
  });

  test('no temporary file is left in the emscripten file system', () => {
    const leftovers = oc.FS.readdir('/').filter((f) => f.startsWith('cad-input-'));
    assert.deepEqual(leftovers, []);
  });
});

// --------------------------------------------------------------------------- envelopes

// The totals and oriented envelope are computed by summary.js (MESH component);
// checked here on CAD results when that module is present.
const summaryModule = join(ROOT, 'web', 'engine', 'summary.js');

let summarize;
describe('CAD envelopes through summary.js', { skip: !existsSync(summaryModule) && 'web/engine/summary.js not present' }, () => {
  before(async () => {
    ({ summarize } = await import('../../web/engine/summary.js'));
  });

  for (const name of cadFiles) {
    test(name, (t) => {
      const result = parityResults.get(name) ?? timedAnalyze(t, name, undefined, undefined, `${name} (summary)`);
      const s = summarize(result.bodies);
      const e = expected[name].summary;
      const size = modelSize(expected[name]);
      approx(s.volume, e.volume, EXACT, 0, 'volume');
      approx(s.area, e.area, EXACT, 0, 'area');
      approxVec(s.centroid, e.centroid, EXACT, EXACT * size, 'centroid');
      assert.equal(s.bodies, e.bodies, 'bodies');
      assert.equal(s.solids, e.solids, 'solids');
      assert.equal(s.open_bodies, e.open_bodies, 'open_bodies');
      approxVec(s.bbox.min, e.bbox.min, 0, BBOX * size, 'bbox.min');
      approxVec(s.bbox.max, e.bbox.max, 0, BBOX * size, 'bbox.max');
      approx(s.bbox.volume, e.bbox.volume, BBOX * 3, 0, 'bbox.volume');
      // The oriented box encloses the display vertices: with another tessellation
      // (see checkMeshVolume) it encloses other points (0.4 % apart on revolved_spline.step).
      const tol = totalTriangles(result) === e.triangles ? OBB : OTHER_MESH;
      approxVec(s.obb.size, e.obb.size, tol, 0, 'obb.size');
      approx(s.obb.volume, e.obb.volume, tol, 0, 'obb.volume');
      assert.ok(s.obb.volume <= s.bbox.volume * (1 + 1e-9), 'the oriented box is not larger than the axis-aligned one');
      approx(s.fill_ratio, e.fill_ratio, BBOX * 3, 0, 'fill_ratio');
    });
  }

  test('far from the origin, the envelope uses double-precision vertices', () => {
    // At 1e6 mm from the origin float32 has a 0.06 mm resolution: the oriented
    // box of a 12 mm model computed from the display positions was 1 % off.
    const model = () => assemble('Compound', [box(0, 0, 0, 1, 2, 3), new oc.BRepPrimAPI_MakeSphere_5(new oc.gp_Pnt_3(10, 0, 0), 1.5).Shape()]);
    const near = analyzeCad(oc, brepBytes('near.brep', model()), 'near.brep');
    const moved = model().Moved(new oc.TopLoc_Location_2(translation(1e6, 1e6, 1e6)), false);
    const far = analyzeCad(oc, brepBytes('far.brep', moved), 'far.brep');
    // (the box corners, 1e6 + integers, are exact in float32 and need no copy; the sphere's are not)
    const sphere = far.bodies.find((b) => b.triangles > 12);
    assert.ok(sphere.mesh.positions64 instanceof Float64Array, 'float64 vertices far from the origin');
    assert.equal(sphere.mesh.positions64.length, sphere.mesh.positions.length);
    const [sNear, sFar] = [near, far].map((r) => summarize(r.bodies));
    approxVec(sFar.obb.size, sNear.obb.size, 1e-6, 0, 'oriented box size');
    approx(sFar.volume, sNear.volume, 1e-9, 0, 'volume');
  });

  test('near the origin too, the envelope uses double-precision vertices (R4)', () => {
    // A thin plate (100 x 100 x 0.01 mm) placed with a rotation: float32 rounds its
    // vertices by up to 4e-6 mm, which made its oriented envelope 1.8e-5 too large
    // (the parity target is 1e-6); the Python engine measures double-precision vertices.
    const [a, b] = [0.5, 0.3]; // rotation about z, then about x
    const rotation = [
      [Math.cos(a), -Math.sin(a), 0],
      [Math.cos(b) * Math.sin(a), Math.cos(b) * Math.cos(a), -Math.sin(b)],
      [Math.sin(b) * Math.sin(a), Math.sin(b) * Math.cos(a), Math.cos(b)],
    ];
    const plate = box(0, 0, 0, 100, 100, 0.01).Moved(placement(rotation, [0, 0, 0]), false);
    const { bodies } = analyzeCad(oc, brepBytes('plate.brep', plate), 'plate.brep');
    assert.ok(bodies[0].mesh.positions64 instanceof Float64Array, 'float64 vertices kept');
    const s = summarize(bodies);
    approx(s.obb.volume, 100, 1e-9, 0, 'oriented box volume');
    approxVec(s.obb.size, [100, 100, 0.01], 1e-9, 0, 'oriented box size');
    // Vertices that float32 holds exactly need no copy.
    const exact = analyzeCad(oc, brepBytes('box.brep', box(0, 0, 0, 1, 2, 3)), 'box.brep');
    assert.equal(exact.bodies[0].mesh.positions64, undefined, 'no float64 copy of exact vertices');
  });
});

// --------------------------------------------------------------------------- large heaps
// Last: these tests grow the wasm heap for good (to 2 GiB, then to its 4 GiB
// maximum), as large models do. The memory is reserved, hardly touched.

describe('CAD with a large wasm heap', () => {
  const heapTop = () => {
    const p = oc._malloc(1 << 20) >>> 0;
    oc._free(p);
    return p;
  };

  /** Analyse with Poly_Triangulation.Node/Triangle calls counted and triangulation addresses recorded. */
  function analyzeCounting(name) {
    const P = oc.Poly_Triangulation.prototype;
    const H = oc.Handle_Poly_Triangulation.prototype;
    const [node, triangle, get] = [P.Node, P.Triangle, H.get];
    const counts = { node: 0, triangle: 0, addresses: [] };
    P.Node = function (...args) {
      counts.node++;
      return node.apply(this, args);
    };
    P.Triangle = function (...args) {
      counts.triangle++;
      return triangle.apply(this, args);
    };
    H.get = function () {
      const tri = get.call(this);
      counts.addresses.push(tri.$$.ptr >>> 0);
      return tri;
    };
    try {
      return { result: analyzeCad(oc, fixtureBytes(name), name), counts };
    } finally {
      [P.Node, P.Triangle, H.get] = [node, triangle, get];
    }
  }

  test('triangulations above 2 GiB are still read straight from the heap', (t) => {
    // Embind hands pointers over as signed integers, negative above 2 GiB:
    // every triangulation there went through the slow per-node accessors.
    const name = 'sphere.stp';
    const low = analyzeCounting(name);
    const blocks = [];
    try {
      // Move the heap top past 2 GiB, then fill the free blocks below it.
      const spacer = oc._malloc(Math.max(2 ** 31 - heapTop() + (16 << 20), 0)) >>> 0;
      if (spacer) blocks.push(spacer);
      for (const size of [1 << 16, 4096, 512, 64, 16]) {
        for (let p; (p = oc._malloc(size) >>> 0); ) {
          blocks.push(p);
          if (p >= 2 ** 31) break;
        }
      }
      const high = analyzeCounting(name);
      if (!high.counts.addresses.some((a) => a >= 2 ** 31)) {
        t.skip('the heap could not be grown past 2 GiB here');
        return;
      }
      t.diagnostic(`Node() calls: ${low.counts.node} below 2 GiB, ${high.counts.node} above`);
      assert.equal(high.counts.node, low.counts.node, 'Node() calls (samples only)');
      assert.equal(high.counts.triangle, low.counts.triangle, 'Triangle() calls (samples only)');
      assert.deepStrictEqual(high.result, low.result);
    } finally {
      for (const p of blocks) oc._free(p);
    }
  });

  test('running out of wasm memory is reported, not turned into missing geometry', (t) => {
    // Simulated: the heap is grown to its maximum and the mesher produces
    // nothing, as BRepMesh does when its allocations fail.
    const blocks = [];
    const Mesher = oc.BRepMesh_IncrementalMesh_2;
    try {
      for (const size of [2 ** 30, 2 ** 28, 2 ** 26, 2 ** 24]) {
        for (let p; (p = oc._malloc(size) >>> 0); ) blocks.push(p);
      }
      if (oc.HEAPU8.length < 2 ** 32 - 2 ** 27) {
        t.skip(`the heap could only grow to ${oc.HEAPU8.length >>> 20} MB here`);
        return;
      }
      oc.BRepMesh_IncrementalMesh_2 = function () {
        return { delete() {} };
      };
      assert.throws(
        () => analyzeCad(oc, fixtureBytes('two_solids.step'), 'two_solids.step'),
        (err) => err instanceof Error && /^Not enough memory/.test(err.message),
      );
    } finally {
      oc.BRepMesh_IncrementalMesh_2 = Mesher;
      for (const p of blocks) oc._free(p);
    }
    // With the memory back, the same model is analysed normally.
    checkParity(analyzeCad(oc, fixtureBytes('two_solids.step'), 'two_solids.step'), expected['two_solids.step'], 'two_solids.step');
  });
});
