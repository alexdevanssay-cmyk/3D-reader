// Totals and overall envelope of a set of bodies (browser counterpart of
// reader3d/model.py `summarize`).
//
// The oriented envelope follows model.py `_oriented_box` step by step: it is the
// smallest of the axis-aligned box and the boxes with one face flush with a face of the
// convex hull of the vertices. For every distinct hull face direction (the ones carrying
// the largest hull area first, at most MAX_DIRECTIONS), the hull is projected on the
// plane of that face and the minimum-area enclosing rectangle of the projection is found
// with rotating calipers.
//
// The points are the vertices used by the faces, in double precision, welded on the
// 1e-8 grid like trimesh welds the meshes it loads; flat sets keep the axis-aligned box
// (Qhull refuses them).
//
// three's ConvexHull is fast when the hull has few vertices, slow when nearly every point
// is on it (dense smooth surfaces: about 20 s for a million points), and it can miss
// points of tight clusters that Qhull merges. So the box found is always measured again
// on every point, and large point sets whose hull would be that large are searched on
// the hull of a subsample instead (see minVolumeBox).

import { Vector3 } from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

/** Most hull face directions tried (model.py OBB_MAX_DIRECTIONS). */
const MAX_DIRECTIONS = 2000;
/** Point sets up to this size always get their exact hull. */
const EXACT_POINTS = 20000;
/** Larger sets get their exact hull when it is expected to have at most this many vertices. */
const EXACT_HULL_VERTICES = 20000;
/** Size of the subsample whose hull estimates the hull of a large set. */
const SAMPLE_POINTS = 20000;
/** Candidates of a subsample search re-measured exactly on every point. */
const TOP_CANDIDATES = 4;
/** Two hull normals are one direction when |n1 . n2| > 1 - 1e-9, i.e. |n1 -/+ n2|^2 < 2e-9. */
const SAME_DIRECTION = 2e-9;
/** Point sets thinner than this (relative to their size) are flat: Qhull fails on them. */
const FLAT = 1e-13;

/**
 * Totals and envelopes of the analysed bodies.
 *
 * @param {object[]} bodies  bodies of the result contract (bbox, volume, centroid, area,
 *   triangles, mesh.positions/indices)
 * @returns {object} the `summary` object of the result contract
 */
export function summarize(bodies) {
  if (!bodies || !bodies.length) throw new Error('No geometry found in file');

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let k = 0; k < 3; k++) {
      mins[k] = Math.min(mins[k], b.bbox.min[k]);
      maxs[k] = Math.max(maxs[k], b.bbox.max[k]);
    }
  }
  const size = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
  const solids = bodies.filter((b) => b.volume !== null && b.volume !== undefined);
  const volume = solids.length ? solids.reduce((s, b) => s + b.volume, 0) : null;

  // Centre of mass of the bodies that have one (a body of zero volume has none), weighted
  // by their volumes; none when these add up to (numerically) nothing.
  let centroid = null;
  const massive = solids.filter((b) => b.centroid);
  const weight = massive.reduce((s, b) => s + b.volume, 0);
  if (massive.length && Math.abs(weight) > 1e-12 * Math.max(...size) ** 3) {
    const m = [0, 0, 0];
    for (const b of massive) for (let k = 0; k < 3; k++) m[k] += b.centroid[k] * b.volume;
    const c = m.map((x) => x / weight);
    if (c.every(Number.isFinite)) centroid = c;
  }

  const envelopeVolume = size[0] * size[1] * size[2];
  return {
    volume,
    area: bodies.reduce((s, b) => s + b.area, 0),
    centroid,
    bodies: bodies.length,
    solids: solids.length,
    open_bodies: bodies.length - solids.length,
    triangles: bodies.reduce((s, b) => s + triangleCount(b), 0),
    bbox: { min: mins, max: maxs, size, volume: envelopeVolume },
    obb: orientedBox(bodies, size),
    // Share of the axis-aligned envelope actually filled with material.
    fill_ratio: volume && envelopeVolume > 0 ? volume / envelopeVolume : null,
  };
}

