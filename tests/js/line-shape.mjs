// The shape of a parting line from its pieces (segments: xyz of both ends of
// each), shared by the parting tests: loose ends, runs turning back (teeth,
// combs), its loops (length, enclosed area); the undercut regions of a split
// (their areas); where the colours of the halves change with no line.
import { REACH_DOWN, REACH_UP, SIDE_NONE, lineMesh, partingPieces } from '../../web/engine/parting.js';

/** The ends of the pieces of a line met by an odd number of pieces (within 1e-4 mm): 0 when it is in closed loops. */
export function looseEnds(segments) {
  const ends = [];
  for (let i = 0; i < segments.length; i += 3) ends.push([segments[i], segments[i + 1], segments[i + 2]]);
  return ends.filter((p) => ends.filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4).length % 2).length;
}

/**
 * The shape of a line from its pieces (ends within 1e-4 mm), its pieces in a
 * straight row merged into runs: `reversals`, the points where two runs turn
 * back by more than 135° (a zigzag along long triangles, a spike round one);
 * `teeth`, the runs shorter than 3 mm at such a point (a notch, a tooth along
 * the short edges of triangles); `combs`, the runs (1 mm long at least) along
 * another within 3° and 1 mm of it over half their length (the parallel lines
 * of a comb across a band of long thin triangles, the two sides of a spike).
 */
export function shapeOfLine(segments) {
  const m = segments.length / 6;
  const key = (j) => `${Math.round(segments[j] * 1e4)},${Math.round(segments[j + 1] * 1e4)},${Math.round(segments[j + 2] * 1e4)}`;
  const at = (j) => [segments[j], segments[j + 1], segments[j + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(...a);
  const other = (j) => (j % 6 === 0 ? j + 3 : j - 3);
  const ends = new Map();
  for (let j = 0; j < segments.length; j += 3) (ends.get(key(j)) ?? ends.set(key(j), []).get(key(j))).push(j);
  // Runs: pieces in a row (turning by less than 1°) merged.
  const root = Int32Array.from({ length: m }, (_, k) => k);
  const find = (k) => (root[k] === k ? k : (root[k] = find(root[k])));
  const bends = [];
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const [u, v] = list.map((j) => sub(at(other(j)), at(j)));
    const turn = dot(u, v) / (len(u) * len(v));
    if (turn < -Math.cos(Math.PI / 180)) root[find(list[0] / 6 | 0)] = find(list[1] / 6 | 0);
    else bends.push([list[0], list[1], turn]);
  }
  const length = new Float64Array(m);
  for (let k = 0; k < m; k++) length[find(k)] += len(sub(at(6 * k + 3), at(6 * k)));
  let reversals = 0;
  const teeth = new Set();
  for (const [a, b, turn] of bends) {
    if (turn <= Math.cos(Math.PI / 4)) continue;
    reversals++;
    for (const j of [a, b]) if (length[find(j / 6 | 0)] < 3) teeth.add(find(j / 6 | 0));
  }
  // The ends of each run: the ends of its pieces not inside it.
  const runEnds = new Map();
  for (let j = 0; j < segments.length; j += 3) {
    const r = find(j / 6 | 0);
    const list = ends.get(key(j));
    if (list.length === 2 && find(list[0] / 6 | 0) === find(list[1] / 6 | 0)) continue;
    (runEnds.get(r) ?? runEnds.set(r, []).get(r)).push(at(j));
  }
  const runs = [...runEnds].filter(([r, e]) => e.length === 2 && length[r] >= 1).map(([, [a, b]]) => ({ a, b, l: len(sub(b, a)) }));
  // A run along a longer one: within 3° of it, over half its length, 1 mm off it at most.
  const along = (s, t) => {
    const u = sub(t.b, t.a).map((x) => x / t.l), w = sub(s.b, s.a);
    if (Math.abs(dot(u, w)) < Math.cos((3 * Math.PI) / 180) * s.l) return false;
    const ta = dot(sub(s.a, t.a), u), tb = dot(sub(s.b, t.a), u);
    const overlap = Math.min(Math.max(ta, tb), t.l) - Math.max(Math.min(ta, tb), 0);
    const off = (p, tp) => len(sub(sub(p, t.a), u.map((x) => x * tp)));
    return overlap >= s.l / 2 && Math.max(off(s.a, ta), off(s.b, tb)) < 1;
  };
  const comb = new Uint8Array(runs.length);
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length; k++) {
      const [s, t] = runs[i].l < runs[k].l ? [runs[i], runs[k]] : [runs[k], runs[i]];
      if (along(s, t)) comb[i] = comb[k] = 1;
    }
  }
  const combs = comb.reduce((n, c) => n + c, 0);
  return { reversals, teeth: teeth.size, combs };
}

