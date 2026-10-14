// The parting halves optimised over the surface (web/engine/parting.js,
// optimiseHalves: minimum cuts) on synthetic parts meshed as CAD bodies are,
// coarse and fine: no small or isolated loops, no teeth, the line where the
// halves change, planar where a plane fits; every real undercut reported
// (its area, its slides), the real holes, slots and studs kept; the same
// halves whatever the order of the triangles.
//
//   node --test tests/js/parting-optimised.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { REACH_DOWN, REACH_UP, SHADOW, SIDE_LOWER, SIDE_NONE, SIDE_UPPER, SILHOUETTE, evaluateParting, lineMesh, lineTension } from '../../web/engine/parting.js';
import { analyseSlides, effectiveSlides, prepareSlides, slidesSignature, undercutMask } from '../../web/engine/slides.js';
import { HOLED, bossedTube, cylBosses, groovedBlock, holedBlock, studBlock, subdivided } from './cad-parts.mjs';
import { BRACKET, Body, zBracket } from './curved-mesh.mjs';
import { approx } from './helpers.mjs';
import { lineLoops, looseEnds, shapeOfLine, undercutRegions, unlinedEdges } from './line-shape.mjs';
import { voxels } from './meshes.mjs';

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
 * comb, no run turning back; the line along every edge between two whole
 * triangles of different halves (unlinedEdges: the colours never change
 * where no line is drawn). Returns {r (evaluateParting), loops, regions
 * (the areas of the undercut regions, largest first)}.
 */
function cleanSplit(part, d, label) {
  const r = evaluateParting(part.positions, part.indices, d);
  assert.equal(looseEnds(r.segments), 0, `${label}: loose ends`);
  assert.deepEqual(shapeOfLine(r.segments), { reversals: 0, teeth: 0, combs: 0 }, `${label}: shape`);
  const neighbours = lineMesh(part.positions, part.indices).neighbours;
  assert.deepEqual(unlinedEdges(part, neighbours, r, d), [], `${label}: halves changing with no line`);
  const loops = lineLoops(r.segments);
  const regions = undercutRegions(part, neighbours, r.flags);
  return { r, loops, regions };
}

/** The slides of a split along d (slides.js, as the page groups them): {analysis, view}. */
function slidesOf(part, d, r) {
  const mask = undercutMask({ flags: r.flags });
  const sig = slidesSignature({ nt: mask.length, direction: d, mask });
  const analysis = analyseSlides(prepareSlides(part.positions, part.indices), { direction: d, mask, flags: r.flags, side: r.side, sig });
  return { analysis, view: effectiveSlides(analysis) };
}

/** The same mesh, its triangles in another order and each turned (its corners from another one): {mesh, order}. */
function shuffled({ positions, indices }, seed = 7) {
  const nt = indices.length / 3;
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: nt }, (_, i) => i);
  for (let i = nt - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out = new Uint32Array(3 * nt);
  order.forEach((f, k) => {
    const [p, q, r] = [indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]];
    out.set(k % 2 ? [q, r, p] : [p, q, r], 3 * k);
  });
  return { mesh: { positions, indices: out }, order };
}

