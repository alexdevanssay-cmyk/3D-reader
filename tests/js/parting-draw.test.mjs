// Parting line drawn by hand (web/engine/parting-draw.js) on synthetic meshes.
//
//   node --test tests/js/parting-draw.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  alignPoints, arcDefault, arcFromCentre, arcGeometry, crossings, drawMesh, drawnParting, edgePath, layArc, layStraight, parseDrawing,
  proposeSides, regionSides, reprojectPoint, reviveDrawing, rotateAbout, segmentName, segmentPlane, serializeDrawing, splitRegions, surfacePoint,
  turnSign,
} from '../../web/engine/parting-draw.js';
import { feedingContext, feedingZones } from '../../web/engine/feeding.js';
import {
  REACH_DOWN, REACH_UP, SIDE_LOWER, SIDE_NONE, SIDE_UPPER, evaluateParting, lineMesh, lineSummary, mouldBlocks, parseDirection, parseTriple,
} from '../../web/engine/parting.js';
import { approx } from './helpers.mjs';
import { prism, revolve, voxels } from './meshes.mjs';

const Z = [0, 0, 1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A mesh with what the drawing needs of it, and its points by position. */
function body(mesh) {
  const dm = drawMesh(lineMesh(mesh.positions, mesh.indices));
  return { mesh, dm, at: (xyz) => reprojectPoint(dm, xyz) };
}

/** The points of a path, as [x, y, z]. */
function points(path) {
  const out = [];
  for (let j = 0; j < path.xyz.length; j += 3) out.push([path.xyz[j], path.xyz[j + 1], path.xyz[j + 2]]);
  return out;
}

/** A closed loop of straight segments through the points (SurfacePoints). */
const loop = (dm, pts, options = {}) => pts.map((a, k) => layStraight(dm, a, pts[(k + 1) % pts.length], { axis: Z, ...options }));

/** Barycentrics of x in triangle f of the mesh (its own corners). */
function bary({ positions: P, indices: I }, f, x) {
  const [a, b, c] = [0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1], P[3 * I[3 * f + k] + 2]]);
  const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v2 = [x[0] - a[0], x[1] - a[1], x[2] - a[2]];
  const d = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const d00 = d(v0, v0), d01 = d(v0, v1), d11 = d(v1, v1), d20 = d(v2, v0), d21 = d(v2, v1);
  const den = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}

/** Every piece in its triangle, every crossing on an edge the two triangles share. */
function assertWalked(b, path, label) {
  const { dm, mesh } = b;
  const pts = points(path);
  for (let j = 0; j < path.tri.length; j++) {
    for (const x of [pts[j], pts[j + 1]]) {
      if (path.cross[j] < 0 && path.cross[j + 1] < 0 && j > 0 && j < path.tri.length - 1) continue;
      for (const w of bary(mesh, path.tri[j], x)) assert.ok(w >= -1e-9, `${label}: piece ${j} out of its triangle (${w})`);
    }
  }
  for (let j = 1; j < pts.length - 1; j++) {
    if (path.cross[j] < 0) continue;
    const h = path.cross[j], t = path.twin[j];
    assert.equal(Math.floor(h / 3), path.tri[j - 1], `${label}: left from its triangle`);
    assert.equal(Math.floor(t / 3), path.tri[j], `${label}: into the next one`);
    assert.equal(dm.N[h], path.tri[j], `${label}: across the edge`);
    const ends = (e) => [dm.W[e], dm.W[3 * Math.floor(e / 3) + ((e % 3) + 1) % 3]].sort((x, y) => x - y);
    assert.deepEqual(ends(h), ends(t), `${label}: the same edge from both sides`);
  }
}

const sortedAreas = (split) => split.regions.map((r) => r.area).sort((x, y) => x - y);

/** Area of the triangles of a mesh where keep(f, centre). */
function areaWhere({ positions: P, indices: I }, keep) {
  let sum = 0;
  for (let f = 0; f < I.length / 3; f++) {
    const [a, b, c] = [0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1], P[3 * I[3 * f + k] + 2]]);
    const centre = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    if (!keep(f, centre)) continue;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
}

// The box of the cases: 60 × 40 × 20 mm, 8800 mm².
const boxMesh = (options = {}) => voxels(() => true, [12, 8, 4], { size: 5, ...options });
const loopAt = (z) => [[30, 0, z], [60, 20, z], [30, 40, z], [0, 20, z]];

