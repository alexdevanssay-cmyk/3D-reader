// Cast parts meshed as a CAD body is (synthetic, for the parting line tests
// on curved faces and faces along the draw direction): each B-rep face with
// its own vertices, its flat faces ear-clipped round their holes into long
// thin triangles (the mesher of a CAD kernel without inner points), the rows
// of a cone staggered by half a step from one to the next (as OpenCascade
// meshes a cone), the positions in float32.
//
// - zBracket: a Z bracket (no planar line along Z), turned about Z (its walls
//   along Z across the frame: n·d of their long triangles off 0 by the
//   rounding of float32), a boss with 0.5° of draft on its upper flange;
// - mushroom: a cap on a stem over a base plate, overhanging it: along Z the
//   edge of the base's shadow crosses the fan of the cap's underside;
// - peg: a cylinder out of a wall over a ledge with an oblique front, meshed
//   in strips of long triangles: along Z the edge of the ledge's shadow
//   crosses them obliquely.
import { ShapeUtils, Vector2 } from 'three';

/** A body built face by face: {face (its B-rep faces' triangles), mesh()}. */
class Body {
  constructor() {
    this.positions = [];
    this.indices = [];
    this.faceOf = [];
    this.faces = 0;
  }

  /** One face: its points (xyz) and triangles (index triples), each turned to face along `outward(centre)`. */
  addFace(points, triangles, outward) {
    const base = this.positions.length / 3;
    for (const p of points) this.positions.push(...p);
    for (const [a, b, c] of triangles) {
      const pa = points[a], pb = points[b], pc = points[c];
      const u = [0, 1, 2].map((k) => pb[k] - pa[k]), v = [0, 1, 2].map((k) => pc[k] - pa[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const o = outward([0, 1, 2].map((k) => (pa[k] + pb[k] + pc[k]) / 3));
      const flip = n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0;
      this.indices.push(base + a, base + (flip ? c : b), base + (flip ? b : c));
      this.faceOf.push(this.faces);
    }
    return this.faces++;
  }

  /**
   * A flat face: an outline and holes (2D points in the frame origin o, axes
   * u, v), ear-clipped, facing along `normal`.
   */
  flat(o, u, v, outline, holes, normal) {
    const v2 = (pts) => pts.map(([x, y]) => new Vector2(x, y));
    const tris = ShapeUtils.triangulateShape(v2(outline), holes.map(v2));
    const points = [...outline, ...holes.flat()].map(([a, b]) => [0, 1, 2].map((k) => o[k] + a * u[k] + b * v[k]));
    return this.addFace(points, tris, () => normal);
  }

  /** A band between two closed rings of as many points (xyz), ring b turned half a step from ring a when `staggered`. */
  band(a, b, outward, staggered = false) {
    const n = a.length;
    const tris = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (staggered) tris.push([i, j, n + i], [j, n + j, n + i]);
      else tris.push([i, j, n + j], [i, n + j, n + i]);
    }
    return this.addFace([...a, ...b], tris, outward);
  }

  /** {positions (Float32Array), indices (Uint32Array), faces, face (per triangle)}, turned by `turn`° about z. */
  mesh(turn = 0) {
    const t = (turn * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const P = new Float32Array(this.positions.length);
    for (let i = 0; i < P.length; i += 3) {
      const [x, y, z] = [this.positions[i], this.positions[i + 1], this.positions[i + 2]];
      P[i] = c * x - s * y;
      P[i + 1] = s * x + c * y;
      P[i + 2] = z;
    }
    return { positions: P, indices: Uint32Array.from(this.indices), faces: this.faces, face: Int32Array.from(this.faceOf) };
  }
}

/** Points from a to b (2D), `step` apart at most, a included, b not. */
function along([ax, ay], [bx, by], step) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
  return Array.from({ length: n }, (_, i) => [ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
}

/** Ring of n points (xyz) at height z about (cx, cy), radius r, the first at angle `phase` steps. */
const ring = (cx, cy, z, r, n, phase = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * (i + phase)) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
  });

export const BRACKET = {
  depth: 40,
  // The Z profile (x, z), counter-clockwise seen from -y: lower flange (x < -6, z 0..8), web, upper flange (x > 6, z 22..30).
  profile: [[-40, 0], [6, 0], [6, 22], [40, 22], [40, 30], [-6, 30], [-6, 8], [-40, 8]],
  step: 2, // the profile cut every 2 mm (the caps: fans of long thin triangles)
  boss: { x: 23, y: 20, r: 12, height: 12, draftDeg: 0.5, rows: 4, segments: 16 },
};

/**
 * The Z bracket, its long flat faces along the y axis, turned by `turn`°
 * about z; `boss` false: without its boss. Along Z its line is stepped: round
 * the bottom face (z = 0) and round the underside of the upper flange (z = 22).
 */
export function zBracket({ turn = 20, boss = true } = {}) {
  const body = new Body();
  const { depth: D, profile, step } = BRACKET;
  const n = profile.length;
  // Its profile cut every `step`: the caps and the walls share those points.
  const cut = profile.map((p, i) => along(p, profile[(i + 1) % n], step));
  const outline = cut.flat();
  // Caps: y = 0 (seen from -y: (x, z) counter-clockwise) and y = D.
  body.flat([0, 0, 0], [1, 0, 0], [0, 0, 1], outline, [], [0, -1, 0]);
  body.flat([0, D, 0], [1, 0, 0], [0, 0, 1], outline, [], [0, 1, 0]);
  // Walls: one flat face per edge of the profile, its points on both caps.
  const B = BRACKET.boss;
  const t = Math.tan((B.draftDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const [x0, z0] = profile[i], [x1, z1] = profile[(i + 1) % n];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const u = [(x1 - x0) / len, 0, (z1 - z0) / len];
    const normal = [u[2], 0, -u[0]]; // outward for a counter-clockwise (x, z) profile
    const pts = cut[i].map(([x, z]) => [(x - x0) * u[0] + (z - z0) * u[2], 0]);
    const wall = [...pts, [len, 0], [len, D], ...pts.map(([a]) => [a, D]).reverse()];
    // The top of the upper flange (z = 30, x 40 -> -6): round the foot of the boss.
    const holes = [];
    if (boss && z0 === 30 && z1 === 30) holes.push(ring(B.x, B.y, 30, B.r, B.segments).map(([x, y]) => [(x - x0) * u[0], y]).reverse());
    body.flat([x0, 0, z0], u, [0, 1, 0], wall, holes, normal);
  }
  if (boss) {
    // The boss: a cone of rows staggered by half a step, its flat top.
    const rows = Array.from({ length: B.rows + 1 }, (_, k) => {
      const z = 30 + (B.height * k) / B.rows;
      return ring(B.x, B.y, z, B.r - (z - 30) * t, B.segments, k / 2);
    });
    for (let k = 0; k < B.rows; k++) body.band(rows[k], rows[k + 1], (g) => [g[0] - B.x, g[1] - B.y, 0], true);
    const top = rows[B.rows];
    body.flat([0, 0, 30 + B.height], [1, 0, 0], [0, 1, 0], top.map(([x, y]) => [x, y]), [], [0, 0, 1]);
  }
  return body.mesh(turn);
}

export const MUSHROOM = {
  base: [-30, -30, 0, 30, 30, 10], // x0, y0, z0, x1, y1, z1
  stem: { x: 15, y: 0, r: 6, top: 25, segments: 24 },
  cap: { r: 25, height: 5, segments: 72 },
};

/**
 * A cap (a disc, r 25, 5 thick) on a stem over a base plate (60 × 60 × 10),
 * centred at x = 15: its underside overhangs the base beyond x = 30. Along
 * Z, its underside over the base is an undercut, the rest of it the lower
 * half: the edge of the base's shadow (x = 30) crosses the fan of the flat
 * annulus obliquely.
 */
export function mushroom() {
  const body = new Body();
  const [x0, y0, z0, x1, y1, z1] = MUSHROOM.base;
  const { stem, cap } = MUSHROOM;
  const foot = ring(stem.x, stem.y, z1, stem.r, stem.segments);
  const square = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // Base: bottom, top round the foot of the stem, sides.
  body.flat([0, 0, z0], [1, 0, 0], [0, 1, 0], square, [], [0, 0, -1]);
  body.flat([0, 0, z1], [1, 0, 0], [0, 1, 0], square, [foot.map(([x, y]) => [x, y]).reverse()], [0, 0, 1]);
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = square[i], [bx, by] = square[(i + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const u = [(bx - ax) / len, (by - ay) / len, 0];
    body.flat([ax, ay, z0], u, [0, 0, 1], [[0, 0], [len, 0], [len, z1 - z0], [0, z1 - z0]], [], [u[1], -u[0], 0]);
  }
  // Stem.
  const neck = ring(stem.x, stem.y, stem.top, stem.r, stem.segments);
  body.band(foot, neck, (g) => [g[0] - stem.x, g[1] - stem.y, 0]);
  // Cap: underside round the stem, rim, top.
  const under = ring(stem.x, stem.y, stem.top, cap.r, cap.segments);
  const over = ring(stem.x, stem.y, stem.top + cap.height, cap.r, cap.segments);
  body.flat([0, 0, stem.top], [1, 0, 0], [0, 1, 0], under.map(([x, y]) => [x, y]), [neck.map(([x, y]) => [x, y]).reverse()], [0, 0, -1]);
  body.band(under, over, (g) => [g[0] - stem.x, g[1] - stem.y, 0]);
  body.flat([0, 0, stem.top + cap.height], [1, 0, 0], [0, 1, 0], over.map(([x, y]) => [x, y]), [], [0, 0, 1]);
  return body.mesh(0);
}

export const PEG = {
  wall: { x0: -10, x1: 0, y: 25, top: 50 }, // x from x0 to x1, y from -y to y, z from 0 to top
  ledge: { top: 10, front: [15, 35] }, // its front from (15, -25) to (35, 25): x = 25 + 0.4 y
  peg: { z: 30, r: 8, length: 50, segments: 24 },
};

/**
 * A peg (a cylinder along x, r 8, 50 long) out of a wall over a ledge whose
 * front is oblique (x = 25 + 0.4 y), its cylinder meshed in strips of two
 * long thin triangles (50 × 2.1 mm) from its foot to its end, as a CAD
 * kernel meshes one. Along Z, its underside over the ledge is an undercut
 * (joined to the upper half), beyond the ledge the lower half: the edge of
 * the ledge's shadow crosses its strips obliquely.
 */
export function peg() {
  const body = new Body();
  const { wall, ledge, peg: g } = PEG;
  const [f0, f1] = ledge.front;
  const W = wall.y;
  const circle = Array.from({ length: g.segments }, (_, i) => {
    const a = (2 * Math.PI * i) / g.segments;
    return [g.r * Math.cos(a), g.z + g.r * Math.sin(a)]; // (y, z)
  });
  // Bottom, back, top of the wall.
  body.flat([0, 0, 0], [1, 0, 0], [0, 1, 0], [[wall.x0, -W], [f0, -W], [f1, W], [wall.x0, W]], [], [0, 0, -1]);
  body.flat([wall.x0, 0, 0], [0, 1, 0], [0, 0, 1], [[-W, 0], [W, 0], [W, wall.top], [-W, wall.top]], [], [-1, 0, 0]);
  body.flat([0, 0, wall.top], [1, 0, 0], [0, 1, 0], [[wall.x0, -W], [wall.x1, -W], [wall.x1, W], [wall.x0, W]], [], [0, 0, 1]);
  // Front of the wall above the ledge, round the foot of the peg.
  body.flat([wall.x1, 0, 0], [0, 1, 0], [0, 0, 1], [[-W, ledge.top], [W, ledge.top], [W, wall.top], [-W, wall.top]], [[...circle].reverse()], [1, 0, 0]);
  // Top and oblique front of the ledge.
  body.flat([0, 0, ledge.top], [1, 0, 0], [0, 1, 0], [[wall.x1, -W], [f0, -W], [f1, W], [wall.x1, W]], [], [0, 0, 1]);
  const len = Math.hypot(f1 - f0, 2 * W);
  const u = [(f1 - f0) / len, (2 * W) / len, 0];
  body.flat([f0, -W, 0], u, [0, 0, 1], [[0, 0], [len, 0], [len, ledge.top], [0, ledge.top]], [], [u[1], -u[0], 0]);
  // Sides (y = -25, y = 25).
  for (const [y, f] of [[-W, f0], [W, f1]]) {
    body.flat([0, y, 0], [1, 0, 0], [0, 0, 1], [[wall.x0, 0], [f, 0], [f, ledge.top], [wall.x1, ledge.top], [wall.x1, wall.top], [wall.x0, wall.top]], [], [0, Math.sign(y), 0]);
  }
  // The peg: its cylinder in strips, its end.
  const ringAt = (x) => circle.map(([y, z]) => [x, y, z]);
  body.band(ringAt(wall.x1), ringAt(wall.x1 + g.length), (p) => [0, p[1], p[2] - g.z]);
  body.flat([wall.x1 + g.length, 0, 0], [0, 1, 0], [0, 0, 1], circle, [], [1, 0, 0]);
  return body.mesh(0);
}
