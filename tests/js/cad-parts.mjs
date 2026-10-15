// Cast parts meshed as a CAD body is (synthetic, for the tests of the
// optimised parting halves): each B-rep face with its own vertices, flat
// faces ear-clipped round their holes, cylinders in strips of two long
// triangles from end to end (see curved-mesh.mjs); and the same parts
// finely meshed (each triangle cut into 4^levels).
//
// - bossedTube: a tube along x with sector bosses on it: along X the strips
//   of the tube (exactly along d) in the shadows of the bosses;
// - holedBlock: a block with through holes along y and z;
// - studBlock: a block with a ledge on one side and a stud on the other, of
//   a few tenths of a millimetre (below the tension of the line) or more;
// - groovedBlock: a block with a groove round its four sides;
// - cylBosses: a cylinder with radial bosses blended into it, meshed by OCCT
//   (a fixture).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { Body } from './curved-mesh.mjs';
import { ROOT } from './helpers.mjs';

export const TUBE = {
  r: 20,
  length: 120,
  segments: 48,
  // Sector bosses: over the strips [from, to) of the tube, x from x0 to x1, h above it.
  bosses: [
    { from: 2, to: 6, x0: 15, x1: 30, h: 12 },
    { from: 10, to: 14, x0: 45, x1: 58, h: 10 },
    { from: 20, to: 23, x0: 70, x1: 80, h: 8 },
    { from: 30, to: 34, x0: 90, x1: 104, h: 12 },
  ],
};

/**
 * A tube along x (r 20, 120 long, its ends closed) in strips of two long
 * triangles, cut where the bosses stand; on it, sector bosses (radial sides,
 * flat ends, a cylindrical top in strips).
 */
export function bossedTube() {
  const { r, length: L, segments: n, bosses } = TUBE;
  const body = new Body();
  const angle = (i) => (2 * Math.PI * i) / n;
  const at = (x, i, rad) => [x, rad * Math.cos(angle(i)), rad * Math.sin(angle(i))];
  const cuts = [...new Set([0, L, ...bosses.flatMap((b) => [b.x0, b.x1])])].sort((a, b) => a - b);
  // The tube: a ring of points at each cut, the strips between two cuts but under a boss.
  const points = [], tris = [];
  const id = (k, i) => k * n + (i % n);
  for (const x of cuts) for (let i = 0; i < n; i++) points.push(at(x, i, r));
  const under = (i, xa, xb) => bosses.some((b) => i >= b.from && i < b.to && xa >= b.x0 && xb <= b.x1);
  for (let k = 0; k + 1 < cuts.length; k++) {
    for (let i = 0; i < n; i++) {
      if (!under(i, cuts[k], cuts[k + 1])) tris.push([id(k, i), id(k + 1, i), id(k + 1, i + 1)], [id(k, i), id(k + 1, i + 1), id(k, i + 1)]);
    }
  }
  body.addFace(points, tris, (c) => [0, c[1], c[2]]);
  // Its ends.
  const disc = Array.from({ length: n }, (_, i) => [r * Math.cos(angle(i)), r * Math.sin(angle(i))]);
  body.flat([0, 0, 0], [0, 1, 0], [0, 0, 1], disc, [], [-1, 0, 0]);
  body.flat([L, 0, 0], [0, 1, 0], [0, 0, 1], disc, [], [1, 0, 0]);
  for (const { from, to, x0, x1, h } of bosses) {
    const R = r + h;
    const top = [], strips = [];
    for (let i = from; i <= to; i++) top.push(at(x0, i, R), at(x1, i, R));
    for (let j = 0; j < to - from; j++) strips.push([2 * j, 2 * j + 1, 2 * j + 3], [2 * j, 2 * j + 3, 2 * j + 2]);
    body.addFace(top, strips, (c) => [0, c[1], c[2]]);
    const sector = [];
    for (let i = from; i <= to; i++) sector.push([r * Math.cos(angle(i)), r * Math.sin(angle(i))]);
    for (let i = to; i >= from; i--) sector.push([R * Math.cos(angle(i)), R * Math.sin(angle(i))]);
    body.flat([x0, 0, 0], [0, 1, 0], [0, 0, 1], sector, [], [-1, 0, 0]);
    body.flat([x1, 0, 0], [0, 1, 0], [0, 0, 1], sector, [], [1, 0, 0]);
    for (const [i, s] of [[from, -1], [to, 1]]) {
      const t = [-Math.sin(angle(i)) * s, Math.cos(angle(i)) * s];
      body.addFace([at(x0, i, r), at(x1, i, r), at(x1, i, R), at(x0, i, R)], [[0, 1, 2], [0, 2, 3]], () => [0, t[0], t[1]]);
    }
  }
  return body.mesh();
}

export const HOLED = {
  size: [80, 50, 20], // x, y, z
  // Through holes along y: [x, z, r]; along z: [x, y, r].
  alongY: [[15, 10, 3], [40, 10, 2], [62, 9, 5]],
  alongZ: [[27, 35, 2.5], [52, 38, 4], [72, 36, 2]],
  segments: 24,
};

