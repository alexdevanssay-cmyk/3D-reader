// Draw direction and parting line (web/engine/parting.js) on synthetic meshes.
//
//   node --test tests/js/parting.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BLOCK_GRID, REACH_DOWN, REACH_UP, SIDE_LOWER, SIDE_UPPER, applyOverrides, axisLabel, canonicalAxis, evaluateParting, faceRegions,
  lineMesh, lineShape, lineSummary, mouldBlocks, parseDirection, partingLine, partingPieces, pieceTriangles, proposeParting, sameDirection,
  sampleByArea,
} from '../../web/engine/parting.js';
import { LEVEL, SHADOW, SIDE_NONE, SILHOUETTE, TRAPPED, ZERO_DRAFT } from '../../web/engine/parting.js';
import { BRACKET, MUSHROOM, PEG, mushroom, peg, zBracket } from './curved-mesh.mjs';
import { approx } from './helpers.mjs';
import { PLATE, castPlate } from './plate-mesh.mjs';

// The synthetic meshes, shared with the tests of the line drawn by hand.
import { prism, revolve, voxels } from './meshes.mjs';

const byAxis = (proposal) => Object.fromEntries(proposal.candidates.map((c) => [c.axis, c]));

describe('draw direction proposed from the geometry', () => {
  test('a box: no undercut along its axes, a planar line around it, drawn across its thinnest side', () => {
    for (const mesh of [voxels(() => true, [10, 6, 2], { size: 10 }), prism([[0, 0], [100, 0], [100, 20], [0, 20]], 60, [50, 10])]) {
      const { proposal, side } = proposeParting(mesh.positions, mesh.indices);
      const axes = byAxis(proposal);
      assert.deepEqual(Object.keys(axes).sort(), ['X', 'Y', 'Z']);
      for (const c of proposal.candidates) {
        assert.equal(c.undercut_area_mm2, 0, c.axis);
        assert.equal(c.parting.planar, true, c.axis);
      }
      assert.equal(proposal.status, 'proposed');
      assert.equal(proposal.axis, 'Z');
      assert.deepEqual(proposal.direction, [0, 0, 1]);
      // The sides of the box have no draft: 6400 of 18400 mm².
      approx(proposal.zero_draft_share, 6400 / 18400, 0, 1e-4, 'zero-draft share');
      approx(proposal.projected_area_mm2, 6000, 1e-9, 0, 'projected area');
      assert.equal(proposal.mould_height_mm, 20);
      // The line goes round its bottom edge: one loop of 320 mm, at z = 0.
      assert.deepEqual([proposal.parting.kind, proposal.parting.loops, proposal.parting.length_mm, proposal.parting.level_mm], ['planar', 1, 320, 0]);
      assert.ok(side.every((s) => s === SIDE_UPPER || s === SIDE_LOWER));
      assert.equal(proposal.sampled, null);
    }
  });

  test('an L: planar; its diagonal principal axes, without zero-draft faces but with a warped line, are not proposed', () => {
    const mesh = voxels((x, y, z) => z < 1 || x < 1, [6, 8, 6], { size: 5 });
    const { proposal } = proposeParting(mesh.positions, mesh.indices);
    assert.ok(['X', 'Z'].includes(proposal.axis), proposal.axis);
    assert.equal(proposal.undercut_area_mm2, 0);
    assert.equal(proposal.parting.planar, true);
    const diagonal = proposal.candidates.find((c) => c.source === 'principal_axis' && c.undercut_area_mm2 === 0 && c.parting.planar === false);
    assert.ok(diagonal, JSON.stringify(proposal.candidates.map((c) => c.axis)));
    assert.ok(diagonal.zero_draft_area_mm2 < proposal.zero_draft_area_mm2);
    assert.equal(diagonal.parting.kind, 'warped');
  });

  test('a T with long triangles across its flat faces: a planar line, those faces cut at the underside of its bar', () => {
    // Bar 30 × 5 on top of a stem 5 wide and 10 high, 20 deep.
    const profile = [[12.5, 0], [17.5, 0], [17.5, 10], [30, 10], [30, 15], [0, 15], [0, 10], [12.5, 10]];
    const mesh = prism(profile, 20, [15, 11]);
    const { proposal, segments } = proposeParting(mesh.positions, mesh.indices);
    assert.equal(proposal.axis, 'Z');
    assert.equal(proposal.undercut_area_mm2, 0);
    // Across both flat faces (30 mm each) and the two ends of the bar (20 mm each), at z = 10.
    assert.deepEqual([proposal.parting.planar, proposal.parting.loops, proposal.parting.level_mm], [true, 1, 10]);
    approx(proposal.parting.length_mm, 2 * 30 + 2 * 20, 1e-6, 0, 'length');
    for (let i = 2; i < segments.length; i += 3) approx(segments[i], 10, 0, 1e-4, 'height of the line');
  });

  test('a block with a side hole: an undercut unless the axis is along the hole', () => {
    // 50 × 30 × 20, a square hole 10 × 10 through it along y.
    const mesh = voxels((x, y, z) => !(x >= 4 && x < 6 && z >= 1 && z < 3), [10, 6, 4], { size: 5 });
    const { proposal } = proposeParting(mesh.positions, mesh.indices);
    const axes = byAxis(proposal);
    // The four sides of the hole: 4 × 10 × 30 mm².
    approx(axes.Z.undercut_area_mm2, 1200, 1e-9, 0, 'undercut along Z');
    approx(axes.X.undercut_area_mm2, 1200, 1e-9, 0, 'undercut along X');
    assert.equal(axes.Y.undercut_area_mm2, 0);
    assert.equal(proposal.axis, 'Y');
    // The line goes round the block and round the hole: two loops.
    assert.deepEqual([proposal.parting.planar, proposal.parting.loops], [true, 2]);
    approx(proposal.undercut_share, 0, 0, 0, 'undercut share');
  });

  test('a stepped part: without undercut, its parting line cannot be planar', () => {
    // A Z profile (bottom flange, web, top flange) with a hole through each flange.
    const mesh = voxels((x, y, z) => {
      const bottom = z < 1 && x < 4, web = x === 3, top = z >= 4 && x >= 3;
      const hole = y >= 3 && y < 5 && ((x === 1 && z < 1) || (x === 5 && z >= 4));
      return (bottom || web || top) && !hole;
    }, [7, 8, 5], { size: 5 });
    const { proposal } = proposeParting(mesh.positions, mesh.indices);
    assert.equal(proposal.axis, 'Z');
    assert.equal(proposal.undercut_area_mm2, 0);
    // Every planar candidate leaves undercuts (the holes, across them).
    for (const c of proposal.candidates.filter((c) => c.parting?.planar)) assert.ok(c.undercut_area_mm2 > 0, c.axis);
    assert.equal(proposal.parting.planar, false);
    assert.equal(proposal.parting.kind, 'stepped');
    assert.equal(proposal.parting.height_range_mm, 20);
    assert.deepEqual(proposal.parting.levels_mm, [0, 20]);
    // Round the part, and round each hole.
    assert.equal(proposal.parting.loops, 3);
  });

  test('curved silhouettes: no undercut where a line grazes the next facets, a planar line along their zigzag', () => {
    // A sphere R 20 in 15 bands (no ring on its equator), a torus R 30 r 10 lying flat (none on its equators).
    const bands = Array.from({ length: 14 }, (_, k) => -Math.PI / 2 + (Math.PI * (k + 1)) / 15);
    const sphere = revolve(bands.map((t) => [20 * Math.cos(t), 20 * Math.sin(t)]), 24, { poles: [-20, 20] });
    const tube = Array.from({ length: 15 }, (_, k) => (2 * Math.PI * (k + 0.5)) / 15);
    const torus = revolve(tube.map((t) => [30 + 10 * Math.cos(t), 10 * Math.sin(t)]), 48, { loop: true });
    for (const [mesh, loops] of [[sphere, 1], [torus, 2]]) {
      const { summary } = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
      assert.equal(summary.undercut_area_mm2, 0);
      assert.deepEqual([summary.parting.planar, summary.parting.loops], [true, loops]);
    }
    // Round the outside of the torus and round its hole, at mid-height.
    const { proposal } = proposeParting(torus.positions, torus.indices);
    assert.deepEqual([proposal.axis, proposal.parting.loops, proposal.parting.level_mm], ['Z', 2, 0]);
  });

  test('a large mesh: candidates ranked on triangles drawn by area with a fixed seed, the same twice', () => {
    const mesh = voxels((x, y, z) => !(x >= 4 && x < 6 && z >= 1 && z < 3), [10, 6, 4], { size: 5, subdivide: 6 });
    const nt = mesh.indices.length / 3;
    const options = { fullLimit: 5000, samples: 4000 };
    const first = proposeParting(mesh.positions, mesh.indices, options);
    const second = proposeParting(mesh.positions, mesh.indices, options);
    assert.deepEqual(first.proposal, second.proposal);
    assert.deepEqual(first.side, second.side);
    assert.deepEqual(first.proposal.sampled, { triangles: nt, samples: 4000, seed: first.proposal.sampled.seed, by: 'area' });
    assert.equal(first.proposal.axis, 'Y');
    // The direction chosen is classified on every triangle.
    assert.equal(first.side.length, nt);
    assert.deepEqual(first.proposal.parting, proposeParting(mesh.positions, mesh.indices, { fullLimit: Infinity }).proposal.parting);
    // The undercut estimated from the sample, close to the exact one.
    const exact = byAxis(proposeParting(mesh.positions, mesh.indices, { fullLimit: Infinity }).proposal).Z.undercut_share;
    approx(byAxis(first.proposal).Z.undercut_share, exact, 0, 0.03, 'sampled undercut share');
    // Another seed, another draw.
    const areas = new Float64Array(1000).fill(1);
    assert.deepEqual(sampleByArea(areas, 50, 7), sampleByArea(areas, 50, 7));
    assert.notDeepEqual(sampleByArea(areas, 50, 7), sampleByArea(areas, 50, 8));
    // Drawn by area: a triangle 9 times larger, drawn about 9 times more.
    const counts = [0, 0];
    for (const f of sampleByArea(Float64Array.from([1, 9]), 10000, 3)) counts[f]++;
    approx(counts[1] / counts[0], 9, 0.15, 0, 'draws by area');
  });

  test('a large mesh: a candidate whose line was never classified does not rank as planar', () => {
    // Two blocks apart: the two candidates with the least zero-draft surface
    // have a stepped or warped line, those not classified on every triangle
    // must not win as if theirs were planar.
    const mesh = voxels((x, y, z) => (x === 3 && y < 3 && z < 3) || (x === 0 && y === 3 && z === 2), [4, 4, 3], { size: 5 });
    const nt = mesh.indices.length / 3;
    const full = proposeParting(mesh.positions, mesh.indices).proposal;
    assert.deepEqual([full.axis, full.parting.kind, full.undercut_area_mm2], ['Z', 'planar', 0]);
    const { proposal } = proposeParting(mesh.positions, mesh.indices, { fullLimit: 10, samples: 30 * nt });
    assert.ok(proposal.sampled);
    assert.deepEqual([proposal.axis, proposal.parting.kind, proposal.undercut_area_mm2], ['Z', 'planar', 0]);
    // Its principal axes, the obliques with less zero-draft surface, need more
    // than 5 % more steel in their die block: ranked below on it, never
    // classified on every triangle. X, as much steel and as well fed as Z, has
    // less zero-draft surface: it would win as if its line were planar, but
    // classified on every triangle its line is stepped.
    for (const c of proposal.candidates.filter((c) => c.source === 'principal_axis')) {
      assert.ok(c.orientation.steel_kg > 1.05 * proposal.orientation.steel_kg, `${c.axis}: ${c.orientation.steel_kg} kg`);
    }
    const lessDraft = proposal.candidates.find((c) => c.zero_draft_area_mm2 < proposal.zero_draft_area_mm2 && c.undercut_area_mm2 === 0 && c.orientation.steel_kg <= 1.05 * proposal.orientation.steel_kg);
    assert.equal(lessDraft?.axis, 'X', JSON.stringify(proposal.candidates.map((c) => c.axis)));
    assert.equal(lessDraft.parting?.kind, 'stepped');
  });

  test('a large mesh: the direction chosen shows the areas of its faces classified on every triangle', () => {
    // A plate 200 × 200 × 15 mm with a pocket 5 mm square in its side: 125 mm²
    // of undercut along Z, missed by 300 triangles drawn by area.
    const mesh = voxels((x, y, z) => !(x === 0 && y === 20 && z === 1), [40, 40, 3], { size: 5, subdivide: 2 });
    const { proposal, flags } = proposeParting(mesh.positions, mesh.indices, { fullLimit: 10, samples: 300 });
    assert.ok(proposal.sampled);
    assert.equal(proposal.axis, 'Z');
    approx(proposal.undercut_area_mm2, 125, 1e-9, 0, 'undercut');
    // The area of the triangles flagged undercut (shown in red), the same.
    const P = mesh.positions, I = mesh.indices;
    let red = 0;
    flags.forEach((flag, f) => {
      if (flag & (REACH_UP | REACH_DOWN)) return;
      const [a, b, c] = [0, 1, 2].map((k) => 3 * I[3 * f + k]);
      const u = [0, 1, 2].map((k) => P[b + k] - P[a + k]), v = [0, 1, 2].map((k) => P[c + k] - P[a + k]);
      red += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    });
    approx(red, 125, 1e-9, 0, 'undercut triangles');
    assert.equal(proposal.undercut_share, proposal.candidates[proposal.candidate_index].undercut_share);
  });

  test('a planar line with a short detour: at the height most of it is at', () => {
    // A plate 800 × 800 × 10 mm, a post 20 mm square on its edge and a lip on
    // top of it, at z = 30, overhanging the edge by 10 mm: 3180 of the 3280 mm
    // of its line at z = 0, the rest round the lip.
    const mesh = voxels((x, y, z) => (z === 0 && x < 80) || (x >= 78 && x < 80 && y < 2 && (z === 1 || z === 2)) || (x >= 78 && y < 2 && z === 3), [81, 80, 4], { size: 10 });
    const { summary } = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
    assert.deepEqual([summary.parting.planar, summary.parting.height_range_mm, summary.parting.length_mm], [true, 30, 3280]);
    assert.equal(summary.parting.level_mm, 0);
  });

  test('a direction given by hand: its undercuts and its line', () => {
    const mesh = voxels((x, y, z) => !(x >= 4 && x < 6 && z >= 1 && z < 3), [10, 6, 4], { size: 5 });
    const { summary, side, flags } = evaluateParting(mesh.positions, mesh.indices, [0, 0, -2]);
    assert.equal(summary.axis, '-Z');
    assert.deepEqual(summary.direction, [0, 0, -1]);
    approx(summary.undercut_area_mm2, 1200, 1e-9, 0, 'undercut');
    assert.equal(side.length, mesh.indices.length / 3);
    assert.equal(flags.length, side.length);
    assert.equal(summary.parting.planar, true);
    assert.throws(() => evaluateParting(mesh.positions, mesh.indices, [0, 0, 0]));
  });
});

