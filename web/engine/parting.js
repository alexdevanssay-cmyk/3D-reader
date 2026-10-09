// Draw direction and parting line of a cast part (gravity die, low pressure,
// sand), proposed from the geometry of its closed triangle mesh (mm).
//
// For a draw direction d, a triangle is formed by the half of the mould it can
// leave the part from: a line from its centre, moved off the surface along its
// normal, meets no other triangle along +d -> the upper half can form it;
// along -d -> the lower half; neither -> an undercut, formed by a core or a
// slide. Faces at less than the draft angle from d have no draft. The parting
// line is the boundary between the triangles of the two halves: planar when
// its points are at one height along d, else stepped or warped.
//
// The lines along d are tested against a uniform grid of the triangles
// projected on the plane normal to d (one grid per direction): a line meets
// only the triangles of its cell, and one walk gives both senses.
//
// Plain JavaScript without bare imports: it runs in the parting worker
// (partworker.js) and on the page (faces reassigned by hand).

import { edgeNeighbours, weld } from './thickness.js';

export const PARTING_VERSION = 1;

// Half of the mould of a triangle: none (an undercut), upper (+d), lower (-d).
export const SIDE_NONE = 0;
export const SIDE_UPPER = 1;
export const SIDE_LOWER = 2;
// Flags of a triangle for a direction.
export const REACH_UP = 1; // a line along +d leaves the part
export const REACH_DOWN = 2; // along -d
export const ZERO_DRAFT = 4; // |n.d| below the sine of the draft angle

export const DEFAULT_DRAFT_DEG = 1;
// Every candidate is classified on every triangle up to this size; above,
// the candidates are ranked on triangles drawn by area (fixed seed), and the
// direction chosen is classified on every triangle.
export const FULL_LIMIT = 400_000;
export const SAMPLES = 150_000;
export const SEED = 0x5eed;

const MAX_CANDIDATES = 6;
const SAME_AXIS = Math.cos((10 * Math.PI) / 180); // two candidates closer than 10° are one
const SNAP = Math.cos((1 * Math.PI) / 180); // within 1° of X, Y or Z: that axis
const NORMAL_BINS = 25; // per side of a face of the cube of directions (odd: an axis is the middle of a bin)
// A direction of face normals is dominant above this share of the surface (not
// one facet of a curved face).
const DOMINANT_SHARE = 0.05;
// A face reachable from both sides, square to d within this, goes to the upper half.
const TIE = 1e-6;
// Planar: the points of the line within this height along d (the larger of the two).
const PLANAR_TOL_MM = 0.5;
const PLANAR_TOL_SHARE = 0.005; // of the height of the part along d
// Ranking: undercut and zero-draft areas closer than these shares of the surface are equal.
const UNDERCUT_TIE = 0.002;
const ZERO_DRAFT_TIE = 0.01;
const RATIO_TIE = 0.01; // of the larger projected area per height
const BARY_MARGIN = 1e-7; // a line through the common edge of two triangles meets one of them
// Facets of one smooth surface: normals closer than this (35°, above the angular deflection of a coarse tessellation).
const SMOOTH_FACETS = Math.cos((35 * Math.PI) / 180);

// ------------------------------------------------------------------ mesh

/**
 * What every direction needs of a mesh: positions in double precision, moved
 * to the centre of the box (precision far from the origin), unit outward
 * normals (flipped when the enclosed volume is negative), areas, centres,
 * longest edges, and the vertices merged by position (the faces of a CAD
 * body have their own vertices): {welded (per corner), nv}.
 */
export function prepareMesh(positions, indices) {
  const nt = indices.length / 3;
  const nv = positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const x = positions[3 * i + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  const centre = nv ? min.map((m, k) => (m + max[k]) / 2) : [0, 0, 0];
  const P = new Float64Array(3 * nv);
  for (let i = 0; i < 3 * nv; i++) P[i] = positions[i] - centre[i % 3];
  const normals = new Float64Array(3 * nt);
  const centres = new Float64Array(3 * nt);
  const areas = new Float64Array(nt);
  const reach = new Float64Array(nt); // longest edge
  let volume = 0;
  for (let f = 0; f < nt; f++) {
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    volume += P[a] * nx + P[a + 1] * ny + P[a + 2] * nz;
    const len = Math.hypot(nx, ny, nz);
    areas[f] = len / 2;
    if (len > 0) {
      normals[3 * f] = nx / len;
      normals[3 * f + 1] = ny / len;
      normals[3 * f + 2] = nz / len;
    }
    for (let k = 0; k < 3; k++) centres[3 * f + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
    reach[f] = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2));
  }
  if (volume < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  let totalArea = 0;
  for (let f = 0; f < nt; f++) totalArea += areas[f];
  const diag = nv ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  // Slivers without area (thousands round a singular point of a B-spline face).
  const sliver = 1e-9 * diag * diag;
  return { positions: P, indices, nt, nv, normals, centres, areas, reach, totalArea, diag, centre, sliver, merged: weld(positions, indices) };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** One sense of an axis: its largest component positive (Z is [0, 0, 1]); within 1° of X, Y or Z, that axis. */
export function canonicalAxis(v) {
  const a = normalize(v);
  if (!a) return null;
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(a[i]) > Math.abs(a[k])) k = i;
  const s = a[k] < 0 ? -1 : 1;
  if (Math.abs(a[k]) >= SNAP) return [0, 1, 2].map((i) => (i === k ? 1 : 0));
  return a.map((x) => x * s + 0); // + 0: no -0
}

/** "X", "-Z"… for an axis of the frame, else its components. */
export function axisLabel(d) {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) >= SNAP) return (d[k] < 0 ? "-" : "") + "XYZ"[k];
  }
  return `(${d.map((x) => Math.round(x * 1000) / 1000).join(", ")})`;
}

