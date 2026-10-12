// Parting line drawn by hand on the surface of a cast part: points clicked on
// its display mesh, joined by lines laid on the surface ("droit": a plane
// slice walked from triangle to triangle; "courbe": a circular arc draped on
// the surface), the loops closed, then the two halves of the mould split by
// region and given to the chapes by part, never by face.
//
// Pure geometry: no three.js, no DOM, no Math.random, deterministic (the same
// mesh and the same points give the same result), testable in node. The mesh
// is the display mesh of a body (float32 positions at their real coordinates,
// never recentred): tolerances scale with the size of the coordinates.
//
// Every crossing of an edge is computed once from the canonical end of the
// edge (its welded vertex of lower id), so the two triangles of the edge get
// the same bits: the pieces chain end to end without a gap (feeding.js and
// lineShape chain them by their ends).

import { REACH_DOWN, REACH_UP, SIDE_LOWER, SIDE_NONE, SIDE_UPPER, lineShape } from "./parting.js";

export const DRAW_VERSION = 1;

// A point clicked on a triangle: its barycentrics at least this, so that it
// is inside the triangle it was clicked on.
const BARY_MIN = 1e-12;
const DEG = Math.PI / 180;
// A plane nearly containing a clicked facet slices it along no line.
const FACET_LIMIT = Math.cos(10 * DEG);
// Two candidate planes closer than this are one.
const SAME_PLANE = Math.cos(3 * DEG);
// The level plane through a chord: the chord at least 10° off the axis.
const LEVEL_MIN = Math.sin(10 * DEG);
// The normal section: the mean normal of the two clicked facets, across the chord, at least this long.
const NORMAL_MIN = 0.25;
// Planes turned about the chord, when neither of the first two goes from A to B.
const TURNS = [30, -30, 60, -60];
// Both senses go round to B: the longer one walked up to this share more (plus two edges).
const LONGER = 1.15;
// A start or an end of a walk within this many tau of the slice.
const NEAR_TAU = 10;
// Arcs: one chord of the polygon every 3° at most, 2 to 120 chords.
const ARC_STEP = 3 * DEG;
const ARC_MIN = 2;
const ARC_MAX = 120;
// A* along the edges: nodes explored at most.
export const MAX_NODES = 500_000;
// A drawing: loops and points at most.
export const MAX_LOOPS = 32;
export const MAX_POINTS = 2000;
// Regions of fewer triangles than this and less than this share of the surface: dissolved in their neighbours.
const SMALL_TRIANGLES = 3;
const SMALL_SHARE = 1e-4;
// Points aligned to one height: searched within this share of the diagonal, on this many triangles at most.
const ALIGN_REACH = 0.05;
const ALIGN_TRIANGLES = 4096;
export const PLANES = ["X", "Y", "Z", "vector", "face"];

// ------------------------------------------------------------------ vectors

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const neg = (a) => [-a[0] + 0, -a[1] + 0, -a[2] + 0];

function unit(v) {
  const n = norm(v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** v without its part along the unit vector c, made unit (null when along c). */
const across = (v, c) => unit(sub(v, scale(c, dot(v, c))));

/** The xyz of a point: a SurfacePoint ({p}) or [x, y, z]. */
const pt = (a) => (a && a.p ? a.p : a);

/** Distance from p to the segment ab. */
function segmentDistance(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, add(a, scale(ab, t)));
}

/** Closest point to p on the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

// ------------------------------------------------------------------ mesh

/**
 * What the drawing needs of a body, built once from its line mesh (lineMesh:
 * the vertices welded by position and the neighbour across each edge).
 *
 * line -- {positions (float32), indices, welded, neighbours}
 * outward -- +1 or -1, the sense of the triangles that turns their normals
 *   outwards (computed from the enclosed volume when not given)
 * Returns {P, I, W, N, nt, nvW, rep (the first original vertex of each
 * welded one), Q (Float64Array, the position of each welded vertex), normals
 * (unit, outwards), areas, totalArea, diag, tau (the tolerance of a vertex on
 * a plane), edgeLen (median edge length), outward} plus scratch arrays
 * stamped by generation counters (nothing of the size of the mesh is
 * allocated per click) and, built when first needed, the triangles round
 * each welded vertex.
 */
export function drawMesh(line, { outward = null } = {}) {
  const { positions: P, indices: I, welded: W, neighbours: N } = line;
  const nt = I.length / 3;
  let nvW = 0;
  for (let i = 0; i < W.length; i++) if (W[i] >= nvW) nvW = W[i] + 1;
  const rep = new Int32Array(nvW).fill(-1);
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    if (rep[w] < 0 || I[i] < rep[w]) rep[w] = I[i];
  }
  const Q = new Float64Array(3 * nvW);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let largest = 0;
  for (let w = 0; w < nvW; w++) {
    const v = rep[w];
    if (v < 0) continue;
    for (let k = 0; k < 3; k++) {
      const x = P[3 * v + k];
      Q[3 * w + k] = x;
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
      if (Math.abs(x) > largest) largest = Math.abs(x);
    }
  }
  const diag = nvW && min[0] <= max[0] ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  const centre = min[0] <= max[0] ? min.map((m, k) => (m + max[k]) / 2) : [0, 0, 0];
  const normals = new Float64Array(3 * nt);
  const areas = new Float64Array(nt);
  let volume = 0, totalArea = 0;
  for (let f = 0; f < nt; f++) {
    const a = 3 * W[3 * f], b = 3 * W[3 * f + 1], c = 3 * W[3 * f + 2];
    const ux = Q[b] - Q[a], uy = Q[b + 1] - Q[a + 1], uz = Q[b + 2] - Q[a + 2];
    const vx = Q[c] - Q[a], vy = Q[c + 1] - Q[a + 1], vz = Q[c + 2] - Q[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    areas[f] = len / 2;
    totalArea += len / 2;
    volume += (Q[a] - centre[0]) * nx + (Q[a + 1] - centre[1]) * ny + (Q[a + 2] - centre[2]) * nz;
    if (len > 0) {
      normals[3 * f] = nx / len;
      normals[3 * f + 1] = ny / len;
      normals[3 * f + 2] = nz / len;
    }
  }
  const out = outward === -1 || outward === 1 ? outward : volume < 0 ? -1 : 1;
  if (out < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i] + 0;
  // Median edge length, on at most 4096 triangles at a fixed stride.
  const lengths = [];
  for (let f = 0, stride = Math.max(1, Math.floor(nt / 4096)); f < nt; f += stride) {
    for (let e = 0; e < 3; e++) {
      const a = 3 * W[3 * f + e], b = 3 * W[3 * f + ((e + 1) % 3)];
      lengths.push(Math.hypot(Q[b] - Q[a], Q[b + 1] - Q[a + 1], Q[b + 2] - Q[a + 2]));
    }
  }
  lengths.sort((x, y) => x - y);
  const edgeLen = lengths.length ? lengths[lengths.length >> 1] : 0;
  return {
    P, I, W, N, nt, nvW, rep, Q, normals, areas, totalArea, diag,
    tau: Math.max(1e-6 * diag, 2.4e-7 * largest),
    edgeLen, outward: out,
    // Scratch: signed distances of the welded vertices to the plane of generation sGen.
    sVal: new Float64Array(nvW), sGen: new Uint32Array(nvW), gen: 0,
    stars: null, search: null,
  };
}

/** The triangles round each welded vertex (compressed rows, in triangle order): built once. */
function starsOf(dm) {
  if (dm.stars) return dm.stars;
  const { W, nt, nvW } = dm;
  const start = new Int32Array(nvW + 1);
  for (let i = 0; i < 3 * nt; i++) start[W[i] + 1]++;
  for (let w = 0; w < nvW; w++) start[w + 1] += start[w];
  const list = new Int32Array(3 * nt);
  const fill = start.slice(0, nvW);
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) list[fill[W[3 * f + k]]++] = f;
  }
  return (dm.stars = { start, list });
}

/** The triangles sharing a welded vertex with triangle f (f among them), in order. */
function starOf(dm, f) {
  const { start, list } = starsOf(dm);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const w = dm.W[3 * f + k];
    for (let s = start[w]; s < start[w + 1]; s++) out.push(list[s]);
  }
  out.sort((x, y) => x - y);
  return out.filter((g, i) => i === 0 || g !== out[i - 1]);
}

function sharesVertex(dm, f, g) {
  const W = dm.W;
  for (let i = 0; i < 3; i++) {
    const w = W[3 * g + i];
    if (w === W[3 * f] || w === W[3 * f + 1] || w === W[3 * f + 2]) return true;
  }
  return false;
}

const corner = (dm, w) => [dm.Q[3 * w], dm.Q[3 * w + 1], dm.Q[3 * w + 2]];
const cornersOf = (dm, f) => [0, 1, 2].map((k) => corner(dm, dm.W[3 * f + k]));
const normalOf = (dm, f) => [dm.normals[3 * f], dm.normals[3 * f + 1], dm.normals[3 * f + 2]];

/** Barycentrics of the projection of x on the plane of triangle f (its welded corners). */
function barycentrics(dm, f, x) {
  const [a, b, c] = cornersOf(dm, f);
  const v0 = sub(b, a), v1 = sub(c, a), v2 = sub(x, a);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (!(Math.abs(den) > 0)) return [1 / 3, 1 / 3, 1 / 3];
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}

// ------------------------------------------------------------------ points

/**
 * A point clicked on triangle f: {t: f, b: its barycentrics (double, at
 * least 1e-12, summing to 1), p: the point of the triangle they give}.
 */
export function surfacePoint(dm, f, xyz) {
  const raw = barycentrics(dm, f, xyz);
  const b = raw.map((x) => (x > BARY_MIN ? x : BARY_MIN));
  const s = b[0] + b[1] + b[2];
  for (let k = 0; k < 3; k++) b[k] /= s;
  const [A, B, C] = cornersOf(dm, f);
  const p = add(A, add(scale(sub(B, A), b[1]), scale(sub(C, A), b[2])));
  return { t: f, b, p };
}

/**
 * The point of the surface closest to xyz (a point saved on another
 * tessellation of the part), on the triangle of lowest index among equals:
 * one scan of the triangles, those whose box is further than the best found
 * skipped. Null on a mesh without triangles.
 */
