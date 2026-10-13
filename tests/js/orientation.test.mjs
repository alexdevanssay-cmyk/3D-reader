// Orientation of a part in its die by casting process (web/engine/orientation.js):
// the minimum-area rectangle and the die block of a draw direction.
// Synthetic geometry.
//
//   node --test tests/js/orientation.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_TOOLING, dieSize } from '../../web/chiffrage/tooling.js';
import {
  DIE_DEFAULTS, convexHull, dieBlock, dieKey, minAreaRect, normalizeDie, normalizeProcess, orientationKey, processForIsland,
} from '../../web/engine/orientation.js';
import { approx } from './helpers.mjs';

const LOW_PRESSURE = { plan: 'horizontal', alimentation: 'bas' };
const GRAVITY_HORIZONTAL = { plan: 'horizontal', alimentation: 'haut' };
const deg = Math.PI / 180;
const approxVec = (a, b, tol, label) => b.forEach((x, k) => approx(a[k], x, 0, tol, `${label} [${k}]`));

/** A small deterministic generator (Park-Miller), values in [0, 1). */
function random(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** The least area of a rectangle round the points with a side along the direction of a pair of them (every edge of the hull is one). */
function bruteRect(pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      if (!(len > 0)) continue;
      const ex = (pts[j][0] - pts[i][0]) / len, ey = (pts[j][1] - pts[i][1]) / len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of pts) {
        const a = x * ex + y * ey, b = -x * ey + y * ex;
        a0 = Math.min(a0, a);
        a1 = Math.max(a1, a);
        b0 = Math.min(b0, b);
        b1 = Math.max(b1, b);
      }
      best = Math.min(best, (a1 - a0) * (b1 - b0));
    }
  }
  return best;
}

const rect = (pts) => minAreaRect(Float64Array.from(pts, (p) => p[0]), Float64Array.from(pts, (p) => p[1]));

describe('minimum-area rectangle', () => {
  test('a rectangle turned 30°: its sides and axes exactly, not its box', () => {
    const c = Math.cos(30 * deg), s = Math.sin(30 * deg);
    const at = (x, y) => [10 + x * c - y * s, -5 + x * s + y * c];
    const pts = [];
    // Its corners, points along its sides and inside it.
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) pts.push(at(-100 + 25 * i, -50 + 25 * j));
    const r = rect(pts);
    approx(r.a, 200, 1e-12, 0, 'a');
    approx(r.b, 100, 1e-12, 0, 'b');
    approx(r.area, 20000, 1e-12, 0, 'area');
    approxVec(r.u, [c, s], 1e-12, 'u');
    approxVec(r.v, [-s, c], 1e-12, 'v');
    approxVec(r.centre, [10, -5], 1e-9, 'centre');
    assert.equal(r.hull, 4);
    // Its box along the frame: 223.2 × 186.6.
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    approx((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)), (200 * c + 100 * s) * (200 * s + 100 * c), 1e-9, 0, 'box');
  });

  test('a triangle: a side on its longest edge', () => {
    // An obtuse triangle: along (0, 0)-(10, 0) its third corner overhangs, the rectangle is 12 × 3.
    const r = rect([[0, 0], [10, 0], [12, 3]]);
    approx(r.area, 30, 1e-12, 0, 'twice its area');
    approx(r.a, Math.sqrt(153), 1e-12, 0, 'a: the longest edge');
    approx(r.b, 30 / Math.sqrt(153), 1e-12, 0, 'b: its height');
    approxVec(r.u, [12 / Math.sqrt(153), 3 / Math.sqrt(153)], 1e-12, 'u');
    // A right triangle: its legs and its hypotenuse give the same area; the one along the frame.
    const right = rect([[0, 0], [4, 0], [0, 3]]);
    assert.deepEqual([right.a, right.b, right.u, right.v], [4, 3, [1, 0], [0, 1]]);
  });

  test('a circle (a regular polygon): a square on two of its sides, the one along the frame', () => {
    const n = 64, R = 50;
    const circle = (turn) => Array.from({ length: n }, (_, k) => {
      const a = ((k + 0.5) * 2 * Math.PI) / n + turn;
      return [R * Math.cos(a), R * Math.sin(a)];
    });
    const r = rect(circle(0));
    approx(r.a, 2 * R * Math.cos(Math.PI / n), 1e-12, 0, 'a');
    approx(r.b, r.a, 1e-12, 0, 'a square');
    approxVec(r.u, [1, 0], 1e-12, 'u along x');
    approxVec(r.v, [0, 1], 1e-12, 'v along y');
    // Turned 2°: every side ties; the one whose u is the nearest to x (1/2 of a side off), whatever the order of the points.
    const turned = circle(2 * deg);
    const t = rect(turned);
    approx(t.area, (2 * R * Math.cos(Math.PI / n)) ** 2, 1e-9, 0, 'area');
    assert.ok(Math.abs(t.u[0]) >= Math.cos(Math.PI / n), `u ${t.u}`);
    const next = random(3);
    const shuffled = turned.map((p) => [next(), p]).sort((x, y) => x[0] - y[0]).map(([, p]) => p);
    assert.deepEqual(rect(shuffled), t);
  });

  test('the least of every rectangle on a pair of points, whatever their order', () => {
    const next = random(11);
    for (const count of [3, 5, 12, 40, 200]) {
      for (let trial = 0; trial < 5; trial++) {
        const pts = Array.from({ length: count }, () => [100 * next() - 30, 60 * next() + 7]);
        const r = rect(pts);
        approx(r.area, bruteRect(pts), 1e-9, 1e-12, `${count} points`);
        approx(r.a * r.b, r.area, 1e-12, 0, 'a × b');
        assert.ok(r.a >= r.b);
        // Every point in it.
        for (const [x, y] of pts) {
          const a = (x - r.centre[0]) * r.u[0] + (y - r.centre[1]) * r.u[1], b = (x - r.centre[0]) * r.v[0] + (y - r.centre[1]) * r.v[1];
          assert.ok(Math.abs(a) <= r.a / 2 + 1e-9 && Math.abs(b) <= r.b / 2 + 1e-9, `${x}, ${y} outside`);
        }
        // The same rectangle from the points in another order, and with duplicates.
        const again = rect([...pts].reverse().concat(pts.slice(0, 3)));
        assert.deepEqual([again.a, again.b, again.u, again.v], [r.a, r.b, r.u, r.v]);
      }
    }
    // Degenerate: one point, two, all on a line.
    assert.deepEqual([rect([[1, 2]]).a, rect([[1, 2]]).b], [0, 0]);
    assert.deepEqual([rect([[0, 0], [3, 4]]).a, rect([[0, 0], [3, 4], [6, 8], [3, 4]]).a], [5, 10]);
    // The hull: counter-clockwise, without the points inside or along its sides.
    const xs = Float64Array.from([0, 2, 1, 2, 0, 1, 1]), ys = Float64Array.from([0, 0, 1, 2, 2, 0, 2]);
    assert.deepEqual([...convexHull(xs, ys)], [0, 1, 3, 4]);
  });
});

