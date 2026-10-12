// A flat cast plate meshed as a CAD body is (synthetic, for the parting line
// tests): a plate 60 × 60 × 15 mm in the XY plane with a round lobe at each
// end (90 mm long along Y), a countersunk hole through each lobe, two
// prismatic pillars and a central round boss with a bore through it on its
// top face, and raised letters (1 mm). Each face has its own vertices (a
// B-rep face), its flat faces cut into long thin triangles round their holes
// (ear clipping, as the mesher of a CAD kernel does without inner points),
// its round faces into strips.
import { ShapeUtils, Vector2 } from 'three';

export const PLATE = {
  thickness: 15,
  boss: { r: 10, height: 8, bore: 5 },
  pillars: [[-26, 16, -18, 24], [18, -24, 26, -16]], // x0, y0, x1, y1; 12 mm high
  pillarHeight: 12,
  holes: { y: 35, r: 3.5, countersink: 6, depth: 2.5 },
  lobes: { y: 33, r: 12 },
  letters: [
    [[-27, -27], [-20, -27], [-20, -25], [-25, -25], [-25, -18], [-27, -18]], // L
    [[-9.5, -27], [-7.5, -27], [-7.5, -20], [-4, -20], [-4, -18], [-13, -18], [-13, -20], [-9.5, -20]], // T
    [[23, 17], [25, 17], [25, 26], [23, 26]], // I
    [[4, 19], [6, 19], [10, 27], [8, 27]], // a slanted stroke
  ],
};