export function reprojectPoint(dm, xyz) {
  const { W, Q, nt } = dm;
  let best = -1, bestD = Infinity, bestX = null;
  for (let f = 0; f < nt; f++) {
    const a = 3 * W[3 * f], b = 3 * W[3 * f + 1], c = 3 * W[3 * f + 2];
    let out2 = 0;
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(Q[a + k], Q[b + k], Q[c + k]), hi = Math.max(Q[a + k], Q[b + k], Q[c + k]);
      const o = xyz[k] < lo ? lo - xyz[k] : xyz[k] > hi ? xyz[k] - hi : 0;
      out2 += o * o;
    }
    if (out2 >= bestD * bestD) continue;
    const x = closestOnTriangle(xyz, [Q[a], Q[a + 1], Q[a + 2]], [Q[b], Q[b + 1], Q[b + 2]], [Q[c], Q[c + 1], Q[c + 2]]);
    const d = dist(x, xyz);
    if (d < bestD) {
      best = f;
      bestD = d;
      bestX = x;
    }
  }
  return best < 0 ? null : surfacePoint(dm, best, bestX);
}

// ------------------------------------------------------------------ plane slices

/** A plane through o, normal m (not necessarily unit), with its own generation of vertex values. */
function newPlane(dm, m, o) {
  dm.gen = (dm.gen + 1) >>> 0;
  if (dm.gen === 0) {
    dm.sGen.fill(0);
    dm.gen = 1;
  }
  return { m, o, gen: dm.gen };
}

/** Signed distance of welded vertex w to the plane, 0 within tau (a vertex on the plane). */
function sOf(dm, pl, w) {
  if (dm.sGen[w] === pl.gen) return dm.sVal[w];
  const Q = dm.Q, m = pl.m, o = pl.o;
  let s = m[0] * (Q[3 * w] - o[0]) + m[1] * (Q[3 * w + 1] - o[1]) + m[2] * (Q[3 * w + 2] - o[2]);
  if (s <= dm.tau && s >= -dm.tau) s = 0;
  dm.sVal[w] = s;
  dm.sGen[w] = pl.gen;
  return s;
}

/**
 * The edges of triangle f crossed by the plane (bit e: edge e, from corner e
 * to e + 1), the sides of its welded vertices (s >= 0, a tie counting as
 * '+'): two bits or none.
 */
function crossedEdges(dm, pl, f) {
  const W = dm.W;
  const p0 = sOf(dm, pl, W[3 * f]) >= 0, p1 = sOf(dm, pl, W[3 * f + 1]) >= 0, p2 = sOf(dm, pl, W[3 * f + 2]) >= 0;
  return (p0 !== p1 ? 1 : 0) | (p1 !== p2 ? 2 : 0) | (p2 !== p0 ? 4 : 0);
}

/** Where the plane crosses the edge (wa, wb), from its welded vertex of lower id: the same bits from both triangles. */
function edgeCrossing(dm, pl, wa, wb) {
  if (wa > wb) [wa, wb] = [wb, wa];
  const sa = sOf(dm, pl, wa), sb = sOf(dm, pl, wb);
  const t = sa / (sa - sb);
  const Q = dm.Q, a = 3 * wa, b = 3 * wb;
  return [Q[a] + t * (Q[b] - Q[a]), Q[a + 1] + t * (Q[b + 1] - Q[a + 1]), Q[a + 2] + t * (Q[b + 2] - Q[a + 2])];
}

const crossingOn = (dm, pl, f, e) => edgeCrossing(dm, pl, dm.W[3 * f + e], dm.W[3 * f + ((e + 1) % 3)]);

/** The slice of triangle f: {f, e0, e1 (its crossed edges, e0 < e1), x0, x1}, or null. */
function chordOf(dm, pl, f) {
  const mask = crossedEdges(dm, pl, f);
  if (!mask) return null;
  const e0 = mask & 1 ? 0 : 1;
  const e1 = mask & 4 ? 2 : 1;
  return { f, e0, e1, x0: crossingOn(dm, pl, f, e0), x1: crossingOn(dm, pl, f, e1) };
}

/** The edge of g on the same welded pair as half-edge h (its entry into g), or -1. */
function entryEdge(dm, h, g) {
  const W = dm.W;
  const f = (h / 3) | 0, e = h - 3 * f;
  const wa = W[h], wb = W[3 * f + ((e + 1) % 3)];
  for (let k = 0; k < 3; k++) {
    const u = W[3 * g + k], v = W[3 * g + ((k + 1) % 3)];
    if ((u === wa && v === wb) || (u === wb && v === wa)) return k;
  }
  return -1;
}

/**
 * The triangle a walk starts from at point sp ({t, p}): t itself when the
 * plane crosses it and its slice passes within 10 tau of p; else, of the
 * crossed triangles sharing a welded vertex with t, the one whose slice
 * passes nearest p (the longer slice, then the lower index, among equals).
 * Null when the plane crosses none of them.
 */
function startOf(dm, pl, sp) {
  const own = chordOf(dm, pl, sp.t);
  if (own && segmentDistance(sp.p, own.x0, own.x1) <= NEAR_TAU * dm.tau) return own;
  const tie = 1e-3 * dm.tau;
  let best = null, bestD = Infinity, bestL = -1;
  for (const g of starOf(dm, sp.t)) {
    const c = g === sp.t ? own : chordOf(dm, pl, g);
    if (!c) continue;
    const d = segmentDistance(sp.p, c.x0, c.x1), l = dist(c.x0, c.x1);
    if (d < bestD - tie || (d <= bestD + tie && l > bestL + tie)) {
      best = c;
      bestD = d;
      bestL = l;
    }
  }
  return best;
}

/** The walk has reached point B (SurfacePoint) in triangle g: g is B's triangle, or a crossed one of its star whose slice passes within 10 tau of B. */
function reaches(dm, pl, g, B) {
  if (g === B.t) return true;
  if (!sharesVertex(dm, g, B.t)) return false;
  const c = chordOf(dm, pl, g);
  return !!c && segmentDistance(B.p, c.x0, c.x1) <= NEAR_TAU * dm.tau;
}

/**
 * The shortest way (breadth first, across manifold edges) from triangle
 * `from` to triangle `to` among the triangles sharing a welded vertex with
 * `around`: the half-edges crossed, in order; null when there is none.
 */
function bridgeRoute(dm, from, to, around) {
  if (from === to) return [];
  for (let e = 0; e < 3; e++) if (dm.N[3 * from + e] === to) return [3 * from + e];
  const allowed = new Set(starOf(dm, around));
  if (!allowed.has(from) || !allowed.has(to)) return null;
  const prev = new Map([[from, -1]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head];
    for (let e = 0; e < 3; e++) {
      const g = dm.N[3 * t + e];
      if (g < 0 || !allowed.has(g) || prev.has(g)) continue;
      prev.set(g, 3 * t + e);
      if (g === to) {
        const route = [];
        for (let x = g; prev.get(x) >= 0; x = (prev.get(x) / 3) | 0) route.push(prev.get(x));
        return route.reverse();
      }
      queue.push(g);
    }
  }
  return null;
}

/** A line being laid: its points, the triangle of each piece, the half-edges crossed. */
class Trace {
  constructor(p) {
    this.xyz = [p[0], p[1], p[2]];
    this.tri = [];
    this.cross = [-1];
    this.twin = [-1];
    this.length = 0;
  }

  get last() {
    const n = this.xyz.length;
    return [this.xyz[n - 3], this.xyz[n - 2], this.xyz[n - 1]];
  }

  /** The piece in triangle f ends at q, where the line leaves f by half-edge h (-1: q inside f) into the half-edge tw of the next triangle. */
  push(f, q, h = -1, tw = -1) {
    this.length += dist(this.last, q);
    this.xyz.push(q[0], q[1], q[2]);
    this.tri.push(f);
    this.cross.push(h);
    this.twin.push(tw);
  }

  /** Pieces of no length at point p, across the edges from triangle `from` to `to` (round their common vertex): the line stays one chain of triangles. */
  bridge(dm, from, to, p, around) {
    const route = bridgeRoute(dm, from, to, around);
    if (!route) return false;
    let t = from;
    for (const h of route) {
      const g = dm.N[h];
      this.push(t, p, h, 3 * g + entryEdge(dm, h, g));
      t = g;
    }
    return true;
  }

  /** The line arrives at point P (SurfacePoint) from triangle f: the piece in f, then the triangles round to P's own. */
  arrive(dm, f, P) {
    const route = f === P.t ? [] : bridgeRoute(dm, f, P.t, P.t) ?? [];
    let t = f;
    for (const h of route) {
      const g = dm.N[h];
      this.push(t, P.p, h, 3 * g + entryEdge(dm, h, g));
      t = g;
    }
    this.push(t, P.p);
  }

  /** The point at half its length. */
  middle() {
    const half = this.length / 2;
    const x = this.xyz;
    let walked = 0;
    for (let k = 3; k < x.length; k += 3) {
      const a = [x[k - 3], x[k - 2], x[k - 1]], b = [x[k], x[k + 1], x[k + 2]];
      const l = dist(a, b);
      if (walked + l >= half && l > 0) return add(a, scale(sub(b, a), (half - walked) / l));
      walked += l;
    }
    return this.last;
  }

  /** The pieces of another trace that starts where this one ends, added to it. */
  append(other) {
    const x = other.xyz;
    for (let j = 0; j < other.tri.length; j++) this.push(other.tri[j], [x[3 * j + 3], x[3 * j + 4], x[3 * j + 5]], other.cross[j + 1], other.twin[j + 1]);
  }

  path(method, extra = {}) {
    return {
      xyz: Float64Array.from(this.xyz),
      tri: Int32Array.from(this.tri),
      cross: Int32Array.from(this.cross),
      twin: Int32Array.from(this.twin),
      edges: null,
      verts: null,
      length: this.length,
      method,
      via: 0,
      m: null,
      status: "ok",
      ...extra,
    };
  }
}

/** A segment that could not be laid: the chord, in A's triangle. */
function failedPath(A, B, method, error) {
  const tr = new Trace(A.p);
  tr.push(A.t, B.p);
  return tr.path(method, { status: "failed", error });
}

/**
 * One sense of the walk along the slice of a plane from A towards B: sense
 * +1 leaves the start triangle by the crossing ahead along B - A (on a tie
 * the lower edge), -1 by the other one.
 */
function walker(dm, pl, A, B, start, sense) {
  const tr = new Trace(A.p);
  const along = dot(sub(start.x0, start.x1), sub(B.p, A.p));
  const e = sense * along > 0 ? start.e0 : sense * along < 0 ? start.e1 : sense > 0 ? start.e0 : start.e1;
  const w = { tr, f: start.f, e, first: start.f, sense, status: "run", error: null, steps: 0 };
  // Both points in one triangle: the chord, inside it.
  if (sense > 0 && A.t === B.t) {
    tr.push(A.t, B.p);
    w.status = "ok";
    return w;
  }
  if (start.f !== A.t) tr.bridge(dm, A.t, start.f, A.p, A.t);
  if (sense > 0 && reaches(dm, pl, start.f, B)) {
    tr.arrive(dm, start.f, B);
    w.status = "ok";
  }
  return w;
}