describe('straight segments: a plane slice walked from triangle to triangle', () => {
  const box = body(boxMesh());

  test('across a face at one height: the level plane, exact, continuous', () => {
    const A = box.at([10, 0, 10.3]), B = box.at([30, 0, 10.3]);
    const path = layStraight(box.dm, A, B, { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'level']);
    approx(path.length, 20, 0, 1e-9, 'length');
    for (const p of points(path)) {
      approx(p[2], 10.3, 0, 1e-6, 'height');
      approx(p[1], 0, 0, 1e-6, 'on the front face');
    }
    assertWalked(box, path, 'front face');
  });

  test('round a corner: still level', () => {
    const path = layStraight(box.dm, box.at([50, 0, 10.3]), box.at([60, 20, 10.3]), { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'level']);
    approx(path.length, 30, 0, 1e-9, 'length');
    for (const p of points(path)) approx(p[2], 10.3, 0, 1e-6, 'height');
    assertWalked(box, path, 'corner');
  });

  test('a loop exactly through the vertices of the grid: the halves at its height (seam triangles to their real area)', () => {
    for (const perFace of [false, true]) {
      const b = body(boxMesh({ perFace }));
      const paths = loop(b.dm, loopAt(10).map(b.at));
      assert.deepEqual(paths.map((p) => p.status), ['ok', 'ok', 'ok', 'ok']);
      for (const p of paths) approx(p.length, 50, 0, 1e-6, 'segment');
      paths.forEach((p, k) => assertWalked(b, p, `segment ${k}`));
      const split = splitRegions(b.dm, [paths]);
      assert.equal(split.count, 2);
      assert.deepEqual(split.errors, []);
      const [lo, hi] = sortedAreas(split);
      approx(lo, 4400, 0, 1e-6, 'lower');
      approx(hi, 4400, 0, 1e-6, 'upper');
    }
  });

  test('a loop between the vertices: seam triangles to their larger piece', () => {
    const paths = loop(box.dm, loopAt(7).map(box.at));
    const split = splitRegions(box.dm, [paths]);
    assert.equal(split.count, 2);
    const [lo, hi] = sortedAreas(split);
    approx(lo, 3900, 0, 1e-6, 'lower');
    approx(hi, 4900, 0, 1e-6, 'upper');
    approx(split.seamArea, 1000, 0, 1e-6, 'seam');
  });

  test('front to back: the shorter way round, ⇄ the other one, the two making the slice', () => {
    const A = box.at([15, 0, 12]), B = box.at([25, 40, 12]);
    const path = layStraight(box.dm, A, B, { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'level']);
    approx(path.length, 80, 0, 1e-9, 'shorter way');
    const other = layStraight(box.dm, A, B, { axis: Z, spec: { kind: 'straight', via: -path.via, m: path.m } });
    assert.equal(other.via, -path.via);
    approx(other.length, 120, 0, 1e-9, 'other way');
    approx(path.length + other.length, 200, 0, 1e-9, 'the slice');
    for (const p of [...points(path), ...points(other)]) approx(p[2], 12, 0, 1e-9, 'height');
    // The way nearer the camera when both are within 15 %: a point at mid-height of the back face.
    const C = box.at([30, 0, 12]), D = box.at([30, 40, 12]);
    const left = layStraight(box.dm, C, D, { axis: Z, prefer: [-200, 20, 12] });
    const right = layStraight(box.dm, C, D, { axis: Z, prefer: [260, 20, 12] });
    assert.ok(points(left).some((p) => p[0] === 0) && !points(left).some((p) => p[0] === 60), 'by the left face');
    assert.ok(points(right).some((p) => p[0] === 60) && !points(right).some((p) => p[0] === 0), 'by the right face');
  });

  test('on the top face: the normal section (the level plane is tangent), the straight chord', () => {
    const b = body(boxMesh({ subdivide: 3 }));
    const path = layStraight(b.dm, b.at([3, 5, 20]), b.at([37, 31, 20]), { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'normal']);
    approx(path.length, Math.hypot(34, 26), 0, 1e-9, 'chord');
    assertWalked(b, path, 'top face');
  });

  test('a 12-facet cylinder: on the facets, and the two ways round make the slice', () => {
    const b = body(revolve([[10, 0], [10, 10]], 12, { poles: [0, 10] }));
    const A = b.at([10 * Math.cos(0.2), 10 * Math.sin(0.2), 3]), B = b.at([10 * Math.cos(2), 10 * Math.sin(2), 6]);
    const path = layStraight(b.dm, A, B, { axis: Z });
    assert.equal(path.status, 'ok');
    assert.ok(path.length > dist(A.p, B.p) && path.length < Math.PI * 10, `${path.length}`);
    const other = layStraight(b.dm, A, B, { axis: Z, spec: { kind: 'straight', via: -path.via, m: path.m } });
    for (const p of [...points(path), ...points(other)]) {
      const r = Math.hypot(p[0], p[1]);
      // Within the float32 rounding of the vertices.
      assert.ok(r >= 10 * Math.cos(Math.PI / 12) - 1e-5 && r <= 10 + 1e-5, `on a facet: ${r}`);
    }
    // The slice of the facets by the plane: one straight piece per facet, between its vertical edges (the vertices of the first ring).
    const m = path.m, o = A.p;
    const edges = Array.from({ length: 12 }, (_, k) => {
      const x = b.mesh.positions[3 * k], y = b.mesh.positions[3 * k + 1];
      return [x, y, o[2] - (m[0] * (x - o[0]) + m[1] * (y - o[1])) / m[2]];
    });
    assert.ok(edges.every((p) => p[2] > 0 && p[2] < 10));
    const perimeter = edges.reduce((s, p, k) => s + dist(p, edges[(k + 1) % 12]), 0);
    approx(path.length + other.length, perimeter, 0, 1e-9, 'the slice');
    assertWalked(b, path, 'cylinder');
  });

  test('a thin plate: on its top near the rim, the chord', () => {
    const b = body(prism([[0, 0], [100, 0], [100, 0.5], [0, 0.5]], 100, [50, 0.25]));
    const A = b.at([2, 3, 0.5]), B = b.at([97, 4, 0.5]);
    const path = layStraight(b.dm, A, B, { axis: Z });
    assert.equal(path.status, 'ok');
    approx(path.length, dist(A.p, B.p), 0, 1e-9, 'chord');
    for (const p of points(path)) approx(p[2], 0.5, 0, 1e-9, 'on the top');
  });

  test('long fan triangles: across the flat face, the chord, one piece per triangle crossed', () => {
    const b = body(prism([[12.5, 0], [17.5, 0], [17.5, 10], [30, 10], [30, 15], [0, 15], [0, 10], [12.5, 10]], 20, [15, 11]));
    const A = b.at([2, 0, 12.5]), B = b.at([28, 0, 12.5]);
    const path = layStraight(b.dm, A, B, { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'level']);
    approx(path.length, 26, 0, 1e-9, 'chord');
    assert.equal(path.tri.length, 3);
    assert.equal(new Set(path.tri).size, 3);
    assertWalked(b, path, 'fan');
  });

  test('a hole between the points: no plane goes from one to the other, along the edges of the top face', () => {
    // A plate 60 × 50 × 5 with a square hole 20 × 20 through it, centred on the chord.
    const b = body(voxels((x, y) => !(x >= 4 && x < 8 && y >= 2 && y < 6), [12, 10, 1], { size: 5 }));
    const A = b.at([10, 20, 5]), B = b.at([50, 20, 5]);
    const path = layStraight(b.dm, A, B, { axis: Z });
    assert.deepEqual([path.status, path.method], ['ok', 'edges']);
    assert.ok(path.length >= dist(A.p, B.p));
    assert.ok(path.edges.length >= 2 && path.verts.length >= 2);
    for (const p of points(path)) {
      approx(p[2], 5, 0, 1e-9, 'on the top');
      assert.ok(!(p[0] > 20 && p[0] < 40 && p[1] > 10 && p[1] < 30), `in the hole: ${p}`);
    }
    // No fallback asked: not laid.
    assert.equal(layStraight(b.dm, A, B, { axis: Z, edges: false }).status, 'failed');
    assert.equal(layStraight(b.dm, A, B, { axis: Z, quick: true }).status, 'failed');
    // A point beside the hole: two straight segments.
    const C = b.at([30, 45, 5]);
    for (const [P, Q] of [[A, C], [C, B]]) {
      const p = layStraight(b.dm, P, Q, { axis: Z });
      assert.equal(p.status, 'ok');
      assert.ok(['level', 'normal'].includes(p.method), p.method);
      approx(p.length, dist(P.p, Q.p), 0, 1e-9, 'beside the hole');
    }
  });

  test('degenerate clicks: on vertices, in one triangle, along a line of the grid or the edge of a face', () => {
    const { dm, mesh } = box;
    // Clicked exactly at vertices: barycentrics (1, 0, 0).
    const vertexOn = (xyz) => {
      for (let f = 0; f < dm.nt; f++) {
        for (let k = 0; k < 3; k++) {
          const v = mesh.indices[3 * f + k];
          if ([0, 1, 2].every((c) => mesh.positions[3 * v + c] === xyz[c])) return surfacePoint(dm, f, xyz);
        }
      }
      return null;
    };
    const A = vertexOn([10, 0, 10]), B = vertexOn([60, 20, 10]);
    assert.ok(A.b.some((x) => x > 1 - 1e-9));
    const path = layStraight(dm, A, B, { axis: Z });
    assert.equal(path.status, 'ok');
    approx(path.length, 70, 0, 1e-9, 'along the line of the grid round the corner');
    assertWalked(box, path, 'vertices');
    // Two points in one triangle: one piece.
    const f = A.t;
    const P = surfacePoint(dm, f, [0, 1, 2].reduce((s, k) => s.map((x, c) => x + (k === 0 ? 0.6 : 0.2) * mesh.positions[3 * mesh.indices[3 * f + k] + c]), [0, 0, 0]));
    const Q = surfacePoint(dm, f, [0, 1, 2].reduce((s, k) => s.map((x, c) => x + (k === 1 ? 0.6 : 0.2) * mesh.positions[3 * mesh.indices[3 * f + k] + c]), [0, 0, 0]));
    const inside = layStraight(dm, P, Q, { axis: Z });
    assert.deepEqual([inside.status, inside.tri.length, [...inside.tri]], ['ok', 1, [f]]);
    approx(inside.length, dist(P.p, Q.p), 0, 1e-12, 'one piece');
    // Along the bottom edge of the front face: every vertex on the plane, the walk does not stall.
    const edge = layStraight(dm, box.at([10, 0, 0]), box.at([30, 0, 0]), { axis: Z });
    assert.equal(edge.status, 'ok');
    approx(edge.length, 20, 0, 1e-9, 'along the edge');
    for (const p of points(edge)) assert.deepEqual([Math.abs(p[1]) < 1e-9, Math.abs(p[2]) < 1e-9], [true, true]);
  });

  test('far from the origin in float32: the same as near it', () => {
    const near = boxMesh();
    const far = { positions: Float32Array.from(near.positions, (x) => x + 1e4), indices: near.indices };
    const b = body(far);
    assert.ok(b.dm.tau > 2e-3);
    const paths = loop(b.dm, loopAt(10).map((p) => b.at(p.map((x) => x + 1e4))));
    assert.deepEqual(paths.map((p) => p.status), ['ok', 'ok', 'ok', 'ok']);
    for (const p of paths) approx(p.length, 50, 0, 1e-6, 'segment');
    const split = splitRegions(b.dm, [paths], { axis: Z });
    assert.equal(split.count, 2);
    const [lo, hi] = sortedAreas(split);
    approx(lo, 4400, 0, 1e-6, 'lower');
    approx(hi, 4400, 0, 1e-6, 'upper');
  });
});

