// The bodies an analysis covers: those checked in the list of the 3D page
// (app.js state.included). Every figure shown, exported, pushed to the
// costing, given to the AI or returned to a script is of them, and says so;
// a result per body (the parting line card's body) is one of them. Pure
// helpers of that rule, for app.js and the tests: which bodies, the card's
// body among them, what is missing for them, and the results of each body
// merged as they come (a body checked again is not computed again).

/** The bodies checked, in the order of the file: {indices, count, total, all, none}. */
export function scopeOf(total, included) {
  const indices = [];
  for (let i = 0; i < total; i++) if (included.has(i)) indices.push(i);
  return { indices, count: indices.length, total, all: indices.length === total, none: !indices.length };
}

/**
 * What results say of the bodies they cover: {mode ("all" | "checked" |
 * "none"), bodies (how many), bodies_in_file, indices (into the bodies of the
 * file)}. No names: the bodies of the results have theirs.
 */
export function scopeInfo(bodies, indices) {
  const total = bodies?.length ?? 0;
  return {
    mode: !indices.length ? "none" : indices.length === total ? "all" : "checked",
    bodies: indices.length,
    bodies_in_file: total,
    indices: [...indices],
  };
}

/**
 * The body of a card of results per body (the parting line, the risers):
 * the one selected in the list (its row clicked) when it is checked, else the
 * largest closed body checked (by its volume); -1 when no closed body is
 * checked. Never a body left out of the analysis.
 */
export function cardBody(bodies, indices, selected = -1) {
  if (selected >= 0 && selected < bodies.length && indices.includes(selected)) return selected;
  let best = -1;
  for (const i of indices) {
    if (bodies[i]?.closed && (best < 0 || (bodies[i].volume ?? 0) > (bodies[best].volume ?? 0))) best = i;
  }
  return best;
}

/**
 * The closed bodies of `indices` (open ones have no inside: nothing to
 * compute) without a result in `results` (per body; null: none), nor in any
 * of `busy` (Sets or Maps of bodies: being computed, failed and not to be
 * asked again until Retry).
 */
export function missingBodies(bodies, indices, results, ...busy) {
  return indices.filter((i) => bodies[i]?.closed && !results?.[i] && !busy.some((b) => b?.has(i)));
}

/** Per-body results merged, for `count` bodies: those of `fresh` (null where not computed) over those `kept`. */
export function mergeBodies(kept, fresh, count) {
  return Array.from({ length: count }, (_, i) => fresh?.[i] ?? kept?.[i] ?? null);
}

/**
 * The summary of no body: what the page shows and gives when none is
 * checked, never the figures of bodies left out (a summary of summarize's
 * shape, its quantities null).
 */
export function emptySummary() {
  return {
    volume: null,
    area: null,
    centroid: null,
    bodies: 0,
    solids: 0,
    open_bodies: 0,
    triangles: 0,
    bbox: { min: null, max: null, size: [null, null, null], volume: null },
    obb: null,
    fill_ratio: null,
  };
}
