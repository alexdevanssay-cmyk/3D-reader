// Totals and overall envelope of a set of bodies (browser counterpart of
// reader3d/model.py `summarize`).
//
// The oriented envelope is the smallest-volume box found over the candidate
// orientations "one box face flush with a face of the convex hull": for every
// distinct hull face normal, the hull is projected on the plane of that face and the
// minimum-area enclosing rectangle is found with rotating calipers. This is the same
// family of candidates as trimesh.bounds.oriented_bounds (used by the Python engine),
// searched exhaustively rather than on a 0.1 rad grid, and the axis-aligned box is
// always kept as a candidate, so the result is never larger than the AABB.

import { Vector3 } from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

/** Above this many distinct points the hull orientation search runs on a subsample. */
const HULL_MAX_POINTS = 20000;
/** Candidate directions are bounded by MAX_DIRECTIONS and by a work budget of
 *  directions x (hull faces + edges + vertices); beyond it hull normals are binned. */
const MAX_DIRECTIONS = 4000;
const MIN_DIRECTIONS = 300;
const SEARCH_BUDGET = 8e7;
/** Candidates re-measured exactly on every point. */
const TOP_CANDIDATES = 4;

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

  let centroid = null;
  if (solids.length && volume) {
    const m = [0, 0, 0];
    for (const b of solids) {
      if (!b.centroid) continue; // a zero-volume body has no centre of mass
      for (let k = 0; k < 3; k++) m[k] += b.centroid[k] * b.volume;
    }
    centroid = m.map((x) => x / volume);
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
 * Smallest-volume oriented bounding box over all display vertices, compared with the
 * axis-aligned box (model.py `_oriented_box`). Sizes are sorted in decreasing order.
 * Bodies far from the origin carry their double-precision vertices (`mesh.positions64`,
 * see meshanalysis.js), which are used instead of the float32 display copy.
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
    // keep the axis-aligned box, like the Python engine when trimesh fails
  }
  return { size: best, volume: product(best) };
}

const product = (v) => v[0] * v[1] * v[2];

/** Distinct finite vertices used by the bodies' meshes, as a Float64Array (xyz). */
function uniquePoints(bodies) {
  const sourceOf = (b) => b.mesh?.positions64 ?? b.mesh?.positions;
  let total = 0;
  for (const b of bodies) total += sourceOf(b) ? sourceOf(b).length / 3 : 0;
  const cap = nextPow2(2 * total);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const out = new Float64Array(3 * total);
  const word = new Float64Array(1);
  const words = new Uint32Array(word.buffer);
  // hash of a coordinate: both 32-bit words of its double (-0 and +0 are the same point)
  const mix = (h, v) => {
    word[0] = v === 0 ? 0 : v;
    h = Math.imul(h ^ words[0], 0x9e3779b1);
    return Math.imul(h ^ words[1], 0x85ebca6b);
  };
  let count = 0;
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
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
      let h = mix(mix(mix(0x2545f491, x), y), z);
      h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
      h = (h ^ (h >>> 13)) & mask;
      for (;;) {
        const s = table[h];
        if (s === -1) {
          table[h] = count;
          out[3 * count] = x;
          out[3 * count + 1] = y;
          out[3 * count + 2] = z;
          count++;
          break;
        }
        if (out[3 * s] === x && out[3 * s + 1] === y && out[3 * s + 2] === z) break;
        h = (h + 1) & mask;
      }
    }
  }
  return out.slice(0, 3 * count);
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

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const point = (p, i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];

