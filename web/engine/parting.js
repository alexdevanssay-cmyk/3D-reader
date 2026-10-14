// Draw direction and parting line of a cast part (gravity die, low pressure,
// sand), proposed from the geometry of its closed triangle mesh (mm).
//
// For a draw direction d, a triangle is formed by the half of the mould it can
// leave the part from: lines from points of it, moved off the surface along
// its normal, meet no other triangle along +d -> the upper half can form it;
// along -d -> the lower half; neither -> an undercut, formed by a core or a
// slide. Its centre, and more points spread over a large or long triangle (the
// faces of a CAD body are fans of long triangles): each sense by the majority
// of them, the shares of them kept as the evidence of the triangle. Faces at
// less than the draft angle from d have no draft.
//
// The halves are optimised over the whole surface (optimiseHalves): two exact
// minimum cuts of the triangles (mincut.js), the cost of each label from the
// evidence of the triangle times its area, plus a tension λ (about 1.5 mm)
// times the length of the line, lighter where the surface turns from one half
// to the other: the undercuts first, then the upper and lower halves. A
// region too small or thin for the line round it (a spike, a tooth, a small
// loop) goes to the half round it; a slot, a hole, a boss keep their own.
//
// The halves, and the parting line between them:
// - a plane leaves every triangle only one half can form on its side: a
//   planar line; the faces both halves can form, and the undercuts, on the
//   side of the plane, cut by it when across it;
// - else the halves of the optimum: a line across the triangles (along the
//   silhouettes of curved faces, the edges of the shadows, an iso-line of
//   the halves over small facets), not along their edges, round the undercut
//   regions (each joins the half its heavier border is with); planar when
//   all of it is within the planar tolerance of one height (then that plane);
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
// The orientation of each direction for the casting process (orientation.js):
// its die block (the steel blank), which ranks the directions too
// (proposeParting), and the direction up when the metal is cast, which does
// not: the die and its undercuts depend on the part and the draw direction,
// not on where the metal comes in; the process decides which way is up.
//
// Plain JavaScript without bare imports: it runs in the parting worker
// (partworker.js) and on the page (faces reassigned by hand).

import { minCut } from './mincut.js';
import { STEEL_TIE, normalizeDie, normalizeProcess, orientationFor, orientationKey, orientationMesh } from './orientation.js';
import { edgeNeighbours, weld } from './thickness.js';

// 3: the line on curved faces and long thin CAD triangles (silhouettes,
// shadows); the directions ranked by their die block too, each with its
// orientation for the process; d turned so that up is +d on a horizontal
// parting plane.
// 4: the halves optimised over the surface (minimum cuts: no spikes, teeth,
// small loops), the line across small facets along an iso-line.
export const PARTING_VERSION = 4;

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
export const SILHOUETTE = 32; // across the silhouette of a curved face between the halves: in the half of its centre, cut by the silhouette (n·d = 0 between its corners)
export const SHADOW = 64; // across the edge of a shadow along d inside a face between the halves (or an undercut): in the half of most of it, cut by that edge
// Both: across the line of the optimised halves inside a smooth surface, neither a silhouette nor the edge of a
// shadow: cut along the zero of the halves smoothed round it (isoField), in the half of its side of it.
export const ISO_CUT = SILHOUETTE | SHADOW;
/** How a triangle is cut by its flags (without a plane): 0, SILHOUETTE, SHADOW or ISO_CUT. */
const cutOf = (flag) => flag & ISO_CUT;
// The mode of lineCuts of each (none: of a shadow, as it was).
const MODE_OF = { 0: 3, [SILHOUETTE]: 2, [SHADOW]: 3, [ISO_CUT]: 4 };

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
// The lines of sight of a facet of a curved surface start this share of how
// far its neighbours on it bend off its plane further off it (see surfaceOf),
// at most SAG_MAX of the diagonal.
const SAG_SHARE = 0.25;
const SAG_MAX = 5e-3;
// A line of sight grazes a facet of a curved surface whose plane passes within this many of their stand-offs of its start (lineHits).
const GRAZE = 8;
// n·d of a triangle off by up to 4 × this × its largest coordinate / its smallest height (float32 positions).
const ROUNDING_NOISE = 4 * 2 ** -24;
// The silhouette of a curved face between the halves: n·d at its corners of either sign beyond this, at most
// this share of the border of its band beside a triangle in the half of the other side of it.
const SILHOUETTE_TINY = 1e-9;
const SILHOUETTE_DISAGREE = 0.25;
// A hook of the line: a piece shorter than this share of its size, turning back by more than 135° (cosine) (unhook).
const HOOK_SHARE = 0.01;
const HOOK_TURN = Math.cos((45 * Math.PI) / 180);
const FOLD_TURN = Math.cos((10 * Math.PI) / 180);
// The colours follow a hook taken out on the triangles whose plane it is in, within this share of its size (partingPieces).
const HOOK_PLANE = 0.01;
// A small loop of the line taken out: at most this many pieces (dropSmallLoops).
const SMALL_LOOP_PIECES = 64;
// The triangles crossed by the edges of the shadows: at most this share of them (at least SHADOW_MIN) (shadowHalves).
const SHADOW_MAX = 0.05;
const SHADOW_MIN = 20_000;
// Their points of an edge look from inside the triangle by 2 % of its height there, this share of the diagonal at most.
const SHADOW_INSET = 1e-3;
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
// The tension of the parting line (optimiseHalves, mm): 1.5 mm, at most 1 %
// of the diagonal of a small part.
const TENSION_MM = 1.5;
const TENSION_SHARE = 0.01;
// A region of triangles blocked both ways by their points is noise of the lines of sight, formed by the half round
// it, when its area is under this share of the line's tension times its border (noiseUndercuts): narrower than
// 0.2 mm, a lone triangle under about 0.6 mm (a point or two of a small facet at the edge of a shadow). Every other is
// reported as an undercut, its area and its slides, whatever the line does round it (a groove, a window in a wall).
const UNDERCUT_NOISE = 1 / 16;
// The weight of the line along an edge (placeWeights): half its length on the
// outline along d, all of it across faces with 15° of draft or more, or
// across a flat face (its triangles within 0.5°, FLAT_FACET: no outline there).
const PLACE_MIN = 0.5;
const PLACE_FULL = Math.sin((15 * Math.PI) / 180);
// Above this many triangles, the cuts of the halves on patches of them (solveCut).
const COARSE_LIMIT = 200_000;
// The cut of the patches made again on the triangles of the patches along its changes of label and of this many rings
// of patches round them (refineBand: about 1.5 λ on either side).
const BAND_RINGS = 2;
// A triangle whose points disagree, larger than this × λ² (a long triangle of a
// CAD face across the edge of a shadow): its majority kept by the undercuts
// (optimiseHalves); smaller, its region regularised like any other.
const STRADDLE_AREA = 4;
// A triangle in the half it does not face (facingDown: a face both halves can
// form, upper when exactly along d) costs this share of its area more: a face
// along d changes half only to save more line than that (a small region of
// it), not to take the line diagonally across it or one step lower.
const FACING = 0.1;

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
 * them, it is not an undercut; nor a facet of a curved surface (normals
 * less than 35° apart) whose plane passes within GRAZE times their
 * stand-offs (surfaceOf) of o, in the sense `self` faces: along the
 * silhouette of a bore across d, the line tangent to it drifts across its
 * facets further on (the other way, it goes into the part through `self`).
 */
function lineHits(mesh, grid, self, ox, oy, oz, tEps) {
  const { indices: I, normals: N, reach, positions: P } = mesh;
  const sag = mesh.surface?.sag;
  const W = mesh.merged.welded;
  const s0 = W[3 * self], s1 = W[3 * self + 1], s2 = W[3 * self + 2];
  const { u, v, d, pu, pv, pw } = grid;
  const a0 = ox * u[0] + oy * u[1] + oz * u[2];
  const b0 = ox * v[0] + oy * v[1] + oz * v[2];
  const w0 = ox * d[0] + oy * d[1] + oz * d[2];
  // The sense `self` faces along d: a line the other way goes into the part through it, it does not graze.
  const ndSelf = N[3 * self] * d[0] + N[3 * self + 1] * d[1] + N[3 * self + 2] * d[2];
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
    const near = Math.abs(t) <= reach[self];
    const stand = sag && t * ndSelf >= 0 ? sag[self] + sag[f] : 0;
    if ((near || stand > 0) && N[3 * f] * N[3 * self] + N[3 * f + 1] * N[3 * self + 1] + N[3 * f + 2] * N[3 * self + 2] > SMOOTH_FACETS) {
      if (near) {
        const v0 = W[3 * f], v1 = W[3 * f + 1], v2 = W[3 * f + 2];
        if (v0 === s0 || v0 === s1 || v0 === s2 || v1 === s0 || v1 === s1 || v1 === s2 || v2 === s0 || v2 === s1 || v2 === s2) continue;
      }
      if (stand > 0) {
        const r = 3 * a;
        if (Math.abs((ox - P[r]) * N[3 * f] + (oy - P[r + 1]) * N[3 * f + 1] + (oz - P[r + 2]) * N[3 * f + 2]) <= GRAZE * stand) continue;
      }
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

/**
 * The smooth surfaces a mesh is the facets of, computed once (the same for
 * every direction). Two facets across an edge are of one smooth surface
 * when they share its vertices (the same B-rep face of a CAD body, each face
 * with vertices of its own; any edge of a welded mesh) and their normals are
 * less than 35° apart. {neighbours, sag, facesDown, vertexTriangles}:
 * - neighbours: the triangles across the edges (welded vertices; -1 free,
 *   -2 shared by more);
 * - sag, per triangle: how far its smooth surface stands off it (the
 *   tessellation is a polygon inside a convex surface, outside a concave
 *   one): a quarter of the farthest a neighbour of it on that surface bends
 *   off its plane (about twice the sagitta of the facets); 0 on a flat face;
 * - facesDown(f, d): whether triangle f faces -d, by the normal of its
 *   surface at its centre (those of its corners: the facets round each
 *   within 35° of it, by area; the facets of a tessellated cone lean by ±3°
 *   from one row to the next, not the cone), beyond the rounding of n·d of
 *   float32 positions (4 × 2^-24 × their largest coordinate over its
 *   smallest height: a long thin facet of an exact plane along d has n·d up
 *   to ±1e-5);
 * - vertexTriangles(): the triangles round each vertex (by index),
 *   {start, around} in compressed rows, built when first asked for.
 */
function surfaceOf(mesh) {
  if (mesh.surface) return mesh.surface;
  const { positions: P, indices: I, nt, normals: N, areas, reach, merged, diag, centre } = mesh;
  const { welded, nv } = merged;
  const neighbours = (merged.neighbours ??= edgeNeighbours(nv, welded));
  const has = (g, v) => I[3 * g] === v || I[3 * g + 1] === v || I[3 * g + 2] === v;
  const cosine = (f, g) => N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2];
  const sag = new Float32Array(nt);
  const most = SAG_MAX * diag;
  for (let f = 0; f < nt; f++) {
    let far = 0;
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g < 0) continue;
      const a = I[3 * f + e], b = I[3 * f + ((e + 1) % 3)];
      if (!has(g, a) || !has(g, b) || cosine(f, g) <= SMOOTH_FACETS) continue;
      const c = 3 * (I[3 * g] !== a && I[3 * g] !== b ? I[3 * g] : I[3 * g + 1] !== a && I[3 * g + 1] !== b ? I[3 * g + 1] : I[3 * g + 2]);
      const off = Math.abs((P[c] - P[3 * a]) * N[3 * f] + (P[c + 1] - P[3 * a + 1]) * N[3 * f + 1] + (P[c + 2] - P[3 * a + 2]) * N[3 * f + 2]);
      if (off > far) far = off;
    }
    if (far > 0) sag[f] = Math.min(SAG_SHARE * far, most);
  }
  const nvi = P.length / 3;
  let M = 0; // the largest coordinate of the positions given
  for (let i = 0; i < 3 * nvi; i++) M = Math.max(M, Math.abs(P[i] + centre[i % 3]));
  // The facets round each vertex (by index: a CAD face's own), {start, around} in compressed rows, when first asked for.
  let rows = null;
  const vertexTriangles = () => {
    if (rows) return rows;
    const start = new Int32Array(nvi + 1);
    for (let i = 0; i < 3 * nt; i++) start[I[i] + 1]++;
    for (let v = 0; v < nvi; v++) start[v + 1] += start[v];
    const around = new Int32Array(3 * nt);
    const fill = start.slice(0, nvi);
    for (let i = 0; i < 3 * nt; i++) around[fill[I[i]]++] = (i / 3) | 0;
    return (rows = { start, around });
  };
  // The smooth normals, when first asked for.
  let smooth = null, known = null;
  const smoothNormal = (f) => {
    if (!smooth) {
      smooth = new Float32Array(3 * nt);
      known = new Uint8Array(nt);
    }
    const { start, around } = vertexTriangles();
    if (known[f]) return;
    known[f] = 1;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k];
      for (let s = start[v], end = start[v + 1]; s < end; s++) {
        const g = around[s];
        if (g !== f && cosine(f, g) <= SMOOTH_FACETS) continue;
        x += areas[g] * N[3 * g];
        y += areas[g] * N[3 * g + 1];
        z += areas[g] * N[3 * g + 2];
      }
    }
    const len = Math.hypot(x, y, z);
    if (len > 0) {
      smooth[3 * f] = x / len;
      smooth[3 * f + 1] = y / len;
      smooth[3 * f + 2] = z / len;
    }
  };
  const facesDown = (f, d) => {
    smoothNormal(f);
    const noise = areas[f] > 0 ? (ROUNDING_NOISE * M * reach[f]) / (2 * areas[f]) : Infinity;
    return smooth[3 * f] * d[0] + smooth[3 * f + 1] * d[1] + smooth[3 * f + 2] * d[2] + TIE + noise < 0;
  };
  return (mesh.surface = { neighbours, sag, facesDown, vertexTriangles });
}

/**
 * Whether triangle f (both halves can form it) faces -d: by the silhouette
 * of its face, n·d of the normals at its corners (vertexNormals of `line`),
 * their mean beyond their rounding, as the triangles cut by a silhouette
 * (silhouetteHalves) when the faces have vertices of their own; else by the
 * normal of its smooth surface (surfaceOf).
 */
function facingDown(mesh, line, f, d) {
  const normals = line ? vertexNormals(line) : null;
  if (!normals) return surfaceOf(mesh).facesDown(f, d);
  const { normal, noise } = normals;
  const I = mesh.indices;
  let phi = 0, tol = 0;
  for (let k = 0; k < 3; k++) {
    const v = I[3 * f + k];
    phi += normal[3 * v] * d[0] + normal[3 * v + 1] * d[1] + normal[3 * v + 2] * d[2];
    if (noise[v] > tol) tol = noise[v];
  }
  return phi / 3 < -(TIE + tol);
}

/** True when the point at offset u of P comes before the one at v: by x, then y, then z. */
const before = (P, u, v) => P[u] < P[v] || (P[u] === P[v] && (P[u + 1] < P[v + 1] || (P[u + 1] === P[v + 1] && P[u + 2] < P[v + 2])));

/**
 * Flags (REACH_UP, REACH_DOWN, ZERO_DRAFT) of the triangles `list` (all when
 * null) for direction d: each sense reached from at least half of the points
 * of the triangle (its centre first, then a low-discrepancy sequence over it,
 * as many as sampleCount gives). A triangle drawn several times in `list`:
 * classified once. `evidence` (every triangle, list null; newEvidence): per
 * triangle the shares of its points whose line of sight is free upwards,
 * downwards, and free neither way (share, 3 per triangle; a sliver: free
 * both ways), how many points (count) and which were blocked upwards and
 * downwards (up, down: bit j for point j): what the halves are optimised on
 * (optimiseHalves).
 */
function classify(mesh, grid, d, list, sinDraft, evidence = null) {
  const { positions: P, indices: I, normals, centres, nt, diag } = mesh;
  const n = list ? list.length : nt;
  const flags = new Uint8Array(n);
  const known = list ? new Map() : null;
  const h = sampleSpacing(mesh);
  // Off the surface by more than the rounding of float32 positions, far less than a detail.
  const eps = diag * 1e-5;
  // And by the stand-off of the smooth surface of a facet of a curved face (surfaceOf): its line along d grazes that surface, it does not cross its other facets.
  const { sag } = surfaceOf(mesh);
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
      if (evidence) {
        evidence.share[3 * f] = evidence.share[3 * f + 1] = 1;
        evidence.count[f] = 1;
      }
      continue;
    }
    const cx = centres[3 * f], cy = centres[3 * f + 1], cz = centres[3 * f + 2];
    const off = eps + sag[f];
    let k = sampleCount(mesh, f, h);
    // Its corners by position (x, then y, then z): the same points whichever corner it starts with, either winding.
    let a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    if (before(P, b, a)) [a, b] = [b, a];
    if (before(P, c, b)) [b, c] = [c, b];
    if (before(P, b, a)) [a, b] = [b, a];
    let up = 0, down = 0, none = 0, upMask = 0, downMask = 0;
    for (let j = 0; j < k; j++) {
      // Its first SAMPLE_FIRST points (spread over it) agree both ways: the rest would not change the majority (nor the shares).
      if (j === SAMPLE_FIRST && up % SAMPLE_FIRST === 0 && down % SAMPLE_FIRST === 0) {
        k = SAMPLE_FIRST;
        break;
      }
      let x = cx, y = cy, z = cz;
      if (j) {
        const [p, q] = samplePoint(j);
        x += SAMPLE_INSET * (P[a] + p * (P[b] - P[a]) + q * (P[c] - P[a]) - cx);
        y += SAMPLE_INSET * (P[a + 1] + p * (P[b + 1] - P[a + 1]) + q * (P[c + 1] - P[a + 1]) - cy);
        z += SAMPLE_INSET * (P[a + 2] + p * (P[b + 2] - P[a + 2]) + q * (P[c + 2] - P[a + 2]) - cz);
      }
      const hits = lineHits(mesh, grid, f, x + off * nx, y + off * ny, z + off * nz, tEps);
      if (!(hits & 1)) up++;
      else upMask |= 1 << j;
      if (!(hits & 2)) down++;
      else downMask |= 1 << j;
      if (hits === 3) none++;
    }
    if (2 * up >= k) flag |= REACH_UP;
    if (2 * down >= k) flag |= REACH_DOWN;
    flags[s] = flag;
    known?.set(f, flag);
    if (evidence) {
      evidence.share[3 * f] = up / k;
      evidence.share[3 * f + 1] = down / k;
      evidence.share[3 * f + 2] = none / k;
      evidence.count[f] = k;
      evidence.up[f] = upMask;
      evidence.down[f] = downMask;
    }
  }
  return flags;
}

