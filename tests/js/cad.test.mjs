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
const BBOX = 1e-6; // bounding boxes, relative to the model size
const MESH = 2e-3; // tessellation-dependent values (OCCT versions differ)
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
    approx(body.mesh_volume, eb.mesh_volume, MESH, 0, `${label}: mesh_volume`);
    approxVec(body.color, eb.color, 0, COLOR, `${label}: color`);
  });

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
      if (analytic != null) approx(totalVolume(result), analytic, EXACT, 0, `${name}: analytic volume`);
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
    // A finer mesh approximates the exact volume better.
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
});

/**
 * Rewrite the STEP text so that the instance placed at `origin` is placed by a
 * CARTESIAN_TRANSFORMATION_OPERATOR_3D with scale -1 and the same origin and
 * axes as its rigid placement, the way OpenCascade 8 writes a mirrored instance.
 */
function mirrorStepInstance(text, origin) {
  const record = (id) => text.match(new RegExp(`${id}\\s*=\\s*(\\w+)\\s*\\(([^;]*)\\);`));
  const refs = (args) => args.match(/#\d+/g);
  const point = (args) => args.match(/\(([^()]*)\)\s*\)?$/)[1].split(',').map(Number);
  let found = null;
  for (const [all, id, args] of text.matchAll(/(#\d+)\s*=\s*ITEM_DEFINED_TRANSFORMATION\s*\(([^;]*)\);/g)) {
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
    const files = ['as1_pe_203.stp', 'io1-cm-214.stp', 'surface_box.step'];
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
      approxVec(s.obb.size, e.obb.size, MESH, 0, 'obb.size');
      approx(s.obb.volume, e.obb.volume, MESH, 0, 'obb.volume');
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
    assert.ok(near.bodies.every((b) => b.mesh.positions64 === undefined), 'no float64 copy near the origin');
    for (const b of far.bodies) {
      assert.ok(b.mesh.positions64 instanceof Float64Array, 'float64 vertices far from the origin');
      assert.equal(b.mesh.positions64.length, b.mesh.positions.length);
    }
    const [sNear, sFar] = [near, far].map((r) => summarize(r.bodies));
    approxVec(sFar.obb.size, sNear.obb.size, 1e-6, 0, 'oriented box size');
    approx(sFar.volume, sNear.volume, 1e-9, 0, 'volume');
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