/** One triangle further: out of the current one by its exit edge, into the next one. */
function walkStep(dm, pl, w, B) {
  const { f, e } = w;
  const h = 3 * f + e;
  const x = crossingOn(dm, pl, f, e);
  const g = dm.N[h];
  const k = g >= 0 ? entryEdge(dm, h, g) : -1;
  w.tr.push(f, x, h, k >= 0 ? 3 * g + k : -1);
  if (g < 0 || k < 0) {
    w.status = "fail";
    w.error = "open";
    return;
  }
  // Before the loop test: a walk round the part comes back to A's triangle when B is in it.
  if (reaches(dm, pl, g, B)) {
    w.tr.arrive(dm, g, B);
    w.status = "ok";
    return;
  }
  // A plane slices a triangle along one chord and an edge joins two
  // triangles: the slice is a chain of triangles, met again only at its
  // first (round a closed slice), so no mark per triangle is needed.
  if (g === w.first || ++w.steps > dm.nt) {
    w.status = "fail";
    w.error = "loop";
    return;
  }
  const other = crossedEdges(dm, pl, g) & ~(1 << k);
  if (!other) {
    w.status = "fail";
    w.error = "open";
    return;
  }
  w.f = g;
  w.e = other & 1 ? 0 : other & 2 ? 1 : 2;
}

/**
 * The line from A to B in the plane through A of normal m (both senses in
 * lockstep, or `only` one): {status: 'ok', trace, sense, m} or {status:
 * 'fail', error}. A plane meeting no triangle at A is tried again with -m (a
 * plane through vertices: the other side of them counts as crossed).
 */
function tryPlane(dm, A, B, m, { only = 0, prefer = null } = {}) {
  for (const mm of [m, neg(m)]) {
    const pl = newPlane(dm, mm, A.p);
    const start = startOf(dm, pl, A);
    if (!start) continue;
    const walkers = (only ? [only] : [1, -1]).map((sense) => walker(dm, pl, A, B, start, sense));
    let bound = Infinity;
    const done = () => walkers.find((w) => w.status === "ok");
    if (done()) bound = LONGER * done().tr.length + 2 * dm.edgeLen;
    for (;;) {
      let running = false;
      for (const w of walkers) {
        if (w.status !== "run") continue;
        if (w.tr.length > bound) {
          w.status = "fail";
          w.error = "longer";
          continue;
        }
        walkStep(dm, pl, w, B);
        if (w.status === "ok" && bound === Infinity) bound = LONGER * w.tr.length + 2 * dm.edgeLen;
        if (w.status === "run") running = true;
      }
      if (!running) break;
    }
    const ok = walkers.filter((w) => w.status === "ok" && w.tr.length <= bound);
    if (!ok.length) return { status: "fail", error: walkers[0].error ?? "open" };
    ok.sort((a, b) => a.tr.length - b.tr.length);
    let chosen = ok[0];
    if (ok.length > 1 && prefer && ok[1].tr.length <= LONGER * ok[0].tr.length) {
      const d0 = dist(ok[0].tr.middle(), prefer), d1 = dist(ok[1].tr.middle(), prefer);
      if (d1 < d0) chosen = ok[1];
    }
    return { status: "ok", trace: chosen.tr, sense: chosen.sense, m: mm };
  }
  // Neither side of the plane met at A (A at a vertex the plane goes through):
  // two points in one triangle still have their chord.
  if (only !== -1 && A.t === B.t) {
    const tr = new Trace(A.p);
    tr.push(A.t, B.p);
    return { status: "ok", trace: tr, sense: 1, m };
  }
  return { status: "fail", error: "open" };
}

/**
 * The candidate planes of a straight segment A -> B, in order: the level
 * plane (through the chord, the closest to square to the axis: points at
 * one height stay at it round the part), the normal section (square to the
 * mean of the clicked facets: a straight line on a face), then the first of
 * them turned about the chord by +30°, -30°, +60°, -60°. Each {method, m}.
 */
function candidatePlanes(dm, A, B, axis, quick) {
  const c = unit(sub(B.p, A.p));
  const nA = normalOf(dm, A.t), nB = normalOf(dm, B.t);
  const list = [];
  const level = sub(axis, scale(c, dot(axis, c)));
  const mLevel = norm(level) >= LEVEL_MIN ? unit(level) : null;
  if (mLevel) list.push({ method: "level", m: mLevel });
  const n = add(nA, nB);
  const nPerp = sub(n, scale(c, dot(n, c)));
  const mNormal = norm(nPerp) >= NORMAL_MIN ? unit(cross(c, nPerp)) : null;
  if (mNormal) list.push({ method: "normal", m: mNormal });
  const base = mLevel ?? mNormal;
  if (base && !quick) {
    const side = cross(c, base);
    for (const deg of TURNS) {
      const t = deg * DEG;
      list.push({ method: "turned", m: add(scale(base, Math.cos(t)), scale(side, Math.sin(t))) });
    }
  }
  return { list, nA, nB, mLevel, mNormal };
}

/**
 * A straight segment ("droit") laid on the surface from A to B (SurfacePoints):
 * the slice of the display mesh by a plane through the chord, walked from
 * triangle to triangle (exact per triangle), the shorter way round of the
 * first candidate plane that goes from A to B (within 15 %, the way whose
 * middle is nearer `prefer`, the camera when placing). Along the edges of the
 * mesh (A*) when no plane does (a hole or a slot between A and B, a free
 * edge).
 *
 * axis -- the rotation axis (the draw direction)
 * prefer -- the camera position at placing time, or null
 * spec -- the segment's {via, m} stored: that plane and that sense first
 * edges -- false: no fallback along the edges
 * quick -- the level and normal planes only, no fallback (hover previews)
 * Returns a Path: {xyz, tri, cross, twin, edges, verts, length, method
 * ('level' | 'normal' | 'turned' | 'edges'), via (+1: leaving A towards B,
 * -1: the other way round), m (the plane's normal), status ('ok' |
 * 'failed'), error}.
 */
export function layStraight(dm, A, B, { axis = [0, 0, 1], prefer = null, spec = null, edges = true, quick = false } = {}) {
  const a = unit(axis) ?? [0, 0, 1];
  const chord = dist(A.p, B.p);
  if (!(chord > 1e-12 * (dm.diag || 1))) {
    const tr = new Trace(A.p);
    tr.arrive(dm, A.t, B);
    return tr.path("normal", { via: 1 });
  }
  const { list, nA, nB, mLevel, mNormal } = candidatePlanes(dm, A, B, a, quick);
  const methodOf = (m) => (mLevel && Math.abs(dot(m, mLevel)) > 1 - 1e-9 ? "level" : mNormal && Math.abs(dot(m, mNormal)) > 1 - 1e-9 ? "normal" : "turned");
  const stored = spec?.m && spec.m.length === 3 && spec.m.every(Number.isFinite) ? unit(spec.m) : null;
  if (stored) {
    const via = spec.via === -1 ? -1 : 1;
    const r = tryPlane(dm, A, B, stored, { only: via });
    if (r.status === "ok") return r.trace.path(methodOf(stored), { via, m: r.m });
  }
  const tried = [];
  for (const { method, m } of list) {
    if (Math.abs(dot(m, nA)) > FACET_LIMIT || Math.abs(dot(m, nB)) > FACET_LIMIT) continue;
    if (tried.some((t) => Math.abs(dot(t, m)) > SAME_PLANE)) continue;
    tried.push(m);
    const r = tryPlane(dm, A, B, m, { prefer });
    if (r.status === "ok") return r.trace.path(method, { via: r.sense, m: r.m });
  }
  if (edges && !quick) {
    const path = edgePath(dm, A, B);
    if (path) return path;
  }
  return failedPath(A, B, "level", "open");
}

/**
 * The normal of the plane a straight segment A -> B is first laid in: the
 * level plane, else the normal section, neither nearly containing a clicked
 * facet; null when neither applies. The plane of the arc a segment turned
 * "courbe" takes by default (arcDefault) when its line has no plane of its
 * own (laid along the edges, or not laid yet).
 */
export function segmentPlane(dm, A, B, axis = [0, 0, 1]) {
  if (!(dist(A.p, B.p) > 0)) return null;
  const { list, nA, nB } = candidatePlanes(dm, A, B, unit(axis) ?? [0, 0, 1], true);
  const first = list.find(({ m }) => Math.abs(dot(m, nA)) <= FACET_LIMIT && Math.abs(dot(m, nB)) <= FACET_LIMIT);
  return first ? first.m : null;
}

// ------------------------------------------------------------------ along the edges

/** A binary heap of (key, node), the lowest key first (then the lowest node). */
class Heap {
  constructor() {
    this.keys = [];
    this.nodes = [];
  }

  get size() {
    return this.keys.length;
  }

  less(i, j) {
    return this.keys[i] < this.keys[j] || (this.keys[i] === this.keys[j] && this.nodes[i] < this.nodes[j]);
  }

