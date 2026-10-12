// Through and blind holes measured on the geometry (web/engine/holes.js):
// synthetic parts of known holes, closed meshes with their analytic surfaces.
//
//   node --test tests/js/holes.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOLES_VERSION, currentHoles, holesOfInstance, holesToMeasure, measureHoles, restoreHoles } from '../../web/engine/holes.js';
import { approx, approxVec } from './helpers.mjs';
import { partBody, plate } from './hole-parts.mjs';

const measure = (part) => measureHoles(part.positions, part.indices, part.surfaces);

test('a plate with a through hole: open at both ends, its length the thickness', () => {
  const record = measure(plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }] }));
  assert.equal(record.version, HOLES_VERSION);
  assert.equal(record.method, 'axis_rays_on_mesh');
  assert.equal(record.holes.length, 1);
  const [hole] = record.holes;
  assert.deepEqual(hole.surfaces, [1]);
  assert.equal(hole.through, true);
  assert.equal(hole.open_ends, 2);
  assert.equal(hole.measured, true);
  approx(hole.diameter_mm, 10, 1e-12, 0, 'diameter');
  approx(hole.length_mm, 10, 1e-9, 0, 'length');
  approxVec(hole.axis, [0, 0, 1], 0, 1e-12, 'axis');
  assert.equal('depth_mm' in hole, false);
});

test('a blind hole with a flat bottom: its depth from the opening, its axis into the material', () => {
  const [hole] = measure(plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'flat' })).holes;
  assert.equal(hole.through, false);
  assert.equal(hole.open_ends, 1);
  assert.equal(hole.measured, true);
  assert.equal(hole.bottom, 'flat');
  approx(hole.depth_mm, 12, 1e-9, 0, 'depth');
  assert.equal('tip_depth_mm' in hole, false);
  // Open at the top: drilled downwards.
  approxVec(hole.axis, [0, 0, -1], 0, 1e-12, 'axis');
});

test('a blind hole with a drill point: the depth of the full diameter, the point and its angle', () => {
  const part = plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'drill' });
  const [hole] = measure(part).holes;
  // The cylinder and its cone: one hole.
  assert.deepEqual(hole.surfaces, [1, 2]);
  assert.equal(hole.through, false);
  assert.equal(hole.bottom, 'drill_point');
  approx(hole.drill_point_angle_deg, 118, 1e-9, 0, 'point angle');
  approx(hole.depth_mm, 12, 1e-9, 0, 'depth of the full diameter');
  approx(hole.tip_depth_mm, 12 + 4 / Math.tan((59 * Math.PI) / 180), 1e-6, 0, 'depth to the tip');
  approx(hole.length_mm, hole.tip_depth_mm, 1e-6, 0, 'its faces down to the tip');
});

test('a counterbored through hole: one hole of two diameters, through', () => {
  const part = plate({ H: 20, sections: [{ r: 8, top: 20, bottom: 14 }, { r: 4, top: 14, bottom: 0 }] });
  const { holes } = measure(part);
  assert.equal(holes.length, 1);
  const [hole] = holes;
  assert.deepEqual(hole.surfaces, [1, 3]);
  assert.equal(hole.through, true);
  approx(hole.diameter_mm, 8, 1e-12, 0, 'narrowest diameter');
  assert.deepEqual(hole.diameters_mm, [8, 16]);
  approx(hole.length_mm, 20, 1e-9, 0, 'length');
});

test('a counterbored blind hole: blind, its depth from the top of the counterbore', () => {
  const part = plate({ H: 20, sections: [{ r: 8, top: 20, bottom: 16 }, { r: 3, top: 16, bottom: 6 }], end: 'flat' });
  const [hole] = measure(part).holes;
  assert.equal(hole.through, false);
  assert.equal(hole.bottom, 'flat');
  approx(hole.depth_mm, 14, 1e-9, 0, 'depth');
  approxVec(hole.axis, [0, 0, -1], 0, 1e-12, 'axis');
});

