// Orientation of a cast part in its die, by casting process (gravity die
// « coquille gravité », low pressure « basse pression »): the die block of a
// draw direction (the steel blank, « brut de coquille », a rectangular block)
// and the direction that is up when the metal is cast (« haut de coulée », g).
//
// Die block. The part projected on the plane square to the draw direction d
// fits in a rectangle; the smallest one (convex hull by Andrew's monotone
// chain, then rotating calipers: the minimum-area rectangle has a side on an
// edge of the hull, Freeman & Shapira 1975) gives the axes u, v of the block
// in the parting plane and its sides a >= b along them; c is the extent of
// the part along d. Rectangles as small (a regular polygon): the one whose u
// is the closest to an axis of the frame, then the smaller angle from the
// axis of the frame the plane shows longest (X, then Y, then Z): the same
// rectangle whatever the order of the points and the sense of d. The block
// round it as web/chiffrage/tooling.js dieSize
// sizes it, but oriented: L = a + 2 longueur, l = n b + (n - 1)
// entreEmpreintes + 2 largeur (the n cavities side by side along v), h = c +
// 2 hauteur, its steel L l h × densite.
//
// Up direction. A horizontal parting plane (the upper die on top): g = ±d,
// the sense of d then chosen so that g = +d (flip d = swap the halves; the
// caller does it). A vertical parting plane (the die opens horizontally, the
// block stands on one of its edges): g one of ±u, ±v. Chosen by the feeding:
// the massive sections on the feeding side, under the risers for a die fed
// from the top (gravity), near the ingate for a die fed from below (low
// pressure: directional solidification from the top towards the feed). What
// is always known in the worker measures it: s(g) = ((c_V - c_A) · g) / H_g,
// c_V the centroid of the solid, c_A that of its surface, H_g the extent of
// the part along g. A thick section holds more volume for its surface: s > 0
// puts the massive sections towards +g. A top feed wants s high, a bottom
// feed s low. With the wall thickness of each triangle (the diameter t of its
// inscribed sphere, from the thickness card), c_T = Σ area t³ centre / Σ area
// t³ in place of c_V: area × t is the metal under the face (the slab estimate
// of feeding.js), t² grows as its solidification time (Chvorinov: the modulus
// ~ t, the time ~ modulus²): the sections that are heavy and freeze last
// weigh the most. Two senses within UP_TIE of the best: the shorter side
// vertical (a lower metallostatic head and fill height), then + before -,
// then u before v. The feeding chooses g for a draw direction, never the
// direction: the die block and the undercuts depend on the part and d only,
// so parting.js proposes the same d (and blank) whatever the process; the
// process decides which way is up.
//
// Plain JavaScript without bare imports: it runs in the parting worker
// (parting.js, partworker.js) and on the page (a line drawn by hand, the
// score again with the thickness).

export const DEFAULT_PROCESS = Object.freeze({ plan: "vertical", alimentation: "haut" });
export const PLANS = Object.freeze(["vertical", "horizontal"]);
export const FEEDS = Object.freeze(["haut", "bas"]);

// The die block of the costing: the margins round one cavity, between the
// cavities, and the density of the steel of web/chiffrage/tooling.js
// DEFAULT_TOOLING (marges, densite), one cavity. Copied, not imported: the
// workers do not load the costing (tests/js/orientation.test.mjs checks they
// agree). The page sends the settings' own with each job.
export const DIE_DEFAULTS = Object.freeze({
  marges: Object.freeze({ longueur: 60, largeur: 60, hauteur: 50, entreEmpreintes: 40 }),
  densite: 7.8,
  cavities: 1,
});

