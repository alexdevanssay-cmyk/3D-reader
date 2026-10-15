// Minimum s-t cut of a graph by maximum flow (Boykov and Kolmogorov, "An
// experimental comparison of min-cut/max-flow algorithms for energy
// minimization in vision", PAMI 2004): two search trees, one from the
// source and one from the sink, grown from the nodes with a terminal
// capacity; where they meet, a path of residual capacity, saturated; the
// nodes cut off their tree by it re-attached when they can be (adoption),
// freed otherwise. Its trees are kept between paths: on the graphs of
// surfaces (a node per triangle, an arc per edge) the paths are short and
// found in about linear time.
//
// It minimises an energy of binary labels with submodular pairwise terms
// exactly: E = sum of the cost of each node's label + sum over the arcs
// between nodes of different labels of their capacity (the parting line,
// parting.js). Deterministic: the nodes and arcs are visited in their
// order, the queues first in first out.
//
// Plain JavaScript without imports: it runs in the parting worker and on
// the page.

const FREE = 0;
const SOURCE = 1;
const SINK = 2;
const TERMINAL = -2; // the parent of a node next to its terminal
const NONE = -1;

/**
 * The minimum cut of a graph of n nodes, given in compressed rows: the arcs
 * of node i are first[i] .. first[i + 1] - 1, arc a to node head[a] (-1: no
 * arc), its residual capacity cap[a] (modified), the arc back sister[a];
 * tcap[i] the terminal capacity of node i, from the source when positive,
 * to the sink when negative (modified: what is left of it). The labels: 1
 * for the nodes on the source side, 0 on the sink side; a node on neither
 * (both sides cost the same) on the side `free` gives (1: the largest set
 * of the source side, 0: the smallest). Returns {side (Uint8Array), flow}.
 */