// ------------------------------------------------------------------ candidates

/** Eigenvectors of a symmetric 3×3 matrix (Jacobi), largest eigenvalue first. */
function eigenvectors(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]).map((i) => [v[0][i], v[1][i], v[2][i]]);
}

/**
 * Candidate draw axes: the directions of the face normals that hold the most
 * surface (both senses together), the axes of the frame (a part is drawn in
 * the frame of its design), then the principal axes of the surface; closer
 * than 10° to an earlier one, left out; at most six. Each axis covers both
 * halves. Ties of the ranking go to the earlier one.
 */
export function candidateAxes(mesh, max = MAX_CANDIDATES) {
  const { normals, areas, centres, nt, totalArea } = mesh;
  // Normals binned on the faces of a cube, in the sense of their largest component.
  const B = NORMAL_BINS;
  const binArea = new Float64Array(3 * B * B);
  const binSum = new Float64Array(9 * B * B);
  for (let f = 0; f < nt; f++) {
    const A = areas[f];
    if (!(A > 0)) continue;
    let n0 = normals[3 * f], n1 = normals[3 * f + 1], n2 = normals[3 * f + 2];
    const k = Math.abs(n0) >= Math.abs(n1) && Math.abs(n0) >= Math.abs(n2) ? 0 : Math.abs(n1) >= Math.abs(n2) ? 1 : 2;
    const s = [n0, n1, n2][k] < 0 ? -1 : 1;
    n0 *= s;
    n1 *= s;
    n2 *= s;
    const n = [n0, n1, n2];
    const big = n[k];
    const p = n[(k + 1) % 3] / big, q = n[(k + 2) % 3] / big;
    const ip = Math.min(B - 1, Math.max(0, Math.floor(((p + 1) / 2) * B)));
    const iq = Math.min(B - 1, Math.max(0, Math.floor(((q + 1) / 2) * B)));
    const bin = (k * B + ip) * B + iq;
    binArea[bin] += A;
    binSum[3 * bin] += n0 * A;
    binSum[3 * bin + 1] += n1 * A;
    binSum[3 * bin + 2] += n2 * A;
  }
  const bins = [];
  for (let i = 0; i < binArea.length; i++) if (binArea[i] >= DOMINANT_SHARE * totalArea) bins.push(i);
  bins.sort((x, y) => binArea[y] - binArea[x]);
  const list = bins.map((i) => ({ axis: [binSum[3 * i], binSum[3 * i + 1], binSum[3 * i + 2]], source: "face_normals" }));

  for (let k = 0; k < 3; k++) list.push({ axis: [0, 1, 2].map((i) => (i === k ? 1 : 0)), source: "frame_axis" });
  // Principal axes of the surface: its second moments about its centre, each
  // triangle's exact (A/12 (a aT + b bT + c cT + 9 g gT)), whatever the
  // triangulation (the centres alone tilt the axes of a box of 12 triangles).
  const { positions: P, indices: I } = mesh;
  const m1 = [0, 0, 0];
  const m2 = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  for (let f = 0; f < nt; f++) {
    const A = areas[f];
    if (!(A > 0)) continue;
    const g = [centres[3 * f], centres[3 * f + 1], centres[3 * f + 2]];
    for (let k = 0; k < 3; k++) m1[k] += A * g[k];
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    pairs.forEach(([i, j], k) => {
      m2[k] += (A / 12) * (P[a + i] * P[a + j] + P[b + i] * P[b + j] + P[c + i] * P[c + j] + 9 * g[i] * g[j]);
    });
  }
  if (totalArea > 0) {
    const mean = m1.map((x) => x / totalArea);
    const cov = pairs.map(([i, j], k) => m2[k] - totalArea * mean[i] * mean[j]);
    for (const axis of eigenvectors(cov)) list.push({ axis, source: "principal_axis" });
  }

  const out = [];
  for (const { axis, source } of list) {
    const d = canonicalAxis(axis);
    if (!d || out.some((o) => Math.abs(dot(o.direction, d)) > SAME_AXIS)) continue;
    out.push({ direction: d, source });
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------ lines along d

/** Two unit vectors square to d and to each other. */
function basis(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize([d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  return [u, v];
}

/**
 * Uniform grid of the triangles projected on the plane normal to d (u, v),
 * about one cell per triangle; each triangle in the cells its projected box
 * covers, a crowded cell cut again (cellGrid). Triangles square to the plane
 * (a line along d cannot cross them) are left out.
 */
function lineGrid(mesh, d) {
  const { positions: P, indices: I, nt, nv, normals } = mesh;
  const [u, v] = basis(d);
  const pu = new Float64Array(nv), pv = new Float64Array(nv), pw = new Float64Array(nv);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, wmin = Infinity, wmax = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    const a = x * u[0] + y * u[1] + z * u[2], b = x * v[0] + y * v[1] + z * v[2], c = x * d[0] + y * d[1] + z * d[2];
    pu[i] = a;
    pv[i] = b;
    pw[i] = c;
    if (a < umin) umin = a;
    if (a > umax) umax = a;
    if (b < vmin) vmin = b;
    if (b > vmax) vmax = b;
    if (c < wmin) wmin = c;
    if (c > wmax) wmax = c;
  }
  const crossing = new Uint8Array(nt);
  const boxW = new Float64Array(nt), boxH = new Float64Array(nt);
  const box = new Float64Array(4 * nt); // u min, u max, v min, v max
  // Slivers block no line: left out, they would crowd a cell.
  let count = 0;
  for (let f = 0; f < nt; f++) {
    const nd = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2];
    if (Math.abs(nd) < 1e-9 || mesh.areas[f] < mesh.sliver) continue;
    crossing[f] = 1;
    count++;
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    box[4 * f] = Math.min(pu[a], pu[b], pu[c]);
    box[4 * f + 1] = Math.max(pu[a], pu[b], pu[c]);
    box[4 * f + 2] = Math.min(pv[a], pv[b], pv[c]);
    box[4 * f + 3] = Math.max(pv[a], pv[b], pv[c]);
    boxW[f] = box[4 * f + 1] - box[4 * f];
    boxH[f] = box[4 * f + 3] - box[4 * f + 2];
  }
  const W = Math.max(umax - umin, 1e-12), H = Math.max(vmax - vmin, 1e-12);
  // Cells the median size of the triangle boxes: long thin triangles (the
  // meridians of a surface of revolution) cover several cells rather than
  // make every cell large. At most 2048 cells a side, 4 per triangle, and
  // 12 entries per triangle in all.
  const sample = [];
  for (let f = 0, step = Math.max(1, Math.floor(nt / 4096)); f < nt; f += step) if (crossing[f]) sample.push(Math.max(boxW[f], boxH[f]));
  sample.sort((x, y) => x - y);
  let cell = Math.max(sample[sample.length >> 1] ?? Math.max(W, H), Math.max(W, H) / 2048, 1e-12);
  const entries = (size) => {
    let n = 0;
    for (let f = 0; f < nt; f++) if (crossing[f]) n += (Math.floor(boxW[f] / size) + 2) * (Math.floor(boxH[f] / size) + 2);
    return n;
  };
  while (Math.ceil(W / cell) * Math.ceil(H / cell) > 4 * count + 1024 || entries(cell) > 12 * count + 1024) cell *= 1.3;
  const nu = Math.max(1, Math.ceil(W / cell)), nvv = Math.max(1, Math.ceil(H / cell));
  const list = new Int32Array(count);
  for (let f = 0, n = 0; f < nt; f++) if (crossing[f]) list[n++] = f;
  const root = cellGrid(list, { box, I, pu, pv }, umin, vmin, cell, nu, nvv, 0, Infinity);
  return { d, u, v, pu, pv, pw, root, height: wmax - wmin };
}

// A cell of more triangles than this gets a finer grid of its own (3 levels at most).
const CELL_SPLIT = 48;

/**
 * Triangles `list` in an nu × nv grid of cells `size` wide from (u0, v0),
 * each in the cells its projection overlaps (geo: {box (u min, u max, v min,
 * v max per triangle), I, pu, pv}), in compressed rows; null above `limit`
 * entries. A crowded cell (small details, triangles round a point) is cut
 * again into a finer grid, when that does not copy its triangles into every
 * sub-cell.
 */
function cellGrid(list, geo, u0, v0, size, nu, nv, depth, limit) {
  const { box, I, pu, pv } = geo;
  const margin = 1e-9 * size;
  // Each cell of the box of the triangle that the triangle itself overlaps (an
  // edge with the whole cell outside it separates them): long thin triangles
  // round a point share few cells.
  // Edge e of the triangle: inside where n·(c - p) >= 0, n its inward normal.
  const ex = new Float64Array(3), ey = new Float64Array(3), nx = new Float64Array(3), ny = new Float64Array(3);
  const cells = (f, visit) => {
    const i0 = Math.min(nu - 1, Math.max(0, Math.floor((box[4 * f] - u0) / size)));
    const i1 = Math.min(nu - 1, Math.max(0, Math.floor((box[4 * f + 1] - u0) / size)));
    const j0 = Math.min(nv - 1, Math.max(0, Math.floor((box[4 * f + 2] - v0) / size)));
    const j1 = Math.min(nv - 1, Math.max(0, Math.floor((box[4 * f + 3] - v0) / size)));
    if (i0 === i1 && j0 === j1) return visit(i0 * nv + j0);
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    const turn = (pu[b] - pu[a]) * (pv[c] - pv[a]) - (pv[b] - pv[a]) * (pu[c] - pu[a]) < 0 ? -1 : 1;
    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : e === 1 ? b : c, q = e === 0 ? b : e === 1 ? c : a;
      ex[e] = pu[p];
      ey[e] = pv[p];
      nx[e] = -turn * (pv[q] - pv[p]);
      ny[e] = turn * (pu[q] - pu[p]);
    }
    for (let i = i0; i <= i1; i++) {
      const xa = u0 + i * size - margin, xb = xa + size + 2 * margin;
      for (let j = j0; j <= j1; j++) {
        const ya = v0 + j * size - margin, yb = ya + size + 2 * margin;
        // Apart when, for an edge, even the corner of the cell furthest inwards is outside it.
        let apart = false;
        for (let e = 0; e < 3; e++) {
          if (nx[e] * ((nx[e] > 0 ? xb : xa) - ex[e]) + ny[e] * ((ny[e] > 0 ? yb : ya) - ey[e]) < 0) {
            apart = true;
            break;
          }
        }
        if (!apart) visit(i * nv + j);
      }
    }
  };
  const start = new Int32Array(nu * nv + 1);
  for (const f of list) cells(f, (k) => start[k + 1]++);
  for (let k = 0; k < nu * nv; k++) start[k + 1] += start[k];
  if (start[nu * nv] > limit) return null;
  const items = new Int32Array(start[nu * nv]);
  const fill = start.slice(0, nu * nv);
  for (const f of list) cells(f, (k) => (items[fill[k]++] = f));
  const sub = new Map();
  if (depth < 2) {
    for (let k = 0; k < nu * nv; k++) {
      const n = start[k + 1] - start[k];
      if (n <= CELL_SPLIT) continue;
      const m = Math.min(16, Math.ceil(Math.sqrt(n / 8)));
      const i = Math.floor(k / nv), j = k - i * nv;
      const finer = cellGrid(items.subarray(start[k], start[k + 1]), geo, u0 + i * size, v0 + j * size, size / m, m, m, depth + 1, 4 * n);
      if (finer) sub.set(k, finer);
    }
  }
  return { u0, v0, size, nu, nv, start, items, sub, depth };
}

/**
 * Which senses of the line through point o along d meet a triangle other
 * than `self`: 1 ahead (+d), 2 behind (-d), 3 both. Not the next facets of
 * the same smooth surface (a vertex in common, normals less than 35° apart,
 * within the size of `self`): a line from a facet at a silhouette grazes
 * them, it is not an undercut.
 */
function lineHits(mesh, grid, self, ox, oy, oz, tEps) {
  const { indices: I, normals: N, reach } = mesh;
  const W = mesh.merged.welded;
  const s0 = W[3 * self], s1 = W[3 * self + 1], s2 = W[3 * self + 2];
  const { u, v, d, pu, pv, pw } = grid;
  const a0 = ox * u[0] + oy * u[1] + oz * u[2];
  const b0 = ox * v[0] + oy * v[1] + oz * v[2];
  const w0 = ox * d[0] + oy * d[1] + oz * d[2];
  // The cell of the line, in the finer grid of a crowded cell.
  let g = grid.root;
  let k;
  for (;;) {
    let i = Math.floor((a0 - g.u0) / g.size), j = Math.floor((b0 - g.v0) / g.size);
    if (g.depth === 0 && (i < 0 || j < 0 || i >= g.nu || j >= g.nv)) return 0;
    i = Math.min(g.nu - 1, Math.max(0, i)); // a finer grid: rounding at its border
    j = Math.min(g.nv - 1, Math.max(0, j));
    k = i * g.nv + j;
    const finer = g.sub.size ? g.sub.get(k) : undefined;
    if (!finer) break;
    g = finer;
  }
  const { start, items } = g;
  let bits = 0;
  for (let s = start[k], end = start[k + 1]; s < end; s++) {
    const f = items[s];
    if (f === self) continue;
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    const xa = pu[a] - a0, ya = pv[a] - b0, xb = pu[b] - a0, yb = pv[b] - b0, xc = pu[c] - a0, yc = pv[c] - b0;
    const ea = xb * yc - xc * yb; // twice the signed area of (o, b, c): the weight of a
    const eb = xc * ya - xa * yc;
    const ec = xa * yb - xb * ya;
    const area = ea + eb + ec;
    if (area === 0) continue;
    const m = -BARY_MARGIN * area;
    if (area > 0 ? ea < m || eb < m || ec < m : ea > m || eb > m || ec > m) continue;
    const t = (ea * pw[a] + eb * pw[b] + ec * pw[c]) / area - w0;
    if (!(t > tEps || t < -tEps)) continue;
    if (Math.abs(t) <= reach[self] && N[3 * f] * N[3 * self] + N[3 * f + 1] * N[3 * self + 1] + N[3 * f + 2] * N[3 * self + 2] > SMOOTH_FACETS) {
      const v0 = W[3 * f], v1 = W[3 * f + 1], v2 = W[3 * f + 2];
      if (v0 === s0 || v0 === s1 || v0 === s2 || v1 === s0 || v1 === s1 || v1 === s2 || v2 === s0 || v2 === s1 || v2 === s2) continue;
    }
    bits |= t > 0 ? 1 : 2;
    if (bits === 3) return 3;
  }
  return bits;
}

/**
 * Flags (REACH_UP, REACH_DOWN, ZERO_DRAFT) of the triangles `list` (all when
 * null) for direction d.
 */
function classify(mesh, grid, d, list, sinDraft) {
  const { normals, centres, nt, diag } = mesh;
  const n = list ? list.length : nt;
  const flags = new Uint8Array(n);
  // Off the surface by more than the rounding of float32 positions, far less than a detail.
  const eps = diag * 1e-5;
  const tEps = diag * 1e-7;
  for (let s = 0; s < n; s++) {
    const f = list ? list[s] : s;
    const nx = normals[3 * f], ny = normals[3 * f + 1], nz = normals[3 * f + 2];
    if (!(nx || ny || nz)) continue; // degenerate: no side, no area
    const nd = nx * d[0] + ny * d[1] + nz * d[2];
    let flag = Math.abs(nd) < sinDraft ? ZERO_DRAFT : 0;
    // A sliver (no area, a normal of no meaning): either half, as its neighbours.
    if (mesh.areas[f] < mesh.sliver) {
      flags[s] = flag | REACH_UP | REACH_DOWN;
      continue;
    }
    const hits = lineHits(mesh, grid, f, centres[3 * f] + eps * nx, centres[3 * f + 1] + eps * ny, centres[3 * f + 2] + eps * nz, tEps);
    if (!(hits & 1)) flag |= REACH_UP;
    if (!(hits & 2)) flag |= REACH_DOWN;
    flags[s] = flag;
  }
  return flags;
}

/** True for a triangle both halves can form (a face without draft, on the outside). */
const isFree = (flag) => (flag & (REACH_UP | REACH_DOWN)) === (REACH_UP | REACH_DOWN);

/**
 * Height along d (in the frame of the positions) of a planar parting line
 * that leaves every triangle only one half can form on its side, or null
 * when there is none: the faces of the lower half all below it, those of the
 * upper half all above it. The lowest such plane: the part in the upper
 * half as far as it can (a line on an edge, not across a face).
 */
function planeHeight(mesh, flags, d, tol) {
  const { positions: P, indices: I, nt, nv, centre } = mesh;
  const offset = dot(centre, d);
  let lowerTop = -Infinity, upperBottom = Infinity, bottom = Infinity;
  for (let i = 0; i < nv; i++) bottom = Math.min(bottom, P[3 * i] * d[0] + P[3 * i + 1] * d[1] + P[3 * i + 2] * d[2]);
  for (let f = 0; f < nt; f++) {
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if (reach !== REACH_UP && reach !== REACH_DOWN) continue;
    for (let k = 0; k < 3; k++) {
      const v = 3 * I[3 * f + k];
      const w = P[v] * d[0] + P[v + 1] * d[1] + P[v + 2] * d[2];
      if (reach === REACH_DOWN) lowerTop = Math.max(lowerTop, w);
      else upperBottom = Math.min(upperBottom, w);
    }
  }
  if (!(nv > 0) || lowerTop > upperBottom + tol) return null;
  return Math.max(lowerTop, bottom) + offset;
}

/**
 * Half of each triangle from its flags: the side it leaves by. A face both
 * can form: with a planar line (height `plane`), the side of its centre; else
 * by the sense of its normal, square to d: upper.
 */
export function sidesOf(mesh, flags, d, plane = null) {
  const { normals, centres, nt, centre } = mesh;
  const level = plane == null ? null : plane - dot(centre, d);
  const side = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue; // degenerate: no side
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if (reach === REACH_UP) side[f] = SIDE_UPPER;
    else if (reach === REACH_DOWN) side[f] = SIDE_LOWER;
    else if (reach) {
      const w = level == null
        ? normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2] + TIE
        : centres[3 * f] * d[0] + centres[3 * f + 1] * d[1] + centres[3 * f + 2] * d[2] - level;
      side[f] = w < 0 ? SIDE_LOWER : SIDE_UPPER;
    }
  }
  return side;
}