const ring = (cx, cy, r, n, from = 0, to = 2 * Math.PI, closed = true) =>
  Array.from({ length: closed ? n : n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

/**
 * The plate: {positions (Float32Array), indices (Uint32Array), faces (count
 * of its B-rep faces), top (index of its top face among them), face (per
 * triangle)}; welded: the vertices merged (an STL of the same triangles).
 * pillars, letters -- instead of PLATE's; boss, holes -- false: without them
 */
export function castPlate({ welded = false, pillars = PLATE.pillars, letters = PLATE.letters, boss: withBoss = true, holes: withHoles = true } = {}) {
  const T = PLATE.thickness;
  const positions = [];
  const indices = [];
  const faceOf = [];
  let faces = 0;
  // One face: its points (xyz) and triangles (index triples), each turned to face along `outward(p)`.
  const addFace = (points, triangles, outward) => {
    const base = positions.length / 3;
    for (const p of points) positions.push(...p);
    for (const [a, b, c] of triangles) {
      const pa = points[a], pb = points[b], pc = points[c];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const g = [0, 1, 2].map((k) => (pa[k] + pb[k] + pc[k]) / 3);
      const o = outward(g);
      const flip = n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0;
      indices.push(base + a, base + (flip ? c : b), base + (flip ? b : c));
      faceOf.push(faces);
    }
    return faces++;
  };
  // A flat face square to z: an outline and holes (xy), ear-clipped.
  const flat = (z, outline, holes, up) => {
    const v2 = (pts) => pts.map(([x, y]) => new Vector2(x, y));
    const tris = ShapeUtils.triangulateShape(v2(outline), holes.map(v2));
    const points = [...outline, ...holes.flat()].map(([x, y]) => [x, y, z]);
    return addFace(points, tris, () => [0, 0, up ? 1 : -1]);
  };
  // A wall square to z between z0 and z1 along a polyline (xy), one quad per piece (2 triangles), as one face.
  const wall = (line, z0, z1, outward, closed = false) => {
    const points = [];
    const tris = [];
    for (const [x, y] of line) points.push([x, y, z0], [x, y, z1]);
    const n = line.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      tris.push([2 * i, 2 * j, 2 * j + 1], [2 * i, 2 * j + 1, 2 * i + 1]);
    }
    return addFace(points, tris, outward);
  };
  // A band between two rings (xyz) of as many points, closed round.
  const band = (a, b, outward) => {
    const n = a.length;
    const tris = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push([i, j, n + j], [i, n + j, n + i]);
    }
    return addFace([...a, ...b], tris, outward);
  };
  const planeOut = (nx, ny) => () => [nx, ny, 0];
  const radial = (cx, cy, s = 1) => (g) => [s * (g[0] - cx), s * (g[1] - cy), 0];

  // Outline of the plate, counter-clockwise: the square and its lobes beyond y = ±30.
  const { y: ly, r: lr } = PLATE.lobes;
  const a = Math.asin((ly - 30) / lr);
  const north = ring(0, ly, lr, 16, -a, Math.PI + a, false);
  const south = ring(0, -ly, lr, 16, Math.PI - a, 2 * Math.PI + a, false);
  const outline = [[30, -30], [30, 30], ...north, [-30, 30], [-30, -30], ...south];

  // Sides of the plate.
  wall([[30, -30], [30, 30]], 0, T, planeOut(1, 0));
  wall([[30, 30], north[0]], 0, T, planeOut(0, 1));
  wall(north, 0, T, radial(0, ly));
  wall([north.at(-1), [-30, 30]], 0, T, planeOut(0, 1));
  wall([[-30, 30], [-30, -30]], 0, T, planeOut(-1, 0));
  wall([[-30, -30], south[0]], 0, T, planeOut(0, -1));
  wall(south, 0, T, radial(0, -ly));
  wall([south.at(-1), [30, -30]], 0, T, planeOut(0, -1));

  // Holes: the bore of the boss, the countersunk holes of the lobes.
  const { r: br, height: bh, bore } = PLATE.boss;
  const boreRing = ring(0, 0, bore, 24);
  const bossRing = ring(0, 0, br, 24);
  const { y: hy, r: hr, countersink: cr, depth: cd } = PLATE.holes;
  const holeRings = [hy, -hy].map((y) => ring(0, y, hr, 16));
  const sinkRings = [hy, -hy].map((y) => ring(0, y, cr, 16));

  flat(0, outline, [...(withBoss ? [boreRing] : []), ...(withHoles ? holeRings : [])], false); // bottom
  // Top face: round the boss, the pillars, the letters and the countersinks.
  const pillarRing = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const top = flat(T, outline, [...(withBoss ? [bossRing] : []), ...pillars.map(pillarRing), ...letters, ...(withHoles ? sinkRings : [])], true);

  // The boss and its bore.
  const at = (pts, z) => pts.map(([x, y]) => [x, y, z]);
  if (withBoss) {
    band(at(bossRing, T), at(bossRing, T + bh), radial(0, 0));
    flat(T + bh, bossRing, [boreRing], true);
    band(at(boreRing, 0), at(boreRing, T + bh), radial(0, 0, -1));
  }
  // The countersunk holes: their bore, then the cone to the top face.
  if (withHoles) {
    [hy, -hy].forEach((y, k) => {
      band(at(holeRings[k], 0), at(holeRings[k], T - cd), radial(0, y, -1));
      band(at(holeRings[k], T - cd), at(sinkRings[k], T), (g) => [-g[0], -(g[1] - y), Math.hypot(g[0], g[1] - y)]);
    });
  }
  // The pillars.
  const H = PLATE.pillarHeight;
  for (const p of pillars) {
    const [x0, y0, x1, y1] = p;
    wall(pillarRing(p), T, T + H, radial((x0 + x1) / 2, (y0 + y1) / 2), true);
    flat(T + H, pillarRing(p), [], true);
  }
  // The letters, raised 1 mm: their sides one face each (square to their edges), their top.
  for (const letter of letters) {
    const n = letter.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += letter[i][0] * letter[(i + 1) % n][1] - letter[(i + 1) % n][0] * letter[i][1];
    for (let i = 0; i < n; i++) {
      const p = letter[i], q = letter[(i + 1) % n];
      const out = s > 0 ? [q[1] - p[1], p[0] - q[0], 0] : [p[1] - q[1], q[0] - p[0], 0];
      wall([p, q], T, T + 1, () => out);
    }
    flat(T + 1, letter, [], true);
  }

  let P = Float32Array.from(positions);
  let I = Uint32Array.from(indices);
  if (welded) {
    const ids = new Map();
    const merged = [];
    const map = new Uint32Array(P.length / 3);
    for (let v = 0; v < map.length; v++) {
      const key = `${P[3 * v]},${P[3 * v + 1]},${P[3 * v + 2]}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = merged.length / 3;
        merged.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
        ids.set(key, id);
      }
      map[v] = id;
    }
    P = Float32Array.from(merged);
    I = I.map((v) => map[v]);
  }
  return { positions: P, indices: I, faces, top, face: Int32Array.from(faceOf) };
}
