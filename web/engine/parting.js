// Draw direction and parting line of a cast part (gravity die, low pressure,
// sand), proposed from the geometry of its closed triangle mesh (mm).
//
// For a draw direction d, a triangle is formed by the half of the mould it can
// leave the part from: lines from points of it, moved off the surface along
// its normal, meet no other triangle along +d -> the upper half can form it;
// along -d -> the lower half; neither -> an undercut, formed by a core or a
// slide. Its centre, and more points spread over a large or long triangle (the
// faces of a CAD body are fans of long triangles): each sense by the majority
// of them. Faces at less than the draft angle from d have no draft.
//
// The halves, and the parting line between them:
// - a plane leaves every triangle only one half can form on its side: a
//   planar line; the faces both halves can form, and the undercuts, on the
//   side of the plane, cut by it when across it;
// - else each triangle in the half that can form it (both: the upper one): a
//   stepped or warped line, round the undercut regions (each joins the half
//   it shares the longer border with);
// - unless that splits flat faces along d (no draft) between the halves:
//   the line would run across them along their triangles, round the shadow
//   each detail casts along d. Then, when it traps less surface than that
//   splits, the line is planar at the level that leaves the least surface
//   with draft on the wrong side: the faces along d on the side of the
//   plane, cut by it, and the faces with draft that only the other half
//   could form kept in theirs, trapped: undercuts (slides); of a face with
//   draft the plane cuts, its part on that side.
//
// The lines along d are tested against a uniform grid of the triangles
// projected on the plane normal to d (one grid per direction): a line meets
// only the triangles of its cell, and one walk gives both senses.
//
// Plain JavaScript without bare imports: it runs in the parting worker
// (partworker.js) and on the page (faces reassigned by hand).

import { edgeNeighbours, weld } from './thickness.js';

export const PARTING_VERSION = 2;

// Half of the mould of a triangle: none (an undercut), upper (+d), lower (-d).
export const SIDE_NONE = 0;
export const SIDE_UPPER = 1;
export const SIDE_LOWER = 2;
// Flags of a triangle for a direction.
export const REACH_UP = 1; // the upper half can form it: lines along +d leave the part
export const REACH_DOWN = 2; // the lower half: along -d
export const ZERO_DRAFT = 4; // |n.d| below the sine of the draft angle
export const LEVEL = 8; // in the half of its side of the planar line (cut by its plane when across it), not of its reach
export const TRAPPED = 16; // only one half could form it, kept in the other by the planar line: an undercut (slide), its REACH_* cleared

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
// Points of a triangle its lines of sight start from: its centre, and on a
// triangle larger or longer than the spacing, one per spacing of its longest
// edge or per spacing² of its area (the more), SAMPLE_MAX at most. The
// spacing: SAMPLE_DENSITY points over the surface, wider when the triangles
// would get more points besides their centres than a quarter of their count
// (SAMPLE_EXTRA_MIN at least): at most a quarter more lines than with the
// centres alone (a mesh of millions of small triangles: their centres only).
const SAMPLE_DENSITY = 20_000;
const SAMPLE_EXTRA_SHARE = 0.25;
const SAMPLE_EXTRA_MIN = 50_000;
const SAMPLE_MAX = 32;
const SAMPLE_FIRST = 4; // its first points all agree (both senses): the triangle is decided by them
const R2A = 0.7548776662466927; // 1/g, 1/g² (g the plastic number): a low-discrepancy sequence in the unit square
const R2B = 0.5698402909980532;
const SAMPLE_INSET = 0.98; // the points pulled towards the centre, off the edges
/** The sequence of the points of a triangle (see classify), for the slides (slides.js) to cast from the same points. */
export const SAMPLE_POINTS = { R2A, R2B, INSET: SAMPLE_INSET };
// A flat face along d (normals within 0.5°, joined by their edges) is split
// between the halves when each has more than this share of it (and than
// UNDERCUT_TIE of the surface): a line across it along its triangles.
const FLAT_FACET = Math.cos((0.5 * Math.PI) / 180);
const MIXED_SHARE = 0.05;

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

/**
 * Two directions the same, the same sense: within about 0.003°. Not unit
 * vectors: the directions of the JSON are rounded to 6 decimals.
 */
export const sameDirection = (a, b) => dot(a, b) > (1 - 1e-9) * Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);

/** A unit direction with the sense given; within 1° of an axis of the frame, that axis. */
export function snapDirection(v) {
  const c = canonicalAxis(v);
  if (!c) return null;
  return v[0] * c[0] + v[1] * c[1] + v[2] * c[2] < 0 ? c.map((x) => -x + 0) : c;
}

/** "0 0 1", "0;0;1", "0,5 0 1", "0.6, 0, 0.8", "(0.6, 0, 0.8)" (as axisLabel writes it), "X", "-z"… as a direction, or null. */
export function parseDirection(text) {
  const s = String(text ?? "").replace(/[()]/g, "").trim();
  const axis = /^([+-]?)([xyz])$/i.exec(s);
  if (axis) {
    const v = [0, 0, 0];
    v["xyz".indexOf(axis[2].toLowerCase())] = axis[1] === "-" ? -1 : 1;
    return v;
  }
  const v = parseTriple(s);
  return v ? snapDirection(v) : null;
}

/**
 * Three numbers typed in: "40 ; 10 ; 15,9", "40, 10, 15.9", "(40, 10, 15.9)",
 * "0,6 0 0,8"… as [x, y, z] (not normalised), or null.
 */
export function parseTriple(text) {
  const s = String(text ?? "").replace(/[()]/g, "").trim();
  // With a decimal point, commas are separators too; else spaces or semicolons
  // between the components (then a comma is a decimal comma, a comma at the
  // end of a component a separator), else commas.
  const parts = /\./.test(s)
    ? s.split(/[\s,;]+/)
    : /[\s;]/.test(s)
      ? s.split(/[\s;]+/).map((x) => x.replace(/,$/, "").replace(",", "."))
      : s.split(",");
  if (parts.length !== 3 || parts.some((x) => !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x))) return null;
  return parts.map(Number);
}