describe('curved segments: an arc draped on the surface', () => {
  const box = body(boxMesh());

  test('the arc from its radius and the side of its centre; the centre placed', () => {
    const A = [10, 0, 10], B = [50, 0, 10];
    assert.deepEqual(arcGeometry(A, B, { radius: 19, toward: Z }), { error: 'radius_too_small', min: 20 });
    const half = arcGeometry(A, B, { radius: 20, toward: [0, 0.5, 1] });
    assert.deepEqual(half.centre, [30, 0, 10]);
    assert.deepEqual(half.toward, [0, 1 / Math.hypot(0.5, 1) * 0.5, 1 / Math.hypot(0.5, 1)]);
    approx(half.opening, Math.PI, 0, 1e-12, 'half a circle');
    const arc = arcGeometry(A, B, { radius: 25, toward: Z });
    assert.deepEqual(arc.centre, [30, 0, 25]);
    approx(arc.length, 25 * 2 * Math.asin(20 / 25), 1e-12, 0, 'length');
    // A centre off the bisector plane: brought onto it.
    const placed = arcFromCentre(A, B, [37, 3, 25], Z);
    assert.equal(placed.moved, true);
    assert.deepEqual(placed.centre, [30, 3, 25]);
    approx(placed.radius, Math.hypot(20, 3, 15), 1e-12, 0, 'radius');
    const again = arcGeometry(A, B, placed);
    for (let k = 0; k < 3; k++) approx(again.centre[k], placed.centre[k], 0, 1e-12, 'round trip');
    const back = arcFromCentre(A, B, again.centre, placed.toward);
    approx(back.radius, placed.radius, 1e-12, 0, 'radius back');
    for (let k = 0; k < 3; k++) approx(back.toward[k], placed.toward[k], 0, 1e-12, 'toward back');
    assert.equal(back.moved, false);
    // On the chord: the previous side kept; nothing usable: refused.
    assert.deepEqual(arcFromCentre(A, B, [30, 0, 10], [0, 1, 0]).toward, [0, 1, 0]);
    assert.deepEqual(arcFromCentre(A, B, [30, 0, 10]), { error: 'centre_invalid' });
    assert.deepEqual(arcFromCentre(A, B, [30, 0]), { error: 'centre_invalid' });
    assert.deepEqual(arcFromCentre(A, B, parseTriple('40 ; 10')), { error: 'centre_invalid' });
  });

  test('on the front face: bulging up it leaves the part, down it is the arc of the circle', () => {
    const A = box.at([10, 0, 10.3]), B = box.at([50, 0, 10.3]);
    const straight = layStraight(box.dm, A, B, { axis: Z });
    const spec = arcDefault(A, B, straight.m, Z, [30, 20, 10]);
    assert.equal(spec.radius, 40);
    assert.ok(spec.toward[2] < -0.99, 'bulging towards +Z');
    const up = layArc(box.dm, A, B, { radius: 25, toward: spec.toward });
    assert.deepEqual([up.status, up.error], ['failed', 'arc_off_surface']);
    const down = layArc(box.dm, A, B, { radius: 25, toward: spec.toward.map((x) => -x) });
    assert.deepEqual([down.status, down.method], ['ok', 'arc']);
    const { centre, radius } = arcGeometry(A.p, B.p, { radius: 25, toward: Z });
    const sagitta = radius * (1 - Math.cos((1.5 * Math.PI) / 180));
    for (const p of points(down)) {
      approx(p[1], 0, 0, 1e-9, 'on the front face');
      assert.ok(Math.abs(dist(p, centre) - radius) <= sagitta + 1e-9, `off the circle: ${dist(p, centre) - radius}`);
    }
    approx(Math.min(...points(down).map((p) => p[2])), 0.3, 0, 0.01, 'lowest point');
    approx(down.length, 25 * 2 * Math.asin(20 / 25), 1e-3, 0, 'length');
    assertWalked(box, down, 'arc');
    // Too small a radius: not laid.
    assert.deepEqual([layArc(box.dm, A, B, { radius: 10, toward: Z }).error], ['radius_too_small']);
  });

  test('round a corner: the sagitta met on the corner edge', () => {
    const A = box.at([40, 0, 10.3]), B = box.at([60, 20, 10.3]);
    const sagitta = 20 - Math.sqrt(400 - 200);
    const up = layArc(box.dm, A, B, { radius: 20, toward: [0, 0, -1] });
    assert.equal(up.status, 'ok');
    approx(Math.max(...points(up).map((p) => p[2])) - 10.3, sagitta, 0, 1e-2, 'up');
    const down = layArc(box.dm, A, B, { radius: 20, toward: Z });
    assert.equal(down.status, 'ok');
    approx(Math.min(...points(down).map((p) => p[2])), 10.3 - sagitta, 0, 1e-2, 'down');
    for (const p of [...points(up), ...points(down)]) assert.ok(Math.abs(p[1]) < 1e-9 || Math.abs(p[0] - 60) < 1e-9, `on the faces: ${p}`);
  });

  test('from near a corner round two of them: the drape goes round the corner first, against the chord', () => {
    // A on the back face 2 mm from the left one, B on the front face: the chord crosses the part, the line goes round by the left face.
    const A = box.at([2, 40, 10]), B = box.at([14, 0, 10]);
    const c = dist(A.p, B.p), R = 1.5 * c;
    const sagitta = R - Math.sqrt(R * R - (c * c) / 4);
    for (const toward of [[0, 0, -1], Z]) {
      const arc = layArc(box.dm, A, B, { radius: R, toward });
      assert.deepEqual([arc.status, arc.method], ['ok', 'arc']);
      for (const p of points(arc)) assert.ok(Math.abs(p[1] - 40) < 1e-9 || Math.abs(p[0]) < 1e-9 || Math.abs(p[1]) < 1e-9, `on the back, left or front face: ${p}`);
      const zs = points(arc).map((p) => p[2]);
      approx(toward[2] < 0 ? Math.max(...zs) - 10 : 10 - Math.min(...zs), sagitta, 0, 0.03, 'sagitta');
      assertWalked(box, arc, 'round two corners');
    }
  });

  test('the plane of a segment for its arc: level round the part, the normal section on a face square to the axis', () => {
    const b = body(boxMesh({ subdivide: 3 }));
    const wall = segmentPlane(b.dm, b.at([10, 0, 10.3]), b.at([30, 0, 10.3]), Z);
    approx(Math.abs(wall[2]), 1, 0, 1e-12, 'level');
    const A = b.at([3, 5, 20]), B = b.at([37, 31, 20]);
    const top = segmentPlane(b.dm, A, B, Z);
    approx(top[2], 0, 0, 1e-12, 'normal section');
    approx(top[0] * 34 + top[1] * 26, 0, 0, 1e-9, 'through the chord');
    // Its default arc lies in the top face: a rounded corner seen in plan, bulging away from the centre of the body.
    const spec = arcDefault(A, B, top, Z, [30, 20, 10]);
    approx(spec.toward[2], 0, 0, 1e-12, 'in the face');
    const arc = layArc(b.dm, A, B, spec);
    assert.equal(arc.status, 'ok');
    for (const p of points(arc)) assert.equal(p[2], 20);
    // The centre on the side of the middle of the body, the arc bulging the other way.
    assert.ok(10 * spec.toward[0] + 2 * spec.toward[1] > 0, 'towards the centre of the body');
    const apex = points(arc).reduce((best, p) => (dist(p, [30, 20, 20]) > dist(best, [30, 20, 20]) ? p : best));
    assert.ok(dist(apex, [30, 20, 20]) > dist([20, 18, 20], [30, 20, 20]), 'bulging away from it');
    assert.equal(segmentPlane(b.dm, A, A, Z), null);
  });

  test('inside one large triangle: a polygon of the arc, not its chord', () => {
    const b = body(prism([[12.5, 0], [17.5, 0], [17.5, 10], [30, 10], [30, 15], [0, 15], [0, 10], [12.5, 10]], 20, [15, 11]));
    const A = b.at([10, 0, 14]), B = b.at([20, 0, 14]);
    assert.equal(A.t, B.t);
    const arc = layArc(b.dm, A, B, { radius: 8, toward: Z });
    assert.equal(arc.status, 'ok');
    const K = Math.ceil((2 * Math.asin(5 / 8)) / ((3 * Math.PI) / 180));
    assert.equal(arc.tri.length, K);
    assert.ok(arc.tri.every((f) => f === A.t));
    const { centre } = arcGeometry(A.p, B.p, { radius: 8, toward: Z });
    for (const p of points(arc)) approx(dist(p, centre), 8, 0, 1e-9, 'on the circle');
    assert.ok(arc.length > 10.5);
  });
});

