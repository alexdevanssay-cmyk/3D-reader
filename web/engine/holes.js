// Through and blind holes, measured on the geometry of a closed body.
//
// A hole is a cylindrical face with the material around it, with the coaxial
// cylinders and cones that continue it (a counterbore, a countersink, a drill
// point, the other diameters of a stepped hole): a chain of faces along one
// axis line, from the analytic surfaces of the B-Rep (cad.js
// geometric_surfaces). It is one when its axis is in the air, with its wall
// all round (lines square to the axis meet it at its radius): not the outside
// of a boss or a shaft, nor a rounded edge. From points inside its narrowest
// section, on the axis and around it, lines are cast along the axis in both
// senses on the closed triangle mesh of the body:
// - an end is open when the lines get past the end of the walls of the chain
//   without meeting material (the air around the part, or a cavity of it,
//   past a rounded edge that flares the end of the walls),
// - closed when they meet a bottom (flat, a drill point...) within the walls,
//   or beyond them while still enclosed (a ball end, an inclined bottom: the
//   lines square to the axis there meet material all around),
// each end by a majority of the lines. Both ends open: a through hole; one: a
// blind hole, with its depth. Undetermined (null) when the vote is split, the
// point on the axis is in the material, or the walls do not go all round.
// A hole crossed by a wider one (a cross drilling) is cut in two faces of one
// radius on one axis line, the crossing hole between them: one hole.
//
// The extent of each face along its axis comes from its own triangles
// (axial_extent_mm, cad.js), with the vertices of its B-Rep edges
// (edge_signatures, exact on the circles that end a hole; the only source for
// results kept without the triangles' extent).
//
// Plain JavaScript without bare imports: it runs in the engine worker, after
// the triangulation of each solid (cad.js), and for the results kept by an
// earlier version (client.js asks the worker).

import { rayCaster } from './thickness.js';

// Version of the measurements, kept with them (body.holes.version): those of
// another version, or none, are measured again.
export const HOLES_VERSION = 1;
export const HOLES_METHOD = 'axis_rays_on_mesh';

// Lines square to the axis from the start point: the wall all round at about
// the radius (the display mesh is inscribed in the cylinder: within cos of half
// its angular step, 0.97 at the coarsest preset). A cross hole may take two.
// Closer than WALL_NEAR, it is other material (the bore of a boss or a tube,
// seen from the axis of its outside).
const RING = 12;
const RING_MIN = 10;
const WALL_NEAR = 0.9;
const WALL_FAR = 1.05;
// A line that leaves the material again within this share of the radius met a
// shell inside the face (the bore of a thin tube, from the axis of its outside): no wall.
const WALL_THIN = 1.01;
// A wall that does not go all round at one place (an oblique hole through a
// thin wall): the lines tried at so many places at most along the face.
const SPREAD = 24;
// Past the end of the walls: open when a line square to the axis goes further than this (radii of that end).
const OPEN_FAR = 1.2;
// Lines along the axis: on it and at this share of the radius around it, a majority of 5.
const OFF_AXIS = 0.3;
const VOTES = 5;
const MAJORITY = 3;
// Start points tried along the narrowest section (share of its length): a cross hole may cut the first.
const STARTS = [0.5, 0.25, 0.75];
// A cone whose radius at the bottom is under this share of the hole's is a drill point.
const POINT_RADIUS = 0.25;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Unit vector with its first non-zero component positive (both senses of an axis alike), or null. */
function canonical(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 0)) return null;
  const a = v.map((x) => x / n);
  const first = a.find((x) => Math.abs(x) > 1e-12);
  return first < 0 ? a.map((x) => -x) : a;
}

/** Two unit vectors square to a and to each other. */
function basis(a) {
  const h = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [a[1] * h[2] - a[2] * h[1], a[2] * h[0] - a[0] * h[2], a[0] * h[1] - a[1] * h[0]];
  const n = Math.hypot(u[0], u[1], u[2]);
  u[0] /= n;
  u[1] /= n;
  u[2] /= n;
  return [u, [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]];
}