// Two senses of g whose scores differ by less than this are tied.
export const UP_TIE = 0.02;
// Ranking of the draw directions (parting.js): steel masses within this share
// of the larger are equal. The feeding score does not rank them: it chooses
// the casting up of the direction (and on a horizontal plane its sense) only.
export const STEEL_TIE = 0.05;
// Rectangles of areas within this share of the least are the same size (the
// rounding of float positions; the sides of a regular polygon).
const AREA_TIE = 1e-6;
// Axes closer to a frame axis than this (|cosine|) are as close.
const AXIS_TIE = 1e-9;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const round = (v, digits = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits + 0 : v ?? null);
const roundVec = (v, digits = 6) => v.map((x) => round(x, digits));

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** One sense of a direction: its largest component positive; components under 1e-12 cleared (no -0). */
function canonical(v) {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i;
  const s = v[k] < 0 ? -1 : 1;
  return v.map((x) => (Math.abs(x) < 1e-12 ? 0 : x * s + 0));
}

/** Two unit vectors square to d and to each other (as parting.js). */
export function planeBasis(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(d, a));
  return [u, cross(d, u)];
}

/** "Z", "-X"… for an axis of the frame (within 1e-6), else its components. */
function label(v) {
  for (let k = 0; k < 3; k++) if (Math.abs(v[k]) >= 1 - 1e-6) return (v[k] < 0 ? "-" : "+") + "XYZ"[k];
  return `(${v.map((x) => round(x, 3)).join(", ")})`;
}

// ------------------------------------------------------------------ process, die

/** A process profile {plan: "vertical" | "horizontal", alimentation: "haut" | "bas"}; what is missing or unknown, the default (gravity, vertical plane, top feed). */
export function normalizeProcess(p) {
  return {
    plan: PLANS.includes(p?.plan) ? p.plan : DEFAULT_PROCESS.plan,
    alimentation: FEEDS.includes(p?.alimentation) ? p.alimentation : DEFAULT_PROCESS.alimentation,
  };
}

/**
 * The profile of an island of the costing ({famille, orientation}): its own
 * orientation (settings.processes[code].orientation), else by its family:
 * « Basse pression » horizontal and fed from below, any other (« Coquille
 * gravité », « Sous pression », none) the default. {plan, alimentation, source
 * ("island" | "family" | "default")}.
 */
export function processForIsland(island) {
  const o = island?.orientation;
  if (o && PLANS.includes(o.plan) && FEEDS.includes(o.alimentation)) return { plan: o.plan, alimentation: o.alimentation, source: "island" };
  const famille = String(island?.famille ?? "");
  if (/^basse pression/i.test(famille)) return { plan: "horizontal", alimentation: "bas", source: "family" };
  if (/^coquille gravit/i.test(famille)) return { ...DEFAULT_PROCESS, source: "family" };
  return { ...DEFAULT_PROCESS, source: "default" };
}

/** A number given (a number, or a numeric string) passing ok, else `fallback`. */
function numberOr(x, fallback, ok) {
  const v = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(v) && ok(v) ? v : fallback;
}

/**
 * The die options {marges: {longueur, largeur, hauteur, entreEmpreintes}
 * (mm), densite (kg/dm³), cavities}: those given (the tooling settings of the
 * costing do: they hold marges and densite), the others DIE_DEFAULTS.
 */
export function normalizeDie(die) {
  const m = die?.marges ?? {};
  const d = DIE_DEFAULTS.marges;
  const margin = (k) => numberOr(m[k], d[k], (v) => v >= 0);
  return {
    marges: { longueur: margin("longueur"), largeur: margin("largeur"), hauteur: margin("hauteur"), entreEmpreintes: margin("entreEmpreintes") },
    densite: numberOr(die?.densite, DIE_DEFAULTS.densite, (v) => v > 0),
    cavities: Math.max(1, Math.round(numberOr(die?.cavities, DIE_DEFAULTS.cavities, (v) => v >= 1))),
  };
}