  swap(i, j) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.nodes[i], this.nodes[j]] = [this.nodes[j], this.nodes[i]];
  }

  push(key, node) {
    this.keys.push(key);
    this.nodes.push(node);
    for (let i = this.keys.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop() {
    const node = this.nodes[0];
    const lastKey = this.keys.pop(), lastNode = this.nodes.pop();
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.nodes[0] = lastNode;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.less(l, m)) m = l;
        if (r < this.keys.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return node;
  }
}

/** The triangle of lowest index holding the edge (u, v) of welded vertices. */
function edgeTriangle(dm, u, v) {
  const { start, list } = starsOf(dm);
  const W = dm.W;
  for (let s = start[u]; s < start[u + 1]; s++) {
    const f = list[s];
    if (W[3 * f] === v || W[3 * f + 1] === v || W[3 * f + 2] === v) return f;
  }
  return -1;
}

/**
 * The shortest way from A to B along the edges of the mesh (A* on the welded
 * vertices: from the corners of A's triangle, to those of B's, the straight
 * distance to B as heuristic), when no plane slice joins them. Path
 * [A, v1 … vn, B], method 'edges', with the welded pairs of its edges
 * (edges) and its vertices (verts); null when there is none within maxNodes
 * nodes explored.
 */
export function edgePath(dm, A, B, { maxNodes = MAX_NODES } = {}) {
  const { W, Q, nvW } = dm;
  const { start, list } = starsOf(dm);
  const S = (dm.search ??= { g: new Float64Array(nvW + 1), seen: new Uint32Array(nvW + 1), done: new Uint32Array(nvW + 1), prev: new Int32Array(nvW + 1), stamp: 0 });
  S.stamp = (S.stamp + 1) >>> 0;
  if (S.stamp === 0) {
    S.seen.fill(0);
    S.done.fill(0);
    S.stamp = 1;
  }
  const stamp = S.stamp;
  const target = nvW;
  const toB = (v) => Math.hypot(Q[3 * v] - B.p[0], Q[3 * v + 1] - B.p[1], Q[3 * v + 2] - B.p[2]);
  const heap = new Heap();
  const relax = (v, g, from) => {
    if (S.done[v] === stamp || (S.seen[v] === stamp && S.g[v] <= g)) return;
    S.seen[v] = stamp;
    S.g[v] = g;
    S.prev[v] = from;
    heap.push(g + (v === target ? 0 : toB(v)), v);
  };
  for (let k = 0; k < 3; k++) {
    const v = W[3 * A.t + k];
    relax(v, Math.hypot(Q[3 * v] - A.p[0], Q[3 * v + 1] - A.p[1], Q[3 * v + 2] - A.p[2]), -1);
  }
  const ends = new Set([W[3 * B.t], W[3 * B.t + 1], W[3 * B.t + 2]]);
  let explored = 0;
  while (heap.size) {
    const v = heap.pop();
    if (S.done[v] === stamp) continue;
    S.done[v] = stamp;
    if (v === target) break;
    if (++explored > maxNodes) return null;
    if (ends.has(v)) relax(target, S.g[v] + toB(v), v);
    for (let s = start[v]; s < start[v + 1]; s++) {
      const f = list[s];
      for (let k = 0; k < 3; k++) {
        const u = W[3 * f + k];
        if (u === v) continue;
        relax(u, S.g[v] + Math.hypot(Q[3 * u] - Q[3 * v], Q[3 * u + 1] - Q[3 * v + 1], Q[3 * u + 2] - Q[3 * v + 2]), v);
      }
    }
  }
  if (S.done[target] !== stamp) return null;
  const verts = [];
  for (let v = S.prev[target]; v >= 0; v = S.prev[v]) verts.push(v);
  verts.reverse();
  const tr = new Trace(A.p);
  tr.push(A.t, corner(dm, verts[0]));
  for (let i = 1; i < verts.length; i++) tr.push(edgeTriangle(dm, verts[i - 1], verts[i]), corner(dm, verts[i]));
  tr.push(B.t, B.p);
  const pairs = new Uint32Array(2 * (verts.length - 1));
  for (let i = 1; i < verts.length; i++) {
    pairs[2 * i - 2] = verts[i - 1];
    pairs[2 * i - 1] = verts[i];
  }
  return tr.path("edges", { edges: pairs, verts: Uint32Array.from(verts) });
}

// ------------------------------------------------------------------ arcs

/**
 * A minor circular arc from A to B ("courbe"): radius R, toward (the unit
 * vector from the middle of the chord to the centre, made square to the
 * chord). Returns {centre, radius, toward, opening (θ = 2 asin(c / 2R) <=
 * π), length (Rθ), min (c / 2), chord (unit), w (normal of the plane of the
 * arc)}, or {error: 'radius_too_small', min} (R < c/2), or {error:
 * 'centre_invalid', min} (toward along the chord, or A and B one point).
 */
export function arcGeometry(A, B, { radius, toward }) {
  const a = pt(A), b = pt(B);
  const c = dist(a, b);
  const min = c / 2;
  if (!(c > 0)) return { error: "centre_invalid", min };
  if (!(radius >= min * (1 - 1e-9))) return { error: "radius_too_small", min };
  const chord = scale(sub(b, a), 1 / c);
  const k = toward ? across(toward, chord) : null;
  if (!k) return { error: "centre_invalid", min };
  const R = Math.max(radius, min);
  const M = scale(add(a, b), 0.5);
  const h = Math.sqrt(Math.max(0, R * R - min * min));
  const opening = 2 * Math.asin(Math.min(1, min / R));
  return { centre: add(M, scale(k, h)), radius: R, toward: k, opening, length: R * opening, min, chord, w: unit(cross(chord, k)) };
}

/**
 * The arc given to a segment turned "courbe": radius the chord (60°), its
 * plane through the chord and m (the normal of the segment's plane: that of
 * its straight line, else segmentPlane; null: the level plane's, else any
 * plane through the chord): on a wall round the part (a level plane), the vertical
 * plane of the segment (a rise or a dip of the line); on a face square to the
 * axis (a normal section), that face (a rounded corner). It bulges towards
 * +axis when m is within 60° of the axis, else away from the centre of the
 * body. Returns {radius, toward}.
 */
export function arcDefault(A, B, m, axis, bodyCentre = null) {
  const a = unit(axis) ?? [0, 0, 1];
  const pa = pt(A), pb = pt(B);
  const c = dist(pa, pb);
  const chord = unit(sub(pb, pa)) ?? [1, 0, 0];
  let k = m ? across(m, chord) : null;
  if (!k) {
    const level = sub(a, scale(chord, dot(a, chord)));
    k = norm(level) >= LEVEL_MIN ? unit(level) : across(Math.abs(chord[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], chord);
  }
  const M = scale(add(pa, pb), 0.5);
  if (Math.abs(dot(k, a)) > 0.5) {
    if (dot(k, a) > 0) k = neg(k);
  } else if (bodyCentre && dot(sub(bodyCentre, M), k) < 0) k = neg(k);
  return { radius: c, toward: k };
}

/**
 * The arc whose centre is placed at Cp (typed or clicked): Cp brought onto
 * the bisector plane of the chord (the centre at equal distances from A and
 * B), the plane of the arc turning about the chord to it. Returns {radius,
 * toward, moved (more than 0.01 mm from Cp), centre} or {error:
 * 'centre_invalid'} (not three numbers, or on the chord without a previous
 * toward).
 */
export function arcFromCentre(A, B, Cp, prevToward = null) {
  if (!Array.isArray(Cp) || Cp.length < 3 || !Cp.slice(0, 3).every(Number.isFinite)) return { error: "centre_invalid" };
  const a = pt(A), b = pt(B);
  const c = dist(a, b);
  if (!(c > 0)) return { error: "centre_invalid" };
  const chord = scale(sub(b, a), 1 / c);
  const M = scale(add(a, b), 0.5);
  const C = sub(Cp, scale(chord, dot(sub(Cp, M), chord)));
  const off = sub(C, M);
  const k = norm(off) > 1e-9 * c ? unit(off) : prevToward ? across(prevToward, chord) : null;
  if (!k) return { error: "centre_invalid" };
  return { radius: dist(C, a), toward: k, moved: dist(C, Cp) > 0.01, centre: C };
}

/**
 * A curved segment laid on the surface: the arc (arcGeometry) as a polygon
 * of K chords (one every 3° at most, 2 to 120), each draped on the surface
 * along w (the normal of the plane of the arc): chord j is walked in the
 * plane through it containing w, from where the previous one ended to where
 * the walk crosses the plane through its end containing w (square to the
 * arc there), exactly per triangle (inside one large CAD triangle too);
 * walked back too when forwards fails or ends further from the arc along w
 * (the drape is the nearer: a chord through the part near a corner goes
 * round the corner first). The last chord ends at B. Fails ('arc_off_surface') when a chord's walk is
 * longer than 4 times the chord plus two edges, meets a free edge or loops,
 * or goes further than half the chord plus two edges from the plane of the
 * arc (over a top face or round the back); 'radius_too_small' below c / 2.
 */
export function layArc(dm, A, B, { radius, toward }) {
  const geo = arcGeometry(A.p, B.p, { radius, toward });
  if (geo.error) return failedPath(A, B, "arc", geo.error === "radius_too_small" ? "radius_too_small" : "arc_off_surface");
  const { centre: C, radius: R, opening: theta, w, toward: k } = geo;
  const K = Math.min(ARC_MAX, Math.max(ARC_MIN, Math.ceil(theta / ARC_STEP - 1e-9)));
  const e1 = scale(sub(A.p, C), 1 / R);
  const e2 = theta >= Math.PI - 1e-9 ? neg(k) : across(sub(B.p, C), e1);
  const at = (j) => {
    if (j === 0) return A.p;
    if (j === K) return B.p;
    const phi = (j * theta) / K;
    return add(C, add(scale(e1, R * Math.cos(phi)), scale(e2, R * Math.sin(phi))));
  };
  const tangent = (j) => {
    const phi = (j * theta) / K;
    return add(scale(e1, -Math.sin(phi)), scale(e2, Math.cos(phi)));
  };
  const chord = dist(A.p, B.p);
  const sideLimit = 0.5 * chord + 2 * dm.edgeLen;
  const off = (x) => Math.abs(dot(sub(x, A.p), w)) > sideLimit;
  const fail = () => failedPath(A, B, "arc", "arc_off_surface");
  const tr = new Trace(A.p);
  let cur = { p: A.p, t: A.t };
  for (let j = 0; j < K; j++) {
    const P0 = at(j), P1 = at(j + 1);
    const dir = sub(P1, P0);
    const m = unit(cross(dir, w));
    if (!m) return fail();
    let pl = null, start = null;
    for (const mm of [m, neg(m)]) {
      pl = newPlane(dm, mm, P0);
      start = startOf(dm, pl, cur);
      if (start) break;
    }
    if (!start) return fail();
    if (start.f !== cur.t) tr.bridge(dm, cur.t, start.f, cur.p, cur.t);
    const last = j === K - 1;
    if (last && reaches(dm, pl, start.f, B)) {
      tr.arrive(dm, start.f, B);
      break;
    }
    const T = last ? null : tangent(j + 1);
    const limit = 4 * norm(dir) + 2 * dm.edgeLen;
    const along = dot(sub(start.x0, start.x1), dir);
    // The slice walked from the start, forwards (along the chord) or back,
    // up to the joint (or B): its pieces and where it ends, or null.
    const walk = (forward) => {
      const piece = new Trace(cur.p);
      let f = start.f;
      let e = (along >= 0) === forward ? start.e0 : start.e1;
      let walked = 0;
      let p = cur.p;
      for (;;) {
        const h = 3 * f + e;
        const x = crossingOn(dm, pl, f, e);
        if (T) {
          // The joint: where the walk crosses the plane through P1 square to the arc (a tie is not yet across).
          const J1 = dot(T, sub(x, P1));
          if (J1 > 0) {
            const J0 = dot(T, sub(p, P1));
            const t = J0 < 0 ? J0 / (J0 - J1) : 0;
            const q = add(p, scale(sub(x, p), t));
            if (off(q)) return null;
            piece.push(f, q);
            return { piece, end: { p: q, t: f } };
          }
        }
        const g = dm.N[h];
        const ke = g >= 0 ? entryEdge(dm, h, g) : -1;
        piece.push(f, x, h, ke >= 0 ? 3 * g + ke : -1);
        walked += dist(p, x);
        if (walked > limit || off(x) || g < 0 || ke < 0) return null;
        if (last && reaches(dm, pl, g, B)) {
          piece.arrive(dm, g, B);
          return { piece, end: B };
        }
        if (g === start.f) return null;
        const other = crossedEdges(dm, pl, g) & ~(1 << ke);
        if (!other) return null;
        f = g;
        e = other & 1 ? 0 : other & 2 ? 1 : 2;
        p = x;
      }
    };
    // Both ends of a walk lie on the line through P1 along w: the drape of P1
    // is the nearer one. Forwards first; back when that fails or ends further
    // (a chord through the part near a corner: its drape goes round the
    // corner first, against the chord's direction).
    const along_w = (d) => Math.abs(dot(sub(d.end.p, P1), w));
    const ahead = walk(true);
    let done = ahead;
    if (!ahead || (T && along_w(ahead) > NEAR_TAU * dm.tau)) {
      const back = walk(false);
      if (back && (!ahead || along_w(back) < along_w(ahead) - dm.tau)) done = back;
    }
    if (!done) return fail();
    tr.append(done.piece);
    if (last) break;
    cur = done.end;
  }
  return tr.path("arc");
}

// ------------------------------------------------------------------ halves

/** The most common of the values >= 0 (the lowest among equals), or -1. */
function majority(roots) {
  let best = -1, bestCount = 0;
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    if (r < 0) continue;
    let n = 0;
    for (let j = 0; j < roots.length; j++) if (roots[j] === r) n++;
    if (n > bestCount || (n === bestCount && r < best)) {
      best = r;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The pieces of a loop as chains: consecutive pieces in one triangle merged
 * (entry -> clicked points or arc joints -> exit), the last one joined to
 * the first round the loop. Each {f, pts (xyz of its points), in, out (the
 * half-edges of f entered and left, -1 inside), refs ([path, piece] of its
 * pieces)}.
 */
function loopChains(paths) {
  const chains = [];
  let open = null;
  paths.forEach((path, K) => {
    if (!path) return;
    const { xyz, tri, cross, twin } = path;
    for (let j = 0; j < tri.length; j++) {
      const f = tri[j];
      const q = [xyz[3 * j + 3], xyz[3 * j + 4], xyz[3 * j + 5]];
      if (open && open.f === f) {
        open.pts.push(q);
        open.refs.push([K, j]);
      } else {
        open = { f, pts: [[xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]], q], in: cross[j] >= 0 ? twin[j] : -1, out: -1, refs: [[K, j]] };
        chains.push(open);
      }
      open.out = cross[j + 1] >= 0 ? cross[j + 1] : -1;
    }
  });
  if (chains.length > 1 && chains[0].f === chains.at(-1).f) {
    const last = chains.pop(), first = chains[0];
    chains[0] = { f: first.f, pts: [...last.pts, ...first.pts.slice(1)], in: last.in, out: first.out, refs: [...last.refs, ...first.refs] };
  }
  return chains;
}

/**
 * The two sides of a chain crossing triangle f from edge ein to edge eout:
 * the corners on each side (polygon 1: the chain, then the boundary forward
 * from the exit to the entry; polygon 2: the rest of the triangle) and the
 * area of polygon 1 (shoelace, dotted with the triangle's normal).
 */
function chainSides(dm, f, ch, ein, eout) {
  const V = cornersOf(dm, f);
  const o = V[0];
  const nw = unit(cross(sub(V[1], o), sub(V[2], o)));
  if (!nw) return null;
  let first;
  if (ein === eout) {
    const ev = sub(V[(ein + 1) % 3], V[ein]);
    const tin = dot(sub(ch.pts[0], V[ein]), ev), tout = dot(sub(ch.pts.at(-1), V[ein]), ev);
    first = tout < tin ? [] : [(ein + 1) % 3, (ein + 2) % 3, ein];
  } else {
    first = [];
    for (let k = (eout + 1) % 3; ; k = (k + 1) % 3) {
      first.push(k);
      if (k === ein) break;
    }
  }
  const poly = [...ch.pts, ...first.map((k) => V[k])].map((p) => sub(p, o));
  let s = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) s = add(s, cross(poly[i], poly[(i + 1) % poly.length]));
  const second = [0, 1, 2].filter((k) => !first.includes(k));
  return { first, second, area: dot(s, nw) / 2 };
}

/**
 * The surface split by the closed loops of the drawing into regions.
 *
 * Each crossing of an edge by loop L flips bit L of that edge (both of its
 * half-edges): an edge crossed twice by one loop is no barrier, an edge
 * crossed once by two loops still is. The vertices of lines laid along the
 * edges are line vertices. The welded vertices are joined (union-find)
 * across every edge but the barriers, those at a line vertex, and, with
 * excludeCore, those between two core triangles (formed by neither half:
 * cored passages no longer join the two skins).
 *
 * A triangle takes the region of its vertices off the line (the majority,
 * then the lowest); one the line crosses (a seam triangle) the region of the
 * larger of its two pieces (a line exactly through vertices leaves one
 * piece of no area: the triangle goes to the side of its real area); one
 * without any the most common region round it; core triangles none (-1).
 * Regions of fewer than 3 triangles and less than 1e-4 of the surface are
 * dissolved in their neighbours. Regions are numbered by their first
 * triangle.
 *
 * loops -- Path[][]: the paths of each closed loop, in order
 * flags -- per triangle (REACH_*), or null
 * axis -- the draw direction, for the mean height of each region
 * Returns {label (Int32Array per triangle), count, regions [{area, height,
 * noUp, noDown, first, triangles}], errors [{code: 'not_separating' |
 * 'loop_not_separating' (loop) | 'too_small' (loop)}], separates (per
 * loop), seamArea, totalArea, coreExcluded, flagsKnown, pieceRegions (per
 * loop, per path: Int32Array of the regions on either side of each piece,
 * -1 unknown)}.
 */
export function splitRegions(dm, loops, { flags = null, excludeCore = false, axis = [0, 0, 1] } = {}) {
  const { nt, nvW, W, N, Q, areas } = dm;
  const a = unit(axis) ?? [0, 0, 1];
  const barrier = new Uint32Array(3 * nt);
  const line = new Uint8Array(nvW);
  loops.forEach((paths, L) => {
    const bit = (1 << L) >>> 0;
    for (const path of paths) {
      if (!path) continue;
      const { cross: cr, twin } = path;
      for (let j = 0; j < cr.length; j++) {
        if (cr[j] < 0 || twin[j] < 0) continue;
        barrier[cr[j]] ^= bit;
        barrier[twin[j]] ^= bit;
      }
      if (path.verts) for (const v of path.verts) line[v] = 1;
    }
  });
  const core = excludeCore && flags ? (f) => !(flags[f] & (REACH_UP | REACH_DOWN)) : null;

  // Union-find over the welded vertices (path halving, the smaller root wins).
  const parent = new Int32Array(nvW);
  for (let i = 0; i < nvW; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const g = N[3 * f + e];
      if (g >= 0 && g < f) continue;
      if (barrier[3 * f + e]) continue;
      const wa = W[3 * f + e], wb = W[3 * f + ((e + 1) % 3)];
      if (wa === wb || line[wa] || line[wb]) continue;
      if (core && core(f) && (g < 0 || core(g))) continue;
      const ra = find(wa), rb = find(wb);
      if (ra !== rb) {
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
      }
    }
  }
  const root = new Int32Array(nvW);
  for (let i = 0; i < nvW; i++) root[i] = find(i);
  const rootOf = (w) => (line[w] ? -1 : root[w]);

  // Seam triangles: the chains of each loop.
  const chainsOf = new Map();
  const seam = new Uint8Array(nt);
  const allChains = loops.map((paths) => loopChains(paths));
  for (const chains of allChains) {
    for (const ch of chains) {
      seam[ch.f] = 1;
      const list = chainsOf.get(ch.f);
      if (list) list.push(ch);
      else chainsOf.set(ch.f, [ch]);
    }
  }
  const sameXYZ = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  const sidesOf = (ch) => {
    const f = ch.f;
    if (ch.in < 0 || ch.out < 0 || sameXYZ(ch.pts[0], ch.pts.at(-1))) return null;
    return chainSides(dm, f, ch, ch.in - 3 * f, ch.out - 3 * f);
  };
  let seamArea = 0;
  const label = new Int32Array(nt);
  const UNSET = -2;
  let unset = 0;
  const r3 = [0, 0, 0];
  for (let f = 0; f < nt; f++) {
    if (core && core(f)) {
      label[f] = -1;
      continue;
    }
    const r0 = rootOf(W[3 * f]), r1 = rootOf(W[3 * f + 1]), r2 = rootOf(W[3 * f + 2]);
    if (!seam[f] && r0 >= 0 && r0 === r1 && r1 === r2) {
      label[f] = r0;
      continue;
    }
    r3[0] = r0;
    r3[1] = r1;
    r3[2] = r2;
    let r = -1;
    const chains = seam[f] ? chainsOf.get(f) : null;
    if (chains) {
      if (chains.some((ch) => ch.pts.some((p) => !sameXYZ(p, ch.pts[0])))) seamArea += areas[f];
      if (chains.length === 1) {
        const s = sidesOf(chains[0]);
        if (s) {
          const larger = s.area > areas[f] - s.area ? s.first : s.area < areas[f] - s.area ? s.second : null;
          if (larger?.length) r = majority(larger.map((k) => r3[k]));
        }
      }
    }
    if (r < 0) r = majority(r3);
    label[f] = r >= 0 ? r : UNSET;
    if (r < 0) unset++;
  }
  // Triangles with nothing usable: the most common label round them, three passes.
  for (let pass = 0; pass < 3 && unset; pass++) {
    let changed = false;
    for (let f = 0; f < nt; f++) {
      if (label[f] !== UNSET) continue;
      const near = [0, 1, 2].map((e) => {
        const g = N[3 * f + e];
        return g >= 0 && label[g] >= 0 ? label[g] : -1;
      });
      const r = majority(near);
      if (r >= 0) {
        label[f] = r;
        changed = true;
        unset--;
      }
    }
    if (!changed) break;
  }
  if (unset) for (let f = 0; f < nt; f++) if (label[f] === UNSET) label[f] = -1;

  // Regions: the roots labelling a triangle, numbered by their first triangle.
  const rootRegion = new Int32Array(nvW).fill(-1);
  let count = 0;
  for (let f = 0; f < nt; f++) {
    const r = label[f];
    if (r < 0) continue;
    if (rootRegion[r] < 0) rootRegion[r] = count++;
    label[f] = rootRegion[r];
  }
  // Small regions dissolved in their neighbours.
  const triangles = new Int32Array(count), area = new Float64Array(count);
  for (let f = 0; f < nt; f++) {
    if (label[f] < 0) continue;
    triangles[label[f]]++;
    area[label[f]] += areas[f];
  }
  const small = Uint8Array.from({ length: count }, (_, i) => (triangles[i] < SMALL_TRIANGLES && area[i] < SMALL_SHARE * dm.totalArea ? 1 : 0));
  if (count > 1 && small.some((s) => s) && !small.every((s) => s)) {
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      for (let f = 0; f < nt; f++) {
        const r = label[f];
        if (r < 0 || !small[r]) continue;
        const near = [0, 1, 2].map((e) => {
          const g = N[3 * f + e];
          return g >= 0 && label[g] >= 0 && !small[label[g]] ? label[g] : -1;
        });
        const m = majority(near);
        if (m >= 0) {
          label[f] = m;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  // Numbered again by their first triangle.
  const renumber = new Int32Array(count).fill(-1);
  let kept = 0;
  for (let f = 0; f < nt; f++) {
    const r = label[f];
    if (r < 0) continue;
    if (renumber[r] < 0) renumber[r] = kept++;
    label[f] = renumber[r];
  }
  // The region of each root (a dissolved one: none yet, see below).
  for (let w = 0; w < nvW; w++) {
    const r = rootRegion[w];
    if (r >= 0) rootRegion[w] = renumber[r];
  }
  count = kept;
  const rArea = new Float64Array(count), rHeight = new Float64Array(count), rNoUp = new Float64Array(count), rNoDown = new Float64Array(count);
  const rFirst = new Int32Array(count).fill(-1), rTriangles = new Int32Array(count);
  for (let f = 0; f < nt; f++) {
    const r = label[f];
    if (r < 0) continue;
    const A = areas[f];
    if (rFirst[r] < 0) rFirst[r] = f;
    rTriangles[r]++;
    rArea[r] += A;
    const i = 3 * W[3 * f], j = 3 * W[3 * f + 1], k = 3 * W[3 * f + 2];
    rHeight[r] += A * (a[0] * (Q[i] + Q[j] + Q[k]) + a[1] * (Q[i + 1] + Q[j + 1] + Q[k + 1]) + a[2] * (Q[i + 2] + Q[j + 2] + Q[k + 2])) / 3;
    if (flags) {
      if (!(flags[f] & REACH_UP)) rNoUp[r] += A;
      if (!(flags[f] & REACH_DOWN)) rNoDown[r] += A;
    }
  }
  const regions = Array.from({ length: count }, (_, r) => ({
    area: rArea[r], height: rArea[r] > 0 ? rHeight[r] / rArea[r] : 0, noUp: rNoUp[r], noDown: rNoDown[r], first: rFirst[r], triangles: rTriangles[r],
  }));
  // The region of a vertex off the line: that of its root; for a root
  // labelling no triangle (dissolved, or outvoted round a seam), that of the
  // first labelled triangle round the vertex.
  const regionOf = (w) => {
    if (line[w]) return -1;
    const r = rootRegion[root[w]];
    if (r >= 0) return r;
    const { start, list } = starsOf(dm);
    for (let s = start[w]; s < start[w + 1]; s++) if (label[list[s]] >= 0) return label[list[s]];
    return -1;
  };

  // The regions on either side of each piece: those of the ends of the edge
  // its chain crosses into or out of its triangle, an edge the loop leaves a
  // barrier (a chain going back out by the edge it came in by, round a
  // clicked point, crosses no barrier: unknown, -1); along the edges, those
  // of the third corners of the two triangles of the edge.
  const edgeSides = (u, v) => {
    const { start, list } = starsOf(dm);
    const out = [];
    for (let s = start[u]; s < start[u + 1] && out.length < 2; s++) {
      const f = list[s];
      let has = false, third = -1;
      for (let k = 0; k < 3; k++) {
        const x = W[3 * f + k];
        if (x === v) has = true;
        else if (x !== u) third = x;
      }
      if (has && third >= 0) out.push(regionOf(third));
    }
    return out.length === 2 ? out : [-1, -1];
  };
  const halfEdgeSides = (h) => {
    const f = (h / 3) | 0, e = h - 3 * f;
    return [regionOf(W[h]), regionOf(W[3 * f + ((e + 1) % 3)])];
  };
  const pieceRegions = loops.map((paths, L) => {
    const out = paths.map((path) => (path ? new Int32Array(2 * path.tri.length).fill(-1) : null));
    const bit = (1 << L) >>> 0;
    for (const ch of allChains[L]) {
      const h = ch.in >= 0 && barrier[ch.in] & bit ? ch.in : ch.out >= 0 && barrier[ch.out] & bit ? ch.out : -1;
      if (h < 0) continue;
      const [r1, r2] = halfEdgeSides(h);
      for (const [K, j] of ch.refs) {
        out[K][2 * j] = r1;
        out[K][2 * j + 1] = r2;
      }
    }
    paths.forEach((path, K) => {
      if (!path?.verts) return;
      for (let j = 1; j < path.verts.length; j++) {
        const [r1, r2] = edgeSides(path.verts[j - 1], path.verts[j]);
        out[K][2 * j] = r1;
        out[K][2 * j + 1] = r2;
      }
    });
    return out;
  });

  // Each loop must separate two regions somewhere.
  const errors = [];
  const separates = loops.map((paths, L) => {
    let crossed = false, apart = false;
    pieceRegions[L].forEach((pr, K) => {
      const path = paths[K];
      if (!path) return;
      const bit = (1 << L) >>> 0;
      for (let j = 0; j < path.cross.length; j++) if (path.cross[j] >= 0 && barrier[path.cross[j]] & bit) crossed = true;
      if (path.verts?.length) crossed = true;
      for (let j = 0; j < pr.length; j += 2) if (pr[j] >= 0 && pr[j + 1] >= 0 && pr[j] !== pr[j + 1]) apart = true;
    });
    if (!crossed) errors.push({ code: "too_small", loop: L });
    return crossed && apart;
  });
  if (count < 2) errors.unshift({ code: "not_separating" });
  else separates.forEach((s, L) => {
    if (!s && !errors.some((e) => e.loop === L)) errors.push({ code: "loop_not_separating", loop: L });
  });
  return { label, count, regions, errors, separates, seamArea, totalArea: dm.totalArea, coreExcluded: !!core, flagsKnown: !!flags, pieceRegions, axis: a };
}

const flip = (s) => (s === SIDE_UPPER ? SIDE_LOWER : s === SIDE_LOWER ? SIDE_UPPER : s);

/**
 * The chapes proposed for the regions of a split. Two regions: the pair
 * (upper, lower) leaving the least surface that its chape cannot form
 * (noUp of the upper one + noDown of the lower one); on a tie, the higher
 * one upper (then region 0). More: each upper when less of it lacks REACH_UP
 * than REACH_DOWN, lower in the other case, on a tie by its height against
 * the mean height of the line (lineHeight). Without flags: by height.
 * Returns Uint8Array(count) of SIDE_UPPER / SIDE_LOWER.
 */
export function proposeSides(split, { lineHeight = null } = {}) {
  const { count, regions, totalArea, flagsKnown } = split;
  const out = new Uint8Array(count);
  if (!count) return out;
  if (count === 1) {
    out[0] = SIDE_UPPER;
    return out;
  }
  const tie = 1e-6 * (totalArea || 1);
  if (count === 2) {
    const [r0, r1] = regions;
    let upper0 = null;
    if (flagsKnown) {
      const c0 = r0.noUp + r1.noDown, c1 = r1.noUp + r0.noDown;
      if (Math.abs(c0 - c1) > tie) upper0 = c0 < c1;
    }
    upper0 ??= r0.height >= r1.height;
    out[0] = upper0 ? SIDE_UPPER : SIDE_LOWER;
    out[1] = flip(out[0]);
    return out;
  }
  let h = lineHeight;
  if (h == null) {
    let s = 0, w = 0;
    for (const r of regions) {
      s += r.height * r.area;
      w += r.area;
    }
    h = w > 0 ? s / w : 0;
  }
  regions.forEach((r, i) => {
    if (flagsKnown && Math.abs(r.noUp - r.noDown) > tie) out[i] = r.noUp < r.noDown ? SIDE_UPPER : SIDE_LOWER;
    else out[i] = r.height >= h ? SIDE_UPPER : SIDE_LOWER;
  });
  return out;
}

/**
 * The chapes of the regions with the user's choices: seeds [{t (a triangle
 * clicked), side}] in order (the last one wins in a region); with two
 * regions, one region chosen gives the other the other chape (unless it is
 * chosen too); swap flips the proposal of the regions not chosen.
 */
export function regionSides(split, proposal, seeds = [], swap = false) {
  const { count, label } = split;
  const out = Uint8Array.from(proposal);
  if (swap) for (let i = 0; i < count; i++) out[i] = flip(out[i]);
  const chosen = new Uint8Array(count);
  for (const s of seeds ?? []) {
    const r = Number.isInteger(s?.t) && s.t >= 0 && s.t < label.length ? label[s.t] : -1;
    if (r >= 0 && r < count && (s.side === SIDE_UPPER || s.side === SIDE_LOWER)) chosen[r] = s.side;
  }
  for (let i = 0; i < count; i++) if (chosen[i]) out[i] = chosen[i];
  if (count === 2) {
    for (let i = 0; i < 2; i++) if (chosen[i] && !chosen[1 - i]) out[1 - i] = flip(chosen[i]);
  }
  return out;
}

// ------------------------------------------------------------------ names, crossings

const pointCount = (loop) => (typeof loop === "number" ? loop : Array.isArray(loop) ? loop.length : (loop?.points ?? loop?.pts ?? []).length);

/**
 * The name of segment K of loop L: its points numbered on from one loop to
 * the next ('1-2' … 'n-1', then '7-8' … '10-7'). loops: the drawing's loops
 * ({points}), a loop's paths (a closed loop: one per point) or point counts.
 */
export function segmentName(loops, L, K) {
  let base = 0;
  for (let i = 0; i < L; i++) base += pointCount(loops[i]);
  const n = pointCount(loops[L]);
  return `${base + K + 1}-${base + ((K + 1) % Math.max(1, n)) + 1}`;
}

/**
 * Where the line crosses itself: two pieces of different segments in one
 * triangle that cross (in the plane of the triangle). The point shared by
 * two segments one after the other does not count. loops: Path[][] (closed
 * loops). Returns [{a, b}] (segment names), each pair once.
 */
export function crossings(dm, loops) {
  const byTri = new Map();
  const sizes = loops.map((paths) => paths.length);
  loops.forEach((paths, L) => {
    paths.forEach((path, K) => {
      if (!path || path.status !== "ok") return;
      const { xyz, tri } = path;
      for (let j = 0; j < tri.length; j++) {
        const p = [xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]], q = [xyz[3 * j + 3], xyz[3 * j + 4], xyz[3 * j + 5]];
        if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue;
        const list = byTri.get(tri[j]);
        const item = { L, K, p, q };
        if (list) list.push(item);
        else byTri.set(tri[j], [item]);
      }
    });
  });
  const found = new Map();
  const eps = dm.tau;
  for (const [f, list] of byTri) {
    if (list.length < 2) continue;
    const V = cornersOf(dm, f);
    const u = unit(sub(V[1], V[0]));
    const n = unit(cross(sub(V[1], V[0]), sub(V[2], V[0])));
    if (!u || !n) continue;
    const v = cross(n, u);
    const flat = (x) => [dot(sub(x, V[0]), u), dot(sub(x, V[0]), v)];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i], t = list[j];
        if (s.L === t.L && s.K === t.K) continue;
        const [p, q, r, w] = [flat(s.p), flat(s.q), flat(t.p), flat(t.q)];
        const d = [q[0] - p[0], q[1] - p[1]], e = [w[0] - r[0], w[1] - r[1]];
        const den = d[0] * e[1] - d[1] * e[0];
        if (!(Math.abs(den) > 1e-12 * Math.hypot(...d) * Math.hypot(...e))) continue;
        const rp = [r[0] - p[0], r[1] - p[1]];
        const ts = (rp[0] * e[1] - rp[1] * e[0]) / den, tt = (rp[0] * d[1] - rp[1] * d[0]) / den;
        const ls = Math.hypot(...d), lt = Math.hypot(...e);
        if (ts * ls < -eps || (ts - 1) * ls > eps || tt * lt < -eps || (tt - 1) * lt > eps) continue;
        // At the point shared by two segments one after the other: no crossing.
        const x = add(s.p, scale(sub(s.q, s.p), Math.min(1, Math.max(0, ts))));
        if (s.L === t.L) {
          const n = sizes[s.L];
          const [k1, k2] = s.K < t.K ? [s.K, t.K] : [t.K, s.K];
          const shared = [];
          if (k2 === k1 + 1) shared.push(k2);
          if (k1 === 0 && k2 === n - 1) shared.push(0);
          const paths = loops[s.L];
          if (shared.some((k) => paths[k] && dist(x, [paths[k].xyz[0], paths[k].xyz[1], paths[k].xyz[2]]) <= 10 * eps)) continue;
        }
        const [first, second] = s.L < t.L || (s.L === t.L && s.K < t.K) ? [s, t] : [t, s];
        const key = `${first.L}:${first.K}|${second.L}:${second.K}`;
        if (!found.has(key)) found.set(key, { a: segmentName(sizes, first.L, first.K), b: segmentName(sizes, second.L, second.K), order: [first.L, first.K, second.L, second.K] });
      }
    }
  }
  return [...found.values()]
    .sort((x, y) => x.order.reduce((acc, v, i) => acc || v - y.order[i], 0))
    .map(({ a, b }) => ({ a, b }));
}