/** Two unit vectors completing `d` (unit) to an orthonormal basis. */
function basis(d) {
  const helper = Math.abs(d[0]) < 0.6 ? [1, 0, 0] : Math.abs(d[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const u = cross(d, helper);
  const un = scale(u, 1 / norm(u));
  return [un, cross(d, un)];
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
      const t = a[0] * x + a[1] * y + a[2] * z;
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
 * Returns {area, ex, ey} with (ex, ey) the unit direction of that side.
 */
function minAreaRect(px, py) {
  const k = px.length;
  if (k < 3) {
    // Collinear projection: a segment (or a point) has zero area.
    const dx = k === 2 ? px[1] - px[0] : 1, dy = k === 2 ? py[1] - py[0] : 0;
    const len = Math.hypot(dx, dy) || 1;
    return { area: 0, ex: dx / len, ey: dy / len };
  }
  let best = { area: Infinity, ex: 1, ey: 0 };
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
    const area = (alongE(right) - alongE(left)) * (alongN(top) - alongN(i));
    if (area < best.area) best = { area, ex, ey };
  }
  return best;
}

// --------------------------------------------------------------------------- 3-D

/**
 * Minimum-volume oriented box of a point set (Float64Array xyz).
 * Returns {axes: [a1, a2, a3] (unit vectors), extents: [e1, e2, e3]} or null.
 *
 * Coplanar sets get a flat box from the 2-D minimum rectangle in their plane (like
 * trimesh's coplanar fallback) and collinear sets a segment.
 */
export function minVolumeBox(points) {
  const n = points.length / 3;
  if (n < 2) return null;

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
  const [i1, d1] = farthest((x, y, z) => Math.hypot(x, y, z));
  if (!(d1 > 0)) return null;
  const size = d1;
  const line = scale(sub(point(points, i1), p0), 1 / d1);
  const [i2, d2] = farthest((x, y, z) => norm(cross([x, y, z], line)));
  if (d2 <= 1e-12 * size) {
    const [u, v] = basis(line);
    return { axes: [line, u, v], extents: extentsAlong(points, [line, u, v]) };
  }
  let normal = cross(line, sub(point(points, i2), p0));
  normal = scale(normal, 1 / norm(normal));
  const [, planeDev] = farthest((x, y, z) => Math.abs(x * normal[0] + y * normal[1] + z * normal[2]));
  if (planeDev <= 1e-10 * size) return boxForDirection(points, normal, points);

  // Convex hull, of a subsample for very large sets (the final extents use every point).
  const sample = n > HULL_MAX_POINTS ? subsample(points, HULL_MAX_POINTS) : points;
  const hull = hullOf(sample);
  if (!hull) return null;

  const hullSize = (hull.normals.length + hull.vertices.length) / 3 + hull.edgeFaces.length / 2;
  const maxDirections = Math.max(MIN_DIRECTIONS, Math.min(MAX_DIRECTIONS, Math.floor(SEARCH_BUDGET / hullSize)));
  const candidates = [];
  for (const d of hullDirections(hull.normals, maxDirections)) {
    const c = silhouetteBox(hull, d);
    if (!c) continue;
    candidates.push(c);
    candidates.sort((a, b) => a.volume - b.volume);
    if (candidates.length > TOP_CANDIDATES) candidates.pop();
  }
  // Exact extents of the best candidates, measured on every point (so the box encloses
  // them all even when the search ran on a subsample or the hull dropped a point lying
  // within its tolerance).
  let best = null;
  for (const c of candidates) {
    const extents = extentsAlong(points, c.axes);
    const volume = product(extents);
    if (!best || volume < best.volume) best = { axes: c.axes, extents, volume };
  }
  return best && { axes: best.axes, extents: best.extents };
}

/** Box with one axis along `d`: minimum rectangle of the projection on the plane ⟂ d. */
function boxForDirection(points, d, measurePoints) {
  const [u, v] = basis(d);
  const n = points.length / 3;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = point(points, i);
    xs[i] = dot(p, u);
    ys[i] = dot(p, v);
  }
  const h = hull2d(xs, ys);
  const rect = minAreaRect(h.map((i) => xs[i]), h.map((i) => ys[i]));
  const a1 = [rect.ex * u[0] + rect.ey * v[0], rect.ex * u[1] + rect.ey * v[1], rect.ex * u[2] + rect.ey * v[2]];
  const a2 = cross(d, a1);
  const axes = [a1, a2, d];
  return { axes, extents: extentsAlong(measurePoints, axes) };
}

/** Every k-th point plus the extreme points along the axes and the diagonals. */
function subsample(points, target) {
  const n = points.length / 3;
  const step = Math.ceil(n / target);
  const keep = new Set();
  for (let i = 0; i < n; i += step) keep.add(i);
  const dirs = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z]);
  for (const d of dirs) {
    let best = 0, bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = d[0] * points[3 * i] + d[1] * points[3 * i + 1] + d[2] * points[3 * i + 2];
      if (t > bestVal) [bestVal, best] = [t, i];
    }
    keep.add(best);
  }
  const out = new Float64Array(3 * keep.size);
  let o = 0;
  for (const i of keep) {
    out[o++] = points[3 * i];
    out[o++] = points[3 * i + 1];
    out[o++] = points[3 * i + 2];
  }
  return out;
}

