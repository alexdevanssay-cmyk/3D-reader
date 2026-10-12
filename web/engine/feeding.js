// Risers ("masselottes") and gating ("attaque de coulée") of a cast part
// (gravity die, sand), proposed from the geometry of its closed triangle mesh
// (mm): where the metal solidifies last, which sections can feed which, a
// riser on each region no other one can feed, and an ingate on the parting
// line.
//
// Feeding zones. The local thickness is the diameter of the largest sphere
// inscribed at each triangle (thickness.js "sphere"): larger at the junctions
// of walls, the hot spots. The surface is cut into zones by a watershed of
// that diameter: from the thickest triangles down, each triangle joins the
// zone of its neighbours already reached; a triangle reached by two zones is
// the thickest way between them (their saddle, the neck). Directional
// solidification: a section is fed through another only when the path to the
// feeder does not get thinner (Wlodawer; Campbell, feeding rules). Two zones
// whose neck is clearly thinner than the hot spot of the smaller one
// (NECK_RATIO) solidify apart: each needs a riser of its own. Else they are
// one zone, fed from the thicker hot spot. The surface may cut one mass of
// metal (a boss on a plate, seen from its sides and from under it, the thin
// top of the plate round its foot between them): zones whose hot-spot balls
// overlap are one (BALL_LINK).
//
// Modulus (Chvorinov: the solidification time grows as (V/A)², V the volume
// of a section, A its cooling surface): the riser must stay liquid longer
// than the zone it feeds. Of a zone:
//   - V/A: A the surface of its triangles, V the share of the volume of the
//     body under them, in proportion to Σ area × D/2 (the material between
//     each element of the surface and the middle of the wall: exact for a
//     plate, too much for a bar or a ball, hence scaled to the volume of the
//     body, exact by the divergence theorem);
//   - its hot spot, of inscribed diameter D: D/5, the modulus of a cylinder
//     D high and D across joined to the casting by one end, (πD³/4) / (πD² +
//     πD²/4); between the ball (D/6) and the long bar (D/4), the usual
//     bounds of a junction (heuristic);
//   and the larger of the two.
//
// Risers: a cylinder, H = 1.5 D, of modulus at least 1.2 × the zone's
// (Wlodawer, Chvorinov), on the part above the hot spot: on top (open, in
// the upper half along the draw direction; +Z without a parting line), or on
// the side at the parting line (blind) when the hot spot is closer to the
// joint than to the top. Gating: an ingate on the parting line, where the
// mould opens, on its outer outline (reached from outside the mould): not
// next to an undercut (cores, slides), the lowest along the draw direction
// (bottom filling), not under a riser, the thickest wall there, a zone
// without a riser, then the shortest way into the part. Its section from the
// wall it enters. The casting yield, part / (part + risers + ingate), for
// information (the sprue and runners are not designed here).
//
// The sources named by the constants are in foundry-knowledge.js
// (FOUNDRY_SOURCES); the others are marked heuristic.
//
// An aid to the design of the running and feeding system, not a simulation
// of filling or solidification: every proposal is to be confirmed.
//
// Plain JavaScript without bare imports: it runs in the feeding worker
// (feedworker.js) and on the page (the risers and the ingate placed again
// when the parting line changes, or by hand).

import { SIDE_NONE, sampleByArea } from './parting.js';
import { ballPass, coverPass, edgeNeighbours, prepareMesh, weld } from './thickness.js';

export const FEEDING_VERSION = 1;

// Two zones are one when the section between them is at least this share of
// the hot spot of the smaller one (heuristic: directional solidification,
// "wlodawer_1966", asks for a section that does not decrease towards the
// riser; 10 % for the measure, the inverse of the 1.1 ratio of Heuvers'
// circles, "campbell_casting_handbook").
export const NECK_RATIO = 0.9;
// Modulus of a riser over the modulus of the zone it feeds: the 1.2 factor of
// the modulus method ("wlodawer_1966", on Chvorinov's rule "chvorinov_1940").
export const RISER_MODULUS_FACTOR = 1.2;
// Height of a riser over its diameter (cylinder H = 1.5 D, a usual proportion; heuristic).
export const RISER_ASPECT = 1.5;
// Modulus of the hot spot over its inscribed diameter: D/5 (see above; heuristic).
export const HOT_SPOT_MODULUS = 1 / 5;
// A zone under this share of the volume of the body gets no riser: a small
// isolated hot spot, for a local cooling of the die or a chill (heuristic).
export const SMALL_ZONE_SHARE = 0.01;
// At most this many risers proposed, the zones of the largest modulus first (heuristic).
export const MAX_RISERS = 8;
// Ingate: thickness a share of the wall it enters (it breaks off without
// tearing the part), width a multiple of its thickness, length along the flow
// a multiple of its width (heuristics, neutral).
export const GATE_THICKNESS_RATIO = 0.7;
export const GATE_WIDTH_RATIO = 3;
export const GATE_LENGTH_RATIO = 1.5;
// Every triangle has its own inscribed sphere up to this size; above, the
// spheres of triangles drawn by area (fixed seed), spread to the others.
export const FULL_LIMIT = 200_000;
export const SAMPLES = 60_000;
export const SEED = 0x5eed;

// The hot spot of a zone: its triangles within this share of its largest diameter.
const HOT_PATCH = 0.9;
// A top riser stands on a face of the zone turned up within this share (the
// top of a boss reads less than its middle: no triangle centre on its axis).
const TOP_PATCH = 0.8;
// Two hot spots are one mass when balls of theirs have centres closer than
// this share of the smaller diameter (they overlap by more than half of it;
// heuristic); BALL_SAMPLES balls of each hot spot compared at most.
const BALL_LINK = 0.5;
const BALL_SAMPLES = 256;
// A zone of less than this share of the surface, or of fewer triangles, is noise: one with its neighbour.
const NOISE_SHARE = 1e-4;
const NOISE_TRIANGLES = 3;
// Places tried for the top riser of a zone (spread over its hot spot), and the
// points of its footprint tested: [share of the radius, count] per circle.
const TOP_TRIES = 256;
const FOOTPRINT_RINGS = [[1 / 3, 8], [2 / 3, 12], [1, 16]];
// A large triangle of the top of a hot spot cut into at most this many parts a side, for the places tried.
const FACE_SPLIT = 8;
// Parting line points looked at (spread along it), ingate candidates tested for a free way out.
const PARTING_POINTS = 4096;
const GATE_TRIES = 64;
// Points of each loop of the parting line tested for a free way out (is it on the outer outline, or a hole?).
const LOOP_TRIES = 16;
// The ingate at the bottom: within this height of the lowest point of the line (the larger).
const LOW_BAND_MM = 1;
const LOW_BAND_SHARE = 0.02;
// Walls along the parting line within this share of the thickest are as thick (heuristic).
const THICK_SHARE = 0.9;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const round = (v, digits = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v ?? null);
const roundVec = (v, digits = 3) => (v ? v.map((x) => round(x, digits) + 0) : null);
// A number written the French way, for the "why" of the proposals.
const fr = (v, digits = 1) => String(round(v, digits)).replace('.', ',');