// ------------------------------------------------------------------ alignment

/**
 * Points of a loop moved to one height h along the axis (hand-placed points
 * are never exactly level): for each, among the triangles round it (within
 * 5 % of the diagonal, 4096 at most) that straddle that height, the closest
 * point of their slice at h (the lowest triangle among equals). Returns
 * {points (SurfacePoints, at h exactly), missed (indices of the points with
 * no surface at that height near them, left where they were)}.
 */
export function alignPoints(dm, points, axis, h) {
  const a = unit(axis) ?? [0, 0, 1];
  const reach = ALIGN_REACH * dm.diag;
  const missed = [];
  const out = points.map((sp, i) => {
    const pl = newPlane(dm, a, scale(a, h));
    const seen = new Set([sp.t]);
    const queue = [sp.t];
    let best = null, bestD = Infinity, bestF = -1;
    for (let head = 0; head < queue.length; head++) {
      const f = queue[head];
      const c = chordOf(dm, pl, f);
      if (c) {
        const ab = sub(c.x1, c.x0);
        const l2 = dot(ab, ab);
        const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(sp.p, c.x0), ab) / l2)) : 0;
        const x = t === 0 ? c.x0 : t === 1 ? c.x1 : add(c.x0, scale(ab, t));
        const d = dist(x, sp.p);
        if (d < bestD || (d === bestD && f < bestF)) {
          best = x;
          bestD = d;
          bestF = f;
        }
      }
      for (let e = 0; e < 3 && seen.size < ALIGN_TRIANGLES; e++) {
        const g = dm.N[3 * f + e];
        if (g < 0 || seen.has(g)) continue;
        seen.add(g);
        const [A, B, C] = cornersOf(dm, g);
        if (dist(closestOnTriangle(sp.p, A, B, C), sp.p) <= reach) queue.push(g);
      }
    }
    if (!best) {
      missed.push(i);
      return sp;
    }
    // At h exactly: the point of the slice itself, its barycentrics only kept inside the triangle.
    return { ...surfacePoint(dm, bestF, best), p: best };
  });
  return { points: out, missed };
}

