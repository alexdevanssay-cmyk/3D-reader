// Module Web Worker running the heavy computations off the UI thread.
//
// Import maps do not apply inside workers, so only modules without static bare
// imports (no "three") may be imported here: the OpenCascade engine and the
// mesh readers/analysis are plain JavaScript. glTF parsing (three.js loader) and
// the envelope computation happen on the main thread (see client.js).

import { loadOcct } from './occt.js';
import { analyzeCad } from './cad.js';
import { loadMeshFile } from './meshload.js';
import { analyzeMeshParts } from './meshanalysis.js';

// Root of the site (…/web/ or …/3D-reader/), where vendor/ lives.
const baseUrl = new URL('../', import.meta.url).href;

let occtPromise = null;
let occtModule = null; // once loaded: its WebAssembly heap is reported with every message

// Memory of the CAD engine: the WebAssembly heap only grows (up to 4 GiB) and is
// never given back, so the page can restart the worker when it gets large.
const HEAP_MAX = 4294901760;
const heapSize = () => occtModule?.HEAPU8?.length ?? occtModule?.wasmMemory?.buffer?.byteLength ?? 0;
const memory = () => ({ heap: heapSize(), heap_max: HEAP_MAX, loaded: occtModule !== null });
let progressTarget = null; // id of the request that currently wants loading progress

function occt() {
  if (!occtPromise) {
    occtPromise = loadOcct({
      baseUrl,
      onProgress: (p) => postMessage({ type: 'progress', id: progressTarget, ...p }),
    })
      .then((oc) => (occtModule = oc))
      .catch((err) => {
      occtPromise = null; // allow a retry, e.g. after a network error
      throw err;
    });
  }
  return occtPromise;
}

function transferables(bodies) {
  const list = [];
  for (const b of bodies) {
    if (b.mesh?.positions?.buffer) list.push(b.mesh.positions.buffer);
    if (b.mesh?.indices?.buffer) list.push(b.mesh.indices.buffer);
    if (b.mesh?.positions64?.buffer) list.push(b.mesh.positions64.buffer);
  }
  return [...new Set(list)];
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  // Exceptions thrown inside the WebAssembly code can surface as bare numbers.
  if (typeof err === 'number') return `OpenCascade internal error (${err})`;
  return String(err);
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'preload') {
      await occt();
      postMessage({ type: 'ready', engine: 'cad', memory: memory() });
      return;
    }
    if (msg.type === 'memory') {
      postMessage({ type: 'memory', id: msg.id, memory: memory() });
      return;
    }
    if (msg.type !== 'analyze') return;

    let result;
    // Progress of the analysis itself, in percent (the CAD engine download has its own).
    let last = -1;
    const progress = (percent, step) => {
      percent = Math.min(100, Math.max(0, Math.floor(percent)));
      if (percent === last) return;
      last = percent;
      postMessage({ type: 'progress', id: msg.id, stage: 'analyze', engine: msg.kind === 'cad' ? 'cad' : 'mesh', percent, step, memory: memory() });
    };
    if (msg.kind === 'cad') {
      progressTarget = msg.id;
      const oc = await occt();
      progress(0, 'read');
      result = analyzeCad(oc, new Uint8Array(msg.bytes), msg.name, {
        quality: msg.quality,
        onProgress: (p) => progress(p.percent * 0.95, p.step), // the last 5 %: envelopes, on the page
      });
    } else if (msg.kind === 'meshfile') {
      progress(0, 'read');
      const { parts, source_unit } = await loadMeshFile(msg.bytes, msg.name, { unit: msg.unit });
      progress(30, 'measure');
      result = { bodies: analyzeMeshParts(parts, (f) => progress(30 + f * 65, 'measure')), source_unit };
    } else {
      progress(30, 'measure');
      result = { bodies: analyzeMeshParts(msg.parts, (f) => progress(30 + f * 65, 'measure')) };
    }
    postMessage({ type: 'result', id: msg.id, result, memory: memory() }, transferables(result.bodies));
  } catch (err) {
    // A crash inside WebAssembly can leave the module in an unusable state:
    // ask the client to start a fresh worker for the next file.
    // An out-of-memory error leaves the WebAssembly heap at its maximum size.
    const fatal =
      msg.kind === 'cad' &&
      (!(err instanceof Error) ||
        err instanceof WebAssembly.RuntimeError ||
        /abort|not enough memory/i.test(err.message));
    postMessage({ type: 'error', id: msg.id, message: errorMessage(err), fatal, memory: memory() });
  }
};
