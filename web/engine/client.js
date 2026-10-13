// Main-thread API of the in-browser engine.
//
// Files are read and analysed in a Web Worker: OpenCascade (WebAssembly) for
// CAD files, plain JavaScript readers for meshes. glTF files are parsed here
// with the three.js loader, and the totals and envelopes are computed here too,
// because both import "three" and import maps (needed to resolve "three") do
// not apply inside workers.

import { summarize } from './summary.js';
import { MESH_EXTENSIONS, needsMainThread } from './meshload.js';
import { cacheKey, loadResult, saveResult } from './cache.js';
import { readShared, sharedState, writeShared } from './shared-cache.js';
import { cancelThickness, thicknessOnAllCores, warmThicknessPool } from './thickpool.js';
import { THICKNESS_VERSION, currentThickness } from './thickness.js';
import { restoreHoles } from './holes.js';

export { warmThicknessPool };

export { MESH_EXTENSIONS };
export const CAD_EXTENSIONS = ['.step', '.stp', '.p21', '.iges', '.igs', '.brep', '.brp'];
export const SUPPORTED_EXTENSIONS = [...CAD_EXTENSIONS, ...MESH_EXTENSIONS];

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, onProgress }
const listeners = new Set(); // CAD engine loading listeners (preload)
const memoryListeners = new Set(); // CAD engine memory reports

/** Called with {heap, heap_max} (bytes) whenever the worker reports its memory. */
export function onMemory(fn) {
  memoryListeners.add(fn);
}

/**
 * Restart the worker to give its WebAssembly heap back to the system (the heap
 * never shrinks). Only when nothing is being analysed; the CAD engine is then
 * reloaded from the browser cache on the next CAD file.
 */
export function releaseMemory() {
  if (pending.size || !worker) return false;
  resetWorker();
  memoryListeners.forEach((fn) => fn({ heap: 0, heap_max: 0, loaded: false, restarted: true }));
  listeners.forEach((fn) => fn({ stage: 'idle' }));
  return true;
}

function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = data.id != null ? pending.get(data.id) : null;
    if (data.memory) memoryListeners.forEach((fn) => fn(data.memory));
    if (data.type === 'progress') {
      job?.onProgress?.(data);
      if (data.stage !== 'analyze') listeners.forEach((fn) => fn(data));
    } else if (data.type === 'ready') {
      listeners.forEach((fn) => fn({ stage: 'ready' }));
    } else if (data.type === 'result') {
      pending.delete(data.id);
      job?.resolve(data.result);
    } else if (data.type === 'error') {
      if (data.id == null) {
        listeners.forEach((fn) => fn({ stage: 'error', message: data.message }));
        return;
      }
      pending.delete(data.id);
      job?.reject(new Error(data.message));
      if (data.fatal) {
        // The restarted worker has lost the jobs queued behind this one (their
        // files were transferred to it), so they fail too.
        for (const other of pending.values()) other.reject(new Error('The analysis engine was restarted: open the file again'));
        pending.clear();
        resetWorker();
      }
    }
  };
  worker.onerror = (event) => {
    // The worker script itself failed (e.g. a module could not be loaded).
    const err = new Error(event.message || 'The analysis engine could not be started');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    listeners.forEach((fn) => fn({ stage: 'error', message: err.message }));
    resetWorker();
  };
  return worker;
}

function resetWorker() {
  worker?.terminate();
  worker = null;
  memoryListeners.forEach((fn) => fn({ heap: 0, heap_max: 0, loaded: false }));
}

/** Stop the analyses in progress (the worker is restarted for the next file). */
export function cancelAll() {
  cancelThickness();
  for (const read of networkReads) read.abort();
  if (!pending.size) return;
  const err = new Error('Cancelled');
  err.cancelled = true;
  for (const job of pending.values()) job.reject(err);
  pending.clear();
  resetWorker();
  listeners.forEach((fn) => fn({ stage: 'idle' }));
}

function call(message, transfer, onProgress) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...message, id }, transfer);
  });
}

/** Start downloading and compiling OpenCascade in the background. */
export function preloadCadEngine(listener) {
  if (listener) listeners.add(listener);
  getWorker().postMessage({ type: 'preload', id: null });
}