test('a hole whose cylinder is given as two half faces: one hole of both', () => {
  const { holes } = measure(plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }], split: true }));
  assert.deepEqual(holes.map((h) => [h.surfaces, h.through, h.diameter_mm, 'diameters_mm' in h]), [[[1, 2], true, 10, false]]);
  const [blind] = measure(plate({ H: 20, sections: [{ r: 8, top: 20, bottom: 14 }, { r: 3, top: 14, bottom: 6 }], end: 'flat', split: true })).holes;
  assert.deepEqual([blind.surfaces, blind.through, blind.bottom, blind.diameters_mm], [[1, 2, 4, 5], false, 'flat', [6, 16]]);
  approx(blind.depth_mm, 14, 1e-9, 0, 'depth');
});

test('a hole opening into an inner cavity: through (into the air of the part)', () => {
  // A closed box-shaped cavity 4 mm high under the hole: lines along the axis meet its floor, past the end of the hole.
  const part = plate({ S: 20, H: 20, sections: [{ r: 3, top: 20, bottom: 12 }], cavity: { C: 12, floor: 8, ceiling: 12 } });
  const [hole] = measure(part).holes;
  assert.equal(hole.through, true);
  assert.equal(hole.open_ends, 2);
  approx(hole.length_mm, 8, 1e-9, 0, 'length');
});

test('a boss is no hole: its axis is in the material', () => {
  // As the CAD engine gives it (material inside: forward): not listed.
  assert.deepEqual(measure(plate({ boss: { r: 5, h: 6 } })).holes, []);
  // Given as a hole (an orientation not to be trusted): measured, not a hole.
  const [hole] = measure(plate({ boss: { r: 5, h: 6, orientation: 'reversed' } })).holes;
  assert.equal(hole.through, null);
  assert.equal(hole.measured, false);
  assert.equal(hole.reason, 'start_point_in_material');
});

test('a mirrored instance (faces turned inwards, the same orientations): the same hole', () => {
  const [through] = measure(plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }], inverted: true })).holes;
  assert.equal(through.through, true);
  const [blind] = measure(plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'flat', inverted: true })).holes;
  assert.equal(blind.through, false);
  approx(blind.depth_mm, 12, 1e-9, 0, 'depth');
});

test('far from the origin: the same measurement', () => {
  const part = plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'drill' });
  const shift = [1e5, -2e5, 3e4];
  const positions = part.positions.map((x, i) => x + shift[i % 3]);
  const move = (p) => p.map((x, i) => x + shift[i % 3]);
  const surfaces = part.surfaces.map((s) => ({
    ...s,
    center_mm: move(s.center_mm),
    ...(s.axis_origin_mm ? { axis_origin_mm: move(s.axis_origin_mm) } : {}),
    edge_signatures: s.edge_signatures.map(move),
  }));
  const [hole] = measureHoles(positions, part.indices, surfaces).holes;
  assert.equal(hole.through, false);
  assert.equal(hole.bottom, 'drill_point');
  approx(hole.depth_mm, 12, 0, 1e-3, 'depth');
});

test('a partial cylinder (a rounded inside corner) is no hole: its wall does not go all round', () => {
  // A cylinder of radius 2 whose axis runs 2 mm off a side of the plate: the
  // side is its only wall, as for a fillet or the end of a slot.
  const part = plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }] });
  const corner = { index: part.surfaces.length, type: 'cylinder', radius_mm: 2, axis: [0, 0, 1], center_mm: [22, 0, 5], orientation: 'reversed', edge_signatures: [[20, 0, 0, 20, 0, 10]] };
  const { holes } = measureHoles(part.positions, part.indices, [...part.surfaces, corner]);
  const fillet = holes.find((h) => h.surfaces.includes(corner.index));
  assert.equal(fillet.through, null);
  assert.equal(fillet.reason, 'not_a_full_revolution');
  assert.equal(holes.find((h) => h.surfaces.includes(1)).through, true);
});

