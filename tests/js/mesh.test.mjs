// Mesh engine (web/engine/meshload.js + meshanalysis.js + summary.js) against the
// Python engine results in tests/fixtures/generated/expected.json, plus regression cases
// whose reference values were produced by reader3d (Python) on the very same bytes.
//
//   node --test tests/js/mesh.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

import { loadMeshFile, needsDomParser, MESH_EXTENSIONS } from '../../web/engine/meshload.js';
import { analyzeMesh, analyzeMeshParts } from '../../web/engine/meshanalysis.js';
import { summarize } from '../../web/engine/summary.js';
import { UNITS, unitFromName } from '../../web/engine/units.js';
import { approx, approxVec, fixtureBytes, loadExpected } from './helpers.mjs';

const expected = loadExpected();
const REL = 1e-6; // parity tolerance of mesh results (SPEC)

const extOf = (name) => name.slice(name.lastIndexOf('.')).toLowerCase();
const meshFixtures = Object.keys(expected).filter((n) => expected[n].kind === 'mesh');

async function analyzeFixture(name, options) {
  const { parts, source_unit } = await loadMeshFile(fixtureBytes(name), name, options);
  const bodies = analyzeMeshParts(parts);
  return { source_unit, bodies, summary: summarize(bodies) };
}

const modelSize = (bbox) => Math.max(...bbox.size.map(Math.abs), 1e-12);

/** Lengths (centroids, bounds) are compared relative to the model size. */
function approxPoint(actual, wanted, size, message) {
  approxVec(actual, wanted, REL, REL * size, message);
}

function checkBody(js, py, size, label, { color = true } = {}) {
  assert.equal(js.closed, py.closed, `${label}: closed`);
  // glTF colours are deliberately reported in sRGB (see meshload.js)
  if (color) approxVec(js.color, py.color, 0, 2e-3, `${label}: color`);
  assert.deepEqual(js.notes, py.notes, `${label}: notes`);
  assert.equal(js.method, 'mesh', `${label}: method`);
  assert.equal(js.triangles, py.triangles, `${label}: triangles`);
  approx(js.volume, py.volume, REL, 0, `${label}: volume`);
  approx(js.mesh_volume, py.mesh_volume, REL, 0, `${label}: mesh_volume`);
  approx(js.area, py.area, REL, 0, `${label}: area`);
  approxPoint(js.centroid, py.centroid, size, `${label}: centroid`);
  approxPoint(js.bbox.min, py.bbox.min, size, `${label}: bbox.min`);
  approxPoint(js.bbox.max, py.bbox.max, size, `${label}: bbox.max`);
  approxPoint(js.bbox.size, py.bbox.size, size, `${label}: bbox.size`);

  // Display arrays of the result contract.
  assert.ok(js.mesh.positions instanceof Float32Array, `${label}: positions are a Float32Array`);
  assert.ok(js.mesh.indices instanceof Uint32Array, `${label}: indices are a Uint32Array`);
  assert.equal(js.mesh.indices.length, 3 * js.triangles, `${label}: index count`);
  const nv = js.mesh.positions.length / 3;
  assert.ok(js.mesh.indices.every((i) => i < nv), `${label}: indices in range`);
}

test('every generated mesh fixture is covered', () => {
  assert.ok(meshFixtures.length >= 12, `only ${meshFixtures.length} mesh fixtures`);
  for (const ext of ['.stl', '.obj', '.ply', '.off', '.glb', '.3mf', '.dae']) {
    assert.ok(meshFixtures.some((n) => extOf(n) === ext), `no ${ext} fixture`);
  }
  for (const name of meshFixtures) assert.ok(MESH_EXTENSIONS.includes(extOf(name)), name);
});

for (const name of meshFixtures) {
  test(`${name} matches the Python engine`, async () => {
    const py = expected[name];
    const js = await analyzeFixture(name);
    const size = modelSize(py.summary.bbox);
    assert.equal(js.source_unit, py.source_unit, 'source_unit');

    // Totals: trimesh and three may group the geometry of a file differently, the totals
    // never depend on it.
    const s = js.summary, e = py.summary;
    for (const key of ['bodies', 'solids', 'open_bodies', 'triangles']) assert.equal(s[key], e[key], `summary.${key}`);
    approx(s.volume, e.volume, REL, 0, 'summary.volume');
    approx(s.area, e.area, REL, 0, 'summary.area');
    approx(s.fill_ratio, e.fill_ratio, REL, 0, 'summary.fill_ratio');
    approxPoint(s.centroid, e.centroid, size, 'summary.centroid');
    approxPoint(s.bbox.min, e.bbox.min, size, 'summary.bbox.min');
    approxPoint(s.bbox.max, e.bbox.max, size, 'summary.bbox.max');
    approx(s.bbox.volume, e.bbox.volume, REL, 0, 'summary.bbox.volume');

    // Oriented envelope: trimesh searches hull directions on a 0.1 rad grid, we search
    // all of them, so ours can only be (slightly) smaller; both never exceed the AABB.
    assert.ok(s.obb.volume <= e.obb.volume * (1 + REL), `obb ${s.obb.volume} > python ${e.obb.volume}`);
    assert.ok(s.obb.volume >= e.obb.volume * (1 - 2e-3), `obb ${s.obb.volume} << python ${e.obb.volume}`);
    assert.ok(s.obb.volume <= s.bbox.volume * (1 + 1e-12), 'obb larger than the AABB');
    assert.deepEqual([...s.obb.size].sort((a, b) => b - a), s.obb.size, 'obb sizes sorted');
    approx(s.obb.volume, s.obb.size[0] * s.obb.size[1] * s.obb.size[2], 1e-12, 0, 'obb volume');

    // Bodies, matched by name (the order of trimesh's scene graph is arbitrary).
    assert.equal(js.bodies.length, py.bodies.length, 'body count');
    const byName = new Map(js.bodies.map((b) => [b.name, b]));
    for (const pb of py.bodies) {
      const jb = byName.get(pb.name);
      assert.ok(jb, `body '${pb.name}' missing (got ${[...byName.keys()].join(', ')})`);
      checkBody(jb, pb, size, `${name}/${pb.name}`, { color: !['.glb', '.gltf'].includes(extOf(name)) });
    }

    if (py.analytic_volume !== null) approx(s.volume, py.analytic_volume, REL, 0, 'analytic volume');
  });
}