/** Per triangle of a mesh: {c (centre), n (unit normal), area}. */
function triangleGeometry(positions, indices) {
  const P = positions, I = indices;
  return Array.from({ length: I.length / 3 }, (_, f) => {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * I[3 * f + k]);
    const u = [0, 1, 2].map((k) => P[b + k] - P[a + k]), v = [0, 1, 2].map((k) => P[c + k] - P[a + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    return { c: [0, 1, 2].map((k) => (P[a + k] + P[b + k] + P[c + k]) / 3), n: n.map((x) => x / len), area: len / 2 };
  });
}

/** The ends of the pieces of a line met by an odd number of pieces (within 1e-4 mm): 0 when it is in closed loops. */
function looseEnds(segments) {
  const ends = [];
  for (let i = 0; i < segments.length; i += 3) ends.push([segments[i], segments[i + 1], segments[i + 2]]);
  return ends.filter((p) => ends.filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4).length % 2).length;
}

/** Area of the part of a triangle (xy) where keep(p) >= 0 for every half-plane `keep` (Sutherland-Hodgman). */
function clippedArea(triangle, halfPlanes) {
  let poly = triangle;
  for (const keep of halfPlanes) {
    const out = [];
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const a = keep(p), b = keep(q);
      if (a >= 0) out.push(p);
      if (a >= 0 !== b >= 0) out.push([p[0] + (a / (a - b)) * (q[0] - p[0]), p[1] + (a / (a - b)) * (q[1] - p[1])]);
    });
    poly = out;
  }
  let s = 0;
  poly.forEach((p, i) => (s += p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1]));
  return Math.abs(s) / 2;
}

/** Area of the part of a triangle (xyz) where h(p) > 0, h linear (clipped by its plane). */
function areaWhere(triangle, h) {
  const poly = [];
  triangle.forEach((p, i) => {
    const q = triangle[(i + 1) % 3];
    const a = h(p), b = h(q);
    if (a > 0) poly.push(p);
    if (a > 0 !== b > 0) poly.push(p.map((x, k) => x + (a / (a - b)) * (q[k] - x)));
  });
  const s = [0, 0, 0];
  for (let i = 1; i + 1 < poly.length; i++) {
    const u = [0, 1, 2].map((k) => poly[i][k] - poly[0][k]), v = [0, 1, 2].map((k) => poly[i + 1][k] - poly[0][k]);
    s[0] += u[1] * v[2] - u[2] * v[1];
    s[1] += u[2] * v[0] - u[0] * v[2];
    s[2] += u[0] * v[1] - u[1] * v[0];
  }
  return Math.hypot(...s) / 2;
}