/** The evidence of the lines of sight of nt triangles, for classify to fill. */
const newEvidence = (nt) => ({ share: new Float32Array(3 * nt), count: new Uint8Array(nt), up: new Uint32Array(nt), down: new Uint32Array(nt) });

/**
 * Point j of the sequence of the points of a triangle (j >= 1; point 0 is its
 * centre): (p, q), the point a + p (b - a) + q (c - a) of its corners a, b, c
 * by position, before it is pulled SAMPLE_INSET towards the centre.
 */
function samplePoint(j) {
  let p = (0.5 + j * R2A) % 1, q = (0.5 + j * R2B) % 1;
  if (p + q > 1) {
    p = 1 - p;
    q = 1 - q;
  }
  return [p, q];
}

/** True for a triangle both halves can form (a face without draft, on the outside). */
const isFree = (flag) => (flag & (REACH_UP | REACH_DOWN)) === (REACH_UP | REACH_DOWN);

/**
 * Height along d (in the frame of the positions) of a planar parting line
 * that leaves every triangle only one half can form on its side, or null
 * when there is none: the faces of the lower half all below it, those of the
 * upper half all above it. The lowest such plane: the part in the upper
 * half as far as it can (a line on an edge, not across a face); unless
 * faces both halves can form above it face -d (by the normal of their
 * smooth surface, see sidesOf: a curved face across its silhouette, the
 * equator of a torus): then, of the heights that leave the least area of
 * the faces facing -d or +d on the side they do not face (by their centres;
 * the faces along d, either side), the first range: between the corners of
 * the faces facing -d below it and those facing +d above it when they do
 * not overlap (the silhouette of a cylinder on the edge between its facets),
 * else its middle.
 */
function planeHeight(mesh, flags, d, tol, line = null) {
  const { positions: P, indices: I, nt, nv, centre, centres, areas, sliver } = mesh;
  const offset = dot(centre, d);
  let lowerTop = -Infinity, upperBottom = Infinity, bottom = Infinity, top = -Infinity;
  for (let i = 0; i < nv; i++) {
    const w = P[3 * i] * d[0] + P[3 * i + 1] * d[1] + P[3 * i + 2] * d[2];
    bottom = Math.min(bottom, w);
    top = Math.max(top, w);
  }
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
  const lo = Math.max(lowerTop, bottom), hi = Math.min(Math.max(upperBottom, lo), top);
  // The faces both halves can form above lo facing -d (1) or +d (2), not along d.
  const height = (f) => centres[3 * f] * d[0] + centres[3 * f + 1] * d[1] + centres[3 * f + 2] * d[2];
  const corner = (f, k) => {
    const v = 3 * I[3 * f + k];
    return P[v] * d[0] + P[v + 1] * d[1] + P[v + 2] * d[2];
  };
  let wrong = 0;
  for (let f = 0; f < nt; f++) {
    if (isFree(flags[f]) && areas[f] >= sliver && height(f) >= lo && facingDown(mesh, line, f, d)) wrong += areas[f];
  }
  if (!(wrong > 0)) return lo + offset;
  const back = [-d[0], -d[1], -d[2]];
  const free = [];
  for (let f = 0; f < nt; f++) {
    if (!isFree(flags[f]) || !(areas[f] >= sliver)) continue;
    const h = height(f);
    if (!(h >= lo && h <= hi)) continue;
    const faces = facingDown(mesh, line, f, d) ? 1 : facingDown(mesh, line, f, back) ? 2 : 0;
    if (faces) free.push({ f, h, faces });
  }
  // Above the plane: upper (see sidesOf); a face below it facing +d, or above it facing -d, wrong.
  free.sort((a, b) => a.h - b.h || a.f - b.f);
  let best = wrong, cut = -1, cost = wrong;
  for (let k = 0; k < free.length; k++) {
    const { f, h, faces } = free[k];
    cost += faces === 1 ? -areas[f] : areas[f];
    const to = k + 1 < free.length ? Math.min(free[k + 1].h, hi) : hi;
    if (cost < best - 1e-9 * mesh.totalArea && to > h) {
      best = cost;
      cut = k;
    }
  }
  if (cut < 0) return lo + offset;
  let below = -Infinity, above = hi;
  free.forEach(({ f, faces }, k) => {
    for (let c = 0; c < 3; c++) {
      if (k <= cut && faces === 1) below = Math.max(below, corner(f, c));
      else if (k > cut && faces === 2) above = Math.min(above, corner(f, c));
    }
  });
  if (below <= above) return (below + above) / 2 + offset;
  const from = free[cut].h, to = cut + 1 < free.length ? Math.min(free[cut + 1].h, hi) : hi;
  return (from + to) / 2 + offset;
}

/**
 * Half of each triangle from its flags: the side it leaves by; none for an
 * undercut. With a planar line (height `plane`), a face both halves can form,
 * or flagged LEVEL: the side of its centre (in the plane: as without a
 * plane, a face at the level of the line); else a face both can form, by the
 * sense it faces (facingDown: the silhouette of its face with the line mesh
 * `line`, else the normal of its smooth surface), square to d within the
 * rounding of its positions: upper (an exact plane along d cut into long
 * facets: all upper, not one facet in two by the rounding of n·d).
 */
export function sidesOf(mesh, flags, d, plane = null, line = null) {
  const { normals, centres, nt, centre } = mesh;
  const level = plane == null ? null : plane - dot(centre, d);
  const tiny = 1e-9 * Math.max(1, mesh.diag);
  const side = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    if (!(normals[3 * f] || normals[3 * f + 1] || normals[3 * f + 2])) continue; // degenerate: no side
    const reach = flags[f] & (REACH_UP | REACH_DOWN);
    if (!reach) continue;
    // (A face in the plane, its centre on it: by its reach, as without a plane.)
    const h = level == null ? 0 : centres[3 * f] * d[0] + centres[3 * f + 1] * d[1] + centres[3 * f + 2] * d[2] - level;
    if (level != null && (flags[f] & LEVEL || reach === (REACH_UP | REACH_DOWN)) && Math.abs(h) > tiny) {
      side[f] = h < 0 ? SIDE_LOWER : SIDE_UPPER;
    } else if (reach === REACH_UP) side[f] = SIDE_UPPER;
    else if (reach === REACH_DOWN) side[f] = SIDE_LOWER;
    else side[f] = facingDown(mesh, line, f, d) ? SIDE_LOWER : SIDE_UPPER;
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

// ------------------------------------------------------------------ optimised halves

/**
 * The surface as a graph, for the minimum cuts of the halves (minCut),
 * computed once (kept on `line`): a node per triangle, an arc per edge to
 * the triangle across it (welded vertices; none for a free or non-manifold
 * edge, nor a triangle next to itself). {first (Int32Array, nt + 1: arcs
 * 3 f .. 3 f + 2 of triangle f), head (Int32Array, 3 nt: the triangle
 * across edge e of f at 3 f + e, -1 none), sister (the arc back), length
 * (Float64Array: of the edge)}.
 */
function surfaceGraph(line) {
  if (line.graph) return line.graph;
  const { positions: P, indices: I, welded, neighbours } = line;
  const nt = I.length / 3;
  const first = new Int32Array(nt + 1);
  for (let f = 0; f <= nt; f++) first[f] = 3 * f;
  const head = new Int32Array(3 * nt).fill(-1);
  const sister = new Int32Array(3 * nt).fill(-1);
  const length = new Float64Array(3 * nt);
  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const a = 3 * f + e;
      const g = neighbours[a];
      if (g < 0 || g === f) continue;
      // The edge of g with the same two vertices.
      const wa = welded[a], wb = welded[3 * f + ((e + 1) % 3)];
      let back = -1;
      for (let c = 0; c < 3 && back < 0; c++) {
        const ua = welded[3 * g + c], ub = welded[3 * g + ((c + 1) % 3)];
        if ((ua === wa && ub === wb) || (ua === wb && ub === wa)) back = 3 * g + c;
      }
      if (back < 0 || neighbours[back] !== f) continue;
      head[a] = g;
      sister[a] = back;
      const ra = 3 * I[a], rb = 3 * I[3 * f + ((e + 1) % 3)];
      length[a] = Math.hypot(P[rb] - P[ra], P[rb + 1] - P[ra + 1], P[rb + 2] - P[ra + 2]);
    }
  }
  return (line.graph = { first, head, sister, length });
}

/**
 * Per arc of the surface graph (surfaceGraph), the weight of the parting
 * line along its edge for direction d: its length, times how poor a place
 * it is for the line, from PLACE_MIN where the surface turns from one half
 * to the other (the faces on either side of the edge facing opposite senses
 * along d, or one along d: the outline of the part along d, a silhouette)
 * up to 1 across a face with PLACE_FULL of draft or more (both faces
 * facing one sense: a line across a face with draft, a step on it), and
 * across a flat face (two triangles within 0.5°, FLAT_FACET). By the
 * normals of the faces from `line` alone (the same weights on the page:
 * partingLine), whatever their orientation; those of the last direction
 * kept on `line`.
 */
function placeWeights(line, d) {
  const kept = line.place;
  if (kept && kept.d[0] === d[0] && kept.d[1] === d[1] && kept.d[2] === d[2]) return kept.w;
  const { positions: P, indices: I } = line;
  const nt = I.length / 3;
  const { head, length } = surfaceGraph(line);
  // n·d of each triangle (its unit normal, any orientation: only the signs relative to each other matter).
  const nd = new Float64Array(nt);
  const n = new Float64Array(3 * nt);
  for (let f = 0; f < nt; f++) {
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      n[3 * f] = nx / len;
      n[3 * f + 1] = ny / len;
      n[3 * f + 2] = nz / len;
    }
    nd[f] = len > 0 ? (nx * d[0] + ny * d[1] + nz * d[2]) / len : 0;
  }
  // Two triangles of one flat face (either orientation): the surface does not turn there, whatever n·d (a face along d
  // has no outline inside it: the line across it, a corner of it cut off, is a line across a face).
  const flat = (f, g) => Math.abs(n[3 * f] * n[3 * g] + n[3 * f + 1] * n[3 * g + 1] + n[3 * f + 2] * n[3 * g + 2]) >= FLAT_FACET;
  const w = new Float64Array(3 * nt);
  for (let a = 0; a < 3 * nt; a++) {
    const f = (a / 3) | 0, g = head[a];
    if (g >= 0) w[a] = length[a] * (flat(f, g) ? 1 : placeOf(nd[f], nd[g]));
  }
  line.place = { d: [d[0], d[1], d[2]], w };
  return w;
}

/** The tension of the parting line (mm): λ of optimiseHalves, for a part of this diagonal. */
export const lineTension = (diag) => Math.min(TENSION_MM, TENSION_SHARE * diag);

/** The weight of the line per mm between two faces of n·d p and q (placeWeights). */
const placeOf = (p, q) => PLACE_MIN + (1 - PLACE_MIN) * Math.min(1, (p * q <= 0 ? 0 : Math.min(Math.abs(p), Math.abs(q))) / PLACE_FULL);

/**
 * Whether the points of triangle f disagree (evidence of classify): some of
 * them blocked in a sense where others are not. Such a triangle straddles
 * the edge of a shadow (a long triangle of a CAD face across it): its
 * majority is all a whole-triangle label can say of it, the line goes
 * across it (shadowHalves).
 */
function straddles(evidence, f) {
  const k = evidence.count[f];
  if (k < 2) return false;
  const all = k >= 32 ? 0xffffffff : 2 ** k - 1;
  const up = evidence.up[f], down = evidence.down[f];
  return (up !== 0 && up !== all) || (down !== 0 && down !== all);
}

/**
 * The halves of direction d optimised over the whole surface, from the
 * evidence of the lines of sight of each triangle (classify, newEvidence),
 * with `line` (lineMesh). Two minimum cuts (minCut) over the triangles,
 * each exact:
 * 1. the undercuts of the line (its shape only: the undercuts reported are
 *    those of the lines of sight, optimisedFlags): of the labels undercut /
 *    formed by a half, the least
 *    Σ area × (1 - none) over the triangles called undercuts + Σ area × none
 *    over the others + λ × the length of the edges between them, `none` the
 *    share of the points of a triangle blocked both ways: a triangle whose
 *    points all agree is called as they are, unless its region is too thin
 *    or small for its border (a single long triangle, a spike, a sliver
 *    round a singular point: what its neighbours are; a slot or a hole
 *    across d keeps its own); a triangle whose points disagree (it straddles
 *    the edge of a shadow) larger than STRADDLE_AREA × λ² (below, the comb
 *    of a blend's facets along a shadow: as any other) keeps its majority (an
 *    undercut when most of its points are blocked both ways; its points in
 *    the reach of one half or the other, a triangle across the edge between
 *    the shadows of the two senses: formed, cut by the line), the line or
 *    the border of the undercut across it, and its edges weigh nothing (its
 *    border is across it, not along them: a sliver in the shadow beside it
 *    is not moved out of it by them);
 * 2. the halves: of the labels upper / lower (a large triangle across the
 *    edge of a shadow, most of its points in one half's reach only: in that
 *    one, as the first cut keeps its majority), the least Σ area × (1 - up)
 *    over the upper half + Σ area × (1 - down) over the lower one, FACING ×
 *    area more in the half it does not face (facingDown: a face both halves
 *    can form in the one it faces, upper when exactly along d, unless moving
 *    a small part of it saves more line), an undercut nothing either way
 *    (its region joined whole to a half by its border), + λ × the weight of
 *    the edges between them (placeWeights: their length, half of it on the
 *    outline along d): each triangle in the half that can form it, the faces
 *    both can form in the one they face; a region of one half within the
 *    other too small for the line round it (a small loop, a tooth of long
 *    triangles) in the other. Ties: the upper half, the triangles formed by
 *    a half.
 * λ, the tension of the line (lineTension): TENSION_MM, less on a small part
 * (TENSION_SHARE of its diagonal): about the smallest detail a die is given
 * a parting or a slide of its own for (a fillet, a lettering 1 mm high), and
 * ten times the deflection of the mesh of a CAD face (its facets, the noise
 * of the lines of sight along them, well below it). A region of contrary
 * evidence changes label when that costs less than the line round it: an
 * undercut region (for the line) when its area is under λ × its border (a
 * strip narrower than 2 λ, a disc under 4 λ across: the line goes round it
 * as round the half it joins, the undercut still reported); a region of one
 * half in the other when its area (1 + FACING) is under λ × the weight of its
 * border (on a face with draft, a strip narrower than about 2 λ). The
 * details of a casting (a boss, a rib, a hole, a slot of a few millimetres)
 * keep their own.
 * Returns {under (Uint8Array: 1 an undercut), upper (Uint8Array: 1 in the
 * upper half, an undercut joined to it)}.
 */
function optimiseHalves(mesh, line, evidence, d, coarseLimit = COARSE_LIMIT) {
  const { nt, areas, diag } = mesh;
  const { first, head, sister, length } = surfaceGraph(line);
  const { share } = evidence;
  const lambda = lineTension(diag);
  const cap = new Float64Array(3 * nt);
  const tcap = new Float64Array(nt);
  // 1. The undercuts (the source side), the rest formed by a half (ties). A large triangle across the edge of a shadow
  // as most of it is, not pulling its neighbours (its border is across it, not along its edges). (No point blocked
  // both ways: no undercut, no cut.)
  let under = new Uint8Array(nt);
  let blocked = false;
  for (let f = 0; f < nt && !blocked; f++) blocked = share[3 * f + 2] > 0;
  const across = Uint8Array.from(areas, (a, f) => (a >= STRADDLE_AREA * lambda * lambda && straddles(evidence, f) ? 1 : 0));
  if (blocked) {
    for (let a = 0; a < 3 * nt; a++) if (head[a] >= 0 && !across[(a / 3) | 0] && !across[head[a]]) cap[a] = lambda * length[a];
    for (let f = 0; f < nt; f++) {
      if (!across[f]) tcap[f] = areas[f] * (2 * share[3 * f + 2] - 1);
      else tcap[f] = 2 * share[3 * f + 2] > 1 ? Infinity : -Infinity;
    }
    under = solveCut(mesh, line, cap, tcap, 0, coarseLimit);
  }
  // 2. The upper half (the source side, and ties); two undercuts: one region, joined whole.
  const w = placeWeights(line, d);
  for (let f = 0; f < nt; f++) {
    for (let a = 3 * f; a < 3 * f + 3; a++) if (head[a] >= 0) cap[a] = under[f] && under[head[a]] ? Infinity : lambda * w[a];
    if (under[f]) {
      tcap[f] = 0;
      continue;
    }
    // (A triangle only one half reaches, all its points, faces that half: no need to ask.)
    const up = share[3 * f], down = share[3 * f + 1];
    // A large triangle across the edge of a shadow, most of it in one half's reach only: in that half (the line
    // across it, shadowHalves), never moved whole into the other one by its neighbours, as the first cut keeps it.
    if (across[f] && 2 * up >= 1 !== 2 * down >= 1) {
      tcap[f] = 2 * up >= 1 ? Infinity : -Infinity;
      continue;
    }
    const facing = up === 1 && down === 0 ? FACING : up === 0 && down === 1 ? -FACING : facingDown(mesh, line, f, d) ? -FACING : FACING;
    tcap[f] = areas[f] * (up - down + facing);
  }
  const upper = solveCut(mesh, line, cap, tcap, 1, coarseLimit);
  return { under, upper };
}