test('no format needs DOMParser (3MF and COLLADA have their own XML reader)', () => {
  assert.equal(typeof globalThis.DOMParser, 'undefined', 'these tests run without a DOM');
  for (const ext of MESH_EXTENSIONS) assert.equal(needsDomParser(`model${ext}`), false, ext);
});

// ----------------------------------------------------------------------------- units

test('a user-selected unit scales the raw coordinates', async () => {
  const mm = await analyzeFixture('box.stl');
  const inch = await analyzeFixture('box.stl', { unit: 'in' });
  assert.equal(inch.source_unit, 'in');
  approx(inch.summary.volume, mm.summary.volume * 25.4 ** 3, REL, 0, 'volume in inches');
  approx(inch.summary.area, mm.summary.area * 25.4 ** 2, REL, 0, 'area in inches');
  const glbMm = await analyzeFixture('two_objects.glb', { unit: 'mm' });
  assert.equal(glbMm.source_unit, 'mm');
  approx(glbMm.summary.volume, expected['two_objects.glb'].summary.volume / 1e9, REL, 0, 'glb read as mm');
});

test('unknown units are rejected like the Python engine', async () => {
  await assert.rejects(loadMeshFile(fixtureBytes('box.stl'), 'box.stl', { unit: 'parsec' }), /Unknown unit 'parsec'/);
});

test('unit names declared by files', () => {
  assert.deepEqual(unitFromName('millimeter'), { name: 'mm', factor: 1 });
  assert.deepEqual(unitFromName('Inch'), { name: 'in', factor: 25.4 });
  assert.deepEqual(unitFromName('meters'), { name: 'm', factor: 1000 });
  assert.deepEqual(unitFromName('micron'), { name: 'micron', factor: 1e-3 });
  assert.equal(unitFromName('furlong'), null);
  assert.deepEqual(UNITS, { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 });
});

// ----------------------------------------------------------------------------- loader edge cases

const ascii = (text) => new TextEncoder().encode(text);

test('unsupported extensions and files without triangles are rejected', async () => {
  await assert.rejects(loadMeshFile(ascii('x'), 'model.xyz'), /Unsupported mesh file type '\.xyz'/);
  const cloud = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n';
  await assert.rejects(loadMeshFile(ascii(cloud), 'cloud.ply'), /The file does not contain any triangle geometry/);
});

test('OFF polygons are triangulated like trimesh', async () => {
  // A unit cube written with quads: 6 quads -> 12 triangles, volume 1.
  const off = `OFF
# cube made of quads
8 6 0
0 0 0
1 0 0
1 1 0
0 1 0
0 0 1
1 0 1
1 1 1
0 1 1
4 0 3 2 1
4 4 5 6 7
4 0 1 5 4
4 1 2 6 5
4 2 3 7 6
4 3 0 4 7
`;
  const { parts, source_unit } = await loadMeshFile(ascii(off), 'cube.off');
  assert.equal(source_unit, 'mm');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'cube');
  const [body] = analyzeMeshParts(parts);
  assert.equal(body.triangles, 12);
  assert.equal(body.closed, true);
  assert.deepEqual(body.notes, []);
  approx(body.volume, 1, 1e-12, 0, 'volume');
  approxVec(body.centroid, [0.5, 0.5, 0.5], 1e-12, 1e-12, 'centroid');
});

test('ASCII STL with several solids gives one body per solid', async () => {
  const facet = (a, b, c) => `facet normal 0 0 0\nouter loop\nvertex ${a}\nvertex ${b}\nvertex ${c}\nendloop\nendfacet\n`;
  const tet = (o) => {
    const p = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => v.map((x, i) => x + o[i]).join(' '));
    return facet(p[0], p[2], p[1]) + facet(p[0], p[1], p[3]) + facet(p[1], p[2], p[3]) + facet(p[0], p[3], p[2]);
  };
  const stl = `solid first\n${tet([0, 0, 0])}endsolid first\nsolid second\n${tet([5, 0, 0])}endsolid second\n`;
  const { parts } = await loadMeshFile(ascii(stl), 'pair.stl');
  assert.deepEqual(parts.map((p) => p.name), ['first', 'second']);
  const s = summarize(analyzeMeshParts(parts));
  approx(s.volume, 2 / 6, 1e-6, 0, 'two tetrahedra');
  assert.equal(s.solids, 2);
});

