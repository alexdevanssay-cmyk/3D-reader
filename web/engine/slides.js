// Slides (« tiroirs ») of a cast part, from the undercuts of the parting line
// shown (parting.js, or drawn by hand: parting-draw.js): the triangles no
// half of the mould can form, grouped by the lateral direction that pulls a
// slide out of them (its « direction de sortie »).
//
// The undercut triangles joined by a vertex are regions. Each region is
// tested along every direction of one pool: the axes of the die in the
// parting plane and a sweep between them, the axes of the frame, the mean
// normal and the axis of each region, up to 45° out of the plane. A line of
// sight from a point of it, moved off the surface along its normal, that
// meets no other triangle along s: s frees that point (a face turned against
// s would be dragged: never). A direction that frees 95 % of a region makes
// it one zone; else a greedy cover on its triangles splits it between
// directions, and a region covered less than 80 % is a probable core
// (« noyau »). Zones a half could form are to rework at the parting line,
// shallow small ones are markings, ignored. The other zones are grouped into
// slides: a greedy set cover by the direction that releases the most zones.
//
// One bounding volume hierarchy per body (thickness.js rayCaster), kept by
// the worker between definitions; the lines cast are bounded whatever the
// size of the mesh (points drawn by area, fixed seeds): the same input gives
// the same result, whatever the order or the winding of the triangles.
//
// The grouping, the edits by hand and their persistence (effectiveSlides,
// editSlides, matchSlideState) are pure functions of the analysis (JSON):
// the page runs them without the mesh.
//
// Plain JavaScript without bare imports: it runs in the slides worker
// (slideworker.js) and on the page.

import {
  REACH_DOWN, REACH_UP, SAMPLE_POINTS, SEED, SIDE_LOWER, SIDE_UPPER, TRAPPED, axisLabel, eigenvectors, prepareMesh, sameDirection, sampleByArea,
  snapDirection,
} from './parting.js';
import { rayCaster } from './thickness.js';

export const SLIDES_VERSION = 1;
const METHOD = "lateral_release_lines_of_sight_bvh";

/**
 * Thresholds of the analysis (each can be overridden by the options of
 * analyseSlides; echoed in the analysis as `thresholds`, which the grouping
 * and the edits use).
 */
export const SLIDE_DEFAULTS = Object.freeze({
  releaseShare: 0.95, // a direction releases a zone: it frees this share of its area
  coreShare: 0.2, // uncovered share of a region at or above which the whole region is a core
  maxTiltDeg: 45, // directions tested up to this tilt out of the parting plane
  sweepDeg: 15, // step of the sweep in the parting plane
  sameDirDeg: 0.5, // two directions closer than this are one
  tieShare: 0.05, // of a region: gains of the cover this close are a tie (die axes first)
  shallowDepthMm: 1.5, // markings: shallower than this…
  shallowAreaShare: 0.02, // …and smaller than this share of the surface
  noiseMm2: 1, // a region under max(this, noiseShare × surface): noise, left yellow
  noiseShare: 1e-4,
  clearanceMm: 5, // stroke = depth + this
  smallMm: 6, // both sizes under this: tag « small: machined? »
  longStrokeMm: 120, // tag « long stroke » above
  manySlides: 4, // warning above this count
  highUndercutShare: 0.3, // warning: undercuts on more than this share of the surface
  maxRegions: 128, // the largest regions analysed, the others listed « not analysed »
  maxDirections: 64, // size of the pool of directions
  rayBudget: 2_000_000, // samples × directions of the ranking of the regions
  splitRayBudget: 1_000_000, // lines of the per-triangle classification of the regions split
});

export const ZONE_KINDS = Object.freeze(["slide", "core", "parting", "ignored"]);

const DEG = Math.PI / 180;
const KEEP_SHARE = 0.5; // the releases a zone keeps
const TESTED_SHARE = 0.05; // a region split: the directions freeing this share of its samples, tested per triangle
const COVER_STEP = 0.01; // of the region: the cover stops below this gain
const COVER_MAX = 4; // directions of a cover
const RECASTS = 8; // hits skipped along one line at most (then blocked)
const SMOOTH_FACETS = Math.cos(35 * DEG); // the next facets of one smooth surface (parting.js lineHits)
const ALONG = 1e-6; // |n·s| below: a face along the line, not crossed
const DRAWS_MIN = 32;
const DRAWS_MAX = 256;
const DRAWS_PER_TRIANGLE = 4;
const SPLIT_DRAWS = 2048; // triangles drawn by area of a region too large to classify every triangle of
const TRIANGLE_POINTS = 4; // a triangle along s: free when at least TRIANGLE_FREE of these points are
const TRIANGLE_FREE = 2;
const MEAN_NORMAL_MIN = 0.05; // a region's mean normal, a direction of the pool when at least this long
const PROJECTED_MIN = 0.2; // a direction projected on the parting plane, kept when at least this long
const FLAT_DEG = 1; // a tilt or an angle under this: none
const HALF_SHARE = 0.8; // the half of a zone: its neighbours in one half over this share
const HALF_FORMABLE = 0.95; // a zone a half could form: to rework at the parting line…
const PARALLEL_SHARE = 0.95; // …unless a slide in the plane forms it, not along its faces
const ALSO_BY_HALF = 0.5; // tag of a slide: a member a half could form for this share
const AREA_TIE = 1e-6; // mm²: areas (rounded to 0.01) equal

const { R2A, R2B, INSET } = SAMPLE_POINTS;

// ------------------------------------------------------------------ vectors

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits + 0; // + 0: no -0
const round6 = (v) => v.map((x) => round(x, 6));
const tiltOf = (s, d) => Math.asin(Math.min(1, Math.abs(dot(s, d)))) / DEG;
/** v without its component along d. */
const flatten = (v, d) => {
  const k = dot(v, d);
  return [v[0] - k * d[0], v[1] - k * d[1], v[2] - k * d[2]];
};

/** "+X", "-Y" for an axis of the frame, else its components (axisLabel). */
function signedLabel(s) {
  const label = axisLabel(s);
  return /^[XYZ]$/.test(label) ? `+${label}` : label;
}

/** The axis of the frame s is (snapped: exactly), "+X"…, else null. */
function frameAxis(s) {
  const k = s.findIndex((x) => Math.abs(x) === 1);
  return k >= 0 && s.every((x, i) => i === k || x === 0) ? `${s[k] < 0 ? "-" : "+"}${"XYZ"[k]}` : null;
}

/** "+u", "-v"… when s is an axis of the die, else null. */
function dieAxisOf(s, u, v) {
  const names = [["+u", u, 1], ["+v", v, 1], ["-u", u, -1], ["-v", v, -1]];
  for (const [name, a, sign] of names) if (sign * dot(s, a) > 1 - 1e-9) return name;
  return null;
}

/**
 * The axes of the die in the parting plane of d: u the longest projection of
 * an axis of the frame on the plane (ties: X, then Y, then Z), v = d × u
 * with its largest component positive; each within 1° of an axis of the
 * frame, that axis. d = ±Z: X and Y; d = X: Y and Z.
 */
export function dieAxes(direction) {
  const d = normalize(direction);
  let best = -1;
  let u = null;
  for (let k = 0; k < 3; k++) {
    const p = flatten([0, 1, 2].map((i) => (i === k ? 1 : 0)), d);
    const len = Math.hypot(p[0], p[1], p[2]);
    if (len > best + 1e-9) {
      best = len;
      u = snapDirection(p);
    }
  }
  let v = normalize(cross(d, u));
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i;
  if (v[k] < 0) v = v.map((x) => -x + 0);
  return { u, v: snapDirection(v) };
}