function normalize(v) {
  const n = length(v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** Two unit vectors square to d and to each other. */
function basis(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(d, a));
  return [u, cross(d, u)];
}

// ------------------------------------------------------------------ mesh

/**
 * What the zones and the placements need of a mesh: areas, centres, unit
 * outward normals (flipped when the enclosed volume is negative), the
 * enclosed volume, the surface, the box.
 */
export function feedingMesh(positions, indices) {
  const nt = indices.length / 3;
  const nv = positions.length / 3;
  const areas = new Float64Array(nt);
  const centres = new Float64Array(3 * nt);
  const normals = new Float64Array(3 * nt);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const x = positions[3 * i + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  // Volume about the centre of the box (precision far from the origin).
  const o = nv ? min.map((m, k) => (m + max[k]) / 2) : [0, 0, 0];
  let volume = 0, area = 0;
  const moment = [0, 0, 0]; // of the tetrahedra (o, a, b, c), for the centroid
  const P = positions;
  for (let f = 0; f < nt; f++) {
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const v6 = (P[a] - o[0]) * nx + (P[a + 1] - o[1]) * ny + (P[a + 2] - o[2]) * nz;
    volume += v6;
    for (let k = 0; k < 3; k++) moment[k] += (v6 * (P[a + k] + P[b + k] + P[c + k] - 3 * o[k])) / 4;
    const len = Math.hypot(nx, ny, nz);
    areas[f] = len / 2;
    area += len / 2;
    if (len > 0) {
      normals[3 * f] = nx / len;
      normals[3 * f + 1] = ny / len;
      normals[3 * f + 2] = nz / len;
    }
    for (let k = 0; k < 3; k++) centres[3 * f + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  }
  const centroid = volume ? moment.map((m, k) => o[k] + m / volume) : o;
  volume /= 6;
  if (volume < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i] + 0;
    volume = -volume;
  }
  const diag = nv ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  return { positions, indices, nt, nv, areas, centres, normals, volume, area, min, max, diag, centroid };
}

/** The triangle across each edge, the vertices merged by position (the faces of a CAD body have their own vertices). */
function adjacency(positions, indices) {
  const { welded, nv } = weld(positions, indices);
  return edgeNeighbours(nv, welded);
}

// ------------------------------------------------------------------ inscribed spheres

/**
 * Diameter of the largest inscribed sphere of each triangle (thickness.js):
 * every triangle up to `fullLimit`; above, the balls of the triangles drawn
 * by area (fixed seed) and of their smooth edges, and the surface they
 * cover; the others are left NaN (see spreadValues). Returns
 * {sphere (Float32Array, NaN where none), source ("computed" | "sampled"),
 * sampled ({triangles, samples, seed, by} or null)}.
 */
export function sphereDiameters(positions, indices, { fullLimit = FULL_LIMIT, samples = SAMPLES, seed = SEED, onProgress = null } = {}) {
  const nt = indices.length / 3;
  if (!nt) return { sphere: new Float32Array(0), source: 'computed', sampled: null };
  const mesh = prepareMesh(positions, indices);
  if (nt <= fullLimit) {
    const first = ballPass(mesh, 0, nt, onProgress && ((f) => onProgress(0.8 * f)));
    const sphere = coverPass(mesh, first.samples, first.sphere, 0, first.samples.length / 7, onProgress && ((f) => onProgress(0.8 + 0.2 * f)));
    return { sphere, source: 'computed', sampled: null };
  }
  // A triangle drawn twice is computed once; in index order (the same order whatever the draw).
  const drawn = sampleByArea(feedingMesh(positions, indices).areas, samples, seed).sort();
  let n = 0;
  for (let s = 0; s < drawn.length; s++) if (!s || drawn[s] !== drawn[s - 1]) drawn[n++] = drawn[s];
  const first = ballPass(mesh, 0, n, onProgress && ((f) => onProgress(0.7 * f)), null, drawn.subarray(0, n));
  // Their balls cover the surface they reach, as on a whole mesh (the faces next to a convex edge).
  const sphere = coverPass(mesh, first.samples, first.sphere, 0, first.samples.length / 7, onProgress && ((f) => onProgress(0.7 + 0.3 * f)));
  return { sphere, source: 'sampled', sampled: { triangles: nt, samples, seed, by: 'area' } };
}

/**
 * The triangles without a value (degenerate, or not drawn) take the value of
 * the nearest triangle with one, across edges (breadth first, in index
 * order); none in their piece: 0. A new array.
 */
export function spreadValues(values, neighbours) {
  const nt = values.length;
  const out = Float32Array.from(values);
  const queue = new Int32Array(nt);
  let tail = 0;
  for (let f = 0; f < nt; f++) if (Number.isFinite(out[f])) queue[tail++] = f;
  for (let head = 0; head < tail; head++) {
    const f = queue[head];
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g < 0 || Number.isFinite(out[g])) continue;
      out[g] = out[f];
      queue[tail++] = g;
    }
  }
  for (let f = 0; f < nt; f++) if (!Number.isFinite(out[f])) out[f] = 0;
  return out;
}

/**
 * A triangle thicker than all its neighbours is brought down to the thickest
 * of them: a ball of one triangle is noise (the balls of a true hot spot
 * cover several). A new array.
 */
function clipSpikes(values, neighbours) {
  const out = Float32Array.from(values);
  for (let f = 0; f < values.length; f++) {
    let top = -Infinity, any = false;
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g < 0) continue;
      any = true;
      if (values[g] > top) top = values[g];
    }
    if (any && values[f] > top) out[f] = top;
  }
  return out;
}

// ------------------------------------------------------------------ zones

/**
 * Triangles in the order of their value, largest first, ties by index: the
 * value scaled to 28 bits and the index in 24 bits, sorted as one number
 * (a native sort of the doubles, no comparator).
 */
function descending(values) {
  const nt = values.length;
  let top = 0;
  for (let f = 0; f < nt; f++) if (values[f] > top) top = values[f];
  const keys = new Float64Array(nt);
  const scale = top > 0 ? (2 ** 28 - 1) / top : 0;
  if (nt < 2 ** 24) {
    for (let f = 0; f < nt; f++) keys[f] = (2 ** 28 - 1 - Math.round(Math.max(0, values[f]) * scale)) * 2 ** 24 + f;
    keys.sort();
    const order = new Uint32Array(nt);
    for (let s = 0; s < nt; s++) order[s] = keys[s] % 2 ** 24;
    return order;
  }
  return Uint32Array.from({ length: nt }, (_, f) => f).sort((a, b) => values[b] - values[a] || a - b);
}

/**
 * Feeding zones of a surface: watershed of the values (the inscribed
 * diameters) from the largest down; two zones meeting at a triangle are one
 * when its value is at least NECK_RATIO × the peak of the smaller one.
 * Returns {zone (Int32Array, per triangle, numbered from 0 by the largest
 * peak), count}.
 */
export function watershed(values, neighbours, { neckRatio = NECK_RATIO } = {}) {
  const nt = values.length;
  const parent = new Int32Array(nt).fill(-1); // -1: not reached yet
  const peak = new Float64Array(nt); // of a root
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const order = descending(values);
  const roots = [];
  for (let s = 0; s < nt; s++) {
    const f = order[s];
    roots.length = 0;
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g < 0 || parent[g] < 0) continue;
      const r = find(g);
      if (!roots.includes(r)) roots.push(r);
    }
    if (!roots.length) {
      parent[f] = f;
      peak[f] = values[f];
      continue;
    }
    // The highest peak first (then the smaller root): the triangle joins it.
    roots.sort((a, b) => peak[b] - peak[a] || a - b);
    let main = roots[0];
    parent[f] = main;
    for (let k = 1; k < roots.length; k++) {
      const r = roots[k];
      if (values[f] >= neckRatio * Math.min(peak[main], peak[r])) {
        // One zone: the root of the higher peak stays (a tie: the smaller index).
        const [keep, gone] = peak[r] > peak[main] || (peak[r] === peak[main] && r < main) ? [r, main] : [main, r];
        parent[gone] = keep;
        main = keep;
      }
    }
  }
  // Numbered by peak, largest first (ties: the first triangle of the zone).
  const ids = new Map();
  const zones = [];
  for (let f = 0; f < nt; f++) {
    const r = find(f);
    if (!ids.has(r)) {
      ids.set(r, zones.length);
      zones.push(r);
    }
  }
  const rank = zones.map((r, k) => k).sort((a, b) => peak[zones[b]] - peak[zones[a]] || a - b);
  const number = new Int32Array(zones.length);
  rank.forEach((k, n) => (number[k] = n));
  const zone = new Int32Array(nt);
  for (let f = 0; f < nt; f++) zone[f] = number[ids.get(find(f))];
  return { zone, count: zones.length };
}

/**
 * Zones whose hot spots are one mass of metal joined: the watershed follows
 * the surface, and a thick mass seen from two sides of a concave corner (a
 * boss on a plate: its sides, and the face under it) is cut by the thin
 * faces between them (the top of the plate round the foot of the boss). Two
 * zones are one when balls of their hot spots overlap: centres closer than
 * BALL_LINK × the smaller diameter (heuristic). Renumbered by peak.
 */
function mergeByBalls(zone, count, values, g) {
  const peak = new Float64Array(count);
  for (let f = 0; f < zone.length; f++) if (values[f] > peak[zone[f]]) peak[zone[f]] = values[f];
  // The balls of the hot spot of each zone (BALL_SAMPLES at most, spread in index order).
  const all = Array.from({ length: count }, () => []);
  for (let f = 0; f < zone.length; f++) if (values[f] >= HOT_PATCH * peak[zone[f]] && values[f] > 0 && g.areas[f] > 0) all[zone[f]].push(f);
  const balls = all.map((list) => {
    const step = Math.max(1, Math.ceil(list.length / BALL_SAMPLES));
    const kept = list.filter((_, k) => k % step === 0);
    const out = new Float64Array(4 * kept.length);
    kept.forEach((f, k) => {
      for (let j = 0; j < 3; j++) out[4 * k + j] = g.centres[3 * f + j] - (g.normals[3 * f + j] * values[f]) / 2;
      out[4 * k + 3] = values[f];
    });
    return out;
  });
  // A sphere round each set, to skip the pairs far apart.
  const bound = balls.map((b) => {
    const n = b.length / 4;
    const c = [0, 0, 0];
    for (let k = 0; k < n; k++) for (let j = 0; j < 3; j++) c[j] += b[4 * k + j] / n;
    let r = 0;
    for (let k = 0; k < n; k++) r = Math.max(r, Math.hypot(b[4 * k] - c[0], b[4 * k + 1] - c[1], b[4 * k + 2] - c[2]));
    return { c, r, n };
  });
  const parent = Int32Array.from({ length: count }, (_, z) => z);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const A = bound[a], B = bound[b];
      if (!A.n || !B.n || find(a) === find(b)) continue;
      if (length(sub(A.c, B.c)) > A.r + B.r + BALL_LINK * Math.min(peak[a], peak[b])) continue;
      const p = balls[a], q = balls[b];
      let linked = false;
      for (let i = 0; i < A.n && !linked; i++) {
        for (let j = 0; j < B.n; j++) {
          const reach = BALL_LINK * Math.min(p[4 * i + 3], q[4 * j + 3]);
          const dx = p[4 * i] - q[4 * j], dy = p[4 * i + 1] - q[4 * j + 1], dz = p[4 * i + 2] - q[4 * j + 2];
          if (dx * dx + dy * dy + dz * dz < reach * reach) {
            linked = true;
            break;
          }
        }
      }
      if (linked) {
        const ra = find(a), rb = find(b);
        // The root of the higher peak stays (a tie: the smaller).
        if (peak[rb] > peak[ra] || (peak[rb] === peak[ra] && rb < ra)) parent[ra] = rb;
        else parent[rb] = ra;
      }
    }
  }
  const roots = [...new Set(Array.from({ length: count }, (_, z) => find(z)))].sort((x, y) => peak[y] - peak[x] || x - y);
  const number = new Int32Array(count);
  roots.forEach((r, n) => (number[r] = n));
  const out = new Int32Array(zone.length);
  for (let f = 0; f < zone.length; f++) out[f] = number[find(zone[f])];
  return { zone: out, count: roots.length };
}