function triangleCount(b) {
  if (Number.isInteger(b.triangles)) return b.triangles;
  return b.mesh?.indices ? Math.floor(b.mesh.indices.length / 3) : 0;
}

/**
 * Smallest-volume oriented bounding box of the vertices used by the bodies' faces,
 * compared with the axis-aligned box (model.py `_oriented_box`). Sizes are sorted in
 * decreasing order. The vertices are taken in double precision: `mesh.positions64`
 * when a body has it (meshanalysis.js keeps it whenever the float32 display copy
 * rounded the coordinates), else the display positions.
 */
export function orientedBox(bodies, aabbSize) {
  let best = [...aabbSize].map(Number).sort((a, b) => b - a);
  try {
    const points = uniquePoints(bodies);
    centre(points); // the extents do not depend on the position; the hull is better conditioned
    if (points.length / 3 >= 4) {
      const box = minVolumeBox(points);
      if (box) {
        const extents = [...box.extents].sort((a, b) => b - a);
        if (product(extents) < product(best)) best = extents;
      }
    }
  } catch {
    // keep the axis-aligned box, like the Python engine when the hull fails
  }
  return { size: best, volume: product(best) };
}

const product = (v) => v[0] * v[1] * v[2];

/**
 * The finite vertices used by the bodies' meshes, welded like trimesh welds the
 * vertices of a mesh it loads (and so the Python engine's): one point, the first one,
 * per position rounded to 8 decimals. As a Float64Array (xyz).
 */
function uniquePoints(bodies) {
  const sourceOf = (b) => b.mesh?.positions64 ?? b.mesh?.positions;
  const welder = new Welder(bodies.reduce((s, b) => s + (sourceOf(b) ? sourceOf(b).length / 3 : 0), 0), 1e8);
  for (const b of bodies) {
    const pos = sourceOf(b);
    if (!pos || !pos.length) continue;
    const n = Math.floor(pos.length / 3);
    const used = new Uint8Array(n);
    const idx = b.mesh.indices;
    if (idx) for (let j = 0; j < idx.length; j++) used[idx[j]] = 1;
    else used.fill(1);
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue;
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) welder.add(x, y, z);
    }
  }
  return welder.points();
}

/** The first point of every cell of a grid of step 1 / scale (Float64Array xyz). */
function weld(points, scale) {
  const welder = new Welder(points.length / 3, scale);
  for (let i = 0; i < points.length; i += 3) welder.add(points[i], points[i + 1], points[i + 2]);
  return welder.points();
}

/** numpy `round()`: round half to even. */
function roundHalfEven(v) {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Keeps the first point of every grid cell (coordinates times `scale`, rounded half to
 * even like numpy), in an open-addressing hash table sized for `capacity` points.
 */
class Welder {
  constructor(capacity, scale) {
    this.scale = scale;
    this.mask = nextPow2(2 * capacity) - 1;
    this.table = new Int32Array(this.mask + 1).fill(-1);
    this.keys = new Float64Array(3 * capacity);
    this.out = new Float64Array(3 * capacity);
    this.count = 0;
    const word = new Float64Array(1);
    const words = new Uint32Array(word.buffer);
    // hash of a key: both 32-bit words of its double (-0 and +0 are the same key)
    this.mix = (h, v) => {
      word[0] = v === 0 ? 0 : v;
      h = Math.imul(h ^ words[0], 0x9e3779b1);
      return Math.imul(h ^ words[1], 0x85ebca6b);
    };
  }

  add(x, y, z) {
    const { keys, table, mask, mix } = this;
    const kx = roundHalfEven(x * this.scale), ky = roundHalfEven(y * this.scale), kz = roundHalfEven(z * this.scale);
    let h = mix(mix(mix(0x2545f491, kx), ky), kz);
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
    h = (h ^ (h >>> 13)) & mask;
    for (;;) {
      const s = table[h];
      if (s === -1) {
        const c = this.count++;
        table[h] = c;
        keys[3 * c] = kx;
        keys[3 * c + 1] = ky;
        keys[3 * c + 2] = kz;
        this.out[3 * c] = x;
        this.out[3 * c + 1] = y;
        this.out[3 * c + 2] = z;
        return;
      }
      if (keys[3 * s] === kx && keys[3 * s + 1] === ky && keys[3 * s + 2] === kz) return;
      h = (h + 1) & mask;
    }
  }

  points() {
    return this.out.slice(0, 3 * this.count);
  }
}

/** Translate a point set (xyz, in place) so that its axis-aligned box is centred on the origin. */
function centre(points) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (points[i + k] < lo[k]) lo[k] = points[i + k];
      if (points[i + k] > hi[k]) hi[k] = points[i + k];
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) points[i + k] -= c[k];
}

