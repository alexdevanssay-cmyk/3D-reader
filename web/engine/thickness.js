// Wall thickness ("épaisseur de toile") of a closed triangle mesh, by the two
// usual methods of casting design:
//
// - ray: at a point of the surface, the distance to the opposite wall along
//   the inward normal. It reads the thickness of plates and ribs everywhere,
//   edges included. At each vertex of the display mesh.
// - sphere: the diameter of the largest ball inside the material touching the
//   surface at that point (largest inscribed sphere). It shows the hot spots:
//   at a junction of walls the ball is larger than the walls. Near a convex
//   edge it gets smaller (a ball cannot touch an edge), so it is computed at
//   the centre of each triangle, and a vertex takes the largest value of its
//   triangles. Shrinking-ball algorithm (Ma, Bae, Choi, Lee, Lee 2012): a ball
//   tangent at p, first as large as the wall along the normal, shrinks to the
//   ball through p and the closest surface point inside it, until there is none.
//
// Both use a bounding volume hierarchy of the triangles (N log N in all).
// Plain JavaScript without imports: it runs in the engine worker.

const LEAF_SIZE = 8;
const EDGE_MARGIN = 1e-7;
const MAX_ITERATIONS = 40;
// A ball is accepted when no surface point is deeper inside it than this share
// of its radius: the display mesh is made of flat triangles (chords), slightly
// inside the true curved surface.
const BALL_TOLERANCE = 0.01;
// A surface point seen from the ball centre less than this angle away from p
// belongs to p's own neighbourhood (sharp concave edge), not to the opposite
// wall: it does not shrink the ball (Ma et al., "denoising" threshold).
const MIN_SEPARATION = (25 * Math.PI) / 180;
const SMOOTH = Math.cos((30 * Math.PI) / 180);
const COVER = Math.cos((60 * Math.PI) / 180);

/**
 * Thickness (mm) of each triangle, by both methods.
 *
 * positions -- Float32Array/Float64Array, xyz per vertex (mm)
 * indices   -- Uint32Array, 3 per triangle
 * onProgress(fraction) -- optional, called about every 1 % of the work
 *
 * Returns {ray, sphere, wall}: Float32Array per triangle (NaN where undefined,
 * e.g. a ray leaving an open mesh).
 * - ray: from the centre of the triangle along its inward normal.
 * - sphere: largest of the balls tangent at the centre of the triangle and at
 *   the middle of its edges inside a smooth surface. A CAD face is often cut
 *   into long triangles along its edges: their centres are close to the edge
 *   of the face, where a ball has no room, but the middle of the diagonal of
 *   a rectangle, or of the chords of a disc, is well inside.
 * - wall: the larger of the two (see below), for the thinnest wall of a part.
 * The normals are oriented outwards from the sign of the enclosed volume: the
 * mesh must be closed and consistently oriented (any body with a volume).
 *
 * The work is done in two passes over ranges, so that it can be shared out
 * between workers (see thickpool.js): ballPass() over the triangles, then
 * coverPass() over the balls found; the results of the ranges are merged with
 * mergeMax() (largest value of each triangle), the wall with wallOf().
 */
export function wallThickness(positions, indices, { onProgress = null } = {}) {
  const nt = indices.length / 3;
  if (!nt) return { ray: new Float32Array(0), sphere: new Float32Array(0), wall: new Float32Array(0) };
  const mesh = prepareMesh(positions, indices);
  const first = ballPass(mesh, 0, nt, onProgress && ((f) => onProgress(0.8 * f)));
  const sphere = coverPass(mesh, first.samples, first.sphere, 0, first.samples.length / 7, onProgress && ((f) => onProgress(0.8 + 0.2 * f)));
  onProgress?.(1);
  return { ray: first.ray, sphere, wall: wallOf(first.ray, sphere) };
}

/**
 * What both passes need of a mesh: normals, bounding volume hierarchy, the
 * neighbour across each edge. Plain typed arrays, made with alloc(Type,
 * length): in SharedArrayBuffers, the workers of the pool share one copy
 * (see thickpool.js). Then withQueries() adds the search functions.
 */