/** The noise zones (NOISE_*) joined to the neighbour they share the thickest section with; renumbered. */
function mergeNoise(zone, count, values, neighbours, areas, total) {
  const area = new Float64Array(count), tris = new Int32Array(count);
  for (let f = 0; f < zone.length; f++) {
    area[zone[f]] += areas[f];
    tris[zone[f]]++;
  }
  const noise = (z) => area[z] < NOISE_SHARE * total || tris[z] < NOISE_TRIANGLES;
  const into = Int32Array.from({ length: count }, (_, z) => z);
  // The best neighbour of each noise zone: the thickest edge to another zone.
  const best = new Float64Array(count).fill(-Infinity);
  for (let f = 0; f < zone.length; f++) {
    const z = zone[f];
    if (!noise(z)) continue;
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g < 0 || zone[g] === z) continue;
      const s = Math.min(values[f], values[g]);
      if (s > best[z] || (s === best[z] && zone[g] < into[z])) {
        best[z] = s;
        into[z] = zone[g];
      }
    }
  }
  // Followed to a zone that is not noise (a chain of noise zones; a loop of them stays).
  const target = (z) => {
    for (let k = 0; k < count && into[z] !== z && noise(z); k++) z = into[z];
    return z;
  };
  const kept = [];
  const number = new Int32Array(count).fill(-1);
  for (let z = 0; z < count; z++) {
    const t = target(z);
    if (number[t] < 0) {
      number[t] = kept.length;
      kept.push(t);
    }
  }
  const out = new Int32Array(zone.length);
  for (let f = 0; f < zone.length; f++) out[f] = number[target(zone[f])];
  return { zone: out, count: kept.length };
}

/**
 * Feeding zones of a closed body.
 *
 * positions, indices -- its mesh (mm); not modified
 * sphere -- inscribed diameter per triangle (thickness.js), computed when not given
 * Returns {version, zone (Int32Array, per triangle), sphere (Float32Array,
 * the diameters used), zones [{id, triangles, area_mm2, volume_mm3,
 * sphere_mm, modulus_mm, modulus_volume_mm, modulus_hot_spot_mm,
 * hot_spot_mm, necks [{zone, sphere_mm}], volume_share, needs_riser,
 * small}], body {volume_mm3, area_mm2}, sphere_source, sampled}.
 */
export function feedingZones(positions, indices, { sphere = null, fullLimit = FULL_LIMIT, samples = SAMPLES, seed = SEED, onProgress = null } = {}) {
  const g = feedingMesh(positions, indices);
  const nt = g.nt;
  let source = 'thickness', sampled = null, raw = sphere;
  if (!raw || raw.length !== nt) {
    ({ sphere: raw, source, sampled } = sphereDiameters(positions, indices, { fullLimit, samples, seed, onProgress: onProgress && ((f) => onProgress(0.9 * f)) }));
  }
  const neighbours = adjacency(positions, indices);
  const values = clipSpikes(spreadValues(raw, neighbours), neighbours);
  let { zone, count } = watershed(values, neighbours);
  ({ zone, count } = mergeNoise(zone, count, values, neighbours, g.areas, g.area));
  ({ zone, count } = mergeByBalls(zone, count, values, g));

  // Per zone: surface, Σ area × D/2 (the slab estimate of its volume), peak.
  const area = new Float64Array(count), slab = new Float64Array(count), peak = new Float64Array(count), tris = new Int32Array(count);
  let slabTotal = 0;
  for (let f = 0; f < nt; f++) {
    const z = zone[f];
    area[z] += g.areas[f];
    const s = (g.areas[f] * values[f]) / 2;
    slab[z] += s;
    slabTotal += s;
    if (values[f] > peak[z]) peak[z] = values[f];
    tris[z]++;
  }
  // Hot spot: the mean centre of the balls of the triangles near the peak (area-weighted).
  const hot = new Float64Array(4 * count);
  for (let f = 0; f < nt; f++) {
    const z = zone[f];
    if (!(values[f] >= HOT_PATCH * peak[z])) continue;
    const w = g.areas[f];
    for (let k = 0; k < 3; k++) hot[4 * z + k] += w * (g.centres[3 * f + k] - (g.normals[3 * f + k] * values[f]) / 2);
    hot[4 * z + 3] += w;
  }
  // Necks: the thickest section on the boundary of two zones.
  const necks = new Map();
  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const h = neighbours[3 * f + e];
      if (h <= f || zone[h] === zone[f]) continue;
      const a = Math.min(zone[f], zone[h]), b = Math.max(zone[f], zone[h]);
      const key = a * count + b;
      const s = Math.min(values[f], values[h]);
      if (!(necks.get(key) >= s)) necks.set(key, s);
    }
  }
  const zones = [];
  for (let z = 0; z < count; z++) {
    const volume = slabTotal > 0 ? (g.volume * slab[z]) / slabTotal : 0;
    const byVolume = area[z] > 0 ? volume / area[z] : 0;
    const byHotSpot = HOT_SPOT_MODULUS * peak[z];
    zones.push({
      id: z,
      triangles: tris[z],
      area_mm2: round(area[z], 1),
      volume_mm3: round(volume, 1),
      volume_share: round(g.volume > 0 ? volume / g.volume : 0, 4),
      sphere_mm: round(peak[z], 2),
      modulus_mm: round(Math.max(byVolume, byHotSpot), 3),
      modulus_volume_mm: round(byVolume, 3),
      modulus_hot_spot_mm: round(byHotSpot, 3),
      hot_spot_mm: hot[4 * z + 3] > 0 ? roundVec([hot[4 * z] / hot[4 * z + 3], hot[4 * z + 1] / hot[4 * z + 3], hot[4 * z + 2] / hot[4 * z + 3]]) : null,
      necks: [],
    });
  }
  for (const [key, s] of [...necks].sort((x, y) => x[0] - y[0])) {
    const a = Math.floor(key / count), b = key % count;
    zones[a].necks.push({ zone: b, sphere_mm: round(s, 2) });
    zones[b].necks.push({ zone: a, sphere_mm: round(s, 2) });
  }
  // A riser for each zone but the small ones, the largest modulus first, MAX_RISERS at most;
  // the zone of the largest modulus always (a casting is fed somewhere).
  const byModulus = zones.map((z) => z.id).sort((a, b) => zones[b].modulus_mm - zones[a].modulus_mm || a - b);
  byModulus.forEach((id, rank) => {
    const z = zones[id];
    z.small = z.volume_share < SMALL_ZONE_SHARE;
    z.needs_riser = rank === 0 || (!z.small && rank < MAX_RISERS);
  });
  for (const z of zones) z.necks.sort((x, y) => y.sphere_mm - x.sphere_mm || x.zone - y.zone);
  onProgress?.(1);
  return {
    version: FEEDING_VERSION,
    zone,
    sphere: values,
    zones,
    body: { volume_mm3: round(g.volume, 1), area_mm2: round(g.area, 1) },
    sphere_source: source,
    sampled,
    neck_ratio: NECK_RATIO,
  };
}

// ------------------------------------------------------------------ lines along d

/**
 * Uniform grid of the triangles projected on the plane normal to d, each in
 * the cells its projected box covers: the lines along d (the crossings of
 * a vertical through a point) and the triangles near a point.
 */