/** A short hash of the die options (FNV-1a, 8 hex digits): part of the cache keys of the parting results. */
export function dieKey(die) {
  const n = normalizeDie(die);
  const text = [n.marges.longueur, n.marges.largeur, n.marges.hauteur, n.marges.entreEmpreintes, n.densite, n.cavities].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** What a parting result depends on beyond the mesh: "vertical-haut|1a2b3c4d" (the profile, the hash of the die options). */
export function orientationKey(process, die) {
  const p = normalizeProcess(process);
  return `${p.plan}-${p.alimentation}|${dieKey(die)}`;
}

/**
 * The die block of a part of raw sizes [a, b, c] (mm; a, b across the draw
 * direction, c along it) with the margins, the cavities and the density of
 * `die`: as tooling.js dieSize, oriented. {L, l, h (mm), n (cavities),
 * volume_mm3, steel_kg}.
 */
export function dieBlock([a, b, c], die = DIE_DEFAULTS) {
  const { marges: m, densite, cavities: n } = normalizeDie(die);
  const L = a + 2 * m.longueur;
  const l = n * b + (n - 1) * m.entreEmpreintes + 2 * m.largeur;
  const h = c + 2 * m.hauteur;
  const volume = L * l * h;
  return { L, l, h, n, volume_mm3: volume, steel_kg: (volume * densite) / 1e6 };
}

// ------------------------------------------------------------------ minimum-area rectangle

// Points left near the outline above this many: those closer than
// DEDUPE_SHARE of the extent of the points to an earlier one dropped (a
// cylinder seen along its axis: every ring on the same circle), then, still
// as many, filtered again by a polygon of OUTLINE_FINE directions (seen
// askew: the rings between its ends near its sides), before the sort.
const DEDUPE_ABOVE = 4096;
const OUTLINE_FINE = 64;
const DEDUPE_SHARE = 1e-9;

/**
 * The points `ids` outside the polygon of their extreme points along K
 * directions (Akl-Toussaint; on its outline within rounding: kept): those
 * that may be corners of their convex hull. {ids, span (the larger extent
 * of the points along x, along y)}.
 */
function outlineFilter(xs, ys, ids, K) {
  const n = ids.length;
  const cs = new Float64Array(K), sn = new Float64Array(K);
  for (let j = 0; j < K; j++) {
    // Exact along the axes and the diagonals of the frame.
    cs[j] = j % (K / 4) === 0 ? [1, 0, -1, 0][(4 * j) / K] : Math.cos((2 * Math.PI * j) / K);
    sn[j] = j % (K / 4) === 0 ? [0, 1, 0, -1][(4 * j) / K] : Math.sin((2 * Math.PI * j) / K);
  }
  const best = new Float64Array(K).fill(-Infinity);
  const ext = new Int32Array(K);
  for (let k = 0; k < n; k++) {
    const i = ids[k], x = xs[i], y = ys[i];
    for (let j = 0; j < K; j++) {
      const s = cs[j] * x + sn[j] * y;
      if (s > best[j]) {
        best[j] = s;
        ext[j] = i; // the first one met of equals
      }
    }
  }
  const span = Math.max(best[0] + best[K / 2], best[K / 4] + best[(3 * K) / 4], 0);
  // The polygon, its corners counter-clockwise (the extremes in the order of their directions), once
  // each; each edge as the half-plane nx x + ny y > c inside it.
  const corners = [];
  for (const e of ext) if (!corners.length || (e !== corners.at(-1) && e !== corners[0])) corners.push(e);
  const E = corners.length >= 3 ? corners.length : 0;
  const plane = new Float64Array(3 * E);
  for (let e = 0; e < E; e++) {
    const p = corners[e], q = corners[(e + 1) % E];
    const nx = -(ys[q] - ys[p]), ny = xs[q] - xs[p];
    plane[3 * e] = nx;
    plane[3 * e + 1] = ny;
    plane[3 * e + 2] = nx * xs[p] + ny * ys[p] + 1e-12 * span * span;
  }
  const keep = new Int32Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k], x = xs[i], y = ys[i];
    let inside = E > 0;
    for (let e = 0; e < E; e++) {
      if (plane[3 * e] * x + plane[3 * e + 1] * y <= plane[3 * e + 2]) {
        inside = false;
        break;
      }
    }
    if (!inside) keep[m++] = i;
  }
  return { ids: keep.subarray(0, m), span };
}

/**
 * Convex hull of the points (xs[i], ys[i]) of `list` (all when null), Andrew's
 * monotone chain in double precision: their indices, counter-clockwise from
 * the lowest x (then y), without collinear points (within rounding). The points inside the
 * octagon of their extreme points along 8 directions are left out first
 * (Akl-Toussaint): only those near the outline are sorted; many of them,
 * their near duplicates dropped, then filtered again (DEDUPE_*, OUTLINE_FINE).
 */
