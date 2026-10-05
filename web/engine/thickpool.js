// Wall thickness on all the cores of the computer: a pool of workers
// (thickworker.js), each with a copy of the meshes, computes ranges of
// triangles; the ranges are merged here (largest value of each triangle, see
// thickness.js: the result does not depend on how the work is shared out).

import { mergeMax, wallOf } from './thickness.js';

// Memory a worker needs per byte of mesh (copy of the mesh, normals, tree of
// the triangles, edges): the number of workers is limited by it.
const BYTES_PER_MESH_BYTE = 8;
const MEMORY_BUDGET = 1.5 * 2 ** 30;
const MIN_RANGE = 2000; // triangles: smaller ranges cost more to send than to compute

let active = null; // the computation in progress, for cancel()
// The workers are kept between computations (starting one costs a few hundred
// ms); they drop their meshes at the end of each computation.
const idle = [];

function newWorker() {
  return new Worker(new URL('./thickworker.js', import.meta.url), { type: 'module' });
}

/** Start the workers ahead of the first computation. */
export function warmThicknessPool() {
  if (typeof Worker !== 'function') return;
  while (idle.length < poolSize(0)) idle.push(newWorker());
}

/** Number of workers: one per core (at most 16), as far as the memory allows. */
export function poolSize(meshBytes) {
  const cores = Math.max(1, Math.min(16, globalThis.navigator?.hardwareConcurrency || 4));
  return Math.max(1, Math.min(cores, Math.floor(MEMORY_BUDGET / Math.max(1, meshBytes * BYTES_PER_MESH_BYTE))));
}

/** Stop the computation in progress (its promise rejects with err.cancelled). */
export function cancelThickness() {
  active?.cancel();
}

/**
 * Wall thickness of bodies, on all the cores.
 * bodies -- per body {positions, indices} (not modified) or null (skipped)
 * Resolves to, per body, {ray, sphere, wall} (Float32Array per triangle) or null.
 */
export function thicknessOnAllCores(bodies, { onProgress } = {}) {
  const list = bodies.map((b, key) => (b && b.indices.length ? { key, ...b, nt: b.indices.length / 3 } : null)).filter(Boolean);
  const results = bodies.map((b) => (b && !b.indices.length ? { ray: new Float32Array(0), sphere: new Float32Array(0), wall: new Float32Array(0) } : null));
  if (!list.length) return Promise.resolve(results);
  const meshBytes = list.reduce((n, b) => n + b.positions.byteLength + b.indices.byteLength, 0);
  const size = poolSize(meshBytes);
  const totalTris = list.reduce((n, b) => n + b.nt, 0);

  // Ranges of triangles, large bodies first so that the workers finish together.
  const perRange = Math.max(MIN_RANGE, Math.ceil(totalTris / (size * 2)));
  const tasks = [];
  for (const b of [...list].sort((x, y) => y.nt - x.nt)) {
    const parts = Math.max(1, Math.round(b.nt / perRange));
    for (let i = 0; i < parts; i++) tasks.push({ body: b, from: Math.floor((b.nt * i) / parts), to: Math.floor((b.nt * (i + 1)) / parts) });
  }
  for (const b of list) {
    b.ray = new Float32Array(b.nt).fill(NaN);
    b.sphere = new Float32Array(b.nt).fill(NaN);
  }

  const workers = [];
  let next = 0;
  let done = 0; // triangles of the finished ranges
  const running = new Map(); // task id -> {task, fraction}
  let lastPercent = -1;
  const report = () => {
    let partial = 0;
    for (const { task, fraction } of running.values()) partial += fraction * (task.to - task.from);
    const percent = Math.floor(((done + partial) / totalTris) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    onProgress?.({ stage: 'analyze', step: 'thickness', percent, workers: workers.length });
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

    const start = (worker) => {
      if (next >= tasks.length) {
        if (!running.size && !finished) {
          finished = true;
          stop(true);
          for (const b of list) results[b.key] = { ray: b.ray, sphere: b.sphere, wall: wallOf(b.ray, b.sphere) };
          resolve(results);
        }
        return;
      }
      const id = next++;
      const task = tasks[id];
      running.set(id, { task, fraction: 0 });
      worker.postMessage({ type: 'range', id, key: task.body.key, from: task.from, to: task.to });
    };
    for (let i = 0; i < Math.min(size, tasks.length); i++) {
      const worker = idle.pop() ?? newWorker();
      workers.push(worker);
      worker.onerror = (e) => fail(new Error(e.message || 'The thickness worker could not be started'));
      worker.onmessage = ({ data }) => {
        const entry = running.get(data.id);
        if (!entry) return;
        if (data.type === 'progress') {
          entry.fraction = data.fraction;
          report();
        } else if (data.type === 'error') {
          fail(new Error(data.message));
        } else if (data.type === 'result') {
          const { task } = entry;
          running.delete(data.id);
          task.body.ray.set(data.ray, task.from);
          mergeMax(task.body.sphere, data.sphere);
          done += task.to - task.from;
          report();
          start(worker);
        }
      };
      // Each worker gets its copy of the meshes (structured clone).
      for (const b of list) worker.postMessage({ type: 'mesh', key: b.key, positions: b.positions, indices: b.indices });
      start(worker);
    }
  });
}