// Memory an analysis needs, measured on test files: the CAD engine starts with
// a ~100 MiB WebAssembly heap and adds about 3 bytes per byte of STEP/IGES file
// (a 35 MB STEP of 2000 solids: 207 MiB); meshes are analysed in double
// precision with welding tables (about 12 bytes per byte of file). The factors
// are rounded up: this is a warning, not a limit.
const CAD_BASE_HEAP = 110 * 2 ** 20;
const BYTES_PER_FILE_BYTE = { cad: 4, mesh: 12 };

/** Rough memory (bytes) the analysis of `file` will use, and of which kind. */
export function estimateMemory(file, currentHeap = 0) {
  const kind = CAD_EXTENSIONS.includes(extensionOf(file.name)) ? 'cad' : 'mesh';
  const base = kind === 'cad' ? Math.max(currentHeap, CAD_BASE_HEAP) : 0;
  return { kind, bytes: base + file.size * BYTES_PER_FILE_BYTE[kind] };
}

/**
 * Analyse a File in the browser. Resolves to the same structure as the Python
 * server's /api/analyze response (with typed arrays instead of base64 meshes).
 */
export async function analyzeInBrowser(file, { unit = 'auto', quality = 'normal', onProgress, cache = true, close = false } = {}) {
  const start = performance.now();
  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type '${ext}'. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  const bytes = await file.arrayBuffer();

  // Results kept from an earlier opening of the same content (cache = false:
  // computed again, and the kept results replaced).
  const isCad = CAD_EXTENSIONS.includes(ext);
  const key = await cacheKey(bytes, isCad ? { ext, quality } : { ext, unit }).catch(() => null);
  let networkNote = null;
  if (cache && key && !close) {
    const kept = await loadResult(key);
    if (kept?.data) {
      // A thickness kept by another version of its computation (or of none): computed again.
      const thickness = currentThickness(kept.thickness) ? kept.thickness : null;
      await withHoles(key, kept.data, kept.holes, onProgress);
      // Kept before the shared folder was chosen, or when it could not be reached: written there now.
      const state = await sharedState().catch(() => 'none');
      if (state === 'granted') share(key, { data: kept.data, thickness, replace: false });
      return {
        ...kept.data, file: file.name, cacheKey: key, cached: true, cachedThickness: thickness, cachedParting: kept.parting ?? null, cachedFeeding: kept.feeding ?? null, elapsed_s: Math.round(performance.now() - start) / 1000,
        networkNote: noteOf({ state }),
      };
    }
    // Analysed on another PC: read from the shared network folder (within time limits), else analysed here.
    const shared = await readFromNetwork(key, onProgress);
    if (shared.state === 'read') {
      keep(key, shared, file.name);
      await withHoles(key, shared.data, null, onProgress);
      return { ...shared.data, file: file.name, cacheKey: key, cached: true, cachedFrom: 'network', cachedThickness: shared.thickness, elapsed_s: Math.round(performance.now() - start) / 1000 };
    }
    networkNote = noteOf(shared);
  }

  let kind, sourceUnit, bodies;
  if (CAD_EXTENSIONS.includes(ext)) {
    kind = 'cad';
    ({ bodies, source_unit: sourceUnit = 'mm' } = await call(
      { type: 'analyze', kind, name: file.name, bytes, quality, close },
      [bytes],
      onProgress,
    ));
  } else if (!needsMainThread(file.name)) {
    kind = 'mesh';
    ({ bodies, source_unit: sourceUnit } = await call(
      { type: 'analyze', kind: 'meshfile', name: file.name, bytes, unit },
      [bytes],
      onProgress,
    ));
  } else {
    kind = 'mesh';
    onProgress?.({ stage: 'analyze', percent: 5, step: 'read' });
    const { loadMeshFile } = await import('./meshload.js');
    const { parts, source_unit } = await loadMeshFile(bytes, file.name, { unit });
    sourceUnit = source_unit;
    const transfer = [...new Set(parts.flatMap((p) => [p.positions.buffer, p.indices?.buffer].filter(Boolean)))];
    ({ bodies } = await call({ type: 'analyze', kind, name: file.name, parts }, transfer, onProgress));
  }

  onProgress?.({ stage: 'analyze', percent: 96, step: 'summary' });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the page show it before the envelope search
  const data = {
    file: file.name,
    kind,
    source_unit: sourceUnit,
    units: { length: 'mm', area: 'mm2', volume: 'mm3' },
    engine: 'browser',
    summary: summarize(bodies),
    bodies,
    elapsed_s: Math.round(performance.now() - start) / 1000,
  };
  // Kept for the next opening of the same file (in the background), and on the shared network folder for the other PCs.
  keeping(key, saveResult(key, { data }, { file: file.name }).then((kept) => {
    if (kept) share(key, { data });
    return kept;
  }));
  return { ...data, cacheKey: key, cached: false, cachedThickness: null, cachedParting: null, cachedFeeding: null, networkNote };
}