export function minCut(n, first, head, cap, sister, tcap, { free = 0 } = {}) {
  const tree = new Uint8Array(n);
  const parent = new Int32Array(n).fill(NONE); // the arc from a node to its parent, or TERMINAL
  const stamp = new Int32Array(n); // when its distance to its terminal was last known
  const dist = new Int32Array(n);
  // Active nodes, first in first out (a linked list through next; -1 the end, n + 1 not in it).
  const next = new Int32Array(n).fill(n + 1);
  let qHead = -1, qTail = -1;
  const activate = (i) => {
    if (next[i] !== n + 1) return;
    next[i] = -1;
    if (qTail < 0) qHead = i;
    else next[qTail] = i;
    qTail = i;
  };
  const popActive = () => {
    while (qHead >= 0) {
      const i = qHead;
      qHead = next[i];
      if (qHead < 0) qTail = -1;
      next[i] = n + 1;
      if (tree[i] !== FREE) return i;
    }
    return -1;
  };
  // Orphans, first in first out.
  let orphans = new Int32Array(64), oHead = 0, oTail = 0;
  const pushOrphan = (i) => {
    if (oTail === orphans.length) {
      if (oHead > 0) {
        orphans.copyWithin(0, oHead, oTail);
        oTail -= oHead;
        oHead = 0;
      }
      if (oTail === orphans.length) {
        const grown = new Int32Array(2 * orphans.length);
        grown.set(orphans);
        orphans = grown;
      }
    }
    orphans[oTail++] = i;
    parent[i] = NONE;
  };

  let flow = 0;
  for (let i = 0; i < n; i++) {
    if (tcap[i] > 0) tree[i] = SOURCE;
    else if (tcap[i] < 0) tree[i] = SINK;
    else continue;
    parent[i] = TERMINAL;
    stamp[i] = 0;
    dist[i] = 1;
    activate(i);
  }
  let time = 0;
  let current = -1; // the active node being grown, kept while it can reach the other tree
  for (;;) {
    // Growth: from an active node, the free nodes it reaches join its tree, until a node of the other tree.
    let i = current >= 0 && tree[current] !== FREE ? current : popActive();
    current = -1;
    if (i < 0) break;
    let meet = -1; // the arc from the source tree to the sink tree
    if (tree[i] === SOURCE) {
      for (let a = first[i]; a < first[i + 1]; a++) {
        const j = head[a];
        if (j < 0 || !(cap[a] > 0)) continue;
        if (tree[j] === FREE) {
          tree[j] = SOURCE;
          parent[j] = sister[a];
          stamp[j] = stamp[i];
          dist[j] = dist[i] + 1;
          activate(j);
        } else if (tree[j] === SINK) {
          meet = a;
          break;
        } else if (stamp[j] <= stamp[i] && dist[j] > dist[i]) {
          // A shorter way to the source: its parent now (as the reference implementation does).
          parent[j] = sister[a];
          stamp[j] = stamp[i];
          dist[j] = dist[i] + 1;
        }
      }
    } else {
      for (let a = first[i]; a < first[i + 1]; a++) {
        const j = head[a];
        if (j < 0 || !(cap[sister[a]] > 0)) continue;
        if (tree[j] === FREE) {
          tree[j] = SINK;
          parent[j] = sister[a];
          stamp[j] = stamp[i];
          dist[j] = dist[i] + 1;
          activate(j);
        } else if (tree[j] === SOURCE) {
          meet = sister[a];
          break;
        } else if (stamp[j] <= stamp[i] && dist[j] > dist[i]) {
          parent[j] = sister[a];
          stamp[j] = stamp[i];
          dist[j] = dist[i] + 1;
        }
      }
    }
    time++;
    if (meet < 0) continue;
    current = i; // the path found: grown from it again next
    // Augmentation: the least residual capacity along source -> s -> t -> sink, pushed.
    const s = headOf(meet, first, n, sister, head), t = head[meet];
    let bottleneck = cap[meet];
    for (let k = s; ; ) {
      const a = parent[k];
      if (a === TERMINAL) {
        if (tcap[k] < bottleneck) bottleneck = tcap[k];
        break;
      }
      if (cap[sister[a]] < bottleneck) bottleneck = cap[sister[a]];
      k = head[a];
    }
    for (let k = t; ; ) {
      const a = parent[k];
      if (a === TERMINAL) {
        if (-tcap[k] < bottleneck) bottleneck = -tcap[k];
        break;
      }
      if (cap[a] < bottleneck) bottleneck = cap[a];
      k = head[a];
    }
    cap[sister[meet]] += bottleneck;
    cap[meet] -= bottleneck;
    for (let k = s; ; ) {
      const a = parent[k];
      if (a === TERMINAL) {
        tcap[k] -= bottleneck;
        if (!(tcap[k] > 0)) {
          tcap[k] = 0;
          pushOrphan(k);
        }
        break;
      }
      cap[a] += bottleneck;
      cap[sister[a]] -= bottleneck;
      const up = head[a];
      if (!(cap[sister[a]] > 0)) pushOrphan(k);
      k = up;
    }
    for (let k = t; ; ) {
      const a = parent[k];
      if (a === TERMINAL) {
        tcap[k] += bottleneck;
        if (!(tcap[k] < 0)) {
          tcap[k] = 0;
          pushOrphan(k);
        }
        break;
      }
      cap[sister[a]] += bottleneck;
      cap[a] -= bottleneck;
      const up = head[a];
      if (!(cap[a] > 0)) pushOrphan(k);
      k = up;
    }
    flow += bottleneck;
    // Adoption: each orphan re-attached to a node of its tree that still reaches the terminal, else freed.
    time++;
    while (oHead < oTail) {
      const k = orphans[oHead++];
      const own = tree[k];
      let best = NONE, bestDist = Infinity;
      for (let a = first[k]; a < first[k + 1]; a++) {
        const j = head[a];
        if (j < 0 || tree[j] !== own) continue;
        // The residual capacity towards k's terminal: from j to k in the source tree, from k to j in the sink tree.
        if (!(own === SOURCE ? cap[sister[a]] > 0 : cap[a] > 0)) continue;
        // j's way to the terminal, to its root or a node checked in this pass.
        let d = 0, m = j, ok = false;
        for (;;) {
          if (stamp[m] === time) {
            d += dist[m];
            ok = true;
            break;
          }
          const p = parent[m];
          d++;
          if (p === TERMINAL) {
            stamp[m] = time;
            dist[m] = 1;
            ok = true;
            break;
          }
          if (p === NONE) break;
          m = head[p];
        }
        if (!ok) continue;
        if (d < bestDist) {
          best = a;
          bestDist = d;
        }
        // The distances along that way, known in this pass.
        for (let m2 = j, dd = d; stamp[m2] !== time; m2 = head[parent[m2]]) {
          stamp[m2] = time;
          dist[m2] = dd--;
        }
      }
      if (best !== NONE) {
        parent[k] = best;
        stamp[k] = time;
        dist[k] = bestDist + 1;
        continue;
      }
      // Freed: its children orphans, its neighbours that could take it back active.
      tree[k] = FREE;
      for (let a = first[k]; a < first[k + 1]; a++) {
        const j = head[a];
        if (j < 0 || tree[j] !== own) continue;
        if (own === SOURCE ? cap[sister[a]] > 0 : cap[a] > 0) activate(j);
        const p = parent[j];
        if (p >= 0 && head[p] === k) pushOrphan(j);
      }
    }
    oHead = oTail = 0;
  }
  const side = new Uint8Array(n);
  for (let i = 0; i < n; i++) side[i] = tree[i] === SOURCE ? 1 : tree[i] === SINK ? 0 : free;
  return { side, flow };
}

/** The node an arc leaves (its sister's head). */
function headOf(a, first, n, sister, head) {
  return head[sister[a]];
}
