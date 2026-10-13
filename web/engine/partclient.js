// Main-thread API of the parting line: computed in a worker of its own
// (partworker.js), after the analysis, while the model is looked at; kept
// with the results of the file in this browser (cache.js), like the wall
// thickness.
//
// The worker runs one job at a time; the others wait here, in order, so
// that the jobs of a model no longer shown (its tab closed, another file
// opened in it) can be dropped: those waiting, and the one running (its
// worker stopped, a new one for the next jobs).
//
// Each job carries the casting process ({plan, alimentation}) and the die
// options ({marges, densite, cavities}; orientation.js): the proposals are
// ranked with the die options and oriented for the process, and kept with
// their key (orientationKey): proposals of another process or other die
// options are not taken from the cache.

import { saveResult } from './cache.js';
import { orientationKey } from './orientation.js';
import { PARTING_VERSION } from './parting.js';

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

/** An up direction as the worker takes it: a side ("+u"…), a plain array, or null. */
const upOf = (up) => (up == null ? null : typeof up === 'string' ? up : [...up]);

/**
 * Draw direction and parting line proposed for bodies.
 * bodies  -- per body {positions, indices, thickness (inscribed diameter per
 *            triangle, or none: the feeding score from the volume centroid)}
 *            (copied, the caller keeps its arrays) or null to skip it (open bodies)
 * owner   -- what the job is for (a model), to drop it (cancelParting)
 * process -- {plan: "vertical" | "horizontal", alimentation: "haut" | "bas"} (default: gravity, vertical, top)
 * die     -- {marges, densite, cavities} (default: those of the costing)
 * Resolves to {version, options_key, bodies: per body {proposal, side, flags, plane, segments} or null}.
 */
export function computeParting(bodies, { onProgress, owner, process = null, die = null } = {}) {
  const list = bodies.map((b) => (b ? { positions: b.positions, indices: b.indices, thickness: b.thickness ?? null } : null));
  return call({ type: 'propose', bodies: list, process, die }, { onProgress, owner });
}

/**
 * One direction of a body (chosen by hand): {summary (with its orientation),
 * side, flags, plane, segments}.
 * up     -- the up direction wanted (a vector, or "+u", "-v", "+d"…), else by the feeding
 * orient -- a horizontal parting plane whose up is -d: classified along -d (see parting.js evaluateParting)
 */
export function evaluateDirection({ positions, indices, thickness = null }, direction, { owner, process = null, die = null, up = null, orient = false } = {}) {
  return call({ type: 'evaluate', positions, indices, thickness, direction: [...direction], process, die, up: upOf(up), orient }, { owner });
}

/**
 * The orientation alone of a direction of a body (a line drawn by hand: its
 * plane's normal, as drawn; the feeding score again with the thickness):
 * {orientation (orientation.js), options_key}.
 */
export function orientDirection({ positions, indices, thickness = null }, direction, { owner, process = null, die = null, up = null } = {}) {
  return call({ type: 'orient', positions, indices, thickness, direction: [...direction], process, die, up: upOf(up) }, { owner });
}

/**
 * The proposals kept with the results of a file (cache.js: {version,
 * options_key, bodies}) when they are of this engine, for `count` bodies, for
 * this process and these die options; else null (to compute them again).
 */
export function keptParting(kept, count, { process = null, die = null } = {}) {
  if (kept?.version !== PARTING_VERSION || kept.bodies?.length !== count) return null;
  return kept.options_key === orientationKey(process, die) ? kept.bodies : null;
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
