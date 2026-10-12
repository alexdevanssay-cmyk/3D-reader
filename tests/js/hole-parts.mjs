// Synthetic parts with holes for the hole measurement tests (holes.js,
// semantic.js): closed triangle meshes, outward normals, with the analytic
// surfaces the CAD engine would give (cad.js geometric_surfaces).
//
// A square plate, 2 S wide, from z = 0 to z = H, centred on the z axis; a
// vertical hole on that axis made of `sections` from the top down ({r, top,
// bottom}, contiguous, the first one at z = H), ending:
//   'through'  at z = 0 (or into a cavity: `cavity` {C (half width), floor, ceiling})
//   'flat'     on a flat bottom
//   'drill'    on a drill point (cone of `pointDeg`, 118° by default)
// or a boss: a cylinder of radius `boss.r` standing `boss.h` on the top face.

const N = 32; // segments round a circle (a multiple of 8: the corners of the square are among them)

export function plate({ S = 20, H = 10, sections = [], end = 'through', pointDeg = 118, cavity = null, boss = null, inverted = false } = {}) {
  const positions = [];
  const indices = [];
  const vertex = (p) => positions.push(...p) / 3 - 1;
  const tri = (a, b, c) => indices.push(vertex(a), vertex(b), vertex(c));
  const quad = (a, b, c, d) => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const angle = (i) => (2 * Math.PI * (i % N)) / N;
  const circle = (r, z) => (i) => [r * Math.cos(angle(i)), r * Math.sin(angle(i)), z];
  const square = (s, z) => (i) => {
    const c = Math.cos(angle(i)), n = Math.sin(angle(i));
    const m = Math.max(Math.abs(c), Math.abs(n));
    return [(s * c) / m, (s * n) / m, z];
  };
  // Between an inner and an outer loop at one height, facing up (+z) or down.
  const ring = (inner, outer, up) => {
    for (let i = 0; i < N; i++) {
      if (up) quad(inner(i), outer(i), outer(i + 1), inner(i + 1));
      else quad(inner(i + 1), outer(i + 1), outer(i), inner(i));
    }
  };
  const disc = (loop, centre, up) => {
    for (let i = 0; i < N; i++) up ? tri(centre, loop(i), loop(i + 1)) : tri(centre, loop(i + 1), loop(i));
  };
  // Side walls between two loops (lower, upper), facing out of the loop or into it.
  const wall = (lower, upper, out) => {
    for (let i = 0; i < N; i++) {
      if (out) quad(lower(i), lower(i + 1), upper(i + 1), upper(i));
      else quad(lower(i), upper(i), upper(i + 1), lower(i + 1));
    }
  };

  const surfaces = [];
  const seam = (r, z0, z1) => [r, 0, z0, r, 0, z1];
  const circleEdge = (r, z) => [r, 0, z, r, 0, z];
  const cylinder = (r, bottom, top, orientation = 'reversed') => surfaces.push({
    index: surfaces.length, type: 'cylinder', radius_mm: r, axis: [0, 0, 1], center_mm: [0, 0, (bottom + top) / 2],
    orientation, wire_count: 1, edge_count: 2,
    edge_signatures: [circleEdge(r, top), seam(r, bottom, top), circleEdge(r, bottom), seam(r, bottom, top)],
  });
  const plane = (normal, z, edges) => surfaces.push({
    index: surfaces.length, type: 'plane', normal, center_mm: [0, 0, z], orientation: normal[2] > 0 ? 'forward' : 'reversed', wire_count: 2, edge_count: edges.length, edge_signatures: edges,
  });

  // Outer walls of the plate.
  wall(square(S, 0), square(S, H), true);
  if (boss) {
    const { r, h } = boss;
    ring(circle(r, H), square(S, H), true);
    wall(circle(r, H), circle(r, H + h), true);
    disc(circle(r, H + h), [0, 0, H + h], true);
    disc(square(S, 0), [0, 0, 0], false);
    cylinder(r, H, H + h, boss.orientation ?? 'forward');
    plane([0, 0, 1], H, [circleEdge(r, H)]);
    plane([0, 0, 1], H + h, [circleEdge(r, H + h)]);
  } else {
    // Top face, steps and walls of the hole, from the top down.
    ring(circle(sections[0].r, H), square(S, H), true);
    plane([0, 0, 1], H, [circleEdge(sections[0].r, H)]);
    sections.forEach((sec, k) => {
      wall(circle(sec.r, sec.bottom), circle(sec.r, sec.top), false);
      cylinder(sec.r, sec.bottom, sec.top);
      const next = sections[k + 1];
      if (!next) return;
      // A step: the narrower section below (a counterbore) faces up, a wider one (a groove) down.
      if (next.r < sec.r) ring(circle(next.r, sec.bottom), circle(sec.r, sec.bottom), true);
      else ring(circle(sec.r, sec.bottom), circle(next.r, sec.bottom), false);
      plane([0, 0, next.r < sec.r ? 1 : -1], sec.bottom, [circleEdge(sec.r, sec.bottom), circleEdge(next.r, sec.bottom)]);
    });
    const last = sections[sections.length - 1];
    const zb = last.bottom;
    if (end === 'through' && cavity) {
      const { C, floor, ceiling } = cavity;
      ring(circle(last.r, ceiling), square(C, ceiling), false);
      wall(square(C, floor), square(C, ceiling), false);
      disc(square(C, floor), [0, 0, floor], true);
      disc(square(S, 0), [0, 0, 0], false);
      plane([0, 0, -1], ceiling, [circleEdge(last.r, ceiling)]);
    } else if (end === 'through') {
      ring(circle(last.r, 0), square(S, 0), false);
      plane([0, 0, -1], 0, [circleEdge(last.r, 0)]);
    } else {
      disc(square(S, 0), [0, 0, 0], false);
      if (end === 'flat') {
        disc(circle(last.r, zb), [0, 0, zb], true);
        plane([0, 0, 1], zb, [circleEdge(last.r, zb)]);
      } else {
        const semi = ((pointDeg / 2) * Math.PI) / 180;
        const tip = zb - last.r / Math.tan(semi);
        for (let i = 0; i < N; i++) tri([0, 0, tip], circle(last.r, zb)(i), circle(last.r, zb)(i + 1));
        surfaces.push({
          index: surfaces.length, type: 'cone', semi_angle_rad: semi, ref_radius_mm: last.r, axis_origin_mm: [0, 0, zb], axis: [0, 0, 1],
          center_mm: [0, 0, (zb + tip) / 2], orientation: 'reversed', wire_count: 1, edge_count: 1,
          edge_signatures: [circleEdge(last.r, zb), [0, 0, tip, last.r, 0, zb], [0, 0, tip, 0, 0, tip], [0, 0, tip, last.r, 0, zb]],
        });
      }
    }
  }
  const idx = Uint32Array.from(indices);
  // A mirrored instance: its faces turned inwards (the volume negative).
  if (inverted) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  return { positions: Float64Array.from(positions), indices: idx, surfaces };
}

/** A Reader body of a synthetic part (as the CAD engine gives it), its holes measured when `holes` is given. */
export function partBody(part, extra = {}) {
  const S = Math.max(...part.positions.filter((_, i) => i % 3 === 0));
  const zs = part.positions.filter((_, i) => i % 3 === 2);
  const min = [-S, -S, Math.min(...zs)], max = [S, S, Math.max(...zs)];
  return {
    name: 'Plate',
    method: 'brep',
    closed: true,
    volume: 1000,
    area: 600,
    bbox: { min, max, size: max.map((v, i) => v - min[i]) },
    surface_types: { plane: 1, cylinder: 1, cone: 0, sphere: 0, torus: 0, bspline: 0 },
    mesh: { positions: new Float32Array(part.positions), indices: part.indices },
    geometric_surfaces: part.surfaces,
    notes: [],
    ...extra,
  };
}