/**
 * The loops of a line (its pieces chained by their ends, within 1e-4 mm):
 * [{pieces, length, area}], area the area it encloses (Newell, of its pieces
 * as a closed polygon when each of its points is on two pieces; else NaN),
 * longest first.
 */
export function lineLoops(segments) {
  const m = segments.length / 6;
  const key = (j) => `${Math.round(segments[j] * 1e4)},${Math.round(segments[j + 1] * 1e4)},${Math.round(segments[j + 2] * 1e4)}`;
  const at = (j) => [segments[j], segments[j + 1], segments[j + 2]];
  const ends = new Map();
  for (let j = 0; j < segments.length; j += 3) (ends.get(key(j)) ?? ends.set(key(j), []).get(key(j))).push(j);
  const seen = new Uint8Array(m);
  const loops = [];
  for (let k0 = 0; k0 < m; k0++) {
    if (seen[k0]) continue;
    seen[k0] = 1;
    const list = [k0];
    let length = 0, simple = true;
    for (let q = 0; q < list.length; q++) {
      const k = list[q];
      length += Math.hypot(...at(6 * k + 3).map((x, c) => x - segments[6 * k + c]));
      for (const j of [6 * k, 6 * k + 3]) {
        const others = ends.get(key(j));
        if (others.length !== 2) simple = false;
        for (const o of others) {
          const n = (o / 6) | 0;
          if (!seen[n]) {
            seen[n] = 1;
            list.push(n);
          }
        }
      }
    }
    let area = NaN;
    if (simple) {
      // Walk it in order: from the end of each piece to the other piece at that point.
      const order = [];
      let k = k0, from = 6 * k0;
      for (let i = 0; i < list.length; i++) {
        order.push(at(from));
        const to = from === 6 * k ? 6 * k + 3 : 6 * k;
        const next = ends.get(key(to)).find((o) => ((o / 6) | 0) !== k);
        k = (next / 6) | 0;
        from = next;
      }
      const n = [0, 0, 0];
      order.forEach((p, i) => {
        const r = order[(i + 1) % order.length];
        n[0] += (p[1] - r[1]) * (p[2] + r[2]);
        n[1] += (p[2] - r[2]) * (p[0] + r[0]);
        n[2] += (p[0] - r[0]) * (p[1] + r[1]);
      });
      area = Math.hypot(...n) / 2;
    }
    loops.push({ pieces: list.length, length, area });
  }
  return loops.sort((a, b) => b.length - a.length);
}

/** The undercut regions of a split (triangles without REACH_* joined by edges, `neighbours` of lineMesh): their areas, largest first. */
export function undercutRegions({ positions: P, indices: I }, neighbours, flags) {
  const nt = I.length / 3;
  const under = (f) => !(flags[f] & (REACH_UP | REACH_DOWN));
  const area = (f) => {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * I[3 * f + k]);
    const u = [0, 1, 2].map((k) => P[b + k] - P[a + k]), v = [0, 1, 2].map((k) => P[c + k] - P[a + k]);
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  };
  const seen = new Uint8Array(nt);
  const out = [];
  for (let f0 = 0; f0 < nt; f0++) {
    if (seen[f0] || !under(f0)) continue;
    seen[f0] = 1;
    const stack = [f0];
    let sum = 0;
    while (stack.length) {
      const f = stack.pop();
      sum += area(f);
      for (let e = 0; e < 3; e++) {
        const g = neighbours[3 * f + e];
        if (g >= 0 && !seen[g] && under(g)) {
          seen[g] = 1;
          stack.push(g);
        }
      }
    }
    out.push(sum);
  }
  return out.sort((a, b) => b - a);
}