function columnGrid(g, d) {
  const { positions: P, indices: I, nt, nv } = g;
  const [u, v] = basis(d);
  const pu = new Float64Array(nv), pv = new Float64Array(nv), pw = new Float64Array(nv);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    pu[i] = x * u[0] + y * u[1] + z * u[2];
    pv[i] = x * v[0] + y * v[1] + z * v[2];
    pw[i] = x * d[0] + y * d[1] + z * d[2];
    if (pu[i] < umin) umin = pu[i];
    if (pu[i] > umax) umax = pu[i];
    if (pv[i] < vmin) vmin = pv[i];
    if (pv[i] > vmax) vmax = pv[i];
  }
  let box = new Float64Array(4 * nt); // released once the grid is built
  const sizes = [];
  for (let f = 0; f < nt; f++) {
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    box[4 * f] = Math.min(pu[a], pu[b], pu[c]);
    box[4 * f + 1] = Math.max(pu[a], pu[b], pu[c]);
    box[4 * f + 2] = Math.min(pv[a], pv[b], pv[c]);
    box[4 * f + 3] = Math.max(pv[a], pv[b], pv[c]);
  }
  for (let f = 0, step = Math.max(1, Math.floor(nt / 4096)); f < nt; f += step) sizes.push(Math.max(box[4 * f + 1] - box[4 * f], box[4 * f + 3] - box[4 * f + 2]));
  sizes.sort((x, y) => x - y);
  const W = Math.max(umax - umin, 1e-9), H = Math.max(vmax - vmin, 1e-9);
  let cell = Math.max(sizes[sizes.length >> 1] ?? Math.max(W, H), Math.max(W, H) / 1024, 1e-9);
  const entries = (size) => {
    let n = 0;
    for (let f = 0; f < nt; f++) n += (Math.floor((box[4 * f + 1] - box[4 * f]) / size) + 2) * (Math.floor((box[4 * f + 3] - box[4 * f + 2]) / size) + 2);
    return n;
  };
  while (Math.ceil(W / cell) * Math.ceil(H / cell) > 4 * nt + 1024 || entries(cell) > 16 * nt + 1024) cell *= 1.3;
  const nu = Math.max(1, Math.ceil(W / cell)), nw = Math.max(1, Math.ceil(H / cell));
  const ci = (x) => Math.min(nu - 1, Math.max(0, Math.floor((x - umin) / cell)));
  const cj = (y) => Math.min(nw - 1, Math.max(0, Math.floor((y - vmin) / cell)));
  const start = new Int32Array(nu * nw + 1);
  const each = (f, visit) => {
    for (let i = ci(box[4 * f]), i1 = ci(box[4 * f + 1]); i <= i1; i++) for (let j = cj(box[4 * f + 2]), j1 = cj(box[4 * f + 3]); j <= j1; j++) visit(i * nw + j);
  };
  for (let f = 0; f < nt; f++) each(f, (k) => start[k + 1]++);
  for (let k = 0; k < nu * nw; k++) start[k + 1] += start[k];
  const items = new Int32Array(start[nu * nw]);
  const fill = start.slice(0, nu * nw);
  for (let f = 0; f < nt; f++) each(f, (k) => (items[fill[k]++] = f));
  box = null;
  const stamp = new Int32Array(nt);
  let query = 0;
  const tEps = 1e-7 * (g.diag || 1);

  /**
   * The triangles crossed by the line through o along d, ahead (sense 1) or
   * behind (-1): [{t (distance along the sense), f}], nearest first.
   */
  function crossings(o, sense) {
    const a0 = dot(o, u), b0 = dot(o, v), w0 = dot(o, d);
    const out = [];
    if (a0 < umin || a0 > umax || b0 < vmin || b0 > vmax) return out;
    const k = ci(a0) * nw + cj(b0);
    for (let s = start[k]; s < start[k + 1]; s++) {
      const f = items[s];
      const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
      const xa = pu[a] - a0, ya = pv[a] - b0, xb = pu[b] - a0, yb = pv[b] - b0, xc = pu[c] - a0, yc = pv[c] - b0;
      const ea = xb * yc - xc * yb, eb = xc * ya - xa * yc, ec = xa * yb - xb * ya;
      const area = ea + eb + ec;
      if (area === 0) continue;
      const m = -1e-9 * Math.abs(area);
      if (area > 0 ? ea < m || eb < m || ec < m : ea > -m || eb > -m || ec > -m) continue;
      const t = sense * ((ea * pw[a] + eb * pw[b] + ec * pw[c]) / area - w0);
      if (t > tEps) out.push({ t, f });
    }
    out.sort((x, y) => x.t - y.t || x.f - y.f);
    // A line through an edge meets both triangles: one crossing.
    return out.filter((h, n) => !n || h.t - out[n - 1].t > tEps);
  }

  /** visit(f, squared distance) for each triangle closer than r to point p (once each). */
  function near(p, r, visit) {
    query++;
    const a0 = dot(p, u), b0 = dot(p, v);
    const q = [0, 0, 0];
    for (let i = ci(a0 - r), i1 = ci(a0 + r); i <= i1; i++) {
      for (let j = cj(b0 - r), j1 = cj(b0 + r); j <= j1; j++) {
        const k = i * nw + j;
        for (let s = start[k]; s < start[k + 1]; s++) {
          const f = items[s];
          if (stamp[f] === query) continue;
          stamp[f] = query;
          const d2 = closestOnTriangle(P, I, f, p, q);
          if (d2 <= r * r) visit(f, d2);
        }
      }
    }
  }
  return { d, u, v, crossings, near, cell };
}

/** Closest point of triangle f to p (Ericson, Real-Time Collision Detection 5.1.5), into out; its squared distance. */
function closestOnTriangle(P, I, f, p, out) {
  const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
  const ab = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const ac = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const ap = [p[0] - P[a], p[1] - P[a + 1], p[2] - P[a + 2]];
  const set = (x, y, z) => {
    out[0] = x;
    out[1] = y;
    out[2] = z;
  };
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) set(P[a], P[a + 1], P[a + 2]);
  else {
    const bp = [p[0] - P[b], p[1] - P[b + 1], p[2] - P[b + 2]];
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = [p[0] - P[c], p[1] - P[c + 1], p[2] - P[c + 2]];
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) set(P[b], P[b + 1], P[b + 2]);
    else if (d6 >= 0 && d5 <= d6) set(P[c], P[c + 1], P[c + 2]);
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      set(P[a] + t * ab[0], P[a + 1] + t * ab[1], P[a + 2] + t * ab[2]);
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      set(P[a] + t * ac[0], P[a + 1] + t * ac[1], P[a + 2] + t * ac[2]);
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
      set(P[b] + t * (P[c] - P[b]), P[b + 1] + t * (P[c + 1] - P[b + 1]), P[b + 2] + t * (P[c + 2] - P[b + 2]));
    } else {
      const den = 1 / (va + vb + vc);
      const v = vb * den, w = vc * den;
      set(P[a] + ab[0] * v + ac[0] * w, P[a + 1] + ab[1] * v + ac[1] * w, P[a + 2] + ab[2] * v + ac[2] * w);
    }
  }
  return (p[0] - out[0]) ** 2 + (p[1] - out[1]) ** 2 + (p[2] - out[2]) ** 2;
}

// ------------------------------------------------------------------ risers

/**
 * A riser of modulus at least RISER_MODULUS_FACTOR × `modulus` (mm): a
 * cylinder H = RISER_ASPECT × D whose contact face with the casting does not
 * cool. With H = 1.5 D:
 *   V = πD²H/4 = 3πD³/8, A = πDH + πD²/4 = 7πD²/4 (the side and the top),
 *   M = V/A = 3D/14, so D = 14 M / 3.
 * D rounded up to the millimetre, H too; or the D and H given (by hand).
 * Returns {diameter_mm, height_mm, volume_mm3, riser_modulus_mm}.
 */
export function sizeRiser(modulus, { diameter = null, height = null } = {}) {
  const aspect = RISER_ASPECT;
  // M of a cylinder D across, aspect × D high, without its contact face: D·aspect / (4·aspect + 1).
  const perD = aspect / (4 * aspect + 1);
  const D = diameter > 0 ? diameter : Math.max(1, Math.ceil((RISER_MODULUS_FACTOR * Math.max(0, modulus)) / perD - 1e-9));
  const H = height > 0 ? height : Math.ceil(aspect * D - 1e-9);
  const volume = (Math.PI * D * D * H) / 4;
  const cooling = Math.PI * D * H + (Math.PI * D * D) / 4;
  return { diameter_mm: round(D, 2), height_mm: round(H, 2), volume_mm3: round(volume, 1), riser_modulus_mm: round(volume / cooling, 3) };
}

const massOf = (volume, density) => (density > 0 && Number.isFinite(volume) ? round((volume / 1000) * density, 1) : null);

/**
 * Where a riser stands on the part, for one zone: on top, over the hot spot.
 * On a face of the hot spot turned up with nothing above it; else where the
 * line along d from the centre of one of its balls leaves the part, nothing
 * above; of these, the place whose footprint the part holds best (not over
 * a hole), the nearest to the middle of the hot spot first. Else on the
 * highest free face of the zone.
 */