// ------------------------------------------------------------------ candidates

/** Eigenvectors of a symmetric 3×3 matrix (xx, xy, xz, yy, yz, zz; Jacobi), largest eigenvalue first. */
export function eigenvectors(m) {
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

/** Points of triangle f its lines of sight start from, at spacing h (see SAMPLE_DENSITY). */
function sampleCount(mesh, f, h) {
  if (!(mesh.areas[f] >= mesh.sliver)) return 1;
  return Math.min(SAMPLE_MAX, Math.max(1, Math.ceil(mesh.areas[f] / (h * h)), Math.ceil(mesh.reach[f] / h)));
}

/** The spacing of the points of the lines of sight of a mesh, computed once (the same for every direction). */
function sampleSpacing(mesh) {
  if (mesh.spacing) return mesh.spacing;
  const most = Math.max(SAMPLE_EXTRA_MIN, SAMPLE_EXTRA_SHARE * mesh.nt);
  let h = Math.sqrt(mesh.totalArea / SAMPLE_DENSITY) || mesh.diag || 1;
  for (;;) {
    let extra = 0;
    for (let f = 0; f < mesh.nt && extra <= most; f++) extra += sampleCount(mesh, f, h) - 1;
    if (extra <= most) return (mesh.spacing = h);
    h *= 1.25;
  }
}

/** True when the point at offset u of P comes before the one at v: by x, then y, then z. */
const before = (P, u, v) => P[u] < P[v] || (P[u] === P[v] && (P[u + 1] < P[v + 1] || (P[u + 1] === P[v + 1] && P[u + 2] < P[v + 2])));

/**
 * Flags (REACH_UP, REACH_DOWN, ZERO_DRAFT) of the triangles `list` (all when
 * null) for direction d: each sense reached from at least half of the points
 * of the triangle (its centre first, then a low-discrepancy sequence over it,
 * as many as sampleCount gives). A triangle drawn several times in `list`:
 * classified once.
 */
function classify(mesh, grid, d, list, sinDraft) {
  const { positions: P, indices: I, normals, centres, nt, diag } = mesh;
  const n = list ? list.length : nt;
  const flags = new Uint8Array(n);
  const known = list ? new Map() : null;
  const h = sampleSpacing(mesh);
  // Off the surface by more than the rounding of float32 positions, far less than a detail.
  const eps = diag * 1e-5;
  const tEps = diag * 1e-7;
  for (let s = 0; s < n; s++) {
    const f = list ? list[s] : s;
    const seen = known?.get(f);
    if (seen !== undefined) {
      flags[s] = seen;
      continue;
    }
    const nx = normals[3 * f], ny = normals[3 * f + 1], nz = normals[3 * f + 2];
    const nd = nx * d[0] + ny * d[1] + nz * d[2];
    let flag = Math.abs(nd) < sinDraft ? ZERO_DRAFT : 0;
    // A sliver (no area, a normal of no meaning, or none): either half, as its neighbours.
    if (mesh.areas[f] < mesh.sliver || !(nx || ny || nz)) {
      flags[s] = flag | REACH_UP | REACH_DOWN;
      known?.set(f, flags[s]);
      continue;
    }
    const cx = centres[3 * f], cy = centres[3 * f + 1], cz = centres[3 * f + 2];
    let k = sampleCount(mesh, f, h);
    // Its corners by position (x, then y, then z): the same points whichever corner it starts with, either winding.
    let a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    if (before(P, b, a)) [a, b] = [b, a];
    if (before(P, c, b)) [b, c] = [c, b];
    if (before(P, b, a)) [a, b] = [b, a];
    let up = 0, down = 0;
    for (let j = 0; j < k; j++) {
      // Its first SAMPLE_FIRST points (spread over it) agree both ways: the rest would not change the majority.
      if (j === SAMPLE_FIRST && up % SAMPLE_FIRST === 0 && down % SAMPLE_FIRST === 0) {
        k = SAMPLE_FIRST;
        break;
      }
      let x = cx, y = cy, z = cz;
      if (j) {
        let p = (0.5 + j * R2A) % 1, q = (0.5 + j * R2B) % 1;
        if (p + q > 1) {
          p = 1 - p;
          q = 1 - q;
        }
        x += SAMPLE_INSET * (P[a] + p * (P[b] - P[a]) + q * (P[c] - P[a]) - cx);
        y += SAMPLE_INSET * (P[a + 1] + p * (P[b + 1] - P[a + 1]) + q * (P[c + 1] - P[a + 1]) - cy);
        z += SAMPLE_INSET * (P[a + 2] + p * (P[b + 2] - P[a + 2]) + q * (P[c + 2] - P[a + 2]) - cz);
      }
      const hits = lineHits(mesh, grid, f, x + eps * nx, y + eps * ny, z + eps * nz, tEps);
      if (!(hits & 1)) up++;
      if (!(hits & 2)) down++;
    }
    if (2 * up >= k) flag |= REACH_UP;
    if (2 * down >= k) flag |= REACH_DOWN;
    flags[s] = flag;
    known?.set(f, flag);
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
 * Half of each triangle from its flags: the side it leaves by; none for an
 * undercut. With a planar line (height `plane`), a face both halves can form,
 * or flagged LEVEL: the side of its centre; else a face both can form, by the
 * sense of its normal, square to d: upper.
 */
export function sidesOf(mesh, flags, d, plane = null) {
  const { normals, centres, nt, centre } = mesh;
  const level = plane == null ? null : plane - dot(centre, d);
  const side = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue; // degenerate: no side
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if (!reach) continue;
    if (level != null && (flags[f] & LEVEL || reach === (REACH_UP | REACH_DOWN))) {
      side[f] = centres[3 * f] * d[0] + centres[3 * f + 1] * d[1] + centres[3 * f + 2] * d[2] - level < 0 ? SIDE_LOWER : SIDE_UPPER;
    } else if (reach === REACH_UP) side[f] = SIDE_UPPER;
    else if (reach === REACH_DOWN) side[f] = SIDE_LOWER;
    else side[f] = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2] + TIE < 0 ? SIDE_LOWER : SIDE_UPPER;
  }
  return side;
}

/**
 * The faces both halves can form and the undercuts, with a planar line:
 * flagged LEVEL (on the side of its plane, cut by it when across it).
 */
function levelFree(flags) {
  for (let f = 0; f < flags.length; f++) {
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if (reach !== REACH_UP && reach !== REACH_DOWN) flags[f] |= LEVEL;
  }
}

/**
 * Area of the flat faces along d (ZERO_DRAFT triangles joined by their
 * edges, normals within 0.5°: one plane) that sides split between the halves,
 * each half with more than MIXED_SHARE of the face and UNDERCUT_TIE of the
 * surface: the area of the smaller half of each. The line would run across
 * them along their triangles (round the shadows of the details standing on
 * them), not along their edges or straight.
 */
function splitFlatArea(mesh, neighbours, flags, side) {
  const { normals: N, areas, nt, totalArea, sliver } = mesh;
  const seen = new Uint8Array(nt);
  const queue = new Int32Array(nt);
  const flat = (f) => flags[f] & ZERO_DRAFT && areas[f] >= sliver;
  let split = 0;
  for (let f0 = 0; f0 < nt; f0++) {
    if (seen[f0] || !flat(f0)) continue;
    seen[f0] = 1;
    let head = 0, tail = 0, upper = 0, lower = 0;
    queue[tail++] = f0;
    while (head < tail) {
      const f = queue[head++];
      if (side[f] === SIDE_UPPER) upper += areas[f];
      else if (side[f] === SIDE_LOWER) lower += areas[f];
      for (let e = 0; e < 3; e++) {
        const g = neighbours[3 * f + e];
        if (g < 0 || seen[g] || !flat(g)) continue;
        if (N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2] < FLAT_FACET) continue;
        seen[g] = 1;
        queue[tail++] = g;
      }
    }
    const smaller = Math.min(upper, lower);
    if (smaller > Math.max(MIXED_SHARE * (upper + lower), UNDERCUT_TIE * totalArea)) split += smaller;
  }
  return split;
}