/**
 * The minimum cut of the triangles of `mesh` (minCut over surfaceGraph of
 * `line`, capacities cap per arc, tcap per triangle, ties to `free`): the
 * labels per triangle. Exact up to `limit` triangles (COARSE_LIMIT); above (a
 * mesh of millions of small triangles: the trees of the maximum flow
 * re-rooted at each of its many tiny paths), solved on patches of them,
 * whatever the order of the triangles: the triangles of one cell of a grid
 * of λ / 2 (lineTension) over their centres, of the same kind (the sign of
 * their terminal capacity: of one evidence, one facing), joined across
 * smooth edges (normals within 35°): every triangle with its patch, the cut
 * placed at their scale, half the tension's. The patches never mix kinds
 * nor cross a sharp edge. Then exact near the line (refineBand). When they
 * would not take the graph down by half (triangles larger than the cells),
 * exact on the triangles.
 */
function solveCut(mesh, line, cap, tcap, free, limit = COARSE_LIMIT) {
  const { nt, normals: N, centres: C, diag } = mesh;
  const { first, head, sister } = surfaceGraph(line);
  if (nt <= limit) return minCut(nt, first, head, cap, sister, tcap, { free }).side;
  const kind = (x) => (x === Infinity ? 2 : x === -Infinity ? -2 : x > 0 ? 1 : x < 0 ? -1 : 0);
  // The cell of each triangle (its centre in a grid of λ / 2 from the least corner of the centres).
  const size = lineTension(diag) / 2;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], C[3 * f + k]);
      hi[k] = Math.max(hi[k], C[3 * f + k]);
    }
  }
  const nx = Math.floor((hi[0] - lo[0]) / size) + 1, ny = Math.floor((hi[1] - lo[1]) / size) + 1;
  const cell = new Float64Array(nt);
  for (let f = 0; f < nt; f++) {
    const [i, j, k] = [0, 1, 2].map((c) => Math.floor((C[3 * f + c] - lo[c]) / size));
    cell[f] = i + nx * (j + ny * k);
  }
  // The patches: connected components (the same whatever the order) of one cell, one kind, across smooth edges.
  const patch = new Int32Array(nt).fill(-1);
  const queue = new Int32Array(nt);
  let np = 0;
  for (let s = 0; s < nt; s++) {
    if (patch[s] >= 0) continue;
    const id = np++;
    patch[s] = id;
    const k = kind(tcap[s]);
    let qh = 0, qt = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const f = queue[qh++];
      for (let a = 3 * f; a < 3 * f + 3; a++) {
        const g = head[a];
        if (g < 0 || patch[g] >= 0 || cell[g] !== cell[f] || kind(tcap[g]) !== k) continue;
        if (N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2] <= SMOOTH_FACETS) continue;
        patch[g] = id;
        queue[qt++] = g;
      }
    }
  }
  if (2 * np > nt) return minCut(nt, first, head, cap, sister, tcap, { free }).side;
  // The patches' terminal capacities, and their arcs: the edges between two of them, rows sorted by the patch at
  // their other end and merged (their capacities summed), the sister of each found in its row by bisection.
  const ptcap = new Float64Array(np);
  for (let f = 0; f < nt; f++) ptcap[patch[f]] += tcap[f];
  const start = new Int32Array(np + 1);
  for (let a = 0; a < 3 * nt; a++) {
    const g = head[a];
    if (g >= 0 && patch[g] !== patch[(a / 3) | 0]) start[patch[(a / 3) | 0] + 1]++;
  }
  for (let p = 0; p < np; p++) start[p + 1] += start[p];
  const to = new Int32Array(start[np]), w = new Float64Array(start[np]);
  const fill = start.slice(0, np);
  for (let a = 0; a < 3 * nt; a++) {
    const g = head[a], p = patch[(a / 3) | 0];
    if (g < 0 || patch[g] === p) continue;
    to[fill[p]] = patch[g];
    w[fill[p]++] = cap[a];
  }
  const pfirst = new Int32Array(np + 1);
  const phead = new Int32Array(start[np]), pcap = new Float64Array(start[np]);
  let m = 0;
  for (let p = 0; p < np; p++) {
    pfirst[p] = m;
    // Insertion sort of the row by its other end (a few arcs each).
    for (let x = start[p] + 1; x < start[p + 1]; x++) {
      const q = to[x], c = w[x];
      let y = x - 1;
      for (; y >= start[p] && to[y] > q; y--) {
        to[y + 1] = to[y];
        w[y + 1] = w[y];
      }
      to[y + 1] = q;
      w[y + 1] = c;
    }
    for (let x = start[p]; x < start[p + 1]; x++) {
      if (m > pfirst[p] && phead[m - 1] === to[x]) pcap[m - 1] += w[x];
      else {
        phead[m] = to[x];
        pcap[m++] = w[x];
      }
    }
  }
  pfirst[np] = m;
  const psister = new Int32Array(m);
  for (let p = 0; p < np; p++) {
    for (let x = pfirst[p]; x < pfirst[p + 1]; x++) {
      const q = phead[x];
      let a = pfirst[q], b = pfirst[q + 1] - 1;
      while (a < b) {
        const mid = (a + b) >> 1;
        if (phead[mid] < p) a = mid + 1;
        else b = mid;
      }
      psister[x] = a;
    }
  }
  const { side } = minCut(np, pfirst, phead.subarray(0, m), pcap.subarray(0, m), psister, ptcap, { free });
  return refineBand(nt, head, cap, sister, tcap, free, patch, np, Uint8Array.from(patch, (p) => side[p]));
}

/**
 * The labels of the cut of the patches (solveCut), exact where they change:
 * the triangles of the patches along a change of label and of BAND_RINGS
 * rings of patches round them (about 1.5 λ on either side) cut again on the
 * triangles themselves, the others kept (each arc from the band to one of
 * them as a terminal capacity of its triangle in the band). The cut of the
 * patches places the line at their scale: where the evidence barely leans
 * either way (both halves reach, the faces facing one), its line differs
 * from the exact one and left islands of a patch or two in the other half
 * (on a cylinder with blended bosses, 227 000 triangles: loops of a
 * millimetre round them, 5 loops for 1 along X). The labels (`label`,
 * changed in place).
 */
function refineBand(nt, head, cap, sister, tcap, free, patch, np, label) {
  const along = new Uint8Array(np);
  for (let a = 0; a < 3 * nt; a++) {
    const f = (a / 3) | 0, g = head[a];
    if (g >= 0 && label[f] !== label[g]) along[patch[f]] = along[patch[g]] = 1;
  }
  let band = Uint8Array.from(along);
  for (let ring = 0; ring < BAND_RINGS; ring++) {
    const next = Uint8Array.from(band);
    for (let a = 0; a < 3 * nt; a++) {
      const g = head[a];
      if (g >= 0 && band[patch[(a / 3) | 0]]) next[patch[g]] = 1;
    }
    band = next;
  }
  const index = new Int32Array(nt).fill(-1);
  let nb = 0;
  for (let f = 0; f < nt; f++) if (band[patch[f]]) index[f] = nb++;
  if (!nb) return label;
  const bfirst = new Int32Array(nb + 1);
  for (let k = 0; k <= nb; k++) bfirst[k] = 3 * k;
  const bhead = new Int32Array(3 * nb).fill(-1), bsister = new Int32Array(3 * nb).fill(-1);
  const bcap = new Float64Array(3 * nb), btcap = new Float64Array(nb);
  for (let f = 0; f < nt; f++) {
    const k = index[f];
    if (k < 0) continue;
    let t = tcap[f];
    for (let e = 0; e < 3; e++) {
      const a = 3 * f + e, g = head[a];
      if (g < 0) continue;
      if (index[g] >= 0) {
        bhead[3 * k + e] = index[g];
        bcap[3 * k + e] = cap[a];
        bsister[3 * k + e] = 3 * index[g] + (sister[a] - 3 * g);
      } else if (label[g]) t += cap[sister[a]]; // g on the source side: its arc to f cut unless f is too
      else t -= cap[a]; // g on the sink side: the arc from f to it cut if f is on the source side
    }
    // (Fixed to one half, joined whole to a neighbour fixed to the other: as fixed.)
    btcap[k] = Number.isNaN(t) ? tcap[f] : t;
  }
  const { side } = minCut(nb, bfirst, bhead, bcap, bsister, btcap, { free });
  for (let f = 0; f < nt; f++) if (index[f] >= 0) label[f] = side[index[f]];
  return label;
}

/**
 * The flags of the optimised halves (optimiseHalves), in place: those of the
 * lines of sight (classify: the undercuts reported, their area, their
 * slides, as every triangle's REACH_* by most of its points, whatever half
 * the line puts it in), but a triangle blocked both ways in a region of
 * noise (noise, of noiseUndercuts): the REACH_* of the half the optimum puts
 * it in. The line's own undercuts (`under`, regularised at its tension) are
 * for its shape only: a triangle it absorbs into a half or adds to an
 * undercut region keeps its flags.
 */
function optimisedFlags(flags, { upper }, noise) {
  for (let f = 0; f < flags.length; f++) {
    if (noise[f] && !(flags[f] & (REACH_UP | REACH_DOWN))) flags[f] |= upper[f] ? REACH_UP : REACH_DOWN;
  }
  return flags;
}

/**
 * The triangles blocked both ways by their points (no REACH_* in `flags`, as
 * classified) whose region (joined by their edges) is noise of the lines of
 * sight: its area under UNDERCUT_NOISE × λ (lineTension) × its border, 1
 * each. A real undercut, a groove 1 mm wide or a window through a wall, is
 * far above it.
 */
function noiseUndercuts(mesh, line, flags) {
  const { nt, areas, diag } = mesh;
  const { head, length } = surfaceGraph(line);
  const tension = UNDERCUT_NOISE * lineTension(diag);
  const blocked = (f) => !(flags[f] & (REACH_UP | REACH_DOWN));
  const out = new Uint8Array(nt), seen = new Uint8Array(nt);
  const queue = [];
  for (let f0 = 0; f0 < nt; f0++) {
    if (seen[f0] || !blocked(f0)) continue;
    seen[f0] = 1;
    queue.length = 0;
    queue.push(f0);
    let area = 0, border = 0;
    for (let q = 0; q < queue.length; q++) {
      const f = queue[q];
      area += areas[f];
      for (let a = 3 * f; a < 3 * f + 3; a++) {
        const g = head[a];
        if (g < 0) continue;
        if (!blocked(g)) border += length[a];
        else if (!seen[g]) {
          seen[g] = 1;
          queue.push(g);
        }
      }
    }
    if (area < tension * border) for (const f of queue) out[f] = 1;
  }
  return out;
}

/** The halves of the optimum (optimiseHalves): SIDE_NONE for an undercut. */
function optimisedSides({ under, upper }) {
  const side = new Uint8Array(under.length);
  for (let f = 0; f < side.length; f++) side[f] = under[f] ? SIDE_NONE : upper[f] ? SIDE_UPPER : SIDE_LOWER;
  return side;
}

/**
 * The half each undercut triangle (SIDE_NONE in `side`) is joined to, for
 * the line round its region: of the labels upper / lower of the undercuts,
 * the other triangles as `side` has them, the least weight of the line
 * (placeWeights; as the second cut of optimiseHalves joins them: an
 * undercut costing nothing either way, a region of them joined whole: the
 * minimum cut of the undercuts alone, each region in the half its heavier
 * border is with). The line goes round each region at its lightest border.
 * The edge between two triangles flagged SHADOW in `flags` weighs nothing:
 * the line goes across them, not along it (long triangles in turn undercuts
 * and of a half across the edge of a shadow, one region of each on either
 * side of it). Ties: the upper half. A new array, or `side` itself without
 * undercuts.
 */
function joinUndercuts(line, side, d, flags = null) {
  const nt = side.length;
  let firstUndercut = -1;
  for (let f = 0; f < nt && firstUndercut < 0; f++) if (side[f] === SIDE_NONE) firstUndercut = f;
  if (firstUndercut < 0) return side;
  const { head } = surfaceGraph(line);
  const w = placeWeights(line, d);
  const out = Uint8Array.from(side);
  // Each region whole (the minimum cut with infinite arcs inside it): the half its lighter border is not with.
  const region = new Int32Array(nt).fill(-1);
  const queue = [];
  for (let f0 = firstUndercut; f0 < nt; f0++) {
    if (side[f0] !== SIDE_NONE || region[f0] >= 0) continue;
    region[f0] = f0;
    queue.length = 0;
    queue.push(f0);
    let balance = 0, border = 0; // the weight of its border with the upper half less that with the lower one; in all
    for (let q = 0; q < queue.length; q++) {
      const f = queue[q];
      for (let a = 3 * f; a < 3 * f + 3; a++) {
        const g = head[a];
        if (g < 0) continue;
        if (side[g] === SIDE_NONE) {
          if (region[g] < 0) {
            region[g] = f0;
            queue.push(g);
          }
        } else if (flags && cutOf(flags[f]) === SHADOW && cutOf(flags[g]) === SHADOW) continue;
        else if (side[g] === SIDE_UPPER) {
          balance += w[a];
          border += w[a];
        } else if (side[g] === SIDE_LOWER) {
          balance -= w[a];
          border += w[a];
        }
      }
    }
    // Ties within a part in 1e9 of its border (the rounding of the sums, in the order of the triangles): upper.
    const half = balance >= -1e-9 * border ? SIDE_UPPER : SIDE_LOWER;
    for (const f of queue) out[f] = half;
  }
  return out;
}

// ------------------------------------------------------------------ parting line

/**
 * What the parting line needs of a mesh, computed once: the vertices merged
 * by position (the faces of a CAD model have their own vertices) and the
 * triangle on the other side of each edge (-1 free, -2 shared by more).
 */
export function lineMesh(positions, indices, merged = weld(positions, indices)) {
  const { welded, nv } = merged;
  return { positions, indices, welded, neighbours: merged.neighbours ?? edgeNeighbours(nv, welded) };
}

/** The triangles round each welded vertex of `line` (lineMesh), {start, around} in compressed rows, computed once. */
function weldedTriangles(line) {
  if (line.weldedRows) return line.weldedRows;
  const { welded } = line;
  let nw = 0;
  for (let i = 0; i < welded.length; i++) if (welded[i] >= nw) nw = welded[i] + 1;
  const start = new Int32Array(nw + 1);
  for (let i = 0; i < welded.length; i++) start[welded[i] + 1]++;
  for (let w = 0; w < nw; w++) start[w + 1] += start[w];
  const around = new Int32Array(welded.length);
  const fill = start.slice(0, nw);
  for (let i = 0; i < welded.length; i++) around[fill[welded[i]]++] = (i / 3) | 0;
  return (line.weldedRows = { start, around });
}

/**
 * The normals of the surfaces of a mesh at its vertices, by index (each face
 * of a CAD body has its own: the normals of one face), computed once (kept
 * on `line`): the mean of the facets round each by the weights of Max
 * (their edges there, not their areas: a long or a fan triangle would pull
 * the normal its way), and per vertex whether those
 * facets are all within 35° of it (smooth), not all within 0.5° (curved),
 * and the rounding of n·d there (noise: of its facets, float32 positions,
 * see surfaceOf). A mesh without vertices of their own per face (welded: a
 * vertex between a flat face and a fillet would take the normals of both):
 * null.
 */