function nextPow2(n) {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

// --------------------------------------------------------------------------- vectors

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const point = (p, i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];

/**
 * Plane basis of a unit direction n (model.py): u = n x e normalised, with e the
 * coordinate axis the most perpendicular to n (the first one on ties), and v = n x u.
 */
function basis(n) {
  const a = n.map(Math.abs);
  const k = a[0] <= a[1] && a[0] <= a[2] ? 0 : a[1] <= a[2] ? 1 : 2;
  const e = [0, 0, 0];
  e[k] = 1;
  let u = cross(n, e);
  u = scale(u, 1 / Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]));
  return [u, cross(n, u)];
}

/** Extents of the points along three axes (exact measure of a candidate box). */
function extentsAlong(points, axes) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
    for (let k = 0; k < 3; k++) {
      const a = axes[k];
      const t = x * a[0] + y * a[1] + z * a[2];
      if (t < lo[k]) lo[k] = t;
      if (t > hi[k]) hi[k] = t;
    }
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

// --------------------------------------------------------------------------- 2-D

/** Convex hull of 2-D points (Andrew's monotone chain), counter-clockwise, no collinear points. */
function hull2d(xs, ys) {
  const order = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const turn = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lower = [];
  for (const i of order) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let j = order.length - 1; j >= 0; j--) {
    const i = order[j];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle of a convex polygon (counter-clockwise) by rotating
 * calipers: one side of the optimal rectangle is collinear with a polygon edge.
 * Returns {area, width, height, ex, ey}: width along the unit direction (ex, ey) of
 * that side, height across it.
 */
function minAreaRect(px, py) {
  const k = px.length;
  if (k < 3) {
    // Collinear projection: a segment (or a point) has zero area.
    const dx = k === 2 ? px[1] - px[0] : 1, dy = k === 2 ? py[1] - py[0] : 0;
    const len = Math.hypot(dx, dy) || 1;
    return { area: 0, width: k === 2 ? len : 0, height: 0, ex: dx / len, ey: dy / len };
  }
  let best = { area: Infinity, width: 0, height: 0, ex: 1, ey: 0 };
  let right = -1, top = -1, left = -1;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    let ex = px[j] - px[i], ey = py[j] - py[i];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    ex /= len;
    ey /= len;
    const nx = -ey, ny = ex; // inward normal of a counter-clockwise polygon
    const alongE = (m) => px[m] * ex + py[m] * ey;
    const alongN = (m) => px[m] * nx + py[m] * ny;
    if (right < 0) {
      right = top = left = j;
      for (let m = 0; m < k; m++) {
        if (alongE(m) > alongE(right)) right = m;
        if (alongN(m) > alongN(top)) top = m;
        if (alongE(m) < alongE(left)) left = m;
      }
    } else {
      // The extreme points only move forward (counter-clockwise) as the edge turns.
      for (let s = 0; s < k && alongE((right + 1) % k) >= alongE(right); s++) right = (right + 1) % k;
      for (let s = 0; s < k && alongN((top + 1) % k) >= alongN(top); s++) top = (top + 1) % k;
      for (let s = 0; s < k && alongE((left + 1) % k) <= alongE(left); s++) left = (left + 1) % k;
    }
    const width = alongE(right) - alongE(left);
    const height = alongN(top) - alongN(i);
    if (width * height < best.area) best = { area: width * height, width, height, ex, ey };
  }
  return best;
}

// --------------------------------------------------------------------------- 3-D

