// Risers and gating (web/engine/feeding.js) on synthetic meshes: feeding
// zones from the inscribed spheres, a riser on each one no other feeds, the
// ingate on the parting line; the edits by hand; the sampled path.
//
//   node --test tests/js/feeding.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FEEDING_VERSION, NECK_RATIO, RISER_ASPECT, RISER_MODULUS_FACTOR, feedingContext, feedingYield, feedingZones,
  gateFromPoint, hotSpotsWithoutRiser, placeFeeding, proposeFeeding, resizeRiser, riserFromPoint, sizeGate,
  sizeRiser, snapToPartingLine, watershed,
} from '../../web/engine/feeding.js';
import { SIDE_NONE, evaluateParting, proposeParting } from '../../web/engine/parting.js';
import { approx } from './helpers.mjs';

/**
 * Closed mesh of a union of cubes (cells x, y, z of an nx × ny × nz grid where
 * filled(x, y, z)), `size` mm each, every square face cut into `subdivide`²
 * squares (as tests/js/parting.test.mjs).
 */
function voxels(filled, [nx, ny, nz], { size = 1, subdivide = 1 } = {}) {
  const at = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && filled(x, y, z);
  const positions = [];
  const indices = [];
  const ids = new Map();
  const vertex = (p) => {
    const key = p.join(',');
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
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const corner = (da, db) => {
          const p = [...base];
          p[a] += (i + da) / n;
          p[b] += (j + db) / n;
          return vertex(p);
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
 * Closed mesh of a union of the boxes of a rectilinear grid (cell i, j, k from
 * xs[i], ys[j], zs[k] to the next), one quad (two triangles) per face of a
 * cell: long triangles, as a CAD body tessellated coarsely.
 */
function rectilinear(filled, xs, ys, zs) {
  const n = [xs.length - 1, ys.length - 1, zs.length - 1];
  const at = (q) => q.every((v, k) => v >= 0 && v < n[k]) && filled(...q);
  const positions = [];
  const indices = [];
  const ids = new Map();
  const vertex = (q) => {
    const key = q.join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(xs[q[0]], ys[q[1]], zs[q[2]]);
      ids.set(key, id);
    }
    return id;
  };
  for (let x = 0; x < n[0]; x++) for (let y = 0; y < n[1]; y++) for (let z = 0; z < n[2]; z++) {
    if (!at([x, y, z])) continue;
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
      const q = [x, y, z];
      q[k] += s;
      if (at(q)) continue;
      const a = (k + 1) % 3, b = (k + 2) % 3;
      const base = [x, y, z];
      if (s > 0) base[k] += 1;
      const corner = (da, db) => {
        const p = [...base];
        p[a] += da;
        p[b] += db;
        return vertex(p);
      };
      const p00 = corner(0, 0), p10 = corner(1, 0), p11 = corner(1, 1), p01 = corner(0, 1);
      if (s > 0) indices.push(p00, p10, p11, p00, p11, p01);
      else indices.push(p00, p11, p10, p00, p01, p11);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

// 5 mm cells. A plate 100 × 60 × 10 with a boss 15 × 15 × 25 in its middle (x 45..60, y 25..40, z 10..35).
const plateWithBoss = () => voxels((x, y, z) => z < 2 || (x >= 9 && x < 12 && y >= 5 && y < 8 && z < 7), [20, 12, 7], { size: 5, subdivide: 2 });
// A plate 100 × 60 × 5 with a boss 15 × 15 × 15 at each end (x 0..15 and 85..100, y 20..35).
const twoBosses = () => voxels((x, y, z) => z < 1 || ((x < 3 || x >= 17) && y >= 4 && y < 7 && z < 4), [20, 12, 4], { size: 5, subdivide: 2 });
// A plate 100 × 60 × 10.
const plate = () => voxels(() => true, [20, 12, 2], { size: 5, subdivide: 2 });

/** The parting of a mesh as feeding.js takes it: {direction, side, segments} of its proposal. */
function partingOf(mesh) {
  const p = proposeParting(mesh.positions, mesh.indices);
  return { direction: p.proposal.direction, side: p.side, segments: p.segments };
}

const inBox = (p, min, max, tol = 1e-6) => p.every((x, k) => x >= min[k] - tol && x <= max[k] + tol);

describe('feeding zones', () => {
  test('a plate with one thick boss: one zone, its hot spot in the boss, one riser on top of the boss', () => {
    const mesh = plateWithBoss();
    const parting = partingOf(mesh);
    assert.deepEqual(parting.direction, [0, 0, 1]);
    const f = proposeFeeding(mesh.positions, mesh.indices, { parting, density: 2.7 });
    assert.equal(f.version, FEEDING_VERSION);
    assert.equal(f.status, 'proposed');
    // The plate is fed through the boss: the section does not decrease towards it.
    assert.equal(f.zones.length, 1);
    const [zone] = f.zones;
    approx(zone.sphere_mm, 15, 0.05, 0, 'hot spot: the inscribed sphere of the boss');
    assert.ok(inBox(zone.hot_spot_mm, [45, 25, 0], [60, 40, 35]), `hot spot ${zone.hot_spot_mm}`);
    approx(zone.volume_mm3, 100 * 60 * 10 + 15 * 15 * 25, 1e-6, 0.5, 'the volume of the body');
    assert.ok(zone.needs_riser && !zone.small);

    assert.equal(f.risers.length, 1);
    const [riser] = f.risers;
    assert.deepEqual([riser.type, riser.open, riser.zone, riser.source, riser.reason], ['top', true, 0, 'proposed', 'isolated_hot_spot_top']);
    // On the top face of the boss.
    assert.ok(inBox(riser.position_mm, [45, 25, 35], [60, 40, 35]), `riser at ${riser.position_mm}`);
    assert.deepEqual(riser.axis, [0, 0, 1]);
    // Sized on the modulus of the zone: at least 1.2 × it, H = 1.5 D.
    assert.ok(riser.riser_modulus_mm >= RISER_MODULUS_FACTOR * zone.modulus_mm - 1e-9);
    assert.equal(riser.height_mm, Math.ceil(RISER_ASPECT * riser.diameter_mm));
    approx(riser.volume_mm3, (Math.PI * riser.diameter_mm ** 2 * riser.height_mm) / 4, 1e-6, 0.1, 'volume');
    approx(riser.mass_g, (riser.volume_mm3 / 1000) * 2.7, 1e-3, 0.1, 'mass at 2.7 g/cm³');
    assert.match(riser.why, /^Point chaud Ø 15 mm .* masselotte ouverte sur le dessus/);
    assert.deepEqual(f.hot_spots_without_riser, []);
  });

  test('two bosses joined by a thin plate: two zones, a riser over each', () => {
    const mesh = twoBosses();
    const f = proposeFeeding(mesh.positions, mesh.indices, { parting: partingOf(mesh) });
    assert.equal(f.zones.length, 2);
    // The plate between them is a neck: clearly thinner than both hot spots.
    for (const z of f.zones) {
      approx(z.sphere_mm, 15, 0.05, 0, 'hot spot of a boss');
      assert.equal(z.necks.length, 1);
      assert.ok(z.necks[0].sphere_mm < NECK_RATIO * z.sphere_mm, `neck ${z.necks[0].sphere_mm}`);
    }
    assert.equal(f.risers.length, 2);
    const xs = f.risers.map((r) => r.position_mm[0]).sort((a, b) => a - b);
    assert.ok(xs[0] <= 15 && xs[1] >= 85, `risers at x = ${xs}`);
    for (const r of f.risers) {
      assert.equal(r.type, 'top');
      assert.equal(r.position_mm[2], 20, 'on the top of a boss');
    }
    assert.notEqual(f.risers[0].zone, f.risers[1].zone);
    // No mass without a density: the volume only.
    assert.ok(f.risers.every((r) => r.mass_g === null && r.volume_mm3 > 0));
  });

  test('a plate of one thickness: one zone, one riser at most', () => {
    const mesh = plate();
    const f = proposeFeeding(mesh.positions, mesh.indices, { parting: partingOf(mesh) });
    assert.equal(f.zones.length, 1);
    approx(f.zones[0].sphere_mm, 10, 0.02, 0, 'the plate');
    // V/A of the plate: 60000 / (2 × 6000 + 2 × 160 × 10) = 3.947 mm.
    approx(f.zones[0].modulus_mm, 60000 / 15200, 0.001, 0, 'modulus V/A');
    assert.ok(f.risers.length <= 1);
  });

  test('the watershed: two peaks joined by a neck stay apart, by a section as thick as the smaller one they are one', () => {
    // A strip of triangles: values along it, each joined to the next.
    const strip = (values) => {
      const n = values.length;
      const neighbours = new Int32Array(3 * n).fill(-1);
      for (let f = 0; f < n; f++) {
        if (f > 0) neighbours[3 * f] = f - 1;
        if (f < n - 1) neighbours[3 * f + 1] = f + 1;
      }
      return watershed(Float32Array.from(values), neighbours);
    };
    assert.equal(strip([10, 15, 10, 5, 10, 15, 10]).count, 2);
    assert.equal(strip([10, 15, 14, 14, 15, 10]).count, 1);
    // The larger peak is zone 0.
    assert.deepEqual([...strip([12, 5, 15]).zone], [1, 0, 0]);
  });
});

describe('gating', () => {
  test('the ingate lies on the parting line, on the outer outline, inwards in the parting plane', () => {
    for (const mesh of [plateWithBoss(), twoBosses(), plate()]) {
      const parting = partingOf(mesh);
      const f = proposeFeeding(mesh.positions, mesh.indices, { parting });
      const gate = f.gate;
      assert.ok(gate, 'an ingate');
      assert.equal(gate.on_parting_line, true);
      assert.ok(snapToPartingLine(gate.position_mm, parting.segments).distance < 1e-3, 'on a segment of the line');
      // On the bottom of the part (its planar line at z = 0), inside its box.
      approx(gate.position_mm[2], 0, 0, 1e-6, 'height');
      assert.ok(inBox(gate.position_mm, [0, 0, 0], [100, 60, 0]));
      // Inwards, in the parting plane: from the outline towards the part.
      approx(gate.direction[2], 0, 0, 1e-9, 'in the parting plane');
      const inside = gate.position_mm.map((x, k) => x + 5 * gate.direction[k]);
      assert.ok(inBox(inside, [0, 0, 0], [100, 60, 0]), `inwards: ${inside}`);
      // Section from the wall it enters: 0.7 × the wall, 3 × as wide.
      assert.deepEqual(gate, { ...gate, ...sizeGate(gate.wall_sphere_mm) });
      assert.equal(gate.reason, 'thickest_wall_on_parting_line');
      assert.match(gate.why, /^Sur la ligne de joint/);
      assert.ok(!gate.near_undercut && !gate.near_riser);
    }
  });

  test('away from an undercut: not next to a groove across the parting line', () => {
    // A block 100 × 60 × 20 with a groove 5 deep along the side y = 0, from x = 0 to 50, z 5..15: an undercut.
    // Drawn along Z (the proposal would draw it along Y, the groove then formed by the die).
    const mesh = voxels((x, y, z) => !(y === 0 && x < 10 && z >= 1 && z < 3), [20, 12, 4], { size: 5, subdivide: 2 });
    const { side, segments } = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
    const parting = { direction: [0, 0, 1], side, segments };
    assert.ok(parting.side.some((s) => s === SIDE_NONE), 'the groove is an undercut');
    const f = proposeFeeding(mesh.positions, mesh.indices, { parting });
    assert.equal(f.gate.near_undercut, false);
    const [x, y] = f.gate.position_mm;
    assert.ok(!(y < 1 && x < 70), `ingate at ${f.gate.position_mm}, next to the groove`);
  });

  test('a ring finely cut: the points of the hole, nearer the middle, are not tried first; the ingate on the outer outline', () => {
    // A square ring 120 × 120 × 10 with a hole 40 × 40, drawn along Z: 128 pieces of its line round the hole
    // (more than the candidates tried), every point low, as thick, in one zone fed.
    const mesh = voxels((x, y) => !(x >= 8 && x < 16 && y >= 8 && y < 16), [24, 24, 2], { size: 5, subdivide: 4 });
    const { side, segments } = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
    assert.equal(segments.length / 6, 512);
    const zones = feedingZones(mesh.positions, mesh.indices, { sphere: new Float32Array(mesh.indices.length / 3).fill(10) });
    const { gate } = placeFeeding(mesh.positions, mesh.indices, zones, { parting: { direction: [0, 0, 1], side, segments } });
    assert.ok(gate, 'an ingate');
    assert.equal(gate.outer_outline, true);
    const [x, y] = gate.position_mm;
    assert.ok([x, y].some((c) => Math.abs(c) < 1e-6 || Math.abs(c - 120) < 1e-6), `on the outer outline: ${gate.position_mm}`);
    const inside = gate.position_mm.map((c, k) => c + 5 * gate.direction[k]);
    assert.ok(inBox(inside, [0, 0, 0], [120, 120, 0]), `inwards: ${inside}`);
  });

  test('a coarse mesh: the ingate sized from the wall it touches, not from a boss next to it', () => {
    // A plate 160 × 80 × 5 with a boss 20 × 20 × 25 whose side is 15 mm from the edge y = 0, in triangles
    // of 15 to 40 mm (a CAD body): the boss within half a triangle of the outline.
    const xs = [0, 20, 40, 60, 70, 90, 100, 120, 140, 160];
    const mesh = rectilinear((i, j, k) => k === 0 || (xs[i] === 70 && j === 1), xs, [0, 15, 35, 60, 80], [0, 5, 30]);
    const parting = partingOf(mesh);
    assert.deepEqual(parting.direction, [0, 0, 1]);
    const f = proposeFeeding(mesh.positions, mesh.indices, { parting });
    approx(f.zones[0].sphere_mm, 20, 0.05, 0, 'the boss');
    approx(f.gate.wall_sphere_mm, 5, 0.05, 0, 'the plate at the ingate');
    assert.deepEqual([f.gate.thickness_mm, f.gate.width_mm], [3.5, 10.5]);
    // By hand next to the boss: the same.
    const ctx = feedingContext(mesh.positions, mesh.indices, feedingZones(mesh.positions, mesh.indices), { parting });
    const gate = gateFromPoint([80, 0, 2], ctx);
    approx(gate.wall_sphere_mm, 5, 0.05, 0, 'the plate at the ingate placed by hand');
    assert.match(gate.why, /paroi Ø inscrit 5 mm/);
  });

  test('without a parting line: risers along +Z, no ingate', () => {
    const mesh = plateWithBoss();
    const f = proposeFeeding(mesh.positions, mesh.indices);
    assert.equal(f.parting_known, false);
    assert.deepEqual(f.direction, [0, 0, 1]);
    assert.equal(f.gate, null);
    assert.equal(f.risers.length, 1);
    assert.equal(f.risers[0].position_mm[2], 35);
    // Yield: part / (part + risers), no ingate counted.
    assert.equal(f.yield.gating_volume_mm3, 0);
    approx(f.yield.value, f.body.volume_mm3 / (f.body.volume_mm3 + f.risers[0].volume_mm3), 1e-3, 0, 'yield');
  });
});

describe('risers and ingate by hand', () => {
  const mesh = plateWithBoss();
  const parting = partingOf(mesh);
  const zones = feedingZones(mesh.positions, mesh.indices);
  const ctx = feedingContext(mesh.positions, mesh.indices, zones, { parting });
  // The triangle of the mesh whose centre is nearest to p.
  const triangleAt = (p) => {
    let best = -1, d = Infinity;
    const { positions: P, indices: I } = mesh;
    for (let f = 0; f < I.length / 3; f++) {
      const c = [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3);
      const r = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      if (r < d) [best, d] = [f, r];
    }
    return best;
  };

  test('a riser placed on a face: sized from the zone touched, on top or on the side by the face', () => {
    const top = riserFromPoint([52, 32, 35], { triangle: triangleAt([52, 32, 35]), zones, normal: [0, 0, 1], direction: parting.direction, density: 2.7, id: 'M1' });
    assert.deepEqual([top.id, top.type, top.open, top.source, top.zone, top.offset], ['M1', 'top', true, 'manual', 0, null]);
    assert.deepEqual(top.position_mm, [52, 32, 35]);
    assert.equal(top.modulus_mm, zones.zones[0].modulus_mm);
    assert.deepEqual({ ...top, ...sizeRiser(zones.zones[0].modulus_mm) }, top);
    assert.match(top.why, /^Placée à la main/);
    const side = riserFromPoint([0, 30, 5], { triangle: triangleAt([0, 30, 5]), zones, positions: mesh.positions, indices: mesh.indices, direction: parting.direction });
    assert.deepEqual([side.type, side.open, side.offset], ['side', false, [-1, 0, 0]]);
    // D and H typed in: the volume, the modulus and the mass follow.
    const resized = resizeRiser(top, { diameter: 40, height: 50, density: 2.7 });
    assert.deepEqual([resized.diameter_mm, resized.height_mm, resized.sized_by_hand], [40, 50, true]);
    approx(resized.volume_mm3, Math.PI * 400 * 50, 1e-9, 0.1, 'volume');
    approx(resized.riser_modulus_mm, (Math.PI * 400 * 50) / (Math.PI * 40 * 50 + Math.PI * 400), 1e-3, 0, 'modulus');
    approx(resized.mass_g, Math.PI * 400 * 50 * 2.7 / 1000, 1e-3, 0.1, 'mass');
  });

  test('the ingate placed by hand: brought onto the parting line, inwards', () => {
    const gate = gateFromPoint([30, 2, 3], ctx, { triangle: triangleAt([30, 0, 3]) });
    assert.equal(gate.on_parting_line, true);
    assert.equal(gate.source, 'manual');
    approx(gate.position_mm[2], 0, 0, 1e-6, 'onto the line at the bottom');
    approx(gate.position_mm[1], 0, 0, 1e-6, 'on the side y = 0');
    assert.deepEqual(gate.direction, [0, 1, 0]);
    assert.ok(gate.outer_outline);
    // Without a parting line: where it was clicked.
    const free = gateFromPoint([30, 0, 3], feedingContext(mesh.positions, mesh.indices, zones), { triangle: triangleAt([30, 0, 3]) });
    assert.deepEqual([free.on_parting_line, free.position_mm, free.direction], [false, [30, 0, 3], [0, 1, 0]]);
  });

  test('the nearest point of the parting line', () => {
    const segments = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 10, 0]);
    const snap = snapToPartingLine([12, 4, 3], segments);
    assert.deepEqual([snap.point, snap.segment], [[10, 4, 0], 1]);
    approx(snap.distance, Math.hypot(2, 3), 1e-9, 0, 'distance');
    assert.equal(snapToPartingLine([0, 0, 0], new Float32Array(0)), null);
  });

  test('a riser deleted: its hot spot is listed without one; the yield follows the risers', () => {
    const placed = placeFeeding(mesh.positions, mesh.indices, zones, { parting, ctx });
    assert.deepEqual(hotSpotsWithoutRiser(zones.zones, placed.risers), []);
    assert.deepEqual(hotSpotsWithoutRiser(zones.zones, []), [0]);
    const y = feedingYield(65625, [{ volume_mm3: 10000 }, { volume_mm3: 5000 }], { volume_mm3: 625 });
    assert.deepEqual(y, { value: 0.8077, part_volume_mm3: 65625, risers_volume_mm3: 15000, gating_volume_mm3: 625, counted: 'part_risers_ingate' });
  });
});

describe('sizes', () => {
  test('a riser: a cylinder H = 1.5 D, its contact face not cooling, M = 3D/14 at least 1.2 × the zone', () => {
    for (const m of [1, 2.5, 3.947, 10]) {
      const r = sizeRiser(m);
      assert.equal(r.height_mm, Math.ceil(1.5 * r.diameter_mm));
      assert.ok(r.riser_modulus_mm >= 1.2 * m - 1e-9, `${m}: ${r.riser_modulus_mm}`);
      // The smallest whole diameter: one millimetre less is not enough.
      assert.ok((3 * (r.diameter_mm - 1)) / 14 < 1.2 * m);
    }
    approx(sizeRiser(0, { diameter: 14, height: 21 }).riser_modulus_mm, 3, 1e-9, 0, 'M = 3D/14');
  });

  test('an ingate: 0.7 × the wall thick, 3 × as wide, to the half millimetre', () => {
    assert.deepEqual(sizeGate(10), { thickness_mm: 7, width_mm: 21, length_mm: 31.5, section_mm2: 147, volume_mm3: 4630.5 });
    assert.deepEqual(sizeGate(4.3), { thickness_mm: 3, width_mm: 9, length_mm: 13.5, section_mm2: 27, volume_mm3: 364.5 });
  });
});

describe('large meshes', () => {
  test('sampled: the balls of triangles drawn by area, the same proposal every time', () => {
    const mesh = plateWithBoss();
    const parting = partingOf(mesh);
    const run = () => proposeFeeding(mesh.positions, mesh.indices, { parting, fullLimit: 1000, samples: 1500 });
    const a = run();
    assert.deepEqual(a.sampled, { triangles: mesh.indices.length / 3, samples: 1500, seed: 0x5eed, by: 'area' });
    assert.equal(a.sphere_source, 'sampled');
    const b = run();
    assert.deepEqual(b.zones, a.zones);
    assert.deepEqual(b.risers, a.risers);
    assert.deepEqual(b.gate, a.gate);
    assert.deepEqual([...b.zone], [...a.zone]);
    // The same reading as on every triangle: one zone, the riser on the boss.
    assert.equal(a.zones.length, 1);
    approx(a.zones[0].sphere_mm, 15, 0.05, 0, 'hot spot');
    assert.equal(a.risers.length, 1);
    assert.ok(inBox(a.risers[0].position_mm, [45, 25, 35], [60, 40, 35]), `riser at ${a.risers[0].position_mm}`);
  });

  test('the inscribed spheres given (from the thickness card): used as they are', () => {
    const mesh = plate();
    const sphere = new Float32Array(mesh.indices.length / 3).fill(10);
    const z = feedingZones(mesh.positions, mesh.indices, { sphere });
    assert.equal(z.sphere_source, 'thickness');
    assert.equal(z.zones.length, 1);
    assert.equal(z.zones[0].sphere_mm, 10);
  });
});