describe('the parting halves optimised over the surface', () => {
  test('the tension of the line: 1.5 mm, 1 % of the diagonal of a small part', () => {
    assert.equal(lineTension(300), 1.5);
    approx(lineTension(80), 0.8, 1e-12);
  });

  test('a finely meshed body (each triangle cut into 16): the line of the coarse body; the overhangs of its faceted boss still reported', () => {
    // The Z bracket along Z, its faces cut into small triangles. On the boss
    // (0.5° of draft, its rows staggered), small facets under the rows above
    // them (which stand out by the sagitta of the facets, 0.2 mm) are blocked
    // both ways: reported as undercuts (7 mm² each, the slides judge them),
    // joined to the half round them: the line is the coarse body's, round the
    // bottom face, up the web, round the underside of the upper flange.
    const { x, y, r: rb, height } = BRACKET.boss;
    const t = (20 * Math.PI) / 180;
    const cx = Math.cos(t) * x - Math.sin(t) * y, cy = Math.sin(t) * x + Math.cos(t) * y;
    for (const [label, part] of [['coarse', zBracket()], ['fine', subdivided(zBracket(), 2)]]) {
      const { r, loops, regions } = cleanSplit(part, [0, 0, 1], label);
      const { parting } = r.summary;
      assert.deepEqual([parting.kind, parting.loops, parting.levels_mm, loops.length], ['stepped', 1, [0, 22], 1], label);
      approx(parting.length_mm, 2 * 46 + 40 + 2 * 22 + 2 * 34 + 40, 0, 1e-6, `${label}: length`);
      // The undercuts all on the boss.
      const P = part.positions, I = part.indices;
      r.flags.forEach((flag, f) => {
        if (flag & (REACH_UP | REACH_DOWN)) return;
        const c = [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3);
        assert.ok(Math.hypot(c[0] - cx, c[1] - cy) <= rb + 0.01 && c[2] >= 30 && c[2] <= 30 + height, `${label}: an undercut at ${c}`);
      });
      if (label === 'coarse') assert.equal(regions.length, 0);
      else approx(r.summary.undercut_area_mm2, 415, 0.02, 0, 'the overhangs of the fine boss');
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

  test('real undercuts narrower than twice the tension of the line: reported, their area and their slides', () => {
    // The line's undercuts are regularised at its tension (1.5 mm): a region
    // narrower than 3 mm goes to a half for the line's shape. Those of the
    // lines of sight are reported all the same (the costing needs every
    // undercut, every slide): a groove 1 × 1 mm (or 2 × 0.5) round a block,
    // a window 10 × 10 mm through a wall 2.5 mm thick. They were reported
    // formed, no slide.
    for (const [width, depth] of [[1, 1], [2, 0.5]]) {
      const L = 120, part = groovedBlock({ L, width, depth });
      const label = `groove ${width} × ${depth}`;
      const { r } = cleanSplit(part, [0, 0, 1], label);
      // Its floor and ceiling (rings round the back), its back.
      const area = 2 * (L * L - (L - 2 * depth) ** 2) + 4 * (L - 2 * depth) * width;
      approx(r.summary.undercut_area_mm2, area, 0, 0.1, `${label}: undercut`);
      assert.deepEqual([r.summary.parting.kind, r.summary.parting.loops], ['planar', 1], label);
      const { analysis, view } = slidesOf(part, [0, 0, 1], r);
      approx(analysis.zones.reduce((sum, z) => sum + z.area_mm2, 0), area, 0, 0.1, `${label}: zones`);
      assert.equal(view.slides.length, 2, `${label}: slides`);
    }
    // A cup 100 × 100 × 50 mm (open below), its walls 2.5 mm thick, a window 10 × 10 mm through one.
    const cup = voxels((x, y, z) => {
      if (x >= 1 && x < 39 && y >= 1 && y < 39 && z < 19) return false;
      return !(x === 39 && y >= 18 && y < 22 && z >= 6 && z < 10);
    }, [40, 40, 20], { size: 2.5, perFace: true });
    const { r } = cleanSplit(cup, [0, 0, 1], 'window');
    approx(r.summary.undercut_area_mm2, 4 * 10 * 2.5, 0, 0.1, 'window: undercut');
    const { view } = slidesOf(cup, [0, 0, 1], r);
    assert.deepEqual(view.slides.map((sl) => [sl.axis, sl.zones.length]), [['X', 1]]);
  });

  test('above the coarse limit, on patches of triangles: exact where patches cannot take the graph down by half', () => {
    // The tube's triangles are larger than the cells of the patches (λ / 2):
    // each its own patch, the cut made on the triangles, the same halves.
    const part = bossedTube();
    for (const d of [[1, 0, 0], [0, 0, 1], [0, 0.6, 0.8]]) {
      const exact = evaluateParting(part.positions, part.indices, d);
      const coarse = evaluateParting(part.positions, part.indices, d, { coarseLimit: 100 });
      assert.deepEqual([coarse.side, coarse.flags, coarse.summary], [exact.side, exact.flags, exact.summary], String(d));
    }
  });

  test('a finely meshed body above the coarse limit (264 000 triangles): the same halves whatever the order of its triangles', () => {
    // The patches were grown from the triangles in their order: shuffled, the
    // line had a loop more along Z and 28 mm less obliquely. Now the patches
    // of the cells of a grid of λ / 2 (connected parts of each), the cut of
    // their graph unique: the same undercut and loops, the line within 1 %.
    const part = subdivided(bossedTube(), 4);
    const { mesh } = shuffled(part);
    for (const d of [[0, 0, 1], [0, 0.6, 0.8]]) {
      const a = evaluateParting(part.positions, part.indices, d), b = evaluateParting(mesh.positions, mesh.indices, d);
      const label = String(d);
      approx(b.summary.undercut_area_mm2, a.summary.undercut_area_mm2, 1e-6, 0, `${label}: undercut`);
      assert.deepEqual([b.summary.parting.kind, b.summary.parting.loops], [a.summary.parting.kind, a.summary.parting.loops], label);
      approx(b.summary.parting.length_mm, a.summary.parting.length_mm, 0.01, 0, `${label}: length`);
    }
  });

  test('a planar line across faces whose shared vertices differ by a hair (welded): one loop, not broken where it crosses their edges', () => {
    // A cylinder along x in strips offset half a step (no vertex on the line
    // at z = 0), its caps with their own copies of the rim vertices, one
    // float32 step higher: the plane crossed each rim edge at two points a
    // hair apart (one per face), the line in 4 loops.
    const n = 24, r = 10, L = 50;
    const ring = (x) => Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * (i + 0.5)) / n;
      return [x, r * Math.cos(a), r * Math.sin(a)];
    });
    const body = new Body();
    body.band(ring(0), ring(L), (q) => [0, q[1], q[2]]);
    const disc = ring(0).map(([, y, z]) => [y, z]);
    body.flat([0, 0, 0], [0, 1, 0], [0, 0, 1], disc, [], [-1, 0, 0]);
    body.flat([L, 0, 0], [0, 1, 0], [0, 0, 1], disc, [], [1, 0, 0]);
    const exact = body.mesh();
    const nudged = Float32Array.from(exact.positions);
    for (let v = 2 * n; v < nudged.length / 3; v++) nudged[3 * v + 2] = Math.fround(nudged[3 * v + 2] + Math.abs(nudged[3 * v + 2]) * 2 ** -23);
    const results = [exact, { positions: nudged, indices: exact.indices }].map((part, k) => cleanSplit(part, [0, 0, 1], k ? 'nudged' : 'exact'));
    for (const { r } of results) assert.deepEqual([r.summary.parting.kind, r.plane, r.summary.parting.loops], ['planar', 0, 1]);
    approx(results[1].r.summary.parting.length_mm, results[0].r.summary.parting.length_mm, 0, 1e-3, 'length');
  });

  test('a large triangle across the edge of a shadow, most of it in one half\'s reach: never left whole in the other half', () => {
    // The second cut moved such a long triangle whole into the half round it
    // (the shadows cut it no more, it was no longer between the halves): a
    // face in a half its flags exclude, uncut. Now in the half of its
    // majority, as the first cut keeps it.
    const cases = [[bossedTube(), [0.6, 0.8, 0]], [holedBlock(), [0.6, 0, 0.8]], [holedBlock(), [0, 0.6, 0.8]]];
    for (const [part, d] of cases) {
      const r = evaluateParting(part.positions, part.indices, d);
      assert.equal(r.plane, null);
      const lambda = lineTension(diagonal(part));
      const P = part.positions, I = part.indices;
      r.flags.forEach((flag, f) => {
        const reach = flag & (REACH_UP | REACH_DOWN);
        if ((reach !== REACH_UP && reach !== REACH_DOWN) || flag & (SILHOUETTE | SHADOW) || r.side[f] === SIDE_NONE) return;
        const [a, b, c] = [0, 1, 2].map((k) => 3 * I[3 * f + k]);
        const u = [0, 1, 2].map((k) => P[b + k] - P[a + k]), v = [0, 1, 2].map((k) => P[c + k] - P[a + k]);
        const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
        if (area >= 4 * lambda * lambda) assert.equal(r.side[f], reach === REACH_UP ? SIDE_UPPER : SIDE_LOWER, `${d}: triangle ${f}, ${area} mm²`);
      });
    }
  });

  test('pin holes along d (Ø 1.2 mm): a loop round each, the halves of their walls and the line agreeing', () => {
    // Loops enclosing less than λ² were taken out of the line whatever was
    // inside: the walls of the holes, whole triangles in the upper half, kept
    // their colour with no line round them (1 loop, 400 mm, for 3, 407.5).
    // Now only the slivers between two cuts inside the triangles they cut.
    const rad = 0.6, n = 16, H = 5, holes = [[30, 30], [70, 70]];
    const body = new Body();
    const circle = (cx, cy) => Array.from({ length: n }, (_, i) => [cx + rad * Math.cos((2 * Math.PI * i) / n), cy + rad * Math.sin((2 * Math.PI * i) / n)]);
    const rect = [[0, 0], [100, 0], [100, 100], [0, 100]], side = [[0, 0], [100, 0], [100, H], [0, H]];
    const rims = holes.map(([x, y]) => circle(x, y));
    body.flat([0, 0, 0], [1, 0, 0], [0, 1, 0], rect, rims.map((c) => [...c].reverse()), [0, 0, -1]);
    body.flat([0, 0, H], [1, 0, 0], [0, 1, 0], rect, rims.map((c) => [...c].reverse()), [0, 0, 1]);
    body.flat([0, 0, 0], [1, 0, 0], [0, 0, 1], side, [], [0, -1, 0]);
    body.flat([0, 100, 0], [1, 0, 0], [0, 0, 1], side, [], [0, 1, 0]);
    body.flat([0, 0, 0], [0, 1, 0], [0, 0, 1], side, [], [-1, 0, 0]);
    body.flat([100, 0, 0], [0, 1, 0], [0, 0, 1], side, [], [1, 0, 0]);
    holes.forEach(([x, y], k) => body.band(rims[k].map(([u, v]) => [u, v, 0]), rims[k].map(([u, v]) => [u, v, H]), (c) => [x - c[0], y - c[1], 0]));
    const part = body.mesh();
    const { r, loops } = cleanSplit(part, [0, 0, 1], 'pin holes');
    assert.deepEqual([r.summary.parting.kind, r.plane, r.summary.parting.loops, loops.length], ['planar', 0, 3, 3]);
    // The outline and the rims of the two holes (16-gons of radius 0.6).
    approx(r.summary.parting.length_mm, 400 + 2 * 2 * n * rad * Math.sin(Math.PI / n), 0, 0.05, 'length');
  });

  test('a cylinder with blended bosses meshed by OCCT, each triangle cut into 64 (227 000, above the coarse limit): the loops of the exact cut', () => {
    // The cut of the patches (cells of λ / 2) placed the line at their scale
    // where the evidence barely leans either way (both halves reach, the
    // faces facing one): islands of a patch or two in the other half, loops
    // of a millimetre round them (along X 5 loops for 1, along Y 4 for 2).
    // Now cut again on the triangles in a band round its line: the exact
    // cut's loops.
    const part = subdivided(cylBosses(), 3);
    assert.ok(part.indices.length / 3 > 200_000);
    for (const d of [[1, 0, 0], [0, 1, 0]]) {
      const label = String(d);
      const patches = evaluateParting(part.positions, part.indices, d);
      const exact = evaluateParting(part.positions, part.indices, d, { coarseLimit: Infinity });
      const [lp, le] = [patches, exact].map((x) => lineLoops(x.segments));
      assert.deepEqual([patches.summary.parting.loops, lp.length], [exact.summary.parting.loops, le.length], label);
      assert.deepEqual(lp.filter((l) => l.length < 5).map((l) => l.length), [], `${label}: small loops`);
      approx(patches.summary.parting.length_mm, exact.summary.parting.length_mm, 0.01, 0, `${label}: length`);
      approx(patches.summary.undercut_area_mm2, exact.summary.undercut_area_mm2, 1e-9, 0, `${label}: undercut`);
    }
  });
});