function topPlace(ctx, zoneId, patch, tops, diameter) {
  const { g, grid, d } = ctx;
  const R = diameter / 2;
  const tol = Math.max(1, 0.15 * diameter);
  const lift = Math.max(1e-3 * (g.diag || 1), 0.02 * diameter);
  const mean = [0, 0, 0];
  let wsum = 0;
  for (const p of patch) {
    for (let k = 0; k < 3; k++) mean[k] += p.w * p.c[k];
    wsum += p.w;
  }
  for (let k = 0; k < 3; k++) mean[k] /= wsum || 1;
  // Points of the footprint of a riser at `contact` on the part (its top there,
  // nothing above): its centre, and on circles of R/3, 2R/3 and R, 8, 12 and
  // 16 points (about R/3 apart).
  const footprint = [[0, 0]];
  for (const [s, count] of FOOTPRINT_RINGS) {
    for (let k = 0; k < count; k++) {
      const a = (2 * Math.PI * (k + s / 2)) / count;
      footprint.push([s * R * Math.cos(a), s * R * Math.sin(a)]);
    }
  }
  const all = footprint.length;
  const held = (contact) => {
    let n = 0;
    for (const [x, y] of footprint) {
      const q = addScaled(addScaled(addScaled(contact, ctx.u, x), ctx.v, y), d, lift);
      const down = grid.crossings(q, -1);
      if (down.length && Math.abs(down[0].t - lift) <= tol && dot(normalAt(g, down[0].f), d) > 0.2 && !grid.crossings(q, 1).length) n++;
    }
    return n;
  };
  // Tried in the order of their distance to the middle of the hot spot, across d, spread over it.
  const across = (p) => {
    const w = sub(p, mean);
    return Math.hypot(dot(w, ctx.u), dot(w, ctx.v));
  };
  const spread = (list) => {
    list.sort((a, b) => a.r - b.r || a.f - b.f);
    const step = Math.max(1, Math.floor(list.length / TOP_TRIES));
    return list.filter((_, k) => k % step === 0).slice(0, TOP_TRIES);
  };
  // The nearest place the part holds (its whole footprint); none: the nearest.
  const pick = (tries, place) => {
    let first = null;
    for (const p of tries) {
      const at = place(p);
      if (!at) continue;
      const n = held(at.contact);
      const found = { ...at, held: n, supported: n === all };
      if (found.supported) return found;
      first ??= found;
    }
    return first;
  };
  // The faces of the hot spot turned up (a boss: its top), nothing above them: points
  // about R/2 apart inside each (a CAD face is a few long triangles), FACE_POINTS at most.
  const points = [];
  const P = g.positions, I = g.indices;
  for (const p of tops) {
    const [a, b, c] = [0, 1, 2].map((k) => [P[3 * I[3 * p.f + k]], P[3 * I[3 * p.f + k] + 1], P[3 * I[3 * p.f + k] + 2]]);
    const longest = Math.max(length(sub(b, a)), length(sub(c, b)), length(sub(a, c)));
    const n = Math.min(FACE_SPLIT, Math.max(1, Math.ceil(longest / Math.max(R / 2, 1e-9))));
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        const s = (i + 1 / 3) / n, t = (j + 1 / 3) / n;
        const at = [0, 1, 2].map((k) => a[k] + s * (b[k] - a[k]) + t * (c[k] - a[k]));
        points.push({ f: p.f, c: p.c, at, r: across(at) });
      }
    }
  }
  let best = pick(spread(points), (p) => {
    if (grid.crossings(addScaled(p.at, d, lift), 1).length) return null;
    return { contact: p.at, triangle: p.f, depth: length(sub(p.at, p.c)), centre: p.c };
  });
  // From the balls of the hot spot (a hot spot inside the part): where the line along d leaves it.
  best ??= pick(spread(patch.map((p) => ({ ...p, r: length(sub(p.c, mean)) }))), (p) => {
    const up = grid.crossings(p.c, 1);
    // From inside the material: the first crossing leaves it by an upward face, and nothing is above.
    if (up.length !== 1 || dot(normalAt(g, up[0].f), d) <= 0) return null;
    return { contact: addScaled(p.c, d, up[0].t), triangle: up[0].f, depth: up[0].t, centre: p.c };
  });
  if (best) return best;
  // The highest face of the zone turned up with nothing above it.
  let top = -1, height = -Infinity;
  for (let f = 0; f < g.nt; f++) {
    if (ctx.zone[f] !== zoneId || dot(normalAt(g, f), d) < 0.5) continue;
    const h = g.centres[3 * f] * d[0] + g.centres[3 * f + 1] * d[1] + g.centres[3 * f + 2] * d[2];
    if (h > height || (h === height && f < top)) {
      const c = centreAt(g, f);
      if (grid.crossings(addScaled(c, d, 1e-6 * (g.diag || 1)), 1).length) continue;
      top = f;
      height = h;
    }
  }
  if (top < 0) return null;
  return { contact: centreAt(g, top), triangle: top, depth: null, centre: mean, supported: false, highest: true };
}

const normalAt = (g, f) => [g.normals[3 * f], g.normals[3 * f + 1], g.normals[3 * f + 2]];
const centreAt = (g, f) => [g.centres[3 * f], g.centres[3 * f + 1], g.centres[3 * f + 2]];

/**
 * Riser of a zone (a summary of feedingZones): on top, or on the side at the
 * parting line when the hot spot is closer to it than to the top.
 * patch -- the balls of its hot spot; tops -- its faces near the hot spot turned up
 */
function placeRiser(ctx, z, patch, tops, n) {
  const size = sizeRiser(z.modulus_mm);
  const top = topPlace(ctx, z.id, patch, tops, size.diameter_mm);
  const hot = top?.centre ?? z.hot_spot_mm;
  // The nearest point of the parting line on this zone, on its outer outline.
  let side = null;
  if (ctx.points && hot) {
    let best = null;
    for (const p of ctx.points) {
      if (p.zone !== z.id) continue;
      const r = length(sub(p.at, hot));
      if (!best || r < best.r) best = { p, r };
    }
    if (best && (!top || top.highest || best.r < length(sub(top.contact, hot)))) {
      const out = outward(ctx, best.p);
      if (out) side = { point: best.p, out };
    }
  }
  const base = {
    id: `R${n}`,
    zone: z.id,
    zone_sphere_mm: z.sphere_mm,
    modulus_mm: z.modulus_mm,
    ...size,
    mass_g: massOf(size.volume_mm3, ctx.density),
    axis: roundVec(ctx.d, 6),
    source: 'proposed',
  };
  if (side) {
    const params = { sphere: fr(z.sphere_mm), modulus: fr(z.modulus_mm, 2), riser: fr(size.riser_modulus_mm, 2) };
    return {
      ...base,
      type: 'side',
      open: false,
      position_mm: roundVec(side.point.at),
      offset: roundVec(side.out, 6),
      reason: 'hot_spot_at_parting_line',
      why: `Point chaud Ø ${params.sphere} mm (module ${params.modulus} mm) plus près du plan de joint que du dessus : masselotte latérale borgne sur la ligne de joint ; module ${params.riser} mm ≥ 1,2 × module de la zone (Chvorinov, Wlodawer).`,
    };
  }
  if (!top) return null;
  const params = { sphere: fr(z.sphere_mm), modulus: fr(z.modulus_mm, 2), riser: fr(size.riser_modulus_mm, 2) };
  const reason = top.highest ? 'highest_face_of_zone' : 'isolated_hot_spot_top';
  return {
    ...base,
    type: 'top',
    open: true,
    position_mm: roundVec(top.contact),
    offset: null,
    reason,
    why: top.highest
      ? `Point chaud Ø ${params.sphere} mm (module ${params.modulus} mm) sans surface libre juste au-dessus : masselotte ouverte sur la face la plus haute de la zone ; module ${params.riser} mm ≥ 1,2 × module de la zone (Chvorinov, Wlodawer).`
      : `Point chaud Ø ${params.sphere} mm (module ${params.modulus} mm) qu'aucune section plus épaisse n'alimente : masselotte ouverte sur le dessus, au-dessus du point chaud ; module ${params.riser} mm ≥ 1,2 × module de la zone (Chvorinov, Wlodawer).`,
  };
}

// ------------------------------------------------------------------ parting line

/**
 * The triangles next to point `at` of the parting line, within r: the
 * nearest one, the thickest wall of those touching the point (the nearest
 * within 1e-4 of the diagonal: the faces on either side of the line, not a
 * thicker section further on, a large triangle of a CAD face reaching far)
 * and their outward normals within r/2 (area-weighted, for the outward
 * sense). {nearest (-1: none), sphere, normal}.
 */