export function convexHull(xs, ys, list = null) {
  const n = list ? list.length : xs.length;
  if (!n) return new Int32Array(0);
  let ids = list;
  if (!ids) {
    ids = new Int32Array(n);
    for (let k = 0; k < n; k++) ids[k] = k;
  }
  let { ids: keep, span } = outlineFilter(xs, ys, ids, 8);
  if (keep.length > DEDUPE_ABOVE && span > 0) keep = dedupe(xs, ys, keep, DEDUPE_SHARE * span);
  if (keep.length > DEDUPE_ABOVE) keep = outlineFilter(xs, ys, keep, OUTLINE_FINE).ids;
  const sorted = Int32Array.from(keep).sort((i, j) => xs[i] - xs[j] || ys[i] - ys[j] || i - j);
  const m = sorted.length;
  const hull = new Int32Array(2 * m + 1);
  let h = 0;
  // A turn within the rounding of the coordinates (1e-12 of the extent squared): straight on, the middle point dropped.
  const flat = 1e-12 * span * span;
  const turn = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  for (let k = 0; k < m; k++) {
    while (h >= 2 && turn(hull[h - 2], hull[h - 1], sorted[k]) <= flat) h--;
    hull[h++] = sorted[k];
  }
  for (let k = m - 2, low = h + 1; k >= 0; k--) {
    while (h >= low && turn(hull[h - 2], hull[h - 1], sorted[k]) <= flat) h--;
    hull[h++] = sorted[k];
  }
  // The last point is the first again (a single point: itself once).
  return hull.slice(0, Math.max(1, h - 1));
}

/**
 * The points `ids` without those in the same cell of a grid of `q` as an
 * earlier one (an open-addressing table of the cells, in the order given).
 */
function dedupe(xs, ys, ids, q) {
  const n = ids.length;
  let x0 = Infinity, y0 = Infinity;
  for (let k = 0; k < n; k++) {
    if (xs[ids[k]] < x0) x0 = xs[ids[k]];
    if (ys[ids[k]] < y0) y0 = ys[ids[k]];
  }
  let size = 16;
  while (size < 2 * n) size *= 2;
  const mask = size - 1;
  const slots = new Int32Array(size).fill(-1);
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const out = new Int32Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k];
    const a = Math.round((xs[i] - x0) / q), b = Math.round((ys[i] - y0) / q);
    let slot = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) & mask;
    for (;;) {
      const s = slots[slot];
      if (s < 0) {
        slots[slot] = m;
        cx[m] = a;
        cy[m] = b;
        out[m++] = i;
        break;
      }
      if (cx[s] === a && cy[s] === b) break;
      slot = (slot + 1) & mask;
    }
  }
  return out.subarray(0, m);
}

/** u in the sense whose angle is in [0, π): y > 0, or y = 0 and x > 0. */
const halfTurn = (x, y) => (y < 0 || (y === 0 && x < 0) ? [-x + 0, -y + 0] : [x, y]);

/**
 * Minimum-area rectangle round the points (xs[i], ys[i]) of `list` (all when
 * null): rotating calipers on their convex hull, one rectangle per edge of
 * it. Ties (areas within AREA_TIE): the one whose u (its longer side) is the
 * closest to an axis of the frame (of the plane's `basis` [e1, e2] in 3D when
 * given, else of the 2D frame), then the smaller angle of u (in [0, π),
 * counter-clockwise from `reference`, a 2D direction: x by default).
 * Returns {a, b (its sides, a >= b), u, v (unit, 2D, u along a; each with its
 * largest component positive), centre [x, y], area, hull (its point count)}.
 */
