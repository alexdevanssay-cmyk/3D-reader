// Draw direction and parting line (web/engine/parting.js) on synthetic meshes.
//
//   node --test tests/js/parting.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BLOCK_GRID, REACH_DOWN, REACH_UP, SIDE_LOWER, SIDE_UPPER, applyOverrides, axisLabel, canonicalAxis, evaluateParting, faceRegions,
  lineMesh, lineSummary, mouldBlocks, parseDirection, partingLine, proposeParting, sameDirection, sampleByArea,
} from '../../web/engine/parting.js';
import { approx } from './helpers.mjs';

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