function wallAt(ctx, at, r) {
  const { g, grid } = ctx;
  let nearest = -1, nd = Infinity, sphere = 0;
  const normal = [0, 0, 0];
  const hits = [];
  grid.near(at, r, (f, d2) => {
    if (d2 < nd || (d2 === nd && f < nearest)) {
      nd = d2;
      nearest = f;
    }
    hits.push(f, d2);
    if (d2 <= (r / 2) ** 2) for (let k = 0; k < 3; k++) normal[k] += g.areas[f] * g.normals[3 * f + k];
  });
  const touch = (Math.sqrt(nd) + 1e-4 * (g.diag || 1)) ** 2;
  for (let h = 0; h < hits.length; h += 2) if (hits[h + 1] <= touch && ctx.sphere[hits[h]] > sphere) sphere = ctx.sphere[hits[h]];
  if (!(sphere > 0) && nearest >= 0) sphere = ctx.sphere[nearest];
  return { nearest, sphere, normal };
}

/**
 * Points of the parting line (the middles of its segments, PARTING_POINTS at
 * most, spread along it), each with the triangles next to it: {at, tangent,
 * zone, sphere (the thickest wall touching it), normal (their outward
 * normals, area-weighted), height (along d), segment}.
 */
function partingPoints(ctx, segments) {
  const { g, grid, d } = ctx;
  const m = segments.length / 6;
  const step = Math.max(1, Math.ceil(m / PARTING_POINTS));
  const out = [];
  const reach = Math.max(2 * grid.cell, 1e-4 * (g.diag || 1));
  for (let s = 0; s < m; s += step) {
    const a = [segments[6 * s], segments[6 * s + 1], segments[6 * s + 2]];
    const b = [segments[6 * s + 3], segments[6 * s + 4], segments[6 * s + 5]];
    const at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const { nearest, sphere, normal } = wallAt(ctx, at, Math.max(reach, length(sub(b, a))));
    if (nearest < 0) continue;
    out.push({ at, tangent: sub(b, a), zone: ctx.zone[nearest], sphere, normal, triangle: nearest, height: dot(at, d), segment: s });
  }
  return out;
}

/**
 * The outward direction of the parting line at point p, in the plane normal
 * to d (square to the line), when the way out along it is free: no other
 * piece of the line across it (an inner loop, a hole, is not reached from
 * outside the mould). Null when it is not.
 */
function outward(ctx, p) {
  const { d } = ctx;
  let n = normalize(cross(d, p.tangent));
  if (!n) return null;
  // The sense of the faces there; else the one that is free.
  const s = dot(p.normal, n);
  const candidates = Math.abs(s) > 1e-9 ? [s > 0 ? n : n.map((x) => -x + 0)] : [n, n.map((x) => -x + 0)];
  for (const dir of candidates) if (freeWay(ctx, p, dir)) return dir;
  return null;
}

/** Whether the half-line from point p of the parting line along dir (in the plane normal to d) crosses no other piece of it. */
function freeWay(ctx, p, dir) {
  const { u, v, flat } = ctx;
  const ox = dot(p.at, u), oy = dot(p.at, v);
  const dx = dot(dir, u), dy = dot(dir, v);
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return false;
  const ux = dx / len, uy = dy / len;
  const eps = 1e-6 * (ctx.g.diag || 1);
  for (let s = 0; s < flat.length / 4; s++) {
    if (s === p.segment) continue;
    const ax = flat[4 * s] - ox, ay = flat[4 * s + 1] - oy, bx = flat[4 * s + 2] - ox, by = flat[4 * s + 3] - oy;
    // The pieces through p (its neighbours along the line) are not in the way.
    if (Math.hypot(ax, ay) < eps || Math.hypot(bx, by) < eps) continue;
    const ex = bx - ax, ey = by - ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const t = (ax * ey - ay * ex) / den; // along the ray
    const w = (ax * uy - ay * ux) / den; // along the piece
    if (t > eps && w >= 0 && w <= 1) return false;
  }
  return true;
}

/** The parting line flattened on the plane normal to d: [u0, v0, u1, v1] per segment. */
function flatten(segments, u, v) {
  const m = segments.length / 6;
  const flat = new Float64Array(4 * m);
  for (let s = 0; s < m; s++) {
    const a = [segments[6 * s], segments[6 * s + 1], segments[6 * s + 2]];
    const b = [segments[6 * s + 3], segments[6 * s + 4], segments[6 * s + 5]];
    flat[4 * s] = dot(a, u);
    flat[4 * s + 1] = dot(a, v);
    flat[4 * s + 2] = dot(b, u);
    flat[4 * s + 3] = dot(b, v);
  }
  return flat;
}

/**
 * The loops of the parting line: its pieces chained by their ends (ends
 * closer than 1e-5 of the diagonal of the body are one). The number of the
 * loop of each piece (Int32Array).
 */