function vertexNormals(line) {
  if (line.vertexNormals !== undefined) return line.vertexNormals;
  const { positions: P, indices: I, welded } = line;
  const nv = P.length / 3, nt = I.length / 3;
  let nw = 0;
  for (let i = 0; i < welded.length; i++) if (welded[i] >= nw) nw = welded[i] + 1;
  let used = 0;
  const seen = new Uint8Array(nv);
  for (let i = 0; i < I.length; i++) if (!seen[I[i]]) (seen[I[i]] = 1), used++;
  if (used <= nw) return (line.vertexNormals = null);
  const normal = new Float64Array(3 * nv);
  // Twice the area of triangle f times its normal, into cross; the squares of its edges ab, ac, bc into sides.
  const cross = [0, 0, 0], sides = [0, 0, 0];
  const facet = (f) => {
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    cross[0] = uy * vz - uz * vy;
    cross[1] = uz * vx - ux * vz;
    cross[2] = ux * vy - uy * vx;
    sides[0] = ux * ux + uy * uy + uz * uz;
    sides[1] = vx * vx + vy * vy + vz * vz;
    sides[2] = (vx - ux) * (vx - ux) + (vy - uy) * (vy - uy) + (vz - uz) * (vz - uz);
  };
  const add = (o, w) => {
    if (!(w < Infinity)) return;
    normal[o] += w * cross[0];
    normal[o + 1] += w * cross[1];
    normal[o + 2] += w * cross[2];
  };
  for (let f = 0; f < nt; f++) {
    facet(f);
    if (!(cross[0] || cross[1] || cross[2])) continue;
    // Weights of Max (1999): the cross product of its edges at the corner over their squared lengths (exact on a sphere).
    const [ab, ac, bc] = sides;
    add(3 * I[3 * f], 1 / (ab * ac));
    add(3 * I[3 * f + 1], 1 / (ab * bc));
    add(3 * I[3 * f + 2], 1 / (ac * bc));
  }
  const smooth = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const m = Math.sqrt(normal[3 * v] * normal[3 * v] + normal[3 * v + 1] * normal[3 * v + 1] + normal[3 * v + 2] * normal[3 * v + 2]);
    if (!(m > 0)) continue;
    normal[3 * v] /= m;
    normal[3 * v + 1] /= m;
    normal[3 * v + 2] /= m;
    smooth[v] = 1;
  }
  const noise = new Float64Array(nv);
  const curved = new Uint8Array(nv);
  let M = 0;
  for (let i = 0; i < P.length; i++) M = Math.max(M, Math.abs(P[i]));
  for (let f = 0; f < nt; f++) {
    facet(f);
    const len = Math.sqrt(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]);
    const longest = Math.sqrt(Math.max(sides[0], sides[1], sides[2]));
    const rounding = len > 0 ? (ROUNDING_NOISE * M * longest) / len : Infinity;
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k];
      if (rounding > noise[v]) noise[v] = rounding;
      if (!smooth[v] || !(len > 0)) continue;
      const cos = (cross[0] * normal[3 * v] + cross[1] * normal[3 * v + 1] + cross[2] * normal[3 * v + 2]) / len;
      if (cos <= SMOOTH_FACETS) smooth[v] = 0;
      if (cos < FLAT_FACET) curved[v] = 1;
    }
  }
  return (line.vertexNormals = { normal, smooth, noise, curved });
}

/**
 * The silhouettes of a mesh along d: per vertex by index, phi = n·d of the
 * normal of its surface there (vertexNormals), and smooth, noise, curved of
 * vertexNormals. Linear over a triangle, phi is 0 along the silhouette of
 * its face, the line where a curved face turns from one half to the other;
 * 0 all over a flat face along d. Null for a welded mesh (vertexNormals).
 * {phi (Float64Array), smooth, noise, curved}; the last one kept on `line`.
 */
function silhouetteField(line, d) {
  const cached = line.silhouette;
  if (cached && cached.d[0] === d[0] && cached.d[1] === d[1] && cached.d[2] === d[2]) return cached.field;
  const normals = vertexNormals(line);
  let field = null;
  if (normals) {
    const { normal, smooth, noise, curved } = normals;
    const nv = smooth.length;
    const phi = new Float64Array(nv);
    for (let v = 0; v < nv; v++) phi[v] = normal[3 * v] * d[0] + normal[3 * v + 1] * d[1] + normal[3 * v + 2] * d[2];
    field = { phi, smooth, noise, curved };
  }
  line.silhouette = { d: [d[0], d[1], d[2]], field };
  return field;
}

/**
 * The halves of the undercut triangles (SIDE_NONE: a core or a slide), for
 * the line only: it goes round an undercut region, it does not stop at it.
 * With a planar line (`plane`), the side of the plane of their centres (cut
 * by it when across it, see partingLine); else the half each is joined to
 * by the lightest line round them (joinUndercuts: the joins of the optimum
 * of the halves; `flags` with SHADOW, see there). A new array, or `side`
 * itself without undercuts.
 */
function undercutHalves(line, side, d, plane, flags = null) {
  const { positions: P, indices: I } = line;
  const nt = I.length / 3;
  let first = -1;
  for (let f = 0; f < nt && first < 0; f++) if (side[f] === SIDE_NONE) first = f;
  if (first < 0) return side;
  if (plane == null) return joinUndercuts(line, side, d, flags);
  const out = Uint8Array.from(side);
  const w = (r) => P[3 * r] * d[0] + P[3 * r + 1] * d[1] + P[3 * r + 2] * d[2];
  for (let f = first; f < nt; f++) {
    if (side[f] === SIDE_NONE) out[f] = (w(I[3 * f]) + w(I[3 * f + 1]) + w(I[3 * f + 2])) / 3 < plane ? SIDE_LOWER : SIDE_UPPER;
  }
  return out;
}

/**
 * The hooks of a line taken out, in place: two pieces that meet at a point
 * of no other piece turning back by more than 135°, one of them shorter than
 * HOOK_SHARE of the size of the line (where a cut across a face meets its
 * edge, the line along that edge for a few tenths of a millimetre and back),
 * or folded back to within 10° with their other ends closer than that (a
 * sliver a tenth of a millimetre wide between them): one piece between
 * their other ends instead (none when they are the same point), until there
 * is none. pieces: [xyz, xyz, key, key] each. Each taken out, in order, into
 * `hooks` when given: {X (the point), A, B (the other ends), kx, ka, kb
 * (their keys)}, the triangle between them now on the other side of the
 * line (partingPieces).
 */
function unhook(pieces, hooks = null) {
  if (pieces.length < 2) return;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [a, b] of pieces) {
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], a[c], b[c]);
      hi[c] = Math.max(hi[c], a[c], b[c]);
    }
  }
  const hook = HOOK_SHARE * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const alive = new Uint8Array(pieces.length + pieces.length).fill(1);
  const byEnd = new Map();
  const add = (k) => {
    for (const key of [pieces[k][2], pieces[k][3]]) {
      const list = byEnd.get(key);
      if (list) list.push(k);
      else byEnd.set(key, [k]);
    }
  };
  pieces.forEach((_, k) => add(k));
  const work = [...byEnd.keys()];
  let changed = false;
  while (work.length) {
    const key = work.pop();
    const list = byEnd.get(key)?.filter((k) => alive[k]);
    if (!list) continue;
    byEnd.set(key, list);
    if (list.length !== 2 || list[0] === list[1]) continue;
    // The other end of each piece, and the piece from the point to it.
    const far = list.map((k) => (pieces[k][2] === key ? [pieces[k][1], pieces[k][3], pieces[k][0]] : [pieces[k][0], pieces[k][2], pieces[k][1]]));
    const [[A, ka, X], [B, kb]] = far;
    const u = [A[0] - X[0], A[1] - X[1], A[2] - X[2]], v = [B[0] - X[0], B[1] - X[1], B[2] - X[2]];
    const la = Math.hypot(u[0], u[1], u[2]), lb = Math.hypot(v[0], v[1], v[2]);
    const turn = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    // A hook: one piece short, turning back; a fold: turning back to within 10°, its other ends close (a sliver between them).
    const isHook = Math.min(la, lb) <= hook && !(la > 0 && lb > 0 && turn <= HOOK_TURN * la * lb);
    const isFold = turn > FOLD_TURN * la * lb && Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) <= hook;
    if (!isHook && !isFold) continue;
    hooks?.push({ X, A, B, kx: key, ka, kb });
    alive[list[0]] = alive[list[1]] = 0;
    byEnd.set(key, []);
    changed = true;
    if (ka !== kb) {
      pieces.push([A, B, ka, kb]);
      add(pieces.length - 1);
    }
    work.push(ka, kb);
  }
  if (!changed) return;
  let n = 0;
  for (let k = 0; k < pieces.length; k++) if (alive[k]) pieces[n++] = pieces[k];
  pieces.length = n;
}

/**
 * How a split into halves is cut across its triangles, for its parting line
 * (partingLine) and the colours of its halves (partingPieces): the same cuts
 * for both. The undercut regions joined to a half (undercutHalves); with a
 * planar line (`plane`), the faces both halves can form, the undercuts and
 * the faces flagged LEVEL across the plane cut at that height; else the
 * triangles flagged SILHOUETTE cut by the silhouette of their surface (phi =
 * 0, positive on the upper side), those flagged SHADOW by the edges of the
 * shadows along d (shadowLabels, shadowShape); none reassigned by hand
 * (`fixed`). Options as partingLine. Returns {side (joined), field, shade,
 * mesh, grid (those of the shadows, else as given), modeOf(f) (1 by the
 * plane, 2 by its silhouette, 3 by the edges of shadows), shapeOf(f)
 * (shadowShape), value(f, r) (of the cut at vertex r of f: the plane, the
 * silhouette; positive upper), nearOf(f) (on the cut within this), isSplit(f),
 * splitState (per triangle: 0 not known yet, 1 not cut, 2 cut), crossing(f,
 * ra, rb) (where the value is 0 along edge (ra, rb), 0 to 1), along(ra, rb,
 * t), pointOn(f, ra, rb), at(r)}.
 */
function lineCuts(line, side, d, { flags = null, plane = null, fixed = null, height = null, mesh = null, grid = null } = {}) {
  const { positions: P, indices: I, welded } = line;
  const nt = I.length / 3;
  const w = (r) => P[3 * r] * d[0] + P[3 * r + 1] * d[1] + P[3 * r + 2] * d[2];
  const tiny = 1e-9 * Math.max(1, Math.abs(plane ?? 0), height ?? 0);
  const given = side;
  side = undercutHalves(line, side, d, plane, flags);
  let field = null, shade = null, iso = null;
  if (plane == null && flags) {
    let silhouettes = false, shadows = false, isos = false;
    for (let f = 0; f < nt && !(silhouettes && shadows && isos); f++) {
      if (fixed?.[f]) continue;
      const cut = cutOf(flags[f]);
      if (cut === ISO_CUT) isos = true;
      else if (cut === SILHOUETTE) silhouettes = true;
      else if (cut === SHADOW) shadows = true;
    }
    if (silhouettes) field = silhouetteField(line, d);
    if (shadows) {
      mesh ??= prepareMesh(P, I);
      grid ??= lineGrid(mesh, d);
      field ??= silhouetteField(line, d);
      shade = shadowLabels(mesh, grid, line, given, side, flags, d, field);
    }
    if (isos) iso = isoField(line, side, flags, fixed);
  }
  // 1 by the plane, 2 by its silhouette, 3 by the edges of shadows, 4 by the iso-line of the halves.
  const modeOf = (f) => (plane != null ? 1 : MODE_OF[cutOf(flags[f])]);
  const shapes = new Map();
  const shapeOf = (f) => {
    let s = shapes.get(f);
    if (!s) shapes.set(f, (s = shadowShape(f, P, I, welded, shade)));
    return s;
  };
  // The value of the cut at vertex r of triangle f cut by the plane or a silhouette (positive: upper), on it within nearOf(f).
  const value = (f, r) => {
    const mode = modeOf(f);
    return mode === 1 ? w(r) - plane : mode === 4 ? iso[r] : field.phi[r];
  };
  const nearOf = (f) => (plane != null ? tiny : SILHOUETTE_TINY);
  // A face both halves can form, an undercut or a face flagged LEVEL, across the plane: its side changes at the plane.
  const split = (f) => {
    if (fixed?.[f] || !flags) return false;
    if (plane != null ? !(flags[f] & LEVEL || isFree(flags[f])) : !((field && cutOf(flags[f]) === SILHOUETTE) || (shade && cutOf(flags[f]) === SHADOW) || (iso && cutOf(flags[f]) === ISO_CUT))) return false;
    if (modeOf(f) === 3) return shapeOf(f).cuts.length > 0;
    const near = nearOf(f);
    let below = false, above = false;
    for (let k = 0; k < 3; k++) {
      const h = value(f, I[3 * f + k]);
      if (h < -near) below = true;
      else if (h > near) above = true;
    }
    return below && above;
  };
  // Where along edge (ra, rb) of triangle f its value is 0: the plane, the silhouette.
  const crossing = (f, ra, rb) => {
    if (modeOf(f) === 1) {
      const ha = w(ra), hb = w(rb);
      return (plane - ha) / (hb - ha);
    }
    const va = value(f, ra), vb = value(f, rb);
    return va / (va - vb);
  };
  const along = (ra, rb, t) => [0, 1, 2].map((c) => P[3 * ra + c] + t * (P[3 * rb + c] - P[3 * ra + c]));
  const pointOn = (f, ra, rb) => along(ra, rb, crossing(f, ra, rb));
  const at = (r) => [P[3 * r], P[3 * r + 1], P[3 * r + 2]];
  // A typed array: every triangle of a large mesh.
  const splitState = new Uint8Array(nt);
  const isSplit = (f) => (splitState[f] ||= split(f) ? 2 : 1) === 2;
  return { given, side, field, shade, mesh, grid, modeOf, shapeOf, value, nearOf, isSplit, splitState, crossing, along, pointOn, at };
}

/**
 * Parting line of a split into halves: where the surface goes from the upper
 * half to the lower one, round the undercut regions (undercutHalves). Along
 * the edges between triangles of the two halves, and, with a planar line
 * (`plane`: its height along d), across the faces both halves can form, the
 * undercuts and the faces flagged LEVEL (`flags`), cut at that height,
 * unless reassigned by hand (`fixed`); without a plane, across the triangles
 * flagged SILHOUETTE and SHADOW (lineCuts).
 *
 * side   -- half of each triangle (SIDE_*)
 * height -- of the part along d, for the planarity tolerance
 * Returns {segments (Float32Array, xyz of both ends of each piece),
 * length_mm, loops, planar, kind ("planar", "stepped", "warped", or null
 * without a line), height_range_mm, heights_mm [lowest, highest] along d,
 * level (the height most of its length is at: the median), levels (heights
 * of its level runs)}.
 */
export function partingLine(line, side, d, options = {}) {
  const { pieces } = lineOf(line, side, d, options);
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
  const shape = lineShape(ends, d, { height: options.height ?? null, loops });
  return { segments, length_mm: shape.length_mm, loops, planar: shape.planar, kind: shape.kind, height_range_mm: shape.height_range_mm, heights_mm: shape.heights_mm, level: shape.level, levels: shape.levels };
}

/**
 * The pieces of the parting line of a split (partingLine): {cut (lineCuts),
 * pieces ([xyz, xyz, key, key]: the ends of each and what they are, a
 * vertex, a point of an edge), hooks (taken out of it, unhook)}.
 */
