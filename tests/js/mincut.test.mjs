// The minimum cut of the parting halves (web/engine/mincut.js) against all the
// cuts of small random graphs.
//
//   node --test tests/js/mincut.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { minCut } from '../../web/engine/mincut.js';

/** A small deterministic generator (Park-Miller). */
function random(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * A random graph of n nodes, three arc slots each (as a triangle and its
 * edges), the capacity of an arc and of its sister the same (an edge of the
 * line), some of them infinite, and terminal capacities of both signs, some
 * infinite: {n, first, head, sister, cap, tcap}.
 */
function graph(rnd, n, { infinite = 0 } = {}) {
  const first = Int32Array.from({ length: n + 1 }, (_, i) => 3 * i);
  const head = new Int32Array(3 * n).fill(-1), sister = new Int32Array(3 * n).fill(-1), cap = new Float64Array(3 * n);
  const degree = new Int32Array(n);
  for (let t = 0; t < 2 * n; t++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j || degree[i] >= 3 || degree[j] >= 3) continue;
    let twice = false;
    for (let a = 3 * i; a < 3 * i + degree[i]; a++) if (head[a] === j) twice = true;
    if (twice) continue;
    const a = 3 * i + degree[i]++, b = 3 * j + degree[j]++;
    head[a] = j;
    head[b] = i;
    sister[a] = b;
    sister[b] = a;
    cap[a] = cap[b] = rnd() < infinite ? Infinity : rnd() < 0.2 ? 0 : Math.round(rnd() * 10) / 2;
  }
  const tcap = Float64Array.from({ length: n }, () => {
    if (rnd() < infinite) return rnd() < 0.5 ? Infinity : -Infinity;
    return rnd() < 0.3 ? 0 : Math.round((rnd() * 2 - 1) * 10) / 2;
  });
  return { n, first, head, sister, cap, tcap };
}

/** The energy of the labels S (1: source side): the terminal arcs and the arcs from the source side to the sink side cut. */
function energy({ n, head, cap, tcap }, S) {
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (S[i] && tcap[i] < 0) e -= tcap[i];
    if (!S[i] && tcap[i] > 0) e += tcap[i];
    for (let a = 3 * i; a < 3 * i + 3; a++) if (head[a] >= 0 && S[i] && !S[head[a]]) e += cap[a];
  }
  return e;
}

/** The least energy over all the labels, and the smallest and the largest source sides that reach it. */
function bruteForce(g) {
  let best = Infinity, sets = [];
  for (let m = 0; m < 1 << g.n; m++) {
    const S = Array.from({ length: g.n }, (_, i) => (m >> i) & 1);
    const e = energy(g, S);
    if (e < best - 1e-9) {
      best = e;
      sets = [S];
    } else if (e === best || Math.abs(e - best) <= 1e-9) sets.push(S);
  }
  const smallest = sets.reduce((acc, S) => acc.map((x, i) => x & S[i]));
  const largest = sets.reduce((acc, S) => acc.map((x, i) => x | S[i]));
  return { best, smallest, largest };
}

describe('minimum cut', () => {
  test('the least energy of every random graph, its ties on the side asked: the smallest or the largest source side', () => {
    const rnd = random(12345);
    for (let trial = 0; trial < 600; trial++) {
      const g = graph(rnd, 2 + Math.floor(rnd() * 9), { infinite: trial % 3 === 0 ? 0.1 : 0 });
      const { best, smallest, largest } = bruteForce(g);
      if (best === Infinity) continue; // an infinite source and sink joined by infinite arcs: no finite cut
      for (const free of [0, 1]) {
        const { side, flow } = minCut(g.n, g.first, g.head, Float64Array.from(g.cap), g.sister, Float64Array.from(g.tcap), { free });
        assert.equal(energy(g, side), best, `trial ${trial}, free ${free}: energy`);
        assert.equal(flow, best, `trial ${trial}, free ${free}: flow`);
        assert.deepEqual([...side], free ? largest : smallest, `trial ${trial}, free ${free}: labels`);
      }
    }
  });

  test('the same cut twice: deterministic', () => {
    const g = graph(random(7), 9);
    const run = () => minCut(g.n, g.first, g.head, Float64Array.from(g.cap), g.sister, Float64Array.from(g.tcap)).side;
    assert.deepEqual(run(), run());
  });

  test('a chain: cut at its lightest arc, both ends held by infinite terminal capacities', () => {
    // 0 - 1 - 2 - 3 - 4, the source at 0, the sink at 4; arcs 5, 2, 3, 4: cut between 1 and 2.
    const n = 5;
    const first = Int32Array.from({ length: n + 1 }, (_, i) => 2 * i);
    const head = new Int32Array(2 * n).fill(-1), sister = new Int32Array(2 * n).fill(-1), cap = new Float64Array(2 * n);
    [5, 2, 3, 4].forEach((c, i) => {
      const a = 2 * i + 1, b = 2 * (i + 1);
      head[a] = i + 1;
      head[b] = i;
      sister[a] = b;
      sister[b] = a;
      cap[a] = cap[b] = c;
    });
    const tcap = Float64Array.from([Infinity, 0, 0, 0, -Infinity]);
    const { side, flow } = minCut(n, first, head, cap, sister, tcap);
    assert.deepEqual([...side], [1, 1, 0, 0, 0]);
    assert.equal(flow, 2);
  });
});