function lineLoops(segments, diag) {
  const m = segments.length / 6;
  const q = 1e-5 * (diag || 1);
  const parent = Int32Array.from({ length: m }, (_, s) => s);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const ends = new Map();
  for (let s = 0; s < m; s++) {
    for (const e of [6 * s, 6 * s + 3]) {
      const key = `${Math.round(segments[e] / q)},${Math.round(segments[e + 1] / q)},${Math.round(segments[e + 2] / q)}`;
      const other = ends.get(key);
      if (other === undefined) ends.set(key, s);
      else {
        const a = find(s), b = find(other);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const loop = new Int32Array(m);
  for (let s = 0; s < m; s++) loop[s] = find(s);
  return loop;
}

/**
 * The loops of the parting line on the outer outline (reached from outside
 * the mould): those with a point whose way out is free; a hole has none.
 * LOOP_TRIES points of each loop tested: its extremes across d, then spread
 * along it. Returns {outer (the loop numbers), free (Map point -> its way
 * out, the points found free)}.
 */
function outerLoops(ctx, points) {
  const byLoop = new Map();
  for (const p of points) {
    const id = ctx.loops[p.segment];
    const list = byLoop.get(id);
    if (list) list.push(p);
    else byLoop.set(id, [p]);
  }
  const outer = new Set();
  const free = new Map();
  for (const [id, list] of byLoop) {
    const tries = new Set();
    for (const axis of [ctx.u, ctx.v]) {
      let lo = list[0], hi = list[0];
      for (const p of list) {
        if (dot(p.at, axis) < dot(lo.at, axis)) lo = p;
        if (dot(p.at, axis) > dot(hi.at, axis)) hi = p;
      }
      tries.add(lo).add(hi);
    }
    const step = Math.max(1, Math.ceil(list.length / (LOOP_TRIES - tries.size)));
    for (let k = 0; k < list.length && tries.size < LOOP_TRIES; k += step) tries.add(list[k]);
    for (const p of tries) {
      const dir = outward(ctx, p);
      if (!dir) continue;
      outer.add(id);
      free.set(p, dir);
      break;
    }
  }
  return { outer, free };
}

// ------------------------------------------------------------------ gating

/**
 * An ingate of a wall of inscribed diameter `wall` (mm): thickness
 * GATE_THICKNESS_RATIO × wall, width GATE_WIDTH_RATIO × thickness (rounded to
 * the half millimetre), length along the flow GATE_LENGTH_RATIO × width.
 */
export function sizeGate(wall) {
  const half = (x) => Math.max(0.5, Math.round(2 * x) / 2);
  const thickness = half(GATE_THICKNESS_RATIO * Math.max(0, wall));
  const width = half(GATE_WIDTH_RATIO * thickness);
  const len = half(GATE_LENGTH_RATIO * width);
  return { thickness_mm: thickness, width_mm: width, length_mm: len, section_mm2: round(thickness * width, 2), volume_mm3: round(thickness * width * len, 1) };
}

/**
 * The undercut triangles (SIDE_NONE) in a hash grid of their centres, cells
 * at least `radius` wide: within(p, r <= radius) tells whether one is within
 * r of point p (from its centre, plus its own size). Null without any.
 */
function undercutIndex(g, side, radius) {
  const list = [];
  for (let f = 0; f < g.nt; f++) if (side[f] === SIDE_NONE && g.areas[f] > 0) list.push(f);
  if (!list.length) return null;
  const P = g.positions, I = g.indices;
  const size = new Float64Array(g.nt);
  let cell = radius;
  for (const f of list) {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const a = 3 * I[3 * f + k];
      s = Math.max(s, Math.hypot(P[a] - g.centres[3 * f], P[a + 1] - g.centres[3 * f + 1], P[a + 2] - g.centres[3 * f + 2]));
    }
    size[f] = s;
    cell = Math.max(cell, s);
  }
  cell = Math.max(cell, 1e-3 * (g.diag || 1));
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (const f of list) {
    const k = key(...[0, 1, 2].map((j) => Math.floor(g.centres[3 * f + j] / cell)));
    const bucket = cells.get(k);
    if (bucket) bucket.push(f);
    else cells.set(k, [f]);
  }
  return {
    within(p, r) {
      const reach = Math.ceil((r + cell) / cell);
      const [ci, cj, ck] = p.map((x) => Math.floor(x / cell));
      for (let i = ci - reach; i <= ci + reach; i++) for (let j = cj - reach; j <= cj + reach; j++) for (let k = ck - reach; k <= ck + reach; k++) {
        for (const f of cells.get(key(i, j, k)) ?? []) {
          if (Math.hypot(p[0] - g.centres[3 * f], p[1] - g.centres[3 * f + 1], p[2] - g.centres[3 * f + 2]) <= r + size[f]) return true;
        }
      }
      return false;
    },
  };
}

/**
 * The ingate on the parting line: on its outer outline (a free way out in the
 * parting plane; the loops of the line with none, the holes, last), not next
 * to an undercut (a core or a slide there), the lowest along d (bottom
 * filling: a planar line is level), then away from the risers and their
 * zones, the thickest wall, the first along the line.
 */
function placeGate(ctx, risers) {
  const { g, grid, d, points, side } = ctx;
  if (!points?.length) return null;
  // The points of the outer outline first: those of a hole have no way out (whatever their rank).
  const { outer, free } = outerLoops(ctx, points);
  const onOuter = (p) => outer.has(ctx.loops[p.segment]);
  let low = Infinity, high = -Infinity, lowOuter = Infinity;
  for (const p of points) {
    low = Math.min(low, p.height);
    high = Math.max(high, p.height);
    if (onOuter(p)) lowOuter = Math.min(lowOuter, p.height);
  }
  const band = Math.max(LOW_BAND_MM, LOW_BAND_SHARE * (dot(g.max, d.map(Math.abs)) - dot(g.min, d.map(Math.abs)) || high - low));
  // The lowest of the outer outline (of the whole line without one found).
  const bottom = Number.isFinite(lowOuter) ? lowOuter : low;
  const fedZones = new Set(risers.map((r) => r.zone));
  // An undercut within the reach of the ingate and its wall.
  const reach = (p) => Math.max(sizeGate(p.sphere).width_mm, 2 * p.sphere);
  const undercuts = side ? undercutIndex(g, side, Math.max(...points.map(reach))) : null;
  const scored = points.map((p, k) => {
    const gate = sizeGate(p.sphere);
    const undercut = !!undercuts?.within(p.at, reach(p));
    // Under the footprint of a riser (across d, with the width of the ingate): the riser's own feeding.
    const across = (w) => Math.hypot(dot(w, ctx.u), dot(w, ctx.v));
    const nearRiser = risers.some((r) => across(sub(r.position_mm, p.at)) < r.diameter_mm / 2 + gate.width_mm / 2);
    // The way into the part: from the point to the centroid, in the parting plane.
    const way = across(sub(p.at, g.centroid));
    return { p, k, gate, outer: onOuter(p), undercut, low: p.height <= bottom + band, nearRiser, fed: fedZones.has(p.zone), way };
  });
  // The thickest walls (within THICK_SHARE of the thickest, where the ingate may go), a zone
  // without a riser, then the shortest way into the part (the middle of a long side rather than a corner).
  const thickest = Math.max(0, ...scored.filter((s) => (s.outer || !outer.size) && !s.undercut && s.low).map((s) => s.p.sphere));
  const rank = (s) => [s.outer ? 0 : 1, s.undercut ? 1 : 0, s.low ? 0 : 1, s.nearRiser ? 1 : 0, s.p.sphere >= THICK_SHARE * thickest ? 0 : 1, s.fed ? 1 : 0, Math.round(s.way * 10), s.k];
  scored.sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  let chosen = null, out = null;
  for (const s of scored.slice(0, GATE_TRIES)) {
    out = outward(ctx, s.p);
    if (out) {
      chosen = s;
      break;
    }
  }
  // None of the first free (a notch of the outline): GATE_TRIES more spread over the others of
  // the outer outline, in their order; else the best of the points found free on it.
  if (!chosen) {
    const rest = scored.slice(GATE_TRIES).filter((s) => s.outer);
    const step = Math.max(1, Math.ceil(rest.length / GATE_TRIES));
    for (let k = 0; k < rest.length && !chosen; k += step) {
      out = outward(ctx, rest[k].p);
      if (out) chosen = rest[k];
    }
  }
  if (!chosen) {
    chosen = scored.find((s) => free.has(s.p)) ?? null;
    out = chosen ? free.get(chosen.p) : null;
  }
  if (!chosen) return null;
  const planar = high - low <= band;
  const params = { wall: fr(chosen.p.sphere), thickness: fr(chosen.gate.thickness_mm), width: fr(chosen.gate.width_mm) };
  const where = planar
    ? `Sur la ligne de joint (contour extérieur), dans la paroi la plus épaisse qu'elle longe (Ø inscrit ${params.wall} mm)`
    : `Sur la ligne de joint (contour extérieur), au plus bas selon la direction de démoulage (remplissage par le bas), paroi Ø inscrit ${params.wall} mm`;
  const away = [chosen.undercut ? null : 'des contre-dépouilles', chosen.nearRiser ? null : 'des masselottes'].filter(Boolean);
  return {
    position_mm: roundVec(chosen.p.at),
    direction: roundVec(out.map((x) => -x + 0), 6), // inwards
    on_parting_line: true,
    outer_outline: true,
    zone: chosen.p.zone,
    wall_sphere_mm: round(chosen.p.sphere, 2),
    height_mm: round(chosen.p.height, 2),
    ...chosen.gate,
    near_undercut: chosen.undercut,
    near_riser: chosen.nearRiser,
    reason: planar ? 'thickest_wall_on_parting_line' : 'bottom_fill_on_parting_line',
    why: `${where}${away.length ? `, loin ${away.join(' et ')}` : ''} ; attaque ${params.thickness} × ${params.width} mm (épaisseur 0,7 × paroi, largeur 3 × épaisseur : heuristique).`,
    source: 'proposed',
  };
}

// ------------------------------------------------------------------ placement

/**
 * What the placements need of a body with its zones (feedingZones) and its
 * parting ({direction, side (SIDE_* per triangle), segments}, or null: +Z,
 * no side riser, no ingate).
 */
export function feedingContext(positions, indices, zones, { parting = null, density = null } = {}) {
  const g = feedingMesh(positions, indices);
  const d = normalize(parting?.direction ?? [0, 0, 1]) ?? [0, 0, 1];
  const grid = columnGrid(g, d);
  const segments = parting?.segments?.length ? parting.segments : null;
  const ctx = { g, grid, d, u: grid.u, v: grid.v, zone: zones.zone, sphere: zones.sphere, zones: zones.zones, side: parting?.side ?? null, density, segments, points: null, flat: null, loops: null, parting: !!parting?.direction };
  if (segments) {
    ctx.flat = flatten(segments, grid.u, grid.v);
    ctx.loops = lineLoops(segments, g.diag);
    ctx.points = partingPoints(ctx, segments);
  }
  return ctx;
}

/**
 * Risers and ingate of a body from its zones (feedingZones) for a parting
 * line ({direction, side, segments} or null). Returns {risers, gate,
 * yield, hot_spots_without_riser, direction, parting_known}.
 */
export function placeFeeding(positions, indices, zones, { parting = null, density = null, ctx = null } = {}) {
  ctx ??= feedingContext(positions, indices, zones, { parting, density });
  const { g } = ctx;
  // The balls of the hot spot of each zone, and its faces near the hot spot turned up.
  const peak = new Map(zones.zones.map((z) => [z.id, z.sphere_mm]));
  const patches = new Map(zones.zones.map((z) => [z.id, []]));
  const tops = new Map(zones.zones.map((z) => [z.id, []]));
  for (let f = 0; f < g.nt; f++) {
    const z = ctx.zone[f];
    const D = ctx.sphere[f];
    const top = peak.get(z) ?? Infinity;
    if (!(D >= TOP_PATCH * top - 1e-9) || !(g.areas[f] > 0)) continue;
    const ball = { f, w: g.areas[f], c: [0, 1, 2].map((k) => g.centres[3 * f + k] - (g.normals[3 * f + k] * D) / 2) };
    if (D >= HOT_PATCH * top - 1e-9) patches.get(z).push(ball);
    if (dot(normalAt(g, f), ctx.d) >= 0.5) tops.get(z).push(ball);
  }
  const risers = [];
  const order = zones.zones.filter((z) => z.needs_riser).sort((a, b) => b.modulus_mm - a.modulus_mm || a.id - b.id);
  for (const z of order) {
    const r = placeRiser(ctx, z, patches.get(z.id), tops.get(z.id), risers.length + 1);
    if (r) risers.push(r);
  }
  const gate = placeGate(ctx, risers);
  return {
    direction: roundVec(ctx.d, 6),
    parting_known: ctx.parting,
    risers,
    gate,
    yield: feedingYield(zones.body.volume_mm3, risers, gate),
    hot_spots_without_riser: hotSpotsWithoutRiser(zones.zones, risers),
  };
}

/** The zones that need a riser and have none (deleted, or moved away by hand). */
export function hotSpotsWithoutRiser(zones, risers) {
  const fed = new Set(risers.map((r) => r.zone));
  return zones.filter((z) => z.needs_riser && !fed.has(z.id)).map((z) => z.id);
}

/**
 * Casting yield, for information: part / (part + risers + ingate). The
 * sprue, the runners and the pouring cup are not counted (not designed
 * here): an upper bound.
 */
export function feedingYield(partVolume, risers, gate) {
  const risersVolume = risers.reduce((s, r) => s + (r.volume_mm3 || 0), 0);
  const gating = gate?.volume_mm3 ?? 0;
  const total = partVolume + risersVolume + gating;
  return {
    value: total > 0 ? round(partVolume / total, 4) : null,
    part_volume_mm3: round(partVolume, 1),
    risers_volume_mm3: round(risersVolume, 1),
    gating_volume_mm3: round(gating, 1),
    counted: 'part_risers_ingate',
  };
}

// ------------------------------------------------------------------ by hand

/**
 * A riser placed by hand at a point of the part (a click on the 3D view):
 * sized from the zone of the triangle touched (or the D and H given), on top
 * when the face there is turned up along d (open), else on the side (blind).
 *
 * point    -- on the surface (mm, the frame of the mesh)
 * triangle -- the triangle touched (its zone, its normal), or -1
 * zones    -- feedingZones of the body
 * normal   -- outward normal there (else the triangle's)
 * Returns a riser, like those of placeFeeding (source "manual").
 */
export function riserFromPoint(point, { triangle = -1, zones, normal = null, direction = [0, 0, 1], density = null, diameter = null, height = null, id = 'M1', positions = null, indices = null } = {}) {
  const d = normalize(direction) ?? [0, 0, 1];
  const zoneId = triangle >= 0 && zones?.zone ? zones.zone[triangle] : -1;
  const z = zones?.zones?.[zoneId] ?? null;
  let n = normal ? normalize(normal) : null;
  if (!n && triangle >= 0 && positions && indices) {
    const g = feedingMesh(positions, indices);
    n = normalAt(g, triangle);
  }
  const sphere = z?.sphere_mm ?? (triangle >= 0 ? zones?.sphere?.[triangle] ?? null : null);
  const modulus = z?.modulus_mm ?? (sphere != null ? HOT_SPOT_MODULUS * sphere : 0);
  const size = sizeRiser(modulus, { diameter, height });
  const top = !n || dot(n, d) >= 0.5;
  // Beside the part, square to d, on the side the face looks to.
  const offset = top ? null : normalize(sub(n, d.map((x) => x * dot(n, d))));
  const byHand = diameter > 0 || height > 0;
  return {
    id,
    zone: zoneId,
    zone_sphere_mm: sphere != null ? round(sphere, 2) : null,
    modulus_mm: round(modulus, 3),
    ...size,
    mass_g: massOf(size.volume_mm3, density),
    axis: roundVec(d, 6),
    type: top ? 'top' : 'side',
    open: top,
    position_mm: roundVec(point),
    offset: offset ? roundVec(offset, 6) : null,
    source: 'manual',
    sized_by_hand: byHand,
    reason: byHand ? 'manual_sized' : 'manual',
    why: byHand
      ? 'Placée et dimensionnée à la main.'
      : `Placée à la main ; dimensionnée sur le module de la zone touchée (${fr(modulus, 2)} mm × 1,2).`,
  };
}

/** A riser with another D and H (typed by hand): its volume, modulus and mass again. */
export function resizeRiser(riser, { diameter = null, height = null, density = null } = {}) {
  const size = sizeRiser(riser.modulus_mm ?? 0, { diameter: diameter ?? riser.diameter_mm, height: height ?? riser.height_mm });
  return { ...riser, ...size, mass_g: massOf(size.volume_mm3, density), sized_by_hand: true, reason: riser.source === 'manual' ? 'manual_sized' : riser.reason, why: riser.source === 'manual' ? 'Placée et dimensionnée à la main.' : `${riser.why} Dimensions modifiées à la main.` };
}

/**
 * The nearest point of the parting line (segments: xyz of both ends of each
 * piece) to `point`: {point, distance, segment}, or null without a line.
 */
export function snapToPartingLine(point, segments) {
  const m = (segments?.length ?? 0) / 6;
  let best = null;
  for (let s = 0; s < m; s++) {
    const a = [segments[6 * s], segments[6 * s + 1], segments[6 * s + 2]];
    const ab = [segments[6 * s + 3] - a[0], segments[6 * s + 4] - a[1], segments[6 * s + 5] - a[2]];
    const l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(point, a), ab) / l2)) : 0;
    const q = addScaled(a, ab, t);
    const r = length(sub(point, q));
    if (!best || r < best.distance) best = { point: q, distance: r, segment: s };
  }
  return best;
}