function lineOf(line, side, d, options) {
  const { plane = null } = options;
  const { positions: P, indices: I, welded, neighbours } = line;
  const nt = I.length / 3;
  const cutting = lineCuts(line, side, d, options);
  side = cutting.side;
  // How each triangle cut is cut: 1 by the plane, 2 by its silhouette, 3 by the edges of shadows.
  const { modeOf, shapeOf, value, nearOf, isSplit, splitState, crossing, along, pointOn, at } = cutting;
  // [xyz, xyz, key, key, whole?]: the ends of each piece and what they are (a vertex, a point of an edge); along the
  // edge of a triangle not cut, a point inside it (its centroid), or true when both triangles of the edge are whole.
  const pieces = [];
  const centroid = (w) => {
    const [a, b, c] = [at(I[3 * w]), at(I[3 * w + 1]), at(I[3 * w + 2])];
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  };
  // A point at t along edge (wa, wb) (welded) where a cut crosses it: by where it is along the edge (two cuts of
  // their own, the silhouettes of two faces or a silhouette and an iso-line, cross it at points of their own, joined
  // along it; the same point for the triangles on either side of a cut, the line goes on). A plane crosses an edge
  // once: by the edge alone (its vertices' copies of two faces, welded but not bit for bit the same, would put the
  // crossing at two points a hair apart, the line broken there).
  const edgeKey = (wa, wb, t) => {
    if (plane != null) return wa < wb ? `e${wa},${wb}` : `e${wb},${wa}`;
    return wa < wb ? `e${wa},${wb}@${Math.round(t * 1e9)}` : `e${wb},${wa}@${Math.round((1 - t) * 1e9)}`;
  };
  // The vertex of triangle g at welded vertex wv (the faces of a CAD body have their own: the values of g's surface).
  const corner = (g, wv) => (welded[3 * g] === wv ? I[3 * g] : welded[3 * g + 1] === wv ? I[3 * g + 1] : I[3 * g + 2]);
  // The halves along edge (wa, wb) of triangle x cut, from wa to wb: [{from, to, upper, keyFrom, keyTo}].
  const runsAlong = (x, wa, wb) => {
    const ra = corner(x, wa), rb = corner(x, wb);
    if (modeOf(x) !== 3) {
      const ha = value(x, ra), hb = value(x, rb);
      if (!(ha * hb < 0)) return [{ from: 0, to: 1, upper: ha + hb > 0, keyFrom: `v${wa}`, keyTo: `v${wb}` }];
      const t = crossing(x, ra, rb);
      return [{ from: 0, to: t, upper: ha > 0, keyFrom: `v${wa}`, keyTo: edgeKey(wa, wb, t) }, { from: t, to: 1, upper: hb > 0, keyFrom: edgeKey(wa, wb, t), keyTo: `v${wb}` }];
    }
    const s = shapeOf(x);
    let e = 0;
    while (e < 3 && !((welded[3 * x + e] === wa && welded[3 * x + ((e + 1) % 3)] === wb) || (welded[3 * x + e] === wb && welded[3 * x + ((e + 1) % 3)] === wa))) e++;
    const forward = welded[3 * x + e] === wa;
    const key = (i) => (i < 0 ? null : `e${s.events[i].lo},${s.events[i].hi}:${s.events[i].i}`);
    let out = s.runs(e).map(([from, to, half, i], k, list) => ({ from, to, upper: half === SIDE_UPPER, end: i, start: k ? list[k - 1][3] : -1 }));
    out = out.map((r) => ({ from: r.from, to: r.to, upper: r.upper, keyFrom: key(r.start) ?? `v${welded[3 * x + e]}`, keyTo: key(r.end) ?? `v${welded[3 * x + ((e + 1) % 3)]}` }));
    if (forward) return out;
    return out.reverse().map((r) => ({ from: 1 - r.to, to: 1 - r.from, upper: r.upper, keyFrom: r.keyTo, keyTo: r.keyFrom }));
  };
  // The parts of edge (wa, wb) where the half along it differs: one side cut (x), the other of half `other`, or both cut (x, y).
  const edgeParts = (x, y, other, wa, wb) => {
    const ra = corner(x, wa), rb = corner(x, wb);
    const a = runsAlong(x, wa, wb), b = y >= 0 ? runsAlong(y, wa, wb) : [{ from: 0, to: 1, upper: other === SIDE_UPPER, keyFrom: `v${wa}`, keyTo: `v${wb}` }];
    // The breaks of both, each with its key.
    const breaks = new Map([[0, `v${wa}`], [1, `v${wb}`]]);
    for (const r of [...a, ...b]) {
      if (!breaks.has(r.from)) breaks.set(r.from, r.keyFrom);
      if (!breaks.has(r.to)) breaks.set(r.to, r.keyTo);
    }
    const ts = [...breaks.keys()].sort((p, q) => p - q);
    const upperAt = (runs, t) => runs.find((r) => t >= r.from && t <= r.to).upper;
    let open = null;
    const close = (t) => {
      if (open == null) return;
      pieces.push([open.t === 0 ? at(ra) : along(ra, rb, open.t), t === 1 ? at(rb) : along(ra, rb, t), open.key, breaks.get(t)]);
      open = null;
    };
    for (let k = 0; k + 1 < ts.length; k++) {
      const m = (ts[k] + ts[k + 1]) / 2;
      const differ = upperAt(a, m) !== upperAt(b, m);
      if (differ && open == null) open = { t: ts[k], key: breaks.get(ts[k]) };
      // A piece ends at every break (each a point of the line).
      if (open != null) close(ts[k + 1]);
    }
  };

  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f) continue; // free, non-manifold, or seen from the other triangle
      const sf = side[f], sg = side[g];
      const wa = welded[3 * f + e], wb = welded[3 * f + ((e + 1) % 3)];
      const xf = isSplit(f), xg = isSplit(g);
      // The edge as a vertex pair of the triangle cut (of f when neither is).
      const ra = xf || !xg ? I[3 * f + e] : corner(g, wa), rb = xf || !xg ? I[3 * f + ((e + 1) % 3)] : corner(g, wb);
      if (!xf && !xg) {
        if (sf !== SIDE_NONE && sg !== SIDE_NONE && sf !== sg) pieces.push([at(ra), at(rb), `v${wa}`, `v${wb}`, true]);
        continue;
      }
      if (xf && xg) {
        // The same rule on both sides; but two faces cut by rules or values of their own (silhouettes of two faces, a silhouette and a shadow): the parts of the edge where they differ.
        const ga = corner(g, wa), gb = corner(g, wb);
        if (plane == null && (ga !== ra || gb !== rb || modeOf(f) === 3 || modeOf(g) === 3 || modeOf(f) !== modeOf(g))) edgeParts(f, g, null, wa, wb);
        continue;
      }
      // One side cut (upper above the plane, on the upper side of the silhouette or the shadow), the other of one half: the part of the edge where they differ.
      const x = xf ? f : g;
      const other = xf ? sg : sf;
      if (other === SIDE_NONE) continue;
      if (modeOf(x) === 3) {
        edgeParts(x, -1, other, wa, wb);
        continue;
      }
      const keepAbove = other === SIDE_LOWER;
      const ha = value(x, ra), hb = value(x, rb);
      const inA = keepAbove ? ha > 0 : ha < 0;
      const inB = keepAbove ? hb > 0 : hb < 0;
      if (inA && inB) pieces.push([at(ra), at(rb), `v${wa}`, `v${wb}`, centroid(xf ? g : f)]);
      else if (inA !== inB && Math.abs(hb - ha) > nearOf(x)) {
        const t = crossing(x, ra, rb);
        const cut = along(ra, rb, t);
        pieces.push(inA ? [at(ra), cut, `v${wa}`, edgeKey(wa, wb, t)] : [cut, at(rb), edgeKey(wa, wb, t), `v${wb}`]);
      }
    }
  }
  // Across the faces cut by the plane, a silhouette or the edges of shadows.
  for (let f = 0; f < nt; f++) {
    if (splitState[f] !== 2) continue;
    if (modeOf(f) === 3) {
      const { events, cuts } = shapeOf(f);
      const key = (ev) => `e${ev.lo},${ev.hi}:${ev.i}`;
      for (const [i, j] of cuts) pieces.push([shadowPoint(P, I, f, events[i]), shadowPoint(P, I, f, events[j]), key(events[i]), key(events[j])]);
      continue;
    }
    const near = nearOf(f);
    const ends = [];
    for (let e = 0; e < 3; e++) {
      const ra = I[3 * f + e], rb = I[3 * f + ((e + 1) % 3)];
      const ha = value(f, ra), hb = value(f, rb);
      if (Math.abs(ha) <= near) ends.push([at(ra), `v${welded[3 * f + e]}`]);
      else if (ha * hb < 0 && Math.abs(hb) > near) {
        const t = crossing(f, ra, rb);
        ends.push([along(ra, rb, t), edgeKey(welded[3 * f + e], welded[3 * f + ((e + 1) % 3)], t)]);
      }
    }
    if (ends.length === 2) pieces.push([ends[0][0], ends[1][0], ends[0][1], ends[1][1]]);
  }
  const hooks = [];
  unhook(pieces, hooks);
  dropSmallLoops(line, pieces, hooks);
  return { cut: cutting, pieces, hooks };
}

/**
 * The small closed loops of a line taken out, in place: a loop of at most
 * SMALL_LOOP_PIECES pieces (chained by their keys, each point on two of
 * them) enclosing less than λ² (lineTension of the part), every piece of it
 * across a triangle (a point of an edge at one end at least): a sliver
 * between two cuts that meet, the silhouettes of two faces, a silhouette and
 * the edge of a shadow, inside the triangles they cut; each into `hooks` as
 * the fan of triangles from its first point (partingPieces: its inside, the
 * parts of those triangles, on the other side of the line, as the line round
 * it). A loop round a whole triangle stays (the rim of a pin hole, a small
 * face of its own): the hooks move the parts of the triangles cut, not it,
 * its half the colours show. So does one with a piece along an edge between
 * two whole triangles of different halves (one of them inside).
 */
function dropSmallLoops(line, pieces, hooks) {
  if (pieces.length < 3) return;
  const size = line.diag ??= (() => {
    const P = line.positions;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], P[i]);
      hi[i % 3] = Math.max(hi[i % 3], P[i]);
    }
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  })();
  const lambda = lineTension(size);
  const byEnd = new Map();
  pieces.forEach(([, , ka, kb], k) => {
    for (const key of [ka, kb]) (byEnd.get(key) ?? byEnd.set(key, []).get(key)).push(k);
  });
  const seen = new Uint8Array(pieces.length);
  const drop = new Uint8Array(pieces.length);
  for (let k0 = 0; k0 < pieces.length; k0++) {
    if (seen[k0]) continue;
    // The loop from piece k0: each of its points on two pieces exactly, back to its start.
    const loop = [k0];
    const points = [pieces[k0][0]], keys = [pieces[k0][2]];
    seen[k0] = 1;
    let key = pieces[k0][3], at = pieces[k0][1], closed = false, simple = true;
    while (loop.length <= SMALL_LOOP_PIECES) {
      const list = byEnd.get(key);
      if (list.length !== 2) {
        simple = false;
        break;
      }
      const next = list[0] === loop.at(-1) ? list[1] : list[0];
      if (next === k0) {
        closed = true;
        break;
      }
      if (seen[next]) {
        simple = false;
        break;
      }
      seen[next] = 1;
      loop.push(next);
      points.push(at);
      keys.push(key);
      const forward = pieces[next][2] === key;
      at = forward ? pieces[next][1] : pieces[next][0];
      key = forward ? pieces[next][3] : pieces[next][2];
    }
    if (!closed || !simple || loop.length < 3) continue;
    // Along an edge between two whole triangles: one of them inside.
    if (loop.some((k) => pieces[k][4] === true)) continue;
    // Its area (Newell): under λ².
    const n = [0, 0, 0];
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    });
    if (!(Math.hypot(n[0], n[1], n[2]) / 2 < lambda * lambda)) continue;
    // Along the edge of a whole triangle: that triangle inside (on the left of the piece seen from n, the loop
    // turning round n) or not sure which side.
    const wholeInside = loop.some((k, i) => {
      const c = pieces[k][4];
      if (!c) return false;
      const p = points[i], q = points[(i + 1) % points.length];
      const e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const left = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]];
      return (c[0] - p[0]) * left[0] + (c[1] - p[1]) * left[1] + (c[2] - p[2]) * left[2] >= 0;
    });
    if (wholeInside) continue;
    for (const k of loop) drop[k] = 1;
    for (let i = 1; i + 1 < points.length; i++) hooks.push({ X: points[0], A: points[i], B: points[i + 1], kx: keys[0], ka: keys[i], kb: keys[i + 1] });
  }
  let m = 0;
  for (let k = 0; k < pieces.length; k++) if (!drop[k]) pieces[m++] = pieces[k];
  pieces.length = m;
}

/**
 * The triangles a split's parting line crosses, cut where it crosses them,
 * for the colours of the halves and the undercuts to change on the line,
 * not along the edges of the triangles: by the plane, the silhouette or the
 * chords across the edges of shadows (lineCuts: the same cuts as
 * partingLine); where the line takes out a hook (unhook), the triangle
 * between the hook and the piece put instead on the other side of it, in
 * the triangles whose plane it is in (one the line goes along the edges of
 * cut there too). The pieces of a triangle cover it once, convex polygons in
 * its plane wound as it is. Each piece:
 * - half: the side of the line it is on (SIDE_UPPER, SIDE_LOWER; an undercut
 *   region in the half it is joined to, undercutHalves);
 * - undercut: formed by no half, as the view colours a triangle (no REACH_*,
 *   not reassigned by hand); but, by the plane, of a face with draft only
 *   one half can form, on the side that half cannot reach (trapAtLevel; of a
 *   triangle flagged TRAPPED, the half of its larger part); off its
 *   triangle's half across the edge of a shadow, by the lines of sight from
 *   its middle (a part of a long triangle in a shadow no half reaches);
 * - near: an undercut triangle whose colour it takes (its slide zone,
 *   nearUndercuts): its own, else one beside it; -1 none.
 * Nothing for a line along the edges of the triangles (count 0). Options as
 * partingLine. Returns {count, tri (Int32Array: the triangle of each piece,
 * ascending), half, undercut (Uint8Array), near (Int32Array), start
 * (Uint32Array, count + 1: its first corner), points (Float64Array: xyz of
 * the corners, in the frame of the positions)}.
 */
export function partingPieces(line, side, d, options = {}) {
  const { flags = null, fixed = null } = options;
  const { positions: P, indices: I, welded, neighbours } = line;
  const nt = I.length / 3;
  const { cut, hooks } = lineOf(line, side, d, options);
  const { modeOf, shapeOf, value, nearOf, isSplit, pointOn, at } = cut;
  const joined = cut.side;
  // Coloured as an undercut: formed by no half, not reassigned by hand.
  const undercutTri = (f) => !!flags && !(flags[f] & (REACH_UP | REACH_DOWN)) && !fixed?.[f];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], P[i]);
    hi[i % 3] = Math.max(hi[i % 3], P[i]);
  }
  const diag = P.length ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
  // Parts of no area (twice their area below this), off an edge by the rounding (this far at most).
  const small = 1e-12 * diag * diag, onEdge = 1e-9 * Math.max(1, diag, ...lo.map(Math.abs), ...hi.map(Math.abs));
  // Twice the area of a polygon (xyz).
  const area2 = (poly) => {
    const s = [0, 0, 0];
    for (let k = 1; k + 1 < poly.length; k++) {
      const u = [0, 1, 2].map((c) => poly[k][c] - poly[0][c]), v = [0, 1, 2].map((c) => poly[k + 1][c] - poly[0][c]);
      s[0] += u[1] * v[2] - u[2] * v[1];
      s[1] += u[2] * v[0] - u[0] * v[2];
      s[2] += u[0] * v[1] - u[1] * v[0];
    }
    return Math.hypot(s[0], s[1], s[2]);
  };
  const corners = (f) => [at(I[3 * f]), at(I[3 * f + 1]), at(I[3 * f + 2])];

  // The pieces of each triangle cut: [{poly (xyz), half}].
  const byTri = new Map();
  const trapped = new Map(); // a triangle flagged TRAPPED across the plane: the half of its larger part
  for (let f = 0; f < nt; f++) {
    if (!isSplit(f)) continue;
    const list = [];
    if (modeOf(f) !== 3) {
      // By the plane or the silhouette: the corners and the points where the value changes sign, on either side.
      const near = nearOf(f);
      const upper = [], lower = [];
      for (let e = 0; e < 3; e++) {
        const ra = I[3 * f + e], rb = I[3 * f + ((e + 1) % 3)];
        const ha = value(f, ra), hb = value(f, rb);
        if (Math.abs(ha) <= near) upper.push(at(ra)), lower.push(at(ra));
        else (ha > 0 ? upper : lower).push(at(ra));
        if (Math.abs(ha) > near && ha * hb < 0 && Math.abs(hb) > near) {
          const p = pointOn(f, ra, rb);
          upper.push(p);
          lower.push(p);
        }
      }
      list.push({ poly: upper, half: SIDE_UPPER }, { poly: lower, half: SIDE_LOWER });
      if (modeOf(f) === 1 && flags[f] & TRAPPED) trapped.set(f, area2(upper) >= area2(lower) ? SIDE_UPPER : SIDE_LOWER);
    } else {
      // Across the edges of shadows: a piece per arc cut off by a chord, and the rest (shadowShape).
      const { events, cuts, drawn, middle } = shapeOf(f);
      const n = events.length;
      const corner = (k) => at(I[3 * f + k]);
      const event = (i) => shadowPoint(P, I, f, events[i]);
      // The corners of f between event a and the next one round its outline (all three round from the last to the first on one edge).
      const between = (a, b) => {
        let steps = (events[b].e - events[a].e + 3) % 3;
        if (!steps && b <= a) steps = 3;
        return Array.from({ length: steps }, (_, k) => corner((events[a].e + 1 + k) % 3));
      };
      const chordFrom = new Set(cuts.map(([i]) => i));
      const rest = [];
      for (let a = 0; a < n; a++) {
        rest.push(event(a));
        if (!chordFrom.has(a)) rest.push(...between(a, (a + 1) % n)); // else a chord to the next event
      }
      list.push({ poly: rest, half: middle });
      for (const [a, b] of cuts) list.push({ poly: [event(a), ...between(a, b), event(b)], half: drawn[a] });
    }
    byTri.set(f, list.filter((x) => x.poly.length >= 3));
  }

  // The hooks taken out of the line: the triangle between each and its other ends on the other side (in turn, as unhook took them out).
  if (hooks.length) {
    let nw = 0;
    for (let i = 0; i < welded.length; i++) if (welded[i] >= nw) nw = welded[i] + 1;
    const start = new Int32Array(nw + 1);
    for (let i = 0; i < welded.length; i++) start[welded[i] + 1]++;
    for (let w = 0; w < nw; w++) start[w + 1] += start[w];
    const around = new Int32Array(welded.length);
    const fill = start.slice(0, nw);
    for (let i = 0; i < welded.length; i++) around[fill[welded[i]]++] = (i / 3) | 0;
    // The triangles round a point of the line by its key: a vertex ("v<w>"), a point of an edge ("e<a>,<b>@<t>", "e<a>,<b>:<i>": round either end).
    const round = (key, out) => {
      for (const w of key.slice(1).split(/[:@]/)[0].split(",").map(Number)) for (let s = start[w]; s < start[w + 1]; s++) out.add(around[s]);
      return out;
    };
    const flip = (h) => (h === SIDE_UPPER ? SIDE_LOWER : SIDE_UPPER);
    for (const { X, A, B, kx, ka, kb } of hooks) {
      const near = round(kb, round(ka, round(kx, new Set())));
      for (const g of [...near].sort((x, y) => x - y)) {
        // In the plane of g (2D, its corners counter-clockwise).
        const [c0, c1, c2] = corners(g);
        const u = [0, 1, 2].map((k) => c1[k] - c0[k]), w = [0, 1, 2].map((k) => c2[k] - c0[k]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const lu = Math.hypot(u[0], u[1], u[2]), ln = Math.hypot(n[0], n[1], n[2]);
        if (!(lu > 0 && ln > 0)) continue;
        const ex = u.map((x) => x / lu), nn = n.map((x) => x / ln);
        // A hook across a crease (its triangle off the plane of g by more than 1 % of its size): left as it is.
        const size = Math.max(Math.hypot(A[0] - X[0], A[1] - X[1], A[2] - X[2]), Math.hypot(B[0] - X[0], B[1] - X[1], B[2] - X[2]), Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]));
        const offPlane = (p) => Math.abs((p[0] - c0[0]) * nn[0] + (p[1] - c0[1]) * nn[1] + (p[2] - c0[2]) * nn[2]);
        if (Math.max(offPlane(X), offPlane(A), offPlane(B)) > HOOK_PLANE * size + onEdge) continue;
        const ey = [nn[1] * ex[2] - nn[2] * ex[1], nn[2] * ex[0] - nn[0] * ex[2], nn[0] * ex[1] - nn[1] * ex[0]];
        const to2 = (p) => {
          const r = [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]];
          return [r[0] * ex[0] + r[1] * ex[1] + r[2] * ex[2], r[0] * ey[0] + r[1] * ey[1] + r[2] * ey[2]];
        };
        const to3 = ([x, y]) => [0, 1, 2].map((k) => c0[k] + x * ex[k] + y * ey[k]);
        let t = [X, A, B].map(to2);
        const turn = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]);
        if (!(Math.abs(turn) > small)) continue; // no triangle between them
        if (turn < 0) t = [t[0], t[2], t[1]];
        // The part of a polygon (2D) on the left of p -> q (keep), or on its right.
        const clip = (poly, p, q, keep) => {
          const out = [];
          const side = (r) => (keep ? 1 : -1) * ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
          poly.forEach((r, k) => {
            const s = poly[(k + 1) % poly.length];
            const a = side(r), b = side(s);
            if (a >= 0) out.push(r);
            if (a >= 0 !== b >= 0) out.push([r[0] + (a / (a - b)) * (s[0] - r[0]), r[1] + (a / (a - b)) * (s[1] - r[1])]);
          });
          return out;
        };
        const area = (poly) => {
          let s = 0;
          poly.forEach((r, k) => (s += r[0] * poly[(k + 1) % poly.length][1] - poly[(k + 1) % poly.length][0] * r[1]));
          return Math.abs(s);
        };
        const list = byTri.get(g) ?? [{ poly: corners(g), half: joined[g] }];
        const out = [];
        let touched = false;
        for (const piece of list) {
          let rest = piece.poly.map(to2);
          let inside = rest;
          for (let e = 0; e < 3; e++) inside = clip(inside, t[e], t[(e + 1) % 3], true);
          if (!(area(inside) > small)) {
            out.push(piece);
            continue;
          }
          touched = true;
          // Its parts out of the triangle, then the triangle's, on the other side.
          for (let e = 0; e < 3; e++) {
            const outside = clip(rest, t[e], t[(e + 1) % 3], false);
            if (area(outside) > small) out.push({ poly: outside.map(to3), half: piece.half });
            rest = clip(rest, t[e], t[(e + 1) % 3], true);
          }
          out.push({ poly: inside.map(to3), half: flip(piece.half) });
        }
        if (touched) byTri.set(g, out);
      }
    }
  }

  // The lines of sight from a point of triangle f (as shadowSight): neither half reaches it?
  let sight = null;
  const blocked = (f, poly) => {
    const { mesh, grid } = cut;
    if (!sight) sight = { sag: surfaceOf(mesh).sag, eps: mesh.diag * 1e-5, tEps: mesh.diag * 1e-7 };
    const N = mesh.normals, c = mesh.centre, off = sight.eps + sight.sag[f];
    const m = [0, 1, 2].map((k) => poly.reduce((sum, p) => sum + p[k], 0) / poly.length - c[k] + off * N[3 * f + k]);
    return lineHits(mesh, grid, f, m[0], m[1], m[2], sight.tEps) === 3;
  };
  // Whether a piece of triangle f in half h is an undercut.
  const undercutOf = (f, poly, h) => {
    if (isSplit(f) && modeOf(f) === 1) {
      const reach = flags[f] & (REACH_UP | REACH_DOWN);
      if (trapped.has(f)) return h === trapped.get(f);
      if (!reach) return true;
      if (reach === (REACH_UP | REACH_DOWN) || flags[f] & ZERO_DRAFT) return false;
      return h === (reach === REACH_UP ? SIDE_LOWER : SIDE_UPPER);
    }
    // Across the edge of a shadow: each piece by its lines of sight (a sliver in the shadow the undercuts left to a half, still in it).
    if ((isSplit(f) && modeOf(f) !== 3) || !cut.shade || (h === joined[f] && !isSplit(f))) return undercutTri(f);
    return blocked(f, poly);
  };
  // How far a piece runs along each edge of triangle f: its sides with both ends on that edge.
  const alongEdges = (f, poly) => {
    const c = corners(f);
    const off = (p, e) => {
      const a = c[e], b = c[(e + 1) % 3];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const l = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const s = l > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l : 0;
      return Math.hypot(ap[0] - s * ab[0], ap[1] - s * ab[1], ap[2] - s * ab[2]);
    };
    const runs = [0, 0, 0];
    poly.forEach((p, k) => {
      const q = poly[(k + 1) % poly.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (l > onEdge) for (let e = 0; e < 3; e++) if (off(p, e) <= onEdge && off(q, e) <= onEdge) runs[e] += l;
    });
    return runs;
  };
  const list = []; // {f, poly, half, undercut, runs, near}, by triangle
  for (const f of [...byTri.keys()].sort((x, y) => x - y)) {
    for (const { poly, half: h } of byTri.get(f)) {
      if (!(area2(poly) > small)) continue;
      const u = undercutOf(f, poly, h);
      list.push({ f, poly, half: h, undercut: u, runs: u ? alongEdges(f, poly) : null, near: -1 });
    }
  }
  nearUndercuts(list, neighbours, welded, undercutTri);
  const tri = [], half = [], under = [], near = [], start = [0], points = [];
  for (const x of list) {
    tri.push(x.f);
    half.push(x.half);
    under.push(x.undercut ? 1 : 0);
    near.push(x.near);
    for (const p of x.poly) points.push(p[0], p[1], p[2]);
    start.push(points.length / 3);
  }
  return {
    count: tri.length,
    tri: Int32Array.from(tri),
    half: Uint8Array.from(half),
    undercut: Uint8Array.from(under),
    near: Int32Array.from(near),
    start: Uint32Array.from(start),
    points: Float64Array.from(points),
  };
}

