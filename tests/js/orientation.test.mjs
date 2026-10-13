// Orientation of a part in its die by casting process (web/engine/orientation.js):
// the minimum-area rectangle and the die block of a draw direction, the
// direction up when cast; the draw directions ranked with them (parting.js).
// Synthetic meshes.
//
//   node --test tests/js/orientation.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_TOOLING, dieSize } from '../../web/chiffrage/tooling.js';
import { feedingZones } from '../../web/engine/feeding.js';
import {
  DIE_DEFAULTS, blockFrame, convexHull, dieBlock, dieKey, minAreaRect, normalizeDie, normalizeProcess, orientationKey, orientationMesh,
  orientationOf, processForIsland,
} from '../../web/engine/orientation.js';
import { SIDE_LOWER, SIDE_UPPER, evaluateParting, proposeParting } from '../../web/engine/parting.js';
import { analyseSlides, effectiveSlides, prepareSlides, slidesSignature, undercutMask } from '../../web/engine/slides.js';
import { approx } from './helpers.mjs';
import { prism, revolve, voxels } from './meshes.mjs';

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

// An inverted T: a base 60 (x) × 30 (z), 30 thick, a wall 4 thick and 80 high on its middle, 100 deep along y.
const T_PROFILE = [[0, 0], [60, 0], [60, 30], [32, 30], [32, 110], [28, 110], [28, 30], [0, 30]];
const tPart = () => prism(T_PROFILE, 100, [30, 25]);

/** The centre (xyz) of each triangle. */
const centres = ({ positions: P, indices: I }) => Array.from({ length: I.length / 3 }, (_, f) => [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3));

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