/**
 * The faces that can bound a hole: cylinders and cones, each with its axis
 * (canonical), a point of it and its extent along it (from its triangles and
 * the vertices of its B-Rep edges), moved by -origin. Either orientation: the
 * material is outside a "reversed" face of a right-handed surface, but a
 * mirrored placement or a solid turned inside out reverses that; the lines
 * tell (the axis of a boss is in the material).
 */
function holeFaces(surfaces, origin) {
  const faces = [];
  for (const s of surfaces ?? []) {
    if ((s?.type !== 'cylinder' && s?.type !== 'cone') || (s.orientation !== 'reversed' && s.orientation !== 'forward')) continue;
    const axis = canonical(s.axis);
    if (!axis || !Array.isArray(s.center_mm) || !s.center_mm.every(finite)) continue;
    if (s.type === 'cylinder' && !(s.radius_mm > 0)) continue;
    if (s.type === 'cone' && !(finite(s.semi_angle_rad) && finite(s.ref_radius_mm) && Array.isArray(s.axis_origin_mm) && s.axis_origin_mm.every(finite))) continue;
    let lo = Infinity, hi = -Infinity;
    const extend = (t) => {
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    };
    for (const e of s.edge_signatures ?? []) {
      if (!Array.isArray(e) || e.length !== 6 || !e.every(finite)) continue;
      for (const k of [0, 3]) extend((e[k] - origin[0]) * axis[0] + (e[k + 1] - origin[1]) * axis[1] + (e[k + 2] - origin[2]) * axis[2]);
    }
    // The extent of its triangles, along its own axis from its centre: the
    // whole face, where an edge only gives its vertices (the seam vertex of an
    // opening on an inclined face, anywhere on it).
    const extent = s.axial_extent_mm;
    if (Array.isArray(extent) && extent.length === 2 && extent.every(finite)) {
      const tc = dot(s.center_mm.map((x, k) => x - origin[k]), axis);
      const sense = dot(axis, s.axis) < 0 ? -1 : 1;
      for (const x of extent) extend(tc + sense * x);
    }
    if (!(hi > lo)) continue;
    const point = s.center_mm.map((x, k) => x - origin[k]);
    const face = { index: s.index, type: s.type, flag: s.orientation, axis, point, lo, hi };
    if (s.type === 'cylinder') face.radius = s.radius_mm;
    else {
      // Radius at t along the canonical axis: ref_radius at the axis origin, growing by tan(semi-angle) along the cone's own axis.
      const sense = dot(axis, s.axis) < 0 ? -1 : 1;
      const t0 = dot(s.axis_origin_mm.map((x, k) => x - origin[k]), axis);
      const slope = Math.tan(s.semi_angle_rad) * sense;
      face.radiusAt = (t) => Math.max(0, s.ref_radius_mm + (t - t0) * slope);
      face.semiAngle = Math.abs(s.semi_angle_rad);
    }
    face.foot = face.point.map((x, k) => x - dot(face.point, axis) * axis[k]);
    faces.push(face);
  }
  return faces;
}

/** Distance between the axis lines of two faces of the same direction. */
function lineDistance(a, b) {
  const d = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
  const t = dot(d, a.axis);
  return Math.hypot(d[0] - t * a.axis[0], d[1] - t * a.axis[1], d[2] - t * a.axis[2]);
}

/** Largest radius of a face. */
const maxRadius = (f) => f.radius ?? Math.max(f.radiusAt(f.lo), f.radiusAt(f.hi));

/** Whether two faces are cylinders of one radius (the pieces of one cylinder). */
const sameCylinder = (f, g) => f.type === 'cylinder' && g.type === 'cylinder' && Math.abs(f.radius - g.radius) <= Math.max(1e-6, 1e-5 * Math.max(f.radius, g.radius));

/**
 * Calls fn(i, j) for each pair of faces i < j of the same orientation on one
 * axis line (a hash of the lines: direction, foot of the perpendicular from
 * the origin in cells of `cell` mm).
 */