/**
 * Minimum-volume oriented box of a point set (Float64Array xyz, ideally centred).
 * Returns {axes: [a1, a2, a3] (unit vectors), extents: [e1, e2, e3]}, or null for fewer
 * than 4 points or a flat (coplanar or collinear) set, which keep the axis-aligned box.
 */
export function minVolumeBox(points) {
  const n = points.length / 3;
  if (n < 4) return null;

  // Largest triangle spanned by extreme points: detects collinear and coplanar sets.
  let i0 = 0;
  for (let i = 1; i < n; i++) if (points[3 * i] < points[3 * i0]) i0 = i;
  const p0 = point(points, i0);
  const farthest = (distance) => {
    let best = i0, bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = distance(points[3 * i] - p0[0], points[3 * i + 1] - p0[1], points[3 * i + 2] - p0[2]);
      if (d > bestD) [bestD, best] = [d, i];
    }
    return [best, bestD];
  };
  const [i1, size] = farthest((x, y, z) => Math.hypot(x, y, z));
  if (!(size > 0)) return null;
  const line = scale(sub(point(points, i1), p0), 1 / size);
  const [i2, d2] = farthest((x, y, z) => norm(cross([x, y, z], line)));
  if (d2 <= FLAT * size) return null;
  let normal = cross(line, sub(point(points, i2), p0));
  normal = scale(normal, 1 / norm(normal));
  const [, planeDev] = farthest((x, y, z) => Math.abs(x * normal[0] + y * normal[1] + z * normal[2]));
  if (planeDev <= FLAT * size) return null;

  // The exact hull, unless the set is large and a subsample shows that most of its points
  // are on the hull (a dense smooth surface). Points inside the hull of the extreme
  // points cannot be hull vertices: they are left out first.
  const candidates = n > EXACT_POINTS ? outsideExtremes(points, size) : points;
  const m = candidates.length / 3;
  let sample = null;
  if (m > EXACT_POINTS) {
    sample = hullOf(subsample(candidates, SAMPLE_POINTS));
    const expected = (sample ? sample.vertices.length / 3 : 0) * (m / (sample?.from ?? m));
    if (sample && expected <= EXACT_HULL_VERTICES) sample = null;
  }
  if (!sample) {
    // three's QuickHull can miss points of tight clusters (triangle soups with sub-1e-8
    // noise, which Qhull merges): the box is measured again on every point, and when it
    // does not hold them the search runs again on points snapped to a coarser grid.
    let measured = null;
    for (const grid of [0, 1e-10, 1e-9]) {
      const hull = hullOf(grid ? weld(candidates, 1 / (grid * size)) : candidates);
      if (!hull) return measured;
      let best = null;
      for (const d of hullDirections(hull.normals, hull.areas, MAX_DIRECTIONS)) {
        const c = silhouetteBox(hull, d);
        if (c && (!best || c.volume < best.volume)) best = c;
      }
      if (!best) return measured;
      measured = { axes: best.axes, extents: extentsAlong(points, best.axes) };
      const tolerance = Math.max(1e-9, 4 * grid) * size;
      if (measured.extents.every((e, k) => e <= best.extents[k] + tolerance)) return measured;
    }
    return measured;
  }

  // Search on the hull of the subsample, then measure the best candidates on every point
  // (the box encloses them all).
  const boxes = [];
  for (const d of hullDirections(sample.normals, sample.areas, MAX_DIRECTIONS)) {
    const c = silhouetteBox(sample, d);
    if (!c) continue;
    boxes.push(c);
    boxes.sort((a, b) => a.volume - b.volume);
    if (boxes.length > TOP_CANDIDATES) boxes.pop();
  }
  let best = null;
  for (const c of boxes) {
    const extents = extentsAlong(points, c.axes);
    const volume = product(extents);
    if (!best || volume < best.volume) best = { axes: c.axes, extents, volume };
  }
  return best && { axes: best.axes, extents: best.extents };
}