test('without cylinders, or without a mesh: nothing to measure; a mesh with gaps: not measured, said why', () => {
  const part = plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }] });
  assert.deepEqual(measureHoles(part.positions, part.indices, part.surfaces.filter((s) => s.type === 'plane')).holes, []);
  assert.equal(measureHoles(new Float32Array(0), new Uint32Array(0), part.surfaces), null);
  // Lines would leave it through its gaps: a blind hole would read as through.
  const open = measureHoles(part.positions, part.indices, part.surfaces, { closed: false });
  assert.deepEqual([open.holes, open.reason], [[], 'open_mesh']);
  assert.equal(currentHoles(open), true);
});

test('the bodies whose holes are to be measured: closed CAD bodies without current measurements', () => {
  const mesh = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  const cad = { closed: true, method: 'brep', mesh, geometric_surfaces: [] };
  const bodies = [
    cad,
    { ...cad, holes: { version: HOLES_VERSION, method: 'axis_rays_on_mesh', holes: [] } },
    { ...cad, holes: { version: HOLES_VERSION - 1, holes: [] } },
    { ...cad, closed: false },
    { ...cad, method: 'mesh' },
    { ...cad, mesh: undefined },
  ];
  assert.deepEqual(holesToMeasure(bodies), [0, 2]);
  assert.equal(currentHoles(bodies[1].holes), true);
  assert.equal(currentHoles(bodies[2].holes), false);
  assert.equal(currentHoles(undefined), false);
});

test('results kept before the holes were measured: measured once, then given from what was kept', async () => {
  const through = partBody(plate({ H: 10, sections: [{ r: 5, top: 10, bottom: 0 }] }));
  const blind = partBody(plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'flat' }));
  const stl = { closed: true, method: 'mesh', mesh: through.mesh };
  const calls = [];
  const measure = async (list) => {
    calls.push(list.length);
    return list.map((b) => measureHoles(b.positions, b.indices, b.surfaces));
  };
  const bodies = [through, stl, blind];
  const kept = await restoreHoles(bodies, null, measure);
  assert.deepEqual(calls, [2]);
  assert.deepEqual([bodies[0].holes.holes[0].through, bodies[2].holes.holes[0].through], [true, false]);
  assert.deepEqual(kept.map((r) => r && r.version), [HOLES_VERSION, null, HOLES_VERSION]);
  // Opened again: the measurements kept are given, nothing is measured.
  const again = [{ ...through, holes: undefined }, stl, { ...blind, holes: undefined }];
  assert.equal(await restoreHoles(again, kept, measure), null);
  assert.deepEqual(calls, [2]);
  assert.equal(again[2].holes.holes[0].depth_mm, 12);
  // Measured with the analysis (current): nothing to do.
  assert.equal(await restoreHoles(bodies, null, measure), null);
  assert.deepEqual(calls, [2]);
});

test('the holes of another instance of a part: the same, along its own axes; none for another part', () => {
  const part = plate({ H: 20, sections: [{ r: 4, top: 20, bottom: 8 }], end: 'drill' });
  const record = measure(part);
  // Turned half a turn about x (z -> -z): the axes of its faces too.
  const turned = part.surfaces.map((s) => (s.axis ? { ...s, axis: [s.axis[0], -s.axis[1], -s.axis[2]] } : s));
  const copy = holesOfInstance(record, part.surfaces, turned);
  assert.equal(copy.version, HOLES_VERSION);
  const [hole] = copy.holes;
  assert.deepEqual([hole.surfaces, hole.through, hole.depth_mm, hole.bottom], [[1, 2], false, 12, 'drill_point']);
  // Drilled from the top of the part as is (-z): from below once turned.
  approxVec(record.holes[0].axis, [0, 0, -1], 0, 1e-12, 'as is');
  approxVec(hole.axis, [0, 0, 1], 0, 1e-12, 'turned');
  // Another radius, or other faces: measured on its own.
  assert.equal(holesOfInstance(record, part.surfaces, part.surfaces.map((s) => (s.type === 'cylinder' ? { ...s, radius_mm: 5 } : s))), null);
  assert.equal(holesOfInstance(record, part.surfaces, part.surfaces.slice(1)), null);
});