export function prepareMesh(positions, indices, alloc = (Type, n) => new Type(n)) {
  const normals = triangleNormals(positions, indices, alloc);
  const bvh = buildBvh(positions, indices, alloc);
  const neighbours = edgeNeighbours(positions.length / 3, indices, alloc);
  const diag = Math.hypot(bvh.max[0] - bvh.min[0], bvh.max[1] - bvh.min[1], bvh.max[2] - bvh.min[2]);
  return withQueries({ positions, indices, normals, bvh, neighbours, diag });
}

/** The prepared mesh with its search functions (each worker makes its own: they keep a stack). */
export function withQueries({ query, ...data }) {
  return { ...data, query: makeQueries(data.bvh) };
}

/**
 * The triangle on the other side of each edge (3 per triangle, edge e from
 * vertex e to vertex e + 1): -1 on a free edge, -2 on an edge shared by more
 * than two triangles. Found with an open-addressing hash of the edges.
 */
function edgeNeighbours(nv, indices, alloc) {
  const nt = indices.length / 3;
  const out = alloc(Int32Array, 3 * nt).fill(-1);
  let size = 16;
  while (size < 3 * nt * 2) size *= 2;
  const mask = size - 1;
  const keyA = new Int32Array(size).fill(-1);
  const keyB = new Int32Array(size);
  const first = new Int32Array(size); // half-edge (3 f + e) seen first
  const second = new Int32Array(size).fill(-1); // and second
  for (let h = 0; h < 3 * nt; h++) {
    const f = (h / 3) | 0;
    const e = h - 3 * f;
    const u = indices[h], w = indices[3 * f + ((e + 1) % 3)];
    const i = u < w ? u : w, j = u < w ? w : u;
    let slot = (Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b)) & mask;
    while (keyA[slot] !== -1 && (keyA[slot] !== i || keyB[slot] !== j)) slot = (slot + 1) & mask;
    if (keyA[slot] === -1) {
      keyA[slot] = i;
      keyB[slot] = j;
      first[slot] = h;
    } else if (second[slot] === -1) {
      second[slot] = h;
      out[first[slot]] = f;
      out[h] = (first[slot] / 3) | 0;
    } else {
      out[first[slot]] = out[second[slot]] = out[h] = -2;
    }
  }
  return out;
}

/**
 * First pass, over the triangles from..to-1: the ray thickness and the balls
 * tangent at their centres and at the middle of their smooth edges.
 * Returns {ray, sphere} (Float32Array of all the triangles, NaN outside the
 * range; sphere can also be set on a neighbour) and the balls found, for the
 * second pass: samples, Float32Array of [x, y, z, outward nx, ny, nz, diameter].
 */