describe('flat faces along the draw direction (a CAD body: flat faces cut into long triangles round their holes)', () => {
  test('a plate drawn along its length: one planar line across it, closed; its flat faces cut straight, not along their triangles', () => {
    // Its pillars, letters and boss cast shadows along Y on its top face: no
    // plane leaves every face one half only can form on its side. The line
    // was the boundary of those shadows along the triangles of the top face
    // (warped, 470 mm in 5 pieces); it is now the section of the plate at
    // the level that leaves the least surface with draft on the wrong side:
    // through the axis of the boss.
    for (const welded of [false, true]) {
      const plate = castPlate({ welded });
      const { summary, side, flags, segments, plane } = evaluateParting(plate.positions, plate.indices, [0, 1, 0]);
      const label = welded ? 'STL' : 'B-rep faces';
      assert.deepEqual([summary.parting.kind, summary.parting.level_mm, summary.parting.loops], ['planar', 0, 2], label);
      assert.equal(plane, 0, label);
      // Every piece at y = 0, none loose: the section of the plate, on each side of its bore
      // (bottom 25, side 15, top 20, boss 8 + 5, bore 23: twice 96 mm).
      for (let i = 1; i < segments.length; i += 3) approx(segments[i], 0, 0, 1e-4, `${label}: y of the line`);
      assert.equal(looseEnds(segments), 0, label);
      approx(summary.parting.length_mm, 192, 0, 0.05, `${label}: length`);
      // Every triangle in the half of its side of the plane, unless an undercut: no face split along its triangles.
      const tris = triangleGeometry(plate.positions, plate.indices);
      tris.forEach(({ c }, f) => {
        if (side[f] !== SIDE_NONE) assert.equal(side[f], c[1] < 0 ? SIDE_LOWER : SIDE_UPPER, `${label}: triangle ${f} at y = ${c[1]}`);
        assert.ok(flags[f] & LEVEL);
      });
      // Trapped (undercuts): faces with draft that only the other half could
      // form; the faces of the pillars that face the line (2 × 8 × 12 mm²),
      // half of a side of the L in the shadow of a pillar.
      let trapped = 0;
      tris.forEach(({ c, n, area }, f) => {
        if (!(flags[f] & TRAPPED)) return;
        trapped += area;
        assert.equal(flags[f] & (REACH_UP | REACH_DOWN | ZERO_DRAFT), 0);
        assert.equal(side[f], SIDE_NONE);
        assert.ok(n[1] * c[1] < 0, `trapped on its own side: ${c}`);
        assert.ok(Math.abs(c[1]) >= 16, c.join());
      });
      approx(trapped, 2 * 8 * PLATE.pillarHeight + 1, 1e-6, 0, `${label}: trapped`);
      approx(summary.trapped_area_mm2, trapped, 0, 0.05, `${label}: trapped in the summary`);
      // Part of the undercut figure, with the bore and holes across Y and the shadows between details.
      assert.ok(summary.undercut_area_mm2 > trapped);
    }
  });

  test('the same plate along Z (its proposal): planar at its bottom face, round the plate and its three holes, no undercut', () => {
    for (const welded of [false, true]) {
      const plate = castPlate({ welded });
      const { proposal, segments } = proposeParting(plate.positions, plate.indices);
      assert.deepEqual([proposal.axis, proposal.undercut_area_mm2, proposal.trapped_area_mm2], ['Z', 0, 0]);
      assert.deepEqual([proposal.parting.kind, proposal.parting.level_mm, proposal.parting.loops], ['planar', 0, 4]);
      assert.equal(looseEnds(segments), 0);
      // Its line along Y, as typed by hand: the one above.
      assert.equal(byAxis(proposal).Y.parting.kind, 'planar');
    }
  });

  test('a stepped part with a block on a flat side: still stepped, a planar line would trap more than the shadows it avoids', () => {
    // The Z profile of the stepped part above, a block (5 mm cube) standing on
    // its flat front face at mid-height: the block's shadows split that face
    // (50 mm² in the lower half); a planar line would trap a flange (575 mm²).
    const profile = (x, y, z) => {
      const bottom = z < 1 && x < 4, web = x === 3, top = z >= 4 && x >= 3;
      const hole = y >= 3 && y < 5 && ((x === 1 && z < 1) || (x === 5 && z >= 4));
      return (bottom || web || top) && !hole;
    };
    const mesh = voxels((x, y, z) => (y >= 1 && profile(x, y - 1, z)) || (y === 0 && x === 3 && z === 2), [7, 9, 5], { size: 5 });
    const { summary } = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
    assert.deepEqual([summary.parting.kind, summary.undercut_area_mm2, summary.trapped_area_mm2], ['stepped', 0, 0]);
    assert.deepEqual(summary.parting.levels_mm, [0, 10, 20]);
  });

  test('a planar line across faces with draft: their parts on the side their half cannot reach trapped, as the plane cuts them', () => {
    // Drawn obliquely in its plane, the plate has no plane that leaves every
    // face on its side, and the warped line would split its top face: the
    // planar line. Any plane across the plate cuts its ±X walls (two long
    // triangles each, with draft: only the half each looks to can form it);
    // the part of each on the other side is trapped, whichever side of the
    // plane its centre is on.
    const plate = castPlate();
    const tris = triangleGeometry(plate.positions, plate.indices);
    const P = plate.positions, I = plate.indices;
    for (const d of [[0.6, 0.8, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]]) {
      const { summary, flags, plane } = evaluateParting(plate.positions, plate.indices, d);
      assert.equal(summary.parting.kind, 'planar', String(d));
      const height = (p) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
      let trapped = 0, unflagged = 0, cut = 0, undercut = 0;
      tris.forEach(({ area }, f) => {
        const reach = flags[f] & (REACH_UP | REACH_DOWN);
        if (!reach && !(flags[f] & TRAPPED)) undercut += area;
        if (!(flags[f] & TRAPPED) && ((reach !== REACH_UP && reach !== REACH_DOWN) || flags[f] & ZERO_DRAFT)) return;
        const corners = [0, 1, 2].map((k) => [0, 1, 2].map((c) => P[3 * I[3 * f + k] + c]));
        const below = areaWhere(corners, (p) => plane - height(p)), above = areaWhere(corners, (p) => height(p) - plane);
        approx(below + above, area, 1e-9, 1e-9);
        // Its part on the side its half cannot reach (below the plane for the upper half); flagged TRAPPED
        // (an undercut in the view, its reach cleared) when that is most of it.
        const wrong = flags[f] & TRAPPED ? Math.max(below, above) : reach === REACH_UP ? below : above;
        if (!(flags[f] & TRAPPED)) assert.ok(wrong <= area / 2, `triangle ${f}: ${wrong} of ${area} mm² on the wrong side`);
        trapped += wrong;
        if (wrong > 1e-9 && wrong < area - 1e-9) cut++;
        if (!(flags[f] & TRAPPED)) unflagged += wrong;
      });
      approx(summary.trapped_area_mm2, trapped, 0, 0.05, `${d}: trapped`);
      approx(summary.undercut_area_mm2, undercut + trapped, 0, 0.1, `${d}: undercut`);
      // Faces cut by the plane, with parts on the wrong side not flagged: counted too (a count by centres left them out).
      assert.ok(cut >= 4, `${d}: ${cut} faces cut`);
      assert.ok(unflagged > 50, `${d}: ${unflagged} mm²`);
    }
  });

  test('a planar line that would trap more than the warped line splits, counted to the plane: the warped line kept', () => {
    // 6° off Y, a plane at its best level would leave about 1230 mm² on the
    // side the halves cannot reach: 805 of it in the ±X walls it cuts (about
    // half of each wall on the side only the other half reaches; counted by
    // the centres of their two triangles, a wall was all or nothing), the
    // rest in whole faces; more than the 1000 mm² of flat faces the warped
    // line splits.
    const plate = castPlate();
    const d = [-0.105, 0.995, 0];
    const { summary, plane } = evaluateParting(plate.positions, plate.indices, d);
    assert.equal(plane, null);
    assert.notEqual(summary.parting.kind, 'planar');
    assert.equal(summary.trapped_area_mm2, 0);
  });

  test('the same triangles with their corners in another order, or wound the other way: the same halves and figures', () => {
    // The points of the lines of sight of a long triangle do not depend on the corner it starts with.
    const plate = castPlate();
    const I = plate.indices;
    const tris = triangleGeometry(plate.positions, I);
    const reorder = (order) => Uint32Array.from(I, (_, i) => I[i - (i % 3) + order[i % 3]]);
    for (const d of [[0, 1, 0], [0.6, 0.8, 0], [1, 0, 0]]) {
      const base = evaluateParting(plate.positions, I, d);
      for (const order of [[1, 2, 0], [2, 0, 1], [0, 2, 1]]) {
        const other = evaluateParting(plate.positions, reorder(order), d);
        assert.deepEqual(other.summary, base.summary, `${d}: corners ${order}`);
        assert.deepEqual(other.flags, base.flags, `${d}: corners ${order}`);
        assert.equal(other.plane, base.plane);
        // The halves too, but of the slivers without area (the half of a neighbour, any).
        tris.forEach(({ area }, f) => area > 1e-6 && assert.equal(other.side[f], base.side[f], `${d}: corners ${order}, triangle ${f}`));
      }
    }
  });

  test('lines of sight from several points of a long triangle: its halves by most of its area, not by its centre', () => {
    // A narrow pillar (2 mm across Y) on the plate: its shadows along ±Y on
    // the top face, strips 2 mm wide that long triangles of the face cross.
    const pillar = [20, 0, 22, 4];
    const plate = castPlate({ pillars: [pillar], letters: [], boss: false, holes: false });
    const { flags } = evaluateParting(plate.positions, plate.indices, [0, 1, 0]);
    const P = plate.positions, I = plate.indices;
    const across = [(p) => p[0] - pillar[0], (p) => pillar[2] - p[0]];
    let checked = 0, centreWrong = 0;
    for (let f = 0; f < I.length / 3; f++) {
      if (plate.face[f] !== plate.top) continue;
      const tri = [0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1]]);
      const area = clippedArea(tri, []);
      // Shares of it in the shadow behind the pillar along +Y (the upper half cannot form it), in front of it (the lower).
      const behind = clippedArea(tri, [...across, (p) => pillar[1] - p[1]]) / area;
      const before = clippedArea(tri, [...across, (p) => p[1] - pillar[3]]) / area;
      const c = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
      if (c[0] > pillar[0] && c[0] < pillar[2] && (c[1] < pillar[1] || c[1] > pillar[3]) && Math.max(behind, before) < 0.35) centreWrong++;
      for (const [share, bit] of [[behind, REACH_UP], [before, REACH_DOWN]]) {
        if (Math.abs(share - 0.5) < 0.15) continue;
        assert.equal(!!(flags[f] & bit), share < 0.5, `triangle ${f}: ${(100 * share).toFixed(0)} % in a shadow`);
        checked++;
      }
    }
    // Triangles whose centre is in a shadow but most of their area is not: their centre alone got them wrong.
    assert.ok(centreWrong >= 1, 'no triangle of that kind');
    assert.ok(checked >= 60, String(checked));
  });

  test('an undercut region between the halves: the line goes round it, it does not stop at it', () => {
    // Three cubes in a row along the draw direction X: the first in the lower
    // half, the last in the upper one, the middle one an undercut (a core)
    // between them. The line was nothing: the halves do not touch.
    const mesh = voxels(() => true, [3, 1, 1], { size: 10 });
    const tris = triangleGeometry(mesh.positions, mesh.indices);
    const side = Uint8Array.from(tris, ({ c }) => (c[0] < 10 ? SIDE_LOWER : c[0] > 20 ? SIDE_UPPER : SIDE_NONE));
    const flags = Uint8Array.from(side, (s) => (s === SIDE_UPPER ? REACH_UP : s === SIDE_LOWER ? REACH_DOWN : 0));
    const line = lineMesh(mesh.positions, mesh.indices);
    // No plane: the undercut region joins one half (ties: the upper one), the line round its border with the other.
    const round = partingLine(line, side, [1, 0, 0], { flags, height: 30 });
    assert.deepEqual([round.kind, round.loops, round.length_mm, round.level], ['planar', 1, 40, 10]);
    // The bottom of the middle cube in the lower half too: the undercut region's border with it longer, it joins it.
    const longer = side.map((s, f) => (s === SIDE_NONE && tris[f].c[2] === 0 ? SIDE_LOWER : s));
    const other = partingLine(line, longer, [1, 0, 0], { flags, height: 30 });
    assert.deepEqual([other.kind, other.loops, other.length_mm, other.level], ['planar', 1, 40, 20]);
    assert.equal(looseEnds(other.segments), 0);
    assert.equal(looseEnds(round.segments), 0);
    // A planar line across it: cut at its plane.
    const across = partingLine(line, side, [1, 0, 0], { flags: flags.map((f) => f | LEVEL), plane: 15, height: 30 });
    assert.deepEqual([across.kind, across.loops, across.length_mm, across.level], ['planar', 1, 40, 15]);
    assert.equal(looseEnds(across.segments), 0);
  });

  test('a face moved by hand on that planar line: the line along its edges, continuous; none moved, the line proposed', () => {
    const plate = castPlate();
    const base = evaluateParting(plate.positions, plate.indices, [0, 1, 0]);
    const { region } = faceRegions(plate.positions, plate.indices, { brep: true });
    const top = region[plate.face.indexOf(plate.top)];
    const moved = applyOverrides(base.side, region, { [top]: SIDE_LOWER });
    const fixed = Uint8Array.from(region, (r) => (r === top ? 1 : 0));
    const line = lineMesh(plate.positions, plate.indices);
    const l = partingLine(line, moved, [0, 1, 0], { flags: base.flags, plane: base.plane, fixed, height: base.summary.mould_height_mm });
    assert.equal(l.planar, false);
    assert.equal(looseEnds(l.segments), 0);
    // The top face no longer cut: its pieces at its height all along its border (its outline, its holes).
    const P = plate.positions, I = plate.indices;
    const border = [];
    for (let f = 0; f < I.length / 3; f++) {
      if (plate.face[f] !== plate.top) continue;
      for (let e = 0; e < 3; e++) {
        const g = line.neighbours[3 * f + e];
        if (g >= 0 && plate.face[g] === plate.top) continue;
        border.push([I[3 * f + e], I[3 * f + ((e + 1) % 3)]].map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]));
      }
    }
    const onEdge = (p, [a, b]) => {
      const ab = [0, 1, 2].map((k) => b[k] - a[k]), ap = [0, 1, 2].map((k) => p[k] - a[k]);
      const t = (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
      return t > -1e-6 && t < 1 + 1e-6 && Math.hypot(...[0, 1, 2].map((k) => ap[k] - t * ab[k])) < 1e-4;
    };
    let onTop = 0;
    for (let i = 0; i < l.segments.length; i += 6) {
      const a = l.segments.subarray(i, i + 3), b = l.segments.subarray(i + 3, i + 6);
      if (Math.abs(a[2] - PLATE.thickness) > 1e-4 || Math.abs(b[2] - PLATE.thickness) > 1e-4) continue;
      onTop++;
      assert.ok(border.some((edge) => onEdge(a, edge) && onEdge(b, edge)), `piece across the top face: ${a} ${b}`);
    }
    assert.ok(onTop > 0);
    const back = partingLine(line, applyOverrides(base.side, region, {}), [0, 1, 0], { flags: base.flags, plane: base.plane, height: base.summary.mould_height_mm });
    assert.deepEqual(lineSummary(back), base.summary.parting);
  });
});

