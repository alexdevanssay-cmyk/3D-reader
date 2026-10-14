// The parting halves optimised over the surface (web/engine/parting.js,
// optimiseHalves: minimum cuts) on synthetic parts meshed as CAD bodies are,
// coarse and fine: no undercut spikes, no small or isolated loops, no
// teeth, planar where a plane fits, the real holes, slots and studs kept.
//
//   node --test tests/js/parting-optimised.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluateParting, lineMesh, lineTension } from '../../web/engine/parting.js';
import { HOLED, bossedTube, holedBlock, studBlock, subdivided } from './cad-parts.mjs';
import { zBracket } from './curved-mesh.mjs';
import { approx } from './helpers.mjs';
import { lineLoops, looseEnds, shapeOfLine, undercutRegions } from './line-shape.mjs';

/** The diagonal of the box of a mesh. */
function diagonal({ positions: P }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], P[i]);
    hi[i % 3] = Math.max(hi[i % 3], P[i]);
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/**
 * The split of `part` along d, checked clean: no loose end, no tooth, no
 * comb, no run turning back; every loop of the line enclosing λ² at least
 * (no sliver loop round a few triangles); every undercut region λ² at least
 * (no spike). Returns {r (evaluateParting), loops, regions}.
 */
function cleanSplit(part, d, label) {
  const r = evaluateParting(part.positions, part.indices, d);
  const lambda = lineTension(diagonal(part));
  assert.equal(looseEnds(r.segments), 0, `${label}: loose ends`);
  assert.deepEqual(shapeOfLine(r.segments), { reversals: 0, teeth: 0, combs: 0 }, `${label}: shape`);
  const loops = lineLoops(r.segments);
  for (const l of loops) assert.ok(!(l.area < lambda * lambda), `${label}: a loop of ${l.length} mm round ${l.area} mm²`);
  const regions = undercutRegions(part, lineMesh(part.positions, part.indices).neighbours, r.flags);
  for (const a of regions) assert.ok(a >= lambda * lambda, `${label}: an undercut region of ${a} mm²`);
  return { r, loops, regions };
}