test('OBJ objects are grouped per material like trimesh, named like Python uploads', async () => {
  const quadBox = (o) => {
    const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    return v.map((p) => `v ${p.map((x, i) => x + o[i]).join(' ')}`).join('\n');
  };
  const faces = (base) =>
    [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]
      .map((f) => `f ${f.map((i) => i + base).join(' ')}`)
      .join('\n');
  // Two objects without materials: a single body named after the file (trimesh merges them).
  const obj = `o a\n${quadBox([0, 0, 0])}\n${faces(0)}\no b\n${quadBox([3, 0, 0])}\n${faces(8)}\n`;
  const one = await loadMeshFile(ascii(obj), 'blocks.obj');
  assert.deepEqual(one.parts.map((p) => p.name), ['blocks']);
  const [body] = analyzeMeshParts(one.parts);
  approx(body.volume, 2, 1e-9, 0, 'merged volume');
  assert.equal(body.triangles, 24);
  // Two materials: one body per material. Without the material library (never available
  // for an uploaded file, nor to the Python server) trimesh names the groups after the file,
  // the last group first: 'blue' is "blocks.obj" and 'red' "blocks.obj_1".
  const withMtl = `${quadBox([0, 0, 0])}\n${quadBox([3, 0, 0])}\nusemtl red\n${faces(0)}\nusemtl blue\n${faces(8)}\n`;
  const two = await loadMeshFile(ascii(withMtl), 'blocks.obj');
  assert.deepEqual(two.parts.map((p) => p.name), ['blocks.obj', 'blocks.obj_1']);
  assert.equal(two.parts[0].positions[0], 3, "'blue' holds the second box");
  for (const b of analyzeMeshParts(two.parts)) approx(b.volume, 1, 1e-9, 0, b.name);
});

/** An embedded .gltf: unit cube scaled x2 and translated by its node, with a material colour. */
function bracketGltf(extra = {}) {
  const v = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) v.push(x, y, z);
  const f = [1, 3, 0, 4, 1, 0, 0, 3, 2, 2, 4, 0, 1, 7, 3, 5, 1, 4, 5, 7, 1, 3, 7, 2, 6, 4, 2, 2, 7, 6, 6, 5, 4, 7, 5, 6];
  const bytes = Buffer.concat([Buffer.from(new Float32Array(v).buffer), Buffer.from(new Uint16Array(f).buffer)]);
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Bracket', mesh: 0, translation: [1, 2, 3], scale: [2, 2, 2] }],
    meshes: [{ name: 'CubeMesh', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 1] } }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }, { buffer: 0, byteOffset: 96, byteLength: 72 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    ...extra,
  });
}

test('embedded glTF: node transform, metres, node name and material colour', async () => {
  // Python engine on the same file: source_unit m, body 'Bracket', volume 8e9,
  // bbox.min [0, 1000, 2000], centroid [1000, 2000, 3000].
  const { parts, source_unit } = await loadMeshFile(ascii(bracketGltf()), 'bracket.gltf');
  assert.equal(source_unit, 'm');
  const [body] = analyzeMeshParts(parts);
  assert.equal(body.name, 'Bracket');
  approx(body.volume, 8e9, 1e-9, 0, 'volume');
  approxVec(body.bbox.min, [0, 1000, 2000], 1e-9, 0, 'bbox.min');
  approxVec(body.centroid, [1000, 2000, 3000], 1e-9, 0, 'centroid');
  // baseColorFactor is linear: the body colour is its sRGB encoding (the viewer expects sRGB).
  approxVec(body.color, [0.7353569830524495, 0.5370987304831942, 1], 0, 1e-4, 'sRGB colour');
});

test('glTF files that need other files or decoders fail clearly', async () => {
  const external = bracketGltf({ buffers: [{ byteLength: 168, uri: 'bracket.bin' }] });
  await assert.rejects(loadMeshFile(ascii(external), 'bracket.gltf'), /separate file \('bracket\.bin'\)/);
  const draco = bracketGltf({ extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] });
  await assert.rejects(loadMeshFile(ascii(draco), 'bracket.gltf'), /Compressed glTF geometry/);
});

// ----------------------------------------------------------------------------- analysis

// trimesh.creation.box((10, 20, 30)): the reference results below were produced by
// reader3d.mesh._mesh_body on the same vertices and faces.
const BOX_V = [
  [-5, -10, -15], [-5, -10, 15], [-5, 10, -15], [-5, 10, 15],
  [5, -10, -15], [5, -10, 15], [5, 10, -15], [5, 10, 15],
];
const BOX_F = [
  [1, 3, 0], [4, 1, 0], [0, 3, 2], [2, 4, 0], [1, 7, 3], [5, 1, 4],
  [5, 7, 1], [3, 7, 2], [6, 4, 2], [2, 7, 6], [6, 5, 4], [7, 5, 6],
];
const flip = (faces, which) => faces.map((f, i) => (which.includes(i) ? [f[2], f[1], f[0]] : f));
const without = (faces, which) => faces.filter((_, i) => !which.includes(i));
const mesh = (v, f) => analyzeMesh('m', Float32Array.from(v.flat()), Uint32Array.from(f.flat()));