/**
 * The shape of a line from its pieces (ends within 1e-4 mm), its pieces in a
 * straight row merged into runs: `reversals`, the points where two runs turn
 * back by more than 135° (a zigzag along long triangles, a spike round one);
 * `teeth`, the runs shorter than 3 mm at such a point (a notch, a tooth along
 * the short edges of triangles); `combs`, the runs (1 mm long at least) along
 * another within 3° and 1 mm of it over half their length (the parallel lines
 * of a comb across a band of long thin triangles, the two sides of a spike).
 */
function shapeOfLine(segments) {
  const m = segments.length / 6;
  const key = (j) => `${Math.round(segments[j] * 1e4)},${Math.round(segments[j + 1] * 1e4)},${Math.round(segments[j + 2] * 1e4)}`;
  const at = (j) => [segments[j], segments[j + 1], segments[j + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(...a);
  const other = (j) => (j % 6 === 0 ? j + 3 : j - 3);
  const ends = new Map();
  for (let j = 0; j < segments.length; j += 3) (ends.get(key(j)) ?? ends.set(key(j), []).get(key(j))).push(j);
  // Runs: pieces in a row (turning by less than 1°) merged.
  const root = Int32Array.from({ length: m }, (_, k) => k);
  const find = (k) => (root[k] === k ? k : (root[k] = find(root[k])));
  const bends = [];
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const [u, v] = list.map((j) => sub(at(other(j)), at(j)));
    const turn = dot(u, v) / (len(u) * len(v));
    if (turn < -Math.cos(Math.PI / 180)) root[find(list[0] / 6 | 0)] = find(list[1] / 6 | 0);
    else bends.push([list[0], list[1], turn]);
  }
  const length = new Float64Array(m);
  for (let k = 0; k < m; k++) length[find(k)] += len(sub(at(6 * k + 3), at(6 * k)));
  let reversals = 0;
  const teeth = new Set();
  for (const [a, b, turn] of bends) {
    if (turn <= Math.cos(Math.PI / 4)) continue;
    reversals++;
    for (const j of [a, b]) if (length[find(j / 6 | 0)] < 3) teeth.add(find(j / 6 | 0));
  }
  // The ends of each run: the ends of its pieces not inside it.
  const runEnds = new Map();
  for (let j = 0; j < segments.length; j += 3) {
    const r = find(j / 6 | 0);
    const list = ends.get(key(j));
    if (list.length === 2 && find(list[0] / 6 | 0) === find(list[1] / 6 | 0)) continue;
    (runEnds.get(r) ?? runEnds.set(r, []).get(r)).push(at(j));
  }
  const runs = [...runEnds].filter(([r, e]) => e.length === 2 && length[r] >= 1).map(([, [a, b]]) => ({ a, b, l: len(sub(b, a)) }));
  // A run along a longer one: within 3° of it, over half its length, 1 mm off it at most.
  const along = (s, t) => {
    const u = sub(t.b, t.a).map((x) => x / t.l), w = sub(s.b, s.a);
    if (Math.abs(dot(u, w)) < Math.cos((3 * Math.PI) / 180) * s.l) return false;
    const ta = dot(sub(s.a, t.a), u), tb = dot(sub(s.b, t.a), u);
    const overlap = Math.min(Math.max(ta, tb), t.l) - Math.max(Math.min(ta, tb), 0);
    const off = (p, tp) => len(sub(sub(p, t.a), u.map((x) => x * tp)));
    return overlap >= s.l / 2 && Math.max(off(s.a, ta), off(s.b, tb)) < 1;
  };
  const comb = new Uint8Array(runs.length);
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length; k++) {
      const [s, t] = runs[i].l < runs[k].l ? [runs[i], runs[k]] : [runs[k], runs[i]];
      if (along(s, t)) comb[i] = comb[k] = 1;
    }
  }
  const combs = comb.reduce((n, c) => n + c, 0);
  return { reversals, teeth: teeth.size, combs };
}

/** Faces (B-rep) whose triangles are in both halves; undercuts (SIDE_NONE) left out. */
function facesSplit(face, side) {
  const halves = new Map();
  face.forEach((r, f) => {
    if (side[f] === SIDE_NONE) return;
    (halves.get(r) ?? halves.set(r, new Set()).get(r)).add(side[f]);
  });
  return [...halves].filter(([, s]) => s.size > 1).map(([r]) => r);
}