// ------------------------------------------------------------------ the drawing as a whole

/** Messages of a drawing: their code, their level, the key of their text (web/i18n.js) and its values. */
const message = (code, level, hint, values = {}) => ({ code, level, hint, ...values });

/**
 * The parting of a drawing: its segments laid (those not laid yet), the
 * surface split by its loops (again with the core triangles left out when
 * the loops do not separate it and the flags are known), the chapes of the
 * regions (proposed, then the user's choices), the side and undercut of each
 * triangle, and the line: its pieces between regions of different chapes
 * (active), the others apart (inactive), its shape (lineShape).
 *
 * drawing -- {loops: [{points (SurfacePoints), segs (SegSpecs), paths
 *   (Paths laid, optional), closed}], seeds [{p, t, side}], swap}
 * axis -- the draw direction (the rotation axis)
 * flags -- per triangle for that direction (REACH_*), or null
 * height -- of the mould along the axis (planarity tolerance)
 * bodyCentre -- the centre of the body, for the side of an arc not given
 *   its radius or centre yet (arcDefault)
 * prefer -- the camera position, for the segments not laid yet
 * Returns {ok, paths, split, regionSide, side (Uint8Array per triangle),
 * undercut (Uint8Array per triangle), segments (Float32Array, xyz of both
 * ends of each active piece, none of no length), inactive (likewise),
 * shape, figures {undercut_area_mm2, undercut_share, seam_area_mm2, parts,
 * upper_parts, lower_parts, core_excluded}, messages [{code, level ('error'
 * | 'warning'), hint, ...}]}. Not ok (side and line null) while a loop is
 * open, a segment is not laid, or the loops do not separate the surface.
 */