/**
 * Share of a triangle on the positive side of a height linear over it, g0,
 * g1, g2 at its corners (the side of a plane it is cut by).
 */
function positiveShare(g0, g1, g2) {
  const n = (g0 > 0) + (g1 > 0) + (g2 > 0);
  if (n === 0 || n === 3) return n / 3;
  // The corner alone on its side (the positive one, else the other), the share of the triangle on its side: the product of the parts of its two edges.
  const odd = n === 1;
  let alone;
  if ((g0 > 0) === odd) alone = (g0 * g0) / ((g0 - g1) * (g0 - g2));
  else if ((g1 > 0) === odd) alone = (g1 * g1) / ((g1 - g0) * (g1 - g2));
  else alone = (g2 * g2) / ((g2 - g0) * (g2 - g1));
  return odd ? alone : 1 - alone;
}

/**
 * Height along d (centred frame) of the plane of a planar line across
 * halves that interleave: the one that leaves the least area of faces with
 * draft that only one half can form on the other side of it (of a face it
 * cuts, its part on that side, as trapAtLevel counts it). Of the ranges of
 * heights as good that no such face spans, the widest (then the lowest), at
 * its middle: halfway between the details on either side; else the lowest
 * height where it is least. The faces without draft only one half can form
 * do not count (see trapAtLevel), but when there are no others.
 *
 * That area at height L: the faces only the lower half can form (σ = -1)
 * all, plus σ times the area under L of each face (0 below its lowest
 * corner, all of it above its highest, a quadratic of L between: one from
 * its lowest corner to its middle one, another to its highest), summed in a
 * sweep over the heights of the vertices. A part of a face less than 1e-5
 * of the diagonal high (or a face as flat): its change at one end, the end
 * that counts it the more (exact at its corners, never less than it is).
 */
