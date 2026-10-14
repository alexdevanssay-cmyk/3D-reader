// The shape of a parting line from its pieces (segments: xyz of both ends of
// each), shared by the parting tests: loose ends, runs turning back (teeth,
// combs), its loops (length, enclosed area); and the undercut regions of a
// split (their areas).
import { REACH_DOWN, REACH_UP, SHADOW, SIDE_NONE, SILHOUETTE } from '../../web/engine/parting.js';

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
 * The edges between two triangles of different halves (`side`, neither an
 * undercut) that no piece of the line runs along, neither triangle cut by
 * it (by the plane `plane` along d, across it; else flagged SILHOUETTE or
 * SHADOW): the colours of the halves changing with no line there. [] when
 * the line and the halves agree.
 */
export function unlinedEdges({ positions: P, indices: I }, neighbours, { side, flags, segments, plane = null }, d) {
  const key = (a, b) => {
    const k = (i) => `${Math.round(P[3 * i] * 1e4)},${Math.round(P[3 * i + 1] * 1e4)},${Math.round(P[3 * i + 2] * 1e4)}`;
    const [x, y] = [k(a), k(b)];
    return x < y ? `${x} ${y}` : `${y} ${x}`;
  };
  const lined = new Set();
  const at = (j) => `${Math.round(segments[j] * 1e4)},${Math.round(segments[j + 1] * 1e4)},${Math.round(segments[j + 2] * 1e4)}`;
  for (let j = 0; j < segments.length; j += 6) {
    const [x, y] = [at(j), at(j + 3)];
    lined.add(x < y ? `${x} ${y}` : `${y} ${x}`);
  }
  const height = (i) => P[3 * i] * d[0] + P[3 * i + 1] * d[1] + P[3 * i + 2] * d[2] - plane;
  const cut = (f) => {
    if (plane == null) return (flags[f] & (SILHOUETTE | SHADOW)) !== 0;
    const h = [0, 1, 2].map((k) => height(I[3 * f + k]));
    return h.some((x) => x < -1e-6) && h.some((x) => x > 1e-6);
  };
  const out = [];
  for (let f = 0; f < I.length / 3; f++) {
    for (let e = 0; e < 3; e++) {
      const g = neighbours[3 * f + e];
      if (g <= f || side[f] === SIDE_NONE || side[g] === SIDE_NONE || side[f] === side[g] || cut(f) || cut(g)) continue;
      if (!lined.has(key(I[3 * f + e], I[3 * f + ((e + 1) % 3)]))) out.push([f, g]);
    }
  }
  return out;
}
