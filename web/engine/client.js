// Main-thread API of the in-browser engine.
//
// CAD files are sent to a Web Worker that runs OpenCascade (WebAssembly).
// Mesh files are parsed here with the three.js loaders, which need the DOM for
// some formats, then analysed in the worker. The totals and envelopes are
// computed here too, because they use three.js and import maps (needed to
// resolve "three") do not apply inside workers.

import { summarize } from './summary.js';

export const CAD_EXTENSIONS = ['.step', '.stp', '.p21', '.iges', '.igs', '.brep', '.brp'];
export const MESH_EXTENSIONS = ['.stl', '.obj', '.ply', '.off', '.glb', '.gltf', '.3mf', '.dae'];
export const SUPPORTED_EXTENSIONS = [...CAD_EXTENSIONS, ...MESH_EXTENSIONS];

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, onProgress }
const listeners = new Set(); // CAD engine loading listeners (preload)

function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = data.id != null ? pending.get(data.id) : null;
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
      if (data.fatal) resetWorker();
      job?.reject(new Error(data.message));
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

/**
 * Analyse a File in the browser. Resolves to the same structure as the Python
 * server's /api/analyze response (with typed arrays instead of base64 meshes).
 */
export async function analyzeInBrowser(file, { unit = 'auto', quality = 'normal', onProgress } = {}) {
  const start = performance.now();
  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type '${ext}'. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  const bytes = await file.arrayBuffer();

  let kind, sourceUnit, bodies;
  if (CAD_EXTENSIONS.includes(ext)) {
    kind = 'cad';
    ({ bodies, source_unit: sourceUnit = 'mm' } = await call(
      { type: 'analyze', kind, name: file.name, bytes, quality },
      [bytes],
      onProgress,
    ));
  } else {
    kind = 'mesh';
    onProgress?.({ stage: 'parse' });
    const { loadMeshFile } = await import('./meshload.js');
    const { parts, source_unit } = await loadMeshFile(bytes, file.name, { unit });
    sourceUnit = source_unit;
    const transfer = parts.flatMap((p) => [p.positions.buffer, p.indices?.buffer].filter(Boolean));
    ({ bodies } = await call({ type: 'analyze', kind, name: file.name, parts }, transfer, onProgress));
  }

  onProgress?.({ stage: 'summary' });
  return {
    file: file.name,
    kind,
    source_unit: sourceUnit,
    units: { length: 'mm', area: 'mm2', volume: 'mm3' },
    engine: 'browser',
    summary: summarize(bodies),
    bodies,
    elapsed_s: Math.round(performance.now() - start) / 1000,
  };
}