export function minAreaRect(xs, ys, { list = null, basis = null, reference = [1, 0] } = {}) {
  const hull = convexHull(xs, ys, list);
  const h = hull.length;
  const closeness = (u) => {
    if (!basis) return Math.max(Math.abs(u[0]), Math.abs(u[1]));
    const [e1, e2] = basis;
    return Math.max(...[0, 1, 2].map((k) => Math.abs(u[0] * e1[k] + u[1] * e2[k])));
  };
  const result = (u2, a, b, cx, cy) => {
    const [ux, uy] = halfTurn(u2[0], u2[1]);
    const u = Math.abs(ux) >= Math.abs(uy) ? (ux < 0 ? [-ux + 0, -uy + 0] : [ux, uy]) : uy < 0 ? [-ux + 0, -uy + 0] : [ux, uy];
    const v0 = [-u[1] + 0, u[0]];
    const v = Math.abs(v0[0]) >= Math.abs(v0[1]) ? (v0[0] < 0 ? [-v0[0] + 0, -v0[1] + 0] : v0) : v0[1] < 0 ? [-v0[0] + 0, -v0[1] + 0] : v0;
    return { a, b, u, v, centre: [cx, cy], area: a * b, hull: h };
  };
  if (!h) return result([1, 0], 0, 0, 0, 0);
  if (h === 1) return result([1, 0], 0, 0, xs[hull[0]], ys[hull[0]]);
  const hx = Float64Array.from(hull, (i) => xs[i]), hy = Float64Array.from(hull, (i) => ys[i]);
  if (h === 2) {
    // A segment (or one point twice: of no length, along x).
    const len = Math.hypot(hx[1] - hx[0], hy[1] - hy[0]);
    const u = len > 0 ? [(hx[1] - hx[0]) / len, (hy[1] - hy[0]) / len] : [1, 0];
    return result(u, len, 0, (hx[0] + hx[1]) / 2, (hy[0] + hy[1]) / 2);
  }
  // Per edge i (from point i to i + 1): the rectangle with a side on it.
  const area = new Float64Array(h), width = new Float64Array(h), height = new Float64Array(h);
  const ex = new Float64Array(h), ey = new Float64Array(h), cx = new Float64Array(h), cy = new Float64Array(h);
  let j = 0, k = 0, l = 0; // the points furthest along the edge, from it (inwards), back along it
  for (let i = 0; i < h; i++) {
    const i1 = (i + 1) % h;
    let dx = hx[i1] - hx[i], dy = hy[i1] - hy[i];
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    // Counter-clockwise: the inside is on the left, along (-dy, dx).
    const along = (p) => (hx[p] - hx[i]) * dx + (hy[p] - hy[i]) * dy;
    const across = (p) => (hy[p] - hy[i]) * dx - (hx[p] - hx[i]) * dy;
    if (i === 0) {
      for (let p = 1; p < h; p++) {
        if (along(p) > along(j)) j = p;
        if (across(p) > across(k)) k = p;
        if (along(p) < along(l)) l = p;
      }
    } else {
      // The edges turn counter-clockwise: each of these points moves forward round the hull.
      for (let s = 0; s < h && along((j + 1) % h) >= along(j); s++) j = (j + 1) % h;
      for (let s = 0; s < h && across((k + 1) % h) >= across(k); s++) k = (k + 1) % h;
      for (let s = 0; s < h && along((l + 1) % h) <= along(l); s++) l = (l + 1) % h;
    }
    const a0 = along(l), a1 = along(j), b1 = across(k);
    width[i] = a1 - a0;
    height[i] = b1;
    area[i] = width[i] * height[i];
    ex[i] = dx;
    ey[i] = dy;
    cx[i] = hx[i] + ((a0 + a1) / 2) * dx - (b1 / 2) * dy;
    cy[i] = hy[i] + ((a0 + a1) / 2) * dy + (b1 / 2) * dx;
  }
  let least = Infinity;
  for (let i = 0; i < h; i++) least = Math.min(least, area[i]);
  let pick = -1, pickClose = -1, pickAngle = Infinity;
  for (let i = 0; i < h; i++) {
    if (area[i] > least + AREA_TIE * least) continue;
    const u = width[i] >= height[i] ? [ex[i], ey[i]] : [-ey[i], ex[i]];
    const close = closeness(u);
    // u in the frame of the reference (rx, ry), (-ry, rx).
    const [hxu, hyu] = halfTurn(u[0] * reference[0] + u[1] * reference[1], u[1] * reference[0] - u[0] * reference[1]);
    let angle = Math.atan2(hyu, hxu);
    if (angle >= Math.PI - 1e-12) angle = 0;
    if (pick < 0 || close > pickClose + AXIS_TIE || (close >= pickClose - AXIS_TIE && angle < pickAngle)) {
      pick = i;
      pickClose = close;
      pickAngle = angle;
    }
  }
  const i = pick;
  const longer = width[i] >= height[i];
  return result(longer ? [ex[i], ey[i]] : [-ey[i], ex[i]], longer ? width[i] : height[i], longer ? height[i] : width[i], cx[i], cy[i]);
}

