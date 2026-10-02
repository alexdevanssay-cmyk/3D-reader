// Loading of OpenCascade compiled to WebAssembly (opencascade.js, full build).
//
// Browser: the 50 MB wasm binary is published gzip-compressed next to the
// emscripten ES module factory (vendor/opencascade/). It is downloaded with
// progress reporting, decompressed on the fly with DecompressionStream, and
// instantiated through the factory's `instantiateWasm` hook, so emscripten
// never fetches it itself.
//
// Node (tests): the package's own node entry point loads the uncompressed wasm
// from node_modules. It is imported dynamically so browsers never resolve it.

const OCCT_DIR = 'vendor/opencascade/';
const OCCT_JS = 'opencascade.full.js';
const OCCT_WASM_GZ = 'opencascade.full.wasm.gz';

let browserPromise = null;
let nodePromise = null;

/**
 * Load OpenCascade once and resolve to the emscripten module (`oc`).
 *
 * baseUrl    -- URL of the site root, i.e. the directory holding vendor/.
 *               Relative URLs resolve against the page (or worker) location,
 *               like fetch() does. Default: the parent of this engine/ folder.
 * onProgress -- called with {stage: 'download', loaded, total} while the wasm
 *               downloads (total is 0 when the server sends no length), then
 *               once with {stage: 'compile'} while WebAssembly compiles.
 *
 * The promise is cached: later calls return the same module whatever their
 * arguments. A failed load is not cached, so it can be retried.
 */
export function loadOcct({ baseUrl, onProgress } = {}) {
  if (!browserPromise) {
    browserPromise = loadBrowser(resolveBase(baseUrl), onProgress || (() => {})).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** Node.js counterpart of loadOcct(), used by the tests (no download, no gzip). */
export function loadOcctNode() {
  if (!nodePromise) {
    nodePromise = (async () => {
      // A variable specifier keeps static analysers and browsers away from it.
      const entry = 'opencascade.js/dist/node.js';
      const { default: initOpenCascade } = await import(entry);
      return initOpenCascade();
    })().catch((err) => {
      nodePromise = null;
      throw err;
    });
  }
  return nodePromise;
}

function resolveBase(baseUrl) {
  const fallback = new URL('../', import.meta.url);
  if (!baseUrl) return fallback.href;
  const url = new URL(baseUrl, globalThis.location?.href ?? fallback);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

async function loadBrowser(base, onProgress) {
  const dir = new URL(OCCT_DIR, base).href;
  // Start the download first: importing the 400 kB glue script overlaps with it.
  const binaryPromise = downloadWasm(dir + OCCT_WASM_GZ, base, onProgress);
  const factoryPromise = import(/* @vite-ignore */ dir + OCCT_JS).then(
    (mod) => mod.default,
    (err) => {
      throw new Error(`Unable to load OpenCascade from ${dir + OCCT_JS}: ${err.message || err}`);
    },
  );
  const [wasmBinary, factory] = await Promise.all([binaryPromise, factoryPromise]);
  if (typeof factory !== 'function') {
    throw new Error(`${OCCT_JS} does not export the emscripten module factory`);
  }
  onProgress({ stage: 'compile' });
  return instantiate(factory, wasmBinary, dir);
}

/**
 * Run the emscripten factory on an already downloaded binary.
 *
 * The documented `instantiateWasm` hook is used rather than the `wasmBinary`
 * option: emscripten keeps whatever it receives as `wasmBinary` referenced for
 * the lifetime of the module, i.e. 50 MB held for nothing after start-up.
 */
function instantiate(factory, wasmBinary, dir) {
  let bytes = wasmBinary;
  return new Promise((resolve, reject) => {
    factory({
      // Only used if emscripten looks for a companion file; the wasm itself is provided.
      locateFile: (path) => dir + path,
      // OpenCascade reports parsing details on stdout: keep them out of the default console level.
      print: (text) => console.debug(text),
      printErr: (text) => console.warn(text),
      instantiateWasm(imports, receiveInstance) {
        WebAssembly.instantiate(bytes, imports).then(
          ({ instance, module }) => receiveInstance(instance, module),
          (err) => reject(new Error(`Unable to start OpenCascade: ${err.message || err}`)),
        );
        bytes = null;
        return {}; // the exports are delivered asynchronously through receiveInstance
      },
    }).then(resolve, reject);
  });
}

/**
 * Download the gzip-compressed wasm and return the raw binary (Uint8Array).
 *
 * Decompression is streamed while downloading. If the server already decoded
 * the payload (it sent the .gz with "Content-Encoding: gzip"), the bytes start
 * with the wasm magic number instead of the gzip one and are used as they are.
 */
async function downloadWasm(url, base, onProgress) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`Unable to download OpenCascade from ${url}: ${err.message || err}`);
  }
  if (!response.ok) {
    throw new Error(`Unable to download OpenCascade from ${url} (HTTP ${response.status})`);
  }
  // With a Content-Encoding the length is that of the encoded payload, not of
  // the bytes read below: the total is then unknown (0), like without a length.
  const total = response.headers.get('Content-Encoding') ? 0 : Number(response.headers.get('Content-Length')) || 0;
  if (!response.body) {
    // Very old engines: no streaming, hence no intermediate progress.
    const buf = new Uint8Array(await response.arrayBuffer());
    onProgress({ stage: 'download', loaded: buf.length, total: total || buf.length });
    return isGzip(buf) ? gunzip(new Blob([buf]).stream(), buf, base) : buf;
  }

  const reader = response.body.getReader();
  let loaded = 0;
  const report = (chunk) => {
    loaded += chunk.length;
    onProgress({ stage: 'download', loaded, total: total && Math.max(total, loaded) });
  };

  // Peek at the first bytes to recognise the format.
  const head = [];
  let headBytes = 0;
  let done = false;
  while (headBytes < 2 && !done) {
    const step = await reader.read();
    done = step.done;
    if (!done && step.value.length) {
      head.push(step.value);
      headBytes += step.value.length;
      report(step.value);
    }
  }
  const counted = new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const step = await reader.read();
      if (step.done) {
        controller.close();
      } else {
        report(step.value);
        controller.enqueue(step.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  if (!isGzip(Uint8Array.from(head.flatMap((chunk) => [...chunk.subarray(0, 2)])))) {
    return new Uint8Array(await new Response(counted).arrayBuffer());
  }
  return gunzip(counted, null, base);
}

const isGzip = (bytes) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

async function gunzip(stream, wholeBuffer, base) {
  if (typeof DecompressionStream === 'function') {
    try {
      return new Uint8Array(await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    } catch (err) {
      throw new Error(`Unable to decompress OpenCascade: ${err.message || err}`);
    }
  }
  // Browsers without DecompressionStream (Safari < 16.4): fflate, shipped with three.js.
  const bytes = wholeBuffer || new Uint8Array(await new Response(stream).arrayBuffer());
  const fflateUrl = new URL('vendor/three/addons/libs/fflate.module.js', base).href;
  try {
    const { gunzipSync } = await import(/* @vite-ignore */ fflateUrl);
    return gunzipSync(bytes);
  } catch (err) {
    throw new Error(`This browser cannot decompress OpenCascade (no DecompressionStream): ${err.message || err}`);
  }
}