describe('curved faces and faces along the draw direction of a CAD body (long, thin, grazing triangles)', () => {
  test('flat walls along d across the frame: one half each, not one long triangle in two (no zigzag, no comb, no small loop)', () => {
    // The Z bracket turned 20° about Z: n·d of the long triangles of its caps
    // (exact planes along Z) is off 0 by up to ±1e-5 (float32 positions);
    // compared with a tie of 1e-6, one triangle in two went to the lower
    // half: a warped line of 945 mm in 4 loops, zigzagging across the caps
    // (17 points turning back). Now the line of the bracket unturned: round
    // the bottom face, up the web under the upper flange, round its
    // underside.
    for (const turn of [20, 0]) {
      const part = zBracket({ turn });
      const { summary, side, segments } = evaluateParting(part.positions, part.indices, [0, 0, 1]);
      const label = `turned ${turn}°`;
      assert.deepEqual([summary.parting.kind, summary.parting.loops, summary.parting.levels_mm], ['stepped', 1, [0, 22]], label);
      approx(summary.parting.length_mm, 2 * 46 + 40 + 2 * 22 + 2 * 34 + 40, 0, 1e-6, `${label}: length`);
      assert.deepEqual(shapeOfLine(segments), { reversals: 0, teeth: 0, combs: 0 }, label);
      assert.equal(looseEnds(segments), 0, label);
      assert.deepEqual(facesSplit(part.face, side), [], label);
      // Its caps (faces 0 and 1) in the upper half, whole.
      part.face.forEach((r, f) => r < 2 && assert.equal(side[f], SIDE_UPPER, `${label}: cap triangle ${f}`));
    }
  });

  test('a boss with 0.5° of draft meshed in staggered rows: no undercut on it, all of it in the upper half', () => {
    // The facets of its rows lean by about ±1°; the lines along +d from the
    // middle of one met the top of the boss, whose outline stands off them by
    // the sagitta of its facets (more than its draft takes in): 456.8 mm² of
    // undercut on the boss. Now from off its surface by that stand-off.
    const part = zBracket({ turn: 0 });
    const boss = part.faces - 2; // its cone, then its top
    const { summary, side, flags } = evaluateParting(part.positions, part.indices, [0, 0, 1]);
    assert.equal(summary.undercut_area_mm2, 0);
    part.face.forEach((r, f) => {
      if (r < boss) return;
      assert.ok(flags[f] & REACH_UP, `triangle ${f}`);
      assert.equal(side[f], SIDE_UPPER, `triangle ${f}`);
    });
    // Its wall without draft for 1°: zero draft.
    approx(summary.zero_draft_area_mm2, 4208, 0, 0.05, 'zero draft');
  });

  test('across a curved face, the line along its silhouette (n·d = 0 between the corners of its triangles), not along their staggered edges', () => {
    // The bracket turned 20° drawn along X (and Y): the halves meet on the
    // boss down two generators of its cone. Along the edges of its staggered
    // rows the line was up to 1.8 mm off them, in teeth. (Along X the line
    // turns back once, by 159°, where the edge of the boss's shadow on the
    // flange meets the edge of the cap at 20°: the corner of a wedge of the
    // flange 25 mm long, not a tooth.)
    const part = zBracket();
    const { x, y, r } = BRACKET.boss;
    const t = (20 * Math.PI) / 180;
    const cx = Math.cos(t) * x - Math.sin(t) * y, cy = Math.sin(t) * x + Math.cos(t) * y;
    for (const d of [[1, 0, 0], [0, 1, 0]]) {
      const { summary, segments, flags } = evaluateParting(part.positions, part.indices, d);
      let along = 0, worst = 0;
      for (let i = 0; i < segments.length; i += 6) {
        const ends = [i, i + 3].map((j) => [segments[j], segments[j + 1], segments[j + 2]]);
        if (!ends.every((p) => p[2] > 30.2 && p[2] < 41.8 && Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r) < 0.5)) continue;
        along += Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1], ends[1][2] - ends[0][2]);
        for (const p of ends) worst = Math.max(worst, Math.abs((p[0] - cx) * d[0] + (p[1] - cy) * d[1]));
      }
      assert.ok(along > 20, `${d}: ${along} mm on the boss`);
      assert.ok(worst < 0.01, `${d}: ${worst} mm off the silhouette`);
      assert.ok([...flags].some((f) => f & SILHOUETTE), `${d}: triangles cut by the silhouette`);
      const { teeth, combs } = shapeOfLine(segments);
      assert.deepEqual([teeth, combs, looseEnds(segments)], [0, 0, 0], String(d));
      assert.equal(summary.parting.loops, 1, String(d));
    }
  });

  test('the edge of a shadow across a fan of long triangles: straight across them, not a staircase along their edges', () => {
    // The cap of the mushroom overhangs its base beyond x = 30: along Z, its
    // underside over the base is an undercut (joined to the upper half), the
    // rest of it the lower half. The line between them went along the long
    // triangles of the cap's underside, up to 5 mm off x = 30; now across
    // them where the lines of sight change.
    const part = mushroom();
    const { summary, segments, flags } = evaluateParting(part.positions, part.indices, [0, 0, 1]);
    const { stem, cap } = MUSHROOM;
    let across = 0, worst = 0;
    for (let i = 0; i < segments.length; i += 6) {
      const ends = [i, i + 3].map((j) => [segments[j], segments[j + 1], segments[j + 2]]);
      // Pieces on the underside (z = 25), not along its rim.
      const mid = [0, 1].map((k) => (ends[0][k] + ends[1][k]) / 2);
      if (!ends.every((p) => Math.abs(p[2] - stem.top) < 1e-4) || Math.hypot(mid[0] - stem.x, mid[1] - stem.y) > cap.r - 0.05) continue;
      across += Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
      for (const p of ends) worst = Math.max(worst, Math.abs(p[0] - 30));
    }
    // The chord x = 30 of the underside (a 72-gon of radius 25): 39.944 mm
    // (it was 58 mm in steps, 8.5 mm off x = 30 at worst).
    approx(across, 39.944, 0, 0.05, 'across the underside');
    assert.ok(worst < 0.2, `${worst} mm off x = 30`);
    assert.ok([...flags].some((f) => f & SHADOW));
    assert.deepEqual([summary.parting.kind, summary.parting.loops, looseEnds(segments)], ['stepped', 2, 0]);
    assert.deepEqual(shapeOfLine(segments), { reversals: 0, teeth: 0, combs: 0 });
    approx(summary.undercut_area_mm2, 3212.5, 0, 0.05, 'undercut');
  });

  test('the edge of a shadow across the long strips of a cylinder, obliquely: a curve across them, not a comb along them', () => {
    // The peg over the ledge: its underside over the ledge an undercut, beyond
    // it the lower half. Each strip of the cylinder (two triangles 50 mm long)
    // was in two, one triangle undercut and the other in the lower half: the
    // undercut joined to the lower half for its long border with it (the
    // long edges of the strips), the line round it along the wall and spikes
    // along the strips (518 mm in all). Now the undercut in the upper half
    // (its border with the lower one across the strips, not along them) and
    // the line along the edge of the ledge's shadow, x = 25 + 0.4 y.
    const part = peg();
    const { summary, segments } = evaluateParting(part.positions, part.indices, [0, 0, 1]);
    const { ledge, peg: g } = PEG;
    const front = (y) => (ledge.front[0] + ledge.front[1]) / 2 + ((ledge.front[1] - ledge.front[0]) / (2 * PEG.wall.y)) * y;
    let across = 0, worst = 0;
    for (let i = 0; i < segments.length; i += 6) {
      const ends = [i, i + 3].map((j) => [segments[j], segments[j + 1], segments[j + 2]]);
      // Not on the wall (x = 0), the end of the peg (x = 50), the bottom.
      assert.ok(!ends.every((p) => Math.abs(p[0]) < 1e-4 && p[2] > 1e-4), `a piece on the wall: ${ends}`);
      if (!ends.every((p) => p[0] > 1 && p[0] < g.length - 1 && p[2] > 1e-4)) continue;
      across += Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1], ends[1][2] - ends[0][2]);
      for (const p of ends) worst = Math.max(worst, Math.abs(p[0] - front(p[1])));
    }
    // The plane x = 25 + 0.4 y across the facets of the underside between those
    // next to its silhouettes (z = 30): 21.9 mm; across those too: 26.0 mm.
    const chord = (from, to) => {
      let sum = 0;
      for (let k = from; k < to; k++) {
        const at = (i) => {
          const a = (2 * Math.PI * i) / g.segments, y = g.r * Math.cos(a), z = g.z + g.r * Math.sin(a);
          return [front(y), y, z];
        };
        const [p, q] = [at(k), at(k + 1)];
        sum += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      }
      return sum;
    };
    assert.ok(across > chord(13, 23) && across < chord(12, 24), `${across} mm across the underside`);
    assert.ok(worst < 0.15, `${worst} mm off the edge of the shadow`);
    assert.deepEqual([summary.parting.loops, looseEnds(segments)], [2, 0]);
    assert.deepEqual(shapeOfLine(segments), { reversals: 0, teeth: 0, combs: 0 });
    approx(summary.parting.length_mm, 271.1, 0, 0.5, 'length');
  });

  test('a planar line across cylinders along d: on their silhouettes, the edges between their facets there', () => {
    // The mushroom along X and Y: the silhouettes of its stem and of the rim
    // of its cap are generators through their vertices (x = 15, y = 0). The
    // planar line was one facet of the stem off them (x = 13.45, y = -1.55):
    // a facet facing -d in the upper half.
    const part = mushroom();
    for (const [d, level] of [[[1, 0, 0], 15], [[0, 1, 0], 0]]) {
      const { summary, plane } = evaluateParting(part.positions, part.indices, d);
      assert.equal(summary.parting.kind, 'planar', String(d));
      approx(plane, level, 0, 1e-9, `${d}: plane`);
      approx(summary.parting.length_mm, 256, 0, 0.05, `${d}: length`);
    }
  });

  test('a stepped line whose climbs are cut into short pieces (a silhouette across a fine mesh): still stepped, at its levels', () => {
    // Round a 40 × 40 square at z = 0 on two sides and z = 10 on the other
    // two, climbing in pieces 0.1 mm high: each piece level within the
    // tolerance (0.5 mm), their heights chained from 0 to 10 in one level
    // (warped). The levels are each within the tolerance of their lowest run.
    const pieces = [];
    const to = (a, b) => pieces.push(...a, ...b);
    const climb = (x, y, up) => {
      for (let k = 0; k < 100; k++) to([x, y, up ? k / 10 : 10 - k / 10], [x, y, up ? (k + 1) / 10 : 10 - (k + 1) / 10]);
    };
    to([0, 0, 0], [40, 0, 0]);
    climb(40, 0, true);
    to([40, 0, 10], [40, 40, 10]);
    to([40, 40, 10], [0, 40, 10]);
    climb(0, 40, false);
    to([0, 40, 0], [0, 0, 0]);
    const shape = lineShape(Float64Array.from(pieces), [0, 0, 1], { height: 10, loops: 1 });
    assert.equal(shape.kind, 'stepped');
    assert.equal(shape.levels.length, 2);
    approx(shape.levels[0], 0, 0, 0.01, 'low level');
    approx(shape.levels[1], 10, 0, 0.01, 'high level');
  });

  test('the line of a split cut by silhouettes and shadows: the same from partingLine on the halves and flags (as the page draws it), closed with a face moved by hand', () => {
    for (const [part, d] of [[zBracket(), [1, 0, 0]], [mushroom(), [0, 0, 1]], [peg(), [0, 0, 1]]]) {
      const { summary, side, flags, plane, segments } = evaluateParting(part.positions, part.indices, d);
      const line = lineMesh(part.positions, part.indices);
      const again = partingLine(line, side, d, { flags, plane, height: summary.mould_height_mm });
      assert.deepEqual(lineSummary(again), summary.parting);
      assert.deepEqual(again.segments, segments);
      // Every face moved to the other half in turn: a closed line.
      const { region, count } = faceRegions(part.positions, part.indices, { brep: true });
      for (let face = 0; face < count; face++) {
        const fixed = Uint8Array.from(region, (r) => (r === face ? 1 : 0));
        const half = side[region.indexOf(face)] === SIDE_UPPER ? SIDE_LOWER : SIDE_UPPER;
        const moved = applyOverrides(side, region, { [face]: half });
        const l = partingLine(line, moved, d, { flags, plane, fixed, height: summary.mould_height_mm });
        assert.equal(looseEnds(l.segments), 0, `${d}: face ${face} moved`);
      }
    }
  });

  test('the same halves and line twice, whatever the order of the corners of the triangles', () => {
    const part = zBracket();
    const I = part.indices;
    const base = evaluateParting(part.positions, I, [1, 0, 0]);
    assert.deepEqual(evaluateParting(part.positions, I, [1, 0, 0]).segments, base.segments);
    const reordered = Uint32Array.from(I, (_, i) => I[i - (i % 3) + [1, 2, 0][i % 3]]);
    const other = evaluateParting(part.positions, reordered, [1, 0, 0]);
    assert.deepEqual(other.summary, base.summary);
    assert.deepEqual(other.side, base.side);
    assert.deepEqual(other.flags, base.flags);
  });
});

