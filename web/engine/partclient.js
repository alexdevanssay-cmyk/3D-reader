// Main-thread API of the parting line: computed in a worker of its own
// (partworker.js), after the analysis, while the model is looked at; kept
// with the results of the file in this browser (cache.js), like the wall
// thickness.

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
  worker = new Worker(new URL('./partworker.js', import.meta.url), { type: 'module' });
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
  worker.onerror = (event) => failAll(new Error(event.message || 'The parting worker could not be started'));
  return worker;
}

function call(message, onProgress) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...message, id });
  });
}

/**
 * Draw direction and parting line proposed for bodies.
 * bodies -- per body {positions, indices} (copied, the caller keeps its
 *           arrays) or null to skip it (open bodies)
 * Resolves to {version, bodies: per body {proposal, side, flags, plane, segments} or null}.
 */
export function computeParting(bodies, { onProgress } = {}) {
  const list = bodies.map((b) => (b ? { positions: b.positions, indices: b.indices } : null));
  return call({ type: 'propose', bodies: list }, onProgress);
}

/** One direction of a body (chosen by hand): {summary, side, flags, plane, segments}. */
export function evaluateDirection({ positions, indices }, direction) {
  return call({ type: 'evaluate', positions, indices, direction: [...direction] });
}

/** Keep the parting proposals of a model with its results (see client.js analyzeInBrowser). */
export function saveParting(key, results) {
  return saveResult(key, { parting: results });
}
