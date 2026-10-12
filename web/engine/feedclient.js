// Main-thread API of the feeding zones (risers and gating): computed in a
// worker of their own (feedworker.js), after the analysis, while the model is
// looked at; kept with the results of the file in this browser (cache.js),
// like the parting line. The risers and the ingate are placed on the page
// (feeding.js placeFeeding), for the parting line shown.

import { saveResult } from './cache.js';

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, onProgress}

function failAll(err) {
  for (const job of pending.values()) job.reject(err);
  pending.clear();
  worker?.terminate();
  worker = null;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./feedworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.type === 'progress') job.onProgress?.(data);
    else {
      pending.delete(data.id);
      if (data.type === 'result') job.resolve(data.result);
      else job.reject(new Error(data.message));
    }
  };
  worker.onerror = (event) => failAll(new Error(event.message || 'The feeding worker could not be started'));
  return worker;
}

/**
 * Feeding zones of bodies.
 * bodies -- per body {positions, indices, sphere (inscribed diameters per
 *           triangle, from the wall thickness, or null: computed)} (copied,
 *           the caller keeps its arrays) or null to skip it (open bodies)
 * Resolves to {version, bodies: per body {zones, body, sphere_source,
 * sampled, neck_ratio, version, zone, sphere} or null}.
 */
export function computeFeeding(bodies, { onProgress } = {}) {
  const list = bodies.map((b) => (b ? { positions: b.positions, indices: b.indices, sphere: b.sphere ?? null } : null));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ type: 'zones', bodies: list, id });
  });
}

/** Keep the feeding zones of a model with its results (see client.js analyzeInBrowser). */
export function saveFeeding(key, results) {
  return saveResult(key, { feeding: results });
}