function bestLevel(mesh, flags, d) {
  const { positions: P, indices: I, areas, nt, nv, sliver, totalArea, diag } = mesh;
  // The heights of the vertices; ascending, each once; the rank of each vertex among them.
  const hv = new Float64Array(nv);
  for (let i = 0; i < nv; i++) hv[i] = P[3 * i] * d[0] + P[3 * i + 1] * d[1] + P[3 * i + 2] * d[2];
  const levels = Float64Array.from(hv).sort();
  let m = 0;
  for (let i = 0; i < nv; i++) if (!m || levels[i] !== levels[m - 1]) levels[m++] = levels[i];
  const lo = levels[0], hi = levels[m - 1];
  // The faces that count.
  const counted = (f, withDraft) => {
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    return (reach === REACH_UP || reach === REACH_DOWN) && areas[f] >= sliver && !(withDraft && flags[f] & ZERO_DRAFT);
  };
  let withDraft = true;
  let n = 0;
  for (let f = 0; f < nt; f++) if (counted(f, true)) n++;
  if (!n) {
    withDraft = false;
    for (let f = 0; f < nt; f++) if (counted(f, false)) n++;
  }
  if (!n || !(hi > lo)) return (lo + hi) / 2 || 0;
  const rank = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    let a = 0, b = m - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (levels[mid] < hv[i]) a = mid + 1;
      else b = mid;
    }
    rank[i] = a;
  }
  // The corners of face f, lowest first (ties by their order in it): in `cs`.
  const cs = new Uint32Array(3);
  const corners = (f) => {
    let a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    if (hv[b] < hv[a]) [a, b] = [b, a];
    if (hv[c] < hv[b]) [b, c] = [c, b];
    if (hv[b] < hv[a]) [a, b] = [b, a];
    cs[0] = a;
    cs[1] = b;
    cs[2] = c;
  };
  // The events at each height: 3 f + k, the k-th corner of face f from the lowest.
  const start = new Uint32Array(m + 1);
  const events = new Uint32Array(3 * n);
  let wrong0 = 0; // below every vertex: the faces only the lower half can form, all on the wrong side
  for (let f = 0; f < nt; f++) {
    if (!counted(f, withDraft)) continue;
    if (!(flags[f] & REACH_UP)) wrong0 += areas[f];
    for (let k = 0; k < 3; k++) start[rank[I[3 * f + k]] + 1]++;
  }
  for (let r = 0; r < m; r++) start[r + 1] += start[r];
  const fill = start.slice(0, m);
  for (let f = 0; f < nt; f++) {
    if (!counted(f, withDraft)) continue;
    corners(f);
    for (let k = 0; k < 3; k++) events[fill[rank[cs[k]]]++] = 3 * f + k;
  }
  const thin = 1e-5 * diag;
  const tol = 1e-9 * totalArea;
  // The area at L: base + (qa L + qb) L + qc; the quadratic of the faces spanning L (`active` parts of faces), exactly 0 without any.
  let base = wrong0, qa = 0, qb = 0, qc = 0, active = 0;
  const at = (L) => base + (qa * L + qb) * L + qc;
  let flat = null; // the best range no face spans: {from, to, wrong}
  let point = null; // the least area at one height: {at, wrong}
  const range = (from, to) => {
    if (!(to > from)) return;
    if (!active) {
      // Ties within a part in 1e9 of the surface: the widest, then the lowest.
      if (!flat || base < flat.wrong - tol || (base <= flat.wrong + tol && to - from > flat.to - flat.from)) flat = { from, to, wrong: Math.min(base, flat?.wrong ?? Infinity) };
    } else if (qa > 0) {
      const L = -qb / (2 * qa);
      if (L > from && L < to && (!point || at(L) < point.wrong - tol)) point = { at: L, wrong: at(L) };
    }
  };
  // At a height x: `rise`, how much more than the area at x the sum counts once the faces with a corner there are passed (a change at one end, up).
  let rise = 0;
  const step = (dA, up = 0) => {
    base += dA;
    rise += up;
  };
  // σ k (L - h)², σ (A - k (h - L)²): the quadratic of a part of a face, added (sign 1) or taken away (-1).
  const lower = (sign, k1, h0) => {
    qa += sign * k1;
    qb -= sign * 2 * k1 * h0;
    qc += sign * k1 * h0 * h0;
    active += sign;
  };
  const upper = (sign, A, k2, h2) => {
    qa -= sign * k2;
    qb += sign * 2 * k2 * h2;
    qc += sign * (A - k2 * h2 * h2);
    active += sign;
  };
  let from = lo;
  for (let r = 0; r < m; r++) {
    if (start[r] === start[r + 1]) continue; // no face that counts has a corner there
    const x = levels[r];
    range(from, x);
    rise = 0;
    for (let e = start[r]; e < start[r + 1]; e++) {
      const f = Math.floor(events[e] / 3), k = events[e] % 3;
      const s = flags[f] & REACH_UP ? 1 : -1, A = s * areas[f]; // σ × its area
      corners(f);
      const h0 = hv[cs[0]], h1 = hv[cs[1]], h2 = hv[cs[2]];
      const span = h2 - h0;
      if (!(span > thin)) {
        // As flat as a plane square to d: all of it at once, at its lowest corner up (at its highest, down).
        if (s > 0 && k === 0) step(A, A);
        else if (s < 0 && k === 2) step(A);
        continue;
      }
      const low = h1 - h0 > thin, high = h2 - h1 > thin;
      const J = (A * (h1 - h0)) / span; // σ × its area under its middle corner
      if (k === 0) {
        if (low) lower(1, A / ((h1 - h0) * span), h0);
        else if (s > 0) step(J, J);
      } else if (k === 1) {
        if (low) lower(-1, A / ((h1 - h0) * span), h0);
        else if (s > 0) step(-J);
        if (high) upper(1, A, A / ((h2 - h1) * span), h2);
        else if (s > 0) step(A, A - J);
        else step(J);
      } else if (high) {
        upper(-1, A, A / ((h2 - h1) * span), h2);
        step(A);
      } else if (s < 0) step(A - J);
    }
    if (!active) qa = qb = qc = 0;
    const here = at(x) - rise;
    if (!point || here < point.wrong - tol) point = { at: x, wrong: here };
    from = x;
  }
  range(from, hi);
  // A range as good as the least (within a part in a million of the surface: the rounding of the sums of the quadratics), else that height.
  if (flat && (!point || flat.wrong <= point.wrong + 1e-6 * totalArea)) return (flat.from + flat.to) / 2;
  return point ? point.at : (lo + hi) / 2;
}

/**
 * The flags of the halves split by a plane at height `level` (centred frame)
 * along d: every triangle on its side (LEVEL); of a face with draft only one
 * half can form, its part on the other side is trapped (the area of a face
 * the plane cuts, from the heights of its corners): TRAPPED when that is
 * more than half of it (an undercut, its REACH_* cleared). The faces without
 * draft keep their reach: on the side of the plane, cut straight by it; what
 * keeps a half from forming one on the wrong side is the shadow of a detail
 * standing on it, whose faces with draft are trapped (the slide that forms
 * them forms that strip of flat face too: not counted, it would follow the
 * triangles of the face). A new array, and the area trapped.
 */