/** A block 80 × 50 × 20 with three through holes along y and three along z (their walls in strips). */
export function holedBlock() {
  const { size: [L, W, H], segments: n } = HOLED;
  const body = new Body();
  const circle = (cx, cy, r) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  const rect = (a, b) => [[0, 0], [a, 0], [a, b], [0, b]];
  const yHoles = HOLED.alongY.map(([x, z, r]) => circle(x, z, r));
  const zHoles = HOLED.alongZ.map(([x, y, r]) => circle(x, y, r));
  body.flat([0, 0, 0], [1, 0, 0], [0, 0, 1], rect(L, H), yHoles.map((c) => [...c].reverse()), [0, -1, 0]);
  body.flat([0, W, 0], [1, 0, 0], [0, 0, 1], rect(L, H), yHoles.map((c) => [...c].reverse()), [0, 1, 0]);
  body.flat([0, 0, 0], [1, 0, 0], [0, 1, 0], rect(L, W), zHoles.map((c) => [...c].reverse()), [0, 0, -1]);
  body.flat([0, 0, H], [1, 0, 0], [0, 1, 0], rect(L, W), zHoles.map((c) => [...c].reverse()), [0, 0, 1]);
  body.flat([0, 0, 0], [0, 1, 0], [0, 0, 1], rect(W, H), [], [-1, 0, 0]);
  body.flat([L, 0, 0], [0, 1, 0], [0, 0, 1], rect(W, H), [], [1, 0, 0]);
  // The walls of the holes, facing their axis.
  const wall = (a, b, outward) => {
    const tris = [];
    for (let i = 0; i < n; i++) tris.push([i, (i + 1) % n, n + ((i + 1) % n)], [i, n + ((i + 1) % n), n + i]);
    body.addFace([...a, ...b], tris, outward);
  };
  HOLED.alongY.forEach(([x, z], k) => wall(yHoles[k].map(([u, v]) => [u, 0, v]), yHoles[k].map(([u, v]) => [u, W, v]), (c) => [x - c[0], 0, z - c[2]]));
  HOLED.alongZ.forEach(([x, y], k) => wall(zHoles[k].map(([u, v]) => [u, v, 0]), zHoles[k].map(([u, v]) => [u, v, H]), (c) => [x - c[0], y - c[1], 0]));
  return body.mesh();
}

/**
 * A block 40 × 30 × 20 (x, y, z) with a ledge along the foot of its +x side
 * (`ledge`: [its height z, its depth, its thickness]) and a stud on its -x
 * side (`stud`: [its depth, its width along y, its thickness], its underside
 * at z = `at`). Along Z the top of the ledge only the upper half reaches,
 * under the underside of the stud and the strip of wall in its shadow, only
 * the lower half: no plane leaves them on their sides.
 */
export function studBlock({ stud = [0.3, 2, 0.3], at = 12, ledge = [0.2, 0.3, 0.3] } = {}) {
  const [L, W, H] = [40, 30, 20];
  const [sp, sw, sh] = stud, [lz, lp, lh] = ledge;
  const y0 = (W - sw) / 2, y1 = y0 + sw;
  const body = new Body();
  const quad = (p, q, r, s, normal) => body.addFace([p, q, r, s], [[0, 1, 2], [0, 2, 3]], () => normal);
  body.flat([0, 0, 0], [1, 0, 0], [0, 1, 0], [[0, 0], [L, 0], [L, W], [0, W]], [], [0, 0, -1]);
  body.flat([0, 0, H], [1, 0, 0], [0, 1, 0], [[0, 0], [L, 0], [L, W], [0, W]], [], [0, 0, 1]);
  // The y faces, with the profile of the ledge.
  const profile = [[0, 0], [L, 0], [L, lz], [L + lp, lz], [L + lp, lz + lh], [L, lz + lh], [L, H], [0, H]];
  body.flat([0, 0, 0], [1, 0, 0], [0, 0, 1], profile, [], [0, -1, 0]);
  body.flat([0, W, 0], [1, 0, 0], [0, 0, 1], profile, [], [0, 1, 0]);
  // The +x side: below the ledge, the ledge (underside, front, top), above it.
  quad([L, 0, 0], [L, W, 0], [L, W, lz], [L, 0, lz], [1, 0, 0]);
  quad([L, 0, lz], [L, W, lz], [L + lp, W, lz], [L + lp, 0, lz], [0, 0, -1]);
  quad([L + lp, 0, lz], [L + lp, W, lz], [L + lp, W, lz + lh], [L + lp, 0, lz + lh], [1, 0, 0]);
  quad([L, 0, lz + lh], [L + lp, 0, lz + lh], [L + lp, W, lz + lh], [L, W, lz + lh], [0, 0, 1]);
  quad([L, 0, lz + lh], [L, W, lz + lh], [L, W, H], [L, 0, H], [1, 0, 0]);
  // The -x side round the foot of the stud (u = y, v = z), and the stud.
  body.flat([0, 0, 0], [0, 1, 0], [0, 0, 1], [[0, 0], [W, 0], [W, H], [0, H]], [[[y0, at], [y0, at + sh], [y1, at + sh], [y1, at]]], [-1, 0, 0]);
  quad([0, y0, at], [-sp, y0, at], [-sp, y1, at], [0, y1, at], [0, 0, -1]);
  quad([0, y0, at + sh], [0, y1, at + sh], [-sp, y1, at + sh], [-sp, y0, at + sh], [0, 0, 1]);
  quad([-sp, y0, at], [-sp, y0, at + sh], [-sp, y1, at + sh], [-sp, y1, at], [-1, 0, 0]);
  quad([0, y0, at], [0, y0, at + sh], [-sp, y0, at + sh], [-sp, y0, at], [0, -1, 0]);
  quad([0, y1, at], [-sp, y1, at], [-sp, y1, at + sh], [0, y1, at + sh], [0, 1, 0]);
  return body.mesh();
}