/** The pieces of partingPieces: [{k, f, pts (xyz), half, undercut, near}]. */
function piecesList(pc) {
  return Array.from({ length: pc.count }, (_, k) => {
    const pts = [];
    for (let j = pc.start[k]; j < pc.start[k + 1]; j++) pts.push([pc.points[3 * j], pc.points[3 * j + 1], pc.points[3 * j + 2]]);
    return { k, f: pc.tri[k], pts, half: pc.half[k], undercut: pc.undercut[k] === 1, near: pc.near[k] };
  });
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The normal of a polygon (xyz) times twice its area. */
const polygonNormal = (pts) => pts.slice(1, -1).reduce((s, p, k) => cross3(sub3(p, pts[0]), sub3(pts[k + 2], pts[0])).map((x, c) => x + s[c]), [0, 0, 0]);
const polygonArea = (pts) => Math.hypot(...polygonNormal(pts)) / 2;
/** Distance from p to the segment ab. */
function segmentDistance(p, a, b) {
  const ab = sub3(b, a), ap = sub3(p, a);
  const l = dot3(ab, ab);
  const t = l > 0 ? Math.max(0, Math.min(1, dot3(ap, ab) / l)) : 0;
  return Math.hypot(...sub3(ap, ab.map((x) => x * t)));
}

/**
 * The pieces of a split as its line cuts them: those of each triangle cover
 * it (their areas its own within 1e-9), convex and wound as it is; every side
 * of one with a piece of the other half beyond it (a point 1e-4 mm off its
 * middle) on the line, its ends and middle within 1e-6 of the size of the
 * part off a segment; along an edge of its triangle, the half of the
 * triangle beyond it when that one is not cut (nor an undercut, nor without
 * area), unless the line runs there. Returns {list, byTri, boundary (length of
 * the sides between the halves), cut (the triangles cut)}.
 */
function assertPieces(part, ev, line, pc, label) {
  const P = part.positions, I = part.indices;
  const list = piecesList(pc);
  const byTri = new Map();
  for (const x of list) (byTri.get(x.f) ?? byTri.set(x.f, []).get(x.f)).push(x);
  const corners = (f) => [0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1], P[3 * I[3 * f + k] + 2]]);
  const lo = [0, 1, 2].map((c) => Math.min(...P.filter((_, i) => i % 3 === c))), hi = [0, 1, 2].map((c) => Math.max(...P.filter((_, i) => i % 3 === c)));
  const tol = 1e-6 * Math.hypot(...sub3(hi, lo));
  const S = [];
  for (let i = 0; i < ev.segments.length; i += 6) S.push([[...ev.segments.subarray(i, i + 3)], [...ev.segments.subarray(i + 3, i + 6)]]);
  const offLine = (p) => Math.min(...S.map(([a, b]) => segmentDistance(p, a, b)));
  let boundary = 0;
  for (const [f, pieces] of byTri) {
    const V = corners(f);
    const n = cross3(sub3(V[1], V[0]), sub3(V[2], V[0]));
    const A = Math.hypot(...n) / 2;
    const unit = n.map((x) => x / (2 * A));
    approx(pieces.reduce((s, x) => s + polygonArea(x.pts), 0), A, 1e-9, 1e-12, `${label}: the pieces of triangle ${f}`);
    // A point inside a convex piece: on the left of each of its sides.
    const inside = (pts, p) => pts.every((a, i) => dot3(cross3(sub3(pts[(i + 1) % pts.length], a), sub3(p, a)), unit) >= -1e-12);
    for (const x of pieces) {
      const m = polygonNormal(x.pts);
      if (Math.hypot(...m) > 1e-9 * A) assert.ok(dot3(m, n) > 0, `${label}: piece ${x.k} wound as triangle ${f}`);
      x.pts.forEach((p, i) => {
        const q = x.pts[(i + 1) % x.pts.length];
        const l = Math.hypot(...sub3(q, p));
        if (l < 1e-9) return;
        let edge = -1;
        for (let e = 0; e < 3; e++) if (segmentDistance(p, V[e], V[(e + 1) % 3]) < tol && segmentDistance(q, V[e], V[(e + 1) % 3]) < tol) edge = e;
        const mid = p.map((c, k) => (c + q[k]) / 2);
        if (edge < 0) {
          const out = cross3(unit, sub3(q, p)).map((c) => (-c / l) * Math.min(1e-4, l / 10));
          const beyond = pieces.find((y) => y !== x && inside(y.pts, mid.map((c, k) => c + out[k])));
          assert.ok(beyond, `${label}: a piece beyond the side ${p} ${q} of piece ${x.k}`);
          if (beyond.half === x.half) return;
          boundary += l / 2; // each side seen from both pieces
          for (const r of [p, q, mid]) assert.ok(offLine(r) <= tol, `${label}: triangle ${f}, ${r} off the line by ${offLine(r)}`);
        } else {
          const g = line.neighbours[3 * f + edge];
          if (g < 0 || byTri.has(g) || ev.side[g] === SIDE_NONE || polygonArea(corners(g)) < 1e-9) return;
          if (ev.side[g] !== x.half) assert.ok(offLine(mid) <= tol, `${label}: piece ${x.k} of triangle ${f} beside triangle ${g} of the other half, no line there`);
        }
      });
    }
  }
  return { list, byTri, boundary, cut: [...byTri.keys()] };
}