/**
 * Keep the wall thickness of a model with its results (see analyzeInBrowser),
 * and on the shared network folder with them (`bodies`: those of the model,
 * whose meshes the thickness is of); each body with THICKNESS_VERSION.
 */
export async function saveThickness(key, results, bodies = null) {
  await saving.get(key);
  const versioned = results.map((t) => (t ? { ...t, version: THICKNESS_VERSION } : null));
  const kept = await saveResult(key, { thickness: versioned });
  if (kept && bodies) share(key, { thickness: versioned, bodies });
  return kept;
}

/**
 * The holes of results kept by a version that did not measure them (see
 * holes.js restoreHoles): those measured since, else measured now in the
 * engine worker (a mesh ray cast, no OpenCascade) and kept with the results.
 * Not measured (left provisional) when the worker fails, or is busy with
 * another analysis (another tab's, which may take minutes: not waited for,
 * measured at a later opening); stopped by cancelAll.
 */
async function withHoles(key, data, kept, onProgress) {
  let records;
  try {
    records = await restoreHoles(data.bodies, kept, (bodies) => {
      if (pending.size) return null;
      onProgress?.({ stage: 'analyze', percent: 97, step: 'holes' });
      return call({ type: 'holes', bodies });
    });
  } catch (err) {
    if (err.cancelled) throw err;
    console.warn('Holes not measured', err);
    return;
  }
  // Added to the results kept, once they are (read from the shared folder: being written).
  if (records) (saving.get(key) ?? Promise.resolve()).catch(() => {}).then(() => saveResult(key, { holes: records }));
}

// ------------------------------------------------------------------ the shared network folder

const saving = new Map(); // key -> the analysis being kept in this browser (the thickness waits for it)
const networkReads = new Set(); // the reads in progress (AbortController), stopped by cancelAll
const sharedListeners = new Set();

/** The analysis of `key` being kept in this browser (`job`): what is kept next of it waits for it. */
function keeping(key, job) {
  saving.set(key, job);
  job.finally(() => saving.get(key) === job && saving.delete(key)).catch(() => {});
}

/** Called with {key, note} when a write in the shared folder failed, to be said discreetly (the results of `key` are shown by then). */
export function onShared(fn) {
  sharedListeners.add(fn);
}

/** What to say of a read or a write of the shared folder (shared-cache.js state), or null. */
function noteOf(result) {
  if (result.state === 'prompt') return { kind: 'prompt' };
  if (result.state === 'error') return { kind: 'error', message: result.error };
  return null;
}

/** The results of `key` from the shared folder (readShared), stopped by cancelAll (rejects with err.cancelled). */
async function readFromNetwork(key, onProgress) {
  const controller = new AbortController();
  networkReads.add(controller);
  try {
    const result = await readShared(key, { signal: controller.signal, onProgress });
    // Stopped while the folder or the file was looked for (a network slow to
    // answer): not analysed after it either, the next file would wait behind it.
    if (controller.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    return result;
  } finally {
    networkReads.delete(controller);
  }
}

/** Results read from the shared folder, kept in this browser too (the analysis, then its thickness). */
function keep(key, shared, name) {
  keeping(key, saveResult(key, { data: shared.data }, { file: name }).then(async (kept) => {
    if (kept && shared.thickness) await saveResult(key, { thickness: shared.thickness });
    return kept;
  }));
}

/** Write in the shared folder in the background (writeShared); a failure is said to the page (onShared), never thrown. */
function share(key, what) {
  writeShared(key, what).then(
    (result) => {
      if (result.state === 'error') sharedListeners.forEach((fn) => fn({ key, note: { kind: 'error', message: result.error, write: true } }));
    },
    () => {},
  );
}

export { clearCache, cacheInfo } from './cache.js';

/**
 * Wall thickness of bodies, on all the cores (see thickpool.js).
 *
 * bodies -- per body {positions, indices} (copied, the caller keeps its arrays)
 *           or null to skip it (open bodies: no inside, no thickness)
 * Resolves to, per body, {ray, sphere, wall} (Float32Array per triangle, mm) or null.
 */
export function computeThickness(bodies, { onProgress } = {}) {
  return thicknessOnAllCores(bodies, { onProgress });
}