/**
 * A block L × L × H (x, y, z) with a groove `width` high and `depth` deep
 * round its four sides, its floor at z = `at` (each face flat, its own
 * vertices): along Z the groove is an undercut (a slide), whatever its size.
 */
export function groovedBlock({ L = 120, H = 40, at = 20, width = 1, depth = 1 } = {}) {
  const body = new Body();
  const quad = (p, q, r, s, normal) => body.addFace([p, q, r, s], [[0, 1, 2], [0, 2, 3]], () => normal);
  const square = (a, b) => [[a, a], [b, a], [b, b], [a, b]];
  const top = at + width;
  body.flat([0, 0, 0], [1, 0, 0], [0, 1, 0], square(0, L), [], [0, 0, -1]);
  body.flat([0, 0, H], [1, 0, 0], [0, 1, 0], square(0, L), [], [0, 0, 1]);
  // The groove's floor and ceiling: rings round the inner square of its back.
  const inner = square(depth, L - depth).reverse();
  body.flat([0, 0, at], [1, 0, 0], [0, 1, 0], square(0, L), [inner], [0, 0, 1]);
  body.flat([0, 0, top], [1, 0, 0], [0, 1, 0], square(0, L), [inner], [0, 0, -1]);
  // The four sides: below the groove, above it, and its back.
  const corners = [[0, 0], [L, 0], [L, L], [0, L]];
  const back = [[depth, depth], [L - depth, depth], [L - depth, L - depth], [depth, L - depth]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
    const normal = [by - ay, ax - bx, 0].map((x) => Math.sign(x));
    quad([ax, ay, 0], [bx, by, 0], [bx, by, at], [ax, ay, at], normal);
    quad([ax, ay, top], [bx, by, top], [bx, by, H], [ax, ay, H], normal);
    const [cx, cy] = back[i], [dx, dy] = back[(i + 1) % 4];
    quad([cx, cy, at], [dx, dy, at], [dx, dy, top], [cx, cy, top], normal);
  }
  return body.mesh();
}

/**
 * A cylinder R 40, 200 long along x, with radial bosses (R 8 to 12, 15 above
 * it) at 0, 35, 70, 110 and 150° from +y towards +z, each blended into it by
 * a fillet R 4, a hole R 3 through two of them: a STEP body made with OCCT
 * for these tests, meshed as the page meshes it (3546 triangles; the fixture
 * tests/fixtures/cyl_bosses.mesh.gz: nv, nt (uint32), the positions
 * (float32), the indices (uint32)).
 */
export function cylBosses() {
  const buf = gunzipSync(readFileSync(join(ROOT, 'tests', 'fixtures', 'cyl_bosses.mesh.gz')));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const [nv, nt] = new Uint32Array(bytes, 0, 2);
  return { positions: new Float32Array(bytes, 8, 3 * nv), indices: new Uint32Array(bytes, 8 + 12 * nv, 3 * nt) };
}

/** A mesh with each triangle cut into 4^levels at the middles of its edges (a finely meshed body), its faces kept. */
export function subdivided({ positions, indices, face }, levels) {
  const P = Array.from(positions);
  let I = Array.from(indices), F = face ? Array.from(face) : null;
  for (let l = 0; l < levels; l++) {
    const middle = new Map(), next = [], nextFace = [];
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = middle.get(key);
      if (m === undefined) {
        m = P.length / 3;
        P.push((P[3 * a] + P[3 * b]) / 2, (P[3 * a + 1] + P[3 * b + 1]) / 2, (P[3 * a + 2] + P[3 * b + 2]) / 2);
        middle.set(key, m);
      }
      return m;
    };
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      if (F) nextFace.push(F[t / 3], F[t / 3], F[t / 3], F[t / 3]);
    }
    I = next;
    F = F && nextFace;
  }
  return { positions: Float32Array.from(P), indices: Uint32Array.from(I), ...(F ? { face: Int32Array.from(F) } : {}) };
}