const PYTHON_CASES = [
  {
    label: 'two faces flipped, repaired from an inverted start face',
    v: BOX_V, f: flip(BOX_F, [0, 5]),
    volume: 6000, area: 2200, closed: true,
    notes: ['Inconsistent triangle orientation was repaired', 'Normals pointed inwards; volume sign corrected'],
  },
  {
    label: 'four faces flipped',
    v: BOX_V, f: flip(BOX_F, [1, 2, 3, 7]),
    volume: 6000, area: 2200, closed: true, notes: ['Inconsistent triangle orientation was repaired'],
  },
  {
    label: 'two adjacent triangles missing (quad hole)',
    v: BOX_V, f: without(BOX_F, [0, 1]),
    volume: 6000, area: 1750, closed: false,
    notes: ['Mesh was not closed (4 open edges); volume estimated after filling the holes'],
  },
  {
    label: 'two separate triangular holes',
    v: BOX_V, f: without(BOX_F, [0, 11]),
    volume: 6000, area: 1600, closed: false,
    notes: ['Mesh was not closed (6 open edges); volume estimated after filling the holes'],
  },
  {
    label: 'non-manifold fin',
    v: [...BOX_V, [0, 0, 40]], f: [...BOX_F, [0, 1, 8]],
    volume: null, area: 2367.705098312484, closed: false,
    notes: ['Mesh is not closed (2 open edges): the enclosed volume is undefined'],
  },
  {
    label: 'duplicate, reversed duplicate and degenerate faces are ignored',
    v: [...BOX_V, [0, 0, 0]], f: [...BOX_F, BOX_F[0], BOX_F[1], [...BOX_F[3]].reverse(), [0, 1, 1], [0, 1, 0]],
    volume: 6000, area: 2200, closed: true, notes: [],
  },
];

for (const c of PYTHON_CASES) {
  test(`analysis: ${c.label}`, () => {
    const b = mesh(c.v, c.f);
    assert.equal(b.closed, c.closed, 'closed');
    assert.deepEqual(b.notes, c.notes, 'notes');
    approx(b.volume, c.volume, 1e-9, 0, 'volume');
    approx(b.area, c.area, 1e-9, 0, 'area');
    if (c.volume !== null) approxVec(b.centroid, [0, 0, 0], 0, 1e-9, 'centroid');
  });
}

test('analysis: an unwelded triangle soup gives the same result as the indexed mesh', () => {
  const soup = BOX_F.flatMap((f) => f.flatMap((i) => BOX_V[i]));
  const b = analyzeMesh('soup', Float32Array.from(soup), null);
  assert.equal(b.closed, true);
  assert.equal(b.triangles, 12);
  assert.equal(b.mesh.indices.length, 36);
  approx(b.volume, 6000, 1e-12, 0, 'volume');
});

test('analysis: vertices are welded on a 1e-8 rounding grid like trimesh merge_vertices', () => {
  // Every other triangle uses shifted copies of the vertices.
  const soup = (shift) => BOX_F.flatMap((f, k) => f.flatMap((i) => BOX_V[i].map((x) => (k % 2 ? x + shift : x))));
  const closed = (shift) => analyzeMesh('w', Float64Array.from(soup(shift)), null).closed;
  assert.equal(closed(2e-9), true, 'x*1e8 + 0.2 rounds to the same integer');
  assert.equal(closed(6e-9), false, 'x*1e8 + 0.6 rounds to the next integer');
  assert.equal(closed(1e-3), false);
});

test('analysis: a closed shell inside another one counts as a cavity (signed volumes add up)', () => {
  const inner = BOX_V.map((p) => p.map((x) => x / 2));
  const b = mesh([...BOX_V, ...inner], [...BOX_F, ...flip(BOX_F, BOX_F.map((_, i) => i)).map((f) => f.map((i) => i + 8))]);
  assert.equal(b.closed, true);
  approx(b.volume, 6000 - 750, 1e-12, 0, 'hollow volume');
  approx(b.area, 2200 * 1.25, 1e-12, 0, 'area');
});

test('analysis: non-finite vertices and out-of-range indices are dropped', () => {
  const v = [...BOX_V, [NaN, 0, 0]];
  const b = mesh(v, [...BOX_F, [0, 1, 8], [0, 1, 99]]);
  assert.equal(b.triangles, 12);
  assert.equal(b.closed, true);
  approx(b.volume, 6000, 1e-12, 0, 'volume');
  assert.ok(b.bbox.min.every(Number.isFinite));
});

// ----------------------------------------------------------------------------- reader regressions
//
// Inputs that the three.js loaders used to read differently from trimesh. Every `python`
// block was produced by reader3d (the Python engine) on exactly the bytes built here.

/** The box above as 6 outward quads. */
const BOX_Q = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];

const plyHeader = (format, nv, nf, vertexProps, faceProps) =>
  ['ply', `format ${format} 1.0`, `element vertex ${nv}`, ...vertexProps.map((p) => `property ${p}`),
    `element face ${nf}`, ...faceProps.map((p) => `property ${p}`), 'end_header', ''].join('\n');