/**
 * The ingate placed by hand near `point`: brought to the nearest point of the
 * parting line when there is one (inward in the parting plane, sized from the
 * wall there), else where it was clicked (along -normal).
 * ctx -- feedingContext of the body for its parting
 */
export function gateFromPoint(point, ctx, { triangle = -1, normal = null } = {}) {
  const snap = ctx.segments ? snapToPartingLine(point, ctx.segments) : null;
  if (snap) {
    const s = snap.segment;
    const raw = ctx.segments;
    const a = [raw[6 * s], raw[6 * s + 1], raw[6 * s + 2]], b = [raw[6 * s + 3], raw[6 * s + 4], raw[6 * s + 5]];
    const r = Math.max(2 * ctx.grid.cell, length(sub(b, a)), 1e-4 * (ctx.g.diag || 1));
    const { nearest, sphere: wall, normal: nrm } = wallAt(ctx, snap.point, r);
    const p = { at: snap.point, tangent: sub(b, a), normal: nrm, segment: s, zone: nearest >= 0 ? ctx.zone[nearest] : -1, sphere: wall };
    let out = outward(ctx, p);
    const outer = !!out;
    if (!out) out = normalize(cross(ctx.d, p.tangent)) ?? [1, 0, 0];
    const gate = sizeGate(wall);
    return {
      position_mm: roundVec(snap.point),
      direction: roundVec(out.map((x) => -x + 0), 6),
      on_parting_line: true,
      outer_outline: outer,
      zone: p.zone,
      wall_sphere_mm: round(wall, 2),
      height_mm: round(dot(snap.point, ctx.d), 2),
      ...gate,
      near_undercut: null,
      near_riser: null,
      reason: 'manual_on_parting_line',
      why: `Placée à la main, ramenée au point le plus proche de la ligne de joint ; attaque ${fr(gate.thickness_mm)} × ${fr(gate.width_mm)} mm (paroi Ø inscrit ${fr(wall)} mm).`,
      source: 'manual',
    };
  }
  const wall = triangle >= 0 ? ctx.sphere[triangle] ?? 0 : 0;
  let n = normal ? normalize(normal) : triangle >= 0 ? normalAt(ctx.g, triangle) : null;
  n ??= [0, 0, 1];
  const gate = sizeGate(wall);
  return {
    position_mm: roundVec(point),
    direction: roundVec(n.map((x) => -x + 0), 6),
    on_parting_line: false,
    outer_outline: null,
    zone: triangle >= 0 ? ctx.zone[triangle] : -1,
    wall_sphere_mm: round(wall, 2),
    height_mm: round(dot(point, ctx.d), 2),
    ...gate,
    near_undercut: null,
    near_riser: null,
    reason: 'manual_without_parting_line',
    why: `Placée à la main (pas de ligne de joint connue) ; attaque ${fr(gate.thickness_mm)} × ${fr(gate.width_mm)} mm.`,
    source: 'manual',
  };
}

// ------------------------------------------------------------------ all at once

/**
 * Risers and ingate proposed for a closed body.
 *
 * positions, indices -- its mesh (mm); not modified
 * sphere  -- inscribed diameter per triangle (thickness.js), computed when not given
 * parting -- {direction, side, segments} (parting.js), or null (+Z, no ingate)
 * density -- g/cm³, for the masses (else volumes only)
 * Returns {version, status, method, zones, risers, gate, yield,
 * hot_spots_without_riser, direction, parting_known, body, sphere_source,
 * sampled} and, per triangle, zone and sphere (typed arrays).
 */
export function proposeFeeding(positions, indices, { sphere = null, parting = null, density = null, fullLimit = FULL_LIMIT, samples = SAMPLES, seed = SEED, onProgress = null } = {}) {
  const zones = feedingZones(positions, indices, { sphere, fullLimit, samples, seed, onProgress });
  const placed = placeFeeding(positions, indices, zones, { parting, density });
  return {
    version: FEEDING_VERSION,
    status: 'proposed',
    method: METHOD,
    zones: zones.zones,
    ...placed,
    body: zones.body,
    sphere_source: zones.sphere_source,
    sampled: zones.sampled,
    zone: zones.zone,
    sphere: zones.sphere,
  };
}

export const METHOD = 'inscribed_sphere_watershed_modulus';
