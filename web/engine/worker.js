// Module Web Worker running the heavy computations off the UI thread.
//
// Import maps do not apply inside workers, so only modules without bare
// imports (no "three") may be imported here: the OpenCascade engine and the
// mesh analysis are plain JavaScript. Parsing mesh files with three.js and the
// envelope computation happen on the main thread (see client.js).

import { loadOcct } from './occt.js';
import { analyzeCad } from './cad.js';
import { analyzeMeshParts } from './meshanalysis.js';

// Root of the site (…/web/ or …/3D-reader/), where vendor/ lives.
const baseUrl = new URL('../', import.meta.url).href;

let occtPromise = null;
let progressTarget = null; // id of the request that currently wants loading progress

function occt() {
  if (!occtPromise) {
    occtPromise = loadOcct({
      baseUrl,
      onProgress: (p) => postMessage({ type: 'progress', id: progressTarget, ...p }),
    }).catch((err) => {
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
  }
  return list;
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
      postMessage({ type: 'ready', engine: 'cad' });
      return;
    }
    if (msg.type !== 'analyze') return;

    let result;
    if (msg.kind === 'cad') {
      progressTarget = msg.id;
      const oc = await occt();
      postMessage({ type: 'progress', id: msg.id, stage: 'analyze' });
      result = analyzeCad(oc, new Uint8Array(msg.bytes), msg.name, { quality: msg.quality });
    } else {
      postMessage({ type: 'progress', id: msg.id, stage: 'analyze' });
      result = { bodies: analyzeMeshParts(msg.parts) };
    }
    postMessage({ type: 'result', id: msg.id, result }, transferables(result.bodies));
  } catch (err) {
    // A crash inside WebAssembly can leave the module in an unusable state:
    // ask the client to start a fresh worker for the next file.
    const fatal =
      msg.kind === 'cad' &&
      (!(err instanceof Error) || err instanceof WebAssembly.RuntimeError || /abort/i.test(err.message));
    postMessage({ type: 'error', id: msg.id, message: errorMessage(err), fatal });
  }
};