export function ballPass(mesh, from, to, onProgress = null, store = null) {
  const { positions, indices, normals, neighbours, query, diag } = mesh;
  const nt = indices.length / 3;
  // Where the values go: arrays of this range, or the arrays shared by the workers.
  const ray = store?.ray ?? new Float32Array(nt).fill(NaN);
  const sphere = store?.sphere ?? new Float32Array(nt).fill(NaN);
  const raiseTo = store?.raiseTo ?? ((f, value) => (sphere[f] = value));
  const eps = diag * 1e-7;
  const tMin = diag * 1e-5; // hits right at the start point (its own or the next face) do not count
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const c = [0, 0, 0];
  const q = [0, 0, 0];

  // Largest ball inside the material tangent at p, normal n (inwards): it starts
  // as large as the wall along n, then shrinks to the ball through p and the
  // closest surface point inside it, until there is none.
  const ball = (t) => {
    let r = (Number.isFinite(t) ? t : diag) / 2;
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      c[0] = p[0] + n[0] * r;
      c[1] = p[1] + n[1] * r;
      c[2] = p[2] + n[2] * r;
      const limit = r * (1 - BALL_TOLERANCE);
      const d2 = query.closest(c, q, limit * limit);
      if (!(d2 < limit * limit)) break; // no surface inside the ball
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const pq2 = ux * ux + uy * uy + uz * uz;
      const along = ux * n[0] + uy * n[1] + uz * n[2];
      if (along <= 0 || pq2 <= eps * eps) break;
      // Angle p-c-q: a contact point next to p is p's own edge, not the opposite wall.
      const cos = ((p[0] - c[0]) * (q[0] - c[0]) + (p[1] - c[1]) * (q[1] - c[1]) + (p[2] - c[2]) * (q[2] - c[2])) / (r * Math.max(Math.sqrt(d2), eps));
      if (Math.acos(Math.max(-1, Math.min(1, cos))) < MIN_SEPARATION) break;
      const next = pq2 / (2 * along); // ball tangent at p through q
      if (!(next < r)) break;
      r = next;
    }
    return 2 * r;
  };
  const keepMax = (f, value) => {
    if (Number.isFinite(value) && !(sphere[f] >= value)) raiseTo(f, value);
  };
  // Every ball, for the second pass: [x, y, z, outward nx, ny, nz, diameter] each
  // (single precision, like the mesh: half the memory).
  let samples = new Float32Array(7 * Math.max(16, Math.ceil((to - from) * 1.5)));
  let used = 0;
  const addSample = (value) => {
    if (!Number.isFinite(value)) return;
    if (used + 7 > samples.length) {
      const grown = new Float32Array(samples.length * 2);
      grown.set(samples);
      samples = grown;
    }
    samples[used++] = p[0];
    samples[used++] = p[1];
    samples[used++] = p[2];
    samples[used++] = -n[0];
    samples[used++] = -n[1];
    samples[used++] = -n[2];
    samples[used++] = value;
  };

  // Edges inside a smooth surface: shared by exactly two triangles at less
  // than 30° (the edges of a CAD face belong to one triangle of its vertices).

  const every = Math.max(1, Math.floor((to - from) / 100));
  for (let f = from; f < to; f++) {
    if (onProgress && (f - from) % every === 0) onProgress((f - from) / (to - from));
    n[0] = -normals[3 * f];
    n[1] = -normals[3 * f + 1];
    n[2] = -normals[3 * f + 2];
    if (!(n[0] || n[1] || n[2])) continue; // degenerate triangle
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], d = 3 * indices[3 * f + 2];
    for (let k = 0; k < 3; k++) p[k] = (positions[a + k] + positions[b + k] + positions[d + k]) / 3;
    const t = query.ray(p, n, tMin);
    if (Number.isFinite(t)) ray[f] = t;
    const value = ball(t);
    keepMax(f, value);
    addSample(value);

    for (let e = 0; e < 3; e++) {
      const i = indices[3 * f + e], j = indices[3 * f + ((e + 1) % 3)];
      const second = neighbours[3 * f + e];
      if (second < f) continue; // free or shared by more than two triangles (< 0), or done from the other triangle
      const g = 3 * second;
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += normals[3 * f + k] * normals[g + k];
      if (dot < SMOOTH) continue;
      let len = 0;
      for (let k = 0; k < 3; k++) {
        p[k] = (positions[3 * i + k] + positions[3 * j + k]) / 2;
        n[k] = -(normals[3 * f + k] + normals[g + k]);
        len += n[k] * n[k];
      }
      len = Math.sqrt(len);
      for (let k = 0; k < 3; k++) n[k] /= len;
      const value = ball(query.ray(p, n, tMin));
      keepMax(f, value);
      keepMax(second, value);
      addSample(value);
      for (let k = 0; k < 3; k++) n[k] = -normals[3 * f + k]; // back to this triangle
    }
  }
  return { ray, sphere, samples: samples.subarray(0, used) };
}

