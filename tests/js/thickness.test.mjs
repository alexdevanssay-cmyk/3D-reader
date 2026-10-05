// Wall thickness (web/engine/thickness.js) on meshes of known thickness.
//
//   node --test tests/js/thickness.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { thicknessHistogram, thicknessStats, valueRange, wallThickness } from '../../web/engine/thickness.js';

/** Closed mesh of an extruded polygon (counter-clockwise, star-shaped from `kernel`), z from 0 to h. */
function extrude(polygon, h, kernel, { divisions = 1 } = {}) {
  const positions = [];
  const indices = [];
  const vertex = (x, y, z) => positions.push(x, y, z) / 3 - 1;
  const n = polygon.length;
  // Caps: fans from the kernel point.
  const bottomCentre = vertex(kernel[0], kernel[1], 0);
  const topCentre = vertex(kernel[0], kernel[1], h);
  const bottom = polygon.map(([x, y]) => vertex(x, y, 0));
  const top = polygon.map(([x, y]) => vertex(x, y, h));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(bottomCentre, bottom[j], bottom[i]);
    indices.push(topCentre, top[i], top[j]);
  }
  // Sides: one quad per edge, split along z into `divisions` rows.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const rows = [];
    for (let r = 0; r <= divisions; r++) {
      const z = (h * r) / divisions;
      rows.push(r === 0 ? [bottom[i], bottom[j]] : r === divisions ? [top[i], top[j]] : [vertex(...polygon[i], z), vertex(...polygon[j], z)]);
    }
    for (let r = 0; r < divisions; r++) {
      const [a, b] = rows[r];
      const [c, d] = rows[r + 1];
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Closed mesh of a tube (outer radius R, inner r, height h), `segments` around. */
function tube(R, r, h, segments = 96) {
  const positions = [];
  const indices = [];
  const ring = (radius, z) => {
    const first = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(radius * Math.cos(a), radius * Math.sin(a), z);
    }
    return first;
  };
  const ob = ring(R, 0), ot = ring(R, h), ib = ring(r, 0), it = ring(r, h);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(ob + i, ob + j, ot + j, ob + i, ot + j, ot + i); // outside, facing out
    indices.push(ib + j, ib + i, it + i, ib + j, it + i, it + j); // inside, facing the axis
    indices.push(ot + i, ot + j, it + j, ot + i, it + j, it + i); // top
    indices.push(ob + j, ob + i, ib + i, ob + j, ib + i, ib + j); // bottom
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

const box = (lx, ly, lz) =>
  extrude([[0, 0], [lx, 0], [lx, ly], [0, ly]], lz, [lx / 2, ly / 2]);

function areaWeighted(mesh, values) {
  const P = mesh.positions;
  const I = mesh.indices;
  const items = [];
  for (let f = 0; f < I.length / 3; f++) {
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    items.push([values[f], area]);
  }
  items.sort((x, y) => x[0] - y[0]);
  const total = items.reduce((n, it) => n + it[1], 0);
  return (fraction) => {
    let acc = 0;
    for (const [value, area] of items) if ((acc += area) >= fraction * total) return value;
    return items.at(-1)[0];
  };
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} instead of ${expected} ± ${tol}`);

describe('wall thickness', () => {
  test('a plate reads its thickness everywhere with the sphere method', () => {
    const plate = box(100, 60, 8);
    const { sphere, ray } = wallThickness(plate.positions, plate.indices);
    assert.equal(sphere.length, plate.indices.length / 3);
    for (const v of sphere) near(v, 8, 0.1, 'sphere');
    // The ray crosses the plate on its large faces; the end faces read its length.
    const [min, max] = valueRange(ray);
    near(min, 8, 1e-9, 'ray min');
    near(max, 100, 1e-9, 'ray max');
  });

  test('the orientation of the triangles does not matter', () => {
    const plate = box(50, 40, 5);
    const flipped = Uint32Array.from(plate.indices);
    for (let i = 0; i < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]];
    const a = wallThickness(plate.positions, plate.indices);
    const b = wallThickness(plate.positions, flipped);
    assert.deepEqual(b.sphere, a.sphere);
    assert.deepEqual(b.ray, a.ray);
  });

  test('a tube reads its wall thickness on both cylinders', () => {
    const mesh = tube(20, 14, 50);
    const { sphere, ray } = wallThickness(mesh.positions, mesh.indices);
    const q = areaWeighted(mesh, sphere);
    near(q(0.02), 6, 0.15, 'sphere, 2 % of the area');
    near(q(0.98), 6, 0.15, 'sphere, 98 % of the area');
    // Along the normal of the cylinders (2/3 of the surface: outside and inside).
    const qr = areaWeighted(mesh, ray);
    near(qr(0.3), 6, 0.1, 'ray');
  });

  test('a T junction of 6 mm walls shows a hot spot larger than the walls', () => {
    // T profile: bar 60 x 6, stem 6 wide and 30 long below it; extruded 100 mm.
    const T = [[-30, 0], [-3, 0], [-3, -30], [3, -30], [3, 0], [30, 0], [30, 6], [-30, 6]];
    const mesh = extrude(T, 100, [0, 3], { divisions: 20 });
    const { sphere } = wallThickness(mesh.positions, mesh.indices);
    const q = areaWeighted(mesh, sphere);
    near(q(0.5), 6, 0.1, 'walls');
    const [, max] = valueRange(sphere);
    // Largest circle in the junction: through the top of the bar and the two
    // inner corners: diameter 7.5 (3^2 + (6 - r)^2 = r^2 -> r = 3.75).
    near(max, 7.5, 0.15, 'hot spot');
  });

  test('thinnest wall: the ends of a bar do not count as thin walls', () => {
    // A 10 x 10 bar, 100 long: near its end faces no ball fits (sphere < 10),
    // but the wall between opposite faces is 10 everywhere.
    const bar = box(10, 10, 100);
    const { sphere, wall } = wallThickness(bar.positions, bar.indices);
    const parts = (values) => [{ positions: bar.positions, indices: bar.indices, values }];
    const s = thicknessStats(parts(sphere));
    const w = thicknessStats(parts(wall));
    near(w.min, 10, 0.05, 'wall min');
    near(w.median, 10, 0.05, 'wall median');
    near(s.median, 10, 0.05, 'sphere median');
    assert.ok(s.area > 0 && Math.abs(s.area - w.area) < 1e-9);
  });

  test('thinnest wall of a T junction: the walls, not the junction', () => {
    const T = [[-30, 0], [-3, 0], [-3, -30], [3, -30], [3, 0], [30, 0], [30, 6], [-30, 6]];
    const mesh = extrude(T, 100, [0, 3], { divisions: 20 });
    const { wall } = wallThickness(mesh.positions, mesh.indices);
    const stats = thicknessStats([{ positions: mesh.positions, indices: mesh.indices, values: wall }]);
    near(stats.min, 6, 0.05, 'thinnest wall');
  });

  test('statistics of nothing', () => {
    assert.deepEqual(thicknessStats([]), { min: null, median: null, max: null, area: 0, details: null });
  });

  test('lettering thinner than the floor: reported apart, not as the thinnest wall', () => {
    // An 8 mm plate and a 0.5 mm thin raised mark (a separate thin slab).
    const plate = box(100, 60, 8);
    const mark = box(20, 20, 0.5);
    const parts = [plate, mark].map((m) => ({ positions: m.positions, indices: m.indices, values: wallThickness(m.positions, m.indices).wall }));
    const raw = thicknessStats(parts);
    near(raw.min, 0.5, 0.01, 'without floor, the mark is the thinnest wall');
    assert.equal(raw.details, null);
    const s = thicknessStats(parts, { floor: 1 });
    near(s.min, 8, 0.05, 'thinnest wall above the floor');
    near(s.details.min, 0.5, 0.01, 'lettering');
    near(s.details.share, (2 * 20 * 20) / (2 * (100 * 60 + 100 * 8 + 60 * 8) + 2 * 20 * 20 + 4 * 20 * 0.5), 0.05, 'share of the surface');
  });

  test('histogram: area per thickness class', () => {
    const plate = box(100, 60, 8);
    const { ray } = wallThickness(plate.positions, plate.indices);
    const { area, total } = thicknessHistogram(plate.positions, plate.indices, ray, 10, 5);
    near(total, 2 * (100 * 60 + 100 * 8 + 60 * 8), 1e-6, 'total area');
    near(area[0], 2 * 100 * 60, 1e-6, 'class 0-10 mm: the large faces');
    near(area[4], 2 * (100 * 8 + 60 * 8), 1e-6, 'last class: everything thicker');
  });

  test('progress is reported up to the end', () => {
    const mesh = tube(20, 14, 50, 32);
    const seen = [];
    wallThickness(mesh.positions, mesh.indices, { onProgress: (f) => seen.push(f) });
    assert.ok(seen.length > 10);
    assert.ok(seen.every((f, i) => i === 0 || f >= seen[i - 1]));
    assert.equal(seen.at(-1), 1);
  });

  test('an empty mesh gives empty results', () => {
    const { sphere, ray, wall } = wallThickness(new Float32Array(0), new Uint32Array(0));
    assert.equal(sphere.length, 0);
    assert.equal(ray.length, 0);
    assert.equal(wall.length, 0);
  });
});