/** The frame of a slide along s for draw direction d: b the height in its face (d without its part along s), a = b × s. */
export function slideBasis(s, d) {
  const b = normalize(flatten(d, s)) ?? normalize(cross(s, Math.abs(s[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  return { a: cross(b, s), b };
}

/**
 * The language-neutral parts of the name of a direction s (draw direction
 * d, die axes u, v): {axis ("X", "-Y", or its components), reference_axis
 * (the sense of an axis of the die nearest its projection on the parting
 * plane, "+X"…), angle_deg (from that reference to its projection, about d,
 * right-handed; null under 1°), tilt_deg (out of the plane; null under 1°),
 * tilt_up (towards +d)}. The page writes « +Y », « +Y +30° », « +Y, incliné
 * de 20° vers le haut ».
 */
export function directionParts(s, d, u, v) {
  const sd = dot(s, d);
  const p = normalize(flatten(s, d));
  let ref = u;
  let angle = null;
  if (p) {
    let best = -Infinity;
    for (const r of [u, v, u.map((x) => -x + 0), v.map((x) => -x + 0)]) {
      const c = dot(r, p);
      if (c > best + 1e-9) {
        best = c;
        ref = r;
      }
    }
    const a = Math.atan2(dot(cross(ref, p), d), dot(ref, p)) / DEG;
    angle = Math.abs(a) < FLAT_DEG ? null : round(a, 1);
  }
  const tilt = tiltOf(s, d);
  return { axis: axisLabel(s), reference_axis: signedLabel(ref), angle_deg: angle, tilt_deg: tilt < FLAT_DEG ? null : round(tilt, 1), tilt_up: sd > 1e-9 };
}

// ------------------------------------------------------------------ mask, signature

/**
 * The undercut triangles of a parting definition, as the page paints them
 * yellow: those of a drawing (`undercut`), else those no half can form (their
 * REACH_* cleared, TRAPPED included) but the faces reassigned by hand
 * (`fixed`). A Uint8Array per triangle.
 */
export function undercutMask(field) {
  const flags = field.flags;
  const nt = field.undercut ? field.undercut.length : flags.length;
  const mask = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    mask[f] = field.undercut ? (field.undercut[f] === 1 ? 1 : 0) : !(flags[f] & (REACH_UP | REACH_DOWN)) && !field.fixed?.[f] ? 1 : 0;
  }
  return mask;
}

/** FNV-1a 32 of bytes fed to it, as 8 hex digits. */
function fnv32() {
  let h = 0x811c9dc5;
  return {
    byte(b) {
      h = Math.imul(h ^ b, 0x01000193) >>> 0;
    },
    text(s) {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) this.byte(c);
        else for (const b of new TextEncoder().encode(s[i])) this.byte(b);
      }
    },
    hex: () => h.toString(16).padStart(8, "0"),
  };
}

/**
 * The signature of an analysis input: FNV-1a 32 of « s1|<nt>|<d to 6
 * decimals>| », then of the indices of the triangles of the mask, delta-coded
 * as LEB128 bytes. "s1:<nt>:<count>:<8 hex>". Another definition (another
 * candidate, a face picked or reassigned, a direction typed, a drawing),
 * another signature.
 */
export function slidesSignature({ nt, direction, mask }) {
  const h = fnv32();
  h.text(`s1|${nt}|${direction.map((x) => round(x, 6).toFixed(6)).join(",")}|`);
  let count = 0;
  let previous = 0;
  for (let f = 0; f < nt; f++) {
    if (!mask[f]) continue;
    count++;
    let delta = f - previous;
    previous = f;
    while (delta >= 0x80) {
      h.byte((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    h.byte(delta);
  }
  return `s1:${nt}:${count}:${h.hex()}`;
}

// ------------------------------------------------------------------ preparation

function unionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a < b) parent[b] = a;
    else if (b < a) parent[a] = b;
  };
  return { find, union };
}

/**
 * What every analysis of a body needs, computed once (the worker keeps the
 * last body's): {mesh (parting.js prepareMesh: centred positions, outward
 * normals, areas, centres, longest edges, welded vertices), caster (lines
 * cast on a hierarchy of the centred float32 positions), eps (the offset of
 * the points off the surface: above the rounding of float32 positions far
 * from the origin), tEps, vertexTris ({start, items}: the triangles of each
 * welded vertex), shellOf (the connected shell of each triangle), shellCount
 * (the triangles of each shell)}.
 */
export function prepareSlides(positions, indices) {
  const mesh = prepareMesh(positions, indices);
  const { nt, diag } = mesh;
  const { welded: W, nv } = mesh.merged;
  const caster = rayCaster(Float32Array.from(mesh.positions), indices);
  let maxAbs = 0;
  if (positions instanceof Float32Array) {
    for (let i = 0; i < positions.length; i++) {
      const a = Math.abs(positions[i]);
      if (a > maxAbs) maxAbs = a;
    }
  }
  const start = new Int32Array(nv + 1);
  for (let c = 0; c < 3 * nt; c++) start[W[c] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const items = new Int32Array(3 * nt);
  const fill = start.slice(0, nv);
  for (let c = 0; c < 3 * nt; c++) items[fill[W[c]]++] = (c / 3) | 0;
  const uf = unionFind(nv);
  for (let f = 0; f < nt; f++) {
    uf.union(W[3 * f], W[3 * f + 1]);
    uf.union(W[3 * f], W[3 * f + 2]);
  }
  const shellOf = new Int32Array(nt);
  const label = new Int32Array(nv).fill(-1);
  const counts = [];
  for (let f = 0; f < nt; f++) {
    const r = uf.find(W[3 * f]);
    if (label[r] < 0) {
      label[r] = counts.length;
      counts.push(0);
    }
    shellOf[f] = label[r];
    counts[label[r]]++;
  }
  return {
    mesh, caster, eps: Math.max(1e-5 * diag, 1e-6 * maxAbs), tEps: 1e-7 * diag, vertexTris: { start, items }, shellOf, shellCount: Int32Array.from(counts),
  };
}

// ------------------------------------------------------------------ analysis

/**
 * Slides of one parting definition of a body.
 *
 * prepared -- prepareSlides(positions, indices) of the body
 * input -- {direction (the draw direction), mask (its undercut triangles:
 *   undercutMask), flags (REACH_*, TRAPPED per triangle for that direction,
 *   or null), side (SIDE_* per triangle, or null), draftDeg, sig}
 * options -- thresholds overriding SLIDE_DEFAULTS, and onProgress(share)
 *   called after each region
 * Returns the analysis (JSON, but `zone`: per triangle the index of its zone
 * in `zones`, -1 not undercut, -2 noise, -3 not analysed).
 */
export function analyseSlides(prepared, input, options = {}) {
  const { onProgress = null, ...overrides } = options;
  const O = { ...SLIDE_DEFAULTS };
  for (const k of Object.keys(SLIDE_DEFAULTS)) if (Number.isFinite(overrides[k])) O[k] = overrides[k];
  const { mesh, caster, eps, tEps, shellOf, shellCount } = prepared;
  const { start: vStart, items: vItems } = prepared.vertexTris;
  const { nt, normals: N, areas, centres: C, positions: P, indices: I, reach, diag, totalArea, centre } = mesh;
  const W = mesh.merged.welded;
  const nv = mesh.merged.nv;
  const d = normalize(input.direction ?? []);
  if (!d) throw new Error("Invalid draw direction");
  const { mask } = input;
  if (!mask || mask.length !== nt) throw new Error("The undercut mask does not match the body");
  const flags = input.flags ?? null;
  const side = input.side ?? null;
  const draftDeg = input.draftDeg ?? 1;
  const sinDraft = Math.sin(draftDeg * DEG);
  const { u, v } = dieAxes(d);
  const zone = new Int32Array(nt).fill(-1);

  let undercutArea = 0;
  let undercutCount = 0;
  for (let f = 0; f < nt; f++) {
    if (!mask[f]) continue;
    undercutCount++;
    undercutArea += areas[f];
  }
  const undercutShare = totalArea > 0 ? undercutArea / totalArea : 0;
  let rays = 0;
  const result = (fields) => ({
    version: SLIDES_VERSION,
    method: METHOD,
    sig: input.sig ?? null,
    direction: round6(d),
    die_axes: { u: round6(u), v: round6(v) },
    ...fields,
    undercut_area_mm2: round(undercutArea, 2),
    undercut_share: round(undercutShare, 3),
    surface_area_mm2: round(totalArea, 2),
    diag_mm: round(diag, 2),
    warnings: undercutShare > O.highUndercutShare ? ["undercut_share_high"] : [],
    thresholds: { ...O },
    zone,
  });
  if (!undercutCount) {
    return result({
      status: "none", directions: [], zones: [], noise: { zones: 0, area_mm2: 0 }, not_analysed: { zones: 0, area_mm2: 0 },
      sampled: { scaled: false, split_sampled: 0 }, stats: { rays: 0, split_rays: 0, regions: 0, directions: 0 },
    });
  }

  // Triangles by their centre (x, then y, then z): the same order whatever
  // the order of the mesh (then by normal, then index: never met on a mesh).
  const byCentre = (f, g) => C[3 * f] - C[3 * g] || C[3 * f + 1] - C[3 * g + 1] || C[3 * f + 2] - C[3 * g + 2] || N[3 * f] - N[3 * g] || N[3 * f + 1] - N[3 * g + 1] || N[3 * f + 2] - N[3 * g + 2] || f - g;
  /** Area, centroid g, mean normal m, normal moment M (xx xy xz yy yz zz) of triangles. */
  const statsOf = (tris) => {
    let A = 0, gx = 0, gy = 0, gz = 0, mx = 0, my = 0, mz = 0;
    const M = [0, 0, 0, 0, 0, 0];
    for (const f of tris) {
      const a = areas[f];
      const nx = N[3 * f], ny = N[3 * f + 1], nz = N[3 * f + 2];
      A += a;
      gx += a * C[3 * f];
      gy += a * C[3 * f + 1];
      gz += a * C[3 * f + 2];
      mx += a * nx;
      my += a * ny;
      mz += a * nz;
      M[0] += a * nx * nx;
      M[1] += a * nx * ny;
      M[2] += a * nx * nz;
      M[3] += a * ny * ny;
      M[4] += a * ny * nz;
      M[5] += a * nz * nz;
    }
    if (!(A > 0)) {
      // Slivers only: their centres.
      const n = tris.length;
      const g = [0, 1, 2].map((k) => tris.reduce((s, f) => s + C[3 * f + k], 0) / n);
      return { area: A, g, m: [0, 0, 0], M };
    }
    return { area: A, g: [gx / A, gy / A, gz / A], m: [mx / A, my / A, mz / A], M };
  };
  // Geometric order: by centroid (x, then y, then z, each to 1e-6 of the diagonal), then the larger.
  const q = 1e-6 * diag || 1e-12;
  const keyOf = (g) => g.map((x) => Math.round(x / q));
  const geometric = (a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || b.area - a.area || a.tris.length - b.tris.length || byCentre(a.tris[0], b.tris[0]);

  // Regions: the undercut triangles joined by a welded vertex.
  const uf = unionFind(nv);
  for (let f = 0; f < nt; f++) {
    if (!mask[f]) continue;
    uf.union(W[3 * f], W[3 * f + 1]);
    uf.union(W[3 * f], W[3 * f + 2]);
  }
  const regionOf = new Int32Array(nv).fill(-1);
  const lists = [];
  const shellMasked = new Int32Array(shellCount.length);
  for (let f = 0; f < nt; f++) {
    if (!mask[f]) continue;
    const r = uf.find(W[3 * f]);
    if (regionOf[r] < 0) {
      regionOf[r] = lists.length;
      lists.push([]);
    }
    lists[regionOf[r]].push(f);
    shellMasked[shellOf[f]]++;
  }
  let regions = lists.map((tris) => {
    tris.sort(byCentre);
    const st = statsOf(tris);
    const shell = shellOf[tris[0]];
    return { tris, ...st, key: keyOf(st.g), enclosed: shellMasked[shell] === shellCount[shell] };
  });
  regions.sort(geometric);
  const regionCount = regions.length;
  const noiseArea = Math.max(O.noiseMm2, O.noiseShare * totalArea);
  const noise = { zones: 0, area: 0 };
  const notAnalysed = { zones: 0, area: 0 };
  regions = regions.filter((R) => {
    if (R.area >= noiseArea) return true;
    noise.zones++;
    noise.area += R.area;
    for (const f of R.tris) zone[f] = -2;
    return false;
  });
  if (regions.length > O.maxRegions) {
    const kept = new Set([...regions].sort((a, b) => b.area - a.area || geometric(a, b)).slice(0, O.maxRegions));
    regions = regions.filter((R) => {
      if (kept.has(R)) return true;
      notAnalysed.zones++;
      notAnalysed.area += R.area;
      for (const f of R.tris) zone[f] = -3;
      return false;
    });
  }

  // The pool of directions: the sweep in the plane (the die axes at 0, 90,
  // 180, 270°), the axes of the frame, then each region's mean normal and
  // axis (the eigenvector of the least moment of its normals), as they are
  // and projected on the plane; within 1° of an axis of the frame, that axis.
  const pool = [];
  const sameCos = Math.cos(O.sameDirDeg * DEG);
  const add = (t, source) => {
    if (pool.length >= O.maxDirections) return;
    const n = normalize(t);
    if (!n) return;
    const s = snapDirection(n);
    const tilt = tiltOf(s, d);
    if (tilt > O.maxTiltDeg + 1e-9) return;
    if (pool.some((e) => dot(e.s, s) > sameCos)) return;
    pool.push({ s, source, tilt, die: dieAxisOf(s, u, v), frame: frameAxis(s) });
  };
  // Tilts within 1e-6° are equal (the rounding of directions in the plane).
  const byTilt = (a, b) => (Math.abs(a.tilt - b.tilt) > 1e-6 ? a.tilt - b.tilt : 0);
  const steps = Math.max(4, Math.round(360 / O.sweepDeg));
  const dies = [u, v, u.map((x) => -x + 0), v.map((x) => -x + 0)];
  for (let k = 0; k < steps; k++) {
    if ((4 * k) % steps === 0) add(dies[(4 * k) / steps], "die_axis");
    else {
      const a = (2 * Math.PI * k) / steps;
      add([0, 1, 2].map((i) => Math.cos(a) * u[i] + Math.sin(a) * v[i]), "sweep");
    }
  }
  for (let k = 0; k < 3; k++) for (const sign of [1, -1]) add([0, 1, 2].map((i) => (i === k ? sign : 0)), "frame");
  for (const R of regions) {
    const list = [];
    if (Math.hypot(R.m[0], R.m[1], R.m[2]) >= MEAN_NORMAL_MIN) list.push(R.m);
    const e = eigenvectors(R.M)[2];
    list.push(e, e.map((x) => -x));
    for (const t of list) {
      add(t, "zone");
      const p = flatten(normalize(t), d);
      if (Math.hypot(p[0], p[1], p[2]) >= PROJECTED_MIN) add(p, "zone");
    }
  }
  /** Of two directions of the pool (indices), the one a slide had better take: an axis of the die, of the frame, the smaller tilt, the first. */
  const prefer = (i, j) => {
    const a = pool[i], b = pool[j];
    if (!a.die !== !b.die) return a.die ? -1 : 1;
    if (!a.frame !== !b.frame) return a.frame ? -1 : 1;
    return byTilt(a, b) || i - j;
  };

  /** Releases: the larger share, an axis of the die, of the frame, the smaller tilt, the shallower, the first. */
  const releaseOrder = (x, y) => {
    if (x.share !== y.share) return y.share - x.share;
    const a = pool[x.dir], b = pool[y.dir];
    if (!a.die !== !b.die) return a.die ? -1 : 1;
    if (!a.frame !== !b.frame) return a.frame ? -1 : 1;
    return byTilt(a, b) || (x.depth_mm != null && y.depth_mm != null ? x.depth_mm - y.depth_mm : 0) || x.dir - y.dir;
  };

  // The points of a triangle: its centre, then a low-discrepancy sequence
  // over it (its corners by position: the same whatever its winding), as
  // classify (parting.js) draws them.
  const before = (a, b) => P[a] < P[b] || (P[a] === P[b] && (P[a + 1] < P[b + 1] || (P[a + 1] === P[b + 1] && P[a + 2] < P[b + 2])));
  const pointOf = (f, j, out) => {
    const cx = C[3 * f], cy = C[3 * f + 1], cz = C[3 * f + 2];
    if (!j) {
      out[0] = cx;
      out[1] = cy;
      out[2] = cz;
      return;
    }
    let a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    if (before(b, a)) [a, b] = [b, a];
    if (before(c, b)) [b, c] = [c, b];
    if (before(b, a)) [a, b] = [b, a];
    let p = (0.5 + j * R2A) % 1, r = (0.5 + j * R2B) % 1;
    if (p + r > 1) {
      p = 1 - p;
      r = 1 - r;
    }
    for (let k = 0; k < 3; k++) out[k] = C[3 * f + k] + INSET * (P[a + k] + p * (P[b + k] - P[a + k]) + r * (P[c + k] - P[a + k]) - C[3 * f + k]);
  };
  const sharesVertex = (f, g) => {
    const a = W[3 * f], b = W[3 * f + 1], c = W[3 * f + 2];
    for (let k = 0; k < 3; k++) {
      const w = W[3 * g + k];
      if (w === a || w === b || w === c) return true;
    }
    return false;
  };
  const origin = [0, 0, 0];
  const hit = [0];
  /**
   * The line from point x of triangle f, off the surface, along s meets no
   * other triangle: but itself, faces along the line, and the next facets
   * of the same smooth surface within its size (a line from a facet at a
   * silhouette grazes them: parting.js lineHits). The caller has checked
   * that f does not face against s.
   */
  const free = (f, x, s) => {
    const nx = N[3 * f], ny = N[3 * f + 1], nz = N[3 * f + 2];
    origin[0] = x[0] + eps * nx;
    origin[1] = x[1] + eps * ny;
    origin[2] = x[2] + eps * nz;
    let tMin = tEps;
    for (let k = 0; k < RECASTS; k++) {
      rays++;
      const t = caster.ray(origin, s, tMin, hit);
      if (!(t < Infinity)) return true;
      const g = hit[0];
      const gx = N[3 * g], gy = N[3 * g + 1], gz = N[3 * g + 2];
      if (g === f || Math.abs(gx * s[0] + gy * s[1] + gz * s[2]) < ALONG || (t <= reach[f] && gx * nx + gy * ny + gz * nz > SMOOTH_FACETS && sharesVertex(f, g))) {
        tMin = t;
        continue;
      }
      return false;
    }
    return false;
  };
  const against = (f, s) => N[3 * f] * s[0] + N[3 * f + 1] * s[1] + N[3 * f + 2] * s[2] < -sinDraft;

  // Draws of each region, scaled down together to the budget.
  let draws = regions.map((R) => Math.min(DRAWS_MAX, Math.max(DRAWS_MIN, DRAWS_PER_TRIANGLE * R.tris.length)));
  const planned = draws.reduce((a, n) => a + n, 0) * pool.length;
  const scaled = planned > O.rayBudget;
  if (scaled) draws = draws.map((n) => Math.max(DRAWS_MIN, Math.floor((n * O.rayBudget) / planned)));
  let splitLeft = O.splitRayBudget;
  let splitSampled = 0;
  let splitRays = 0;
  const local = new Int32Array(nt).fill(-1); // index of a triangle in the region being split
  const zones = [];
  const pt = new Float64Array(3);
  const points = Array.from({ length: TRIANGLE_POINTS }, () => new Float64Array(3));

  regions.forEach((R, rank) => {
    const nTri = R.tris.length;
    const regionAreas = Float64Array.from(R.tris, (f) => areas[f]);
    // Ranked on points drawn by area: the k-th draw of a triangle, its point k.
    const picks = sampleByArea(regionAreas, draws[rank], SEED + rank);
    const drawn = new Int32Array(nTri);
    const freed = new Int32Array(pool.length);
    for (const i of picks) {
      const f = R.tris[i];
      pointOf(f, drawn[i]++, pt);
      for (let k = 0; k < pool.length; k++) if (!against(f, pool[k].s) && free(f, pt, pool[k].s)) freed[k]++;
    }
    const drawShare = Array.from(freed, (n) => n / picks.length);
    const base = { tris: R.tris, stats: R, enclosed: R.enclosed, core: null, split: false, partial: null, cover: null };
    if (Math.max(...drawShare) >= O.releaseShare) {
      zones.push({ ...base, releases: drawShare.flatMap((sh, k) => (sh >= KEEP_SHARE ? [[k, sh]] : [])) });
      onProgress?.((rank + 1) / regions.length);
      return;
    }

    // No single direction frees it: each triangle classified along the
    // directions that free some of it (on triangles drawn by area when the
    // budget left is short), then a greedy cover.
    const tested = [];
    drawShare.forEach((sh, k) => sh >= TESTED_SHARE && tested.push(k));
    const nTest = tested.length;
    const reason = () => (R.enclosed ? "enclosed" : nTest ? "partial" : "no_direction");
    if (!nTest) {
      zones.push({ ...base, core: reason(), releases: [] });
      onProgress?.((rank + 1) / regions.length);
      return;
    }
    let list;
    if (nTri * nTest * TRIANGLE_POINTS <= splitLeft) {
      list = Int32Array.from({ length: nTri }, (_, i) => i);
      splitLeft -= nTri * nTest * TRIANGLE_POINTS;
    } else {
      const seen = new Uint8Array(nTri);
      for (const i of sampleByArea(regionAreas, SPLIT_DRAWS, SEED + 1000 + rank)) seen[i] = 1;
      const distinct = [];
      for (let i = 0; i < nTri; i++) if (seen[i]) distinct.push(i);
      list = Int32Array.from(distinct);
      splitLeft = Math.max(0, splitLeft - list.length * nTest * TRIANGLE_POINTS);
      splitSampled++;
    }
    const triFree = new Uint8Array(nTri * nTest);
    const classified = new Uint8Array(nTri);
    let classifiedArea = 0;
    const cast0 = rays;
    for (const i of list) {
      const f = R.tris[i];
      classified[i] = 1;
      classifiedArea += regionAreas[i];
      for (let j = 0; j < TRIANGLE_POINTS; j++) pointOf(f, j, points[j]);
      for (let t = 0; t < nTest; t++) {
        const s = pool[tested[t]].s;
        if (against(f, s)) continue;
        let n = 0;
        for (let j = 0; j < TRIANGLE_POINTS; j++) {
          if (free(f, points[j], s)) n++;
          if (n >= TRIANGLE_FREE || n + TRIANGLE_POINTS - 1 - j < TRIANGLE_FREE) break;
        }
        if (n >= TRIANGLE_FREE) triFree[i * nTest + t] = 1;
      }
    }
    splitRays += rays - cast0;
    // Weights: each classified triangle for its share of the area classified.
    const scale = classifiedArea > 0 ? R.area / classifiedArea : 0;
    const weight = (i) => (classified[i] ? regionAreas[i] * scale : 0);
    const shareAlong = (t, members) => {
      let freedArea = 0, all = 0;
      for (const i of members) {
        if (!classified[i]) continue;
        all += regionAreas[i];
        if (triFree[i * nTest + t]) freedArea += regionAreas[i];
      }
      return all > 0 ? freedArea / all : 0;
    };
    const covered = new Uint8Array(nTri);
    const chosen = []; // indices into tested
    let coveredArea = 0;
    while (chosen.length < COVER_MAX) {
      const gains = new Float64Array(nTest);
      for (const i of list) {
        if (covered[i]) continue;
        const w = weight(i);
        for (let t = 0; t < nTest; t++) if (triFree[i * nTest + t]) gains[t] += w;
      }
      const top = Math.max(...gains);
      if (!(top >= COVER_STEP * R.area)) break;
      const floor = Math.max(top - O.tieShare * R.area, COVER_STEP * R.area);
      let pick = -1;
      for (let t = 0; t < nTest; t++) if (gains[t] >= floor && (pick < 0 || prefer(tested[t], tested[pick]) < 0)) pick = t;
      chosen.push(pick);
      coveredArea += gains[pick];
      for (const i of list) if (triFree[i * nTest + pick]) covered[i] = 1;
      if (coveredArea >= O.releaseShare * R.area) break;
    }
    const cover = R.area > 0 ? coveredArea / R.area : 0;
    const all = Array.from({ length: nTri }, (_, i) => i);
    const releasesOf = (members) => tested.flatMap((k, t) => {
      const sh = shareAlong(t, members);
      return sh >= KEEP_SHARE ? [[k, sh]] : [];
    });
    if (!chosen.length || cover < 1 - O.coreShare) {
      zones.push({ ...base, core: reason(), releases: releasesOf(all) });
      onProgress?.((rank + 1) / regions.length);
      return;
    }

    // Split: each triangle freed to the direction chosen most square to it
    // (then the one that takes it the furthest out of the region, then the
    // first chosen); the others to the first chosen among their neighbours,
    // layer by layer from those; one zone per direction and connected piece.
    const assign = new Int32Array(nTri).fill(-1);
    for (const i of list) {
      const f = R.tris[i];
      let best = -1, k0 = 0, k1 = 0;
      for (let o = 0; o < chosen.length; o++) {
        if (!triFree[i * nTest + chosen[o]]) continue;
        const s = pool[tested[chosen[o]]].s;
        const a0 = Math.round(10 * (N[3 * f] * s[0] + N[3 * f + 1] * s[1] + N[3 * f + 2] * s[2]));
        const a1 = (C[3 * f] - R.g[0]) * s[0] + (C[3 * f + 1] - R.g[1]) * s[1] + (C[3 * f + 2] - R.g[2]) * s[2];
        if (best < 0 || a0 > k0 || (a0 === k0 && a1 > k1)) {
          best = o;
          k0 = a0;
          k1 = a1;
        }
      }
      assign[i] = best;
    }
    for (let i = 0; i < nTri; i++) local[R.tris[i]] = i;
    const neighbours = (i, visit) => {
      const f = R.tris[i];
      for (let c = 0; c < 3; c++) {
        const w = W[3 * f + c];
        for (let p = vStart[w]; p < vStart[w + 1]; p++) {
          const j = local[vItems[p]];
          if (j >= 0 && j !== i) visit(j);
        }
      }
    };
    let frontier = all.filter((i) => assign[i] >= 0);
    const queued = new Uint8Array(nTri);
    while (frontier.length) {
      const layer = [];
      for (const i of frontier) {
        neighbours(i, (j) => {
          if (assign[j] < 0 && !queued[j]) {
            queued[j] = 1;
            layer.push(j);
          }
        });
      }
      const values = layer.map((j) => {
        let m = -1;
        neighbours(j, (k) => {
          if (assign[k] >= 0 && (m < 0 || assign[k] < m)) m = assign[k];
        });
        return m;
      });
      layer.forEach((j, n) => (assign[j] = values[n]));
      frontier = layer;
    }
    const piece = new Int32Array(nTri).fill(-1);
    for (let i0 = 0; i0 < nTri; i0++) {
      if (piece[i0] >= 0) continue;
      const members = [i0];
      piece[i0] = i0;
      for (let h = 0; h < members.length; h++) {
        neighbours(members[h], (j) => {
          if (piece[j] < 0 && assign[j] === assign[i0]) {
            piece[j] = i0;
            members.push(j);
          }
        });
      }
      members.sort((a, b) => a - b); // the order of the region: by centre
      const tris = members.map((i) => R.tris[i]);
      zones.push({
        ...base, tris, stats: tris.length === nTri ? R : statsOf(tris), split: chosen.length > 1, partial: cover < O.releaseShare ? cover : null,
        cover: tested[chosen[assign[i0]]], releases: releasesOf(members),
      });
    }
    for (const f of R.tris) local[f] = -1;
    onProgress?.((rank + 1) / regions.length);
  });

  // The zones in geometric order, numbered from 1.
  for (const z of zones) {
    z.area = z.stats.area;
    z.key = keyOf(z.stats.g);
  }
  zones.sort(geometric);
  const stamp = new Int32Array(nt);
  const out = zones.map((z, index) => {
    for (const f of z.tris) zone[f] = index;
    const { area, g, m } = z.stats;
    // Corners, box, the half of its neighbours, the share a half could form.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let formable = 0, upper = 0, lower = 0, around = 0, neighbourCount = 0;
    for (const f of z.tris) {
      if (flags && flags[f] & (REACH_UP | REACH_DOWN | TRAPPED)) formable += areas[f];
      for (let c = 0; c < 3; c++) {
        const r = 3 * I[3 * f + c];
        for (let k = 0; k < 3; k++) {
          if (P[r + k] < min[k]) min[k] = P[r + k];
          if (P[r + k] > max[k]) max[k] = P[r + k];
        }
        const w = W[3 * f + c];
        for (let p = vStart[w]; p < vStart[w + 1]; p++) {
          const h = vItems[p];
          if (mask[h] || stamp[h] === index + 1) continue;
          stamp[h] = index + 1;
          neighbourCount++;
          around += areas[h];
          if (side?.[h] === SIDE_UPPER) upper += areas[h];
          else if (side?.[h] === SIDE_LOWER) lower += areas[h];
        }
      }
    }
    const half = !neighbourCount ? "inside" : upper > HALF_SHARE * around ? "upper" : lower > HALF_SHARE * around ? "lower" : "across";
    const halfFormable = area > 0 ? formable / area : 0;
    // The releases, the best first; the geometry of those that release it (else of the best).
    const geometry = (k) => {
      const s = pool[k].s;
      const { a, b } = slideBasis(s, d);
      let s0 = Infinity, s1 = -Infinity, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, parallel = 0;
      for (const f of z.tris) {
        if (Math.abs(N[3 * f] * s[0] + N[3 * f + 1] * s[1] + N[3 * f + 2] * s[2]) < sinDraft) parallel += areas[f];
        for (let c = 0; c < 3; c++) {
          const r = 3 * I[3 * f + c];
          const x = P[r], y = P[r + 1], zz = P[r + 2];
          const ps = x * s[0] + y * s[1] + zz * s[2], pa = x * a[0] + y * a[1] + zz * a[2], pb = x * b[0] + y * b[1] + zz * b[2];
          if (ps < s0) s0 = ps;
          if (ps > s1) s1 = ps;
          if (pa < a0) a0 = pa;
          if (pa > a1) a1 = pa;
          if (pb < b0) b0 = pb;
          if (pb > b1) b1 = pb;
        }
      }
      const cs = dot(centre, s), ca = dot(centre, a), cb = dot(centre, b);
      const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
      return {
        depth_mm: round(s1 - s0, 2),
        lo_mm: round(s0 + cs, 2),
        hi_mm: round(s1 + cs, 2),
        box_mm: [round(a0 + ca, 2), round(a1 + ca, 2), round(b0 + cb, 2), round(b1 + cb, 2)],
        exit_mm: [0, 1, 2].map((k) => round(centre[k] + s1 * s[k] + ma * a[k] + mb * b[k], 2)),
        parallel_share: area > 0 ? round(parallel / area, 3) : 0,
      };
    };
    const releases = z.releases.map(([k, sh]) => ({ dir: k, share: round(sh, 3) }));
    for (const r of releases) if (r.share >= O.releaseShare) Object.assign(r, geometry(r.dir));
    releases.sort(releaseOrder);
    if (releases.length && releases[0].share < O.releaseShare) Object.assign(releases[0], geometry(releases[0].dir));
    // Its kind.
    const released = releases.filter((r) => r.share >= O.releaseShare);
    let kind = "slide";
    let reason = null;
    if (z.core) [kind, reason] = ["core", z.core];
    else if (released.length && Math.min(...released.map((r) => r.depth_mm)) < O.shallowDepthMm && area < O.shallowAreaShare * totalArea) [kind, reason] = ["ignored", "shallow"];
    else if (halfFormable >= HALF_FORMABLE && !released.some((r) => pool[r.dir].tilt < FLAT_DEG && r.parallel_share < PARALLEL_SHARE)) [kind, reason] = ["parting", "half_formable"];
    else if (!released.length && z.cover == null) [kind, reason] = ["core", "no_direction"];
    const centroid = g.map((x, k) => round(x + centre[k], 2));
    return {
      id: index + 1,
      anchor: `${centroid.map((x) => x.toFixed(2)).join(",")}|${round(area, 1).toFixed(1)}`,
      centroid_mm: centroid,
      area_mm2: round(area, 2),
      triangles: z.tris.length,
      bbox_mm: { min: min.map((x, k) => round(x + centre[k], 2)), max: max.map((x, k) => round(x + centre[k], 2)) },
      mean_normal: round6(m),
      kind,
      reason,
      half,
      half_formable_share: round(halfFormable, 3),
      split: z.split,
      partial_share: z.partial == null ? null : round(z.partial, 3),
      cover_dir: z.cover,
      releases,
    };
  });
  // Anchors unique: a second zone at the same place and of the same area gets "#2"….
  const anchors = new Map();
  for (const z of out) {
    const n = (anchors.get(z.anchor) ?? 0) + 1;
    anchors.set(z.anchor, n);
    if (n > 1) z.anchor += `#${n}`;
  }

  return result({
    status: notAnalysed.zones ? "capped" : "ok",
    directions: pool.map((e, id) => ({ id, direction: round6(e.s), ...directionParts(e.s, d, u, v), source: e.source, die_axis: e.die, frame: e.frame })),
    zones: out,
    noise: { zones: noise.zones, area_mm2: round(noise.area, 2) },
    not_analysed: { zones: notAnalysed.zones, area_mm2: round(notAnalysed.area, 2) },
    sampled: { scaled, split_sampled: splitSampled },
    stats: { rays, split_rays: splitRays, regions: regionCount, directions: pool.length },
  });
}

// ------------------------------------------------------------------ slides of an analysis (pure)

const REFERENCE_ORDER = { "+X": 0, "-X": 1, "+Y": 2, "-Y": 3, "+Z": 4, "-Z": 5 };
const infos = new WeakMap();

/** What the grouping needs of an analysis, computed once per analysis object. */
function infoOf(analysis) {
  let info = infos.get(analysis);
  if (info) return info;
  const d = analysis.direction;
  const O = { ...SLIDE_DEFAULTS, ...analysis.thresholds };
  const dirs = analysis.directions.map((e) => ({ s: e.direction, die: e.die_axis, frame: e.frame, tilt: tiltOf(e.direction, d), parts: e }));
  const releases = new Map(analysis.zones.map((z) => [z.id, new Map(z.releases.map((r) => [r.dir, r]))]));
  const prefer = (i, j) => {
    const a = dirs[i], b = dirs[j];
    if (!a.die !== !b.die) return a.die ? -1 : 1;
    if (!a.frame !== !b.frame) return a.frame ? -1 : 1;
    return (Math.abs(a.tilt - b.tilt) > 1e-6 ? a.tilt - b.tilt : 0) || i - j;
  };
  info = {
    d, u: analysis.die_axes.u, v: analysis.die_axes.v, O, dirs, prefer,
    zones: analysis.zones,
    byId: new Map(analysis.zones.map((z) => [z.id, z])),
    release: (z, k) => (k == null ? null : releases.get(z.id)?.get(k) ?? null),
    share: (z, k) => (k == null ? 0 : releases.get(z.id)?.get(k)?.share ?? 0),
  };
  infos.set(analysis, info);
  return info;
}

/** The direction of the pool within sameDirDeg of vector s (the nearest), else null. */
function poolIdOf(info, s) {
  const n = normalize(s ?? []);
  if (!n) return null;
  let best = null;
  let top = Math.cos(info.O.sameDirDeg * DEG);
  info.dirs.forEach((e, k) => {
    const c = dot(e.s, n) / Math.hypot(e.s[0], e.s[1], e.s[2]);
    if (c >= top) {
      top = c;
      best = k;
    }
  });
  return best;
}

const byArea = (a, b) => (Math.abs(b.area_mm2 - a.area_mm2) > AREA_TIE ? b.area_mm2 - a.area_mm2 : 0) || a.id - b.id;
const sumAreas = (zones) => zones.reduce((s, z) => s + z.area_mm2, 0);

/**
 * Zones grouped into slides: while one is released (releaseShare) along a
 * direction of the pool, the direction releasing the most of them (then the
 * larger area, an axis of the die, of the frame, the smaller tilt, the first)
 * takes them all; each left (split between directions, partly released)
 * joins a slide on its best release, else gets one of its own on it.
 */
function groupZones(info, zones) {
  const rs = info.O.releaseShare;
  const open = [...zones].sort(byArea);
  const left = new Set(open);
  const groups = [];
  for (;;) {
    let best = null;
    for (let k = 0; k < info.dirs.length; k++) {
      const members = open.filter((z) => left.has(z) && info.share(z, k) >= rs);
      if (!members.length) continue;
      const area = sumAreas(members);
      if (!best || members.length > best.members.length || (members.length === best.members.length && (area > best.area + AREA_TIE || (Math.abs(area - best.area) <= AREA_TIE && info.prefer(k, best.dir) < 0)))) {
        best = { dir: k, members, area };
      }
    }
    if (!best) break;
    for (const z of best.members) left.delete(z);
    groups.push({ dir: best.dir, members: best.members });
  }
  for (const z of open) {
    if (!left.has(z)) continue;
    const k = z.releases[0]?.dir ?? z.cover_dir ?? 0;
    const g = groups.find((x) => x.dir === k);
    if (g) g.members.push(z);
    else groups.push({ dir: k, members: [z] });
  }
  return groups;
}

/** The extent of a zone along s (pool direction k, or null): its release's, else from its box (exact along an axis of the frame). */
function extentAlong(info, z, k, s) {
  const r = info.release(z, k);
  if (r?.depth_mm != null) return r;
  const { a, b } = slideBasis(s, info.d);
  const range = (w) => {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = [0, 1, 2].reduce((sum, i) => sum + ((c >> i) & 1 ? z.bbox_mm.max[i] : z.bbox_mm.min[i]) * w[i], 0);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return [lo, hi];
  };
  const [s0, s1] = range(s), [a0, a1] = range(a), [b0, b1] = range(b);
  const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
  return {
    depth_mm: round(s1 - s0, 2), lo_mm: round(s0, 2), hi_mm: round(s1, 2), box_mm: [a0, a1, b0, b1].map((x) => round(x, 2)),
    exit_mm: [0, 1, 2].map((i) => round(s1 * s[i] + ma * a[i] + mb * b[i], 2)),
  };
}

/** A slide of the view, from its direction (pool index, or null and its vector s) and its zones. */
function slideDetail(info, { key, dir, s, members, forced }) {
  const { O } = info;
  const ext = members.map((z) => extentAlong(info, z, dir, s));
  const depth = Math.max(...ext.map((e) => e.depth_mm));
  const stroke = round(depth + O.clearanceMm, 2);
  const size = [
    round(Math.max(...ext.map((e) => e.box_mm[1])) - Math.min(...ext.map((e) => e.box_mm[0])), 2),
    round(Math.max(...ext.map((e) => e.box_mm[3])) - Math.min(...ext.map((e) => e.box_mm[2])), 2),
  ];
  const largest = members.reduce((m, z, i) => (byArea(z, members[m]) < 0 ? i : m), 0);
  const halves = new Set(members.map((z) => z.half));
  const choices = info.dirs.map((_, k) => k).filter((k) => members.every((z) => info.share(z, k) >= O.releaseShare)).sort(info.prefer);
  const least = Math.min(...members.map((z) => info.share(z, dir)));
  const parts = dir != null ? info.dirs[dir].parts : directionParts(s, info.d, info.u, info.v);
  return {
    key,
    id: null,
    dir,
    direction: round6(s),
    axis: parts.axis,
    reference_axis: parts.reference_axis,
    angle_deg: parts.angle_deg,
    tilt_deg: parts.tilt_deg,
    tilt_up: parts.tilt_up,
    zones: members.map((z) => z.id).sort((a, b) => a - b),
    area_mm2: round(sumAreas(members), 2),
    depth_mm: depth,
    stroke_mm: stroke,
    size_mm: size,
    half: halves.size === 1 ? [...halves][0] : "across",
    exit_mm: ext[largest].exit_mm,
    tags: {
      inclined: tiltOf(s, info.d) >= FLAT_DEG,
      small: size[0] < O.smallMm && size[1] < O.smallMm,
      long_stroke: stroke > O.longStrokeMm,
      also_by_half: members.some((z) => z.half_formable_share >= ALSO_BY_HALF),
      partial: !forced && least < O.releaseShare ? least : null,
      forced: forced && least < O.releaseShare ? least : null,
    },
    choices,
  };
}

/** Slides in the order of their names: the larger, then +X, -X, +Y, -Y, +Z, -Z, the other directions of the pool, then by their first zone. */
function displayOrder(info) {
  const rank = (sl) => (sl.dir == null ? 1e9 : REFERENCE_ORDER[info.dirs[sl.dir].frame] ?? 6 + sl.dir);
  return (a, b) => (Math.abs(b.area_mm2 - a.area_mm2) > AREA_TIE ? b.area_mm2 - a.area_mm2 : 0) || rank(a) - rank(b) || a.zones[0] - b.zones[0];
}

/** Keys of the slides of a state in order: "p1", "p2"…, then "u1"…. */
function keyOrder(a, b) {
  const x = /^([a-z]*)(\d*)$/.exec(a), y = /^([a-z]*)(\d*)$/.exec(b);
  if (!x || !y || x[1] !== y[1]) return a < b ? -1 : a > b ? 1 : 0;
  return Number(x[2]) - Number(y[2]);
}

/** The view of an analysis and a state (see effectiveSlides), and the next number of a slide created ("u<next>"). */
function buildView(analysis, state, messages = []) {
  const info = infoOf(analysis);
  const rs = info.O.releaseShare;
  const kindOf = new Map();
  const groups = [];
  let next = 1;
  if (!state) {
    for (const z of info.zones) kindOf.set(z.id, z.kind);
    for (const g of groupZones(info, info.zones.filter((z) => z.kind === "slide"))) groups.push({ key: null, dir: g.dir, s: info.dirs[g.dir].s, members: g.members, forced: false });
  } else {
    const keys = Object.keys(state.slides ?? {}).sort(keyOrder);
    next = Math.max(Number.isInteger(state.next) ? state.next : 1, 1 + Math.max(0, ...keys.map((k) => (/^u\d+$/.test(k) ? Number(k.slice(1)) : 0))));
    const bySlide = new Map();
    for (const key of keys) {
      const saved = state.slides[key];
      const dir = poolIdOf(info, saved?.dir);
      const s = dir != null ? info.dirs[dir].s : normalize(saved?.dir ?? []);
      if (s) bySlide.set(key, { key, dir, s, members: [], forced: saved.forced != null });
    }
    const absent = [];
    for (const z of info.zones) {
      const e = state.zones?.[z.anchor];
      if (e && e.kind !== "slide" && ZONE_KINDS.includes(e.kind)) {
        kindOf.set(z.id, e.kind);
        continue;
      }
      const slide = e?.kind === "slide" ? bySlide.get(e.slide) : null;
      if (slide) {
        kindOf.set(z.id, "slide");
        slide.members.push(z);
        continue;
      }
      // Not in the state: as proposed; a slide joins the first slide of the state that releases it, else a new one.
      kindOf.set(z.id, z.kind);
      if (z.kind === "slide") absent.push(z);
    }
    const rest = [];
    for (const z of absent.sort(byArea)) {
      const slide = [...bySlide.values()].find((sl) => sl.dir != null && info.share(z, sl.dir) >= rs);
      if (slide) slide.members.push(z);
      else rest.push(z);
    }
    for (const sl of bySlide.values()) if (sl.members.length) groups.push(sl);
    for (const g of groupZones(info, rest)) groups.push({ key: `u${next++}`, dir: g.dir, s: info.dirs[g.dir].s, members: g.members, forced: false });
  }
  const slides = groups.map((g) => slideDetail(info, g)).sort(displayOrder(info));
  const slideOf = new Map();
  slides.forEach((sl, i) => {
    sl.id = `T${i + 1}`;
    sl.key ??= `p${i + 1}`;
    for (const id of sl.zones) slideOf.set(id, sl);
  });
  const zoneKind = new Map(info.zones.map((z) => [z.id, { kind: kindOf.get(z.id), slide: slideOf.get(z.id)?.id ?? null, key: slideOf.get(z.id)?.key ?? null }]));
  const ofKind = (kind) => info.zones.filter((z) => kindOf.get(z.id) === kind).sort(byArea);
  const cores = ofKind("core").map((z, i) => ({ id: `N${i + 1}`, zone: z.id, area_mm2: z.area_mm2, centroid_mm: z.centroid_mm, reason: z.kind === "core" ? z.reason : null }));
  const parting = ofKind("parting").map((z) => ({ zone: z.id, area_mm2: z.area_mm2, centroid_mm: z.centroid_mm }));
  const ignoredZones = ofKind("ignored");
  const ignored = { zones: ignoredZones.map((z) => z.id).sort((a, b) => a - b), area_mm2: round(sumAreas(ignoredZones), 2) };
  return {
    view: {
      origin: state ? "manual" : "proposed",
      slides,
      cores,
      parting,
      ignored,
      counts: { slides: slides.length, cores: cores.length, parting: parting.length, ignored: ignored.zones.length },
      zoneKind,
      messages: [...messages],
    },
    next,
  };
}

/**
 * The slides of an analysis: proposed (state null), or as edited by hand
 * (a state of editSlides, or matched by matchSlideState; the zones it does
 * not have keep their proposed kind, a slide among them joins the first
 * slide of the state that releases it, else a new one). Never stored:
 * {origin ("proposed" | "manual"), slides [{key, id ("T1"…), dir (index in
 * analysis.directions, null for a direction forced off the pool), direction,
 * axis, reference_axis, angle_deg, tilt_deg, tilt_up, zones (ids), area_mm2,
 * depth_mm, stroke_mm, size_mm [width, height], half, exit_mm, tags,
 * choices (the directions releasing every zone of it)}], cores [{id ("N1"…),
 * zone, area_mm2, centroid_mm, reason}], parting [{zone, area_mm2,
 * centroid_mm}], ignored {zones, area_mm2}, counts, zoneKind (Map zone id ->
 * {kind, slide ("T1" | null), key}), messages (of matchSlideState)}.
 */
export function effectiveSlides(analysis, state = null, { messages = [] } = {}) {
  return buildView(analysis, state, messages).view;
}

/** The complete state of a view: every zone with its kind and slide key, every slide with its direction. */
function materialise(analysis, state) {
  const { view, next } = buildView(analysis, state);
  const st = { v: 1, zones: {}, slides: {}, next };
  for (const sl of view.slides) st.slides[sl.key] = sl.tags.forced != null ? { dir: sl.direction, forced: round(sl.tags.forced, 3) } : { dir: sl.direction };
  for (const z of analysis.zones) {
    const k = view.zoneKind.get(z.id);
    st.zones[z.anchor] = { kind: k.kind, slide: k.kind === "slide" ? k.key : null };
  }
  return st;
}

/**
 * An edit by hand of the slides (pure): returns {state, message?} or {error,
 * ...}. A null state (the proposal) is first made complete: every zone with
 * its kind and slide, the slides proposed keyed "p1", "p2"… in their order.
 *
 * op -- {op: "merge", a, b} (slide keys): one slide on a direction releasing
 *         all their zones (a's, else b's, else the best); error
 *         "no_common_direction" without one;
 *       {op: "move", zone (id), to (slide key)}: into a slide whose direction
 *         releases it (else on one releasing them all, message
 *         "direction_changed"; else error "not_released");
 *       {op: "move", zone, to: "new"}: a slide of its own on its best release
 *         (forced on it when that is under releaseShare; without any, on its
 *         mean normal in the parting plane, else on +u);
 *       {op: "direction", slide, dir}: one of the slide's choices, else error
 *         "not_released";
 *       {op: "kind", zone, kind}: core, parting, ignored (out of its slide);
 *         slide (back to its proposed slide when that is there and releases
 *         it, else as "new");
 *       {op: "reset"}: the proposal (state null).
 * Slides left without zones are dropped.
 */
export function editSlides(analysis, state, op) {
  if (op?.op === "reset") return { state: null };
  const info = infoOf(analysis);
  const rs = info.O.releaseShare;
  const st = materialise(analysis, state);
  const zoneOf = (id) => info.byId.get(Number(id)) ?? null;
  const membersOf = (key) => info.zones.filter((z) => st.zones[z.anchor]?.kind === "slide" && st.zones[z.anchor].slide === key);
  const dirOf = (key) => poolIdOf(info, st.slides[key].dir);
  const common = (zones) => info.dirs.map((_, k) => k).filter((k) => zones.every((z) => info.share(z, k) >= rs)).sort(info.prefer);
  const done = (extra = {}) => {
    const used = new Set(Object.values(st.zones).map((e) => e.slide));
    for (const key of Object.keys(st.slides)) if (!used.has(key)) delete st.slides[key];
    return { state: st, ...extra };
  };
  const newSlide = (z) => {
    const best = z.releases[0];
    let dir;
    let forced = null;
    if (best) {
      dir = info.dirs[best.dir].s;
      if (best.share < rs) forced = best.share;
    } else {
      const p = flatten(z.mean_normal, info.d);
      dir = Math.hypot(p[0], p[1], p[2]) >= MEAN_NORMAL_MIN ? snapDirection(p) : info.u;
      forced = 0;
    }
    const key = `u${st.next++}`;
    st.slides[key] = forced == null ? { dir: round6(dir) } : { dir: round6(dir), forced: round(forced, 3) };
    st.zones[z.anchor] = { kind: "slide", slide: key };
    return done();
  };
  switch (op?.op) {
    case "merge": {
      const { a, b } = op;
      if (!st.slides[a] || !st.slides[b] || a === b) return { error: "invalid" };
      const both = [...membersOf(a), ...membersOf(b)];
      const ks = common(both);
      if (!ks.length) return { error: "no_common_direction" };
      const da = dirOf(a), db = dirOf(b);
      const k = ks.includes(da) ? da : ks.includes(db) ? db : ks[0];
      st.slides[a] = { dir: round6(info.dirs[k].s) };
      for (const z of both) st.zones[z.anchor] = { kind: "slide", slide: a };
      return done();
    }
    case "move": {
      const z = zoneOf(op.zone);
      if (!z) return { error: "invalid" };
      if (op.to === "new") return newSlide(z);
      const key = op.to;
      if (!st.slides[key]) return { error: "invalid" };
      const was = st.zones[z.anchor];
      if (was.kind === "slide" && was.slide === key) return done();
      const k = dirOf(key);
      if (k != null && info.share(z, k) >= rs) {
        st.zones[z.anchor] = { kind: "slide", slide: key };
        return done();
      }
      const ks = common([...membersOf(key), z]);
      if (!ks.length) return { error: "not_released", share: info.share(z, k), slide: key };
      st.slides[key] = { dir: round6(info.dirs[ks[0]].s) };
      st.zones[z.anchor] = { kind: "slide", slide: key };
      return done({ message: "direction_changed", slide: key, dir: ks[0] });
    }
    case "direction": {
      const key = op.slide;
      if (!st.slides[key]) return { error: "invalid" };
      const k = Number(op.dir);
      if (!common(membersOf(key)).includes(k)) return { error: "not_released" };
      st.slides[key] = { dir: round6(info.dirs[k].s) };
      return done();
    }
    case "kind": {
      const z = zoneOf(op.zone);
      if (!z || !ZONE_KINDS.includes(op.kind)) return { error: "invalid" };
      if (op.kind !== "slide") {
        st.zones[z.anchor] = { kind: op.kind, slide: null };
        return done();
      }
      if (st.zones[z.anchor].kind === "slide") return done();
      // Back to its proposed slide, when it is still there and releases it.
      const index = buildView(analysis, null).view.slides.findIndex((sl) => sl.zones.includes(z.id));
      const key = index >= 0 ? `p${index + 1}` : null;
      if (key && st.slides[key] && info.share(z, dirOf(key)) >= rs) {
        st.zones[z.anchor] = { kind: "slide", slide: key };
        return done();
      }
      return newSlide(z);
    }
    default:
      return { error: "invalid" };
  }
}

// ------------------------------------------------------------------ persistence

const isDirection = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && v.some((x) => x !== 0);

/** A state checked and in canonical form (keys sorted, directions to 6 decimals), else null. */
function canonicalState(state) {
  if (!state || typeof state !== "object" || state.v !== 1) return null;
  if (!state.zones || typeof state.zones !== "object" || !state.slides || typeof state.slides !== "object") return null;
  if (!Number.isInteger(state.next) || state.next < 1) return null;
  const out = { v: 1, zones: {}, slides: {}, next: state.next };
  for (const key of Object.keys(state.slides).sort(keyOrder)) {
    const sl = state.slides[key];
    if (!sl || typeof sl !== "object" || !isDirection(sl.dir)) return null;
    if (sl.forced != null && !Number.isFinite(sl.forced)) return null;
    out.slides[key] = sl.forced != null ? { dir: round6(sl.dir), forced: round(sl.forced, 3) } : { dir: round6(sl.dir) };
  }
  for (const anchor of Object.keys(state.zones).sort()) {
    const e = state.zones[anchor];
    if (!e || typeof e !== "object" || !ZONE_KINDS.includes(e.kind)) return null;
    if (e.slide != null && typeof e.slide !== "string") return null;
    out.zones[anchor] = { kind: e.kind, slide: e.kind === "slide" ? e.slide ?? null : null };
  }
  return out;
}

/** A state as it is kept (canonical; null: the proposal chosen). An invalid one gives null, with a warning. */
export function serializeSlideState(state) {
  if (state == null) return null;
  const out = canonicalState(state);
  if (!out) console.warn("Slides: an invalid state of the slides is not kept");
  return out;
}

/** A state kept (JSON text, or its object), checked: null for the proposal, or when invalid (with a warning). */
export function parseSlideState(json) {
  if (json == null) return null;
  let value = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      console.warn("Slides: a state of the slides kept is not JSON");
      return null;
    }
  }
  if (value === null) return null;
  const out = canonicalState(value);
  if (!out) console.warn("Slides: a state of the slides kept is invalid");
  return out;
}

/** 8 hex digits of a state (null: the proposal), changed by every edit: for the signature of what the costing reads. */
export function slideStateHash(state) {
  const h = fnv32();
  h.text(JSON.stringify(state == null ? null : canonicalState(state)));
  return h.hex();
}

/**
 * The entry kept to restore for an analysis, among the entries of its body
 * ({sig, version, direction, savedAt, state}): the one of its signature
 * (exact: its null state, the proposal chosen, keeps any other away), else
 * the most recent edited for the same draw direction (carried over).
 * {entry, exact} or null.
 */
export function pickSlideEntry(entries, analysis) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === "object") : [];
  const same = list.find((e) => e.sig === analysis.sig);
  if (same) return { entry: same, exact: true };
  const carried = list
    .filter((e) => e.state != null && isDirection(e.direction) && sameDirection(e.direction, analysis.direction))
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0];
  return carried ? { entry: carried, exact: false } : null;
}

