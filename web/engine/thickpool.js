// Wall thickness on all the cores of the computer: a pool of workers
// (thickworker.js) computes ranges of triangles; the result does not depend on
// how the work is shared out (largest value of each triangle, see
// thickness.js).
//
// When the page is cross-origin isolated (see coi-sw.js), the meshes are
// prepared once in SharedArrayBuffers and read by all the workers, which
// write into shared result arrays: one worker per logical processor, whatever
// the size of the model. Otherwise each worker gets its own copy of the
// meshes, and their number is limited by the memory.

import { mergeMax, wallOf } from './thickness.js';

// Memory a worker needs per byte of mesh when it has its own copy (the copy,
// normals, tree of the triangles, neighbours, balls of a range).
const BYTES_PER_MESH_BYTE = 12;
const MEMORY_BUDGET = 1.5 * 2 ** 30;
const MAX_WORKERS = 16;
const MIN_RANGE = 2000; // triangles: smaller ranges cost more to hand out than to compute
const RANGES_PER_WORKER = 4; // small ranges: the workers finish together

let active = null; // the computation in progress, for cancel()
// The workers are kept between computations (starting one costs a few hundred
// ms); they drop their meshes at the end of each computation.
const idle = [];

const cores = () => Math.max(1, Math.min(MAX_WORKERS, globalThis.navigator?.hardwareConcurrency || 4));
/** True when the workers can share memory (page cross-origin isolated). */
export const canShare = () => globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';

function newWorker() {
  return new Worker(new URL('./thickworker.js', import.meta.url), { type: 'module' });
}

/** Start the workers ahead of the first computation. */
export function warmThicknessPool() {
  if (typeof Worker !== 'function') return;
  while (idle.length < cores()) idle.push(newWorker());
}

/** Number of workers: one per logical processor (at most 16), within the memory without sharing. */
export function poolSize(meshBytes) {
  if (canShare()) return cores();
  return Math.max(1, Math.min(cores(), Math.floor(MEMORY_BUDGET / Math.max(1, meshBytes * BYTES_PER_MESH_BYTE))));
}

/** Stop the computation in progress (its promise rejects with err.cancelled). */
export function cancelThickness() {
  active?.cancel();
}

/** A copy of a typed array in a SharedArrayBuffer. */
function sharedCopy(array) {
  const out = new array.constructor(new SharedArrayBuffer(array.byteLength));
  out.set(array);
  return out;
}

/**
 * Wall thickness of bodies, on all the cores.
 * bodies -- per body {positions, indices} (not modified) or null (skipped)
 * onProgress -- {stage, step, percent, workers}
 * Resolves to, per body, {ray, sphere, wall} (Float32Array per triangle) or null.
 */