/** Small fast deterministic generator (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` triangles drawn by area, with replacement (same seed, same draw). */
export function sampleByArea(areas, count, seed = SEED) {
  const n = areas.length;
  const cumulative = new Float64Array(n);
  let total = 0;
  for (let f = 0; f < n; f++) cumulative[f] = total += areas[f];
  const next = random(seed);
  const out = new Uint32Array(count);
  for (let s = 0; s < count; s++) {
    const x = next() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > x) hi = mid;
      else lo = mid + 1;
    }
    out[s] = lo;
  }
  return out;
}

/**
 * Areas of a classification: undercut (no half can form it), zero draft,
 * projected (the faces seen from +d, on the plane normal to d). Estimated
 * from the triangles drawn by area when `list` is given.
 */
function areasOf(mesh, d, flags, list) {
  const { normals, areas, totalArea, nt } = mesh;
  let undercut = 0, zeroDraft = 0, projected = 0;
  const n = list ? list.length : nt;
  for (let s = 0; s < n; s++) {
    const f = list ? list[s] : s;
    const w = list ? totalArea / n : areas[f];
    const flag = flags[s];
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue;
    const nd = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2];
    if (!(flag & (REACH_UP | REACH_DOWN))) undercut += w;
    if (flag & ZERO_DRAFT) zeroDraft += w;
    if (flag & REACH_UP && nd > 0) projected += w * nd;
  }
  return { undercut, zeroDraft, projected };
}