describe('the parting halves optimised over the surface', () => {
  test('the tension of the line: 1.5 mm, 1 % of the diagonal of a small part', () => {
    assert.equal(lineTension(300), 1.5);
    approx(lineTension(80), 0.8, 1e-12);
  });

  test('a finely meshed body (each triangle cut into 16): no undercut spikes, the line of the coarse body', () => {
    // The Z bracket along Z, its faces cut into small triangles: on the boss
    // (0.5° of draft, its rows staggered), small triangles some of whose
    // points' lines met the rows above them were undercuts of a triangle or
    // two each (415 mm² in 179 regions, yellow specks all over it); now in
    // the half round them, the line the coarse body's: round the bottom face,
    // up the web, round the underside of the upper flange.
    for (const [label, part] of [['coarse', zBracket()], ['fine', subdivided(zBracket(), 2)]]) {
      const { r, loops, regions } = cleanSplit(part, [0, 0, 1], label);
      const { parting } = r.summary;
      assert.deepEqual([parting.kind, parting.loops, parting.levels_mm, r.summary.undercut_area_mm2], ['stepped', 1, [0, 22], 0], label);
      approx(parting.length_mm, 2 * 46 + 40 + 2 * 22 + 2 * 34 + 40, 0, 1e-6, `${label}: length`);
      assert.deepEqual([loops.length, regions.length], [1, 0], label);
    }
  });

  test('a tube in strips with sector bosses, along X: one loop round them and the strips in their shadows; meshed 16 times finer, the same loop', () => {
    // The strips of the tube are exactly along d: both halves reach them but
    // those in the shadow of a boss (along x behind it), the lower half before
    // it, the upper one after it. The line: round each boss and along the
    // edges of the strips its shadows cover, one loop; on the fine mesh, the
    // free strips between two shadows the optimum put in one half stay whole
    // (their lines of sight are no shadow edge to cut a comb along).
    const lengths = [];
    for (const [label, part] of [['coarse', bossedTube()], ['fine', subdivided(bossedTube(), 2)]]) {
      const { r, loops, regions } = cleanSplit(part, [1, 0, 0], label);
      assert.deepEqual([r.summary.parting.loops, loops.length, regions.length, r.summary.undercut_area_mm2], [1, 1, 0, 0], label);
      lengths.push(r.summary.parting.length_mm);
    }
    approx(lengths[1], lengths[0], 0, 0.05, 'the same line');
    approx(lengths[0], 670.5, 0, 0.05, 'length');
  });

  test('a block with holes across and along each axis: a planar line; each hole across d a whole undercut region, each along d a loop of its own', () => {
    const part = holedBlock();
    const [L, W, H] = HOLED.size;
    const n = HOLED.segments;
    // The wall of a hole (an n-gon of radius r) through a thickness t; its section.
    const wall = (r, t) => 2 * n * r * Math.sin(Math.PI / n) * t;
    const section = (r) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
    const ys = HOLED.alongY.map(([, , r]) => r), zs = HOLED.alongZ.map(([, , r]) => r);
    for (const [d, across, along, outline] of [
      [[1, 0, 0], [...ys.map((r) => wall(r, W)), ...zs.map((r) => wall(r, H))], [], 2 * (W + H)],
      [[0, 1, 0], zs.map((r) => wall(r, H)), ys, 2 * (L + H)],
      [[0, 0, 1], ys.map((r) => wall(r, W)), zs, 2 * (L + W)],
    ]) {
      const label = String(d);
      const { r, loops, regions } = cleanSplit(part, d, label);
      assert.deepEqual([r.summary.parting.kind, r.plane], ['planar', 0], label);
      // The holes across d: one undercut region each, its whole wall.
      assert.equal(regions.length, across.length, `${label}: undercut regions`);
      [...across].sort((a, b) => b - a).forEach((a, i) => approx(regions[i], a, 1e-4, 0, `${label}: hole ${i}`));
      approx(r.summary.undercut_area_mm2, across.reduce((s, a) => s + a, 0), 0, 0.1, `${label}: undercut`);
      // The holes along d: a loop round the mouth of each, besides the outline.
      assert.equal(loops.length, 1 + along.length, `${label}: loops`);
      approx(loops[0].length, outline, 1e-9, 0, `${label}: outline`);
      [...along].sort((a, b) => b - a).forEach((rad, i) => approx(loops[i + 1].area, section(rad), 1e-4, 0, `${label}: hole ${i} along d`));
    }
  });

  test('a stud and a ledge 0.3 mm deep, below the tension of the line: one planar line, at the bottom; the plane traps their undersides', () => {
    // Only the upper half reaches the top of the ledge (z = 0.5), only the
    // lower one the underside of the stud (z = 12) and the wall below it in
    // its shadow: no plane leaves them all on their sides. The line went round
    // the bottom and stepped round the ledge, with a loop of its own round the
    // underside of the stud (4.6 mm round 0.6 mm²). Now the halves of the
    // optimum (a strip 0.3 mm deep is no detail for the line) meet within the
    // planar tolerance of z = 0: cut by that plane, which traps the underside
    // of the ledge (0.3 × 30 mm²) and of the stud (0.3 × 2 mm²).
    const part = studBlock();
    const { r, loops } = cleanSplit(part, [0, 0, 1], 'stud');
    assert.deepEqual([r.summary.parting.kind, r.summary.parting.level_mm, r.plane, r.summary.parting.loops], ['planar', 0, 0, 1]);
    approx(loops[0].length, 140, 1e-9, 0, 'length');
    approx(r.summary.trapped_area_mm2, 0.3 * 30 + 0.3 * 2, 0, 0.05, 'trapped');
  });

  test('a stud 1 mm deep and 6 mm wide: a detail, the line round the strip of wall in its shadow, in the one loop round the block', () => {
    // It was a loop of its own round the underside of the stud (14 mm): the
    // wall below it, only the lower half reaches, left in the upper one.
    const part = studBlock({ stud: [1, 6, 1] });
    const { r, loops } = cleanSplit(part, [0, 0, 1], 'stud 1 mm');
    assert.deepEqual([r.plane, r.summary.parting.loops, loops.length, r.summary.undercut_area_mm2], [null, 1, 1, 0]);
    // Round the bottom (140 mm), up both sides of the strip to the stud and round its underside: + 2 × 12 + 1 + 1.
    approx(r.summary.parting.length_mm, 140 + 2 * 12 + 2 * 1 + 1, 0, 0.05, 'length');
  });
});