function coaxialPairs(faces, cell, fn) {
  const dirKey = (f) => f.flag + ':' + f.axis.map((x) => Math.round(x * 1e4)).join(',');
  const grid = new Map();
  const cellOf = (f) => f.foot.map((x) => Math.floor(x / cell));
  faces.forEach((f, i) => {
    const key = dirKey(f) + '|' + cellOf(f).join(',');
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  faces.forEach((f, i) => {
    const c = cellOf(f);
    const dk = dirKey(f);
    const r = maxRadius(f);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(dk + '|' + [c[0] + dx, c[1] + dy, c[2] + dz].join(',')) ?? []) {
        if (j <= i) continue;
        const g = faces[j];
        const tol = Math.min(cell, Math.max(1e-4, 1e-3 * Math.min(r, maxRadius(g))));
        if (lineDistance(f, g) <= tol) fn(i, j);
      }
    }
  });
}

/** Union-find over n items: join(i, j), and the groups of items. */
function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  return {
    join: (i, j) => {
      parent[find(j)] = find(i);
    },
    groups: (items) => {
      const groups = new Map();
      items.forEach((item, i) => {
        const root = find(i);
        const list = groups.get(root);
        if (list) list.push(item);
        else groups.set(root, [item]);
      });
      return [...groups.values()];
    },
  };
}

/**
 * The chains of faces: coaxial faces of the same orientation that continue
 * each other, end to end along the axis (a counterbore and its bore, a drill
 * point), or the pieces of one cylinder (equal radii) whose extents overlap
 * (a cylinder given as two half faces). A face groove round a hole overlaps
 * it without meeting it end to end: not part of it; nor is the outside of a
 * boss (the other orientation).
 */
function chainFaces(faces, tolT, cell, join) {
  coaxialPairs(faces, cell, (i, j) => {
    const f = faces[i], g = faces[j];
    const meet = Math.abs(f.hi - g.lo) <= tolT || Math.abs(g.hi - f.lo) <= tolT;
    if (meet || (sameCylinder(f, g) && f.lo <= g.hi + tolT && g.lo <= f.hi + tolT)) join(i, j);
  });
}

/**
 * Through and blind holes of a closed body.
 *
 * positions -- Float32Array/Float64Array, xyz per vertex (mm); indices -- 3 per triangle
 * surfaces  -- the analytic surfaces of the body (cad.js geometric_surfaces)
 * closed    -- whether the mesh is watertight (meshanalysis.js meshTopology):
 *              lines leave a mesh with gaps, nothing is measured on it
 *              (reason "open_mesh")
 *
 * Returns {version, method, holes: [...]} (and reason "open_mesh" when not
 * closed), one per chain of faces, in the order of their first face:
 *   surfaces    the faces of the hole (indices into surfaces)
 *   axis        unit; a blind hole's points from its opening into the material
 *   diameter_mm the narrowest diameter; diameters_mm every diameter (several: a stepped hole)
 *   length_mm   the extent of its faces along the axis
 *   through     true, false (blind) or null (undetermined: see reason)
 *   open_ends   2, 1 or 0 (null when undetermined)
 *   blind holes: depth_mm (from the opening to the end of the full diameter),
 *     bottom ("flat", "drill_point" or "other"), tip_depth_mm (to the deepest
 *     point on the axis, when not flat), drill_point_angle_deg
 *   measured    whether through is known; method
 * Null when the mesh is empty.
 */