/** Zero-draft area of a direction, from the normals only (exact on a sampled mesh too). */
function zeroDraftArea(mesh, d, sinDraft) {
  const { normals, areas, nt } = mesh;
  let sum = 0;
  for (let f = 0; f < nt; f++) {
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue;
    const nd = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2];
    if (Math.abs(nd) < sinDraft) sum += areas[f];
  }
  return sum;
}

// ------------------------------------------------------------------ parting line

/**
 * What the parting line needs of a mesh, computed once: the vertices merged
 * by position (the faces of a CAD model have their own vertices) and the
 * triangle on the other side of each edge (-1 free, -2 shared by more).
 */
export function lineMesh(positions, indices, merged = weld(positions, indices)) {
  const { welded, nv } = merged;
  return { positions, indices, welded, neighbours: edgeNeighbours(nv, welded) };
}

/**
 * Parting line of a split into halves: where the surface goes from the upper
 * half to the lower one (undercut triangles belong to neither). Along the
 * edges between triangles of the two halves, and, with a planar line
 * (`plane`: its height along d), across the faces both halves can form
 * (`flags`), cut at that height, unless reassigned by hand (`fixed`).
 *
 * side   -- half of each triangle (SIDE_*)
 * height -- of the part along d, for the planarity tolerance
 * Returns {segments (Float32Array, xyz of both ends of each piece),
 * length_mm, loops, planar, kind ("planar", "stepped", "warped", or null
 * without a line), height_range_mm, heights_mm [lowest, highest] along d,
 * levels (heights of its level runs)}.
 */