// ------------------------------------------------------------------ mesh

/**
 * What the orientation needs of a mesh, computed once: the positions in
 * double precision moved to the centre of their box, the areas and centres
 * of the triangles (parting.js prepareMesh gives them: `prepared`), the
 * vertices the triangles use, the centroids of the solid and of its surface;
 * the block frames of the directions asked for are kept on it.
 */
export function orientationMesh(positions, indices, prepared = null) {
  let P, centre, areas, centres;
  const nt = indices.length / 3;
  if (prepared) ({ positions: P, centre, areas, centres } = prepared);
  else {
    const nv = positions.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++) {
        const x = positions[3 * i + k];
        if (x < min[k]) min[k] = x;
        if (x > max[k]) max[k] = x;
      }
    }
    centre = nv ? min.map((m, k) => (m + max[k]) / 2) : [0, 0, 0];
    P = new Float64Array(3 * nv);
    for (let i = 0; i < 3 * nv; i++) P[i] = positions[i] - centre[i % 3];
    areas = new Float64Array(nt);
    centres = new Float64Array(3 * nt);
    for (let f = 0; f < nt; f++) {
      const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      areas[f] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      for (let k = 0; k < 3; k++) centres[3 * f + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
    }
  }
  // The vertices of the triangles, in their order in the positions (whatever the order of the triangles).
  const used = new Uint8Array(P.length / 3);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;
  let count = 0;
  for (let i = 0; i < used.length; i++) count += used[i];
  const verts = new Int32Array(count);
  for (let i = 0, n = 0; i < used.length; i++) if (used[i]) verts[n++] = i;
  // Centroids (centred frame): of the surface, by area; of the solid, of the
  // signed tetrahedra from the centre (the sign of the enclosed volume, as the
  // outward normals of parting.js: a mesh turned inwards gives the same).
  let A = 0, V6 = 0, max = 0, may = 0, maz = 0, mvx = 0, mvy = 0, mvz = 0;
  for (let f = 0; f < nt; f++) {
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const v6 = P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    const w = areas[f];
    V6 += v6;
    A += w;
    mvx += (v6 * (P[a] + P[b] + P[c])) / 4;
    mvy += (v6 * (P[a + 1] + P[b + 1] + P[c + 1])) / 4;
    mvz += (v6 * (P[a + 2] + P[b + 2] + P[c + 2])) / 4;
    max += w * centres[3 * f];
    may += w * centres[3 * f + 1];
    maz += w * centres[3 * f + 2];
  }
  const ma = [max, may, maz], mv = [mvx, mvy, mvz];
  const area = A > 0 ? ma.map((m) => m / A) : [0, 0, 0];
  // An open or flat body (no volume): the surface's, the score 0.
  const volume = Math.abs(V6) > 1e-12 * Math.max(1, A) ** 1.5 ? mv.map((m) => m / V6) : area;
  return { P, indices, nt, areas, centres, centre, verts, centroids: { volume, area }, frames: new Map(), thickness: null };
}

/**
 * Centroid c_T of the surface weighted by area × t³ (t the inscribed
 * diameter of each triangle; NaN, 0 or negative: left out), centred frame;
 * null without any weight. Kept on the mesh for the same field.
 */