describe('halves: regions between the loops, given to the chapes by part', () => {
  test('a torus: the outer equator does not separate it, with the inner one it does', () => {
    const tube = Array.from({ length: 16 }, (_, k) => (2 * Math.PI * (k + 0.5)) / 16);
    const b = body(revolve(tube.map((t) => [30 + 10 * Math.cos(t), 10 * Math.sin(t)]), 48, { loop: true }));
    const ring = (r, phases) => phases.map((t) => b.at([r * Math.cos(t), r * Math.sin(t), 0]));
    const outer = loop(b.dm, ring(40, [0.1, 2.2, 4.3]));
    const inner = loop(b.dm, ring(20, [0.3, 2.4, 4.5]));
    assert.ok([...outer, ...inner].every((p) => p.status === 'ok'));
    const alone = splitRegions(b.dm, [outer]);
    assert.equal(alone.count, 1);
    assert.deepEqual(alone.errors.map((e) => e.code), ['not_separating']);
    const both = splitRegions(b.dm, [outer, inner]);
    assert.equal(both.count, 2);
    assert.deepEqual(both.errors, []);
  });

  test('a block with a hole: a loop in the hole too; along the edges, no leak', () => {
    const b = body(voxels((x, y) => !(x >= 5 && x < 7 && y >= 3 && y < 5), [12, 8, 4], { size: 5 }));
    const outerPts = loopAt(12.5).map(b.at);
    const holePts = [[25, 20, 12.5], [30, 15, 12.5], [35, 20, 12.5], [30, 25, 12.5]].map(b.at);
    const outer = loop(b.dm, outerPts), hole = loop(b.dm, holePts);
    assert.ok([...outer, ...hole].every((p) => p.status === 'ok'));
    assert.deepEqual(splitRegions(b.dm, [outer]).errors.map((e) => e.code), ['not_separating']);
    const both = splitRegions(b.dm, [outer, hole]);
    assert.equal(both.count, 2);
    // A segment of each loop along the edges, then all of them: still two parts.
    const edged = (pts, paths, all) => paths.map((p, k) => (all || k === 0 ? edgePath(b.dm, pts[k], pts[(k + 1) % pts.length]) : p));
    for (const all of [false, true]) {
      const loops = [edged(outerPts, outer, all), edged(holePts, hole, all)];
      assert.ok(loops.flat().every((p) => p && p.status === 'ok'));
      const split = splitRegions(b.dm, loops);
      assert.equal(split.count, 2, all ? 'all along the edges' : 'one segment along the edges');
      assert.deepEqual(split.errors, []);
    }
  });

  test('a tunnel no chape can form joins the two skins: left out as a core', () => {
    // A block with a square tunnel along X at mid-height; the line passes under its end x = 60 and over its end x = 0.
    const mesh = voxels((x, y, z) => !(y >= 3 && y < 5 && z >= 1 && z < 3), [12, 8, 4], { size: 5 });
    const b = body(mesh);
    const { flags } = evaluateParting(mesh.positions, mesh.indices, Z);
    const pts = [[60, 10, 3], [60, 30, 3], [0, 30, 17], [0, 10, 17]].map(b.at);
    const paths = loop(b.dm, pts);
    assert.ok(paths.every((p) => p.status === 'ok'), paths.map((p) => p.status).join());
    assert.deepEqual(splitRegions(b.dm, [paths], { flags }).errors.map((e) => e.code), ['not_separating']);
    const cored = splitRegions(b.dm, [paths], { flags, excludeCore: true });
    assert.deepEqual([cored.count, cored.errors, cored.coreExcluded], [2, [], true]);
    const result = drawnParting(b.dm, { loops: [{ points: pts, segs: [], paths, closed: true }], seeds: [], swap: false }, { axis: Z, flags, height: 20 });
    assert.equal(result.ok, true, JSON.stringify(result.messages));
    assert.equal(result.figures.core_excluded, true);
    assert.ok(result.messages.some((m) => m.code === 'core_excluded'));
    const inTunnel = (c) => c[0] > 0 && c[0] < 60 && c[1] >= 15 && c[1] <= 25 && c[2] >= 5 && c[2] <= 15;
    let tunnel = 0;
    areaWhere(mesh, (f, c) => {
      if (inTunnel(c)) {
        tunnel++;
        assert.equal(result.side[f], SIDE_NONE);
        assert.ok(!(flags[f] & (REACH_UP | REACH_DOWN)));
      }
      return false;
    });
    assert.ok(tunnel > 0);
    approx(result.figures.undercut_area_mm2, areaWhere(mesh, (f, c) => inTunnel(c)), 0, 0.1, 'the tunnel is the undercut');
  });

  test('a figure of eight: the crossing named, three parts', () => {
    const box = body(boxMesh());
    const pts = [[8, 8, 20], [52, 33, 20], [52, 8, 20], [8, 33, 20]].map(box.at);
    const paths = loop(box.dm, pts);
    assert.ok(paths.every((p) => p.status === 'ok'));
    assert.deepEqual(crossings(box.dm, [paths]), [{ a: '1-2', b: '3-4' }]);
    assert.equal(splitRegions(box.dm, [paths]).count, 3);
    // A simple loop: none (its segments meet at their common points only).
    assert.deepEqual(crossings(box.dm, [loop(box.dm, loopAt(10.3).map(box.at))]), []);
  });

  test('the chapes proposed by what each can form, chosen by part, swapped', () => {
    const mesh = boxMesh();
    const box = body(mesh);
    const { flags } = evaluateParting(mesh.positions, mesh.indices, Z);
    const pts = loopAt(10).map(box.at);
    const paths = loop(box.dm, pts);
    const split = splitRegions(box.dm, [paths], { flags, axis: Z });
    const proposal = proposeSides(split, {});
    const topTriangle = box.at([30, 20, 20]).t;
    assert.equal(proposal[split.label[topTriangle]], SIDE_UPPER);
    const drawing = { loops: [{ points: pts, segs: [], paths, closed: true }], seeds: [], swap: false };
    const proposed = drawnParting(box.dm, drawing, { axis: Z, flags, height: 20 });
    assert.equal(proposed.figures.undercut_area_mm2, 0);
    assert.deepEqual([proposed.figures.parts, proposed.figures.upper_parts, proposed.figures.lower_parts], [2, 1, 1]);
    // Swapped: each half given the faces it cannot form (the top and the bottom).
    const swapped = drawnParting(box.dm, { ...drawing, swap: true }, { axis: Z, flags, height: 20 });
    approx(swapped.figures.undercut_area_mm2, areaWhere(mesh, (f) => (swapped.side[f] === SIDE_UPPER ? !(flags[f] & REACH_UP) : !(flags[f] & REACH_DOWN))), 0, 0.1, 'swapped');
    approx(swapped.figures.undercut_area_mm2, 4800, 0, 0.1, 'top and bottom');
    // One part chosen: the other takes the other chape.
    const seeded = drawnParting(box.dm, { ...drawing, seeds: [{ p: [30, 20, 20], t: topTriangle, side: SIDE_LOWER }] }, { axis: Z, flags, height: 20 });
    assert.equal(seeded.side[topTriangle], SIDE_LOWER);
    assert.equal(seeded.side[box.at([30, 20, 0]).t], SIDE_UPPER);
    assert.deepEqual(regionSides(split, proposal, [{ t: topTriangle, side: SIDE_LOWER }], true), regionSides(split, proposal, [{ t: topTriangle, side: SIDE_LOWER }], false));
    // Three parts: by what each can form, a tie by height against the line.
    const low = loop(box.dm, loopAt(5).map(box.at)), high = loop(box.dm, loopAt(12.5).map(box.at));
    const three = splitRegions(box.dm, [low, high], { flags, axis: Z });
    assert.equal(three.count, 3);
    const lineHeight = (5 * 200 + 12.5 * 200) / 400;
    const sides = proposeSides(three, { lineHeight });
    const of = (xyz) => sides[three.label[box.at(xyz).t]];
    assert.equal(of([30, 20, 20]), SIDE_UPPER);
    assert.equal(of([30, 20, 0]), SIDE_LOWER);
    const band = three.regions[three.label[box.at([30, 0, 9]).t]];
    assert.deepEqual([band.noUp, band.noDown], [0, 0]);
    assert.notEqual(band.height, lineHeight);
    assert.equal(of([30, 0, 9]), band.height >= lineHeight ? SIDE_UPPER : SIDE_LOWER);
  });

  test('a slot in a side: its faces, formed by neither chape, are the undercut, the loop under or over it', () => {
    // A block 60 × 40 × 40 with a slot 40 wide, 20 deep and 10 high in its front face (the e2e slot).
    const mesh = voxels((x, y, z) => !(x >= 2 && x < 10 && y < 4 && z >= 3 && z < 5), [12, 8, 8], { size: 5 });
    const b = body(mesh);
    const { flags } = evaluateParting(mesh.positions, mesh.indices, Z);
    const inSlot = (c) => c[0] >= 10 && c[0] <= 50 && c[1] > 0 && c[1] <= 20 && c[2] >= 15 && c[2] <= 25;
    const slot = areaWhere(mesh, (f, c) => inSlot(c));
    approx(slot, 2400, 0, 1e-6, 'faces of the slot');
    const ceiling = b.at([30, 10, 25]).t;
    for (const [z, chape] of [[7.5, SIDE_UPPER], [32.5, SIDE_LOWER]]) {
      const pts = loopAt(z).map(b.at);
      const result = drawnParting(b.dm, { loops: [{ points: pts, segs: [], closed: true }], seeds: [], swap: false }, { axis: Z, flags, height: 40 });
      assert.equal(result.ok, true);
      assert.equal(result.side[ceiling], chape);
      assert.equal(result.undercut[ceiling], 1);
      approx(result.figures.undercut_area_mm2, slot, 0, 0.1, `undercut, the loop at ${z}`);
    }
  });
});

