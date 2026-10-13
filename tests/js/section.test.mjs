// Caps of the section view (web/section.js): which boxes the plane cuts, the
// rectangle laid in the plane over a box, the order the caps are drawn in.
//
//   node --test tests/js/section.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { capOrders, capQuad, planeCutsBox } from '../../web/section.js';
import { approx } from './helpers.mjs';

const box = { min: [0, 0, 0], max: [100, 60, 20] };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const corners = (q) => [0, 1, 2, 3].map((k) => q.slice(3 * k, 3 * k + 3));
const sub = (a, b) => a.map((x, k) => x - b[k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe('planeCutsBox', () => {
  test('a plane through the box cuts it, whichever side it keeps', () => {
    // The plane of app.js: n = -axis keeps p <= pos (constant pos), +axis keeps p >= pos (constant -pos).
    assert.equal(planeCutsBox([0, 0, -1], 10, box), true);
    assert.equal(planeCutsBox([0, 0, 1], -10, box), true);
    assert.equal(planeCutsBox([0, -1, 0], 30, box), true);
    assert.equal(planeCutsBox([1, 0, 0], -99.5, box), true);
  });

  test('a plane beside the box, or along one of its faces, does not', () => {
    assert.equal(planeCutsBox([0, 0, -1], 25, box), false); // above: all kept
    assert.equal(planeCutsBox([0, 0, -1], -5, box), false); // below: all removed
    assert.equal(planeCutsBox([0, 0, -1], 20, box), false); // on the top face
    assert.equal(planeCutsBox([1, 0, 0], 0, box), false); // on the face x = 0
    assert.equal(planeCutsBox([0, 0, -1], 1e12, box), false); // the plane of the section turned off
  });

  test('an oblique plane through a corner region', () => {
    const n = [1, 1, 1].map((x) => x / Math.sqrt(3));
    assert.equal(planeCutsBox(n, -dot(n, [1, 1, 1]), box), true);
    assert.equal(planeCutsBox(n, -dot(n, [101, 61, 21]), box), false);
  });
});

describe('capQuad', () => {
  test('in the plane, over the box seen along the normal, wound round the normal', () => {
    for (const [normal, constant] of [[[0, 0, -1], 10], [[0, 1, 0], -18.25], [[-1, 0, 0], 75.5], [[1, 2, 2].map((x) => x / 3), -40]]) {
      const q = capQuad(normal, constant, box);
      assert.equal(q.length, 12);
      const pts = corners(q);
      for (const p of pts) approx(dot(normal, p) + constant, 0, 0, 1e-9, `corner ${p} in the plane`);
      // Counter-clockwise seen from the side the normal points to.
      const w = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
      assert.ok(dot(w, normal) > 0, `winding of ${normal}`);
      // Every corner of the box, projected on the plane, inside the rectangle.
      const u = sub(pts[1], pts[0]), v = sub(pts[3], pts[0]);
      for (let k = 0; k < 8; k++) {
        const c = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
        const r = sub(c, pts[0]);
        const s = dot(r, u) / dot(u, u), t = dot(r, v) / dot(v, v);
        assert.ok(s > 0 && s < 1 && t > 0 && t < 1, `corner ${c} over the rectangle of ${normal}: ${s}, ${t}`);
      }
    }
  });

  test('a section along Z: the rectangle of the box, a little wider, at the height of the plane', () => {
    const pts = corners(capQuad([0, 0, -1], 10, box, 0.02));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    approx(Math.min(...xs), -2, 0, 1e-6, 'x min');
    approx(Math.max(...xs), 102, 0, 1e-6, 'x max');
    approx(Math.min(...ys), -2, 0, 1e-6, 'y min');
    approx(Math.max(...ys), 62, 0, 1e-6, 'y max');
    for (const p of pts) approx(p[2], 10, 0, 1e-9, 'z');
  });

  test('a normal of any length: the same plane; none of length 0', () => {
    const a = capQuad([0, 0, -1], 10, box);
    const b = capQuad([0, 0, -4], 40, box);
    a.forEach((x, k) => approx(b[k], x, 0, 1e-9, `coordinate ${k}`));
    assert.equal(capQuad([0, 0, 0], 1, box), null);
  });
});

describe('capOrders', () => {
  test('each solid counted, then capped, before the next one; within the range', () => {
    const orders = capOrders(5, 0.5, 0.9);
    assert.equal(orders.length, 5);
    const flat = orders.flat();
    for (let k = 1; k < flat.length; k++) assert.ok(flat[k] > flat[k - 1], `order ${k}`);
    assert.ok(flat[0] >= 0.5 && flat.at(-1) < 0.9);
    assert.deepEqual(capOrders(0), []);
  });
});