function thicknessCentroid(om, t) {
  if (!t || t.length !== om.nt) return null;
  if (om.thickness?.field === t) return om.thickness.centroid;
  let W = 0;
  const m = [0, 0, 0];
  for (let f = 0; f < om.nt; f++) {
    const x = t[f];
    if (!(x > 0)) continue;
    const w = om.areas[f] * x * x * x;
    W += w;
    for (let k = 0; k < 3; k++) m[k] += w * om.centres[3 * f + k];
  }
  const centroid = W > 0 ? m.map((x) => x / W) : null;
  om.thickness = { field: t, centroid };
  return centroid;
}

/**
 * The block frame of a draw axis (either sense of it: computed for its
 * canonical sense, the same for both): {u, v (unit, in the parting plane,
 * each with its largest component positive; u along the longer side), a, b
 * (the sides of the minimum-area rectangle of the part projected on the
 * plane, a >= b), c (its extent along the axis), centre (of that oriented
 * box, model frame)}.
 */
export function blockFrame(om, direction) {
  const unit = normalize(direction);
  if (!unit) throw new Error("Invalid draw direction");
  const axis = canonical(unit);
  const key = axis.join(",");
  const kept = om.frames.get(key);
  if (kept) return kept;
  const [e1, e2] = planeBasis(axis);
  const { P, verts } = om;
  const n = verts.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let wmin = Infinity, wmax = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = 3 * verts[k], x = P[i], y = P[i + 1], z = P[i + 2];
    xs[k] = x * e1[0] + y * e1[1] + z * e1[2];
    ys[k] = x * e2[0] + y * e2[1] + z * e2[2];
    const w = x * axis[0] + y * axis[1] + z * axis[2];
    if (w < wmin) wmin = w;
    if (w > wmax) wmax = w;
  }
  // Ties of the rectangle measured from the axis of the frame the plane shows longest (X, then Y, then Z).
  let ref = [1, 0], longest = -1;
  for (let k = 0; k < 3; k++) {
    const p = [e1[k], e2[k]], len = Math.hypot(p[0], p[1]);
    if (len > longest + 1e-9) [ref, longest] = [[p[0] / len, p[1] / len], len];
  }
  const r = minAreaRect(xs, ys, { basis: [e1, e2], reference: ref });
  const u = canonical(normalize([0, 1, 2].map((k) => r.u[0] * e1[k] + r.u[1] * e2[k])) ?? e1);
  const v = canonical(normalize(cross(axis, u)));
  const wc = n ? (wmin + wmax) / 2 : 0;
  const centre = [0, 1, 2].map((k) => om.centre[k] + r.centre[0] * e1[k] + r.centre[1] * e2[k] + wc * axis[k]);
  const frame = { axis, u, v, a: r.a, b: r.b, c: n ? wmax - wmin : 0, centre };
  om.frames.set(key, frame);
  return frame;
}

// ------------------------------------------------------------------ up direction

/**
 * The orientation of draw direction d (its sense as given) for a process:
 * the block frame, the die block, the allowed up directions with their
 * feeding scores and the one chosen (the rule above, or the allowed one
 * nearest to `up`: a vector or a side "+u", "-v", "+d"…).
 *
 * options -- process ({plan, alimentation}), die (normalizeDie), thickness
 *   (inscribed diameter per triangle: c_T in place of c_V), up
 * Returns {summary, steel (kg), side ("+u", "-u", "+v", "-v", "+d", "-d"),
 * up, frame}. The summary (JSON, mm):
 *   process {plan, alimentation}
 *   up (g, unit), up_axis ("+Z", "-X" or its components), up_side,
 *   upper_half_down (a horizontal plane whose up is -d: the upper half, +d,
 *     at the bottom, « chape supérieure en bas »)
 *   block_axes {u, v, d} (unit; u along a, v along b and the cavities)
 *   raw_mm [a, b, c], raw_centre_mm (the centre of that oriented box)
 *   die_block_mm [L, l, h], die_volume_dm3, steel_kg (L l h × densite: the
 *     bare block, without the weight coefficient of the costing), cavities,
 *     margins_mm, density
 *   feeding_score (s of g), feeding_basis ("volume_centroid" | "thickness")
 *   choices [{side, up, score, extent_mm}] (every allowed g: to choose
 *     another without computing again)
 *   centroids_mm {area (c_A), feeding (c_V or c_T)}
 */
