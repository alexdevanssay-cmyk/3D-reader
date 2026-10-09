// Draw direction and parting line (web/engine/parting.js) on synthetic meshes.
//
//   node --test tests/js/parting.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SIDE_LOWER, SIDE_UPPER, applyOverrides, axisLabel, canonicalAxis, evaluateParting, faceRegions,
  lineMesh, lineSummary, partingLine, proposeParting, sampleByArea,
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