export function measureHoles(positions, indices, surfaces, { closed = true } = {}) {
  const nv = positions?.length / 3 | 0;
  const nt = indices?.length / 3 | 0;
  if (!nv || !nt || !Array.isArray(surfaces)) return null;
  const record = { version: HOLES_VERSION, method: HOLES_METHOD, holes: [] };
  if (!surfaces.some((s) => s?.type === 'cylinder')) return record;
  if (!closed) return { ...record, reason: 'open_mesh' };

  // Centred in float32: precision far from the origin, half the memory of the hierarchy.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const x = positions[3 * i + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  const origin = min.map((m, k) => (m + max[k]) / 2);
  const P = new Float32Array(3 * nv);
  for (let i = 0; i < 3 * nv; i++) P[i] = positions[i] - origin[i % 3];
  // Outward normals: the faces of a body with a negative volume (mirrored) point inwards.
  let volume = 0;
  for (let f = 0; f < nt; f++) {
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    volume += P[a] * (uy * vz - uz * vy) + P[a + 1] * (uz * vx - ux * vz) + P[a + 2] * (ux * vy - uy * vx);
  }
  const sign = volume < 0 ? -1 : 1;
  const faces = holeFaces(surfaces, origin);
  if (!faces.length) return record;

  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const tolT = Math.max(1e-3, 1e-6 * diag);
  const cell = Math.max(0.05, 1e-5 * diag);
  const { join, groups } = unionFind(faces.length);
  chainFaces(faces, tolT, cell, join);
  const { ray } = rayCaster(P, indices);
  const hit = [-1];
  const tMin = 1e-9 * Math.max(1, diag);
  // Past a hit, to the next one (the triangles that share its edge or vertex too).
  const skip = Math.max(tMin, 1e-7 * diag);

  /** First triangle along (p, d) beyond `from`: {t, entering} (entering: from the air into the material), or null. */
  const cast = (p, d, from = tMin) => {
    const t = ray(p, d, from, hit);
    if (t === Infinity) return null;
    const f = hit[0];
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const n = (uy * vz - uz * vy) * d[0] + (uz * vx - ux * vz) * d[1] + (ux * vy - uy * vx) * d[2];
    return { t, entering: sign * n < 0 };
  };

  /**
   * The lines square to the axis from p ({u, v} its basis): how many meet the
   * material between near and far (the wall), closer, further or nowhere, and
   * each line's kind; or inside when one leaves the material (p is in it).
   * With `thin`: a line into material that it leaves again within `thin`
   * meets material inside the face, not its wall (the island inside a face
   * groove, the bore of a tube from the axis of its outside): "island".
   */
  const ring = (p, [u, v], near, far, thin = 0) => {
    const count = { wall: 0, beyond: 0, closer: 0, island: 0 };
    const kinds = [];
    for (let k = 0; k < RING; k++) {
      const angle = (2 * Math.PI * k) / RING;
      const c = Math.cos(angle), s = Math.sin(angle);
      const d = [c * u[0] + s * v[0], c * u[1] + s * v[1], c * u[2] + s * v[2]];
      const h = cast(p, d);
      if (h && !h.entering) return { inside: true };
      let kind = !h || h.t > far ? 'beyond' : h.t < near ? 'closer' : 'wall';
      if (kind !== 'beyond' && thin > 0) {
        const out = cast(p, d, h.t + skip);
        if (out && !out.entering && out.t <= thin) kind = 'island';
      }
      kinds.push(kind);
      count[kind]++;
    }
    return { ...count, kinds, inside: false };
  };

  // A hole crossed by a wider one (a cross drilling): its cylinder cut in two
  // faces of one radius on one axis line, apart, the crossing hole between
  // them (both ends of the gap inside it) and the air along the axis from one
  // to the other: one hole. Not two bores of one line across a cavity.
  const crossing = faces.filter((f) => f.type === 'cylinder');
  coaxialPairs(faces, cell, (i, j) => {
    if (!sameCylinder(faces[i], faces[j])) return;
    const [f, g] = faces[i].hi < faces[j].lo ? [faces[i], faces[j]] : [faces[j], faces[i]];
    if (!(g.lo - f.hi > tolT)) return;
    const a = f.axis;
    const at = (t) => [0, 1, 2].map((k) => f.foot[k] + t * a[k]);
    const ends = [at(f.hi), at(g.lo)];
    const middle = at((f.hi + g.lo) / 2);
    const crossed = crossing.some((c) => {
      if (c === f || c === g || Math.abs(dot(c.axis, a)) > 0.999) return false;
      const t = dot(middle, c.axis);
      if (t < c.lo - tolT || t > c.hi + tolT) return false;
      return ends.every((p) => {
        const d = [0, 1, 2].map((k) => p[k] - c.point[k]);
        const along = dot(d, c.axis);
        return Math.hypot(d[0] - along * c.axis[0], d[1] - along * c.axis[1], d[2] - along * c.axis[2]) <= c.radius * (1 + 1e-3) + tolT;
      });
    });
    if (!crossed) return;
    const from = (f.lo + f.hi) / 2;
    const h = cast(at(from), a);
    if (!h || (h.entering && from + h.t >= g.lo - tolT)) join(i, j);
  });
  const chains = groups(faces).filter((list) => list.some((f) => f.type === 'cylinder'));

  for (const chain of chains) {
    chain.sort((x, y) => x.index - y.index);
    const a = chain[0].axis;
    const lo = Math.min(...chain.map((f) => f.lo));
    const hi = Math.max(...chain.map((f) => f.hi));
    const cylinders = chain.filter((f) => f.type === 'cylinder');
    // The narrowest section, its longest face: the start points (inside every section of the chain).
    const narrow = cylinders.reduce((x, y) => (y.radius < x.radius - 1e-9 || (Math.abs(y.radius - x.radius) <= 1e-9 && y.hi - y.lo > x.hi - x.lo) ? y : x));
    const r = narrow.radius;
    const tolEnd = Math.max(0.01, 1e-5 * diag, 0.02 * r);
    const frame = basis(a);
    const diameters = [...new Set(cylinders.map((f) => Math.round(2 * f.radius * 1e6) / 1e6))].sort((x, y) => x - y);
    const out = {
      surfaces: chain.map((f) => f.index),
      axis: a,
      diameter_mm: 2 * r,
      ...(diameters.length > 1 ? { diameters_mm: diameters } : {}),
      length_mm: hi - lo,
      through: null,
      open_ends: null,
      measured: false,
      method: HOLES_METHOD,
    };
    record.holes.push(out);

    // A start point on the axis, inside the narrowest section, with its wall all round.
    const base = narrow.point.map((x, k) => x - dot(narrow.point, a) * a[k]); // the axis point at t = 0
    const at = (t) => [base[0] + t * a[0], base[1] + t * a[1], base[2] + t * a[2]];
    const near = WALL_NEAR * r, far = WALL_FAR * r + tolEnd, thin = WALL_THIN * r;
    let start = null;
    let why = null;
    let partial = null; // a start point in the air, its wall not all round there
    for (const share of STARTS) {
      const ts = narrow.lo + share * (narrow.hi - narrow.lo);
      const probe = ring(at(ts), frame, near, far, thin);
      if (probe.inside) {
        // The outside of a boss or a shaft (or a rounded edge): not a hole.
        why = 'start_point_in_material';
        break;
      }
      // Lines into the open first: a rounded inside corner with the opposite wall near its axis is no hole either.
      if (probe.beyond > RING - RING_MIN) {
        why ??= 'not_a_full_revolution';
        if (!probe.closer && !probe.island) partial ??= ts;
      } else if (probe.closer) why ??= 'obstructed';
      // Material between the axis and the wall, all round: the outer wall of
      // a face groove round a hole, the outside of a tube or a boss.
      else if (probe.island) why ??= 'material_inside';
      else {
        start = ts;
        break;
      }
    }
    // An oblique hole through a wall thinner than its diameter: at any one
    // place along the axis its wall is on one side only, but each line square
    // to the axis meets it at some place. Tried along the face and a radius
    // beyond its ends (its extent from the edges alone may be short).
    if (start == null && why === 'not_a_full_revolution' && partial != null) {
      const from = narrow.lo - r, to = narrow.hi + r;
      const n = Math.min(SPREAD, Math.max(3, Math.ceil((to - from) / (0.25 * r)) + 1));
      const covered = new Set();
      for (let i = 0; i < n && covered.size < RING; i++) {
        const probe = ring(at(from + ((to - from) * i) / (n - 1)), frame, near, far, thin);
        if (!probe.inside) probe.kinds.forEach((kind, k) => kind === 'wall' && covered.add(k));
      }
      if (covered.size >= RING_MIN) start = partial;
    }
    if (start == null) {
      out.reason = why;
      // Only faces given as a hole (reversed) are said not to be one: not every boss, shaft or hub.
      if (chain.every((f) => f.flag !== 'reversed')) record.holes.pop();
      continue;
    }

    // The radius of the chain at one of its ends (its widest face there: a counterbore, the top of a countersink).
    const endRadius = (t) => Math.max(r, ...chain.filter((f) => Math.abs((t === hi ? f.hi : f.lo) - t) <= tolT).map((f) => f.radius ?? f.radiusAt(t)));
    // The lines along the axis pass through its narrowest opening: a cone that
    // narrows below the narrowest cylinder and opens (a nozzle, an orifice).
    // A cone down to a point is closed there anyway (a drill point).
    const throat = Math.min(r, ...chain.filter((f) => f.type === 'cone').flatMap((f) => [f.radiusAt(f.lo), f.radiusAt(f.hi)]).filter((x) => x > tolEnd));
    const points = [[0, 0], [OFF_AXIS, 0], [-OFF_AXIS, 0], [0, OFF_AXIS], [0, -OFF_AXIS]].map(([x, y]) => {
      const p = at(start);
      return [0, 1, 2].map((k) => p[k] + throat * (x * frame[0][k] + y * frame[1][k]));
    });
    const ends = [1, -1].map((s) => {
      const d = a.map((x) => s * x);
      const reach = s > 0 ? hi - start : start - lo; // to the end of the walls
      const hits = points.map((p) => cast(p, d));
      const onAxis = hits[0];
      // Past the end of the walls, on the axis: are they still all round (a bottom), or is it open?
      let past;
      const pastEnd = () => {
        if (past !== undefined) return past;
        const gap = onAxis ? onAxis.t - reach : Infinity;
        if (onAxis && (!onAxis.entering || gap <= tolEnd)) return (past = null);
        const step = Math.min(Math.max(tolEnd, 0.1 * r), gap / 2);
        const R = endRadius(s > 0 ? hi : lo);
        const probeAt = (t) => ring(at(start + s * (reach + t)), frame, 0, OPEN_FAR * R + tolEnd);
        let probe = probeAt(step);
        // A rounded edge at the end of the walls (not of the chain) flares
        // within OPEN_FAR there: tried again half way to what the axis meets.
        if (!probe.inside && !probe.beyond && Number.isFinite(gap) && gap > 2 * step) probe = probeAt(gap / 2);
        return (past = probe.inside ? null : probe.beyond ? 'open' : 'closed');
      };
      const votes = hits.map((h) => {
        if (!h) return 'open';
        if (!h.entering) return null;
        if (h.t <= reach + tolEnd) return 'closed';
        return pastEnd();
      });
      const count = (v) => votes.filter((x) => x === v).length;
      const status = count('open') >= MAJORITY ? 'open' : count('closed') >= MAJORITY ? 'closed' : null;
      return { s, status, reach, hits, votes };
    });
    const [plus, minus] = ends;
    if (plus.status === null || minus.status === null) {
      out.reason = 'inconsistent_votes';
      continue;
    }
    const open = ends.filter((e) => e.status === 'open');
    out.open_ends = open.length;
    if (open.length === 0) {
      out.reason = 'closed_at_both_ends';
      continue;
    }
    out.measured = true;
    if (open.length === 2) {
      out.through = true;
      continue;
    }
    // Blind: its axis from the opening into the material, its depth from the opening.
    const bottom = ends.find((e) => e.status === 'closed');
    const s = bottom.s;
    out.through = false;
    out.axis = a.map((x) => (x ? s * x : 0)); // no -0
    const opening = s > 0 ? lo : hi;
    const cylinderEnd = s > 0 ? Math.max(...cylinders.map((f) => f.hi)) : Math.min(...cylinders.map((f) => f.lo));
    out.depth_mm = Math.abs(cylinderEnd - opening);
    const end = s > 0 ? hi : lo;
    const point = chain.find((f) => f.type === 'cone' && Math.abs((s > 0 ? f.hi : f.lo) - end) <= tolT && f.radiusAt(end) <= POINT_RADIUS * r);
    const axial = bottom.hits[0]?.entering && bottom.votes[0] === 'closed' ? bottom.hits[0].t : null;
    const offAxis = bottom.hits.slice(1).filter((h, i) => h?.entering && bottom.votes[i + 1] === 'closed').map((h) => h.t);
    if (point) {
      out.bottom = 'drill_point';
      out.drill_point_angle_deg = (2 * point.semiAngle * 180) / Math.PI;
    } else if (axial != null && offAxis.length && offAxis.every((t) => Math.abs(t - axial) <= tolEnd) && Math.abs(start + s * axial - cylinderEnd) <= tolEnd) {
      out.bottom = 'flat';
    } else {
      out.bottom = 'other';
    }
    if (out.bottom !== 'flat' && axial != null) out.tip_depth_mm = Math.abs(start + s * axial - opening);
  }
  return record;
}