const ANCHOR = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)(?:#\d+)?$/;

/**
 * A state kept, on the zones of an analysis: {state (null: the proposal),
 * messages}. Same signature and version (exact): the zones by their anchors.
 * Else each anchor kept takes the nearest zone not taken within max(0.5 mm,
 * 1e-3 of the diagonal) and 5 % of the area, and the direction of each slide
 * the direction of the pool within sameDirDeg; the zones not found, or of a
 * slide not found, go back to the proposal (messages: {code: "carried"},
 * {code: "dropped", n}).
 */
export function matchSlideState(analysis, entry, { exact = entry?.sig === analysis.sig } = {}) {
  const none = { state: null, messages: [] };
  if (!entry) return none;
  const saved = parseSlideState(entry.state ?? null);
  if (!saved) return none;
  if (!exact && !(isDirection(entry.direction) && sameDirection(entry.direction, analysis.direction))) return none;
  const info = infoOf(analysis);
  const strict = exact && entry.version === SLIDES_VERSION;
  const pairs = new Map();
  if (strict) {
    const byAnchor = new Map(analysis.zones.map((z) => [z.anchor, z]));
    for (const anchor of Object.keys(saved.zones)) if (byAnchor.has(anchor)) pairs.set(anchor, byAnchor.get(anchor));
  } else {
    const tol = Math.max(0.5, 1e-3 * (analysis.diag_mm ?? 0));
    const taken = new Set();
    for (const anchor of Object.keys(saved.zones)) {
      const m = ANCHOR.exec(anchor);
      if (!m) continue;
      const c = [Number(m[1]), Number(m[2]), Number(m[3])], area = Number(m[4]);
      let best = null;
      let gap = Infinity;
      for (const z of analysis.zones) {
        if (taken.has(z.id)) continue;
        const dist = Math.hypot(z.centroid_mm[0] - c[0], z.centroid_mm[1] - c[1], z.centroid_mm[2] - c[2]);
        if (dist > tol || dist >= gap || Math.abs(z.area_mm2 - area) > 0.05 * Math.max(z.area_mm2, area)) continue;
        best = z;
        gap = dist;
      }
      if (best) {
        taken.add(best.id);
        pairs.set(anchor, best);
      }
    }
  }
  const slides = {};
  for (const [key, sl] of Object.entries(saved.slides)) {
    const k = poolIdOf(info, sl.dir);
    if (k == null && !strict) continue;
    const dir = k != null ? round6(info.dirs[k].s) : sl.dir;
    slides[key] = sl.forced != null ? { dir, forced: sl.forced } : { dir };
  }
  const zones = {};
  let dropped = 0;
  for (const [anchor, e] of Object.entries(saved.zones)) {
    const z = pairs.get(anchor);
    if (!z || (e.kind === "slide" && !slides[e.slide])) {
      dropped++;
      continue;
    }
    zones[z.anchor] = { kind: e.kind, slide: e.kind === "slide" ? e.slide : null };
  }
  const messages = exact ? [] : [{ code: "carried" }];
  if (dropped) messages.push({ code: "dropped", n: dropped });
  return { state: { v: 1, zones, slides, next: saved.next }, messages };
}