export function partingLine(line, side, d, { flags = null, plane = null, fixed = null, height = null } = {}) {
  const { positions: P, indices: I, welded, neighbours } = line;
  const nt = I.length / 3;
  const w = (r) => P[3 * r] * d[0] + P[3 * r + 1] * d[1] + P[3 * r + 2] * d[2];
  const tiny = 1e-9 * Math.max(1, Math.abs(plane ?? 0), height ?? 0);
  // A face both halves can form, across the plane: its side changes at the plane.
  const split = (f) => {
    if (plane == null || !flags || !isFree(flags[f]) || fixed?.[f]) return false;
    let below = false, above = false;
    for (let k = 0; k < 3; k++) {
      const h = w(I[3 * f + k]);
      if (h < plane - tiny) below = true;
      else if (h > plane + tiny) above = true;
    }
    return below && above;
  };
  const pieces = []; // [xyz, xyz, key, key]: the ends of each piece and what they are (a vertex, a point of an edge)
  const pointOn = (ra, rb) => {
    const ha = w(ra), hb = w(rb);
    const t = (plane - ha) / (hb - ha);
    return [0, 1, 2].map((c) => P[3 * ra + c] + t * (P[3 * rb + c] - P[3 * ra + c]));
  };
  const at = (r) => [P[3 * r], P[3 * r + 1], P[3 * r + 2]];
  const edgeKey = (wa, wb) => (wa < wb ? `e${wa},${wb}` : `e${wb},${wa}`);
  const splitCache = new Map();
  const isSplit = (f) => {
    let s = splitCache.get(f);
    if (s === undefined) splitCache.set(f, (s = split(f)));
    return s;
  };

  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f) continue; // free, non-manifold, or seen from the other triangle
      const sf = side[f], sg = side[g];
      const ra = I[3 * f + e], rb = I[3 * f + ((e + 1) % 3)];
      const wa = welded[3 * f + e], wb = welded[3 * f + ((e + 1) % 3)];
      const xf = isSplit(f), xg = isSplit(g);
      if (!xf && !xg) {
        if (sf !== SIDE_NONE && sg !== SIDE_NONE && sf !== sg) pieces.push([at(ra), at(rb), `v${wa}`, `v${wb}`]);
        continue;
      }
      if (xf && xg) continue; // the same rule on both sides
      // One side cut by the plane (upper above it), the other of one half: the part of the edge where they differ.
      const other = xf ? sg : sf;
      if (other === SIDE_NONE) continue;
      const keepAbove = other === SIDE_LOWER;
      const ha = w(ra), hb = w(rb);
      const inA = keepAbove ? ha > plane : ha < plane;
      const inB = keepAbove ? hb > plane : hb < plane;
      if (inA && inB) pieces.push([at(ra), at(rb), `v${wa}`, `v${wb}`]);
      else if (inA !== inB && Math.abs(hb - ha) > tiny) {
        const cut = pointOn(ra, rb);
        pieces.push(inA ? [at(ra), cut, `v${wa}`, edgeKey(wa, wb)] : [cut, at(rb), edgeKey(wa, wb), `v${wb}`]);
      }
    }
  }
  // Across the faces cut by the plane.
  for (const [f, s] of splitCache) {
    if (!s) continue;
    const ends = [];
    for (let e = 0; e < 3; e++) {
      const ra = I[3 * f + e], rb = I[3 * f + ((e + 1) % 3)];
      const ha = w(ra) - plane, hb = w(rb) - plane;
      if (Math.abs(ha) <= tiny) ends.push([at(ra), `v${welded[3 * f + e]}`]);
      else if (ha * hb < 0 && Math.abs(hb) > tiny) ends.push([pointOn(ra, rb), edgeKey(welded[3 * f + e], welded[3 * f + ((e + 1) % 3)])]);
    }
    if (ends.length === 2) pieces.push([ends[0][0], ends[1][0], ends[0][1], ends[1][1]]);
  }

  const m = pieces.length;
  const segments = new Float32Array(6 * m);
  if (!m) return { segments, length_mm: 0, loops: 0, planar: null, kind: null, height_range_mm: null, heights_mm: null, levels: [] };
  const hOf = (p) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
  let length = 0, lo = Infinity, hi = -Infinity;
  const lengths = new Float64Array(m);
  pieces.forEach(([a, b], k) => {
    segments.set(a, 6 * k);
    segments.set(b, 6 * k + 3);
    lengths[k] = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    length += lengths[k];
    lo = Math.min(lo, hOf(a), hOf(b));
    hi = Math.max(hi, hOf(a), hOf(b));
  });

  // Loops: the pieces chained by their ends.
  const byEnd = new Map();
  pieces.forEach(([, , ka, kb], k) => {
    for (const key of [ka, kb]) {
      const list = byEnd.get(key);
      if (list) list.push(k);
      else byEnd.set(key, [k]);
    }
  });
  const used = new Uint8Array(m);
  let loops = 0;
  for (let k0 = 0; k0 < m; k0++) {
    if (used[k0]) continue;
    loops++;
    const stack = [k0];
    used[k0] = 1;
    while (stack.length) {
      const k = stack.pop();
      for (const key of [pieces[k][2], pieces[k][3]]) {
        for (const next of byEnd.get(key)) {
          if (!used[next]) {
            used[next] = 1;
            stack.push(next);
          }
        }
      }
    }
  }

  const span = hi - lo;
  const tol = Math.max(PLANAR_TOL_MM, PLANAR_TOL_SHARE * (height ?? span));
  // Planar: 95 % of its length within ±tol of one height (the median). A line
  // along the edges of a curved silhouette zigzags by a facet: still planar.
  const byHeight = pieces.map(([a, b], k) => [(hOf(a) + hOf(b)) / 2, lengths[k], Math.abs(hOf(b) - hOf(a)) / 2]).sort((x, y) => x[0] - y[0]);
  let median = byHeight[0][0];
  for (let k = 0, acc = 0; k < m; k++) {
    if ((acc += byHeight[k][1]) >= length / 2) {
      median = byHeight[k][0];
      break;
    }
  }
  let near = 0;
  for (const [h, len, half] of byHeight) if (Math.abs(h - median) + half <= tol) near += len;
  const planar = near >= 0.95 * length;
  // Stepped: most of its length in level runs, at two heights or more; else warped.
  const runs = [];
  let levelLength = 0;
  pieces.forEach(([a, b], k) => {
    if (Math.abs(hOf(b) - hOf(a)) > tol) return;
    levelLength += lengths[k];
    runs.push([(hOf(a) + hOf(b)) / 2, lengths[k]]);
  });
  runs.sort((x, y) => x[0] - y[0]);
  const levels = [];
  for (const [h, len] of runs) {
    const last = levels.at(-1);
    if (last && h - last.top <= tol) {
      last.top = h;
      last.length += len;
      last.sum += h * len;
    } else levels.push({ top: h, length: len, sum: h * len });
  }
  // Levels of at least 5 % of the line (a few level pieces of a warped line are not steps).
  const kept = levels.filter((l) => l.length >= 0.05 * length).map((l) => l.sum / l.length);
  const kind = planar ? "planar" : levelLength >= 0.6 * length && kept.length >= 2 ? "stepped" : "warped";
  return { segments, length_mm: length, loops, planar, kind, height_range_mm: span, heights_mm: [lo, hi], levels: kept };
}