/** Binary little-endian PLY: float xyz, faces as uchar count + int indices, then uchar r g b. */
function binaryPly(vertices, faces, faceColors) {
  const header = ascii(plyHeader('binary_little_endian', vertices.length, faces.length, ['float x', 'float y', 'float z'],
    ['list uchar int vertex_indices', 'uchar red', 'uchar green', 'uchar blue']));
  const size = 12 * vertices.length + faces.reduce((s, f) => s + 1 + 4 * f.length + 3, 0);
  const body = new DataView(new ArrayBuffer(size));
  let o = 0;
  for (const v of vertices) for (const x of v) { body.setFloat32(o, x, true); o += 4; }
  faces.forEach((f, i) => {
    body.setUint8(o++, f.length);
    for (const k of f) { body.setInt32(o, k, true); o += 4; }
    for (const c of faceColors[i]) body.setUint8(o++, c);
  });
  const out = new Uint8Array(header.length + size);
  out.set(header);
  out.set(new Uint8Array(body.buffer), header.length);
  return out;
}

const RED = [255, 0, 0], BLUE = [0, 0, 255];
const asciiPlyBox = (vertexProps, faceProps, vertexLine, faceLine, faces = BOX_F) =>
  ascii(plyHeader('ascii', 8, faces.length, vertexProps, faceProps) +
    BOX_V.map(vertexLine).join('\n') + '\n' + faces.map(faceLine).join('\n') + '\n');
const XYZ = ['float x', 'float y', 'float z'];

/** Regular pentagonal prism (radius 5, height 7): 2 pentagons + 5 quads. */
function pentaprismPly() {
  const ring = [0, 1, 2, 3, 4].map((k) => [5 * Math.cos((2 * Math.PI * k) / 5), 5 * Math.sin((2 * Math.PI * k) / 5)]);
  const v = [...ring.map(([x, y]) => [x, y, 0]), ...ring.map(([x, y]) => [x, y, 7])];
  const faces = [[4, 3, 2, 1, 0], [5, 6, 7, 8, 9], ...[0, 1, 2, 3, 4].map((k) => [k, (k + 1) % 5, 5 + ((k + 1) % 5), 5 + k])];
  return ascii(plyHeader('ascii', 10, 7, ['double x', 'double y', 'double z'], ['list uchar int vertex_indices']) +
    v.map((p) => p.map((x) => x.toPrecision(17)).join(' ')).join('\n') + '\n' + faces.map((f) => `${f.length} ${f.join(' ')}`).join('\n') + '\n');
}

/** 10 mm cube with the corner (10, 10, 10) lifted to z = 20: its 3 quads are not planar. */
function twistedQuadsPly() {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 20], [0, 10, 10]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return ascii(plyHeader('ascii', 8, 6, XYZ, ['list uchar int vertex_indices']) +
    v.map((p) => p.join(' ')).join('\n') + '\n' + q.map((f) => `4 ${f.join(' ')}`).join('\n') + '\n');
}

/** OBJ box made of quads, `size` at `offset`. */
function objQuadBox(size, offset) {
  const v = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) v.push([x * size[0] + offset[0], y * size[1] + offset[1], z * size[2] + offset[2]]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return ascii(v.map((p) => `v ${p.join(' ')}`).join('\n') + '\n' + quads.map((q) => `f ${q.map((i) => i + 1).join(' ')}`).join('\n') + '\n');
}