/** Whether a body's hole measurements (body.holes) are of this version. */
export function currentHoles(record) {
  return record?.version === HOLES_VERSION && Array.isArray(record.holes);
}

/**
 * The holes of another instance of a shape (an assembly part placed again,
 * mirrored or not), from those measured on one (`record`): the same holes,
 * each axis carried by the axis of its first face (`from`: the analytic
 * surfaces of the measured instance, `to`: those of this one, face by face).
 * Null when the faces of a hole differ (another shape, or scaled).
 */
export function holesOfInstance(record, from, to) {
  if (!currentHoles(record) || !Array.isArray(from) || !Array.isArray(to) || from.length !== to.length) return null;
  // Equal but for the rounding of a placement.
  const equal = (p, q) => (p ?? null) === (q ?? null) || (finite(p) && finite(q) && Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p)));
  const same = (i) => {
    const x = from[i], y = to[i];
    return x?.type === y?.type && equal(x.radius_mm, y.radius_mm) && equal(x.semi_angle_rad, y.semi_angle_rad) && canonical(y.axis) != null;
  };
  const holes = [];
  for (const hole of record.holes) {
    if (!Array.isArray(hole.surfaces) || !hole.surfaces.length || !hole.surfaces.every(same)) return null;
    // The axes of the face as given (not canonical: a placement turns them as it turns the hole).
    const unit = (v) => {
      const n = Math.hypot(v[0], v[1], v[2]);
      return v.map((x) => x / n);
    };
    const a = unit(from[hole.surfaces[0]].axis), b = unit(to[hole.surfaces[0]].axis);
    // A blind hole's axis from its opening into the material: the same sense along its face's axis.
    const sense = dot(hole.axis, a) < 0 ? -1 : 1;
    const { surfaces, diameters_mm, ...rest } = hole;
    holes.push({
      ...rest,
      surfaces: [...surfaces],
      axis: hole.through === false ? b.map((x) => (x ? sense * x : 0)) : canonical(b),
      ...(diameters_mm ? { diameters_mm: [...diameters_mm] } : {}),
    });
  }
  return { ...record, holes };
}