/**
 * Second pass, over the balls from..to-1 of samples: local thickness. A ball
 * tangent at a point of a wall gives its diameter to the surface around that
 * point, up to its radius, on the same side of the wall (normals less than 60°
 * apart). Close to a convex edge no ball fits, but the balls of the middle of
 * the wall reach it: a 6 mm rib reads 6 mm up to its edges, and a hot spot
 * shows over the area its ball touches.
 * sphere -- the sphere values so far (all the triangles): changed in place and
 *           returned. Each triangle ends with the largest value that reaches
 *           it, whatever the order of the balls: the ranges can be merged.
 */
export function coverPass(mesh, samples, sphere, from, to, onProgress = null, raiseTo = null) {
  const { normals, query } = mesh;
  const set = raiseTo ?? ((f, value) => (sphere[f] = value));
  const every = Math.max(1, Math.floor((to - from) / 20));
  for (let s = from; s < to; s++) {
    if (onProgress && (s - from) % every === 0) onProgress((s - from) / (to - from));
    const k = 7 * s;
    const radius = samples[k + 6] / 2;
    const value = samples[k + 6];
    const want = (f) =>
      !(sphere[f] >= value) && normals[3 * f] * samples[k + 3] + normals[3 * f + 1] * samples[k + 4] + normals[3 * f + 2] * samples[k + 5] > COVER;
    query.within(samples, k, radius * radius, want, (f) => set(f, value));
  }
  return sphere;
}

/** Into target, the largest of the two values of each triangle (NaN: no value). */
export function mergeMax(target, values) {
  for (let f = 0; f < target.length; f++) {
    const v = values[f];
    if (Number.isFinite(v) && !(target[f] >= v)) target[f] = v;
  }
  return target;
}

/**
 * Wall: the larger of the two. Each method underestimates where the other
 * does not: the sphere near convex edges and at the ends of bars (no room for
 * a ball), the ray at concave corners (it meets the next wall early).
 */
export function wallOf(ray, sphere) {
  const wall = new Float32Array(ray.length);
  for (let f = 0; f < ray.length; f++) {
    const a = ray[f], b = sphere[f];
    wall[f] = Number.isFinite(a) ? (Number.isFinite(b) ? Math.max(a, b) : a) : b;
  }
  return wall;
}

/** Smallest and largest finite values. */
export function valueRange(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const x of values) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return min <= max ? [min, max] : [NaN, NaN];
}

// Share of the surface below which the thinnest (or thickest) values are not
// reported: a few tiny triangles along the edges of the faces should not set
// the minimum wall of a part.
export const STATS_SHARE = 0.001;

/**
 * Area-weighted statistics of the thickness of one or more meshes:
 * {min, median, max, area, details} in mm (mm² for area).
 * - min: the thinnest wall found on at least STATS_SHARE of the surface;
 *   max: the thickest likewise.
 * - floor (option): thinner values are details of the surface (lettering,
 *   marks), not walls: they are left out of min / median / max and reported
 *   apart as details: {min, share of the surface}, or null when there are
 *   none (on less than STATS_SHARE of the surface).
 * parts: [{positions, indices, values}] (values per triangle; NaN skipped).
 */
export function thicknessStats(parts, { floor = 0 } = {}) {
  const items = [];
  for (const { positions, indices, values } of parts) {
    for (let f = 0; f < values.length; f++) {
      if (Number.isFinite(values[f])) items.push([values[f], triangleArea(positions, indices[3 * f], indices[3 * f + 1], indices[3 * f + 2])]);
    }
  }
  if (!items.length) return { min: null, median: null, max: null, area: 0, details: null };
  items.sort((x, y) => x[0] - y[0]);
  const areaOf = (list) => list.reduce((n, it) => n + it[1], 0);
  const quantile = (list, fraction) => {
    const total = areaOf(list);
    let acc = 0;
    for (const [value, area] of list) if ((acc += area) >= fraction * total) return value;
    return list.at(-1)[0];
  };
  const total = areaOf(items);
  const thin = floor > 0 ? items.filter(([v]) => v < floor) : [];
  const thinShare = thin.length ? areaOf(thin) / total : 0;
  const kept = floor > 0 ? items.filter(([v]) => v >= floor) : items;
  const stats = kept.length
    ? { min: quantile(kept, STATS_SHARE), median: quantile(kept, 0.5), max: quantile(kept, 1 - STATS_SHARE) }
    : { min: null, median: null, max: null };
  return { ...stats, area: total, details: thinShare >= STATS_SHARE ? { min: quantile(thin, 0.01), share: thinShare } : null };
}