/** ASCII STL with two unnamed solids, the second one shifted by 20 mm. */
function unnamedSolidsStl() {
  const facet = (f, d) => `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${BOX_V[i][0] + d} ${BOX_V[i][1]} ${BOX_V[i][2]}`).join('\n')}\nendloop\nendfacet\n`;
  return ascii(`solid\n${BOX_F.map((f) => facet(f, 0)).join('')}endsolid\nsolid\n${BOX_F.map((f) => facet(f, 20)).join('')}endsolid\n`);
}

/** Binary STL whose header announces Materialise colours, all facet attributes 0. */
function colorHeaderStl() {
  const out = new Uint8Array(84 + 50 * BOX_F.length);
  const view = new DataView(out.buffer);
  out.set(ascii('COLOR='), 0);
  out.set([200, 200, 200, 255], 6);
  view.setUint32(80, BOX_F.length, true);
  BOX_F.forEach((f, i) => f.forEach((k, j) => BOX_V[k].forEach((x, a) => view.setFloat32(84 + 50 * i + 12 + 12 * j + 4 * a, x, true))));
  return out;
}

/** A 3MF package with `model` as its 3D/3dmodel.model part. */
function threeMf(model) {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  });
}
const MESH_3MF = `<mesh><vertices>${BOX_V.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${BOX_F.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
const model3mf = (resources, build) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources}</resources><build>${build}</build></model>`;
const brick3mf = (build) => threeMf(model3mf(`<object id="1" name="Brick" type="model">${MESH_3MF}</object>`, build));

/** COLLADA document with the box as geometry "geom" (`primitives`) and the visual scene `nodes`. */
function dae(primitives, nodes) {
  return ascii(`<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit meter="0.001" name="millimeter"/><up_axis>Z_UP</up_axis></asset>
<library_geometries><geometry id="geom" name="geom"><mesh>
<source id="pos"><float_array id="pos-a" count="24">${BOX_V.flat().join(' ')}</float_array><technique_common><accessor source="#pos-a" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>${primitives}
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="scene">${nodes}</visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`);
}
const daeTriangles = (faces) => `<triangles count="${faces.length}"><input semantic="VERTEX" source="#verts" offset="0"/><p>${faces.flat().join(' ')}</p></triangles>`;

const INWARDS = 'Normals pointed inwards; volume sign corrected';
// Python oriented envelopes of the two far-off boxes (float32 display vertices cannot resolve them)
const OBB_FAR = 6417.6210000006, OBB_UTM = 10.881000001140384;
const REPAIRED = 'Inconsistent triangle orientation was repaired';
const BOX = { volume: 6000, area: 2200, min: [-5, -10, -15] };
/** Python body: [name, closed, triangles, volume, notes, color]. */
const box = (name, notes = [], color = null) => [name, true, 12, 6000, notes, color];

const REGRESSIONS = [
  // PLY faces: three's PLYLoader de-indexes meshes with face colours or wedge texture
  // coordinates, drops polygons above 4 vertices and splits quads on the other diagonal.
  {
    title: 'ASCII PLY with per-face colours', file: 'facecolors.ply',
    bytes: () => asciiPlyBox(XYZ, ['list uchar int vertex_indices', 'uchar red', 'uchar green', 'uchar blue'],
      (v) => v.join(' '), (q, i) => `4 ${q.join(' ')} ${(i < 4 ? RED : BLUE).join(' ')}`, BOX_Q),
    python: { ...BOX, bodies: [box('facecolors', [], [1, 0, 0])] },
  },
  {
    title: 'binary PLY with per-face colours', file: 'facecolors_bin.ply',
    bytes: () => binaryPly(BOX_V, BOX_F, BOX_F.map((_, i) => (i < 8 ? RED : BLUE))),
    python: { ...BOX, bodies: [box('facecolors_bin', [], [1, 0, 0])] },
  },
  {
    title: 'PLY with per-face (wedge) texture coordinates: a texture visual, default grey', file: 'wedge_uv.ply',
    bytes: () => asciiPlyBox(XYZ, ['list uchar int vertex_indices', 'list uchar float texcoord'],
      (v) => v.join(' '), (f) => `3 ${f.join(' ')} 6 0 0 1 0 0 1`),
    python: { ...BOX, bodies: [box('wedge_uv', [], [0.4, 0.4, 0.4])] },
  },
  {
    title: 'PLY pentagons are fanned (closed pentagonal prism)', file: 'pentaprism.ply', bytes: pentaprismPly,
    python: {
      volume: 416.0872258791296, area: 324.6069028392598, min: [-4.045084971874737, -4.755282581475768, 0],
      bodies: [['pentaprism', true, 16, 416.0872258791296, [], null]],
    },
  },
  {
    title: 'PLY quads are split on the (0, 2) diagonal like trimesh', file: 'twisted.ply', bytes: twistedQuadsPly,
    python: { volume: 1333.3333333333333, area: 741.4213562373095, min: [0, 0, 0], bodies: [['twisted', true, 12, 1333.3333333333333, [], null]] },
  },
  {
    title: 'PLY vertex colour tie goes to the colour numpy sorts first', file: 'tie.ply',
    bytes: () => asciiPlyBox([...XYZ, 'uchar red', 'uchar green', 'uchar blue'], ['list uchar int vertex_indices'],
      (v, i) => `${v.join(' ')} ${i < 4 ? '10 10 200' : '200 10 10'}`, (f) => `3 ${f.join(' ')}`),
    python: { ...BOX, bodies: [box('tie', [], [200 / 255, 10 / 255, 10 / 255])] },
  },
  // OBJ: vertices keep trimesh's order (v order, not first use), which decides the winding repair.
  {
    title: 'OBJ with scrambled vertices and inconsistent winding', file: 'scrambled.obj',
    bytes: () => ascii(['v 10 0 10', 'v 10 10 0', 'v 0 0 0', 'v 10 0 0', 'v 10 10 10', 'v 0 0 10', 'v 0 10 10', 'v 0 10 0',
      'f 3 2 4', 'f 3 8 2', 'f 6 1 5', 'f 6 5 7', 'f 1 4 3', 'f 3 1 6', 'f 4 2 5', 'f 4 5 1', 'f 2 8 7', 'f 2 7 5', 'f 6 3 8', 'f 8 6 7'].join('\n') + '\n'),
    python: { volume: 1000, area: 600, min: [0, 0, 0], bodies: [['scrambled', true, 12, 1000, [REPAIRED, INWARDS], null]] },
  },
  // Coordinates far from the origin are read and analysed in double precision.
  {
    title: 'OBJ far from the origin keeps double precision', file: 'far.obj',
    bytes: () => objQuadBox([10.3, 20.7, 30.1], [123456.789, -98765.4321, 50000.123]),
    python: {
      volume: 6417.620999991894, area: 2292.61999999997, min: [123456.789, -98765.4321, 50000.123], obb: OBB_FAR,
      bodies: [['far', true, 12, 6417.620999991894, [INWARDS], null]],
    },
  },
  {
    title: 'OBJ in UTM-like coordinates', file: 'utm.obj',
    bytes: () => objQuadBox([1.3, 2.7, 3.1], [650000.123, 6860000.456, 100.789]),
    python: {
      volume: 10.881000001604358, area: 31.82000000217925, min: [650000.123, 6860000.456, 100.789], obb: OBB_UTM,
      bodies: [['utm', true, 12, 10.881000001604358, [INWARDS], null]],
    },
  },
  {
    title: 'OBJ group whose vertices are all NaN is dropped', file: 'nan_group.obj',
    bytes: () => ascii([...BOX_V.map((v) => `v ${v.map((x) => x + 100).join(' ')}`), ...BOX_V.map(() => 'v nan nan nan'), 'usemtl a',
      ...BOX_F.map((f) => `f ${f.map((i) => i + 1).join(' ')}`), 'usemtl b', ...BOX_F.map((f) => `f ${f.map((i) => i + 9).join(' ')}`)].join('\n') + '\n'),
    python: { volume: 6000, area: 2200, min: [95, 90, 85], bodies: [box('nan_group.obj_1')] },
  },
  {
    title: 'OFF with old-Mac (CR only) line endings', file: 'cr.off',
    bytes: () => ascii(['OFF', '8 12 0', ...BOX_V.map((v) => v.join(' ')), ...BOX_F.map((f) => `3 ${f.join(' ')}`)].join('\r') + '\r'),
    python: { ...BOX, bodies: [box('cr')] },
  },
  // STL
  {
    title: 'ASCII STL with unnamed solids', file: 'unnamed.stl', bytes: unnamedSolidsStl,
    python: { volume: 12000, area: 4400, min: [-5, -10, -15], bodies: [box('geometry_1'), box('geometry_2')] },
  },
  {
    title: 'binary STL with a COLOR= header has no colour (trimesh reads none)', file: 'colorheader.stl', bytes: colorHeaderStl,
    python: { ...BOX, bodies: [box('colorheader')] },
  },
  // 3MF: transforms are full 3x4 matrices (three's TRS decomposition loses shear).
  {
    title: '3MF item transform with shear', file: 'shear.3mf', bytes: () => brick3mf('<item objectid="1" transform="1 0 0 0.5 1 0 0 0 1 0 0 0"/>'),
    python: { volume: 6000, area: 2341.6407864998737, min: [-10, -10, -15], bodies: [box('shear')] },
  },
  {
    title: '3MF non-uniform scale after a rotation', file: 'scale_rot.3mf',
    bytes: () => {
      const c = Math.cos(0.5), s = Math.sin(0.5);
      return brick3mf(`<item objectid="1" transform="${3 * c} ${s} 0 ${-3 * s} ${c} 0 0 0 1 0 0 0"/>`);
    },
    python: {
      volume: 18000.000000000004, area: 4827.4715203699525, min: [-27.54650458648168, -11.172953311924744, -15],
      bodies: [['scale_rot', true, 12, 18000.000000000004, [], null]],
    },
  },
  {
    title: '3MF mirrored item: the triangles are reversed, no inverted-normals note', file: 'mirror.3mf',
    bytes: () => brick3mf('<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>'), python: { ...BOX, bodies: [box('mirror')] },
  },
  {
    title: '3MF transform with repeated spaces', file: 'spaces.3mf', bytes: () => brick3mf('<item objectid="1" transform="1  0 0 0 1 0 0 0 1 10 0 0"/>'),
    python: { volume: 6000, area: 2200, min: [5, -10, -15], bodies: [box('spaces')] },
  },
  {
    title: '3MF object placed by two items: named like the scene graph of trimesh', file: 'two_items.3mf',
    bytes: () => brick3mf('<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>'),
    python: { volume: 12000, area: 4400, min: [-5, -10, -15], bodies: [box('two_items'), box('Brick_1')] },
  },
  {
    title: '3MF components', file: 'components.3mf',
    bytes: () => threeMf(model3mf(`<object id="1" name="Brick" type="model">${MESH_3MF}</object><object id="2" name="Pair"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></components></object>`, '<item objectid="2"/>')),
    python: { volume: 12000, area: 4400, min: [-5, -10, -15], bodies: [box('components'), box('Brick_1')] },
  },
  {
    title: '3MF base materials give no colour (trimesh reads none)', file: 'basecolor.3mf',
    bytes: () => threeMf(model3mf(`<basematerials id="5"><base name="blue" displaycolor="#0000FF"/></basematerials><object id="1" name="Brick" type="model" pid="5" pindex="0">${MESH_3MF}</object>`, '<item objectid="1"/>')),
    python: { ...BOX, bodies: [box('basecolor')] },
  },
  // COLLADA: pycollada matrices (shear kept), mirror, one part per primitive and per instance.
  {
    title: 'COLLADA node matrix with shear', file: 'shear.dae',
    bytes: () => dae(daeTriangles(BOX_F), '<node id="n"><matrix>1 0.5 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix><instance_geometry url="#geom"/></node>'),
    python: { volume: 6000, area: 2341.6407864998737, min: [-10, -10, -15], bodies: [box('shear')] },
  },
  {
    title: 'COLLADA mirrored node', file: 'mirror.dae',
    bytes: () => dae(daeTriangles(BOX_F), '<node id="n"><scale>-1 1 1</scale><instance_geometry url="#geom"/></node>'),
    python: { ...BOX, bodies: [box('mirror')] },
  },
  {
    title: 'COLLADA geometry instanced twice', file: 'two_inst.dae',
    bytes: () => dae(daeTriangles(BOX_F), '<node id="a"><instance_geometry url="#geom"/></node><node id="b"><translate>20 0 0</translate><instance_geometry url="#geom"/></node>'),
    python: { volume: 12000, area: 4400, min: [-5, -10, -15], bodies: [box('geom'), box('geom_1')] },
  },
  {
    title: 'COLLADA geometry with two <triangles> primitives: one open body each', file: 'two_prims.dae',
    bytes: () => dae(daeTriangles(BOX_F.slice(0, 6)) + daeTriangles(BOX_F.slice(6)), '<node id="n"><instance_geometry url="#geom"/></node>'),
    python: {
      volume: null, area: 2200, min: [-5, -10, -15],
      bodies: ['geom', 'geom_1'].map((n) => [n, false, 6, null, ['Mesh is not closed (6 open edges): the enclosed volume is undefined'], null]),
    },
  },
  // glTF: node transforms composed like trimesh (negative determinant reverses the triangles).
  {
    title: 'glTF mirrored node', file: 'mirror.gltf', unit: 'm', checkColor: false,
    bytes: () => ascii(bracketGltf({ nodes: [{ name: 'Bracket', mesh: 0, scale: [-2, 2, 2] }] })),
    python: { volume: 8e9, area: 2.4e7, min: [-1000, -1000, -1000], bodies: [['Bracket', true, 12, 8e9, [], null]] },
  },
  {
    title: 'glTF node without a name is named after its index', file: 'unnamed.gltf', unit: 'm', checkColor: false,
    bytes: () => ascii(bracketGltf({ nodes: [{ mesh: 0 }] })),
    python: { volume: 1e9, area: 6e6, min: [-500, -500, -500], bodies: [['0', true, 12, 1e9, [], null]] },
  },
];

for (const c of REGRESSIONS) {
  test(`reader: ${c.title}`, async () => {
    const { parts, source_unit } = await loadMeshFile(c.bytes(), c.file);
    assert.equal(source_unit, c.unit ?? 'mm', 'source_unit');
    const bodies = analyzeMeshParts(parts);
    const s = summarize(bodies);
    const py = c.python;
    approx(s.volume, py.volume, REL, 0, 'summary.volume');
    approx(s.area, py.area, REL, 0, 'summary.area');
    const size = Math.max(...s.bbox.size);
    approxVec(s.bbox.min, py.min, REL, REL * size, 'summary.bbox.min');
    if (py.obb) {
      assert.ok(s.obb.volume <= py.obb * (1 + REL), `obb ${s.obb.volume} > python ${py.obb}`);
      assert.ok(s.obb.volume >= py.obb * (1 - 2e-3), `obb ${s.obb.volume} << python ${py.obb}`);
    }
    assert.deepEqual(bodies.map((b) => b.name).sort(), py.bodies.map((b) => b[0]).sort(), 'body names');
    for (const [name, closed, triangles, volume, notes, color] of py.bodies) {
      const b = bodies.find((x) => x.name === name);
      assert.equal(b.closed, closed, `${name}: closed`);
      assert.equal(b.triangles, triangles, `${name}: triangles`);
      approx(b.volume, volume, REL, 0, `${name}: volume`);
      assert.deepEqual(b.notes, notes, `${name}: notes`);
      if (c.checkColor !== false) approxVec(b.color, color, 0, 2e-3, `${name}: color`);
    }
  });
}

test('reader: coordinates reach the analysis in double precision', async () => {
  const { parts } = await loadMeshFile(objQuadBox([1.3, 2.7, 3.1], [650000.123, 6860000.456, 100.789]), 'utm.obj');
  assert.ok(parts[0].positions instanceof Float64Array);
  assert.equal(parts[0].positions[1], 6860000.456);
  // float32 sources without transform keep their (exact) float32 array
  const stl = await loadMeshFile(fixtureBytes('box.stl'), 'box.stl');
  assert.ok(stl.parts[0].positions instanceof Float32Array);
});

test('reader: every part owns its buffers (they are transferred to the worker)', async () => {
  const { parts } = await loadMeshFile(brick3mf('<item objectid="1"/><item objectid="1"/><item objectid="1"/>'), 'three.3mf');
  const buffers = parts.flatMap((p) => [p.positions.buffer, p.indices?.buffer].filter(Boolean));
  assert.equal(parts.length, 3);
  assert.equal(new Set(buffers).size, buffers.length, 'no shared buffer');
  for (const p of parts) assert.equal(p.positions.byteLength, p.positions.buffer.byteLength, 'whole buffer');
  structuredClone(parts, { transfer: buffers }); // throws on a duplicate or shared buffer
});

test('reader: a file whose triangles all have non-finite vertices has no geometry', async () => {
  const stl = colorHeaderStl();
  new DataView(stl.buffer).setFloat32(84 + 12, NaN, true); // first vertex of the first facet
  const one = await loadMeshFile(stl, 'one_nan.stl');
  assert.equal(analyzeMeshParts(one.parts)[0].triangles, 11);
  const all = colorHeaderStl();
  const view = new DataView(all.buffer);
  for (let f = 0; f < BOX_F.length; f++) view.setFloat32(84 + 50 * f + 12, NaN, true);
  await assert.rejects(loadMeshFile(all, 'all_nan.stl'), /The file does not contain any triangle geometry/);
});

test('analysis: a part whose faces are all dropped gives no body', () => {
  const good = { name: 'good', positions: Float64Array.from(BOX_V.flat()), indices: Uint32Array.from(BOX_F.flat()), color: null };
  const bad = { name: 'bad', positions: new Float64Array(24).fill(NaN), indices: Uint32Array.from(BOX_F.flat()), color: null };
  const bodies = analyzeMeshParts([good, bad]);
  assert.deepEqual(bodies.map((b) => b.name), ['good']);
  approxVec(summarize(bodies).bbox.min, [-5, -10, -15], 0, 0, 'envelope not pulled to the origin');
});
