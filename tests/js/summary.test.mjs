// Totals and envelopes (web/engine/summary.js), and the scale of the mesh engine.
//
//   node --test tests/js/summary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeMesh, analyzeMeshParts } from '../../web/engine/meshanalysis.js';
import { minVolumeBox, summarize } from '../../web/engine/summary.js';
import { approx, approxVec } from './helpers.mjs';

// ----------------------------------------------------------------------------- helpers

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotation matrix (rows) from Euler angles. */
function rotation(ax, ay, az) {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]];
  const ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]];
  const rz = [[cc, -sc, 0], [sc, cc, 0], [0, 0, 1]];
  const mul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  return mul(rz, mul(ry, rx));
}
const apply = (m, p, t = [0, 0, 0]) => m.map((r, i) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + t[i]);

const BOX_F = [
  [1, 3, 0], [4, 1, 0], [0, 3, 2], [2, 4, 0], [1, 7, 3], [5, 1, 4],
  [5, 7, 1], [3, 7, 2], [6, 4, 2], [2, 7, 6], [6, 5, 4], [7, 5, 6],
];
function boxVertices([a, b, c]) {
  const v = [];
  for (const x of [-a / 2, a / 2]) for (const y of [-b / 2, b / 2]) for (const z of [-c / 2, c / 2]) v.push([x, y, z]);
  return v;
}

/** A body (result contract) made of a closed box, rotated and translated. */
function boxBody(dims, rot, offset, name = 'box') {
  const v = boxVertices(dims).map((p) => apply(rot, p, offset));
  return analyzeMesh(name, Float32Array.from(v.flat()), Uint32Array.from(BOX_F.flat()));
}

/** A minimal body holding only points (the envelope only looks at the display mesh). */
function pointBody(points, extra = {}) {
  const positions = Float32Array.from(points.flat());
  const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => Math.fround(p[k]))));
  const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => Math.fround(p[k]))));
  return {
    name: 'points', volume: null, mesh_volume: null, area: 0, centroid: null, closed: false,
    bbox: { min, max, size: max.map((x, k) => x - min[k]) }, triangles: 0,
    mesh: { positions, indices: null }, ...extra,
  };
}

const sortDesc = (v) => [...v].sort((a, b) => b - a);
const prod = (v) => v[0] * v[1] * v[2];

/** Every point projects inside the box returned by minVolumeBox. */
function assertEncloses(box, points, label) {
  for (let k = 0; k < 3; k++) {
    const a = box.axes[k];
    approx(Math.hypot(...a), 1, 1e-9, 0, `${label}: axis ${k} is a unit vector`);
    for (let j = k + 1; j < 3; j++) {
      const d = a[0] * box.axes[j][0] + a[1] * box.axes[j][1] + a[2] * box.axes[j][2];
      assert.ok(Math.abs(d) < 1e-9, `${label}: axes ${k} and ${j} are orthogonal`);
    }
    const t = points.map((p) => p[0] * a[0] + p[1] * a[1] + p[2] * a[2]);
    const span = Math.max(...t) - Math.min(...t);
    assert.ok(span <= box.extents[k] * (1 + 1e-9) + 1e-12, `${label}: points outside the box along axis ${k}`);
  }
}

// ----------------------------------------------------------------------------- totals

test('totals follow model.py summarize', () => {
  const a = boxBody([10, 20, 30], rotation(0, 0, 0), [0, 0, 0], 'a');
  const b = boxBody([2, 2, 2], rotation(0, 0, 0), [20, 0, 0], 'b');
  const open = analyzeMesh('sheet', Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2, 0, 2, 3]));
  const s = summarize([a, b, open]);
  assert.equal(s.bodies, 3);
  assert.equal(s.solids, 2);
  assert.equal(s.open_bodies, 1);
  assert.equal(s.triangles, 26);
  approx(s.volume, 6008, 1e-12, 0, 'volume');
  approx(s.area, 2200 + 24 + 1, 1e-12, 0, 'area');
  approxVec(s.centroid, [(20 * 8) / 6008, 0, 0], 1e-12, 1e-12, 'volume-weighted centroid');
  approxVec(s.bbox.min, [-5, -10, -15], 0, 0, 'bbox.min');
  approxVec(s.bbox.max, [21, 10, 15], 0, 0, 'bbox.max');
  approxVec(s.bbox.size, [26, 20, 30], 0, 0, 'bbox.size');
  approx(s.bbox.volume, 26 * 20 * 30, 1e-12, 0, 'bbox.volume');
  approx(s.fill_ratio, 6008 / (26 * 20 * 30), 1e-12, 0, 'fill_ratio');
});

test('no solid: volume, centroid and fill ratio are null', () => {
  const open = analyzeMesh('sheet', Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0]), Uint32Array.from([0, 1, 2]));
  const s = summarize([open]);
  assert.equal(s.volume, null);
  assert.equal(s.centroid, null);
  assert.equal(s.fill_ratio, null);
  assert.equal(s.solids, 0);
});