describe('die block', () => {
  test("the defaults are the costing's; the block of a part as the costing sizes it, oriented", () => {
    assert.deepEqual(DIE_DEFAULTS.marges, DEFAULT_TOOLING.marges);
    assert.equal(DIE_DEFAULTS.densite, DEFAULT_TOOLING.densite);
    const block = dieBlock([200, 100, 10]);
    assert.deepEqual([block.L, block.l, block.h, block.n], [320, 220, 110, 1]);
    approx(block.steel_kg, (320 * 220 * 110 * 7.8) / 1e6, 1e-12, 0, 'steel');
    // The same as tooling.js dieSize of an axis-aligned box (its sizes sorted), with three cavities.
    const size = dieSize({ bboxSize: [10, 200, 100] }, 3);
    const three = dieBlock([200, 100, 10], { cavities: 3 });
    assert.deepEqual([three.L, three.l, three.h], [size.L, size.l, size.h]);
    assert.deepEqual([three.L, three.l, three.h], [320, 3 * 100 + 2 * 40 + 120, 110]);
  });

  test('the die options from the settings, their key; the process profiles', () => {
    // The tooling settings hold marges and densite; a value missing or wrong: the default.
    const die = normalizeDie({ ...DEFAULT_TOOLING, marges: { longueur: '80', largeur: 70, hauteur: null, entreEmpreintes: -1 }, densite: 7.85, cavities: 2.4 });
    assert.deepEqual(die, { marges: { longueur: 80, largeur: 70, hauteur: 50, entreEmpreintes: 40 }, densite: 7.85, cavities: 2 });
    assert.deepEqual(normalizeDie(null), { marges: { ...DIE_DEFAULTS.marges }, densite: 7.8, cavities: 1 });
    assert.equal(dieKey(null), dieKey(DEFAULT_TOOLING));
    assert.notEqual(dieKey({ densite: 7.85 }), dieKey(null));
    assert.match(orientationKey(null, null), /^vertical-haut\|[0-9a-f]{8}$/);
    assert.notEqual(orientationKey(LOW_PRESSURE, null), orientationKey(null, null));
    assert.notEqual(orientationKey(null, { cavities: 2 }), orientationKey(null, null));
    assert.deepEqual(normalizeProcess({ plan: 'oblique' }), { plan: 'vertical', alimentation: 'haut' });
    // From the island retained by the costing: its own setting, else its family.
    assert.deepEqual(processForIsland({ code: 'BPR', famille: 'Basse pression' }), { plan: 'horizontal', alimentation: 'bas', source: 'family' });
    assert.deepEqual(processForIsland({ code: 'CG3', famille: 'Coquille gravité' }), { plan: 'vertical', alimentation: 'haut', source: 'family' });
    assert.deepEqual(processForIsland({ code: 'SSP', famille: 'Sous pression' }), { plan: 'vertical', alimentation: 'haut', source: 'default' });
    assert.deepEqual(processForIsland(null), { plan: 'vertical', alimentation: 'haut', source: 'default' });
    assert.deepEqual(processForIsland({ famille: 'Coquille gravité', orientation: GRAVITY_HORIZONTAL }), { ...GRAVITY_HORIZONTAL, source: 'island' });
  });
});