describe('the drawn parting line', () => {
  const mesh = boxMesh();
  const box = body(mesh);
  const pts = loopAt(10.3).map(box.at);
  const drawing = { loops: [{ points: pts, segs: pts.map(() => ({ kind: 'straight', via: 1, m: null })), closed: true }], seeds: [], swap: false };

  test('a level loop: a planar line, chained end to end, one loop for the feeding, flat mould halves', () => {
    const { flags } = evaluateParting(mesh.positions, mesh.indices, Z);
    const result = drawnParting(box.dm, drawing, { axis: Z, flags, height: 20 });
    assert.equal(result.ok, true);
    const summary = lineSummary(result.shape);
    assert.deepEqual([summary.planar, summary.kind, summary.level_mm, summary.loops, summary.length_mm], [true, 'planar', 10.3, 1, 200]);
    const s = result.segments;
    const m = s.length / 6;
    assert.ok(m > 4);
    for (let k = 0; k < m; k++) {
      const next = (k + 1) % m;
      assert.deepEqual([s[6 * k + 3], s[6 * k + 4], s[6 * k + 5]], [s[6 * next], s[6 * next + 1], s[6 * next + 2]], `piece ${k}`);
    }
    assert.equal(result.inactive.length, 0);
    const ctx = feedingContext(mesh.positions, mesh.indices, feedingZones(mesh.positions, mesh.indices), { parting: { direction: Z, side: result.side, segments: s } });
    assert.equal(new Set(ctx.loops).size, 1);
    const blocks = mouldBlocks(mesh.positions, Z, { segments: s, level: result.shape.level });
    for (const h of blocks.heights) approx(h, 10.3, 0, 1e-9, 'flat interface');
    assert.deepEqual(result.messages, []);
  });

  test('an arc not given its radius or side yet: the default one, 60° bulging up in the vertical plane of its segment', () => {
    const segs = [{ kind: 'arc' }, ...drawing.loops[0].segs.slice(1)];
    const result = drawnParting(box.dm, { ...drawing, loops: [{ ...drawing.loops[0], segs }] }, { axis: Z, height: 20, bodyCentre: [30, 20, 10] });
    assert.equal(result.ok, true, JSON.stringify(result.messages));
    const arc = result.paths[0][0];
    assert.deepEqual([arc.status, arc.method], ['ok', 'arc']);
    const sagitta = Math.hypot(30, 20) * (1 - Math.cos(Math.PI / 6));
    approx(Math.max(...points(arc).map((p) => p[2])) - 10.3, sagitta, 0, 0.03, 'bulging up');
    // Draped round the corner on the two faces: longer than the straight line round it.
    assert.ok(arc.length > 50, `${arc.length}`);
    assert.equal(result.shape.planar, false);
  });

  test('both parts in one chape: the loop is no parting line there', () => {
    const t = (xyz) => box.at(xyz).t;
    const result = drawnParting(box.dm, { ...drawing, seeds: [{ t: t([30, 20, 20]), side: SIDE_UPPER }, { t: t([30, 20, 0]), side: SIDE_UPPER }] }, { axis: Z });
    assert.equal(result.ok, true);
    assert.equal(result.segments.length, 0);
    assert.ok(result.inactive.length > 0);
    assert.equal(result.shape.length_mm, 0);
    assert.deepEqual(result.messages.map((m) => [m.code, m.n]), [['same_side', 1]]);
  });

  test('deterministic', () => {
    const { flags } = evaluateParting(mesh.positions, mesh.indices, Z);
    const first = drawnParting(box.dm, drawing, { axis: Z, flags, height: 20 });
    const fresh = body(boxMesh());
    const second = drawnParting(fresh.dm, { ...drawing, loops: [{ ...drawing.loops[0], points: loopAt(10.3).map(fresh.at) }] }, { axis: Z, flags, height: 20 });
    for (const key of ['side', 'undercut', 'segments', 'inactive']) assert.deepEqual(second[key], first[key], key);
    assert.deepEqual(second.split.label, first.split.label);
    assert.deepEqual(second.figures, first.figures);
    first.paths[0].forEach((p, k) => assert.deepEqual(second.paths[0][k].xyz, p.xyz));
  });

  test('a loop and its open or failed segments: not applied', () => {
    const open = drawnParting(box.dm, { loops: [{ points: pts, segs: [], closed: false }], seeds: [] }, { axis: Z });
    assert.equal(open.ok, false);
    assert.deepEqual(open.messages.map((m) => m.code), ['open']);
    const arcs = { loops: [{ points: pts, segs: [{ kind: 'arc', radius: 1, toward: Z }, ...pts.slice(1).map(() => ({ kind: 'straight', via: 1, m: null }))], closed: true }], seeds: [] };
    const failed = drawnParting(box.dm, arcs, { axis: Z });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.messages.map((m) => [m.code, m.seg, m.hint]), [['radius_too_small', '1-2', 'parting.draw.radiusSmall']]);
  });

  test('points aligned to one height: exactly at it, the line planar there', () => {
    const raw = [[20, 0, 9.6], [60, 15, 10.4], [40, 40, 9.8], [10, 40, 10.2], [0, 20, 10]].map(box.at);
    const { points: aligned, missed } = alignPoints(box.dm, raw, Z, 10);
    assert.deepEqual(missed, []);
    aligned.forEach((p, i) => {
      approx(p.p[2], 10, 0, 1e-9, `point ${i + 1}`);
      assert.ok(dist(p.p, raw[i].p) <= 0.4 + 1e-9);
    });
    const result = drawnParting(box.dm, { loops: [{ points: aligned, segs: [], closed: true }], seeds: [] }, { axis: Z, height: 20 });
    assert.equal(result.ok, true);
    for (let i = 2; i < result.segments.length; i += 3) assert.equal(result.segments[i], 10);
    assert.deepEqual([result.shape.planar, result.shape.level], [true, 10]);
    // No surface at that height near a point: left where it is.
    const { missed: far } = alignPoints(box.dm, [box.at([30, 20, 20])], Z, 5);
    assert.deepEqual(far, [0]);
  });
});