export function thicknessOnAllCores(bodies, { onProgress } = {}) {
  const list = bodies.map((b, key) => (b && b.indices.length ? { key, ...b, nt: b.indices.length / 3 } : null)).filter(Boolean);
  const results = bodies.map((b) => (b && !b.indices.length ? { ray: new Float32Array(0), sphere: new Float32Array(0), wall: new Float32Array(0) } : null));
  if (!list.length) return Promise.resolve(results);
  const shared = canShare();
  const meshBytes = list.reduce((n, b) => n + b.positions.byteLength + b.indices.byteLength, 0);
  const size = poolSize(meshBytes);
  const totalTris = list.reduce((n, b) => n + b.nt, 0);

  // Ranges of triangles, large bodies first so that the workers finish together.
  const perRange = Math.max(MIN_RANGE, Math.ceil(totalTris / (size * RANGES_PER_WORKER)));
  for (const b of list) {
    b.ranges = [];
    const parts = Math.max(1, Math.round(b.nt / perRange));
    for (let i = 0; i < parts; i++) b.ranges.push({ body: b, from: Math.floor((b.nt * i) / parts), to: Math.floor((b.nt * (i + 1)) / parts) });
    if (shared) {
      // Results written by the workers: the ray by the owner of the range, the
      // sphere as the largest value (0: none yet).
      const ray = new Float32Array(new SharedArrayBuffer(4 * b.nt)).fill(NaN);
      const sphereBuffer = new SharedArrayBuffer(4 * b.nt);
      b.shared = { prepared: null, ray, sphere: new Float32Array(sphereBuffer), sphereBits: new Int32Array(sphereBuffer) };
    } else {
      b.ray = new Float32Array(b.nt).fill(NaN);
      b.sphere = new Float32Array(b.nt).fill(NaN);
    }
  }
  const sorted = [...list].sort((x, y) => y.nt - x.nt);
  // Shared mode: each body is first prepared (by one worker); its ranges follow.
  const queue = shared ? sorted.map((b) => ({ prepare: b })) : sorted.flatMap((b) => b.ranges);
  // Work of a task, in triangles: preparing a mesh is about a tenth of computing it.
  const weight = (task) => (task.prepare ? task.prepare.nt * 0.1 : task.to - task.from);
  const totalWork = list.reduce((n, b) => n + b.nt * (shared ? 1.1 : 1), 0);

  const workers = [];
  let nextId = 0;
  let done = 0; // work of the finished tasks
  const running = new Map(); // task id -> {task, fraction}
  let lastPercent = -1;
  const report = () => {
    let partial = 0;
    for (const { task, fraction } of running.values()) partial += fraction * weight(task);
    const percent = Math.min(100, Math.floor(((done + partial) / totalWork) * 100));
    if (percent === lastPercent) return;
    lastPercent = percent;
    onProgress?.({ stage: 'analyze', step: 'thickness', percent, workers: workers.length, shared });
  };

  return new Promise((resolve, reject) => {
    // Done: the workers go back to the pool without their meshes. Failed or
    // cancelled: they are stopped (they may be in the middle of a range).
    const stop = (keep) => {
      for (const w of workers) {
        w.onmessage = w.onerror = null;
        if (keep) {
          w.postMessage({ type: 'clear' });
          idle.push(w);
        } else w.terminate();
      }
      workers.length = 0;
      if (active === pool) active = null;
    };
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      stop(false);
      reject(err);
    };
    const pool = {
      cancel() {
        const err = new Error('Cancelled');
        err.cancelled = true;
        fail(err);
      },
    };
    active?.cancel();
    active = pool;

    const finish = () => {
      finished = true;
      stop(true);
      for (const b of list) {
        if (shared) {
          // 0 in the shared sphere array: no ball reached the triangle.
          const sphere = Float32Array.from(b.shared.sphere, (v) => (v > 0 ? v : NaN));
          const ray = Float32Array.from(b.shared.ray);
          results[b.key] = { ray, sphere, wall: wallOf(ray, sphere) };
        } else {
          results[b.key] = { ray: b.ray, sphere: b.sphere, wall: wallOf(b.ray, b.sphere) };
        }
      }
      resolve(results);
    };

    const start = (worker) => {
      const task = queue.shift();
      if (!task) {
        if (!running.size && !finished) finish();
        return;
      }
      const id = nextId++;
      running.set(id, { task, fraction: 0, worker });
      if (task.prepare) {
        const b = task.prepare;
        worker.postMessage({ type: 'prepare', id, key: b.key, positions: sharedCopy(b.positions), indices: sharedCopy(b.indices) });
      } else {
        const b = task.body;
        worker.postMessage({ type: 'range', id, key: b.key, from: task.from, to: task.to, shared: shared ? b.shared : null });
      }
    };
    const idleWorkers = [];
    const onResult = (worker, data) => {
      const entry = running.get(data.id);
      if (!entry) return;
      const { task } = entry;
      running.delete(data.id);
      done += weight(task);
      if (task.prepare) {
        // Prepared: its ranges are handed out first (to this worker and the idle ones).
        task.prepare.shared.prepared = data.prepared;
        queue.unshift(...task.prepare.ranges);
        while (idleWorkers.length && queue.length) start(idleWorkers.pop());
      } else if (!shared) {
        task.body.ray.set(data.ray, task.from);
        mergeMax(task.body.sphere, data.sphere);
      }
      report();
      if (!queue.length && running.size) idleWorkers.push(worker);
      else start(worker);
    };

    for (let i = 0; i < size; i++) {
      const worker = idle.pop() ?? newWorker();
      workers.push(worker);
      worker.onerror = (e) => fail(new Error(e.message || 'The thickness worker could not be started'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          const entry = running.get(data.id);
          if (entry) entry.fraction = data.fraction;
          report();
        } else if (data.type === 'error') fail(new Error(data.message));
        else if (data.type === 'result') onResult(worker, data);
      };
      // Without sharing, each worker gets its copy of the meshes (structured clone).
      if (!shared) for (const b of list) worker.postMessage({ type: 'mesh', key: b.key, positions: b.positions, indices: b.indices });
    }
    for (const worker of workers) {
      if (queue.length) start(worker);
      else idleWorkers.push(worker);
    }
    if (!running.size) finish();
  });
}
