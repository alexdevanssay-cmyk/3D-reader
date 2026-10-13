// Main-thread API of the slides (slides.js): computed in a worker of their
// own (slideworker.js) for the parting definition shown of a body, while the
// model is looked at; never kept with the results of the file (recomputed in
// a few seconds; the edits by hand are kept by the page).
//
// The worker runs one job at a time; the others wait here, in order. A job
// waiting for a body whose definition changed again is replaced by the new
// one; the job running is never stopped for that (its result is dropped by
// the page when its signature is no longer the one shown): the worker keeps
// the body prepared for the next definition. The jobs of a model no longer
// shown are dropped, the one running with its worker (and the memory of its
// body).

let worker = null;
let nextId = 1;
let running = null; // the job in the worker: {id, message, owner, key, resolve, reject, onProgress}
const queue = []; // the jobs waiting, in order

function cancelled() {
  const err = new Error('Slides job cancelled');
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
  worker = new Worker(new URL('./slideworker.js', import.meta.url), { type: 'module' });
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
  worker.onerror = (event) => failAll(new Error(event.message || 'The slides worker could not be started'));
  return worker;
}

/** The next job waiting to the worker, when it is free. */
function next() {
  if (running || !queue.length) return;
  running = queue.shift();
  getWorker().postMessage({ ...running.message, id: running.id });
}

/**
 * The slides of one parting definition of a body (slides.js analyseSlides).
 * body -- {positions, indices, bodyKey ("<file>|<body>|<triangles>": the
 *         worker keeps the last body prepared under it)} (copied, the caller
 *         keeps its arrays)
 * input -- {direction, mask, flags, side, draftDeg, sig} (copied)
 * owner -- what the job is for (a model), to drop it (cancelSlides)
 * key -- the body within its owner: a job of the same owner and key still
 *        waiting is replaced (it rejects with an error whose `cancelled` is true)
 * Resolves to the analysis (its `zone` array transferred).
 */
export function computeSlides(body, input, { owner, key, onProgress } = {}) {
  for (let k = queue.length - 1; k >= 0; k--) {
    if (queue[k].owner === owner && queue[k].key === key) queue.splice(k, 1)[0].reject(cancelled());
  }
  const message = {
    type: 'slides',
    bodyKey: body.bodyKey ?? null,
    positions: body.positions,
    indices: body.indices,
    direction: [...input.direction],
    mask: input.mask,
    flags: input.flags ?? null,
    side: input.side ?? null,
    draftDeg: input.draftDeg ?? 1,
    sig: input.sig ?? null,
  };
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, message, owner, key, resolve, reject, onProgress });
    next();
  });
}

/**
 * Drop the jobs of `owner` (a model no longer shown in any tab): those
 * waiting, and the one running with its worker (a new one serves the next
 * jobs). They reject with an error whose `cancelled` is true.
 */
export function cancelSlides(owner) {
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