// ------------------------------------------------------------------ faces

/**
 * Faces of a body, to reassign by hand: the B-rep faces of a CAD body (each
 * face has its own vertices: the triangles joined by a vertex), else the
 * regions of triangles joined across edges bent by less than 30°.
 * Returns {region (Int32Array per triangle), count}, numbered in the order
 * of their first triangle (the same for the same file).
 */
export function faceRegions(positions, indices, { brep = false, line = null } = {}) {
  const nt = indices.length / 3;
  const region = new Int32Array(nt).fill(-1);
  let count = 0;
  if (brep) {
    const nv = positions.length / 3;
    const parent = new Int32Array(nv);
    for (let i = 0; i < nv; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
    };
    for (let f = 0; f < nt; f++) {
      union(indices[3 * f], indices[3 * f + 1]);
      union(indices[3 * f], indices[3 * f + 2]);
    }
    const label = new Int32Array(nv).fill(-1);
    for (let f = 0; f < nt; f++) {
      const r = find(indices[3 * f]);
      if (label[r] < 0) label[r] = count++;
      region[f] = label[r];
    }
    return { region, count };
  }
  const { neighbours } = line ?? lineMesh(positions, indices);
  const mesh = prepareMesh(positions, indices);
  const N = mesh.normals;
  const smooth = Math.cos((30 * Math.PI) / 180);
  const queue = new Int32Array(nt);
  for (let f0 = 0; f0 < nt; f0++) {
    if (region[f0] >= 0) continue;
    region[f0] = count;
    let head = 0, tail = 0;
    queue[tail++] = f0;
    while (head < tail) {
      const f = queue[head++];
      for (let e = 0; e < 3; e++) {
        const g = neighbours[3 * f + e];
        if (g < 0 || region[g] >= 0) continue;
        if (N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2] < smooth) continue;
        region[g] = count;
        queue[tail++] = g;
      }
    }
    count++;
  }
  return { region, count };
}

