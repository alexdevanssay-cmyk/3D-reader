// Section view: what closes the solids the section plane cuts (app.js).
// The plane keeps the points p with n·p + c >= 0 (three.js Plane: normal n,
// constant c). A solid it cuts gets a cap: a rectangle lying in the plane,
// over the boxes of the solids cut seen along n (the same for all of them),
// drawn where the plane is inside the solid (stencil buffer). Arrays
// [x, y, z]; boxes {min, max}. No three.js here: run by the unit tests.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The lowest and the highest n·p + c over the corners of a box. */
function spanAlong(normal, constant, box) {
  let lo = constant, hi = constant;
  for (let k = 0; k < 3; k++) {
    const a = normal[k] * box.min[k], b = normal[k] * box.max[k];
    lo += Math.min(a, b);
    hi += Math.max(a, b);
  }
  return [lo, hi];
}

/** Whether the plane crosses the box (corners strictly on both sides of it): a solid in that box may be cut. */
export function planeCutsBox(normal, constant, box) {
  const [lo, hi] = spanAlong(normal, constant, box);
  return lo < 0 && hi > 0;
}

/**
 * A rectangle in the plane covering the box seen along the normal (the
 * projections of its corners on the plane), widened by `margin` of its larger
 * side all round: its 4 corners in turn, counter-clockwise seen from the side
 * the normal points to (the side kept), as 12 numbers; null for a normal of
 * length 0.
 */
export function capQuad(normal, constant, box, margin = 0.02) {
  const len = Math.hypot(...normal);
  if (!(len > 0)) return null;
  const n = normal.map((x) => x / len);
  const c = constant / len;
  // Two directions in the plane, u × v = n.
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = cross(n, a);
  const ul = Math.hypot(...u);
  u = u.map((x) => x / ul);
  const v = cross(n, u);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
    const pu = dot(p, u), pv = dot(p, v);
    u0 = Math.min(u0, pu);
    u1 = Math.max(u1, pu);
    v0 = Math.min(v0, pv);
    v1 = Math.max(v1, pv);
  }
  const pad = margin * Math.max(u1 - u0, v1 - v0);
  u0 -= pad;
  u1 += pad;
  v0 -= pad;
  v1 += pad;
  // The point of the plane nearest the origin, then the corners round it.
  const o = n.map((x) => -c * x);
  const out = [];
  for (const [U, V] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) for (let k = 0; k < 3; k++) out.push(o[k] + U * u[k] + V * v[k]);
  return out;
}

/**
 * The render orders of the caps of `count` solids, one after the other
 * within (lo, hi): [counting the solid's faces, its cap] for each. Drawn in
 * that order, each solid's count is reset by its cap before the next one.
 */
export function capOrders(count, lo = 0.5, hi = 0.9) {
  const step = (hi - lo) / Math.max(count, 1);
  return Array.from({ length: count }, (_, k) => [lo + k * step, lo + (k + 0.5) * step]);
}