describe('the colours of the halves cut along the line', () => {
  test('a plane across long triangles of faces with draft: their parts on the side their half cannot reach in the colour of the undercuts, as the figure counts them', () => {
    // The plate drawn obliquely: the plane cuts its ±X walls (two long
    // triangles each) and the triangles round its holes; the trapped part of
    // each (trapAtLevel) was coloured with its triangle (a triangle all yellow
    // or all grey by the larger part), now cut on the line: the undercut
    // area coloured is the figure of the card.
    const plate = castPlate();
    const line = lineMesh(plate.positions, plate.indices);
    const P = plate.positions, I = plate.indices;
    for (const d of [[0.6, 0.8, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]]) {
      const ev = evaluateParting(plate.positions, plate.indices, d);
      const pc = partingPieces(line, ev.side, d, { flags: ev.flags, plane: ev.plane, height: ev.summary.mould_height_mm });
      const { list, byTri, boundary } = assertPieces(plate, ev, line, pc, String(d));
      assert.ok(byTri.size >= 20 && boundary > 150, `${d}: ${byTri.size} triangles cut, ${boundary} mm between the halves`);
      const height = (p) => dot3(p, d);
      let coloured = 0, staircase = 0;
      for (let f = 0; f < I.length / 3; f++) {
        if (byTri.has(f)) continue;
        if (!(ev.flags[f] & (REACH_UP | REACH_DOWN))) coloured += polygonArea([0, 1, 2].map((k) => [...P.subarray(3 * I[3 * f + k], 3 * I[3 * f + k] + 3)]));
      }
      for (const x of list) {
        if (!x.undercut) continue;
        coloured += polygonArea(x.pts);
        const reach = ev.flags[x.f] & (REACH_UP | REACH_DOWN);
        // On the side of the plane its half cannot reach (an undercut triangle: wherever).
        if (reach === REACH_UP) x.pts.forEach((p) => assert.ok(height(p) <= ev.plane + 1e-6, `${d}: piece ${x.k} above the plane`));
        if (reach === REACH_DOWN) x.pts.forEach((p) => assert.ok(height(p) >= ev.plane - 1e-6, `${d}: piece ${x.k} under the plane`));
        if (reach) staircase += polygonArea(x.pts);
      }
      approx(coloured, ev.summary.undercut_area_mm2, 0, 0.1, `${d}: the undercuts coloured`);
      // Trapped parts of triangles not flagged (less than half of each, grey with their triangles before).
      assert.ok(staircase > 50, `${d}: ${staircase} mm²`);
    }
  });

  test('a plane across a fan of long triangles of a flat face along d: its two halves, each part an undercut as its triangle', () => {
    const plate = castPlate();
    const line = lineMesh(plate.positions, plate.indices);
    const ev = evaluateParting(plate.positions, plate.indices, [0, 1, 0]);
    const pc = partingPieces(line, ev.side, [0, 1, 0], { flags: ev.flags, plane: ev.plane, height: ev.summary.mould_height_mm });
    const { list } = assertPieces(plate, ev, line, pc, 'along Y');
    // The top and bottom faces cut at y = 0: the upper half on the +Y side.
    const flat = list.filter((x) => x.pts.every((p) => Math.abs(p[2]) < 1e-6 || Math.abs(p[2] - PLATE.thickness) < 1e-6));
    assert.ok(flat.length >= 8);
    for (const x of flat) {
      const y = x.pts.reduce((s, p) => s + p[1], 0) / x.pts.length;
      assert.equal(x.half, y > 0 ? SIDE_UPPER : SIDE_LOWER, `piece ${x.k} at y = ${y}`);
      // The shadows of the boss and the bore along Y, undercuts on either side of the plane.
      assert.equal(x.undercut, !(ev.flags[x.f] & (REACH_UP | REACH_DOWN)), `piece ${x.k}`);
    }
  });

  test('across a curved face, the halves cut along its silhouette', () => {
    const part = zBracket();
    const line = lineMesh(part.positions, part.indices);
    for (const d of [[1, 0, 0], [0, 1, 0]]) {
      const ev = evaluateParting(part.positions, part.indices, d);
      const pc = partingPieces(line, ev.side, d, { flags: ev.flags, plane: ev.plane, height: ev.summary.mould_height_mm });
      const { byTri, boundary } = assertPieces(part, ev, line, pc, String(d));
      const band = [...byTri.keys()].filter((f) => ev.flags[f] & SILHOUETTE);
      assert.ok(band.length >= 8, `${d}: ${band.length} triangles cut by the silhouette`);
      assert.ok(boundary > 20, `${d}: ${boundary} mm`);
      assert.equal(pc.undercut.some((u) => u), false);
    }
  });

  test('the edge of a shadow across a fan and across the strips of a cylinder: the undercut coloured to the chord', () => {
    // The mushroom's cap over its base (x < 30) and the peg's underside over
    // the ledge (x < 25 + 0.4 y): undercuts, joined to the upper half, the rest
    // the lower half. By triangle, the colour of the undercut went past the
    // line along the long triangles, or stopped short of it (151 mm²
    // of the cap's underside, 260 mm² of the peg's, coloured otherwise than
    // their side); cut on the chords, it ends on the line.
    const front = (y) => (PEG.ledge.front[0] + PEG.ledge.front[1]) / 2 + ((PEG.ledge.front[1] - PEG.ledge.front[0]) / (2 * PEG.wall.y)) * y;
    for (const [name, part, edge, onFace] of [
      ['mushroom', mushroom(), () => 30, (p) => Math.abs(p[2] - MUSHROOM.stem.top) < 1e-4],
      // (Of the peg, its underside: up to its sides, its facets reach up, grazing it.)
      ['peg', peg(), (p) => front(p[1]), (p) => Math.abs(Math.hypot(p[1], p[2] - PEG.peg.z) - PEG.peg.r) < 0.5 && p[2] < PEG.peg.z - PEG.peg.r / 4],
    ]) {
      const line = lineMesh(part.positions, part.indices);
      const ev = evaluateParting(part.positions, part.indices, [0, 0, 1]);
      const pc = partingPieces(line, ev.side, [0, 0, 1], { flags: ev.flags, plane: ev.plane, height: ev.summary.mould_height_mm });
      const { list, byTri } = assertPieces(part, ev, line, pc, name);
      assert.ok([...byTri.keys()].every((f) => ev.flags[f] & SHADOW), `${name}: cut across the edges of shadows only`);
      let pieces = 0, wrong = 0, worst = 0;
      for (const x of list) {
        if (!x.pts.every(onFace)) continue;
        pieces++;
        // The undercut on the side of the shadow; a piece of an undercut triangle out of it, or of a triangle of the lower half in it.
        const c = x.pts.reduce((s, p) => s.map((v, k) => v + p[k] / x.pts.length), [0, 0, 0]);
        assert.equal(x.undercut, c[0] < edge(c), `${name}: piece ${x.k} of triangle ${x.f} at x = ${c[0]}`);
        if (x.undercut !== !(ev.flags[x.f] & (REACH_UP | REACH_DOWN))) wrong += polygonArea(x.pts);
        // An undercut piece takes the colour of an undercut triangle beside it (its slide zone).
        if (x.undercut) assert.ok(x.near >= 0 && !(ev.flags[x.near] & (REACH_UP | REACH_DOWN)), `${name}: piece ${x.k}, near ${x.near}`);
        for (const p of x.pts) if (Math.abs(p[0] - edge(p)) < 0.5) worst = Math.max(worst, Math.abs(p[0] - edge(p)));
      }
      assert.ok(pieces >= 16, `${name}: ${pieces} pieces`);
      assert.ok(worst < 0.2, `${name}: a corner of a piece ${worst} mm off the edge of the shadow`);
      assert.ok(wrong > 100, `${name}: ${wrong} mm² coloured otherwise than its triangle`);
    }
  });

  test('nothing to cut for a line along the edges; the same pieces twice; as triangles, their areas', () => {
    const block = voxels(() => true, [4, 3, 2], { size: 5 });
    const flat = evaluateParting(block.positions, block.indices, [0, 0, 1]);
    const blockLine = lineMesh(block.positions, block.indices);
    assert.equal(partingPieces(blockLine, flat.side, [0, 0, 1], { flags: flat.flags, plane: flat.plane, height: 10 }).count, 0);
    const part = mushroom();
    const line = lineMesh(part.positions, part.indices);
    const ev = evaluateParting(part.positions, part.indices, [0, 0, 1]);
    const options = { flags: ev.flags, plane: ev.plane, height: ev.summary.mould_height_mm };
    const pc = partingPieces(line, ev.side, [0, 0, 1], options);
    assert.deepEqual(partingPieces(lineMesh(part.positions, part.indices), ev.side, [0, 0, 1], options), pc);
    // The line itself as partingLine gives it.
    assert.deepEqual(partingLine(line, ev.side, [0, 0, 1], options).segments, ev.segments);
    const { corners, piece } = pieceTriangles(pc);
    const areas = new Float64Array(pc.count);
    for (let t = 0; t < piece.length; t++) areas[piece[t]] += polygonArea([0, 1, 2].map((j) => [...corners.subarray(9 * t + 3 * j, 9 * t + 3 * j + 3)]));
    piecesList(pc).forEach((x) => approx(areas[x.k], polygonArea(x.pts), 1e-9, 1e-12, `piece ${x.k}`));
    // A polygon not convex (the part of a drawn line round a point clicked): an L of three squares.
    const L = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    const tris = pieceTriangles({ count: 1, start: Uint32Array.from([0, 6]), points: Float64Array.from(L.flat()) });
    assert.equal(tris.piece.length, 4);
    let sum = 0;
    for (let t = 0; t < 4; t++) {
      const n = polygonNormal([0, 1, 2].map((j) => [...tris.corners.subarray(9 * t + 3 * j, 9 * t + 3 * j + 3)]));
      assert.ok(n[2] > 0, 'wound as the polygon');
      sum += n[2] / 2;
    }
    approx(sum, 3, 1e-12, 0, 'the L');
  });
});

describe('faces reassigned by hand', () => {
  test('the faces of a CAD body, else regions of triangles between sharp edges', () => {
    const cad = prism([[0, 0], [100, 0], [100, 20], [0, 20]], 60, [50, 10]);
    assert.equal(faceRegions(cad.positions, cad.indices, { brep: true }).count, 6);
    const mesh = voxels(() => true, [10, 6, 2], { size: 10, subdivide: 2 });
    const { region, count } = faceRegions(mesh.positions, mesh.indices);
    assert.equal(count, 6);
    assert.equal(region.length, mesh.indices.length / 3);
    // Numbered in the order of their first triangle.
    assert.equal(region[0], 0);
  });

  test('a face moved to the lower half: the line follows the boundary between the halves', () => {
    const mesh = prism([[0, 0], [100, 0], [100, 20], [0, 20]], 60, [50, 10]);
    const { proposal, side, flags, plane } = proposeParting(mesh.positions, mesh.indices);
    assert.equal(proposal.axis, 'Z');
    const { region } = faceRegions(mesh.positions, mesh.indices, { brep: true });
    // The front face (y = 0): the first face of the prism.
    const front = region[0];
    const overrides = { [front]: SIDE_LOWER };
    const moved = applyOverrides(side, region, overrides);
    assert.ok([...moved].every((s, f) => (region[f] === front ? s === SIDE_LOWER : s === side[f])));
    const fixed = Uint8Array.from(region, (r) => (r === front ? 1 : 0));
    const line = partingLine(lineMesh(mesh.positions, mesh.indices), moved, proposal.direction, { flags, plane, fixed, height: 20 });
    const summary = lineSummary(line);
    // The top edge of the front face and its two ends, then the bottom edge of the three other sides.
    assert.deepEqual([summary.planar, summary.kind, summary.height_range_mm, summary.loops], [false, 'stepped', 20, 1]);
    approx(summary.length_mm, 100 + 2 * 20 + (60 + 100 + 60), 1e-9, 0, 'length');
    assert.deepEqual(summary.levels_mm, [0, 20]);
    // Back to the proposal: no face moved.
    const back = partingLine(lineMesh(mesh.positions, mesh.indices), applyOverrides(side, region, {}), proposal.direction, { flags, plane, height: 20 });
    assert.deepEqual(lineSummary(back), proposal.parting);
  });

  test('directions typed in: components (a decimal point or comma), as axisLabel writes them, or an axis', () => {
    assert.deepEqual(parseDirection('0 0 1'), [0, 0, 1]);
    assert.deepEqual(parseDirection('-z'), [0, 0, -1]);
    assert.deepEqual(parseDirection('1,0,0'), [1, 0, 0]);
    assert.deepEqual(parseDirection('1, 0, 0'), [1, 0, 0]);
    for (const text of ['0.6, 0, 0.8', '0.6,0,0.8', '(0.6, 0, 0.8)', '0,6 0 0,8', '0,6; 0; 0,8', '0,6, 0, 0,8', '0.6 0 0.8']) {
      const d = parseDirection(text);
      assert.ok(d, text);
      approx(d[0], 0.6, 0, 1e-12, text);
      approx(d[2], 0.8, 0, 1e-12, text);
    }
    // The card's own label of an oblique axis, typed back in.
    const tilted = canonicalAxis([0.458, -0.296, 0.838]);
    assert.ok(sameDirection(parseDirection(axisLabel(tilted)), tilted));
    for (const text of ['', '0 0', '1 2 3 4', 'a b c', '0.5.1 0 0']) assert.equal(parseDirection(text), null, text);
  });

  test('the same direction: whatever the length of the vectors (rounded to 6 decimals)', () => {
    const r = [0.267261, 0.534522, 0.801784]; // (1, 2, 3) rounded: |r|² = 0.99999979
    assert.ok(sameDirection(r, r));
    const d = canonicalAxis([1, 2, 3]);
    assert.ok(sameDirection(d, r) && sameDirection(r, d));
    assert.ok(!sameDirection(r, r.map((x) => -x)));
    assert.ok(!sameDirection([0, 0, 1], [0, Math.sin(1e-3), Math.cos(1e-3)]));
    // Every unit vector, rounded as the JSON gives it, is its own direction.
    let seed = 1;
    const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 2000; k++) {
      const v = canonicalAxis([next(), next(), next()]);
      if (v) assert.ok(sameDirection(v.map((x) => Math.round(x * 1e6) / 1e6), v), v.join());
    }
  });

  test('axes: one sense, the frame axes by name', () => {
    assert.deepEqual(canonicalAxis([0, 0, -3]), [0, 0, 1]);
    assert.deepEqual(canonicalAxis([0.0001, 1, 0]), [0, 1, 0]);
    assert.equal(canonicalAxis([0, 0, 0]), null);
    const tilted = canonicalAxis([-1, 0, -1]);
    approx(tilted[0], Math.SQRT1_2, 0, 1e-12, 'x');
    assert.equal(axisLabel([0, 0, -1]), '-Z');
    assert.equal(axisLabel([1, 0, 0]), 'X');
    assert.equal(axisLabel([Math.SQRT1_2, 0, Math.SQRT1_2]), '(0.707, 0, 0.707)');
  });
});

