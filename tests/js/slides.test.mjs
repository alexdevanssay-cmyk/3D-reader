// Slides (« tiroirs ») from the undercuts of a parting line
// (web/engine/slides.js) on synthetic meshes: the zones and the directions
// that release them, the slides, the probable cores, the edits by hand and
// how they are kept; the same result whatever the order of the triangles,
// the lines cast bounded whatever the size of the mesh.
//
//   node --test tests/js/slides.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SIDE_LOWER, SIDE_NONE, applyOverrides, evaluateParting, faceRegions, lineMesh } from '../../web/engine/parting.js';
import { drawMesh, drawnParting, layStraight, reprojectPoint } from '../../web/engine/parting-draw.js';
import {
  SLIDE_DEFAULTS, SLIDES_VERSION, analyseSlides, dieAxes, directionParts, editSlides, effectiveSlides, matchSlideState, parseSlideState,
  pickSlideEntry, prepareSlides, serializeSlideState, slideBasis, slideStateHash, slidesSideHash, slidesSignature, slidesViewHash, undercutMask,
} from '../../web/engine/slides.js';
import { approx, approxVec } from './helpers.mjs';
import { plate } from './hole-parts.mjs';
import { revolve, voxels } from './meshes.mjs';
import { castPlate } from './plate-mesh.mjs';

const X = [1, 0, 0];
const Z = [0, 0, 1];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The meshes (cubes of 5 mm unless noted).
const block = (filled, dims = [10, 6, 4], options = {}) => voxels(filled, dims, { size: 5, ...options });
/** A: a block 50 × 30 × 20, a hole 10 × 10 through it along Y. */
const meshA = () => block((x, y, z) => !(x >= 4 && x < 6 && z >= 1 && z < 3));
/** B: pockets 10 deep into its -X and +X faces. */
const meshB = (options) => block((x, y, z) => !((x < 2 || x >= 8) && y >= 2 && y < 4 && z >= 1 && z < 3), [10, 6, 4], options);
/** C: two pockets into +X. */
const meshC = () => block((x, y, z) => !(x >= 8 && (y === 1 || y === 4) && z >= 1 && z < 3));
/** D: the hole of A, and a blind pocket into -Y. */
const meshD = () => block((x, y, z) => !((x >= 4 && x < 6 && z >= 1 && z < 3) || (x === 1 && y < 2 && z >= 1 && z < 3)));
/** E: a closed void. */
const meshE = () => block((x, y, z) => !(x === 2 && y === 2 && z === 2), [5, 5, 5]);
/** J: a groove round a column of 32 facets. */
const meshJ = () => revolve([[20, -15], [20, -2], [15, -2], [15, 2], [20, 2], [20, 15]], 32, { poles: [-15, 15] });
/** 80 pockets 5 × 10, 5 deep, round a block 205 × 205 × 25 (those at a corner touch by an edge). */
const pockets80 = () => block((x, y, z) => !(z >= 1 && z < 3 && (((x === 0 || x === 40) && y % 2 === 1 && y < 40) || ((y === 0 || y === 40) && x % 2 === 1 && x < 40))), [41, 41, 5]);
/** A block 60 × 40 × 40, a pocket 10 × 10 15 deep into +Y. */
const meshPocket = () => block((x, y, z) => !(x >= 5 && x < 7 && y >= 5 && z >= 3 && z < 5), [12, 8, 8]);

/** The mesh turned by `deg` about `axis` through `centre` (Float64 positions). */
function turn(mesh, axis, deg, centre = [0, 0, 0]) {
  const R = rotation(axis, (deg * Math.PI) / 180);
  const P = mesh.positions, out = new Float64Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const p = [P[i] - centre[0], P[i + 1] - centre[1], P[i + 2] - centre[2]];
    for (let k = 0; k < 3; k++) out[i + k] = R[k][0] * p[0] + R[k][1] * p[1] + R[k][2] * p[2] + centre[k];
  }
  return { positions: out, indices: mesh.indices };
}