/**
 * The undercut triangle whose colour each undercut piece takes (its slide
 * zone), in place (`near`): its own when its triangle is one (undercutTri),
 * else one across the edge of its triangle it runs along the most, else in
 * turn the one of an undercut piece along that edge of a triangle cut there
 * (a corner cut off a fan of long triangles); -1 none. Shared by
 * partingPieces and the line drawn by hand (parting-draw.js). pieces: [{f,
 * undercut, runs (how far it runs along each edge of f), near}], their
 * triangles' neighbours across their edges and welded vertices (lineMesh).
 */
export function nearUndercuts(pieces, neighbours, welded, undercutTri) {
  const byTri = new Map();
  for (const x of pieces) {
    x.near = x.undercut && undercutTri(x.f) ? x.f : -1;
    (byTri.get(x.f) ?? byTri.set(x.f, []).get(x.f)).push(x);
  }
  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (const x of pieces) {
      if (!x.undercut || x.near >= 0) continue;
      const order = [0, 1, 2].filter((e) => x.runs[e] > 0).sort((a, b) => x.runs[b] - x.runs[a] || a - b);
      for (const e of order) {
        const g = neighbours[3 * x.f + e];
        if (g < 0) continue;
        if (undercutTri(g)) x.near = g;
        else {
          const wa = welded[3 * x.f + e], wb = welded[3 * x.f + ((e + 1) % 3)];
          let eg = 0;
          while (eg < 3 && !((welded[3 * g + eg] === wa && welded[3 * g + ((eg + 1) % 3)] === wb) || (welded[3 * g + eg] === wb && welded[3 * g + ((eg + 1) % 3)] === wa))) eg++;
          const y = eg < 3 ? byTri.get(g)?.find((y) => y.undercut && y.near >= 0 && y.runs[eg] > 0) : null;
          if (y) x.near = y.near;
        }
        if (x.near >= 0) break;
      }
      if (x.near >= 0) changed = true;
    }
  }
}

/**
 * The pieces of partingPieces (or of a drawn line, parting-draw.js) as
 * triangles, for the view: each polygon ear-clipped in its plane (the parts
 * of a drawn line round a clicked point are not convex), wound as it is,
 * corners repeated in a row left out. {corners (Float64Array, xyz of the
 * three corners of each triangle), piece (Int32Array: the piece of each)}.
 */
export function pieceTriangles({ count, start, points }) {
  const corners = [], piece = [];
  for (let k = 0; k < count; k++) {
    const ring = [];
    for (let j = start[k]; j < start[k + 1]; j++) {
      const p = [points[3 * j], points[3 * j + 1], points[3 * j + 2]];
      const q = ring.at(-1);
      if (!q || p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) ring.push(p);
    }
    while (ring.length > 1 && ring[0].every((x, c) => x === ring.at(-1)[c])) ring.pop();
    if (ring.length < 3) continue;
    // Its normal (Newell), and the plane it is drawn on: the other two axes.
    const n = [0, 0, 0];
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    });
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [a, b] = n[ax] >= 0 ? [(ax + 1) % 3, (ax + 2) % 3] : [(ax + 2) % 3, (ax + 1) % 3];
    const turn = (p, q, r) => (q[a] - p[a]) * (r[b] - p[b]) - (q[b] - p[b]) * (r[a] - p[a]);
    const emit = (p, q, r) => {
      corners.push(...p, ...q, ...r);
      piece.push(k);
    };
    const left = ring.slice();
    // An ear: a corner turning the polygon's way with no other corner inside its triangle; else (degenerate) a fan.
    while (left.length > 3) {
      let ear = -1;
      for (let i = 0; i < left.length && ear < 0; i++) {
        const p = left[(i + left.length - 1) % left.length], q = left[i], r = left[(i + 1) % left.length];
        if (!(turn(p, q, r) > 0)) continue;
        if (left.every((x) => x === p || x === q || x === r || turn(p, q, x) < 0 || turn(q, r, x) < 0 || turn(r, p, x) < 0)) ear = i;
      }
      if (ear < 0) break;
      emit(left[(ear + left.length - 1) % left.length], left[ear], left[(ear + 1) % left.length]);
      left.splice(ear, 1);
    }
    for (let i = 1; i + 1 < left.length; i++) emit(left[0], left[i], left[i + 1]);
  }
  return { corners: Float64Array.from(corners), piece: Int32Array.from(piece) };
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
  // Each level within tol of its lowest run (a climb cut into short pieces, each level, is not one level from its foot to its top).
  const levels = [];
  for (const [h, len] of runs) {
    const last = levels.at(-1);
    if (last && h - last.bottom <= tol) {
      last.length += len;
      last.sum += h * len;
    } else levels.push({ bottom: h, length: len, sum: h * len });
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

/** The JSON of a classification of direction d (with its orientation for the process: orientation.js). */
function directionSummary(mesh, d, areas, height, parting, source, orientation = null) {
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
    ...(orientation ? { orientation } : {}),
  };
}

// A planar line first, then stepped (flat levels), then warped (a 3D die surface).
const LINE_RANK = { planar: 0, stepped: 1, warped: 2 };

/**
 * Ranking of two directions: less undercut first; then less steel in the die
 * block (within STEEL_TIE of the larger: equal); then the simpler parting
 * line (a non-planar one only when it removes undercuts: a dearer die); then
 * less zero-draft surface; then the larger projected area for the height of
 * the part (a shallower mould). Not the feeding of the casting process: the
 * die and its undercuts depend on the part and the draw direction, not on
 * where the metal comes in; the process only decides which way is up (the
 * casting up of the direction chosen, orientation.js). So the direction, its
 * die blank and its undercuts are the same whatever the process: the costing,
 * which sizes the die of every island from that blank, cannot retain another
 * island because of the orientation the island it retained causes.
 */
function better(a, b, total) {
  if (Math.abs(a.undercut - b.undercut) > UNDERCUT_TIE * total) return a.undercut - b.undercut;
  if (a.steel != null && b.steel != null && Math.abs(a.steel - b.steel) > STEEL_TIE * Math.max(a.steel, b.steel)) return a.steel - b.steel;
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
 * The half of a point of a triangle by its lines of sight along d (as
 * classify: off the triangle along its normal by eps and the stand-off of
 * its surface; both senses: the side of the silhouette of its face there,
 * phi of `field` (silhouetteField) between its corners, as the triangles cut
 * by a silhouette, else the sense of its smooth surface, see sidesOf;
 * neither: the half of the undercut region it borders). given: the halves
 * of the triangles (SIDE_NONE for an undercut); joined: the same, the
 * undercut regions joined to a half (undercutHalves). {sideAt(f, [x, y, z]),
 * point(f, a, b, t): the point at a + t (b - a) of its corners a, b
 * (offsets in the positions), off that edge into the triangle}.
 */
function shadowSight(mesh, grid, line, given, joined, d, field) {
  const { indices: I, neighbours } = line;
  const { positions: P, normals: N, diag } = mesh;
  const { sag, facesDown } = surfaceOf(mesh);
  const eps = diag * 1e-5, tEps = diag * 1e-7;
  // Both senses: below the silhouette (phi of the point < 0 beyond its rounding)?
  const below = (f, x, y, z) => {
    if (!field) return facesDown(f, d);
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const wx = x - P[a], wy = y - P[a + 1], wz = z - P[a + 2];
    const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
    const d20 = wx * ux + wy * uy + wz * uz, d21 = wx * vx + wy * vy + wz * vz;
    const den = d00 * d11 - d01 * d01;
    if (!(den > 0)) return facesDown(f, d);
    const s = (d11 * d20 - d01 * d21) / den, t = (d00 * d21 - d01 * d20) / den;
    const { phi, noise } = field;
    const ia = I[3 * f], ib = I[3 * f + 1], ic = I[3 * f + 2];
    const value = (1 - s - t) * phi[ia] + s * phi[ib] + t * phi[ic];
    return value < -(SILHOUETTE_TINY + Math.max(noise[ia], noise[ib], noise[ic]));
  };
  // In no half's reach: the half of the undercut region there (of the triangle, else of one at a vertex of it).
  const { start, around } = surfaceOf(mesh).vertexTriangles();
  const none = (f) => {
    if (given[f] === SIDE_NONE) return joined[f];
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g >= 0 && given[g] === SIDE_NONE) return joined[g];
    }
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k];
      for (let s = start[v]; s < start[v + 1]; s++) if (given[around[s]] === SIDE_NONE) return joined[around[s]];
    }
    return joined[f];
  };
  const hitsAt = (f, [x, y, z]) => {
    const off = eps + sag[f];
    return lineHits(mesh, grid, f, x + off * N[3 * f], y + off * N[3 * f + 1], z + off * N[3 * f + 2], tEps);
  };
  const sideAt = (f, [x, y, z]) => {
    const hits = hitsAt(f, [x, y, z]);
    const up = !(hits & 1), down = !(hits & 2);
    if (up && down) return below(f, x, y, z) ? SIDE_LOWER : SIDE_UPPER;
    return up ? SIDE_UPPER : down ? SIDE_LOWER : none(f);
  };
  // The point at t from corner a to corner b of f (offsets in P), off the edge into f: by 1 - SAMPLE_INSET of its
  // height square to the edge (not along it: a long triangle), or towards its centre from a corner (a = b); by
  // SHADOW_INSET of the diagonal at most.
  const point = (f, a, b, t) => {
    const out = [0, 0, 0], g = [0, 0, 0];
    let o = 3 * I[3 * f];
    if (o === a || o === b) o = 3 * I[3 * f + 1];
    if (o === a || o === b) o = 3 * I[3 * f + 2];
    let s = 0;
    if (a !== b) {
      let uu = 0, uo = 0;
      for (let c = 0; c < 3; c++) {
        uu += (P[b + c] - P[a + c]) ** 2;
        uo += (P[b + c] - P[a + c]) * (P[o + c] - P[a + c]);
      }
      s = uu > 0 ? uo / uu : 0;
    }
    for (let c = 0; c < 3; c++) {
      out[c] = P[a + c] + t * (P[b + c] - P[a + c]);
      g[c] = a === b ? (P[3 * I[3 * f] + c] + P[3 * I[3 * f + 1] + c] + P[3 * I[3 * f + 2] + c]) / 3 - out[c] : P[o + c] - (P[a + c] + s * (P[b + c] - P[a + c]));
    }
    const far = Math.hypot(g[0], g[1], g[2]);
    const k = far > 0 ? Math.min(1 - SAMPLE_INSET, (SHADOW_INSET * diag) / far) : 0;
    for (let c = 0; c < 3; c++) out[c] += k * g[c];
    return out;
  };
  // A vertex on the silhouette of its face (phi 0 within its rounding): its lines along d are tangent to the face, they
  // graze it; the side of the silhouette of the triangle there instead.
  const onSilhouette = (v) => !!field && field.curved[v] === 1 && Math.abs(field.phi[v]) <= SILHOUETTE_TINY + field.noise[v];
  const vertexSide = (f, k) => {
    const v = I[3 * f + k];
    const p = point(f, 3 * v, 3 * v, 0);
    if (!onSilhouette(v)) return sideAt(f, p);
    return below(f, p[0], p[1], p[2]) ? SIDE_LOWER : SIDE_UPPER;
  };
  // A corner both halves reach (off any silhouette): its half is a default, not the edge of a shadow.
  const vertexFree = (f, k) => {
    const v = I[3 * f + k];
    return !onSilhouette(v) && hitsAt(f, point(f, 3 * v, 3 * v, 0)) === 0;
  };
  return { sideAt, point, vertexSide, vertexFree, onSilhouette };
}