/**
 * Share of the surface area per thickness class: `bins` classes of `width` mm
 * from 0 (the last one also takes everything thicker), from the thickness of
 * each triangle.
 */
export function thicknessHistogram(positions, indices, thickness, width, bins) {
  const area = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const value = thickness[i / 3];
    if (!Number.isFinite(value)) continue;
    const s = triangleArea(positions, indices[i], indices[i + 1], indices[i + 2]);
    area[Math.min(bins - 1, Math.max(0, Math.floor(value / width)))] += s;
    total += s;
  }
  return { area, total };
}

function triangleArea(pos, a, b, c) {
  const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
  const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** Unit normals of the triangles, oriented outwards (flipped if the enclosed volume is negative). */
function triangleNormals(pos, idx, alloc = (Type, n) => new Type(n)) {
  const normals = alloc(Float64Array, idx.length);
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = 3 * idx[i], b = 3 * idx[i + 1], c = 3 * idx[i + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    normals[i] = uy * vz - uz * vy;
    normals[i + 1] = uz * vx - ux * vz;
    normals[i + 2] = ux * vy - uy * vx;
    volume += pos[a] * normals[i] + pos[a + 1] * normals[i + 1] + pos[a + 2] * normals[i + 2];
  }
  const sign = volume < 0 ? -1 : 1;
  for (let k = 0; k < normals.length; k += 3) {
    const len = Math.hypot(normals[k], normals[k + 1], normals[k + 2]);
    const f = len > 0 ? sign / len : 0;
    normals[k] *= f;
    normals[k + 1] *= f;
    normals[k + 2] *= f;
  }
  return normals;
}

// ------------------------------------------------------------------ BVH

/**
 * Bounding volume hierarchy over the triangles: binary tree split at the
 * median of the longest axis. Triangles are stored in tree order (9 doubles
 * each); node i has bounds box[6i..6i+5] and either two children (left = i+1,
 * right = right[i]) or a leaf range [start[i], start[i] + count[i]).
 */
function buildBvh(pos, idx, alloc = (Type, n) => new Type(n)) {
  const nt = idx.length / 3;
  const order = alloc(Uint32Array, nt);
  const centre = new Float64Array(3 * nt);
  for (let t = 0; t < nt; t++) {
    order[t] = t;
    for (let k = 0; k < 3; k++) {
      centre[3 * t + k] = (pos[3 * idx[3 * t] + k] + pos[3 * idx[3 * t + 1] + k] + pos[3 * idx[3 * t + 2] + k]) / 3;
    }
  }
  const maxNodes = 2 * Math.ceil(nt / (LEAF_SIZE / 2)) + 1;
  const box = alloc(Float64Array, 6 * maxNodes);
  const right = alloc(Int32Array, maxNodes);
  const start = alloc(Int32Array, maxNodes);
  const count = alloc(Int32Array, maxNodes);
  let nodes = 0;

  const tri = (t, k, axis) => pos[3 * idx[3 * t + k] + axis];
  const build = (lo, hi) => {
    const node = nodes++;
    const b = 6 * node;
    box[b] = box[b + 1] = box[b + 2] = Infinity;
    box[b + 3] = box[b + 4] = box[b + 5] = -Infinity;
    let cmin0 = Infinity, cmin1 = Infinity, cmin2 = Infinity, cmax0 = -Infinity, cmax1 = -Infinity, cmax2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        for (let axis = 0; axis < 3; axis++) {
          const x = tri(t, k, axis);
          if (x < box[b + axis]) box[b + axis] = x;
          if (x > box[b + 3 + axis]) box[b + 3 + axis] = x;
        }
      }
      const cx = centre[3 * t], cy = centre[3 * t + 1], cz = centre[3 * t + 2];
      if (cx < cmin0) cmin0 = cx;
      if (cx > cmax0) cmax0 = cx;
      if (cy < cmin1) cmin1 = cy;
      if (cy > cmax1) cmax1 = cy;
      if (cz < cmin2) cmin2 = cz;
      if (cz > cmax2) cmax2 = cz;
    }
    const ext = [cmax0 - cmin0, cmax1 - cmin1, cmax2 - cmin2];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    if (hi - lo <= LEAF_SIZE || ext[axis] <= 0) {
      start[node] = lo;
      count[node] = hi - lo;
      return node;
    }
    const mid = (lo + hi) >> 1;
    select(order, centre, axis, lo, hi - 1, mid);
    build(lo, mid);
    right[node] = build(mid, hi);
    return node;
  };
  build(0, nt);

  // The corners in the type of the positions: as exact, half the memory for Float32 positions.
  const tris = alloc(pos instanceof Float32Array ? Float32Array : Float64Array, 9 * nt);
  // Plane of each triangle (unit normal, offset): the distance to the plane is
  // a cheap lower bound of the distance to the triangle.
  const planes = alloc(Float64Array, 4 * nt);
  for (let i = 0; i < nt; i++) {
    const t = order[i];
    for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) tris[9 * i + 3 * k + axis] = tri(t, k, axis);
    const o = 9 * i;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
      planes[4 * i] = nx;
      planes[4 * i + 1] = ny;
      planes[4 * i + 2] = nz;
      planes[4 * i + 3] = nx * tris[o] + ny * tris[o + 1] + nz * tris[o + 2];
    }
  }
  return { box, right, start, count, tris, planes, order, min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] };
}