/**
 * The bodies of a result whose holes can be measured and are not, or by
 * another version: closed CAD bodies with a mesh and analytic surfaces
 * (indices into bodies).
 */
export function holesToMeasure(bodies) {
  return (bodies ?? []).flatMap((b, i) => (b?.closed && b.method === 'brep' && b.mesh?.indices?.length && Array.isArray(b.geometric_surfaces) && !currentHoles(b.holes) ? [i] : []));
}

/**
 * The holes of the bodies of results kept without them (by an earlier
 * version): those kept since (`kept`: per body a record or null, the cache
 * part "holes") given to them, the others measured by `measure` (a list of
 * {positions, indices, surfaces} -> a promise of their records, the engine
 * worker; `closed`: whether the mesh is watertight; null: not measured now).
 * Resolves to the records of every body (null where none) when some were
 * measured now, to keep; else to null.
 */
export async function restoreHoles(bodies, kept, measure) {
  const todo = holesToMeasure(bodies);
  if (!todo.length) return null;
  const stored = Array.isArray(kept) && kept.length === bodies.length ? kept : [];
  const missing = [];
  for (const i of todo) {
    if (currentHoles(stored[i])) bodies[i].holes = stored[i];
    else missing.push(i);
  }
  if (!missing.length) return null;
  const records = await measure(missing.map((i) => {
    const { mesh, geometric_surfaces, topology } = bodies[i];
    return { positions: ArrayBuffer.isView(mesh.positions64) ? mesh.positions64 : mesh.positions, indices: mesh.indices, surfaces: geometric_surfaces, closed: topology?.watertight !== false };
  }));
  if (!records) return null;
  missing.forEach((i, k) => {
    if (currentHoles(records?.[k])) bodies[i].holes = records[k];
  });
  return bodies.map((b) => (currentHoles(b.holes) ? b.holes : null));
}