function trapAtLevel(mesh, flags, d, level) {
  const { positions: P, indices: I, nt, areas, sliver } = mesh;
  const tiny = 1e-9 * Math.max(1, mesh.diag);
  const out = new Uint8Array(nt);
  let trapped = 0;
  // Height of a corner on the wrong side of the plane (positive there); on it within `tiny`: 0.
  const wrongSide = (v, s) => {
    const h = P[3 * v] * d[0] + P[3 * v + 1] * d[1] + P[3 * v + 2] * d[2] - level;
    return Math.abs(h) <= tiny ? 0 : s * h;
  };
  for (let f = 0; f < nt; f++) {
    out[f] = flags[f] | LEVEL;
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if ((reach !== REACH_UP && reach !== REACH_DOWN) || flags[f] & ZERO_DRAFT || !(areas[f] >= sliver)) continue;
    const s = reach === REACH_UP ? -1 : 1; // only the upper half can form it: below the plane is wrong
    const share = positiveShare(wrongSide(I[3 * f], s), wrongSide(I[3 * f + 1], s), wrongSide(I[3 * f + 2], s));
    trapped += share * areas[f];
    if (share > 0.5) out[f] = (out[f] & ~(REACH_UP | REACH_DOWN)) | TRAPPED;
  }
  return { flags: out, trapped };
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
  let undercut = 0, trapped = 0, zeroDraft = 0, projected = 0;
  const n = list ? list.length : nt;
  for (let s = 0; s < n; s++) {
    const f = list ? list[s] : s;
    const w = list ? totalArea / n : areas[f];
    const flag = flags[s];
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue;
    const nd = normals[3 * f] * d[0] + normals[3 * f + 1] * d[1] + normals[3 * f + 2] * d[2];
    if (!(flag & (REACH_UP | REACH_DOWN))) undercut += w;
    if (flag & TRAPPED) trapped += w;
    if (flag & ZERO_DRAFT) zeroDraft += w;
    if (flag & (REACH_UP | TRAPPED) && nd > 0) projected += w * nd;
  }
  return { undercut, trapped, zeroDraft, projected };
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
 * The halves of the undercut triangles (SIDE_NONE: a core or a slide), for
 * the line only: it goes round an undercut region, it does not stop at it.
 * With a planar line (`plane`), the side of the plane of their centres (cut
 * by it when across it, see partingLine); else each region of them (joined
 * by their edges) in the half it shares the longer border with (the line
 * follows its shorter one), ties the upper one. A new array, or `side` itself
 * without undercuts.
 */
function undercutHalves(line, side, d, plane) {
  const { positions: P, indices: I, neighbours } = line;
  const nt = I.length / 3;
  let first = -1;
  for (let f = 0; f < nt && first < 0; f++) if (side[f] === SIDE_NONE) first = f;
  if (first < 0) return side;
  const out = Uint8Array.from(side);
  const w = (r) => P[3 * r] * d[0] + P[3 * r + 1] * d[1] + P[3 * r + 2] * d[2];
  if (plane != null) {
    for (let f = first; f < nt; f++) {
      if (side[f] === SIDE_NONE) out[f] = (w(I[3 * f]) + w(I[3 * f + 1]) + w(I[3 * f + 2])) / 3 < plane ? SIDE_LOWER : SIDE_UPPER;
    }
    return out;
  }
  const queue = new Int32Array(nt);
  const seen = new Uint8Array(nt);
  for (let f0 = first; f0 < nt; f0++) {
    if (side[f0] !== SIDE_NONE || seen[f0]) continue;
    seen[f0] = 1;
    let head = 0, tail = 0, upper = 0, lower = 0;
    queue[tail++] = f0;
    while (head < tail) {
      const f = queue[head++];
      for (let e = 0; e < 3; e++) {
        const g = neighbours[3 * f + e];
        if (g < 0) continue;
        if (side[g] === SIDE_NONE) {
          if (!seen[g]) {
            seen[g] = 1;
            queue[tail++] = g;
          }
          continue;
        }
        const ra = 3 * I[3 * f + e], rb = 3 * I[3 * f + ((e + 1) % 3)];
        const len = Math.hypot(P[rb] - P[ra], P[rb + 1] - P[ra + 1], P[rb + 2] - P[ra + 2]);
        if (side[g] === SIDE_UPPER) upper += len;
        else lower += len;
      }
    }
    const half = lower > upper ? SIDE_LOWER : SIDE_UPPER;
    for (let k = 0; k < tail; k++) out[queue[k]] = half;
  }
  return out;
}

/**
 * Parting line of a split into halves: where the surface goes from the upper
 * half to the lower one, round the undercut regions (undercutHalves). Along
 * the edges between triangles of the two halves, and, with a planar line
 * (`plane`: its height along d), across the faces both halves can form, the
 * undercuts and the faces flagged LEVEL (`flags`), cut at that height,
 * unless reassigned by hand (`fixed`).
 *
 * side   -- half of each triangle (SIDE_*)
 * height -- of the part along d, for the planarity tolerance
 * Returns {segments (Float32Array, xyz of both ends of each piece),
 * length_mm, loops, planar, kind ("planar", "stepped", "warped", or null
 * without a line), height_range_mm, heights_mm [lowest, highest] along d,
 * level (the height most of its length is at: the median), levels (heights
 * of its level runs)}.
 */
export function partingLine(line, side, d, { flags = null, plane = null, fixed = null, height = null } = {}) {
  const { positions: P, indices: I, welded, neighbours } = line;
  const nt = I.length / 3;
  const w = (r) => P[3 * r] * d[0] + P[3 * r + 1] * d[1] + P[3 * r + 2] * d[2];
  const tiny = 1e-9 * Math.max(1, Math.abs(plane ?? 0), height ?? 0);
  side = undercutHalves(line, side, d, plane);
  // A face both halves can form, an undercut or a face flagged LEVEL, across the plane: its side changes at the plane.
  const split = (f) => {
    if (plane == null || !flags || fixed?.[f] || !(flags[f] & LEVEL || isFree(flags[f]))) return false;
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
  // Per triangle: 0 not known yet, 1 not cut, 2 cut (a typed array: every triangle of a large mesh).
  const splitState = new Uint8Array(nt);
  const isSplit = (f) => (splitState[f] ||= split(f) ? 2 : 1) === 2;

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
  for (let f = 0; f < nt; f++) {
    if (splitState[f] !== 2) continue;
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
  // The ends measured in double precision, written to float32 for the display.
  const ends = new Float64Array(6 * m);
  pieces.forEach(([a, b], k) => {
    ends.set(a, 6 * k);
    ends.set(b, 6 * k + 3);
  });
  const segments = Float32Array.from(ends);
  if (!m) return { segments, length_mm: 0, loops: 0, planar: null, kind: null, height_range_mm: null, heights_mm: null, level: null, levels: [] };

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
  const shape = lineShape(ends, d, { height, loops });
  return { segments, length_mm: shape.length_mm, loops, planar: shape.planar, kind: shape.kind, height_range_mm: shape.height_range_mm, heights_mm: shape.heights_mm, level: shape.level, levels: shape.levels };
}

/**
 * Shape of a parting line from its pieces (Float64Array, xyz of both ends of
 * each, in double precision): its length, its heights along d, planar (95 %
 * of its length within the planarity tolerance of one height), stepped (most
 * of it in level runs at two heights or more) or warped. Shared by the line
 * of a split into halves (partingLine) and the line drawn by hand.
 *
 * height -- of the part along d, for the planarity tolerance (else the span of the line)
 * loops -- the number of loops of the line, counted by the caller
 * Returns {length_mm, planar, kind ("planar", "stepped", "warped", or null
 * without a line), height_range_mm, heights_mm [lowest, highest] along d,
 * level (the median height by length), levels (heights of its level runs),
 * loops}.
 */
export function lineShape(pieces, d, { height = null, loops = 0 } = {}) {
  const m = Math.floor(pieces.length / 6);
  if (!m) return { length_mm: 0, planar: null, kind: null, height_range_mm: null, heights_mm: null, level: null, levels: [], loops };
  const hOf = (k) => pieces[k] * d[0] + pieces[k + 1] * d[1] + pieces[k + 2] * d[2];
  let length = 0, lo = Infinity, hi = -Infinity;
  const lengths = new Float64Array(m);
  const ha = new Float64Array(m), hb = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const s = 6 * k;
    lengths[k] = Math.hypot(pieces[s + 3] - pieces[s], pieces[s + 4] - pieces[s + 1], pieces[s + 5] - pieces[s + 2]);
    length += lengths[k];
    ha[k] = hOf(s);
    hb[k] = hOf(s + 3);
    lo = Math.min(lo, ha[k], hb[k]);
    hi = Math.max(hi, ha[k], hb[k]);
  }

  const span = hi - lo;
  const tol = Math.max(PLANAR_TOL_MM, PLANAR_TOL_SHARE * (height ?? span));
  // Planar: 95 % of its length within ±tol of one height (the median). A line
  // along the edges of a curved silhouette zigzags by a facet: still planar.
  const byHeight = Array.from({ length: m }, (_, k) => [(ha[k] + hb[k]) / 2, lengths[k], Math.abs(hb[k] - ha[k]) / 2]).sort((x, y) => x[0] - y[0]);
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
  for (let k = 0; k < m; k++) {
    if (Math.abs(hb[k] - ha[k]) > tol) continue;
    levelLength += lengths[k];
    runs.push([(ha[k] + hb[k]) / 2, lengths[k]]);
  }
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
  return { length_mm: length, planar, kind, height_range_mm: span, heights_mm: [lo, hi], level: median, levels: kept, loops };
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

// ------------------------------------------------------------------ mould halves

// Margin of the halves of the mould shown round a body: the larger of these.
const BLOCK_MARGIN_MM = 5;
const BLOCK_MARGIN_SHARE = 0.15; // of its largest size
// Interface of a line that is not planar: heights at the nodes of a grid of
// at most this many cells a side, from at most this many points of the line.
export const BLOCK_GRID = 48;
export const BLOCK_POINTS = 2048;

/**
 * At most `max` points spread evenly along segments (xyz of both ends of
 * each piece; a long straight edge of a CAD body is one piece), as xyz.
 */
function pointsAlong(segments, max) {
  const m = segments ? Math.floor(segments.length / 6) : 0;
  let total = 0;
  for (let k = 0; k < m; k++) {
    const s = 6 * k;
    total += Math.hypot(segments[s + 3] - segments[s], segments[s + 4] - segments[s + 1], segments[s + 5] - segments[s + 2]);
  }
  if (!m || !(total > 0)) return new Float64Array(m ? 3 : 0).map((_, c) => segments[c]);
  const step = total / max;
  const out = new Float64Array(3 * max);
  let n = 0;
  let next = step / 2; // the middle of each step
  let walked = 0;
  for (let k = 0; k < m && n < max; k++) {
    const s = 6 * k;
    const len = Math.hypot(segments[s + 3] - segments[s], segments[s + 4] - segments[s + 1], segments[s + 5] - segments[s + 2]);
    while (next <= walked + len && n < max) {
      const t = len > 0 ? (next - walked) / len : 0;
      for (let c = 0; c < 3; c++) out[3 * n + c] = segments[s + c] + t * (segments[s + 3 + c] - segments[s + c]);
      n++;
      next += step;
    }
    walked += len;
  }
  return out.subarray(0, 3 * n);
}

/**
 * The two halves of the mould round a body, to show: two closed triangle
 * meshes (blocks), the lower one under the parting surface, the upper one
 * over it. In the frame of the draw direction d and two axes u, v square to
 * it: their footprint is the extent of the body across d plus a margin (the
 * larger of 5 mm and 15 % of its largest size); the lower block goes from
 * the margin under the body up to the parting surface, the upper one from it
 * to the margin over the body. The parting surface is flat at the height of
 * a planar line (`level`, clamped to the extent of the body along d: -/+
 * Infinity under or over it); else a height field over a grid of at most 48
 * cells a side, interpolated from points spread along the line (inverse
 * distance weighting, at most 2048 points; the height of a node follows the
 * points nearest to it), within the extent of the body along d. Without a
 * line nor a level: under the body.
 *
 * positions -- of the body (xyz, mm); only its extent is used
 * direction -- the draw direction (the upper half leaves along it)
 * segments -- of its parting line (xyz of both ends of each piece), or null
 * level -- height along d of a planar line (in the frame of the positions), or null
 * Returns {lower, upper: {positions (Float32Array), indices (Uint32Array),
 * edges (Float32Array, xyz of both ends of each: the outlines of its two
 * faces, its vertical corners)}, frame: {d, u, v}, cells: [nu, nv], heights (Float64Array, along d, of the
 * (nu + 1) × (nv + 1) nodes of the interface, node (i, j) at i × (nv + 1) +
 * j), extent: {u, v, w: [min, max] of the body}, margin}; null for a body
 * without vertices or a direction of no length.
 */
export function mouldBlocks(positions, direction, { segments = null, level = null, grid = BLOCK_GRID, points = BLOCK_POINTS } = {}) {
  const d = normalize(direction);
  const nv = Math.floor(positions.length / 3);
  if (!d || !nv) return null;
  const [u, v] = basis(d);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, wmin = Infinity, wmax = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const a = x * u[0] + y * u[1] + z * u[2], b = x * v[0] + y * v[1] + z * v[2], w = x * d[0] + y * d[1] + z * d[2];
    if (a < umin) umin = a;
    if (a > umax) umax = a;
    if (b < vmin) vmin = b;
    if (b > vmax) vmax = b;
    if (w < wmin) wmin = w;
    if (w > wmax) wmax = w;
  }
  const margin = Math.max(BLOCK_MARGIN_MM, BLOCK_MARGIN_SHARE * Math.max(umax - umin, vmax - vmin, wmax - wmin));
  const u0 = umin - margin, v0 = vmin - margin;
  const W = umax - umin + 2 * margin, H = vmax - vmin + 2 * margin;
  const bottom = wmin - margin, top = wmax + margin;
  const clamp = (h) => (h > wmax ? wmax : h >= wmin ? h : wmin); // NaN: under the body

  // The interface: flat (one cell), or heights from the points of the line.
  const along = level == null ? pointsAlong(segments, Math.max(1, points)) : null;
  let nu = 1, nvv = 1;
  let heights;
  if (!along?.length) {
    heights = new Float64Array(4).fill(clamp(level ?? -Infinity));
  } else {
    // Cells about square: `grid` along the longer side of the footprint.
    const g = Math.max(2, Math.floor(grid));
    nu = W >= H ? g : Math.max(2, Math.round((g * W) / H));
    nvv = H >= W ? g : Math.max(2, Math.round((g * H) / W));
    const n = along.length / 3;
    const pa = new Float64Array(n), pb = new Float64Array(n), pw = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const x = along[3 * k], y = along[3 * k + 1], z = along[3 * k + 2];
      pa[k] = x * u[0] + y * u[1] + z * u[2];
      pb[k] = x * v[0] + y * v[1] + z * v[2];
      pw[k] = x * d[0] + y * d[1] + z * d[2];
    }
    // Weights 1 / r⁶: a node near the line takes its height there (flat by a
    // level run of it), between two runs the surface goes from one height to
    // the other.
    const eps = (1e-3 * Math.max(W / nu, H / nvv)) ** 2;
    heights = new Float64Array((nu + 1) * (nvv + 1));
    for (let i = 0; i <= nu; i++) {
      const a = u0 + (W * i) / nu;
      for (let j = 0; j <= nvv; j++) {
        const b = v0 + (H * j) / nvv;
        let sum = 0, weights = 0;
        for (let k = 0; k < n; k++) {
          const da = a - pa[k], db = b - pb[k];
          const r2 = da * da + db * db + eps;
          const weight = 1 / (r2 * r2 * r2);
          weights += weight;
          sum += weight * pw[k];
        }
        heights[i * (nvv + 1) + j] = clamp(sum / weights);
      }
    }
  }

  // Each block: the interface nodes, then the same nodes on its flat face
  // (under the body for the lower one, over it for the upper one), the walls
  // between their outlines. Triangles turned outwards ((u, v, d) is right-handed).
  const nodes = (nu + 1) * (nvv + 1);
  const at = (i, j) => i * (nvv + 1) + j;
  const outline = [];
  for (let i = 0; i < nu; i++) outline.push(at(i, 0));
  for (let j = 0; j < nvv; j++) outline.push(at(nu, j));
  for (let i = nu; i > 0; i--) outline.push(at(i, nvv));
  for (let j = nvv; j > 0; j--) outline.push(at(0, j));
  const block = (flat, interfaceOnTop) => {
    const P = new Float32Array(6 * nodes);
    for (let i = 0; i <= nu; i++) {
      const a = u0 + (W * i) / nu;
      for (let j = 0; j <= nvv; j++) {
        const b = v0 + (H * j) / nvv;
        const k = at(i, j);
        for (const [node, w] of [[k, heights[k]], [k + nodes, flat]]) {
          for (let c = 0; c < 3; c++) P[3 * node + c] = a * u[c] + b * v[c] + w * d[c];
        }
      }
    }
    const I = new Uint32Array(3 * (4 * nu * nvv + 2 * outline.length));
    let t = 0;
    const tri = (a, b, c) => {
      I[t++] = a;
      I[t++] = b;
      I[t++] = c;
    };
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nvv; j++) {
        const p00 = at(i, j), p10 = at(i + 1, j), p11 = at(i + 1, j + 1), p01 = at(i, j + 1);
        // Seen from +d, (p00, p10, p11) turns counter-clockwise: its normal is +d.
        const [top, under] = interfaceOnTop ? [0, nodes] : [nodes, 0];
        tri(p00 + top, p10 + top, p11 + top);
        tri(p00 + top, p11 + top, p01 + top);
        tri(p00 + under, p11 + under, p10 + under);
        tri(p00 + under, p01 + under, p11 + under);
      }
    }
    // The outline turns counter-clockwise seen from +d: (q - p) × d points outwards.
    for (let k = 0; k < outline.length; k++) {
      const p = outline[k], q = outline[(k + 1) % outline.length];
      const [lo, hi] = interfaceOnTop ? [nodes, 0] : [0, nodes];
      tri(p + lo, q + lo, q + hi);
      tri(p + lo, q + hi, p + hi);
    }
    // Its edges, to draw: the outlines of its two faces and its four vertical corners.
    const E = new Float32Array(6 * (2 * outline.length + 4));
    let e = 0;
    const edge = (a, b) => {
      E.set(P.subarray(3 * a, 3 * a + 3), e);
      E.set(P.subarray(3 * b, 3 * b + 3), e + 3);
      e += 6;
    };
    for (let k = 0; k < outline.length; k++) {
      const p = outline[k], q = outline[(k + 1) % outline.length];
      edge(p, q);
      edge(p + nodes, q + nodes);
    }
    for (const c of [at(0, 0), at(nu, 0), at(nu, nvv), at(0, nvv)]) edge(c, c + nodes);
    return { positions: P, indices: I, edges: E };
  };
  return {
    lower: block(bottom, true),
    upper: block(top, false),
    frame: { d, u, v },
    cells: [nu, nvv],
    heights,
    extent: { u: [umin, umax], v: [vmin, vmax], w: [wmin, wmax] },
    margin,
  };
}