/** Sides with faces reassigned by hand: overrides {face: SIDE_UPPER | SIDE_LOWER}. A new array. */
export function applyOverrides(side, region, overrides) {
  const out = Uint8Array.from(side);
  const entries = Object.entries(overrides ?? {});
  if (!entries.length) return out;
  const want = new Map(entries.map(([k, v]) => [Number(k), v]));
  for (let f = 0; f < out.length; f++) {
    const s = want.get(region[f]);
    if (s === SIDE_UPPER || s === SIDE_LOWER) out[f] = s;
  }
  return out;
}

// ------------------------------------------------------------------ directions

const round = (v, digits = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v ?? null);

/** The JSON of a parting line (without its segments). */
export function lineSummary(l) {
  return {
    planar: l.planar,
    kind: l.kind,
    height_range_mm: round(l.height_range_mm),
    length_mm: round(l.length_mm, 1),
    loops: l.loops,
    // Height of a planar line along d (in the frame of the model); the levels of a stepped one.
    ...(l.planar ? { level_mm: round((l.heights_mm[0] + l.heights_mm[1]) / 2, 2) } : {}),
    ...(l.kind === "stepped" ? { levels_mm: l.levels.map((h) => round(h, 2)) } : {}),
  };
}

/** The JSON of a classification of direction d. */
function directionSummary(mesh, d, areas, height, parting, source) {
  const total = mesh.totalArea || 1;
  return {
    axis: axisLabel(d),
    direction: d.map((x) => round(x, 6)),
    source,
    undercut_area_mm2: round(areas.undercut, 1),
    undercut_share: round(areas.undercut / total, 4),
    zero_draft_area_mm2: round(areas.zeroDraft, 1),
    zero_draft_share: round(areas.zeroDraft / total, 4),
    projected_area_mm2: round(areas.projected, 1),
    mould_height_mm: round(height, 2),
    parting: parting ? lineSummary(parting) : null,
  };
}

// A planar line first, then stepped (flat levels), then warped (a 3D die surface).
const LINE_RANK = { planar: 0, stepped: 1, warped: 2 };

/**
 * Ranking of two directions: less undercut first; then the simpler parting
 * line (a non-planar one only when it removes undercuts: a dearer die); then
 * less zero-draft surface; then the larger projected area for the height of
 * the part (a shallower mould).
 */
function better(a, b, total) {
  if (Math.abs(a.undercut - b.undercut) > UNDERCUT_TIE * total) return a.undercut - b.undercut;
  const pa = LINE_RANK[a.kind] ?? 0, pb = LINE_RANK[b.kind] ?? 0;
  if (pa !== pb) return pa - pb;
  if (Math.abs(a.zeroDraft - b.zeroDraft) > ZERO_DRAFT_TIE * total) return a.zeroDraft - b.zeroDraft;
  if (Math.abs(a.ratio - b.ratio) > RATIO_TIE * Math.max(a.ratio, b.ratio)) return b.ratio - a.ratio;
  return 0;
}

/** Tolerance of a planar line of a part `height` high along d. */
export const planarTolerance = (height) => Math.max(PLANAR_TOL_MM, PLANAR_TOL_SHARE * (height || 0));

/** Slivers take the half of a triangle next to them (their normal means nothing), from one to the next. */
function inheritSlivers(mesh, side, neighbours) {
  const { areas, sliver, nt } = mesh;
  let pending = [];
  for (let f = 0; f < nt; f++) if (areas[f] < sliver) pending.push(f);
  if (!pending.length) return;
  const known = new Uint8Array(nt).fill(1);
  for (const f of pending) known[f] = 0;
  while (pending.length) {
    const next = [], found = [];
    for (const f of pending) {
      let g = -1;
      for (let e = 0; e < 3 && g < 0; e++) {
        const n = neighbours[3 * f + e];
        if (n >= 0 && known[n]) g = n;
      }
      if (g < 0) next.push(f);
      else {
        side[f] = side[g];
        found.push(f);
      }
    }
    if (!found.length) break; // slivers alone: as they are
    for (const f of found) known[f] = 1;
    pending = next;
  }
}

