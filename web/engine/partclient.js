// Main-thread API of the parting line: computed in a worker of its own
// (partworker.js), after the analysis, while the model is looked at; kept
// with the results of the file in this browser (cache.js), like the wall
// thickness.
//
// The worker runs one job at a time; the others wait here, in order, so
// that the jobs of a model no longer shown (its tab closed, another file
// opened in it) can be dropped: those waiting, and the one running (its
// worker stopped, a new one for the next jobs).

import { saveResult } from './cache.js';

let worker = null;
let nextId = 1;
let running = null; // the job in the worker: {id, message, owner, resolve, reject, onProgress}
const queue = []; // the jobs waiting, in order

function cancelled() {
  const err = new Error('Parting job cancelled');
  err.cancelled = true;
  return err;
}

function failAll(err) {
  const jobs = running ? [running, ...queue] : [...queue];
  running = null;
  queue.length = 0;
  worker?.terminate();
  worker = null;
  for (const job of jobs) job.reject(err);
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./partworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = running;
    if (!job || data.id !== job.id) return;
    if (data.type === 'progress') {
      job.onProgress?.(data);
      return;
    }
    running = null;
    if (data.type === 'result') job.resolve(data.result);
    else job.reject(new Error(data.message));
    next();
  };
  worker.onerror = (event) => failAll(new Error(event.message || 'The parting worker could not be started'));
  return worker;
}

/** The next job waiting to the worker, when it is free. */
function next() {
  if (running || !queue.length) return;
  running = queue.shift();
  getWorker().postMessage({ ...running.message, id: running.id });
}

function call(message, { onProgress, owner } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, message, owner, resolve, reject, onProgress });
    next();
  });
}

/**
 * Draw direction and parting line proposed for bodies.
 * bodies -- per body {positions, indices} (copied, the caller keeps its
 *           arrays) or null to skip it (open bodies)
 * owner  -- what the job is for (a model), to drop it (cancelParting)
 * Resolves to {version, bodies: per body {proposal, side, flags, plane, segments} or null}.
 */
export function computeParting(bodies, { onProgress, owner } = {}) {
  const list = bodies.map((b) => (b ? { positions: b.positions, indices: b.indices } : null));
  return call({ type: 'propose', bodies: list }, { onProgress, owner });
}

/** One direction of a body (chosen by hand): {summary, side, flags, plane, segments}. */
export function evaluateDirection({ positions, indices }, direction, { owner } = {}) {
  return call({ type: 'evaluate', positions, indices, direction: [...direction] }, { owner });
}

/**
 * Drop the jobs of `owner` (a model no longer shown in any tab), waiting or
 * running: they reject with an error whose `cancelled` is true.
 */
export function cancelParting(owner) {
  if (owner == null) return;
  const dropped = [];
  for (let k = queue.length - 1; k >= 0; k--) if (queue[k].owner === owner) dropped.push(...queue.splice(k, 1));
  if (running?.owner === owner) {
    dropped.push(running);
    running = null;
    worker?.terminate();
    worker = null;
  }
  for (const job of dropped) job.reject(cancelled());
  next();
}

/** Keep the parting proposals of a model with its results (see client.js analyzeInBrowser). */
export function saveParting(key, results) {
  return saveResult(key, { parting: results });
}