// ------------------------------------------------------------------ directions

const round =(v, digits = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v ?? null);

/** The JSON of a parting line (without its segments). */
export function lineSummary(l) {
  return {
    planar: l.planar,
    kind: l.kind,
    height_range_mm: round(l.height_range_mm),
    length_mm: round(l.length_mm, 1),
    loops: l.loops,
    // Height of a planar line along d (in the frame of the model): the one it is
    // planar at (a short detour off it does not move it); the levels of a stepped one.
    ...(l.planar ? { level_mm: round(l.level, 2) } : {}),
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
    // Of it, faces only one half could form, kept in the other by the planar line (slides): of those it cuts, their parts there.
    trapped_area_mm2: round(areas.trapped ?? 0, 1),
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

/**
 * A direction classified on every triangle: {areas, side, flags, plane, line,
 * height}. A plane that leaves every triangle one half only can form on its
 * side: a planar line. Else each triangle in its half: a stepped or warped
 * line, unless that splits flat faces along d between the halves (round the
 * shadows of the details on them) over more area than a planar line at the
 * best level traps (bestLevel, trapAtLevel): then that planar line.
 */
function fullDirection(mesh, d, sinDraft, getLine) {
  const grid = lineGrid(mesh, d);
  let flags = classify(mesh, grid, d, null, sinDraft);
  let plane = planeHeight(mesh, flags, d, planarTolerance(grid.height));
  const split = (plane) => {
    const side = sidesOf(mesh, flags, d, plane);
    inheritSlivers(mesh, side, getLine().neighbours);
    return { side, line: partingLine(getLine(), side, d, { flags, plane, height: grid.height }) };
  };
  let halves;
  let trapped = null;
  if (plane != null) {
    levelFree(flags);
    halves = split(plane);
  } else {
    halves = split(null);
    const across = halves.line.planar ? 0 : splitFlatArea(mesh, getLine().neighbours, flags, halves.side);
    if (across > 0) {
      const level = bestLevel(mesh, flags, d);
      const trap = trapAtLevel(mesh, flags, d, level);
      if (trap.trapped <= across) {
        flags = trap.flags;
        trapped = trap.trapped;
        plane = level + dot(mesh.centre, d);
        halves = split(plane);
      }
    }
  }
  const areas = areasOf(mesh, d, flags, null);
  if (trapped != null) {
    // What the plane leaves on the wrong side, the parts of the faces it cuts too (not their triangles flagged TRAPPED, more than half there).
    areas.undercut += trapped - areas.trapped;
    areas.trapped = trapped;
  }
  return { areas, side: halves.side, flags, plane, line: halves.line, height: grid.height };
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
      // Its exact areas too: the figures shown are those of the faces coloured.
      const full = fullDirection(mesh, e.d, sinDraft, getLine);
      Object.assign(e, { areas: full.areas, side: full.side, flags: full.flags, plane: full.plane, line: full.line });
      progress();
    }
  }
  // A candidate without its line ranks as if it were planar: the best one
  // classified on every triangle until it has one, and ranked again (six
  // rounds at most).
  let order;
  for (;;) {
    order = evaluated.map((e, i) => i).sort((i, j) => better(key(evaluated[i]), key(evaluated[j]), total) || i - j);
    const top = evaluated[order[0]];
    if (top.side) break;
    Object.assign(top, fullDirection(mesh, top.d, sinDraft, getLine));
  }
  const best = evaluated[order[0]];
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
  let line = null;
  const full = fullDirection(mesh, d, Math.sin((draftDeg * Math.PI) / 180), () => (line ??= lineMesh(positions, indices, mesh.merged)));
  return {
    summary: { ...directionSummary(mesh, d, full.areas, full.height, full.line, "manual"), draft_angle_deg: draftDeg, surface_area_mm2: round(mesh.totalArea, 1), triangles: mesh.nt },
    side: full.side,
    flags: full.flags,
    plane: full.plane,
    segments: full.line.segments,
  };
}