/** Indices of the extreme points along the axes and the diagonals (26 directions). */
function extremePoints(points) {
  const n = points.length / 3;
  const keep = new Set();
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (!(x || y || z)) continue;
        let best = 0, bestVal = -Infinity;
        for (let i = 0; i < n; i++) {
          const t = x * points[3 * i] + y * points[3 * i + 1] + z * points[3 * i + 2];
          if (t > bestVal) [bestVal, best] = [t, i];
        }
        keep.add(best);
      }
    }
  }
  return keep;
}

/** The points of the given indices, as a Float64Array (xyz). */
function pick(points, indices) {
  const out = new Float64Array(3 * indices.size);
  let o = 0;
  for (const i of indices) {
    out[o++] = points[3 * i];
    out[o++] = points[3 * i + 1];
    out[o++] = points[3 * i + 2];
  }
  return out;
}

/** Every k-th point plus the extreme points along the axes and the diagonals. */
function subsample(points, target) {
  const n = points.length / 3;
  const step = Math.ceil(n / target);
  const keep = new Set();
  for (let i = 0; i < n; i += step) keep.add(i);
  for (const i of extremePoints(points)) keep.add(i);
  return pick(points, keep);
}

/**
 * The extreme points along the axes and the diagonals, and the points outside their
 * hull (Akl-Toussaint): that hull lies inside the hull of all the points, so a point
 * inside it (or within 1e-12 of the set size) is not a vertex of the hull.
 */
function outsideExtremes(points, size) {
  const extremes = extremePoints(points);
  const inner = hullOf(pick(points, extremes));
  if (!inner) return points;
  const nf = inner.normals.length / 3;
  const planes = new Float64Array(4 * nf);
  for (let f = 0; f < nf; f++) {
    const c = inner.vertices.subarray(3 * inner.faceVerts[f], 3 * inner.faceVerts[f] + 3);
    for (let k = 0; k < 3; k++) planes[4 * f + k] = inner.normals[3 * f + k];
    planes[4 * f + 3] = c[0] * planes[4 * f] + c[1] * planes[4 * f + 1] + c[2] * planes[4 * f + 2] + 1e-12 * size;
  }
  const outside = (x, y, z) => {
    for (let f = 0; f < nf; f++) if (x * planes[4 * f] + y * planes[4 * f + 1] + z * planes[4 * f + 2] > planes[4 * f + 3]) return true;
    return false;
  };
  // a hull that does not hold its own points (QuickHull on nearly coincident ones) filters nothing
  for (const i of extremes) if (outside(points[3 * i], points[3 * i + 1], points[3 * i + 2])) return points;
  const n = points.length / 3;
  const keep = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (outside(points[3 * i], points[3 * i + 1], points[3 * i + 2])) {
      keep[i] = 1;
      count++;
    }
  }
  for (const i of extremes) if (!keep[i]) (keep[i] = 1), count++;
  const out = new Float64Array(3 * count);
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[o++] = points[3 * i];
    out[o++] = points[3 * i + 1];
    out[o++] = points[3 * i + 2];
  }
  return out;
}

/**
 * Convex hull (three.js QuickHull on double-precision vectors) as flat arrays: hull
 * vertices, outward unit face normals, face areas and the edges with their two faces.
 * `from` is the number of points it was computed from.
 */