/** Quickselect: order[lo..hi] partitioned so that order[k] has the median centre on `axis`. */
function select(order, centre, axis, lo, hi, k) {
  while (hi > lo) {
    const pivot = centre[3 * order[(lo + hi) >> 1] + axis];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (centre[3 * order[i] + axis] < pivot) i++;
      while (centre[3 * order[j] + axis] > pivot) j--;
      if (i <= j) {
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

function makeQueries({ box, right, start, count, tris, planes, order }) {
  const stack = new Int32Array(256);
  const tmp = [0, 0, 0];

  const boxDistance2 = (node, x, y, z) => {
    const b = 6 * node;
    const dx = x < box[b] ? box[b] - x : x > box[b + 3] ? x - box[b + 3] : 0;
    const dy = y < box[b + 1] ? box[b + 1] - y : y > box[b + 4] ? y - box[b + 4] : 0;
    const dz = z < box[b + 2] ? box[b + 2] - z : z > box[b + 5] ? z - box[b + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  };

  /**
   * Squared distance from point c to the surface, if below maxD2 (else maxD2
   * or more is returned); the closest point goes to out.
   */
  function closest(c, out, maxD2 = Infinity) {
    const [x, y, z] = c;
    let best = maxD2;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      if (boxDistance2(node, x, y, z) >= best) continue;
      if (count[node]) {
        for (let i = start[node], end = i + count[node]; i < end; i++) {
          const h = planes[4 * i] * x + planes[4 * i + 1] * y + planes[4 * i + 2] * z - planes[4 * i + 3];
          if (h * h >= best) continue;
          const d2 = closestOnTriangle(tris, 9 * i, x, y, z, tmp);
          if (d2 < best) {
            best = d2;
            out[0] = tmp[0];
            out[1] = tmp[1];
            out[2] = tmp[2];
          }
        }
        continue;
      }
      const l = node + 1;
      const r = right[node];
      const dl = boxDistance2(l, x, y, z);
      const dr = boxDistance2(r, x, y, z);
      // Nearer child on top of the stack.
      if (dl < dr) {
        if (dr < best) stack[sp++] = r;
        if (dl < best) stack[sp++] = l;
      } else {
        if (dl < best) stack[sp++] = l;
        if (dr < best) stack[sp++] = r;
      }
    }
    return best;
  }

  /** Distance along the ray (p, unit d) to the first triangle beyond tMin. */
  function ray(p, d, tMin) {
    const [ox, oy, oz] = p;
    const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
    let best = Infinity;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      const b = 6 * node;
      let t0 = (box[b] - ox) * ix, t1 = (box[b + 3] - ox) * ix;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      t0 = (box[b + 1] - oy) * iy;
      t1 = (box[b + 4] - oy) * iy;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
      t0 = (box[b + 2] - oz) * iz;
      t1 = (box[b + 5] - oz) * iz;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
      // NaN (ray in the plane of a flat box side) keeps the node.
      if (lo > hi || hi < tMin || lo >= best) continue;
      if (count[node]) {
        for (let i = start[node], end = i + count[node]; i < end; i++) {
          const t = rayTriangle(tris, 9 * i, ox, oy, oz, d[0], d[1], d[2]);
          if (t > tMin && t < best) best = t;
        }
        continue;
      }
      stack[sp++] = right[node];
      stack[sp++] = node + 1;
    }
    return best;
  }

  /**
   * Call fn(triangle) for each triangle closer than sqrt(r2) to the point at
   * point[o..o+2], among those for which want(triangle) is true (tested first).
   */
  function within(point, o, r2, want, fn) {
    const x = point[o], y = point[o + 1], z = point[o + 2];
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      if (boxDistance2(node, x, y, z) > r2) continue;
      if (count[node]) {
        for (let i = start[node], end = i + count[node]; i < end; i++) {
          if (!want(order[i])) continue;
          const h = planes[4 * i] * x + planes[4 * i + 1] * y + planes[4 * i + 2] * z - planes[4 * i + 3];
          if (h * h > r2) continue;
          if (closestOnTriangle(tris, 9 * i, x, y, z, tmp) <= r2) fn(order[i]);
        }
        continue;
      }
      stack[sp++] = right[node];
      stack[sp++] = node + 1;
    }
  }

  return { closest, ray, within };
}

/** Möller–Trumbore, both faces; Infinity when missed. */
function rayTriangle(T, o, ox, oy, oz, dx, dy, dz) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-300) return Infinity;
  const inv = 1 / det;
  const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
  // A small margin: a ray through the common edge of two triangles must not
  // slip between them (rounding can put it just outside both).
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -EDGE_MARGIN || u > 1 + EDGE_MARGIN) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EDGE_MARGIN || u + v > 1 + EDGE_MARGIN) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Closest point of triangle T[o..o+8] to (x, y, z) (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(T, o, x, y, z, out) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = x - ax, apy = y - ay, apz = z - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let rx, ry, rz;
  if (d1 <= 0 && d2 <= 0) {
    rx = ax; ry = ay; rz = az;
  } else {
    const bpx = x - T[o + 3], bpy = y - T[o + 4], bpz = z - T[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = x - T[o + 6], cpy = y - T[o + 7], cpz = z - T[o + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      rx = T[o + 3]; ry = T[o + 4]; rz = T[o + 5];
    } else if (d6 >= 0 && d5 <= d6) {
      rx = T[o + 6]; ry = T[o + 7]; rz = T[o + 8];
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      rx = ax + abx * v; ry = ay + aby * v; rz = az + abz * v;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      rx = T[o + 3] + (T[o + 6] - T[o + 3]) * w;
      ry = T[o + 4] + (T[o + 7] - T[o + 4]) * w;
      rz = T[o + 5] + (T[o + 8] - T[o + 5]) * w;
    } else {
      const denom = 1 / (va + vb + vc);
      const v = vb * denom;
      const w = vc * denom;
      rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w;
    }
  }
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  return (x - rx) * (x - rx) + (y - ry) * (y - ry) + (z - rz) * (z - rz);
}