/**
 * Where the colours of the halves change with no line drawn there, as the
 * page shows a split `r` (evaluateParting) along d: each triangle the line
 * crosses in the pieces partingPieces cuts it into (the line's cuts, the
 * triangles of the hooks it took out put on the other side), each other one
 * whole in its half (`side`). An undercut (a piece flagged so, a triangle
 * with no REACH_* or no half) is in the colour of the undercuts, no half's:
 * left out, so is a sliver narrower than 10 eps. Along every edge between
 * two triangles, and across every triangle between two of its pieces, each
 * stretch where the halves on either side differ is to be covered by
 * segments of the line, within eps (1e-5 of the diagonal: a piece may end a
 * hair before a vertex), or 1 % of the segment's length off it (a piece
 * straight across two triangles at an angle, the colours cut in the plane of
 * each). Returns the stretches not covered:
 * [{f, g (-1: inside f), from, to (xyz), length}]; [] when the line and the
 * colours agree.
 */
export function unlinedColourChanges({ positions: P, indices: I }, r, d) {
  const line = lineMesh(P, I);
  const { neighbours } = line;
  const nt = I.length / 3;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], P[i]);
    hi[i % 3] = Math.max(hi[i % 3], P[i]);
  }
  const eps = 1e-5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const pc = partingPieces(line, r.side, d, { flags: r.flags, plane: r.plane, height: r.summary.mould_height_mm });
  const pieces = new Map(); // triangle -> [{half, poly}]
  for (let k = 0; k < pc.count; k++) {
    const poly = [];
    for (let c = pc.start[k]; c < pc.start[k + 1]; c++) poly.push([pc.points[3 * c], pc.points[3 * c + 1], pc.points[3 * c + 2]]);
    // Its width (twice its area over its longest side): a sliver narrower than 10 eps shows no colour.
    const n = [0, 0, 0];
    let longest = 0;
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
      longest = Math.max(longest, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    });
    const visible = Math.hypot(n[0], n[1], n[2]) > 10 * eps * longest;
    const list = pieces.get(pc.tri[k]) ?? [];
    list.push({ half: pc.undercut[k] || !visible ? 0 : pc.half[k], poly });
    pieces.set(pc.tri[k], list);
  }
  // The segments of the line in a grid of cells (each in every cell its box meets), for the stretches to look them up.
  const S = r.segments;
  const size = Math.max(1, (hi[0] - lo[0] + hi[1] - lo[1] + hi[2] - lo[2]) / 300);
  const cellKey = (i, j, k) => `${i},${j},${k}`;
  const grid = new Map();
  const cellOf = (x, c) => Math.floor((x - lo[c]) / size);
  for (let j = 0; j < S.length; j += 6) {
    const a = [0, 1, 2].map((c) => cellOf(Math.min(S[j + c], S[j + 3 + c]) - eps, c)), b = [0, 1, 2].map((c) => cellOf(Math.max(S[j + c], S[j + 3 + c]) + eps, c));
    for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) {
      const key = cellKey(x, y, z);
      (grid.get(key) ?? grid.set(key, []).get(key)).push(j);
    }
  }
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  // The distance of p from the line through a along unit u.
  const off = (p, a, u) => {
    const ap = sub(p, a), t = dot(ap, u);
    return Math.hypot(ap[0] - t * u[0], ap[1] - t * u[1], ap[2] - t * u[2]);
  };
  const out = [];
  // The stretch a-b covered by segments of the line (each along it, within eps)? Else noted.
  const lined = (a, b, f, g) => {
    const L = Math.hypot(...sub(b, a));
    if (!(L > 10 * eps)) return;
    const u = sub(b, a).map((x) => x / L);
    const seen = new Set(), spans = [];
    const ca = [0, 1, 2].map((c) => cellOf(Math.min(a[c], b[c]) - eps, c)), cb = [0, 1, 2].map((c) => cellOf(Math.max(a[c], b[c]) + eps, c));
    for (let x = ca[0]; x <= cb[0]; x++) for (let y = ca[1]; y <= cb[1]; y++) for (let z = ca[2]; z <= cb[2]; z++) {
      for (const j of grid.get(cellKey(x, y, z)) ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        const p = [S[j], S[j + 1], S[j + 2]], q = [S[j + 3], S[j + 4], S[j + 5]];
        // Along it: within eps, or 1 % of its length (a piece straight across two triangles at an angle, the
        // colours cut in the plane of each).
        const tol = 10 * eps + 0.01 * Math.hypot(...sub(q, p));
        if (off(p, a, u) > tol || off(q, a, u) > tol) continue;
        const s0 = dot(sub(p, a), u), s1 = dot(sub(q, a), u);
        spans.push([Math.min(s0, s1), Math.max(s0, s1)]);
      }
    }
    spans.sort((x, y) => x[0] - y[0]);
    let reach = 0;
    for (const [s0, s1] of spans) {
      if (s0 > reach + eps) break;
      reach = Math.max(reach, s1);
    }
    if (reach < L - eps) out.push({ f, g, from: a, to: b, length: L });
  };
  // The halves along edge a-b of triangle f: [[t0, t1, half]] (t along a-b), from its pieces or whole.
  const along = (f, a, b) => {
    const list = pieces.get(f);
    if (!list) return r.side[f] === SIDE_NONE || !(r.flags[f] & (REACH_UP | REACH_DOWN)) ? [] : [[0, 1, r.side[f]]];
    const L2 = dot(sub(b, a), sub(b, a)), L = Math.sqrt(L2), u = sub(b, a).map((x) => x / L);
    const runs = [];
    for (const { half, poly } of list) {
      if (!half) continue;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if (off(p, a, u) > eps || off(q, a, u) > eps) continue;
        const t0 = dot(sub(p, a), sub(b, a)) / L2, t1 = dot(sub(q, a), sub(b, a)) / L2;
        if (Math.abs(t1 - t0) * L > eps) runs.push([Math.min(t0, t1), Math.max(t0, t1), half]);
      }
    }
    return runs;
  };
  const halfAt = (runs, t) => runs.find(([t0, t1]) => t >= t0 && t <= t1)?.[2];
  const corner = (k) => [P[3 * k], P[3 * k + 1], P[3 * k + 2]];
  for (let f = 0; f < nt; f++) {
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f) continue;
      const a = corner(I[3 * f + e]), b = corner(I[3 * f + ((e + 1) % 3)]);
      const rf = along(f, a, b), rg = along(g, a, b);
      if (!rf.length || !rg.length) continue;
      const ts = [...new Set([0, 1, ...rf.flatMap(([t0, t1]) => [t0, t1]), ...rg.flatMap(([t0, t1]) => [t0, t1])])].filter((t) => t >= 0 && t <= 1).sort((x, y) => x - y);
      for (let i = 0; i + 1 < ts.length; i++) {
        const m = (ts[i] + ts[i + 1]) / 2;
        const hf = halfAt(rf, m), hg = halfAt(rg, m);
        if (hf === undefined || hg === undefined || hf === hg) continue;
        const at = (t) => a.map((x, c) => x + t * (b[c] - x));
        lined(at(ts[i]), at(ts[i + 1]), f, g);
      }
    }
  }
  // Inside a triangle: two of its pieces of different halves along a chord they share.
  for (const [f, list] of pieces) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!list[i].half || !list[j].half || list[i].half === list[j].half) continue;
        const A = list[i].poly, B = list[j].poly;
        for (let k = 0; k < A.length; k++) {
          const p = A[k], q = A[(k + 1) % A.length];
          const L = Math.hypot(...sub(q, p));
          if (!(L > 10 * eps)) continue;
          const u = sub(q, p).map((x) => x / L);
          for (let m = 0; m < B.length; m++) {
            const s = B[m], w = B[(m + 1) % B.length];
            if (off(s, p, u) > eps || off(w, p, u) > eps) continue;
            const s0 = Math.max(0, Math.min(dot(sub(s, p), u), dot(sub(w, p), u))), s1 = Math.min(L, Math.max(dot(sub(s, p), u), dot(sub(w, p), u)));
            if (s1 - s0 > 10 * eps) lined(p.map((x, c) => x + s0 * u[c]), p.map((x, c) => x + s1 * u[c]), f, -1);
          }
        }
      }
    }
  }
  return out;
}