/**
 * A closed mesh, consistently turned outwards: every edge shared by exactly
 * two triangles, once each way. Returns its enclosed volume.
 */
function closedVolume({ positions: P, indices: I }, label) {
  const directed = new Map();
  for (let t = 0; t < I.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      assert.notEqual(a, b, `${label}: a degenerate edge`);
      const key = `${a},${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(',');
    assert.equal(count, 1, `${label}: edge ${key} used ${count} times the same way`);
    assert.equal(directed.get(`${b},${a}`), 1, `${label}: edge ${key} on one triangle only`);
  }
  let volume = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * I[t + k]);
    volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return volume;
}

/** Range of the vertices of a block along d. */
function rangeAlong({ positions: P }, d) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const w = P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2];
    lo = Math.min(lo, w);
    hi = Math.max(hi, w);
  }
  return [lo, hi];
}

describe('halves of the mould shown round the body', () => {
  test('a planar line: two boxes meeting flat at its level, a margin round the body', () => {
    // A box 100 × 60 × 20 drawn along Z, its line round its bottom edge (z = 0); a T, its line at the underside of its bar (z = 10).
    const box = voxels(() => true, [10, 6, 2], { size: 10 });
    const t = prism([[12.5, 0], [17.5, 0], [17.5, 10], [30, 10], [30, 15], [0, 15], [0, 10], [12.5, 10]], 20, [15, 11]);
    for (const [mesh, level, size, height] of [[box, 0, [100, 60], 20], [t, 10, [30, 20], 15]]) {
      const { proposal, segments } = proposeParting(mesh.positions, mesh.indices);
      assert.deepEqual([proposal.axis, proposal.parting.level_mm], ['Z', level]);
      const blocks = mouldBlocks(mesh.positions, proposal.direction, { segments, level: proposal.parting.level_mm });
      const margin = Math.max(5, 0.15 * Math.max(...size, height));
      assert.equal(blocks.margin, margin);
      assert.deepEqual(blocks.cells, [1, 1]);
      assert.deepEqual([...blocks.heights], [level, level, level, level]);
      const d = blocks.frame.d;
      assert.deepEqual(rangeAlong(blocks.lower, d), [-margin, level]);
      assert.deepEqual(rangeAlong(blocks.upper, d), [level, height + margin]);
      // Closed boxes over the footprint of the body and its margin.
      const footprint = (size[0] + 2 * margin) * (size[1] + 2 * margin);
      approx(closedVolume(blocks.lower, 'lower'), footprint * (level + margin), 1e-6, 0, 'lower block');
      approx(closedVolume(blocks.upper, 'upper'), footprint * (height + margin - level), 1e-6, 0, 'upper block');
      assert.equal(blocks.lower.indices.length / 3, 12);
    }
    // An oblique direction: the blocks in its frame, a level clamped to the body.
    const blocks = mouldBlocks(box.positions, [0.6, 0, 0.8], { level: 1e6 });
    const [lo, hi] = blocks.extent.w;
    assert.deepEqual([...blocks.heights], [hi, hi, hi, hi]);
    approx(rangeAlong(blocks.upper, [0.6, 0, 0.8])[0], hi, 0, 1e-3, 'upper block from the top of the body');
    approx(rangeAlong(blocks.lower, [0.6, 0, 0.8])[0], lo - blocks.margin, 0, 1e-3, 'lower block from under the body');
    approx(closedVolume(blocks.lower, 'oblique lower') + closedVolume(blocks.upper, 'oblique upper'),
      (blocks.extent.u[1] - blocks.extent.u[0] + 2 * blocks.margin) * (blocks.extent.v[1] - blocks.extent.v[0] + 2 * blocks.margin) * (hi - lo + 2 * blocks.margin), 1e-5, 0, 'both blocks');
    // Without a line nor a level: under the body. Nothing to show without vertices.
    assert.deepEqual([...mouldBlocks(box.positions, [0, 0, 1]).heights], [0, 0, 0, 0]);
    assert.equal(mouldBlocks(new Float32Array(0), [0, 0, 1]), null);
    assert.equal(mouldBlocks(box.positions, [0, 0, 0]), null);
  });

  test('a stepped line: the interface follows the line near it, from one level to the other', () => {
    // The Z profile of the stepped part (its line at z = 0 round the bottom flange, at z = 20 round the top one).
    const mesh = voxels((x, y, z) => {
      const bottom = z < 1 && x < 4, web = x === 3, top = z >= 4 && x >= 3;
      const hole = y >= 3 && y < 5 && ((x === 1 && z < 1) || (x === 5 && z >= 4));
      return (bottom || web || top) && !hole;
    }, [7, 8, 5], { size: 5 });
    const { proposal, segments } = proposeParting(mesh.positions, mesh.indices);
    assert.deepEqual([proposal.parting.kind, proposal.parting.levels_mm], ['stepped', [0, 20]]);
    const blocks = mouldBlocks(mesh.positions, proposal.direction, { segments });
    const [nu, nv] = blocks.cells;
    // 35 × 40 mm and a margin of 6 mm: 48 cells along y (u, for d = Z), 43 along x.
    assert.deepEqual([nu, nv], [BLOCK_GRID, 43]);
    assert.equal(blocks.heights.length, (nu + 1) * (nv + 1));
    const heights = [...blocks.heights];
    assert.ok(Math.min(...heights) >= 0 && Math.max(...heights) <= 25);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 15, 'not flat');
    // Points of the line, every 0.25 mm.
    const line = [];
    for (let s = 0; s < segments.length; s += 6) {
      const len = Math.hypot(segments[s + 3] - segments[s], segments[s + 4] - segments[s + 1], segments[s + 5] - segments[s + 2]);
      for (let k = 0, n = Math.max(1, Math.ceil(len / 0.25)); k <= n; k++) line.push([0, 1, 2].map((c) => segments[s + c] + (k / n) * (segments[s + 3 + c] - segments[s + c])));
    }
    // A node within half a cell of the line, the line at another height more than 4 cells away: its height.
    const [x0, x1] = blocks.extent.u, [y0, y1] = blocks.extent.v;
    const m = blocks.margin;
    assert.deepEqual(blocks.frame.d, [0, 0, 1]);
    const cell = (x1 - x0 + 2 * m) / nu;
    const followed = { 0: 0, 20: 0 };
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        // Node (i, j) at (a, b) in the frame (u, v) square to d.
        const a = x0 - m + ((x1 - x0 + 2 * m) * i) / nu, b = y0 - m + ((y1 - y0 + 2 * m) * j) / nv;
        const at = (p) => Math.hypot(blocks.frame.u[0] * p[0] + blocks.frame.u[1] * p[1] - a, blocks.frame.v[0] * p[0] + blocks.frame.v[1] * p[1] - b);
        let near = null, r = Infinity;
        for (const p of line) if (at(p) < r) [near, r] = [p, at(p)];
        if (r > cell / 2) continue;
        const other = Math.min(...line.filter((p) => Math.abs(p[2] - near[2]) > 1).map(at));
        if (other < 4 * cell) continue;
        approx(blocks.heights[i * (nv + 1) + j], near[2], 0, 0.5, `node ${i}, ${j} by the line at ${near[2]}`);
        if (near[2] in followed) followed[near[2]]++;
      }
    }
    assert.ok(followed[0] > 50 && followed[20] > 50, JSON.stringify(followed));
    // Both blocks closed, on either side of the interface: together, the whole box.
    const volume = closedVolume(blocks.lower, 'lower') + closedVolume(blocks.upper, 'upper');
    approx(volume, (x1 - x0 + 2 * m) * (y1 - y0 + 2 * m) * (25 + 2 * m), 1e-5, 0, 'both blocks');
    assert.ok(closedVolume(blocks.lower, 'lower') > 0 && closedVolume(blocks.upper, 'upper') > 0);
  });

  test('bounded: a body of 2M triangles, a line of 100k pieces', () => {
    // The vertices of a body of 2M triangles (only its extent is read), a wavy line of 100k pieces round it.
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const positions = new Float32Array(3 * 1_000_000);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = 400 * next();
      positions[i + 1] = 150 * next();
      positions[i + 2] = 80 * next();
    }
    const pieces = 100_000;
    const segments = new Float32Array(6 * pieces);
    const point = (k) => {
      const t = (2 * Math.PI * k) / pieces;
      return [200 + 200 * Math.cos(t), 75 + 75 * Math.sin(t), 40 + 30 * Math.sin(5 * t)];
    };
    for (let k = 0; k < pieces; k++) {
      segments.set(point(k), 6 * k);
      segments.set(point(k + 1), 6 * k + 3);
    }
    const blocks = mouldBlocks(positions, [0, 0, 1], { segments });
    const [nu, nv] = blocks.cells;
    assert.ok(Math.max(nu, nv) === BLOCK_GRID && Math.min(nu, nv) >= 2);
    for (const block of [blocks.lower, blocks.upper]) {
      assert.ok(block.positions.length / 3 <= 2 * (BLOCK_GRID + 1) ** 2);
      assert.ok(block.indices.length / 3 <= 4 * BLOCK_GRID ** 2 + 8 * BLOCK_GRID);
    }
    closedVolume(blocks.lower, 'lower');
    closedVolume(blocks.upper, 'upper');
    // Warped: the interface goes up and down with the line, within the body.
    const heights = [...blocks.heights];
    assert.ok(Math.min(...heights) >= blocks.extent.w[0] && Math.max(...heights) <= blocks.extent.w[1]);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 30);
  });
});