export function drawnParting(dm, drawing, { axis = [0, 0, 1], flags = null, height = null, bodyCentre = null, prefer = null } = {}) {
  const a = unit(axis) ?? [0, 0, 1];
  const loops = drawing?.loops ?? [];
  const messages = [];
  const sizes = loops.map((l) => l.points.length);
  // An arc without its radius or its side yet: the default one (60°, in the plane of the segment).
  const arcSpec = (spec, A, B) => {
    if (spec.radius > 0 && spec.toward) return spec;
    const d = arcDefault(A, B, spec.m ?? segmentPlane(dm, A, B, a), a, bodyCentre);
    return { radius: spec.radius > 0 ? spec.radius : d.radius, toward: spec.toward ?? d.toward };
  };
  const paths = loops.map((loop) => {
    const n = loop.points.length;
    const count = loop.closed ? n : Math.max(0, n - 1);
    return Array.from({ length: count }, (_, K) => {
      const laid = loop.paths?.[K];
      if (laid) return laid;
      const A = loop.points[K], B = loop.points[(K + 1) % n];
      const spec = loop.segs?.[K] ?? { kind: "straight", via: 1, m: null };
      return spec.kind === "arc" ? layArc(dm, A, B, arcSpec(spec, A, B)) : layStraight(dm, A, B, { axis: a, spec, prefer });
    });
  });
  loops.forEach((loop, L) => {
    if (!loop.closed || loop.points.length < 3) messages.push(message("open", "error", "parting.draw.min3", { loop: L + 1 }));
    paths[L].forEach((path, K) => {
      const seg = segmentName(sizes, L, K);
      if (path.status !== "ok") {
        const hint = path.error === "radius_too_small" ? "parting.draw.radiusSmall" : path.error === "arc_off_surface" ? "parting.draw.arcOff" : "parting.draw.failed";
        messages.push(message(path.error ?? "failed", "error", hint, { seg }));
      } else if (path.method === "edges") messages.push(message("edges", "warning", "parting.draw.edges.msg", { seg }));
    });
  });
  const empty = { ok: false, paths, split: null, regionSide: null, side: null, undercut: null, segments: null, inactive: null, shape: null, figures: null, messages };
  if (!loops.length || messages.some((m) => m.level === "error")) return empty;

  let split = splitRegions(dm, paths, { flags, axis: a });
  const separation = (s) => s.errors.some((e) => e.code === "not_separating" || e.code === "loop_not_separating");
  if (separation(split) && flags) {
    const without = splitRegions(dm, paths, { flags, excludeCore: true, axis: a });
    if (!separation(without) && !without.errors.length) {
      split = without;
      messages.push(message("core_excluded", "warning", "parting.draw.coreExcluded"));
    }
  }
  if (split.errors.length) {
    for (const e of split.errors) {
      if (e.code === "not_separating") messages.push(message(e.code, "error", "parting.draw.notSeparating"));
      else if (e.code === "loop_not_separating") messages.push(message(e.code, "error", "parting.draw.loopNotSeparating", { n: e.loop + 1 }));
      else messages.push(message(e.code, "error", "parting.draw.loopNotSeparating", { n: e.loop + 1 }));
    }
    return { ...empty, split };
  }

  // The mean height of the line along the axis, by length.
  let hSum = 0, lSum = 0;
  for (const loop of paths) {
    for (const path of loop) {
      const x = path.xyz;
      for (let j = 0; j + 5 < x.length; j += 3) {
        const l = Math.hypot(x[j + 3] - x[j], x[j + 4] - x[j + 1], x[j + 5] - x[j + 2]);
        hSum += (l * (a[0] * (x[j] + x[j + 3]) + a[1] * (x[j + 1] + x[j + 4]) + a[2] * (x[j + 2] + x[j + 5]))) / 2;
        lSum += l;
      }
    }
  }
  const proposal = proposeSides(split, { lineHeight: lSum > 0 ? hSum / lSum : null });
  const regionSide = regionSides(split, proposal, drawing.seeds, drawing.swap);
  const { nt, areas } = dm;
  const side = new Uint8Array(nt), undercut = new Uint8Array(nt);
  let undercutArea = 0;
  for (let f = 0; f < nt; f++) {
    const r = split.label[f];
    const s = r < 0 ? SIDE_NONE : regionSide[r];
    side[f] = s;
    const fl = flags ? flags[f] : REACH_UP | REACH_DOWN;
    if (s === SIDE_NONE || (s === SIDE_UPPER && !(fl & REACH_UP)) || (s === SIDE_LOWER && !(fl & REACH_DOWN))) {
      undercut[f] = 1;
      undercutArea += areas[f];
    }
  }

  // The line: the pieces between regions of different chapes (or unknown). A
  // line along the edges has no barrier of its own: the corners beside it
  // tell its sides, wrongly within a triangle of a sharp turn of the line;
  // such a segment is on the line or off it as most of its length is.
  const active = [], inactive = [];
  let activeLoops = 0;
  const zero = (x, j) => x[3 * j] === x[3 * j + 3] && x[3 * j + 1] === x[3 * j + 4] && x[3 * j + 2] === x[3 * j + 5];
  const pieceLength = (x, j) => Math.hypot(x[3 * j + 3] - x[3 * j], x[3 * j + 4] - x[3 * j + 1], x[3 * j + 5] - x[3 * j + 2]);
  paths.forEach((loop, L) => {
    let any = false;
    loop.forEach((path, K) => {
      const pr = split.pieceRegions[L][K];
      const x = path.xyz;
      let apart = 0, together = 0;
      if (path.method === "edges") {
        for (let j = 0; j < path.tri.length; j++) {
          const r1 = pr[2 * j], r2 = pr[2 * j + 1];
          if (r1 >= 0 && r2 >= 0) {
            if (regionSide[r1] !== regionSide[r2]) apart += pieceLength(x, j);
            else together += pieceLength(x, j);
          }
        }
      }
      for (let j = 0; j < path.tri.length; j++) {
        if (zero(x, j)) continue;
        const r1 = pr[2 * j], r2 = pr[2 * j + 1];
        const on = r1 < 0 || r2 < 0 || (path.method === "edges" ? apart >= together : regionSide[r1] !== regionSide[r2]);
        (on ? active : inactive).push(x[3 * j], x[3 * j + 1], x[3 * j + 2], x[3 * j + 3], x[3 * j + 4], x[3 * j + 5]);
        if (on) any = true;
      }
    });
    if (any) activeLoops++;
    else messages.push(message("same_side", "warning", "parting.draw.sameSide", { n: L + 1 }));
  });
  const pieces = Float64Array.from(active);
  const shape = lineShape(pieces, a, { height, loops: activeLoops });
  for (const { a: s1, b: s2 } of crossings(dm, paths)) messages.push(message("self_cross", "warning", "parting.draw.selfCross", { a: s1, b: s2 }));
  const upper = regionSide.filter((s) => s === SIDE_UPPER).length;
  if (split.count > 2) messages.push(message("regions", "warning", "parting.draw.regions", { count: split.count }));
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    ok: true,
    paths,
    split,
    regionSide,
    side,
    undercut,
    segments: Float32Array.from(pieces),
    inactive: Float32Array.from(inactive),
    shape,
    figures: {
      undercut_area_mm2: round(undercutArea, 1),
      undercut_share: round(undercutArea / (dm.totalArea || 1), 4),
      seam_area_mm2: round(split.seamArea, 1),
      parts: split.count,
      upper_parts: upper,
      lower_parts: split.count - upper,
      core_excluded: split.coreExcluded,
    },
    messages,
  };
}