/**
 * Convex hull (three.js QuickHull) as flat arrays: hull vertices, face normals and the
 * edges with their two faces.
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
  const edgeFaces = [];
  const edgeVerts = [];
  faces.forEach((face, fi) => {
    normals[3 * fi] = face.normal.x;
    normals[3 * fi + 1] = face.normal.y;
    normals[3 * fi + 2] = face.normal.z;
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
    vertices: Float64Array.from(verts),
    normals,
    edgeFaces: Int32Array.from(edgeFaces),
    edgeVerts: Int32Array.from(edgeVerts),
  };
}

/**
 * Distinct directions of the hull face normals (a normal and its opposite are the same
 * direction). Beyond `maxCount` they are binned on a coarser grid, keeping the first
 * normal of every bin (as trimesh does with its 0.1 rad grid).
 */
function hullDirections(normals, maxCount) {
  const all = [];
  for (let i = 0; i < normals.length; i += 3) {
    let d = [normals[i], normals[i + 1], normals[i + 2]];
    const len = norm(d);
    if (!(len > 0.5)) continue; // degenerate face
    d = scale(d, 1 / len);
    // canonical hemisphere
    const s = Math.abs(d[2]) > 1e-12 ? Math.sign(d[2]) : Math.abs(d[1]) > 1e-12 ? Math.sign(d[1]) : Math.sign(d[0]) || 1;
    all.push(scale(d, s));
  }
  const bin = (keyOf) => {
    const bins = new Map();
    for (const d of all) {
      const key = keyOf(d);
      if (!bins.has(key)) bins.set(key, d);
    }
    return [...bins.values()];
  };
  const distinct = bin((d) => `${Math.round(d[0] * 1e9)},${Math.round(d[1] * 1e9)},${Math.round(d[2] * 1e9)}`);
  if (distinct.length <= maxCount) return distinct;
  // Grid step giving about `maxCount` cells over the hemisphere, enlarged until it fits.
  for (let step = Math.sqrt((2 * Math.PI) / maxCount) / 2; ; step *= 1.25) {
    const r = Math.ceil(1 / step) + 1;
    const w = 2 * r + 1;
    const dirs = bin((d) => ((Math.round(d[0] / step) + r) * w + Math.round(d[1] / step) + r) * w + Math.round(d[2] / step) + r);
    if (dirs.length <= maxCount) return dirs;
  }
}

/**
 * Best box with one axis along `d` for the hull: the outline of the projected hull is
 * the projection of its silhouette edges (between a face turned towards d and a face
 * turned away), whose 2-D hull gets the minimum-area rectangle. Work buffers are
 * allocated once per hull.
 */
function silhouetteBox(hull, d) {
  const { vertices, normals, edgeFaces, edgeVerts } = hull;
  const nf = normals.length / 3;
  const nv = vertices.length / 3;
  const buf = (hull.buffers ??= {
    front: new Uint8Array(nf),
    stamp: new Uint32Array(nv),
    epoch: 0,
    xs: new Float64Array(nv),
    ys: new Float64Array(nv),
  });
  const { front, stamp, xs, ys } = buf;
  const epoch = ++buf.epoch;
  for (let f = 0; f < nf; f++) {
    front[f] = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2] > -1e-10 ? 1 : 0;
  }
  let count = 0;
  for (let e = 0; e < edgeFaces.length; e += 2) {
    if (front[edgeFaces[e]] === front[edgeFaces[e + 1]]) continue;
    const a = edgeVerts[e], b = edgeVerts[e + 1];
    if (stamp[a] !== epoch) {
      stamp[a] = epoch;
      count++;
    }
    if (stamp[b] !== epoch) {
      stamp[b] = epoch;
      count++;
    }
  }
  const all = count < 3;

  const [u, v] = basis(d);
  let lo = Infinity, hi = -Infinity, m = 0;
  for (let i = 0; i < nv; i++) {
    const x = vertices[3 * i], y = vertices[3 * i + 1], z = vertices[3 * i + 2];
    const t = x * d[0] + y * d[1] + z * d[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
    if (!all && stamp[i] !== epoch) continue;
    xs[m] = x * u[0] + y * u[1] + z * u[2];
    ys[m] = x * v[0] + y * v[1] + z * v[2];
    m++;
  }
  const px = xs.subarray(0, m), py = ys.subarray(0, m);
  const h = hull2d(px, py);
  const rect = minAreaRect(h.map((i) => px[i]), h.map((i) => py[i]));
  if (!Number.isFinite(rect.area)) return null;
  const a1 = [rect.ex * u[0] + rect.ey * v[0], rect.ex * u[1] + rect.ey * v[1], rect.ex * u[2] + rect.ey * v[2]];
  return { axes: [a1, cross(d, a1), d], volume: rect.area * (hi - lo) };
}