export function orientationFor(om, direction, { process = null, die = null, thickness = null, up = null } = {}) {
  const d = normalize(direction);
  if (!d) throw new Error("Invalid draw direction");
  const p = normalizeProcess(process);
  const frame = blockFrame(om, d);
  const { u, v, a, b, c } = frame;
  const minus = (w) => w.map((x) => -x + 0);
  // [side, g, extent along g, rank of a tie: + before -, then u before v].
  const sides = p.plan === "horizontal"
    ? [["+d", d, c, 0], ["-d", minus(d), c, 1]]
    : [["+u", u, a, 0], ["-u", minus(u), a, 2], ["+v", v, b, 1], ["-v", minus(v), b, 3]];
  const cT = thicknessCentroid(om, thickness);
  const feeder = cT ?? om.centroids.volume;
  const shift = [0, 1, 2].map((k) => feeder[k] - om.centroids.area[k]);
  const sense = p.alimentation === "bas" ? -1 : 1;
  const choices = sides.map(([side, g, H, order]) => {
    const s = H > 0 ? dot(shift, g) / H : 0;
    return { side, g, H, s, e: sense * s, order };
  });
  let chosen = null;
  if (up != null) {
    if (typeof up === "string") chosen = choices.find((x) => x.side === up) ?? null;
    else {
      const w = normalize(up);
      if (w) for (const x of choices) if (!chosen || dot(x.g, w) > dot(chosen.g, w) + 1e-9) chosen = x;
    }
  }
  if (!chosen) {
    // The best score; those within UP_TIE of it: the shorter extent along g, then + before -, then u before v.
    const best = Math.max(...choices.map((x) => x.e));
    const tied = choices.filter((x) => best - x.e < UP_TIE);
    const Hmax = Math.max(...tied.map((x) => x.H));
    tied.sort((x, y) => (Math.abs(x.H - y.H) > 1e-9 * Hmax ? x.H - y.H : 0) || x.order - y.order);
    chosen = tied[0];
  }
  const block = dieBlock([a, b, c], die);
  const dieOptions = normalizeDie(die);
  const model = (q) => roundVec(q.map((x, k) => x + om.centre[k]), 3);
  const summary = {
    process: p,
    up: roundVec(chosen.g),
    up_axis: label(chosen.g),
    up_side: chosen.side,
    // A horizontal plane whose up is -d: the upper half (+d) at the bottom (« chape supérieure en bas »); a drawing by hand is not turned over.
    upper_half_down: p.plan === "horizontal" && chosen.side === "-d",
    block_axes: { u: roundVec(u), v: roundVec(v), d: roundVec(d) },
    raw_mm: [round(a, 2), round(b, 2), round(c, 2)],
    raw_centre_mm: roundVec(frame.centre, 3),
    die_block_mm: [round(block.L, 1), round(block.l, 1), round(block.h, 1)],
    die_volume_dm3: round(block.volume_mm3 / 1e6, 3),
    steel_kg: round(block.steel_kg, 1),
    cavities: block.n,
    margins_mm: dieOptions.marges,
    density: dieOptions.densite,
    feeding_score: round(chosen.s, 4),
    feeding_basis: cT ? "thickness" : "volume_centroid",
    choices: choices.map((x) => ({ side: x.side, up: roundVec(x.g), score: round(x.s, 4), extent_mm: round(x.H, 2) })),
    centroids_mm: { area: model(om.centroids.area), feeding: model(feeder) },
  };
  return { summary, steel: block.steel_kg, side: chosen.side, up: chosen.g, frame };
}

/**
 * The orientation of draw direction d of a body (a line drawn by hand: its
 * plane's normal, its sense as drawn; the score again with the thickness):
 * orientationFor(...).summary on a mesh of its own.
 */
export function orientationOf(positions, indices, direction, options = {}) {
  return orientationFor(orientationMesh(positions, indices), direction, options).summary;
}