// ------------------------------------------------------------------ view helpers

/**
 * The sense of the part's turn for the left arrow, about axis a seen with
 * the camera basis {up, toViewer, right}: an axis upright on screen (|a·up|
 * >= 0.3): the front goes left; else counter-clockwise on screen; else by
 * the right of the screen; else +1. The right arrow turns the other way.
 * A turn about a keeps a·up and a·toViewer: the arrows never swap meaning.
 */
export function turnSign(axis, { up, toViewer, right }) {
  const au = dot(axis, up);
  if (Math.abs(au) >= 0.3) return au > 0 ? -1 : 1;
  const av = dot(axis, toViewer);
  if (Math.abs(av) > 1e-9) return av > 0 ? 1 : -1;
  const ar = dot(axis, right);
  if (Math.abs(ar) > 1e-9) return ar > 0 ? 1 : -1;
  return 1;
}

/** Point v turned by angle (radians) about the line through centre along axis (Rodrigues). */
export function rotateAbout(v, centre, axis, angle) {
  const k = unit(axis);
  if (!k) return [v[0], v[1], v[2]];
  const p = sub(v, centre);
  const c = Math.cos(angle), s = Math.sin(angle);
  const kp = cross(k, p);
  const along = dot(k, p) * (1 - c);
  return [0, 1, 2].map((i) => centre[i] + p[i] * c + kp[i] * s + k[i] * along);
}

// ------------------------------------------------------------------ saving

const round4 = (x) => Math.round(x * 1e4) / 1e4 + 0;
const round6 = (x) => Math.round(x * 1e6) / 1e6 + 0;

/**
 * A drawing as saved with the part (about 60 bytes a point): {v: 1, nt,
 * plane, axis, loops: [{closed, pts: [[x, y, z, t]], segs: [['s', via, mx,
 * my, mz] | ['s', via] (not laid yet) | ['a', R, kx, ky, kz] | ['e'] (along
 * the edges)]}], seeds: [[x, y, z, t, side]], swap}; coordinates to 1e-4
 * mm, vectors to 1e-6.
 */
export function serializeDrawing(drawing, nt) {
  return {
    v: DRAW_VERSION,
    nt,
    plane: drawing.plane ?? "Z",
    axis: (drawing.axis ?? [0, 0, 1]).map(round6),
    loops: (drawing.loops ?? []).map((loop) => ({
      closed: !!loop.closed,
      pts: loop.points.map((s) => [round4(s.p[0]), round4(s.p[1]), round4(s.p[2]), s.t]),
      segs: (loop.segs ?? []).map((s) => {
        // An arc not given its radius and side yet is saved as the straight line it still is.
        if (s.kind === "arc" && s.radius > 0 && s.toward) return ["a", round4(s.radius), ...s.toward.map(round6)];
        if (s.method === "edges") return ["e"];
        return s.m ? ["s", s.via === -1 ? -1 : 1, ...s.m.map(round6)] : ["s", s.via === -1 ? -1 : 1];
      }),
    })),
    seeds: (drawing.seeds ?? []).map((s) => [round4(s.p[0]), round4(s.p[1]), round4(s.p[2]), s.t, s.side]),
    swap: !!drawing.swap,
  };
}

/**
 * A saved drawing read back (JSON text or object), checked: v 1, finite
 * numbers, at most 32 loops and 2000 points, integer triangles, a segment
 * per point of a closed loop (one fewer open). Returns {v, nt, plane, axis,
 * loops: [{closed, points: [{p, t}], segs (SegSpecs)}], seeds [{p, t,
 * side}], swap}, or null (with a console warning).
 */
export function parseDrawing(json) {
  const reject = (why) => {
    console.warn(`Drawn parting line not restored: ${why}`);
    return null;
  };
  let d;
  try {
    d = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return reject("not JSON");
  }
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  const triangle = (t) => Number.isInteger(t) && t >= 0;
  const vector = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
  if (!d || typeof d !== "object" || d.v !== DRAW_VERSION) return reject("version");
  if (d.nt != null && !triangle(d.nt)) return reject("triangle count");
  if (!PLANES.includes(d.plane)) return reject("plane");
  if (!vector(d.axis) || !(norm(d.axis) > 0)) return reject("axis");
  if (!Array.isArray(d.loops) || d.loops.length > MAX_LOOPS) return reject("loops");
  let points = 0;
  const loops = [];
  for (const loop of d.loops) {
    if (!loop || typeof loop !== "object" || !Array.isArray(loop.pts) || !Array.isArray(loop.segs)) return reject("loop");
    const closed = loop.closed === true;
    points += loop.pts.length;
    if (points > MAX_POINTS) return reject("points");
    if (closed && loop.pts.length < 3) return reject("closed loop of fewer than 3 points");
    if (loop.segs.length !== (closed ? loop.pts.length : Math.max(0, loop.pts.length - 1))) return reject("segments");
    const pts = [];
    for (const p of loop.pts) {
      if (!Array.isArray(p) || p.length !== 4 || !p.slice(0, 3).every(finite) || !triangle(p[3])) return reject("point");
      pts.push({ p: p.slice(0, 3), t: p[3] });
    }
    const segs = [];
    for (const s of loop.segs) {
      if (!Array.isArray(s)) return reject("segment");
      if (s[0] === "s" && (s.length === 2 || s.length === 5) && (s[1] === 1 || s[1] === -1) && s.slice(2).every(finite) && (s.length === 2 || norm(s.slice(2)) > 0)) {
        segs.push({ kind: "straight", via: s[1], m: s.length === 5 ? s.slice(2) : null });
      } else if (s[0] === "a" && s.length === 5 && finite(s[1]) && s[1] > 0 && vector(s.slice(2)) && norm(s.slice(2)) > 0) {
        segs.push({ kind: "arc", radius: s[1], toward: s.slice(2) });
      } else if (s[0] === "e" && s.length === 1) {
        segs.push({ kind: "straight", via: 1, m: null, method: "edges" });
      } else return reject("segment");
    }
    loops.push({ closed, points: pts, segs });
  }
  if (!Array.isArray(d.seeds ?? [])) return reject("seeds");
  const seeds = [];
  for (const s of d.seeds ?? []) {
    if (!Array.isArray(s) || s.length !== 5 || !s.slice(0, 3).every(finite) || !triangle(s[3]) || (s[4] !== SIDE_UPPER && s[4] !== SIDE_LOWER)) return reject("seed");
    seeds.push({ p: s.slice(0, 3), t: s[3], side: s[4] });
  }
  return { v: DRAW_VERSION, nt: d.nt ?? null, plane: d.plane, axis: d.axis.slice(), loops, seeds, swap: d.swap === true };
}

/**
 * A parsed drawing put back on a body's mesh: its points (and seeds) on
 * their triangles when the mesh has the same number of triangles, else
 * brought back onto the surface (reprojectPoint: one scan per point; a seed
 * finds its triangle again from its point). The segments keep their specs
 * (an arc its radius and toward).
 */
export function reviveDrawing(dm, parsed) {
  const same = parsed.nt === dm.nt;
  const place = (s) => (same && s.t < dm.nt ? surfacePoint(dm, s.t, s.p) : reprojectPoint(dm, s.p));
  return {
    plane: parsed.plane,
    axis: parsed.axis.slice(),
    loops: parsed.loops.map((loop) => ({ closed: loop.closed, points: loop.points.map(place), segs: loop.segs.map((s) => ({ ...s })) })),
    seeds: parsed.seeds.map((s) => {
      const sp = place(s);
      return { p: sp.p, t: sp.t, side: s.side };
    }),
    swap: parsed.swap,
  };
}