/**
 * Where the edges of the shadows along d cross the triangles flagged SHADOW
 * (shadowHalves): the half of each of their vertices by its lines of sight
 * (shadowSight, from a point of the triangle at that corner); along each of
 * their edges, the half at a quarter, half and three quarters of it, and
 * where it changes between them, halved 8 times (a shadow across a triangle
 * may cross an edge twice); in each, the half of its middle: of the middle
 * of the two arcs of its outline in one half when there are two such arcs
 * (a shadow through it, or a corner cut off on each side), else of its
 * centre. The first triangle flagged at a vertex or an edge looks from it
 * (the same points whatever the halves of the faces moved by hand). given,
 * joined: as shadowSight. Returns {label (per welded vertex: SIDE_*), cross
 * (Map "e<a>,<b>" (welded, a < b) -> where it changes from a to b, 0 to 1,
 * ascending), middle (per triangle: SIDE_*)}.
 */
function shadowLabels(mesh, grid, line, given, joined, flags, d, field) {
  const { indices: I, welded } = line;
  const { nt, positions: P } = mesh;
  const { sideAt, point, vertexSide, onSilhouette } = shadowSight(mesh, grid, line, given, joined, d, field);
  let nw = 0;
  for (let i = 0; i < welded.length; i++) if (welded[i] >= nw) nw = welded[i] + 1;
  const label = new Uint8Array(nw);
  const cross = new Map();
  const middle = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    if (cutOf(flags[f]) !== SHADOW) continue;
    for (let k = 0; k < 3; k++) {
      const v = welded[3 * f + k];
      if (!label[v]) label[v] = vertexSide(f, k);
    }
  }
  for (let f = 0; f < nt; f++) {
    if (cutOf(flags[f]) !== SHADOW) continue;
    for (let e = 0; e < 3; e++) {
      let k0 = e, k1 = (e + 1) % 3;
      if (welded[3 * f + k1] < welded[3 * f + k0]) [k0, k1] = [k1, k0];
      const wa = welded[3 * f + k0], wb = welded[3 * f + k1];
      const key = `e${wa},${wb}`;
      if (cross.has(key)) continue;
      // Along the silhouette (both ends on it): the side of it, no edge of a shadow.
      if (onSilhouette(I[3 * f + k0]) && onSilhouette(I[3 * f + k1])) {
        cross.set(key, []);
        continue;
      }
      const a = 3 * I[3 * f + k0], b = 3 * I[3 * f + k1];
      const ts = [0, 0.25, 0.5, 0.75, 1];
      const halves = ts.map((t, i) => (i === 0 ? label[wa] : i === 4 ? label[wb] : sideAt(f, point(f, a, b, t))));
      const list = [];
      for (let i = 0; i < 4; i++) {
        if (halves[i] === halves[i + 1]) continue;
        let lo = ts[i], hi = ts[i + 1];
        for (let step = 0; step < 8; step++) {
          const m = (lo + hi) / 2;
          if (sideAt(f, point(f, a, b, m)) === halves[i]) lo = m;
          else hi = m;
        }
        list.push((lo + hi) / 2);
      }
      cross.set(key, list);
    }
  }
  for (let f = 0; f < nt; f++) {
    if (cutOf(flags[f]) !== SHADOW) continue;
    const { events, arcs } = shadowOutline(f, I, welded, label, cross);
    const c = [0, 1, 2].map((k) => (P[3 * I[3 * f] + k] + P[3 * I[3 * f + 1] + k] + P[3 * I[3 * f + 2] + k]) / 3);
    if (events.length === 4) {
      // Between the middles of arcs 0 and 2 (the same half): that half through the middle, or the other.
      const at = (i) => {
        const p = shadowPoint(P, I, f, events[i]), q = shadowPoint(P, I, f, events[(i + 1) % 4]);
        return [0, 1, 2].map((k) => (p[k] + q[k]) / 2);
      };
      const p0 = at(0), p2 = at(2);
      const m = [0, 1, 2].map((k) => (p0[k] + p2[k]) / 2);
      middle[f] = sideAt(f, [0, 1, 2].map((k) => c[k] + SAMPLE_INSET * (m[k] - c[k]))) === arcs[0] ? arcs[0] : arcs[1];
    } else middle[f] = events.length ? sideAt(f, c) : arcs[0];
  }
  return { label, cross, middle };
}

/**
 * The outline of triangle f by the edges of the shadows (shadowLabels):
 * from its first corner round it, the points where its half changes
 * (events: {e (its edge), t (along it from its corner e), lo, hi (welded
 * vertices of the edge), i (index of the point along it from lo)}) and the
 * half of the arc of outline after each (arcs; with no event: [the half of
 * its corners]).
 */
function shadowOutline(f, I, welded, label, cross) {
  const events = [];
  for (let e = 0; e < 3; e++) {
    const wa = welded[3 * f + e], wb = welded[3 * f + ((e + 1) % 3)];
    const lo = Math.min(wa, wb), hi = Math.max(wa, wb);
    const list = cross.get(`e${lo},${hi}`) ?? [];
    const n = list.length;
    for (let j = 0; j < n; j++) {
      const i = wa < wb ? j : n - 1 - j;
      events.push({ e, t: wa < wb ? list[i] : 1 - list[i], lo, hi, i });
    }
  }
  const arcs = [];
  let half = label[welded[3 * f]];
  if (!events.length) return { events, arcs: [half] };
  // The half after each event: the other one.
  for (let k = 0; k < events.length; k++) arcs.push((half = half === SIDE_UPPER ? SIDE_LOWER : SIDE_UPPER));
  return { events, arcs };
}

/** The point of an event of shadowOutline on triangle f. */
function shadowPoint(P, I, f, { e, t }) {
  const a = 3 * I[3 * f + e], b = 3 * I[3 * f + ((e + 1) % 3)];
  return [P[a] + t * (P[b] - P[a]), P[a + 1] + t * (P[b + 1] - P[a + 1]), P[a + 2] + t * (P[b + 2] - P[a + 2])];
}

/**
 * How the line crosses triangle f flagged SHADOW (see shadowLabels): the
 * arcs of its outline in another half than its middle are cut off by a
 * chord each (cuts: pairs of events); an arc along one edge only is left in
 * the half of its middle (a shadow across an edge but not into the
 * triangle as drawn: by the triangle across that edge, if at all). The half
 * of the triangle (`half`: of most of it when one corner is cut off, else
 * of its middle), and the half along each of its edges at each event
 * (runs(e): [[from, to, half] along it from its corner e]); the half of its
 * middle and the one each arc is drawn in (`middle`, `drawn`: the pieces of
 * partingPieces).
 */
function shadowShape(f, P, I, welded, shade) {
  const { events, arcs } = shadowOutline(f, I, welded, shade.label, shade.cross);
  const n = events.length;
  const middle = n ? shade.middle[f] || arcs[0] : arcs[0];
  const cuts = [];
  // The half each arc is drawn in: its own when a chord cuts it off, else the middle's.
  const drawn = new Uint8Array(Math.max(n, 1)).fill(middle);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (arcs[i] === middle || events[i].e === events[j].e) continue;
    cuts.push([i, j]);
    drawn[i] = arcs[i];
  }
  // Along edge e from its corner: [[from, to, half], ...], a run per change.
  const runs = (e) => {
    let h = drawn[n ? n - 1 : 0];
    for (let i = 0; i < n && events[i].e < e; i++) h = drawn[i];
    const out = [];
    let from = 0;
    for (let i = 0; i < n; i++) {
      if (events[i].e !== e || drawn[i] === h) continue;
      out.push([from, events[i].t, h, i]);
      from = events[i].t;
      h = drawn[i];
    }
    out.push([from, 1, h, -1]);
    return out;
  };
  let half = middle;
  if (cuts.length === 1) {
    // One region cut off: the half of most of the triangle (the area of that region from its outline).
    const [i, j] = cuts[0];
    const poly = [shadowPoint(P, I, f, events[i])];
    for (let e = events[i].e; e !== events[j].e; e = (e + 1) % 3) {
      const c = 3 * I[3 * f + ((e + 1) % 3)];
      poly.push([P[c], P[c + 1], P[c + 2]]);
    }
    poly.push(shadowPoint(P, I, f, events[j]));
    const area = (pts) => {
      const s = [0, 0, 0];
      for (let k = 1; k + 1 < pts.length; k++) {
        const u = [0, 1, 2].map((c) => pts[k][c] - pts[0][c]), v = [0, 1, 2].map((c) => pts[k + 1][c] - pts[0][c]);
        s[0] += u[1] * v[2] - u[2] * v[1];
        s[1] += u[2] * v[0] - u[0] * v[2];
        s[2] += u[0] * v[1] - u[1] * v[0];
      }
      return Math.hypot(s[0], s[1], s[2]);
    };
    const whole = area([0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1], P[3 * I[3 * f + k] + 2]]));
    if (whole > 0 && area(poly) > whole / 2) half = arcs[i];
  }
  return { events, cuts, runs, half, middle, drawn };
}

/**
 * The edges of the shadows across the faces, for a line that is not planar
 * (after silhouetteHalves): where the halves (the undercut regions joined to
 * one, see undercutHalves) meet inside a smooth surface (across an edge of
 * a face, not along one), their triangles there are flagged SHADOW, and with
 * them every triangle of that surface at a vertex of one of them whose half
 * by its lines of sight is not the triangle's (the edge of a shadow across a
 * fan of long triangles: all of them), at most SHADOW_MAX of the triangles;
 * the line goes where the lines of sight change (shadowLabels), across
 * them, not along their edges (a staircase, spikes along a fan); each of
 * them not an undercut in the half of most of it by that line. The flags (a
 * new array, or `flags` itself), `side` changed in place.
 */
function shadowHalves(mesh, grid, line, side, flags, d, across = null) {
  const { indices: I, neighbours, welded } = line;
  const { normals: N, nt } = mesh;
  // The triangles across the edge of a shadow by their points (`across`, not cut by a silhouette): flagged first, the
  // undercuts joined with them (not along the edges between them, joinUndercuts).
  let out = flags;
  if (across) {
    for (let f = 0; f < nt; f++) {
      if (!across[f] || flags[f] & SILHOUETTE) continue;
      if (out === flags) out = Uint8Array.from(flags);
      out[f] |= SHADOW;
    }
  }
  const joined = undercutHalves(line, side, d, null, out);
  const smoothWith = (f, g) => N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2] > SMOOTH_FACETS;
  const band = new Uint8Array(nt);
  const queue = [];
  const field = silhouetteField(line, d);
  // An edge along the silhouette of a curved face (both ends on it): the line along it is right, its lines of sight graze.
  const onSilhouette = (v) => !!field && field.curved[v] === 1 && Math.abs(field.phi[v]) <= SILHOUETTE_TINY + field.noise[v];
  const alongSilhouette = (f) => (onSilhouette(I[3 * f]) ? 1 : 0) + (onSilhouette(I[3 * f + 1]) ? 1 : 0) + (onSilhouette(I[3 * f + 2]) ? 1 : 0) >= 2;
  // A triangle at a vertex of one cut by a silhouette: the line there follows the silhouette (two cuts of their own
  // side by side would leave slivers, small loops, between them).
  const { start, around } = surfaceOf(mesh).vertexTriangles();
  const byCut = (f) => {
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k];
      for (let s = start[v]; s < start[v + 1]; s++) if (flags[around[s]] & SILHOUETTE) return true;
    }
    return false;
  };
  const enter = (f) => {
    if (band[f] || flags[f] & SILHOUETTE || joined[f] === SIDE_NONE || alongSilhouette(f) || byCut(f)) return;
    band[f] = 1;
    queue.push(f);
  };
  // A triangle on the side of the silhouette of its face it is in the half of (phi at its centre of that sign, beyond its rounding).
  const facing = (h) => {
    if (!field) return false;
    const a = I[3 * h], b = I[3 * h + 1], c = I[3 * h + 2];
    const { phi, noise } = field;
    const v = (phi[a] + phi[b] + phi[c]) / 3, tol = SILHOUETTE_TINY + Math.max(noise[a], noise[b], noise[c]);
    return joined[h] === SIDE_UPPER ? v > tol : v < -tol;
  };
  const has = (g, v) => I[3 * g] === v || I[3 * g + 1] === v || I[3 * g + 2] === v;
  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f || joined[f] === joined[g] || joined[f] === SIDE_NONE || joined[g] === SIDE_NONE) continue;
      if (!has(g, I[3 * f + e]) || !has(g, I[3 * f + ((e + 1) % 3)]) || !smoothWith(f, g)) continue;
      // A silhouette along their common edge or across one of them: the line is there already.
      if ((facing(f) && facing(g)) || (flags[f] | flags[g]) & SILHOUETTE) continue;
      enter(f);
      enter(g);
    }
  }
  if (!queue.length) {
    // Those next to a silhouette's cut (not entered): as given.
    if (out === flags) return flags;
    for (let f = 0; f < nt; f++) if (out[f] & SHADOW && !band[f]) out[f] &= ~SHADOW;
    return out;
  }
  // The band grown across the triangles the edges of the shadows cross.
  const { vertexSide, vertexFree } = shadowSight(mesh, grid, line, side, joined, d, field);
  const seen = new Map(); // welded vertex -> its half (0: both halves reach it)
  const most = Math.max(SHADOW_MIN, SHADOW_MAX * nt);
  for (let q = 0; q < queue.length; q++) {
    const f = queue[q];
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k], wv = welded[3 * f + k];
      let half = seen.get(wv);
      // A corner both halves reach: no shadow to follow from it (its half would be a default, the sense its face
      // faces, where the optimum may have put the face in the other half: the band would flood it, cut into a comb).
      if (half === undefined) seen.set(wv, (half = vertexFree(f, k) ? 0 : vertexSide(f, k)));
      if (!half) continue;
      for (let s = start[v]; s < start[v + 1] && queue.length < most; s++) {
        const g = around[s];
        if (!band[g] && joined[g] !== half && smoothWith(f, g)) enter(g);
      }
    }
  }
  if (out === flags) out = Uint8Array.from(flags);
  // Flagged: the band (those of `across` it left out, by a silhouette, not).
  for (let f = 0; f < nt; f++) if (out[f] & SHADOW && !band[f]) out[f] &= ~SHADOW;
  for (const f of queue) out[f] |= SHADOW;
  // The joins with the band flagged (as partingLine has them).
  const final = undercutHalves(line, side, d, null, out);
  const shade = shadowLabels(mesh, grid, line, side, final, out, d, field);
  for (const f of queue) if (side[f] !== SIDE_NONE) side[f] = shadowShape(f, line.positions, I, welded, shade).half;
  return out;
}


// The iso-line of the halves (isoField): its Gauss-Seidel sweeps, until no value moves by more than ISO_STILL;
// across facets no longer than ISO_MAX × the tension of the line (isoHalves).
const ISO_SWEEPS = 400;
const ISO_STILL = 1e-12;
const ISO_MAX = 4;

/**
 * The halves smoothed round their line where it is cut along their iso-line
 * (the triangles flagged ISO_CUT, not reassigned by hand), per vertex (by
 * index, the value of its welded vertex): +1 in the upper half, -1 in the
 * lower one (`joined`: the undercuts joined to a half), harmonic over the
 * band (each vertex of it with all its triangles in it the mean of the
 * vertices it shares an edge with), from the vertices on its border, each
 * the mean of the halves of its triangles out of it. Its zero runs through
 * the band where the halves meet, smoothed: across the triangles, not along
 * the staircase of their edges. It depends only on the halves round the
 * band: the same once those of the band are set from it. NaN off the band.
 */
function isoField(line, joined, flags, fixed = null) {
  const { indices: I, welded } = line;
  const nt = I.length / 3;
  const { start, around } = weldedTriangles(line);
  const nw = start.length - 1;
  const band = (f) => cutOf(flags[f]) === ISO_CUT && !fixed?.[f];
  const value = new Float64Array(nw).fill(NaN);
  const free = new Uint8Array(nw);
  const sign = (f) => (joined[f] === SIDE_UPPER ? 1 : joined[f] === SIDE_LOWER ? -1 : 0);
  const touched = [];
  for (let f = 0; f < nt; f++) {
    if (!band(f)) continue;
    for (let k = 0; k < 3; k++) {
      const v = welded[3 * f + k];
      if (!Number.isNaN(value[v]) || free[v]) continue;
      let out = 0, sum = 0;
      for (let s = start[v]; s < start[v + 1]; s++) {
        const g = around[s];
        if (band(g)) continue;
        out++;
        sum += sign(g);
      }
      if (out) value[v] = sum / out;
      else {
        free[v] = 1;
        value[v] = 0;
        touched.push(v);
      }
    }
  }
  touched.sort((a, b) => a - b);
  for (let sweep = 0; sweep < ISO_SWEEPS; sweep++) {
    let moved = 0;
    for (const v of touched) {
      let sum = 0, n = 0;
      for (let s = start[v]; s < start[v + 1]; s++) {
        const g = around[s];
        for (let k = 0; k < 3; k++) {
          const u = welded[3 * g + k];
          if (u === v) continue;
          sum += value[u];
          n++;
        }
      }
      const next = n ? sum / n : 0;
      moved = Math.max(moved, Math.abs(next - value[v]));
      value[v] = next;
    }
    if (moved <= ISO_STILL) break;
  }
  // Per vertex by index.
  const out = new Float64Array(line.positions.length / 3).fill(NaN);
  for (let i = 0; i < I.length; i++) out[I[i]] = value[welded[i]];
  return out;
}

