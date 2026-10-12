// Draw direction and parting line (web/engine/parting.js) on synthetic meshes.
//
//   node --test tests/js/parting.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  REACH_DOWN, REACH_UP, SIDE_LOWER, SIDE_UPPER, applyOverrides, axisLabel, canonicalAxis, evaluateParting, faceRegions,
  lineMesh, lineSummary, parseDirection, partingLine, proposeParting, sameDirection, sampleByArea,
} from '../../web/engine/parting.js';
import { LEVEL, SIDE_NONE, TRAPPED, ZERO_DRAFT } from '../../web/engine/parting.js';
import { approx } from './helpers.mjs';
import { PLATE, castPlate } from './plate-mesh.mjs';

/**
 * Closed mesh of a union of cubes (cells x, y, z of an nx × ny × nz grid where
 * filled(x, y, z)), `size` mm each, every square face cut into `subdivide`²
 * squares. perFace: each planar face with its own vertices (as a CAD body).
 */
function voxels(filled, [nx, ny, nz], { size = 1, subdivide = 1, perFace = false } = {}) {
  const at = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && filled(x, y, z);
  const positions = [];
  const indices = [];
  const ids = new Map();
  const vertex = (p, plane) => {
    const key = p.join(',') + (perFace ? `|${plane}` : '');
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(p[0] * size, p[1] * size, p[2] * size);
      ids.set(key, id);
    }
    return id;
  };
  const n = subdivide;
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (!at(x, y, z)) continue;
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
      const q = [x, y, z];
      q[k] += s;
      if (at(...q)) continue;
      const a = (k + 1) % 3, b = (k + 2) % 3;
      const base = [x, y, z];
      if (s > 0) base[k] += 1;
      const plane = `${k}${s}${base[k]}`;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const corner = (da, db) => {
          const p = [...base];
          p[a] += (i + da) / n;
          p[b] += (j + db) / n;
          return vertex(p, plane);
        };
        const p00 = corner(0, 0), p10 = corner(1, 0), p11 = corner(1, 1), p01 = corner(0, 1);
        if (s > 0) indices.push(p00, p10, p11, p00, p11, p01);
        else indices.push(p00, p11, p10, p00, p01, p11);
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * A profile (x, z), counter-clockwise and star-shaped from `kernel`, extruded
 * along y over `depth`: its two flat faces as fans of long triangles, each
 * side one quad, every face with its own vertices (the mesh of a CAD body).
 */
function prism(profile, depth, kernel) {
  const positions = [];
  const indices = [];
  const vertex = (x, y, z) => positions.push(x, y, z) / 3 - 1;
  const n = profile.length;
  for (const [y, sense] of [[0, 1], [depth, -1]]) {
    const k = vertex(kernel[0], y, kernel[1]);
    const ring = profile.map(([x, z]) => vertex(x, y, z));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(...(sense > 0 ? [k, ring[i], ring[j]] : [k, ring[j], ring[i]]));
    }
  }
  for (let i = 0; i < n; i++) {
    const [x0, z0] = profile[i], [x1, z1] = profile[(i + 1) % n];
    const a = vertex(x0, 0, z0), b = vertex(x1, 0, z1), c = vertex(x1, depth, z1), d = vertex(x0, depth, z0);
    indices.push(a, d, c, a, c, b);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Closed mesh of a profile (r, z) turned about z: from ring to ring, closed into a loop or capped at its ends. */
function revolve(profile, segments, { loop = false, poles = null } = {}) {
  const positions = [];
  const indices = [];
  const rings = profile.map(([r, z]) => {
    const first = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    return first;
  });
  const n = profile.length;
  for (let k = 0; k < (loop ? n : n - 1); k++) {
    const a = rings[k], b = rings[(k + 1) % n];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  if (poles) {
    const south = positions.push(0, 0, poles[0]) / 3 - 1, north = positions.push(0, 0, poles[1]) / 3 - 1;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(south, rings[0] + j, rings[0] + i, north, rings[n - 1] + i, rings[n - 1] + j);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

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
    // Its principal axis (0, -0.447, 0.894) has the least zero-draft surface, but a warped line.
    const oblique = proposal.candidates.find((c) => c.source === 'principal_axis' && c.zero_draft_area_mm2 < proposal.zero_draft_area_mm2 && c.undercut_area_mm2 === 0);
    assert.equal(oblique?.parting?.kind, 'warped', JSON.stringify(proposal.candidates.map((c) => c.axis)));
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