function hullOf(points) {
  const n = points.length / 3;
  const vectors = new Array(n);
  for (let i = 0; i < n; i++) vectors[i] = new Vector3(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
  const hull = new ConvexHull().setFromPoints(vectors);
  const faces = hull.faces;
  if (faces.length < 4) return null;

  const faceId = new Map(faces.map((f, i) => [f, i]));
  const vertexId = new Map();
  const verts = [];
  const id = (node) => {
    let k = vertexId.get(node);
    if (k === undefined) {
      k = verts.length / 3;
      vertexId.set(node, k);
      verts.push(node.point.x, node.point.y, node.point.z);
    }
    return k;
  };
  const normals = new Float64Array(3 * faces.length);
  const areas = new Float64Array(faces.length);
  const faceVerts = new Int32Array(faces.length); // one vertex of every face
  const edgeFaces = [];
  const edgeVerts = [];
  faces.forEach((face, fi) => {
    normals[3 * fi] = face.normal.x;
    normals[3 * fi + 1] = face.normal.y;
    normals[3 * fi + 2] = face.normal.z;
    areas[fi] = face.area;
    faceVerts[fi] = id(face.edge.head());
    let e = face.edge;
    do {
      const other = e.twin ? faceId.get(e.twin.face) : undefined;
      const a = id(e.tail()), b = id(e.head());
      if (other !== undefined && fi < other) {
        edgeFaces.push(fi, other);
        edgeVerts.push(a, b);
      }
      e = e.next;
    } while (e !== face.edge);
  });
  return {
    from: n,
    vertices: Float64Array.from(verts),
    normals,
    areas,
    faceVerts,
    edgeFaces: Int32Array.from(edgeFaces),
    edgeVerts: Int32Array.from(edgeVerts),
  };
}

/**
 * model.py `_hull_directions`: the distinct directions of the hull face normals, by
 * decreasing hull area, at most `maxCount`. Two normals are the same direction when
 * |n1 . n2| > 1 - 1e-9 (opposite ones too), grouped transitively; a direction is
 * represented by the normal of its largest face (the first one on ties).
 */
function hullDirections(normals, areas, maxCount) {
  const nf = areas.length;
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const root = (f) => {
    while (parent[f] !== f) {
      parent[f] = parent[parent[f]];
      f = parent[f];
    }
    return f;
  };
  // Grid of cells twice as wide as the grouping radius: the normals within that radius
  // of n (or of -n) lie in the 2 x 2 x 2 cells nearest to it.
  const step = 2 * Math.sqrt(SAME_DIRECTION);
  const reach = Math.ceil(1.5 / step);
  const width = 2 * reach + 1;
  const cellKey = (i, j, k) => ((i + reach) * width + j + reach) * width + k + reach;
  const grid = new Map();
  for (let f = 0; f < nf; f++) {
    const key = cellKey(Math.floor(normals[3 * f] / step), Math.floor(normals[3 * f + 1] / step), Math.floor(normals[3 * f + 2] / step));
    const list = grid.get(key);
    if (list) list.push(f);
    else grid.set(key, [f]);
  }
  const near = new Float64Array(6); // the two nearest cells along each axis
  for (let f = 0; f < nf; f++) {
    for (let s = 1; s >= -1; s -= 2) {
      const x = s * normals[3 * f], y = s * normals[3 * f + 1], z = s * normals[3 * f + 2];
      for (let k = 0; k < 3; k++) {
        const c = (k === 0 ? x : k === 1 ? y : z) / step;
        const i = Math.floor(c);
        near[2 * k] = i;
        near[2 * k + 1] = c - i < 0.5 ? i - 1 : i + 1;
      }
      for (let q = 0; q < 8; q++) {
        const list = grid.get(cellKey(near[q & 1], near[2 + ((q >> 1) & 1)], near[4 + (q >> 2)]));
        if (!list) continue;
        for (const g of list) {
          if (g === f) continue;
          const dx = x - normals[3 * g], dy = y - normals[3 * g + 1], dz = z - normals[3 * g + 2];
          if (dx * dx + dy * dy + dz * dz > SAME_DIRECTION) continue;
          const a = root(f), b = root(g);
          if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
        }
      }
    }
  }
  // Total area and representative (largest face, first on ties) of every group.
  const groups = new Map();
  for (let f = 0; f < nf; f++) {
    const r = root(f);
    const g = groups.get(r);
    if (!g) groups.set(r, { total: areas[f], rep: f });
    else {
      g.total += areas[f];
      if (areas[f] > areas[g.rep]) g.rep = f;
    }
  }
  return [...groups.values()]
    .filter((g) => norm(point(normals, g.rep)) > 0.5) // no normal: degenerate face
    .sort((a, b) => b.total - a.total || a.rep - b.rep)
    .slice(0, maxCount)
    .map((g) => point(normals, g.rep)); // unit normals, like Qhull's
}

/** Above this many edges, a hull gets the faster silhouette and height searches below. */
const LARGE_HULL_EDGES = 20000;

/**
 * Best box with one axis along `d` for the hull: the outline of the projected hull is
 * the projection of its silhouette edges (between a face turned towards d, n . d >
 * -1e-10, and a face turned away), whose 2-D hull gets the minimum-area rectangle; the
 * height is the extent of the hull vertices along d.
 */
function silhouetteBox(hull, d) {
  const { vertices, normals, edgeFaces, edgeVerts } = hull;
  const nv = vertices.length / 3;
  const large = edgeFaces.length / 2 > LARGE_HULL_EDGES;
  const buf = (hull.buffers ??= {
    stamp: new Uint32Array(nv),
    epoch: 0,
    outline: new Int32Array(nv),
    xs: new Float64Array(nv),
    ys: new Float64Array(nv),
    accel: large ? hullAccelerator(hull) : null,
  });
  const { stamp, outline, xs, ys, accel } = buf;
  const epoch = ++buf.epoch;
  // (dot products in numpy einsum's order, (x + z) + y, like model.py)
  const front = (f) => normals[3 * f] * d[0] + normals[3 * f + 2] * d[2] + normals[3 * f + 1] * d[1] > -1e-10;
  let silhouette = 0, m = 0;
  const visit = (e) => {
    if (front(edgeFaces[2 * e]) === front(edgeFaces[2 * e + 1])) return;
    silhouette++;
    const a = edgeVerts[2 * e], b = edgeVerts[2 * e + 1];
    if (stamp[a] !== epoch) {
      stamp[a] = epoch;
      outline[m++] = a;
    }
    if (stamp[b] !== epoch) {
      stamp[b] = epoch;
      outline[m++] = b;
    }
  };
  if (accel) accel.edgesNear(d, visit);
  else for (let e = 0; e < edgeFaces.length / 2; e++) visit(e);
  if (silhouette < 3) {
    m = nv;
    for (let i = 0; i < nv; i++) outline[i] = i;
  }

  let lo = Infinity, hi = -Infinity;
  if (accel) {
    hi = accel.support(d, 0);
    lo = -accel.support([-d[0], -d[1], -d[2]], 1);
  } else {
    for (let i = 0; i < nv; i++) {
      const t = vertices[3 * i] * d[0] + vertices[3 * i + 2] * d[2] + vertices[3 * i + 1] * d[1];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
  }

  const [u, v] = basis(d);
  for (let k = 0; k < m; k++) {
    const i = outline[k];
    const x = vertices[3 * i], y = vertices[3 * i + 1], z = vertices[3 * i + 2];
    xs[k] = x * u[0] + z * u[2] + y * u[1];
    ys[k] = x * v[0] + z * v[2] + y * v[1];
  }
  const px = xs.subarray(0, m), py = ys.subarray(0, m);
  const h = hull2d(px, py);
  const rect = minAreaRect(h.map((i) => px[i]), h.map((i) => py[i]));
  if (!Number.isFinite(rect.area)) return null;
  const a1 = [rect.ex * u[0] + rect.ey * v[0], rect.ex * u[1] + rect.ey * v[1], rect.ex * u[2] + rect.ey * v[2]];
  const extents = [rect.width, rect.height, hi - lo];
  return { axes: [a1, cross(d, a1), d], extents, volume: rect.width * rect.height * (hi - lo) };
}

/**
 * Searches on a hull with many edges (dense smooth surfaces), giving the same results
 * as testing every edge and every vertex:
 *
 * - edgesNear(d, visit): the edges whose faces may lie on either side of d. Edges are
 *   bucketed by the mean m of the normals a, b of their faces. Within a bucket of
 *   centre c, |m . d - c . d| <= |m - c| and |a . d - m . d| = |b . d - m . d| <=
 *   |a - b| / 2, so a bucket where |c . d| exceeds max |m - c| + max |a - b| / 2
 *   (+ slack) has both faces of every edge on the same side (like model.py
 *   `_Silhouettes`, which buckets on a).
 * - support(d, slot): the largest p . d over the hull vertices by hill climbing along
 *   the hull edges, which reaches the maximum on a convex polytope; the climb starts
 *   from where the previous one (same slot) ended.
 */
function hullAccelerator(hull) {
  const { vertices, normals, edgeFaces, edgeVerts } = hull;
  const ne = edgeFaces.length / 2;
  const nv = vertices.length / 3;

  // Edge buckets on a grid of the mean normal of their faces, about as many buckets
  // as edges tested per direction.
  const step = Math.min(Math.max(Math.cbrt(8 / ne), 0.01), 0.2);
  const mid = new Float64Array(3 * ne);
  const cellOf = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    const f = edgeFaces[2 * e], g = edgeFaces[2 * e + 1];
    for (let k = 0; k < 3; k++) mid[3 * e + k] = (normals[3 * f + k] + normals[3 * g + k]) / 2;
    cellOf[e] = (Math.floor((mid[3 * e] + 1) / step) * 1024 + Math.floor((mid[3 * e + 1] + 1) / step)) * 1024 + Math.floor((mid[3 * e + 2] + 1) / step);
  }
  const ids = new Map();
  const bucket = new Int32Array(ne);
  for (let e = 0; e < ne; e++) {
    let id = ids.get(cellOf[e]);
    if (id === undefined) ids.set(cellOf[e], (id = ids.size));
    bucket[e] = id;
  }
  const nb = ids.size;
  const start = new Int32Array(nb + 1);
  for (let e = 0; e < ne; e++) start[bucket[e] + 1]++;
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const fill = start.slice(0, nb);
  const order = new Int32Array(ne);
  const centre = new Float64Array(3 * nb);
  for (let e = 0; e < ne; e++) {
    const b = bucket[e];
    order[fill[b]++] = e;
    for (let k = 0; k < 3; k++) centre[3 * b + k] += mid[3 * e + k];
  }
  for (let b = 0; b < nb; b++) for (let k = 0; k < 3; k++) centre[3 * b + k] /= start[b + 1] - start[b];
  const spread = new Float64Array(nb), reach = new Float64Array(nb);
  for (let e = 0; e < ne; e++) {
    const b = bucket[e], f = edgeFaces[2 * e], g = edgeFaces[2 * e + 1];
    let mc = 0, ab = 0;
    for (let k = 0; k < 3; k++) {
      mc += (mid[3 * e + k] - centre[3 * b + k]) ** 2;
      ab += (normals[3 * f + k] - normals[3 * g + k]) ** 2;
    }
    reach[b] = Math.max(reach[b], Math.sqrt(mc));
    spread[b] = Math.max(spread[b], Math.sqrt(ab) / 2);
  }
  for (let b = 0; b < nb; b++) reach[b] += spread[b] + 1e-9;

  // Vertex adjacency (CSR) for the climbs.
  const degree = new Int32Array(nv + 1);
  for (let e = 0; e < ne; e++) {
    degree[edgeVerts[2 * e] + 1]++;
    degree[edgeVerts[2 * e + 1] + 1]++;
  }
  for (let i = 0; i < nv; i++) degree[i + 1] += degree[i];
  const next = degree.slice(0, nv);
  const adjacent = new Int32Array(2 * ne);
  for (let e = 0; e < ne; e++) {
    const a = edgeVerts[2 * e], b = edgeVerts[2 * e + 1];
    adjacent[next[a]++] = b;
    adjacent[next[b]++] = a;
  }
  const from = [0, 0];

  return {
    edgesNear(d, visit) {
      for (let b = 0; b < nb; b++) {
        const t = centre[3 * b] * d[0] + centre[3 * b + 1] * d[1] + centre[3 * b + 2] * d[2];
        if (Math.abs(t) > reach[b]) continue;
        for (let j = start[b]; j < start[b + 1]; j++) visit(order[j]);
      }
    },
    support(d, slot) {
      const along = (i) => vertices[3 * i] * d[0] + vertices[3 * i + 2] * d[2] + vertices[3 * i + 1] * d[1];
      let v = from[slot], best = along(v);
      for (;;) {
        let up = -1;
        for (let j = degree[v]; j < degree[v + 1]; j++) {
          const t = along(adjacent[j]);
          if (t > best) {
            best = t;
            up = adjacent[j];
          }
        }
        if (up < 0) break;
        v = up;
      }
      from[slot] = v;
      return best;
    },
  };
}