test('an empty body list is an error', () => {
  assert.throws(() => summarize([]), /No geometry found in file/);
});

// ----------------------------------------------------------------------------- oriented box

test('the oriented box of a rotated box is the box itself', () => {
  const random = rng(42);
  for (let i = 0; i < 12; i++) {
    const rot = rotation(random() * 6.3, random() * 6.3, random() * 6.3);
    // Display positions are float32: keep the box near the origin so that their rounding
    // (ulp ~1e-6 at 10 mm) stays well below the 1e-6 relative tolerance.
    const offset = [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10];
    const dims = [40, 10, 5];
    const s = summarize([boxBody(dims, rot, offset)]);
    approxVec(s.obb.size, dims, 1e-6, 0, `rotation ${i}`);
    approx(s.obb.volume, 2000, 1e-6, 0, `rotation ${i} volume`);
    assert.ok(s.obb.volume <= s.bbox.volume * (1 + 1e-12), 'never larger than the AABB');
  }
});

test('a rotated box far from the origin keeps an exact oriented box (double-precision vertices)', () => {
  // UTM-like coordinates: float32 display vertices are 0.5 mm apart there.
  const rot = rotation(0.4, 0.2, 0.9);
  const far = boxVertices([2.7, 1.3, 3.1]).map((p) => apply(rot, p, [650000.123, 6860000.456, 100.789]));
  const body = analyzeMesh('far', Float64Array.from(far.flat()), Uint32Array.from(BOX_F.flat()));
  assert.ok(body.mesh.positions instanceof Float32Array, 'the display copy stays float32');
  assert.ok(body.mesh.positions64 instanceof Float64Array, 'the analysed float64 vertices are kept');
  const s = summarize([body]);
  approxVec(s.obb.size, [3.1, 2.7, 1.3], 1e-6, 0, 'obb size');
  approx(s.obb.volume, 3.1 * 2.7 * 1.3, 1e-6, 0, 'obb volume');
  // near the origin float32 is fine and nothing extra is kept
  const near = boxVertices([2.7, 1.3, 3.1]).map((p) => apply(rot, p, [10, 20, 30]));
  assert.equal(analyzeMesh('near', Float64Array.from(near.flat()), Uint32Array.from(BOX_F.flat())).mesh.positions64, undefined);
});

test('an axis-aligned box keeps its axis-aligned envelope', () => {
  const s = summarize([boxBody([10, 20, 30], rotation(0, 0, 0), [1, 2, 3])]);
  assert.deepEqual(s.obb.size, [30, 20, 10]);
  assert.equal(s.obb.volume, 6000);
});

test('several bodies share one envelope', () => {
  const rot = rotation(0.3, 0.5, 0.7);
  const a = boxBody([10, 10, 10], rot, [0, 0, 0], 'a');
  const b = boxBody([10, 10, 10], rot, apply(rot, [30, 0, 0]), 'b');
  const s = summarize([a, b]);
  approxVec(s.obb.size, [40, 10, 10], 1e-6, 0, 'two cubes in a row');
});

test('the oriented box is never larger than the AABB on random point clouds', () => {
  const random = rng(7);
  const shapes = {
    cube: () => [random(), random(), random()],
    slab: () => [random() * 50, random() * 3, random() * 0.2],
    sphere: () => {
      const u = random() * 2 - 1, t = random() * 2 * Math.PI, r = Math.sqrt(1 - u * u);
      return [r * Math.cos(t), r * Math.sin(t), u];
    },
    gaussian: () => {
      const g = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
      return [5 * g(), 2 * g(), 0.5 * g()];
    },
  };
  for (const [shape, sample] of Object.entries(shapes)) {
    for (const n of [5, 40, 400]) {
      const rot = rotation(random() * 6, random() * 6, random() * 6);
      const points = Array.from({ length: n }, () => apply(rot, sample(), [10, -20, 30]));
      const f32 = points.map((p) => p.map(Math.fround));
      const s = summarize([pointBody(points)]);
      assert.ok(s.obb.volume <= s.bbox.volume * (1 + 1e-12), `${shape}/${n}: obb ${s.obb.volume} > aabb ${s.bbox.volume}`);
      assert.ok(s.obb.volume > 0, `${shape}/${n}: positive volume`);
      assertEncloses(minVolumeBox(Float64Array.from(f32.flat())), f32, `${shape}/${n}`);
    }
  }
});

test('large point sets are searched on a subsample but measured on every point', () => {
  const random = rng(3);
  const rot = rotation(0.2, 1.1, -0.4);
  const points = Array.from({ length: 60000 }, () => apply(rot, [random() * 30, random() * 20, random() * 10]));
  const box = minVolumeBox(Float64Array.from(points.flat()));
  assertEncloses(box, points, 'subsampled');
  // The best box of a filled 30x20x10 block is close to the block.
  assert.ok(prod(box.extents) < 6000 * 1.02, `volume ${prod(box.extents)}`);
});