describe('helpers', () => {
  test('turns about an axis: four quarter turns come back', () => {
    let p = [3, -7, 2];
    const centre = [1, 2, 3], axis = [0.3, -0.4, 0.866];
    for (let k = 0; k < 4; k++) p = rotateAbout(p, centre, axis, Math.PI / 2);
    for (let k = 0; k < 3; k++) approx(p[k], [3, -7, 2][k], 0, 1e-12, 'back');
    const q = rotateAbout([0, -5, 0], [0, 0, 0], Z, -Math.PI / 2);
    approx(q[0], -5, 0, 1e-12, 'x');
    approx(q[1], 0, 0, 1e-12, 'y');
  });

  test('the sense of the arrows', () => {
    const front = { up: [0, 0, 1], toViewer: [0, -1, 0], right: [1, 0, 0] };
    // Axis upright: the left arrow turns the part by -step, its front point (0, -r) going to (-r, 0), on the left of the screen.
    const s = turnSign(Z, front);
    assert.equal(s, -1);
    const moved = rotateAbout([0, -10, 0], [0, 0, 0], Z, (s * Math.PI) / 2);
    approx(moved[0], -10, 0, 1e-12, 'to the left');
    // Seen from above, Z towards the viewer: counter-clockwise on screen.
    assert.equal(turnSign(Z, { up: [0, 1, 0], toViewer: [0, 0, 1], right: [1, 0, 0] }), 1);
    // Front view, axis X: by the right of the screen.
    assert.equal(turnSign([1, 0, 0], front), 1);
    assert.equal(turnSign([0, 0, -1], front), 1);
  });

  test('three numbers typed in', () => {
    for (const text of ['40 ; 10 ; 15,9', '40, 10, 15.9', '(40, 10, 15.9)', '40;10;15,9']) assert.deepEqual(parseTriple(text), [40, 10, 15.9], text);
    assert.deepEqual(parseTriple('-1,5 0 2'), [-1.5, 0, 2]);
    for (const text of ['40 10', '', 'a b c', '1 2 3 4', 'x']) assert.equal(parseTriple(text), null, text);
    // parseDirection: the axis names and the snapping kept.
    assert.deepEqual(parseDirection('-Z'), [0, 0, -1]);
    assert.deepEqual(parseDirection('0 0 3'), [0, 0, 1]);
    assert.equal(parseDirection('0 0 0'), null);
    assert.equal(parseDirection('40 10'), null);
  });

  test('segment names numbered on from one loop to the next', () => {
    const loops = [{ points: [1, 2, 3, 4, 5, 6] }, { points: [1, 2, 3, 4] }];
    assert.equal(segmentName(loops, 0, 0), '1-2');
    assert.equal(segmentName(loops, 0, 5), '6-1');
    assert.equal(segmentName(loops, 1, 0), '7-8');
    assert.equal(segmentName(loops, 1, 3), '10-7');
    assert.equal(segmentName([6, 4], 1, 3), '10-7');
  });

  test('saved and read back; malformed drawings refused', () => {
    const box = body(boxMesh());
    const pts = loopAt(10.3).map(box.at);
    const drawing = {
      plane: 'Z', axis: Z, swap: true,
      loops: [
        { closed: true, points: pts, segs: [{ kind: 'straight', via: -1, m: [0, 0, 1] }, { kind: 'arc', radius: 25.123456, toward: [0, 0.6, -0.8] }, { kind: 'straight', via: 1, m: null, method: 'edges' }, { kind: 'straight', via: 1, m: null }] },
        { closed: false, points: pts.slice(0, 2), segs: [{ kind: 'straight', via: 1, m: null }] },
      ],
      seeds: [{ p: [30.123456, 20, 20], t: 5, side: SIDE_LOWER }],
    };
    const saved = serializeDrawing(drawing, box.dm.nt);
    const text = JSON.stringify(saved);
    assert.ok(text.length < 600, `${text.length} bytes`);
    const read = parseDrawing(text);
    assert.deepEqual(read.loops[0].segs, [
      { kind: 'straight', via: -1, m: [0, 0, 1] }, { kind: 'arc', radius: 25.1235, toward: [0, 0.6, -0.8] },
      { kind: 'straight', via: 1, m: null, method: 'edges' }, { kind: 'straight', via: 1, m: null },
    ]);
    assert.deepEqual(read.loops[0].points.map((p) => p.t), pts.map((p) => p.t));
    assert.deepEqual(read.seeds, [{ p: [30.1235, 20, 20], t: 5, side: SIDE_LOWER }]);
    assert.deepEqual([read.plane, read.axis, read.swap, read.nt, read.loops[1].closed], ['Z', Z, true, box.dm.nt, false]);
    // An arc not given its radius and side yet: saved as the straight line it still is.
    assert.deepEqual(serializeDrawing({ loops: [{ closed: false, points: pts.slice(0, 2), segs: [{ kind: 'arc', via: -1 }] }] }, 1).loops[0].segs, [['s', -1]]);
    // Revived on the same mesh: the same triangles, the points within the rounding.
    const revived = reviveDrawing(box.dm, read);
    revived.loops[0].points.forEach((p, i) => {
      assert.equal(p.t, pts[i].t);
      assert.ok(dist(p.p, pts[i].p) < 1e-4);
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const bad = (change) => {
        const copy = JSON.parse(text);
        change(copy);
        return parseDrawing(copy);
      };
      assert.equal(parseDrawing('{'), null);
      assert.equal(bad((d) => (d.v = 2)), null);
      assert.equal(bad((d) => (d.loops[0].pts[0][0] = 'x')), null);
      assert.equal(bad((d) => (d.loops[0].pts[0][3] = 1.5)), null);
      assert.equal(bad((d) => d.loops[0].segs.pop()), null);
      assert.equal(bad((d) => (d.loops[0].segs[0] = ['q'])), null);
      assert.equal(bad((d) => (d.loops = Array.from({ length: 33 }, () => ({ closed: false, pts: [], segs: [] })))), null);
      assert.equal(bad((d) => (d.loops[1].pts = Array.from({ length: 2000 }, () => [0, 0, 0, 0])) && (d.loops[1].segs = Array.from({ length: 1999 }, () => ['s', 1]))), null);
      assert.equal(bad((d) => (d.seeds[0][4] = 3)), null);
      assert.equal(bad((d) => (d.plane = 'W')), null);
      assert.equal(bad((d) => (d.axis = [0, 0, 0])), null);
      assert.ok(bad(() => {}));
    } finally {
      console.warn = warn;
    }
  });

  test('revived on another tessellation: the same line, the same parts, the same chapes', () => {
    const coarse = body(boxMesh({ subdivide: 2 })), fine = body(boxMesh({ subdivide: 3 }));
    const pts = [[30, 0, 10.3], [60, 20, 10.3], [30, 40, 10.3], [0, 20, 10.3]].map(coarse.at);
    const top = coarse.at([30, 20, 20]);
    const drawing = {
      plane: 'Z', axis: Z, swap: false,
      loops: [{ closed: true, points: pts, segs: [{ kind: 'arc', radius: 40, toward: Z }, ...pts.slice(1).map(() => ({ kind: 'straight', via: 1, m: null }))] }],
      seeds: [{ p: top.p, t: top.t, side: SIDE_LOWER }],
    };
    const before = drawnParting(coarse.dm, drawing, { axis: Z });
    assert.equal(before.ok, true);
    const read = parseDrawing(JSON.stringify(serializeDrawing(drawing, coarse.dm.nt)));
    const revived = reviveDrawing(fine.dm, read);
    assert.equal(revived.seeds[0].t, fine.at(top.p).t);
    const after = drawnParting(fine.dm, revived, { axis: Z });
    assert.equal(after.ok, true);
    approx(after.shape.length_mm, before.shape.length_mm, 0, 0.1, 'length of the line');
    const seam = Math.max(before.split.seamArea, after.split.seamArea);
    sortedAreas(after.split).forEach((a, i) => approx(a, sortedAreas(before.split)[i], 0, seam, `region ${i}`));
    assert.equal(after.side[fine.at([30, 20, 20]).t], SIDE_LOWER);
    assert.equal(after.side[fine.at([30, 20, 0]).t], SIDE_UPPER);
  });
});

describe('bounded', () => {
  test('a box of 2.5M triangles: each segment, the split and the mesh within their budgets', () => {
    const mesh = boxMesh({ subdivide: 60 });
    assert.equal(mesh.indices.length / 3, 2_534_400);
    const line = lineMesh(mesh.positions, mesh.indices);
    let t = performance.now();
    const dm = drawMesh(line);
    const build = performance.now() - t;
    const pts = [[30, 0, 10.3], [60, 20, 10.3], [45, 40, 10.3], [15, 40, 10.3], [0, 20, 10.3]].map((p) => reprojectPoint(dm, p));
    const lays = [];
    const paths = pts.map((a, k) => {
      t = performance.now();
      const p = layStraight(dm, a, pts[(k + 1) % pts.length], { axis: Z });
      lays.push(performance.now() - t);
      return p;
    });
    assert.ok(paths.every((p) => p.status === 'ok' && p.method === 'level'));
    t = performance.now();
    const split = splitRegions(dm, [paths], { axis: Z });
    const splitTime = performance.now() - t;
    console.log(`drawMesh ${build.toFixed(0)} ms; lays ${lays.map((x) => x.toFixed(1)).join(', ')} ms; split ${splitTime.toFixed(0)} ms`);
    assert.equal(split.count, 2);
    assert.ok(build < 3000, `drawMesh ${build} ms`);
    for (const l of lays) assert.ok(l < 100, `lay ${l} ms`);
    assert.ok(splitTime < 1500, `split ${splitTime} ms`);
  });
});