describe('draw directions ranked by their die block and their feeding', () => {
  test('a plate 200 × 100 × 10 turned 30° about Z: drawn along Z, its block 200 × 100 × 10 along its sides, not its box', () => {
    const plate = voxels(() => true, [20, 10, 1], { size: 10 });
    const c = Math.cos(30 * deg), s = Math.sin(30 * deg);
    const P = plate.positions;
    for (let i = 0; i < P.length; i += 3) [P[i], P[i + 1]] = [P[i] * c - P[i + 1] * s, P[i] * s + P[i + 1] * c];
    const { proposal } = proposeParting(P, plate.indices);
    assert.deepEqual(proposal.direction, [0, 0, 1]);
    const o = proposal.orientation;
    assert.deepEqual(o.raw_mm, [200, 100, 10]);
    approxVec(o.block_axes.u, [c, s, 0], 1e-6, 'u');
    approxVec(o.block_axes.v, [-s, c, 0], 1e-6, 'v');
    assert.deepEqual(o.block_axes.d, [0, 0, 1]);
    assert.deepEqual(o.die_block_mm, [320, 220, 110]);
    assert.equal(o.steel_kg, 60.4);
    // Every other candidate needs more steel; along X, its box: 186.6 across (along Y), 223.2 along X.
    for (const cand of proposal.candidates) if (cand !== proposal.candidates[proposal.candidate_index]) assert.ok(cand.orientation.steel_kg > o.steel_kg);
    assert.deepEqual(proposal.candidates.find((x) => x.axis === 'X').orientation.raw_mm, [186.6, 10, 223.21]);
    // Either sense of the axis: the same block.
    const down = orientationOf(P, plate.indices, [0, 0, -1]);
    assert.deepEqual([down.raw_mm, down.block_axes.u, down.block_axes.v, down.die_block_mm], [o.raw_mm, o.block_axes.u, o.block_axes.v, o.die_block_mm]);
    assert.deepEqual(down.block_axes.d, [0, 0, -1]);
  });

  test('as much undercut: the smaller steel mass wins, with the margins given', () => {
    // A box 100 × 60 × 20: no undercut along X, Y or Z; along Z the least steel and the least zero-draft surface.
    const box = voxels(() => true, [10, 6, 2], { size: 10 });
    const plain = proposeParting(box.positions, box.indices).proposal;
    assert.equal(plain.axis, 'Z');
    assert.deepEqual([plain.orientation.raw_mm, plain.orientation.die_block_mm], [[100, 60, 20], [220, 180, 120]]);
    approx(plain.orientation.steel_kg, 37.1, 0, 1e-9, 'steel');
    // Margins of 1 m along the draw direction, none across it: the block the smallest along X (60 × 20 × 2100 mm).
    const tall = { marges: { longueur: 0, largeur: 0, hauteur: 1000, entreEmpreintes: 0 } };
    const { proposal } = proposeParting(box.positions, box.indices, { die: tall });
    assert.equal(proposal.axis, 'X');
    assert.deepEqual(proposal.orientation.die_block_mm, [60, 20, 2100]);
    const byAxis = Object.fromEntries(proposal.candidates.map((x) => [x.axis, x]));
    for (const x of proposal.candidates) assert.equal(x.undercut_area_mm2, 0);
    // Z would win on the next keys (the same planar line, less zero-draft surface): the steel decides.
    assert.ok(byAxis.Z.zero_draft_area_mm2 < byAxis.X.zero_draft_area_mm2);
    assert.ok(byAxis.X.orientation.steel_kg < 0.95 * Math.min(byAxis.Y.orientation.steel_kg, byAxis.Z.orientation.steel_kg));
    assert.deepEqual(proposal.die, normalizeDie(tall));
    assert.notEqual(proposal.options_key, plain.options_key);
  });

  test('a thick base and a thin wall: up towards the base for gravity, the base down near the feed for low pressure', () => {
    const t = tPart();
    // Gravity, vertical parting plane (the default): drawn across the T (X), the base up (g = -Z).
    const gravity = proposeParting(t.positions, t.indices).proposal;
    assert.deepEqual(gravity.direction, [1, 0, 0]);
    assert.deepEqual([gravity.orientation.up, gravity.orientation.up_side, gravity.orientation.up_axis], [[0, 0, -1], '-u', '-Z']);
    assert.deepEqual(gravity.orientation.block_axes, { u: [0, 0, 1], v: [0, 1, 0], d: [1, 0, 0] });
    assert.deepEqual([gravity.orientation.raw_mm, gravity.orientation.feeding_basis], [[110, 100, 60], 'volume_centroid']);
    assert.ok(gravity.orientation.feeding_score > 0.1, String(gravity.orientation.feeding_score));
    assert.deepEqual(gravity.process, { plan: 'vertical', alimentation: 'haut' });
    // Low pressure: a horizontal plane, drawn along Z with the base on the -d side, at the bottom (g = +d).
    const low = proposeParting(t.positions, t.indices, { process: LOW_PRESSURE }).proposal;
    assert.deepEqual([low.direction, low.orientation.up, low.orientation.up_side, low.orientation.upper_half_down], [[0, 0, 1], [0, 0, 1], '+d', false]);
    assert.ok(low.orientation.feeding_score < -0.1, 'massive down');
    // Gravity on a horizontal plane: the base up, d turned over so that the upper half is on top.
    const horizontal = proposeParting(t.positions, t.indices, { process: GRAVITY_HORIZONTAL }).proposal;
    assert.deepEqual([horizontal.axis, horizontal.direction, horizontal.orientation.up, horizontal.orientation.up_side], ['-Z', [0, 0, -1], [0, 0, -1], '+d']);
    assert.ok(horizontal.orientation.feeding_score > 0.1, 'massive up');
    // Its halves: the base (z < 30) in the upper one, along -Z.
    const { side } = proposeParting(t.positions, t.indices, { process: GRAVITY_HORIZONTAL });
    centres(t).forEach((c, f) => {
      if (c[2] < 1e-9) assert.equal(side[f], SIDE_UPPER, `triangle ${f} under the base`);
    });
    // Every candidate carries its orientation.
    for (const p of [gravity, low, horizontal]) {
      for (const x of p.candidates) for (const key of ['up', 'block_axes', 'raw_mm', 'die_block_mm', 'steel_kg', 'feeding_score', 'process']) assert.ok(key in x.orientation, key);
    }
  });

  test('the thickness of each triangle, when given, in place of the volume centroid', () => {
    const t = tPart();
    // A field that says the wall is the massive part (40 mm) and the base thin (2 mm): it disagrees with the volume.
    const thickness = Float32Array.from(centres(t), (c) => (c[2] > 30 ? 40 : 2));
    const byVolume = orientationOf(t.positions, t.indices, [1, 0, 0]);
    const byThickness = orientationOf(t.positions, t.indices, [1, 0, 0], { thickness });
    assert.deepEqual([byVolume.up, byVolume.feeding_basis], [[0, 0, -1], 'volume_centroid']);
    assert.deepEqual([byThickness.up, byThickness.feeding_basis], [[0, 0, 1], 'thickness']);
    assert.ok(byThickness.feeding_score > 0.2);
    // The field of the wall thickness itself (thickness.js: the base 30, the wall 4): agrees with the volume.
    const sphere = feedingZones(t.positions, t.indices).sphere;
    assert.deepEqual(orientationOf(t.positions, t.indices, [1, 0, 0], { thickness: sphere }).up, [0, 0, -1]);
    // In the proposal too; a field of the wrong length: left out.
    const { proposal } = proposeParting(t.positions, t.indices, { thickness });
    assert.deepEqual([proposal.orientation.up, proposal.orientation.feeding_basis], [[0, 0, 1], 'thickness']);
    assert.equal(orientationOf(t.positions, t.indices, [1, 0, 0], { thickness: thickness.subarray(1) }).feeding_basis, 'volume_centroid');
  });

  test('up directions as well fed: the shorter side vertical, then + before -, then u before v', () => {
    // A box 100 × 60 × 20 along Z: every score 0; the shorter side of the block (v, 60 mm) vertical.
    const box = voxels(() => true, [10, 6, 2], { size: 10 });
    const o = orientationOf(box.positions, box.indices, [0, 0, 1]);
    assert.deepEqual([o.block_axes.u, o.block_axes.v, o.up_side, o.up], [[1, 0, 0], [0, 1, 0], '+v', [0, 1, 0]]);
    assert.ok(o.choices.every((x) => x.score === 0));
    // Horizontal: +d.
    assert.equal(orientationOf(box.positions, box.indices, [0, 0, -1], { process: GRAVITY_HORIZONTAL }).up_side, '+d');
    // A square plate 60 × 60 × 10, a block 30 × 30 × 30 on its corner towards -X, +Y: -u and +v as well fed, as long; +v.
    const plate = voxels((x, y, z) => z < 2 || (x < 6 && y >= 6 && z < 8), [12, 12, 8], { size: 5 });
    const sq = orientationOf(plate.positions, plate.indices, [0, 0, 1]);
    assert.deepEqual([sq.block_axes.u, sq.block_axes.v, sq.raw_mm], [[1, 0, 0], [0, 1, 0], [60, 60, 40]]);
    const score = Object.fromEntries(sq.choices.map((x) => [x.side, x.score]));
    assert.ok(score['-u'] > 0.02 && Math.abs(score['-u'] - score['+v']) < 1e-9, JSON.stringify(score));
    assert.deepEqual([sq.up_side, sq.up], ['+v', [0, 1, 0]]);
  });

  test('a direction by hand: its orientation, up chosen by hand, a horizontal plane turned over on demand', () => {
    const t = tPart();
    // Low pressure drawn along -Z: up is -d, the upper half at the bottom; said, not turned over.
    const asGiven = evaluateParting(t.positions, t.indices, [0, 0, -1], { process: LOW_PRESSURE });
    assert.deepEqual(asGiven.summary.direction, [0, 0, -1]);
    assert.deepEqual([asGiven.summary.orientation.up, asGiven.summary.orientation.up_side, asGiven.summary.orientation.upper_half_down], [[0, 0, 1], '-d', true]);
    // Turned over (orient): drawn along +Z, up = +d; the halves swapped: under the base, the lower half.
    const turned = evaluateParting(t.positions, t.indices, [0, 0, -1], { process: LOW_PRESSURE, orient: true });
    assert.deepEqual([turned.summary.direction, turned.summary.orientation.up_side, turned.summary.orientation.upper_half_down], [[0, 0, 1], '+d', false]);
    centres(t).forEach((c, f) => {
      if (c[2] < 1e-9) {
        assert.equal(asGiven.side[f], SIDE_UPPER);
        assert.equal(turned.side[f], SIDE_LOWER);
      }
    });
    assert.equal(turned.summary.options_key, orientationKey(LOW_PRESSURE, null));
    // Up chosen by hand: a side, or the allowed direction nearest a vector.
    assert.deepEqual(evaluateParting(t.positions, t.indices, [1, 0, 0], { up: '+u' }).summary.orientation.up, [0, 0, 1]);
    assert.deepEqual(orientationOf(t.positions, t.indices, [1, 0, 0], { up: [0.1, 0.9, 0.2] }).up_side, '+v');
    // The same summary from the worker's mesh (parting.js) and from the page's (orientationOf).
    assert.deepEqual(evaluateParting(t.positions, t.indices, [1, 0, 0]).summary.orientation, orientationOf(t.positions, t.indices, [1, 0, 0]));
  });

  test('a horizontal plane turned over: the slides of its undercuts the same, its halves swapped', () => {
    // A plate 400 × 400 × 15 on a block 100 × 100 × 80 under it, a pocket 5 mm into the middle of its +X side:
    // drawn along Z (the least steel; the pocket's undercut too small to rank), up to the block (gravity) or away
    // from it (low pressure).
    const mesh = voxels((x, y, z) => (z >= 16 ? !(x === 79 && y === 40 && z === 17) : x >= 30 && x < 50 && y >= 30 && y < 50), [80, 80, 19], { size: 5 });
    const gravity = proposeParting(mesh.positions, mesh.indices, { process: GRAVITY_HORIZONTAL });
    const low = proposeParting(mesh.positions, mesh.indices, { process: LOW_PRESSURE });
    assert.deepEqual([gravity.proposal.direction, gravity.proposal.orientation.up], [[0, 0, -1], [0, 0, -1]]);
    assert.deepEqual([low.proposal.direction, low.proposal.orientation.up], [[0, 0, 1], [0, 0, 1]]);
    const slides = ({ proposal, flags, side }) => {
      const mask = undercutMask({ flags });
      const d = proposal.direction;
      const analysis = analyseSlides(prepareSlides(mesh.positions, mesh.indices), { direction: d, mask, flags, side, sig: slidesSignature({ nt: mask.length, direction: d, mask }) });
      return { mask, analysis, view: effectiveSlides(analysis) };
    };
    const a = slides(gravity), b = slides(low);
    assert.deepEqual(a.mask, b.mask);
    assert.equal(a.analysis.undercut_area_mm2, 125);
    const shape = (s) => s.view.slides.map((x) => [x.axis, x.zones, x.area_mm2, x.stroke_mm]);
    assert.deepEqual(shape(a), [['X', [1], 125, 10]]);
    assert.deepEqual(shape(a), shape(b));
    // The block in the upper half when turned over (gravity), in the lower one along +Z.
    centres(mesh).forEach((c, f) => {
      if (c[2] < 1e-9) assert.deepEqual([gravity.side[f], low.side[f]], [SIDE_UPPER, SIDE_LOWER], `triangle ${f}`);
    });
  });

  test('the same orientation whatever the order of the triangles and of their corners, or their winding', () => {
    const t = tPart();
    const base = orientationOf(t.positions, t.indices, [1, 0, 0]);
    const I = t.indices;
    const n = I.length / 3;
    const next = random(5);
    const order = Array.from({ length: n }, (_, f) => f).map((f) => [next(), f]).sort((a, b) => a[0] - b[0]).map(([, f]) => f);
    const shuffled = new Uint32Array(I.length);
    order.forEach((f, k) => shuffled.set([I[3 * f + 1], I[3 * f + 2], I[3 * f]], 3 * k));
    const wound = Uint32Array.from(I, (_, i) => I[i - (i % 3) + [0, 2, 1][i % 3]]);
    assert.deepEqual(orientationOf(t.positions, shuffled, [1, 0, 0]), base);
    assert.deepEqual(orientationOf(t.positions, wound, [1, 0, 0]), base);
    // Twice the same proposal, with every option.
    const options = { process: LOW_PRESSURE, die: { cavities: 2 } };
    assert.deepEqual(proposeParting(t.positions, t.indices, options).proposal, proposeParting(t.positions, t.indices, options).proposal);
  });

  test('bounded: 2M triangles, every vertex on the outline seen along the axis', () => {
    // A cylinder R 50, 200 long, of 1000 rings of 1000 points: seen along its axis, 1M points on one circle.
    const rings = 1000;
    const cyl = revolve(Array.from({ length: rings }, (_, k) => [50, (200 * k) / (rings - 1)]), 1000, { poles: [0, 200] });
    assert.equal(cyl.indices.length / 3, 2_000_000);
    // The time of this process on the processor (the machine may be shared: its wall clock is logged).
    const cpu = () => {
      const { user, system } = process.cpuUsage();
      return (user + system) / 1000;
    };
    const times = [], walls = [];
    for (const [d, raw] of [[[0, 0, 1], [100, 100, 200]], [[1, 0, 0], [200, 100, 100]], [[0.6, 0, 0.8], null]]) {
      const [c0, w0] = [cpu(), performance.now()];
      const o = orientationOf(cyl.positions, cyl.indices, d);
      times.push(cpu() - c0);
      walls.push(performance.now() - w0);
      if (raw) raw.forEach((x, k) => approx(o.raw_mm[k], x, 0, 0.01, `${d}: raw ${k}`));
    }
    // The block frame alone, on the mesh of the worker (built once for the candidates).
    const om = orientationMesh(cyl.positions, cyl.indices);
    const c0 = cpu();
    blockFrame(om, [0, 0.6, 0.8]);
    const frame = cpu() - c0;
    const ms = (list) => list.map((x) => x.toFixed(0)).join(', ');
    console.log(`orientation of a body of 2M triangles: ${ms(times)} ms of processor (${ms(walls)} ms); a frame ${frame.toFixed(0)} ms`);
    for (const t of times) assert.ok(t < 1500, `${t} ms`);
    assert.ok(frame < 1000, `frame ${frame} ms`);
  });
});