// ----------------------------------------------------------------------------- degenerate inputs

test('a single triangle keeps the axis-aligned box (fewer than 4 points)', () => {
  const s = summarize([pointBody([[0, 0, 0], [3, 1, 0], [1, 2, 2]])]);
  assert.deepEqual(s.obb.size, sortDesc(s.bbox.size));
  assert.equal(s.obb.volume, s.bbox.volume);
});

test('repeated points count once', () => {
  const p = [[0, 0, 0], [3, 1, 0], [1, 2, 2]];
  const s = summarize([pointBody([...p, ...p, ...p])]);
  assert.deepEqual(s.obb.size, sortDesc(s.bbox.size));
});

test('coplanar points get a flat oriented box', () => {
  const rot = rotation(0.4, -0.3, 1.2);
  const points = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) points.push(apply(rot, [i / 2, j / 2, 0], [5, 5, 5]));
  const s = summarize([pointBody(points)]);
  approx(s.obb.size[0], 4, 1e-6, 0, 'length');
  approx(s.obb.size[1], 2, 1e-6, 0, 'width');
  assert.ok(s.obb.size[2] < 1e-5, `thickness ${s.obb.size[2]}`);
  assert.ok(s.obb.volume < 1e-4);
  assert.ok(s.bbox.volume > 1, 'the tilted plane has a real axis-aligned box');
});

test('collinear points get a segment', () => {
  const dir = [1, 2, 2].map((x) => x / 3);
  const points = [0, 1, 2.5, 4, 6].map((t) => dir.map((d) => d * t));
  const s = summarize([pointBody(points)]);
  approx(s.obb.size[0], 6, 1e-6, 0, 'length');
  assert.ok(s.obb.size[1] < 1e-5 && s.obb.size[2] < 1e-5, `${s.obb.size}`);
});

test('bodies without display mesh keep the axis-aligned box', () => {
  const body = pointBody([[0, 0, 0], [1, 2, 3]], { mesh: undefined });
  const s = summarize([body]);
  assert.deepEqual(s.obb.size, [3, 2, 1]);
});

// ----------------------------------------------------------------------------- scale

/** Closed UV sphere: 2 * nlon * (nlat - 1) triangles. */
function uvSphere(nlat, nlon, r) {
  const nv = 2 + (nlat - 1) * nlon;
  const pos = new Float32Array(3 * nv);
  pos.set([0, 0, r, 0, 0, -r]);
  for (let i = 1; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const th = (Math.PI * i) / nlat, ph = (2 * Math.PI * j) / nlon, o = 3 * (2 + (i - 1) * nlon + j);
      pos[o] = r * Math.sin(th) * Math.cos(ph);
      pos[o + 1] = r * Math.sin(th) * Math.sin(ph);
      pos[o + 2] = r * Math.cos(th);
    }
  }
  const v = (i, j) => 2 + (i - 1) * nlon + (j % nlon);
  const idx = new Uint32Array(6 * nlon * (nlat - 1));
  let k = 0;
  for (let j = 0; j < nlon; j++) idx.set([0, v(1, j), v(1, j + 1)], (k += 3) - 3);
  for (let i = 1; i < nlat - 1; i++) {
    for (let j = 0; j < nlon; j++) {
      idx.set([v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1)], k);
      k += 6;
    }
  }
  for (let j = 0; j < nlon; j++) idx.set([1, v(nlat - 1, j + 1), v(nlat - 1, j)], (k += 3) - 3);
  return { pos, idx };
}

test('a 2M-triangle closed mesh (STL-like triangle soup) is analysed in less than 10 s', () => {
  const { pos, idx } = uvSphere(1001, 1000, 50);
  // Unwelded, like a binary STL: three vertices per triangle.
  const soup = new Float32Array(3 * idx.length);
  for (let i = 0; i < idx.length; i++) soup.set(pos.subarray(3 * idx[i], 3 * idx[i] + 3), 3 * i);
  assert.equal(idx.length / 3, 2_000_000);

  const start = performance.now();
  const bodies = analyzeMeshParts([{ name: 'sphere', positions: soup, indices: null, color: null }]);
  const analysed = performance.now();
  const s = summarize(bodies);
  const elapsed = (performance.now() - start) / 1000;

  const [body] = bodies;
  assert.equal(body.closed, true);
  assert.deepEqual(body.notes, []);
  assert.equal(body.triangles, 2_000_000);
  approx(body.volume, (4 / 3) * Math.PI * 50 ** 3, 1e-4, 0, 'sphere volume');
  approxVec(body.centroid, [0, 0, 0], 0, 1e-6, 'centroid');
  assert.ok(s.obb.volume <= s.bbox.volume);
  assert.ok(
    elapsed < 10,
    `analysis ${(analysed - start).toFixed(0)} ms + summary ${(performance.now() - analysed).toFixed(0)} ms`,
  );
});