/** A direction classified on every triangle: {areas, side, flags, plane, line, height}. */
function fullDirection(mesh, d, sinDraft, getLine) {
  const grid = lineGrid(mesh, d);
  const flags = classify(mesh, grid, d, null, sinDraft);
  const plane = planeHeight(mesh, flags, d, planarTolerance(grid.height));
  const side = sidesOf(mesh, flags, d, plane);
  inheritSlivers(mesh, side, getLine().neighbours);
  const line = partingLine(getLine(), side, d, { flags, plane, height: grid.height });
  return { areas: areasOf(mesh, d, flags, null), side, flags, plane, line, height: grid.height };
}

/**
 * Proposed draw direction and parting line of a closed body.
 *
 * positions, indices -- its mesh (mm); not modified
 * draftDeg -- faces closer than this to the draw direction have no draft
 * Returns {proposal, side, flags, plane, segments}: the JSON proposal
 * {status, axis, direction, candidate_index, candidates [...], sampled,
 * method, ... the figures of the direction chosen}, and for that direction,
 * per triangle, its half (SIDE_*) and flags (REACH_*, ZERO_DRAFT), the
 * height of its planar line along d (null: none), and the segments of its
 * parting line.
 */
export function proposeParting(positions, indices, { draftDeg = DEFAULT_DRAFT_DEG, fullLimit = FULL_LIMIT, samples = SAMPLES, seed = SEED, onProgress = null } = {}) {
  const mesh = prepareMesh(positions, indices);
  const sinDraft = Math.sin((draftDeg * Math.PI) / 180);
  const axes = candidateAxes(mesh);
  const sampled = mesh.nt > fullLimit;
  const list = sampled ? sampleByArea(mesh.areas, samples, seed) : null;
  let line = null;
  const getLine = () => (line ??= lineMesh(positions, indices, mesh.merged));
  const total = mesh.totalArea || 1;
  const steps = axes.length + (sampled ? 2 : 0);
  let step = 0;
  const progress = () => onProgress?.(Math.min(1, ++step / steps));

  const evaluated = axes.map(({ direction: d, source }) => {
    let item;
    if (!sampled) {
      item = { ...fullDirection(mesh, d, sinDraft, getLine), d, source };
    } else {
      const grid = lineGrid(mesh, d);
      const areas = areasOf(mesh, d, classify(mesh, grid, d, list, sinDraft), list);
      areas.zeroDraft = zeroDraftArea(mesh, d, sinDraft);
      item = { areas, height: grid.height, line: null, d, source };
    }
    progress();
    return item;
  });
  const key = (e) => ({ undercut: e.areas.undercut, zeroDraft: e.areas.zeroDraft, ratio: e.height > 0 ? e.areas.projected / e.height : 0, kind: e.line?.kind ?? null });
  if (sampled) {
    // The planarity of the lines of the best ones (as little undercut as the least): on every triangle.
    const least = Math.min(...evaluated.map((e) => e.areas.undercut));
    const tied = evaluated.filter((e) => e.areas.undercut - least <= UNDERCUT_TIE * total).sort((a, b) => better(key(a), key(b), total)).slice(0, 2);
    for (const e of tied) {
      const full = fullDirection(mesh, e.d, sinDraft, getLine);
      Object.assign(e, { side: full.side, flags: full.flags, plane: full.plane, line: full.line });
      progress();
    }
  }
  const order = evaluated.map((e, i) => i).sort((i, j) => better(key(evaluated[i]), key(evaluated[j]), total) || i - j);
  const best = evaluated[order[0]];
  if (!best.side) Object.assign(best, fullDirection(mesh, best.d, sinDraft, getLine));
  onProgress?.(1);

  const candidates = evaluated.map((e) => directionSummary(mesh, e.d, e.areas, e.height, e.line, e.source));
  const chosen = candidates[order[0]];
  return {
    proposal: {
      status: "proposed",
      version: PARTING_VERSION,
      ...chosen,
      candidate_index: order[0],
      ranking: order,
      candidates,
      draft_angle_deg: draftDeg,
      surface_area_mm2: round(mesh.totalArea, 1),
      triangles: mesh.nt,
      sampled: sampled ? { triangles: mesh.nt, samples, seed, by: "area" } : null,
      method: "line_of_sight_along_draw_direction_uniform_grid",
    },
    side: best.side,
    flags: best.flags,
    plane: best.plane,
    segments: best.line.segments,
  };
}

/**
 * One direction d of a body, classified on every triangle (a direction
 * chosen or typed by hand): {summary (as a candidate of proposeParting),
 * side, flags, plane, segments}.
 */
export function evaluateParting(positions, indices, direction, { draftDeg = DEFAULT_DRAFT_DEG } = {}) {
  const d = normalize(direction);
  if (!d) throw new Error("Invalid draw direction");
  const mesh = prepareMesh(positions, indices);
  const full = fullDirection(mesh, d, Math.sin((draftDeg * Math.PI) / 180), () => lineMesh(positions, indices, mesh.merged));
  return {
    summary: { ...directionSummary(mesh, d, full.areas, full.height, full.line, "manual"), draft_angle_deg: draftDeg, surface_area_mm2: round(mesh.totalArea, 1), triangles: mesh.nt },
    side: full.side,
    flags: full.flags,
    plane: full.plane,
    segments: full.line.segments,
  };
}