/**
 * The line of the halves of a line that is not planar across the smooth
 * surfaces where it is neither on a silhouette nor on the edge of a shadow
 * (after silhouetteHalves, shadowHalves): the optimum along the edges of
 * small facets (a blend, a finely meshed face: a staircase, teeth round
 * them) smoothed. Where the halves (the undercuts joined to one) meet across
 * an edge inside a face (its two facets with its vertices: not the border
 * of two faces, a clean line already) less than 35° apart, neither cut,
 * both formable by either half (where the evidence leaves the optimum free
 * to place it), both no longer than ISO_MAX × λ (lineTension; longer ones,
 * the strips of a cylinder, the fans of a flat face, are cut by their
 * silhouettes and shadows), the facets of that face round its ends that are
 * as small, as free and not cut, flagged ISO_CUT: the line across them
 * along the zero of the halves smoothed
 * (isoField), each not cut in the half of the sign there (`side` changed in
 * place, but the undercuts), until the joins of the undercuts no longer
 * change (as partingLine has them). The flags (a new array, or `flags`
 * itself).
 */
function isoHalves(mesh, line, side, flags, d) {
  const { indices: I, neighbours, welded } = line;
  const { normals: N, nt, areas, sliver, reach, diag } = mesh;
  const most = ISO_MAX * lineTension(diag);
  // Both halves can form it (a face only one can form keeps its half: the line along its border is the evidence's,
  // the edge of a shadow along the edges of the facets); not an undercut (the line goes round its region, along its
  // border).
  const small = (f) => reach[f] <= most && areas[f] >= sliver && !cutOf(flags[f]) && side[f] !== SIDE_NONE && isFree(flags[f]);
  const smoothWith = (f, g) => N[3 * f] * N[3 * g] + N[3 * f + 1] * N[3 * g + 1] + N[3 * f + 2] * N[3 * g + 2] > SMOOTH_FACETS;
  const has = (g, v) => I[3 * g] === v || I[3 * g + 1] === v || I[3 * g + 2] === v;
  // Inside a face (the triangles round a vertex by its index: of its face; a border of faces, a fillet's with a face,
  // is a clean line already).
  const { start, around } = surfaceOf(mesh).vertexTriangles();
  let joined = undercutHalves(line, side, d, null, flags);
  const ends = new Set();
  for (let f = 0; f < nt; f++) {
    if (!small(f)) continue;
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f || !small(g) || joined[f] === joined[g] || joined[f] === SIDE_NONE || joined[g] === SIDE_NONE || !smoothWith(f, g)) continue;
      if (!has(g, I[3 * f + e]) || !has(g, I[3 * f + ((e + 1) % 3)])) continue;
      ends.add(I[3 * f + e]);
      ends.add(I[3 * f + ((e + 1) % 3)]);
    }
  }
  if (!ends.size) return flags;
  const out = Uint8Array.from(flags);
  const band = [];
  for (const v of [...ends].sort((a, b) => a - b)) {
    for (let s = start[v]; s < start[v + 1]; s++) {
      const g = around[s];
      if (!small(g) || cutOf(out[g])) continue;
      out[g] |= ISO_CUT;
      band.push(g);
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const iso = isoField(line, joined, out);
    for (const f of band) {
      if (side[f] === SIDE_NONE) continue;
      const m = iso[I[3 * f]] + iso[I[3 * f + 1]] + iso[I[3 * f + 2]];
      if (m > 0) side[f] = SIDE_UPPER;
      else if (m < 0) side[f] = SIDE_LOWER;
    }
    const again = undercutHalves(line, side, d, null, out);
    let same = true;
    for (let f = 0; f < nt && same; f++) same = again[f] === joined[f];
    if (same) break;
    joined = again;
  }
  return out;
}

/**
 * The silhouettes of the halves of a line that is not planar (the optimum
 * of optimiseHalves), `side` changed in place; the flags with SILHOUETTE (a
 * new array, or `flags` itself): across a band of triangles of a curved face
 * that turns from facing +d to facing -d (phi of silhouetteField changes
 * sign between their corners) between the halves, the upper one on its side
 * of the silhouette and the lower one on the other, the line follows the
 * silhouette across them (flagged SILHOUETTE, each in the half of its
 * centre), not their edges (a staircase, or a zigzag along staggered rows).
 */
function silhouetteHalves(mesh, grid, line, side, flags, d) {
  const { nt, areas, sliver } = mesh;
  const { indices: I, neighbours } = line;
  const reachOf = (half) => (half === SIDE_UPPER ? REACH_UP : REACH_DOWN);
  const can = (f, half) => areas[f] < sliver || (flags[f] & reachOf(half)) !== 0;
  const comp = new Int32Array(nt).fill(-1);
  const queue = new Int32Array(nt);
  // Silhouettes.
  const field = silhouetteField(line, d);
  if (!field) return flags;
  const { phi, smooth, noise } = field;
  // Of either sign beyond the rounding of their normals (an exact plane along d: neither).
  const below = (v) => phi[v] < -(SILHOUETTE_TINY + noise[v]), above = (v) => phi[v] > SILHOUETTE_TINY + noise[v];
  const centre = (f) => (phi[I[3 * f]] + phi[I[3 * f + 1]] + phi[I[3 * f + 2]]) / 3;
  const band = new Uint8Array(nt);
  let any = false;
  for (let f = 0; f < nt; f++) {
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    if (!(smooth[a] && smooth[b] && smooth[c]) || areas[f] < sliver) continue;
    if (!((below(a) || below(b) || below(c)) && (above(a) || above(b) || above(c)))) continue;
    const target = centre(f) >= 0 ? SIDE_UPPER : SIDE_LOWER;
    if (side[f] !== SIDE_NONE && !can(f, target)) continue;
    band[f] = 1;
    any = true;
  }
  if (!any) return flags;
  const effective = undercutHalves(line, side, d, null, flags);
  const P = line.positions;
  const edgeLength = (f, e) => {
    const ra = 3 * I[3 * f + e], rb = 3 * I[3 * f + ((e + 1) % 3)];
    return Math.hypot(P[rb] - P[ra], P[rb + 1] - P[ra + 1], P[rb + 2] - P[ra + 2]);
  };
  let out = flags;
  for (let f0 = 0; f0 < nt; f0++) {
    if (!band[f0] || comp[f0] >= 0) continue;
    let head = 0, tail = 0, agree = 0, disagree = 0, upper = false, lower = false;
    comp[f0] = f0;
    queue[tail++] = f0;
    while (head < tail) {
      const f = queue[head++];
      for (let e = 0; e < 3; e++) {
        const g = neighbours[3 * f + e];
        if (g < 0) continue;
        if (band[g]) {
          if (comp[g] < 0) {
            comp[g] = f0;
            queue[tail++] = g;
          }
          continue;
        }
        // A triangle beside the band: in the half of its side of the silhouette?
        // (its corners all of one sign beyond their rounding; a face along d: neither)
        const ga = I[3 * g], gb = I[3 * g + 1], gc = I[3 * g + 2];
        const up = above(ga) || above(gb) || above(gc), down = below(ga) || below(gb) || below(gc);
        if (up === down || effective[g] === SIDE_NONE) continue;
        const len = edgeLength(f, e);
        const want = up ? SIDE_UPPER : SIDE_LOWER;
        if (effective[g] === want) {
          agree += len;
          if (want === SIDE_UPPER) upper = true;
          else lower = true;
        } else disagree += len;
      }
    }
    if (!(upper && lower) || disagree > SILHOUETTE_DISAGREE * (agree + disagree)) continue;
    if (out === flags) out = Uint8Array.from(flags);
    for (let k = 0; k < tail; k++) {
      const f = queue[k];
      out[f] |= SILHOUETTE;
      if (side[f] !== SIDE_NONE) side[f] = centre(f) >= 0 ? SIDE_UPPER : SIDE_LOWER;
    }
  }
  return out;
}

/**
 * A direction classified on every triangle: {areas, side, flags, plane, line,
 * height}. The halves optimised over the surface (optimiseHalves), the flags
 * those of the optimum (optimisedFlags). A plane that leaves every triangle
 * one half only can form on its side: a planar line. Else the halves of the
 * optimum, the line across the triangles along the silhouettes, the edges of
 * the shadows and the iso-line of the small facets (silhouetteHalves,
 * shadowHalves, isoHalves). That line all within the planar tolerance of one
 * height: the plane at that height (trapAtLevel), unless it traps more than
 * that tolerance along the line. Else a stepped or warped line, unless the
 * shadows of the details on flat faces along d split them between the halves
 * (as classified) over more area than a planar line at the best level traps
 * (bestLevel, trapAtLevel): then that planar line.
 */
function fullDirection(mesh, d, sinDraft, getLine, coarseLimit = COARSE_LIMIT) {
  const grid = lineGrid(mesh, d);
  const evidence = newEvidence(mesh.nt);
  let flags = classify(mesh, grid, d, null, sinDraft, evidence);
  const classified = Uint8Array.from(flags);
  const optimum = optimiseHalves(mesh, getLine(), evidence, d, coarseLimit);
  const noise = noiseUndercuts(mesh, getLine(), classified);
  optimisedFlags(flags, optimum, noise);
  // The triangles across the edge of a shadow by their points (straddles): the line goes across them.
  const straddling = Uint8Array.from(optimum.under, (_, f) => (straddles(evidence, f) ? 1 : 0));
  let plane = planeHeight(mesh, flags, d, planarTolerance(grid.height), getLine());
  if (plane == null) {
    // A plane by the triangles as classified, that the halves the optimum gave the noise broke (a speck formed by
    // the half round it, across that plane): that plane, the noise formed by the half of its side of it.
    const classifiedPlane = planeHeight(mesh, classified, d, planarTolerance(grid.height), getLine());
    if (classifiedPlane != null) {
      plane = classifiedPlane;
      const level = plane - dot(mesh.centre, d), C = mesh.centres;
      flags = Uint8Array.from(classified, (flag, f) => {
        if (!noise[f] || flag & (REACH_UP | REACH_DOWN)) return flag;
        return flag | (C[3 * f] * d[0] + C[3 * f + 1] * d[1] + C[3 * f + 2] * d[2] < level ? REACH_DOWN : REACH_UP);
      });
    }
  }
  const split = (plane) => {
    const line = getLine();
    let side;
    if (plane != null) {
      side = sidesOf(mesh, flags, d, plane, line);
      inheritSlivers(mesh, side, line.neighbours);
    } else side = optimisedSides(optimum);
    // The halves of the optimum cut along silhouettes, shadows and iso-lines.
    const cut = plane == null ? isoHalves(mesh, line, side, shadowHalves(mesh, grid, line, side, silhouetteHalves(mesh, grid, line, side, flags, d), d, straddling), d) : flags;
    return { side, flags: cut, line: partingLine(line, side, d, { flags: cut, plane, height: grid.height, mesh, grid }) };
  };
  let halves;
  let trapped = null;
  if (plane != null) {
    levelFree(flags);
    halves = split(plane);
  } else {
    halves = split(null);
    const tol = planarTolerance(grid.height);
    const [lo, hi] = halves.line.heights_mm ?? [0, 0];
    if (halves.line.planar && hi - halves.line.level <= tol && halves.line.level - lo <= tol) {
      // The optimum's line all within the planar tolerance of one height: cut by that plane (straight across
      // the faces, not along their edges), unless it traps more than the band of that tolerance along the line.
      // (A detour round a detail, in the 5 % of its length a planar line may have off its height, stays: the
      // plane would trap that detail.)
      const level = halves.line.level - dot(mesh.centre, d);
      const trap = trapAtLevel(mesh, flags, d, level);
      if (trap.trapped <= tol * halves.line.length_mm) {
        flags = trap.flags;
        trapped = trap.trapped;
        plane = halves.line.level;
        halves = split(plane);
      }
    }
    // What a planar line is weighed against: the flat area the shadows split, in the halves of the triangles
    // as classified (the free area the optimum adds to a shadow, for a shorter line, is its choice, not forced).
    let across = 0;
    if (plane == null && !halves.line.planar) {
      const forced = sidesOf(mesh, classified, d, null, getLine());
      inheritSlivers(mesh, forced, getLine().neighbours);
      across = splitFlatArea(mesh, getLine().neighbours, classified, forced);
    }
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
  return { areas, side: halves.side, flags: halves.flags, plane, line: halves.line, height: grid.height };
}

/**
 * The orientation of direction d for the process (orientation.js), and the
 * direction to classify: on a horizontal parting plane whose up is -d, -d
 * when `orient` (the halves swapped: the upper die on top, up = +d).
 */
function orientDirection(om, d, options, orient) {
  let o = orientationFor(om, d, options);
  if (orient && o.side === "-d") {
    d = d.map((x) => -x + 0);
    o = orientationFor(om, d, { ...options, up: d });
  }
  return { d, o };
}

/**
 * Proposed draw direction and parting line of a closed body.
 *
 * positions, indices -- its mesh (mm); not modified
 * draftDeg -- faces closer than this to the draw direction have no draft
 * process -- {plan: "vertical" | "horizontal", alimentation: "haut" | "bas"}
 *            (orientation.js; default: gravity, vertical plane, top feed):
 *            the casting up of each candidate, on a horizontal plane the
 *            sense of d; not the direction proposed (better)
 * die -- the die block options {marges, densite, cavities} (default: those of
 *        the costing, orientation.js DIE_DEFAULTS)
 * thickness -- inscribed diameter per triangle (the thickness card), or null:
 *        the feeding score (the casting up) from the volume centroid
 * Returns {proposal, side, flags, plane, segments}: the JSON proposal
 * {status, axis, direction, candidate_index, candidates [...], sampled,
 * method, process, die, options_key, ... the figures of the direction chosen,
 * its orientation}, and for that direction, per triangle, its half (SIDE_*)
 * and flags (REACH_*, ZERO_DRAFT), the height of its planar line along d
 * (null: none), and the segments of its parting line. On a horizontal parting
 * plane each candidate is in the sense whose up is +d.
 */
export function proposeParting(positions, indices, { draftDeg = DEFAULT_DRAFT_DEG, fullLimit = FULL_LIMIT, samples = SAMPLES, seed = SEED, onProgress = null, process = null, die = null, thickness = null } = {}) {
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
  const om = orientationMesh(positions, indices, mesh);
  const options = { process: normalizeProcess(process), die: normalizeDie(die), thickness };

  const evaluated = axes.map(({ direction, source }) => {
    const { d, o } = orientDirection(om, direction, options, true);
    let item;
    if (!sampled) {
      item = { ...fullDirection(mesh, d, sinDraft, getLine), d, source, o };
    } else {
      const grid = lineGrid(mesh, d);
      const areas = areasOf(mesh, d, classify(mesh, grid, d, list, sinDraft), list);
      areas.zeroDraft = zeroDraftArea(mesh, d, sinDraft);
      item = { areas, height: grid.height, line: null, d, source, o };
    }
    progress();
    return item;
  });
  // The same keys whatever the process: the sense of d (up = +d on a horizontal plane) changes none of them.
  const key = (e) => ({ undercut: e.areas.undercut, steel: e.o.steel, zeroDraft: e.areas.zeroDraft, ratio: e.height > 0 ? e.areas.projected / e.height : 0, kind: e.line?.kind ?? null });
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

  const candidates = evaluated.map((e) => directionSummary(mesh, e.d, e.areas, e.height, e.line, e.source, e.o.summary));
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
      process: options.process,
      die: options.die,
      options_key: orientationKey(options.process, options.die),
    },
    side: best.side,
    flags: best.flags,
    plane: best.plane,
    segments: best.line.segments,
  };
}

/**
 * One direction d of a body, classified on every triangle (a direction
 * chosen or typed by hand): {summary (as a candidate of proposeParting, with
 * its orientation), side, flags, plane, segments}.
 *
 * process, die, thickness -- as proposeParting
 * up -- the up direction wanted (a vector, or a side: "+u", "-v", "+d"…),
 *       the allowed one nearest to it; else chosen by the feeding
 * orient -- on a horizontal parting plane whose up is -d: classified along
 *       -d (the halves swapped, up = +d), as proposeParting does; else d as
 *       given, its summary saying that the upper half is at the bottom
 *       (orientation.upper_half_down)
 * coarseLimit -- above this many triangles, the halves optimised on patches
 *       of them (COARSE_LIMIT; lower in the tests of the patches)
 */
export function evaluateParting(positions, indices, direction, { draftDeg = DEFAULT_DRAFT_DEG, process = null, die = null, thickness = null, up = null, orient = false, coarseLimit = COARSE_LIMIT } = {}) {
  const given = normalize(direction);
  if (!given) throw new Error("Invalid draw direction");
  const mesh = prepareMesh(positions, indices);
  const options = { process: normalizeProcess(process), die: normalizeDie(die), thickness, up };
  const { d, o } = orientDirection(orientationMesh(positions, indices, mesh), given, options, orient);
  let line = null;
  const full = fullDirection(mesh, d, Math.sin((draftDeg * Math.PI) / 180), () => (line ??= lineMesh(positions, indices, mesh.merged)), coarseLimit);
  return {
    summary: {
      ...directionSummary(mesh, d, full.areas, full.height, full.line, "manual", o.summary),
      draft_angle_deg: draftDeg,
      surface_area_mm2: round(mesh.totalArea, 1),
      triangles: mesh.nt,
      options_key: orientationKey(options.process, options.die),
    },
    side: full.side,
    flags: full.flags,
    plane: full.plane,
    segments: full.line.segments,
  };
}
