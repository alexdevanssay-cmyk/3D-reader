// Main-thread API of the feeding zones (risers and gating): computed in a
// worker of their own (feedworker.js), after the analysis, while the model is
// looked at; kept with the results of the file in this browser (cache.js),
// like the parting line. The risers and the ingate are placed (feeding.js
// placeFeeding) for the parting line shown in a second worker of the same
// script: seconds on a large body, never on the page, nor behind the zones
// of another model.

import { saveResult } from './cache.js';

let nextId = 1;
const workers = { zones: null, place: null };
const pending = new Map(); // id -> {resolve, reject, onProgress, kind}

function failAll(kind, err) {
  for (const [id, job] of pending) {
    if (job.kind !== kind) continue;
    pending.delete(id);
    job.reject(err);
  }
  workers[kind]?.terminate();
  workers[kind] = null;
}

function getWorker(kind) {
  if (workers[kind]) return workers[kind];
  const worker = new Worker(new URL('./feedworker.js', import.meta.url), { type: 'module' });
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
  worker.onerror = (event) => failAll(kind, new Error(event.message || 'The feeding worker could not be started'));
  workers[kind] = worker;
  return worker;
}

function call(kind, message, onProgress = null) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, kind });
    getWorker(kind).postMessage({ ...message, id });
  });
}

/**
 * Feeding zones of bodies.
 * bodies -- per body {positions, indices, sphere (inscribed diameters per
 *           triangle, from the wall thickness, or null: computed)} (copied,
 *           the caller keeps its arrays) or null to skip it (open bodies)
 * Resolves to {version, bodies: per body {zones, body, sphere_source,
 * sampled, neck_ratio, version, zone, sphere}, {error} (that body alone: its
 * zones not found) or null}.
 */
export function computeFeeding(bodies, { onProgress } = {}) {
  const list = bodies.map((b) => (b ? { positions: b.positions, indices: b.indices, sphere: b.sphere ?? null } : null));
  return call('zones', { type: 'zones', bodies: list }, onProgress);
}

/**
 * Risers and ingate of bodies for their parting lines (feeding.js
 * placeFeeding), in one go.
 * bodies -- per body {positions, indices, zones ({zone, sphere, zones, body}
 *           of feedingZones), parting ({direction, side, segments} or null),
 *           up (the direction up when cast: the orientation of the parting,
 *           orientation.js; else the draw direction), process ({plan,
 *           alimentation}: "bas", fed from below, low pressure)} (copied, the
 *           caller keeps its arrays)
 * Resolves to their placements, in the same order; each says the up and the
 * process it was placed for (feedingOptionsKey: what a placement kept by the
 * page is keyed by, beside its parting).
 */
export function placeFeedings(bodies) {
  return call('place', { type: 'place', bodies });
}

/** Keep the feeding zones of a model with its results (see client.js analyzeInBrowser). */
export function saveFeeding(key, results) {
  return saveResult(key, { feeding: results });
}