function rotation(axis, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const [x, y, z] = axis.map((v) => v / Math.hypot(...axis));
  return [
    [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
    [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
    [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
  ];
}

/** The triangles in another order (mulberry32), every other one with its corners turned. */
function shuffled(mesh, seed = 7) {
  const nt = mesh.indices.length / 3;
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
  const indices = new Uint32Array(3 * nt);
  order.forEach((f, k) => {
    const [p, q, r] = [mesh.indices[3 * f], mesh.indices[3 * f + 1], mesh.indices[3 * f + 2]];
    indices.set(k % 2 ? [q, r, p] : [p, q, r], 3 * k);
  });
  return { positions: mesh.positions, indices };
}

function triangleAreas({ positions: P, indices: I }) {
  const out = new Float64Array(I.length / 3);
  for (let f = 0; f < out.length; f++) {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * I[3 * f + k]);
    const u = [0, 1, 2].map((k) => P[b + k] - P[a + k]), v = [0, 1, 2].map((k) => P[c + k] - P[a + k]);
    out[f] = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return out;
}

/**
 * The invariants of every analysis: the zones, the noise and the regions not
 * analysed make up the undercut; every undercut triangle has a zone (or is
 * noise, or not analysed), no other one; each slide's direction releases
 * each of its zones (unless partly or forced).
 */
function checkInvariants(name, mesh, mask, analysis, view) {
  const { zones, zone } = analysis;
  const sum = zones.reduce((s, z) => s + z.area_mm2, 0) + analysis.noise.area_mm2 + analysis.not_analysed.area_mm2;
  approx(sum, analysis.undercut_area_mm2, 1e-6, 0.005 * (zones.length + 3), `${name}: zones + noise + not analysed`);
  const areas = triangleAreas(mesh);
  const per = new Float64Array(zones.length);
  let undercut = 0, wrong = 0;
  for (let f = 0; f < mask.length; f++) {
    if ((zone[f] !== -1) !== (mask[f] === 1) || zone[f] < -3 || zone[f] >= zones.length) wrong++;
    if (mask[f]) undercut += areas[f];
    if (zone[f] >= 0) per[zone[f]] += areas[f];
  }
  assert.equal(wrong, 0, `${name}: triangles with a zone exactly the undercut ones`);
  approx(analysis.undercut_area_mm2, undercut, 1e-6, 0.006, `${name}: undercut area`);
  zones.forEach((z, k) => {
    assert.equal(z.id, k + 1);
    approx(z.area_mm2, per[k], 1e-6, 0.006, `${name}: area of zone ${z.id}`);
  });
  for (const sl of view.slides) {
    if (sl.tags.partial != null || sl.tags.forced != null) continue;
    for (const id of sl.zones) {
      const r = zones[id - 1].releases.find((x) => x.dir === sl.dir);
      assert.ok(r && r.share >= analysis.thresholds.releaseShare, `${name}: ${sl.id} releases zone ${id}`);
    }
  }
}

/** The parting of a mesh along d, its undercuts (unless given) analysed, the slides proposed; the invariants checked. */
function run(mesh, d, { ev = null, mask = null, side = null, options = {}, name = '' } = {}) {
  ev ??= evaluateParting(mesh.positions, mesh.indices, d);
  mask ??= undercutMask({ flags: ev.flags });
  const sig = slidesSignature({ nt: mask.length, direction: d, mask });
  const analysis = analyseSlides(prepareSlides(mesh.positions, mesh.indices), { direction: d, mask, flags: ev.flags, side: side ?? ev.side, sig }, options);
  const view = effectiveSlides(analysis);
  checkInvariants(name, mesh, mask, analysis, view);
  return { ev, mask, analysis, view };
}

const axisOf = (analysis, k) => analysis.directions[k].axis;
/** The releases of a zone that release it: [axis, share, depth]. */
const releasing = (analysis, z) => z.releases.filter((r) => r.share >= 0.95).map((r) => [axisOf(analysis, r.dir), r.share, r.depth_mm]);
/** The slides as [id, axis, zones, area, stroke, size]. */
const slidesOf = (view) => view.slides.map((s) => [s.id, s.axis, s.zones, s.area_mm2, s.stroke_mm, s.size_mm]);

describe('undercuts grouped into slides', () => {
  test('A, a hole through along Y: one zone released both ways, one slide on +Y (the first in the pool), stroke 30 + 5 mm', () => {
    for (const d of [Z, [0, 0, -1]]) {
      const { analysis, view } = run(meshA(), d, { name: `A ${d}` });
      assert.equal(analysis.status, 'ok');
      assert.equal(analysis.undercut_area_mm2, 1200);
      assert.equal(analysis.zones.length, 1);
      const [z] = analysis.zones;
      assert.deepEqual([z.triangles, z.kind, z.reason, z.half], [96, 'slide', null, 'upper']);
      assert.deepEqual(releasing(analysis, z), [['Y', 1, 30], ['-Y', 1, 30]]);
      assert.deepEqual(slidesOf(view), [['T1', 'Y', [1], 1200, 35, [10, 10]]]);
      assert.equal(view.slides[0].reference_axis, '+Y');
      assert.deepEqual(view.slides[0].choices.map((k) => axisOf(analysis, k)), ['Y', '-Y']);
      assert.deepEqual(view.counts, { slides: 1, cores: 0, parting: 0, ignored: 0 });
      assert.equal(view.origin, 'proposed');
    }
  });

  test('B, pockets into -X and +X: one slide each, the equal areas named +X first', () => {
    const { analysis, view } = run(meshB(), Z, { name: 'B' });
    assert.equal(analysis.undercut_area_mm2, 1000);
    assert.deepEqual(analysis.zones.map((z) => [z.area_mm2, z.triangles]), [[500, 40], [500, 40]]);
    assert.deepEqual(slidesOf(view), [['T1', 'X', [2], 500, 15, [10, 10]], ['T2', '-X', [1], 500, 15, [10, 10]]]);
  });

  test('C, two pockets into +X: one slide for both', () => {
    const { analysis, view } = run(meshC(), Z, { name: 'C' });
    assert.equal(analysis.undercut_area_mm2, 700);
    assert.deepEqual(analysis.zones.map((z) => [z.id, z.area_mm2]), [[1, 350], [2, 350]]);
    assert.deepEqual(slidesOf(view), [['T1', 'X', [1, 2], 700, 15, [20, 10]]]);
  });

  test('D, the hole through and a blind pocket into -Y: the hole joins the slide the pocket needs', () => {
    const { analysis, view } = run(meshD(), Z, { name: 'D' });
    assert.equal(analysis.undercut_area_mm2, 1550);
    assert.deepEqual(analysis.zones.map((z) => z.area_mm2), [350, 1200]);
    assert.deepEqual(slidesOf(view), [['T1', '-Y', [1, 2], 1550, 35, [25, 10]]]);
  });

  test('E, a closed void: no slide, a probable core, inside', () => {
    const { analysis, view } = run(meshE(), Z, { name: 'E' });
    assert.equal(analysis.undercut_area_mm2, 150);
    assert.equal(view.slides.length, 0);
    assert.deepEqual(view.cores, [{ id: 'N1', zone: 1, area_mm2: 150, centroid_mm: [12.5, 12.5, 12.5], reason: 'enclosed' }]);
    assert.equal(analysis.zones[0].half, 'inside');
  });

  test('E2, a groove inside a vertical bore: no pull direction frees it, a core', () => {
    const mesh = block((x, y, z) => !((x === 3 && y === 3) || (x >= 2 && x <= 4 && y >= 2 && y <= 4 && z === 2)), [7, 7, 5]);
    const { analysis, view } = run(mesh, Z, { name: 'E2' });
    assert.equal(analysis.undercut_area_mm2, 700);
    assert.equal(view.slides.length, 0);
    assert.deepEqual(view.cores.map((c) => [c.area_mm2, c.reason]), [[700, 'no_direction']]);
  });

  test('J, a groove round a column: one region split into two half shells, +X and -X (the die axes win the ties)', () => {
    const { analysis, view } = run(meshJ(), Z, { name: 'J' });
    approx(analysis.undercut_area_mm2, 1468.9, 0, 0.01, 'undercut');
    assert.equal(analysis.stats.regions, 1);
    assert.equal(analysis.zones.length, 2);
    for (const z of analysis.zones) {
      approx(z.area_mm2, 734.45, 0, 0.01, 'half shell');
      assert.equal(z.split, true);
      assert.equal(z.partial_share, null);
    }
    // Depth: the radius, 20 (conservative for a half shell).
    assert.deepEqual(view.slides.map((s) => [s.axis, s.depth_mm, s.stroke_mm, s.size_mm]), [['X', 20, 25, [40, 4]], ['-X', 20, 25, [40, 4]]]);
    assert.equal(analysis.sampled.split_sampled, 0);

    // Finer, the budget of the split short (1536 triangles × 24 directions × 4 points): its triangles classified on
    // as many drawn by area as it pays for (1041), the others to their neighbours' side.
    const fine = run(revolve([[20, -15], [20, -2], [15, -2], [15, 2], [20, 2], [20, 15]], 256, { poles: [-15, 15] }), Z, { options: { splitRayBudget: 100_000 }, name: 'J fine' });
    assert.equal(fine.analysis.sampled.split_sampled, 1);
    assert.ok(fine.analysis.stats.split_rays <= 100_000, String(fine.analysis.stats.split_rays));
    assert.equal(fine.analysis.zones.length, 2);
    for (const z of fine.analysis.zones) approx(z.area_mm2, fine.analysis.undercut_area_mm2 / 2, 0.01, 0, 'half shell, sampled');
    assert.deepEqual(fine.view.slides.map((s) => s.axis), ['X', '-X']);
    // The budget spent: classified on the points it was ranked on, no line more.
    const spent = run(revolve([[20, -15], [20, -2], [15, -2], [15, 2], [20, 2], [20, 15]], 256, { poles: [-15, 15] }), Z, { options: { splitRayBudget: 0 }, name: 'J fine, spent' });
    assert.deepEqual([spent.analysis.sampled.split_sampled, spent.analysis.stats.split_rays], [1, 0]);
    for (const z of spent.analysis.zones) approx(z.area_mm2, spent.analysis.undercut_area_mm2 / 2, 0.05, 0, 'half shell, on the ranking');
    assert.deepEqual(spent.view.slides.map((s) => s.axis), ['X', '-X']);
  });

  test('cross bores: one region split into +X and +Y halves', () => {
    const mesh = block((x, y, z) => !(z >= 2 && z < 4 && ((x >= 3 && x < 5) || (y >= 3 && y < 5))), [8, 8, 6]);
    const { analysis, view } = run(mesh, Z, { name: 'cross' });
    assert.equal(analysis.undercut_area_mm2, 2600);
    assert.equal(analysis.stats.regions, 1);
    assert.deepEqual(analysis.zones.map((z) => z.area_mm2), [1300, 1300]);
    assert.deepEqual(view.slides.map((s) => [s.id, s.axis, s.stroke_mm, s.size_mm]), [['T1', 'X', 45, [10, 10]], ['T2', 'Y', 45, [10, 10]]]);
  });

  test('letters 1 mm deep: markings, ignored; 3 mm deep: one slide', () => {
    const shallow = run(voxels((x, y, z) => !(y === 29 && x >= 10 && x < 40 && z >= 8 && z < 12 && x % 4), [50, 30, 20]), Z, { name: 'letters 1' });
    assert.equal(shallow.analysis.undercut_area_mm2, 202);
    assert.deepEqual(shallow.analysis.zones.map((z) => z.area_mm2).sort((a, b) => a - b), [20, 26, 26, 26, 26, 26, 26, 26]);
    assert.ok(shallow.analysis.zones.every((z) => z.kind === 'ignored' && z.reason === 'shallow'));
    assert.equal(shallow.view.slides.length, 0);
    assert.deepEqual(shallow.view.ignored, { zones: [1, 2, 3, 4, 5, 6, 7, 8], area_mm2: 202 });
    const deep = run(voxels((x, y, z) => !(y >= 27 && x >= 10 && x < 40 && z >= 8 && z < 12 && x % 4), [50, 30, 20]), Z, { name: 'letters 3' });
    assert.equal(deep.analysis.undercut_area_mm2, 422);
    assert.equal(deep.analysis.zones.length, 8);
    assert.deepEqual(deep.view.slides.map((s) => [s.axis, s.zones.length, s.stroke_mm, s.size_mm]), [['Y', 8, 8, [30, 4]]]);
  });

  test('a plate with a hole through it, drawn along X: one slide +Z (the e2e holed block)', () => {
    const { analysis, view } = run(plate({ S: 30, H: 20, sections: [{ r: 10, top: 20, bottom: 0 }] }), X, { name: 'plate' });
    approx(analysis.undercut_area_mm2, 1254.6, 0, 0.1, 'undercut');
    assert.equal(analysis.zones.length, 1);
    assert.deepEqual(view.slides.map((s) => [s.axis, s.stroke_mm, s.size_mm]), [['Z', 25, [20, 20]]]);
  });

  test('the cast plate along X: one slide +Z for five zones, the raised letters ignored; the same welded', () => {
    const faces = run(castPlate(), X, { name: 'plate X' });
    const welded = run(castPlate({ welded: true }), X, { name: 'plate X welded' });
    for (const { analysis, view } of [faces, welded]) {
      // (2432.1 before the halves were optimised: the sides of the raised
      // letters, 1 mm high, in the shadows of others, strips narrower than the
      // tension of the line, are now formed with the half round them.)
      approx(analysis.undercut_area_mm2, 2423.07, 0, 0.1, 'undercut');
      // Stroke: the boss bore 8 and the plate 15, + 5.
      assert.deepEqual(view.slides.map((s) => [s.axis, s.zones.length, s.stroke_mm]), [['Z', 5, 28]]);
      assert.equal(view.ignored.zones.length, 1);
      const letters = analysis.zones[view.ignored.zones[0] - 1];
      approx(letters.area_mm2, 149, 0, 0.5, 'letters');
      assert.equal(Math.min(...letters.releases.filter((r) => r.share >= 0.95).map((r) => r.depth_mm)), 1);
      assert.equal(view.counts.cores, 0);
    }
    assert.deepEqual(welded.analysis.zones, faces.analysis.zones);
    assert.deepEqual(welded.view.slides, faces.view.slides);
  });

  test('the cast plate along Y: a pillar face the planar line traps is to rework at the parting line, not a slide', () => {
    const { analysis, view } = run(castPlate(), [0, 1, 0], { name: 'plate Y' });
    assert.deepEqual(view.slides.map((s) => [s.axis, s.stroke_mm]), [['Z', 28]]);
    assert.equal(view.parting.length, 1);
    assert.equal(view.parting[0].area_mm2, 96);
    const pillar = analysis.zones[view.parting[0].zone - 1];
    assert.deepEqual([pillar.kind, pillar.reason, pillar.half_formable_share], ['parting', 'half_formable', 1]);
    for (const id of view.ignored.zones) {
      assert.ok(analysis.zones[id - 1].releases.some((r) => r.share >= 0.95 && r.depth_mm < 1.5), `ignored zone ${id}`);
    }
    assert.equal(view.counts.cores, 0);
  });

  test('the cast plate along (0.6, 0.8, 0): one slide +Z, one zone to rework at the parting line', () => {
    const d = [0.6, 0.8, 0];
    const { ev, analysis, view } = run(castPlate(), d, { name: 'plate oblique' });
    assert.deepEqual(view.slides.map((s) => [s.axis, s.stroke_mm]), [['Z', 28]]);
    assert.deepEqual(view.parting.map((p) => p.area_mm2), [144]);
    // (2536.3 and 2757.3 before the halves were optimised: the sides of the
    // raised letters, 1 mm high, in the shadows of others, formed with the half
    // round them, as along X.)
    approx(analysis.undercut_area_mm2, 2501.38, 0, 0.5, 'undercut');
    // Below the card's figure, which counts the trapped parts of the faces the plane cuts.
    approx(ev.summary.undercut_area_mm2, 2722.4, 0, 0.5, 'undercut of the parting');
  });

  test('the same result twice, whatever the order of the triangles and their corners', () => {
    const key = ({ analysis, view }) => ({
      zones: analysis.zones.map(({ id, area_mm2, centroid_mm, kind, releases }) => ({ id, area_mm2, centroid_mm, kind, releases })),
      slides: view.slides,
      rays: analysis.stats.rays,
    });
    for (const [name, mesh, d] of [['B', meshB(), Z], ['B per face', meshB({ perFace: true }), Z], ['J', meshJ(), Z], ['plate X', castPlate(), X]]) {
      const a = run(mesh, d, { name });
      const b = run(mesh, d, { name });
      assert.deepEqual(b.analysis, a.analysis, `${name}: twice`);
      assert.deepEqual(key(run(shuffled(mesh), d, { name: `${name} shuffled` })), key(a), `${name}: shuffled`);
    }
    const welded = run(meshB(), Z), faces = run(meshB({ perFace: true }), Z);
    assert.deepEqual(faces.analysis.zones, welded.analysis.zones);
    assert.deepEqual(faces.view.slides, welded.view.slides);
  });

  test('a slide turned in the parting plane: named from its die axis and the angle to it', () => {
    const { view } = run(turn(meshA(), Z, 20, [25, 15, 10]), Z, { name: 'A turned' });
    assert.equal(view.slides.length, 1);
    const [t] = view.slides;
    approxVec(t.direction, [-0.34202, 0.93969, 0], 0, 1e-4, 'direction');
    assert.deepEqual([t.reference_axis, t.angle_deg, t.tilt_deg, t.stroke_mm, t.tags.inclined], ['+Y', 20, null, 35, false]);
  });

  test('a part turned a hair in its assembly, off an axis of the frame or of the sweep: the same slides, pulled along its walls', () => {
    // A line along a wall a hair off the direction cast drifts back into the wall: the region's own direction is in the pool.
    const holed = () => plate({ S: 30, H: 20, sections: [{ r: 10, top: 20, bottom: 0 }] });
    for (const [name, mesh, d, count] of [
      ['plate 0.05° about X', turn(holed(), X, 0.05), X, 1],
      ['cast plate 0.05° about X', turn(castPlate(), X, 0.05), X, 1],
      ['B 0.02° about Z', turn(meshB(), Z, 0.02, [25, 15, 10]), Z, 2],
      ['A 0.02° about Z', turn(meshA(), Z, 0.02, [25, 15, 10]), Z, 1],
      ['C 0.02° about Z', turn(meshC(), Z, 0.02, [25, 15, 10]), Z, 1],
      ['B 0.5° about Z', turn(meshB(), Z, 0.5, [25, 15, 10]), Z, 2],
      ['B 15.02° about Z', turn(meshB(), Z, 15.02, [25, 15, 10]), Z, 2],
      ['A 30.02° about Z', turn(meshA(), Z, 30.02, [25, 15, 10]), Z, 1],
    ]) {
      const { analysis, view } = run(mesh, d, { name });
      assert.equal(view.slides.length, count, `${name}: ${view.slides.map((s) => s.axis).join(', ')}`);
      assert.equal(view.counts.cores, 0, name);
      assert.ok(analysis.zones.every((z) => !z.split), `${name}: no region split`);
    }
    const { view } = run(turn(meshB(), Z, 0.02, [25, 15, 10]), Z, { name: 'B 0.02°' });
    assert.deepEqual(view.slides.map((s) => [s.axis, s.area_mm2, s.stroke_mm]), [['-X', 500, 15], ['X', 500, 15]]);
  });

  test('cross, elbow and tee bores turned 20° about the draw direction: one slide along each branch, whatever the tessellation', () => {
    const bores = {
      cross: (x, y, z) => !(z >= 2 && z < 4 && ((x >= 3 && x < 5) || (y >= 3 && y < 5))),
      elbow: (x, y, z) => !(z >= 2 && z < 4 && ((x < 5 && y >= 3 && y < 5) || (x >= 3 && x < 5 && y >= 3))),
      tee: (x, y, z) => !(z >= 2 && z < 4 && ((y >= 3 && y < 5) || (x >= 3 && x < 5 && y >= 3))),
    };
    for (const [name, filled] of Object.entries(bores)) {
      for (const subdivide of [1, 3]) {
        const { analysis, view } = run(turn(block(filled, [8, 8, 6], { subdivide }), Z, 20, [20, 20, 15]), Z, { name: `${name} ${subdivide}` });
        assert.equal(analysis.stats.regions, 1, name);
        assert.equal(view.slides.length, 2, `${name}, subdivided ${subdivide}: ${view.slides.map((s) => s.axis).join(', ')}`);
        assert.ok(view.slides.every((s) => s.angle_deg === 20 && s.tilt_deg == null), `${name}: ${view.slides.map((s) => `${s.reference_axis} ${s.angle_deg}`).join(', ')}`);
        assert.ok(Math.abs(dot(view.slides[0].direction, view.slides[1].direction)) < 1e-6, `${name}: square to each other`);
      }
    }
    const { view } = run(turn(block(bores.cross, [8, 8, 6]), Z, 20, [20, 20, 15]), Z, { name: 'cross' });
    assert.deepEqual(view.slides.map((s) => [s.reference_axis, s.angle_deg, s.area_mm2, s.stroke_mm]), [['+X', 20, 1300, 45], ['+Y', 20, 1300, 45]]);
  });

  test('a pocket tilted out of the plane: an inclined slide up to 45°, a core beyond', () => {
    for (const deg of [20, 40]) {
      const { view } = run(turn(meshPocket(), X, deg, [30, 20, 20]), Z, { name: `pocket ${deg}°` });
      assert.equal(view.slides.length, 1, `${deg}°`);
      const [t] = view.slides;
      const a = (deg * Math.PI) / 180;
      approxVec(t.direction, [0, Math.cos(a), Math.sin(a)], 0, 1e-4, `${deg}°`);
      assert.deepEqual([t.reference_axis, t.tilt_deg, t.tilt_up, t.stroke_mm, t.tags.inclined], ['+Y', deg, true, 20, true]);
    }
    const { view } = run(turn(meshPocket(), X, 50, [30, 20, 20]), Z, { name: 'pocket 50°' });
    assert.equal(view.slides.length, 0);
    assert.deepEqual(view.cores.map((c) => c.reason), ['partial']);
  });

  test('80 pockets: four slides of 20, never truncated; the 128 largest regions analysed (here 8), the others listed', () => {
    const mesh = pockets80();
    const ev = evaluateParting(mesh.positions, mesh.indices, Z);
    const { analysis, view } = run(mesh, Z, { ev, name: '80 pockets' });
    assert.equal(analysis.stats.regions, 76); // the 4 pairs at the corners touch by an edge
    assert.equal(analysis.zones.length, 80);
    assert.ok(analysis.zones.every((z) => z.area_mm2 === 200 && z.kind === 'slide'));
    const four = view.slides.map((s) => [s.axis, s.zones.length, s.area_mm2, s.stroke_mm, s.size_mm]);
    assert.deepEqual(four, [['X', 20, 4000, 10, [195, 10]], ['-X', 20, 4000, 10, [195, 10]], ['Y', 20, 4000, 10, [195, 10]], ['-Y', 20, 4000, 10, [195, 10]]]);
    assert.equal(analysis.sampled.scaled, false);

    const capped = run(mesh, Z, { ev, options: { maxRegions: 8 }, name: '80 pockets capped' });
    assert.equal(capped.analysis.status, 'capped');
    assert.equal(capped.analysis.not_analysed.zones, 68);
    assert.equal(capped.analysis.not_analysed.area_mm2, 68 * 200);
    assert.equal(capped.analysis.zones.length, 12);
    assert.equal(capped.view.counts.slides, 4);
    assert.equal(capped.analysis.thresholds.maxRegions, 8);

    // A budget of lines too short: fewer points drawn, the same slides.
    const short = run(mesh, Z, { ev, options: { rayBudget: 50_000 }, name: '80 pockets, short budget' });
    assert.equal(short.analysis.sampled.scaled, true);
    assert.deepEqual(short.view.slides, view.slides);
    assert.ok(short.analysis.stats.rays - short.analysis.stats.split_rays <= 50_000, String(short.analysis.stats.rays));
  });

  test('drawn by hand: the slides of its undercuts; with the halves swapped, the top and bottom are to rework at the parting line', () => {
    const mesh = meshB();
    const ev = evaluateParting(mesh.positions, mesh.indices, Z);
    const dm = drawMesh(lineMesh(mesh.positions, mesh.indices));
    const points = [[0, 0, 2.5], [50, 0, 2.5], [50, 30, 2.5], [0, 30, 2.5]].map((p) => reprojectPoint(dm, p));
    const paths = points.map((a, k) => layStraight(dm, a, points[(k + 1) % points.length], { axis: Z }));
    const proposed = run(mesh, Z, { ev, name: 'B proposed' });
    for (const swap of [false, true]) {
      const result = drawnParting(dm, { loops: [{ points, segs: [], paths, closed: true }], seeds: [], swap }, { axis: Z, flags: ev.flags, height: 20 });
      assert.equal(result.ok, true);
      // The field of the page: its undercuts, its halves (SIDE_NONE on the undercuts), the flags of the direction.
      const mask = undercutMask({ flags: ev.flags, undercut: result.undercut });
      const side = result.side.map((s, f) => (result.undercut[f] ? SIDE_NONE : s));
      const { analysis, view } = run(mesh, Z, { ev, mask, side, name: `B drawn, swap ${swap}` });
      if (!swap) {
        assert.deepEqual(analysis.zones, proposed.analysis.zones);
        assert.deepEqual(view.slides, proposed.view.slides);
        continue;
      }
      assert.equal(analysis.undercut_area_mm2, 4000);
      assert.deepEqual(view.slides.map((s) => [s.axis, s.area_mm2, s.stroke_mm, s.size_mm]), [['X', 500, 15, [10, 10]], ['-X', 500, 15, [10, 10]]]);
      assert.deepEqual(view.parting.map((p) => p.area_mm2), [1500, 1500]);
      assert.deepEqual(analysis.warnings, ['undercut_share_high']);
      assert.equal(analysis.status, 'ok');
    }
  });

  test('a face reassigned by hand to a half: no longer an undercut, the slides kept', () => {
    const mesh = meshB({ perFace: true });
    const ev = evaluateParting(mesh.positions, mesh.indices, Z);
    const { region } = faceRegions(mesh.positions, mesh.indices, { brep: true });
    const P = mesh.positions, I = mesh.indices;
    const centre = (f) => [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3);
    // The floor of the -X pocket: at z = 5, x < 10, 10 < y < 20.
    const f0 = Array.from({ length: I.length / 3 }, (_, f) => f).find((f) => {
      const c = centre(f);
      return c[2] === 5 && c[0] < 10 && c[1] > 10 && c[1] < 20;
    });
    const floor = region[f0];
    const side = applyOverrides(ev.side, region, { [floor]: SIDE_LOWER });
    const fixed = Uint8Array.from(region, (r) => (r === floor ? 1 : 0));
    const mask = undercutMask({ flags: ev.flags, fixed });
    const { analysis, view } = run(mesh, Z, { ev, mask, side, name: 'B reassigned' });
    assert.deepEqual(analysis.zones.map((z) => z.area_mm2), [400, 500]);
    assert.deepEqual(view.slides.map((s) => [s.axis, s.area_mm2]), [['X', 500], ['-X', 400]]);
  });

  test('far from the origin, in float32: the same slides', () => {
    const B = meshB();
    const R = rotation([1, 2, 3], 0.3);
    const d = [R[0][2], R[1][2], R[2][2]];
    for (const offset of [[0, 0, 0], [1234.567, -1234.567, 411.5], [12345.678, -12345.678, 4115.2]]) {
      const P = B.positions, positions = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] = R[k][0] * P[i] + R[k][1] * P[i + 1] + R[k][2] * P[i + 2] + offset[k];
      const { view } = run({ positions, indices: B.indices }, d, { name: `B at ${offset}` });
      assert.equal(view.slides.length, 2, String(offset));
      assert.ok(dot(view.slides[0].direction, view.slides[1].direction) < -0.999, 'opposite');
      for (const s of view.slides) {
        approx(s.area_mm2, 500, 1e-4, 0, `area at ${offset}`);
        approx(s.stroke_mm, 15, 0, 1e-3, `stroke at ${offset}`);
      }
    }
  });

  test('no undercut: no zone, no slide', () => {
    const { analysis, view } = run(block(() => true), Z, { name: 'box' });
    assert.equal(analysis.status, 'none');
    assert.deepEqual([analysis.zones, analysis.directions, analysis.stats.rays], [[], [], 0]);
    assert.deepEqual(view.counts, { slides: 0, cores: 0, parting: 0, ignored: 0 });
    assert.ok(analysis.zone.every((k) => k === -1));
  });

  test('regions of noise: left yellow, not analysed, counted', () => {
    // B with a noise threshold above a pocket: both dropped.
    const { analysis, view } = run(meshB(), Z, { options: { noiseMm2: 600 }, name: 'B noise' });
    assert.deepEqual([analysis.zones.length, analysis.noise], [0, { zones: 2, area_mm2: 1000 }]);
    assert.equal(view.slides.length, 0);
    assert.ok(analysis.zone.every((k) => k === -1 || k === -2));
  });
});

describe('bounded cost', () => {
  test('grooves round a column, more than the budget of the split pays for: the lines cast within it', () => {
    // 12 grooves of 768 triangles, each split into two half shells; 24 directions tested: 73 728 lines planned each.
    const profile = [[20, 0]];
    for (let g = 0; g < 12; g++) profile.push([20, 2 + 4 * g], [15, 2 + 4 * g], [15, 4 + 4 * g], [20, 4 + 4 * g]);
    profile.push([20, 50]);
    const mesh = revolve(profile, 128, { poles: [0, 50] });
    // Two classified whole, one on as many triangles as the rest pays for, the others on the points they were ranked on.
    for (const [budget, sampled] of [[200_000, 10], [0, 12]]) {
      const { analysis } = run(mesh, Z, { options: { splitRayBudget: budget }, name: `12 grooves, ${budget}` });
      assert.equal(analysis.stats.regions, 12);
      assert.equal(analysis.sampled.split_sampled, sampled);
      assert.ok(analysis.stats.split_rays <= budget, String(analysis.stats.split_rays));
      assert.equal(analysis.zones.length, 24);
      assert.ok(analysis.zones.every((z) => z.kind === 'slide' && z.split));
    }
    // The budget enough: every triangle classified, the two halves +X and -X.
    const full = run(mesh, Z, { name: '12 grooves, budget enough' });
    assert.equal(full.analysis.sampled.split_sampled, 0);
    assert.deepEqual(full.view.slides.map((s) => [s.axis, s.zones.length]), [['X', 12], ['-X', 12]]);
  });

  test('2.3 million triangles: the same slides, the lines cast bounded', (t) => {
    const coarse = run(meshB(), Z, { name: 'B coarse' });
    const t0 = performance.now();
    const mesh = meshB({ subdivide: 64, perFace: true });
    const nt = mesh.indices.length / 3;
    assert.equal(nt, 2_293_760);
    // The pockets' faces (the parting is not run on such a mesh here): centres in their boxes, off the outer faces.
    const P = mesh.positions, I = mesh.indices;
    const mask = new Uint8Array(nt);
    for (let f = 0; f < nt; f++) {
      const c = [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3);
      if ((c[0] <= 10 || c[0] >= 40) && c[0] > 0 && c[0] < 50 && c[1] >= 10 && c[1] <= 20 && c[2] >= 5 && c[2] <= 15) mask[f] = 1;
    }
    const t1 = performance.now();
    const prepared = prepareSlides(mesh.positions, mesh.indices);
    const t2 = performance.now();
    const analysis = analyseSlides(prepared, { direction: Z, mask, sig: 'big' });
    const t3 = performance.now();
    t.diagnostic(`mesh ${((t1 - t0) / 1000).toFixed(1)} s, prepared ${((t2 - t1) / 1000).toFixed(1)} s, analysed ${((t3 - t2) / 1000).toFixed(1)} s, ${analysis.stats.rays} lines (coarse: ${coarse.analysis.stats.rays})`);
    const view = effectiveSlides(analysis);
    assert.deepEqual(view.slides.map((s) => [s.axis, s.stroke_mm]), [['X', 15], ['-X', 15]]);
    for (const s of view.slides) approx(s.area_mm2, 500, 1e-6, 0, 'area');
    assert.ok(analysis.stats.rays <= SLIDE_DEFAULTS.rayBudget + SLIDE_DEFAULTS.splitRayBudget);
    assert.ok(analysis.stats.rays <= 2 * coarse.analysis.stats.rays, `${analysis.stats.rays} lines, ${coarse.analysis.stats.rays} on the coarse mesh`);
    assert.ok(t3 - t1 < 120_000, `${((t3 - t1) / 1000).toFixed(1)} s`);
  });
});

describe('directions', () => {
  test('the die axes of a draw direction, the names of the directions, the frame of a slide', () => {
    assert.deepEqual(dieAxes(Z), { u: [1, 0, 0], v: [0, 1, 0] });
    assert.deepEqual(dieAxes([0, 0, -1]), { u: [1, 0, 0], v: [0, 1, 0] });
    assert.deepEqual(dieAxes(X), { u: [0, 1, 0], v: [0, 0, 1] });
    const { u, v } = dieAxes(Z);
    assert.deepEqual(directionParts([0, 1, 0], Z, u, v), { axis: 'Y', reference_axis: '+Y', angle_deg: null, tilt_deg: null, tilt_up: false });
    const a = (30 * Math.PI) / 180;
    assert.deepEqual(directionParts([-Math.sin(a), Math.cos(a), 0], Z, u, v), { axis: '(-0.5, 0.866, 0)', reference_axis: '+Y', angle_deg: 30, tilt_deg: null, tilt_up: false });
    const b = (20 * Math.PI) / 180;
    assert.deepEqual(directionParts([0, -Math.cos(b), -Math.sin(b)], Z, u, v), { axis: '(0, -0.94, -0.342)', reference_axis: '-Y', angle_deg: null, tilt_deg: 20, tilt_up: false });
    assert.deepEqual(slideBasis(X, Z), { a: [0, 1, 0], b: [0, 0, 1] });
  });
});

describe('signature of a definition', () => {
  test('the same field, the same signature; a triangle, the triangle count or the direction changed, another one', () => {
    const mesh = meshB();
    const ev = evaluateParting(mesh.positions, mesh.indices, Z);
    const mask = undercutMask({ flags: ev.flags });
    const nt = mask.length;
    const sig = slidesSignature({ nt, direction: Z, mask });
    const count = mask.reduce((n, x) => n + x, 0);
    assert.match(sig, /^s1:\d+:\d+:[0-9a-f]{8}$/);
    assert.equal(sig, `s1:${nt}:${count}:${sig.slice(-8)}`);
    assert.equal(slidesSignature({ nt, direction: [0, 0, 1], mask: Uint8Array.from(mask) }), sig);
    const other = new Set([sig]);
    for (const f of [mask.indexOf(1), mask.indexOf(0)]) {
      const toggled = Uint8Array.from(mask);
      toggled[f] ^= 1;
      other.add(slidesSignature({ nt, direction: Z, mask: toggled }));
    }
    const longer = new Uint8Array(nt + 1);
    longer.set(mask);
    other.add(slidesSignature({ nt: nt + 1, direction: Z, mask: longer }));
    other.add(slidesSignature({ nt, direction: [1e-5, 0, 1], mask }));
    assert.equal(other.size, 5);
  });

  test('faces that are no undercut reassigned: the same signature, other halves (the half of each slide)', () => {
    const mesh = meshB();
    const ev = evaluateParting(mesh.positions, mesh.indices, Z);
    const mask = undercutMask({ flags: ev.flags });
    const side = Uint8Array.from(ev.side, (x, f) => (mask[f] ? x : SIDE_LOWER));
    const nt = mask.length;
    assert.equal(slidesSignature({ nt, direction: Z, mask }), slidesSignature({ nt, direction: Z, mask: undercutMask({ flags: ev.flags }) }));
    assert.notEqual(slidesSideHash(side), slidesSideHash(ev.side));
    assert.equal(slidesSideHash(Uint8Array.from(ev.side)), slidesSideHash(ev.side));
    assert.match(slidesSideHash(ev.side), /^[0-9a-f]{8}$/);
    const halves = (s) => effectiveSlides(run(mesh, Z, { ev, mask, side: s }).analysis).slides.map((sl) => sl.half);
    assert.deepEqual([halves(ev.side), halves(side)], [['upper', 'upper'], ['lower', 'lower']]);
  });

  test('the undercut mask of a field: drawn, else no reach and not reassigned', () => {
    const flags = Uint8Array.from([0, 1, 2, 3, 16, 0]);
    assert.deepEqual([...undercutMask({ flags })], [1, 0, 0, 0, 1, 1]);
    assert.deepEqual([...undercutMask({ flags, fixed: Uint8Array.from([0, 0, 0, 0, 0, 1]) })], [1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...undercutMask({ flags, undercut: Uint8Array.from([0, 1, 0, 0, 0, 0]) })], [0, 1, 0, 0, 0, 0]);
  });
});

describe('edits by hand', () => {
  test('C: a zone to a new slide, merged back, made a core, ignored, then the proposal back', () => {
    const { analysis } = run(meshC(), Z);
    const proposal = effectiveSlides(analysis);
    let r = editSlides(analysis, null, { op: 'move', zone: 2, to: 'new' });
    let view = effectiveSlides(analysis, r.state);
    assert.equal(view.origin, 'manual');
    assert.deepEqual(view.slides.map((s) => [s.key, s.axis, s.zones]), [['p1', 'X', [1]], ['u1', 'X', [2]]]);
    r = editSlides(analysis, r.state, { op: 'merge', a: 'p1', b: 'u1' });
    view = effectiveSlides(analysis, r.state);
    assert.deepEqual(view.slides.map((s) => [s.id, s.axis, s.zones]), [['T1', 'X', [1, 2]]]);
    r = editSlides(analysis, r.state, { op: 'kind', zone: 1, kind: 'core' });
    view = effectiveSlides(analysis, r.state);
    assert.deepEqual([view.counts.slides, view.counts.cores, view.slides[0].zones], [1, 1, [2]]);
    assert.deepEqual(view.cores, [{ id: 'N1', zone: 1, area_mm2: 350, centroid_mm: analysis.zones[0].centroid_mm, reason: null }]);
    assert.deepEqual(view.zoneKind.get(1), { kind: 'core', slide: null, key: null });
    // Back to a slide: its proposed one, still there.
    const back = editSlides(analysis, r.state, { op: 'kind', zone: 1, kind: 'slide' });
    assert.deepEqual(effectiveSlides(analysis, back.state).slides.map((s) => [s.key, s.zones]), [['p1', [1, 2]]]);
    r = editSlides(analysis, r.state, { op: 'kind', zone: 1, kind: 'ignored' });
    assert.deepEqual(effectiveSlides(analysis, r.state).ignored, { zones: [1], area_mm2: 350 });
    r = editSlides(analysis, r.state, { op: 'reset' });
    assert.equal(r.state, null);
    assert.deepEqual(effectiveSlides(analysis, r.state), proposal);
  });

  test('C: what the costing reads of the edits, from what the slides do: a zone moved out and back, the proposal\'s', () => {
    const { analysis } = run(meshC(), Z);
    const proposal = effectiveSlides(analysis);
    const hashOf = (state) => slidesViewHash(effectiveSlides(analysis, state), proposal);
    assert.equal(hashOf(null), slideStateHash(null));
    const out = editSlides(analysis, null, { op: 'move', zone: 2, to: 'new' });
    assert.notEqual(hashOf(out.state), slideStateHash(null));
    // Merged back: the same slide (+X, zones 1 and 2, stroke 15) as proposed, from a state that is not the proposal.
    const back = editSlides(analysis, out.state, { op: 'merge', a: 'p1', b: 'u1' }).state;
    assert.deepEqual(effectiveSlides(analysis, back).slides.map((s) => [s.axis, s.zones, s.stroke_mm]), [['X', [1, 2], 15]]);
    assert.notEqual(slideStateHash(back), slideStateHash(null));
    assert.equal(hashOf(back), slideStateHash(null));
    // Two edits that do the same (zone 2 to a new slide, again from there): one hash; a zone made a core, another.
    const again = editSlides(analysis, back, { op: 'move', zone: 2, to: 'new' }).state;
    assert.notEqual(slideStateHash(again), slideStateHash(out.state));
    assert.equal(hashOf(again), hashOf(out.state));
    const core = editSlides(analysis, null, { op: 'kind', zone: 2, kind: 'core' }).state;
    assert.equal(new Set([hashOf(null), hashOf(out.state), hashOf(core)]).size, 3);
  });

  test('B: no pull direction releases both pockets, they are not merged; a pocket not moved into the other slide', () => {
    const { analysis } = run(meshB(), Z);
    const view = effectiveSlides(analysis);
    assert.deepEqual(editSlides(analysis, null, { op: 'merge', a: view.slides[0].key, b: view.slides[1].key }), { error: 'no_common_direction' });
    assert.deepEqual(editSlides(analysis, null, { op: 'move', zone: 1, to: view.slides[0].key }), { error: 'not_released', share: 0, slide: 'p1' });
    assert.deepEqual(editSlides(analysis, null, { op: 'move', zone: 9, to: 'new' }), { error: 'invalid' });
  });

  test('A: the other sense of the hole chosen; a direction that does not release it refused', () => {
    const { analysis } = run(meshA(), Z);
    const [slide] = effectiveSlides(analysis).slides;
    const minusY = analysis.directions.findIndex((e) => e.axis === '-Y');
    const plusX = analysis.directions.findIndex((e) => e.axis === 'X');
    assert.ok(slide.choices.includes(minusY));
    assert.ok(!slide.choices.includes(plusX));
    const r = editSlides(analysis, null, { op: 'direction', slide: slide.key, dir: minusY });
    assert.deepEqual(effectiveSlides(analysis, r.state).slides.map((s) => [s.axis, s.reference_axis, s.stroke_mm]), [['-Y', '-Y', 35]]);
    assert.deepEqual(editSlides(analysis, null, { op: 'direction', slide: slide.key, dir: plusX }), { error: 'not_released' });
  });

  test('E: the void made a slide by hand: forced on +u, released at 0', () => {
    const { analysis } = run(meshE(), Z);
    const r = editSlides(analysis, null, { op: 'kind', zone: 1, kind: 'slide' });
    const view = effectiveSlides(analysis, r.state);
    assert.deepEqual(view.slides.map((s) => [s.axis, s.direction, s.tags.forced, s.tags.partial, s.choices]), [['X', [1, 0, 0], 0, null, []]]);
    assert.equal(view.counts.cores, 0);
  });

  test('D: the blind pocket to a slide of its own; then into a slide on +Y, which turns to -Y', () => {
    const { analysis } = run(meshD(), Z);
    const blind = analysis.zones.find((z) => z.area_mm2 === 350).id;
    const hole = analysis.zones.find((z) => z.area_mm2 === 1200).id;
    let r = editSlides(analysis, null, { op: 'move', zone: blind, to: 'new' });
    let view = effectiveSlides(analysis, r.state);
    assert.deepEqual(view.slides.map((s) => [s.axis, s.zones]), [['-Y', [hole]], ['-Y', [blind]]]);
    const plusY = analysis.directions.findIndex((e) => e.axis === 'Y');
    const holeSlide = view.zoneKind.get(hole).key;
    r = editSlides(analysis, r.state, { op: 'direction', slide: holeSlide, dir: plusY });
    r = editSlides(analysis, r.state, { op: 'move', zone: blind, to: holeSlide });
    assert.equal(r.message, 'direction_changed');
    view = effectiveSlides(analysis, r.state);
    assert.deepEqual(view.slides.map((s) => [s.key, s.axis, s.zones]), [[holeSlide, '-Y', [blind, hole].sort()]]);
  });
});

describe('edits kept in this browser', () => {
  const entryOf = (analysis, state, savedAt = 1) => ({ sig: analysis.sig, version: SLIDES_VERSION, direction: analysis.direction, savedAt, state: serializeSlideState(state) });

  test('kept as JSON and read back on the analysis computed again: the same view', () => {
    const first = run(meshB(), Z).analysis;
    const { state } = editSlides(first, null, { op: 'kind', zone: 1, kind: 'core' });
    const view = effectiveSlides(first, state);
    const again = run(meshB(), Z).analysis;
    const entry = JSON.parse(JSON.stringify(entryOf(first, state)));
    const parsed = parseSlideState(JSON.stringify(serializeSlideState(state)));
    assert.deepEqual(parsed, entry.state);
    assert.deepEqual(pickSlideEntry([entry], again), { entry, exact: true });
    const match = matchSlideState(again, entry);
    assert.deepEqual(match.messages, []);
    assert.deepEqual(effectiveSlides(again, match.state), view);
    // The signature of the edits: another one for every edit, the proposal's for null.
    assert.notEqual(slideStateHash(state), slideStateHash(null));
    assert.equal(slideStateHash(parsed), slideStateHash(state));
  });

  test('carried over to another mesh of the same body and direction, by the anchors of the zones', () => {
    const coarse = run(meshB({ perFace: true, subdivide: 2 }), Z).analysis;
    const fine = run(meshB({ perFace: true, subdivide: 3 }), Z).analysis;
    assert.notEqual(coarse.sig, fine.sig);
    const { state } = editSlides(coarse, null, { op: 'kind', zone: 1, kind: 'core' });
    const entry = entryOf(coarse, state);
    assert.deepEqual(pickSlideEntry([entry], fine), { entry, exact: false });
    const match = matchSlideState(fine, entry, { exact: false });
    assert.deepEqual(match.messages, [{ code: 'carried' }]);
    const view = effectiveSlides(fine, match.state, { messages: match.messages });
    assert.deepEqual([view.origin, view.counts.slides, view.counts.cores, view.slides[0].axis, view.messages], ['manual', 1, 1, 'X', [{ code: 'carried' }]]);

    // The anchor of the core moved by more than 0.5 mm: that zone back to its proposed kind (a slide), reported.
    const moved = structuredClone(entry);
    const anchor = Object.keys(moved.state.zones).find((a) => moved.state.zones[a].kind === 'core');
    const shifted = anchor.replace(/^(-?[\d.]+)/, (x) => (Number(x) + 0.6).toFixed(2));
    moved.state.zones[shifted] = moved.state.zones[anchor];
    delete moved.state.zones[anchor];
    const lost = matchSlideState(fine, moved, { exact: false });
    assert.deepEqual(lost.messages, [{ code: 'carried' }, { code: 'dropped', n: 1 }]);
    assert.deepEqual(effectiveSlides(fine, lost.state).counts.cores, 0);

    // The proposal chosen for this signature: nothing carried over.
    const marker = { sig: fine.sig, version: SLIDES_VERSION, direction: fine.direction, savedAt: 2, state: null };
    const pick = pickSlideEntry([marker, entry], fine);
    assert.deepEqual(pick, { entry: marker, exact: true });
    assert.deepEqual(matchSlideState(fine, pick.entry, { exact: pick.exact }), { state: null, messages: [] });
    // Another direction: nothing either.
    assert.equal(pickSlideEntry([{ ...entry, direction: [1, 0, 0] }], fine), null);
  });

  test('a state that is not JSON, of another version or with an unknown kind: none (the proposal), with a warning', () => {
    const { analysis } = run(meshC(), Z);
    const { state } = editSlides(analysis, null, { op: 'move', zone: 2, to: 'new' });
    const warn = console.warn;
    const warnings = [];
    console.warn = (m) => warnings.push(m);
    try {
      assert.equal(parseSlideState('{'), null);
      assert.equal(parseSlideState(JSON.stringify({ ...state, v: 2 })), null);
      const anchor = Object.keys(state.zones)[0];
      assert.equal(parseSlideState(JSON.stringify({ ...state, zones: { [anchor]: { kind: 'nope', slide: null } } })), null);
      assert.equal(parseSlideState(JSON.stringify({ ...state, slides: { p1: { dir: [0, 0, Infinity] } } })), null);
      assert.equal(serializeSlideState({ ...state, next: 0 }), null);
      assert.equal(warnings.length, 5);
      assert.equal(parseSlideState(null), null);
      assert.equal(parseSlideState('null'), null);
      assert.equal(warnings.length, 5);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(parseSlideState(JSON.stringify(state)), serializeSlideState(state));
  });
});
