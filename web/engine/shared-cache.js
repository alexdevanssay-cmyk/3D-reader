// Results of the 3D analyses shared on the company network: what this browser
// keeps (cache.js) is also written in the subfolder "analyses-3d" of the
// shared folder (network-folder.js), so that a part analysed on one PC opens
// at once on another one. One file per key of the cache and per part of its
// results:
//   <sha256 of the file>__<tag>.r3d.gz                          the analysis
//   <sha256 of the file>__<tag>__epaisseur-<meshes>.r3d.gz      the wall thickness
// <tag>: a short hash of the cache version and of the options of the key
// (cache.js cacheKey), <meshes>: a short hash of the meshes the thickness was
// computed on (a model whose open surfaces were closed has other meshes).
//
// A file: a container compressed with gzip (CompressionStream), written and
// read as a stream (a large model is never held twice in memory):
//   "R3DCACHE" (8 bytes), the length of the header (uint32, little endian),
//   the header (JSON, UTF-8): {format, version, key, part, date, arrays:
//   [{type, length}], value}, the value being the results with each typed
//   array replaced by {"$r3d": {"t": its rank}} (a number JSON cannot write:
//   {"$r3d": {"n": "NaN"}}; an object with a key "$r3d" of its own:
//   {"$r3d": {"o": the object}}); then the bytes of the arrays, each one
//   starting at a multiple of 8 bytes.
// A file of another version or key, damaged, cut, or slow to come is left:
// the part is analysed on this PC (and its file written again). Nothing here
// waits on the network without a time limit, nor holds the page.

import { SUBFOLDERS, fileIn, sharedDir, sharedFolder, withTimeout, writeFile } from '../network-folder.js';

export const CONTAINER_VERSION = 1;
const FORMAT = 'reader3d-resultats';
const MAGIC = 'R3DCACHE';
const ALIGN = 8;
const CHUNK = 1 << 20; // bytes handed to the compression at a time
const MAX_HEADER = 256 * 2 ** 20;
const TYPES = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };

// --------------------------------------------------------------------------- the container

/** The value with its typed arrays taken out: {value (for JSON), arrays}. Throws on what JSON and the arrays cannot hold (a Map, a function, a cycle). */
export function packValue(value) {
  const arrays = [];
  const ranks = new Map();
  const path = new Set(); // the objects being packed: a cycle is refused
  const pack = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $r3d: { n: String(v) } };
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v !== 'object') throw new TypeError(`valeur non enregistrable (${typeof v})`);
    if (ArrayBuffer.isView(v)) {
      if (!(v.constructor.name in TYPES)) throw new TypeError(`tableau non enregistrable (${v.constructor.name})`);
      if (!ranks.has(v)) {
        ranks.set(v, arrays.length);
        arrays.push(v);
      }
      return { $r3d: { t: ranks.get(v) } };
    }
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new TypeError(`objet non enregistrable (${v.constructor?.name ?? 'inconnu'})`);
    if (path.has(v)) throw new TypeError('valeur circulaire non enregistrable');
    path.add(v);
    let out;
    if (Array.isArray(v)) out = v.map(pack);
    else {
      out = {};
      for (const [k, x] of Object.entries(v)) out[k] = pack(x);
      if (Object.hasOwn(v, '$r3d')) out = { $r3d: { o: out } };
    }
    path.delete(v);
    return out;
  };
  return { value: pack(value), arrays };
}

/** The value of packValue back, its typed arrays `arrays` put in place. */
export function unpackValue(value, arrays) {
  const object = (o) => {
    const out = {};
    // A key "__proto__" of the file stays a key, never the prototype.
    for (const [k, x] of Object.entries(o)) Object.defineProperty(out, k, { value: unpack(x), enumerable: true, writable: true, configurable: true });
    return out;
  };
  const unpack = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(unpack);
    if (!Object.hasOwn(v, '$r3d')) return object(v);
    const m = v.$r3d;
    if (Number.isInteger(m?.t) && m.t >= 0 && m.t < arrays.length) return arrays[m.t];
    if (['NaN', 'Infinity', '-Infinity'].includes(m?.n)) return Number(m.n);
    if (m?.o && typeof m.o === 'object' && !Array.isArray(m.o)) return object(m.o);
    throw new Error('fichier de résultats : référence inconnue');
  };
  return unpack(value);
}

const pad = (n) => (ALIGN - (n % ALIGN)) % ALIGN;

/**
 * The container of `value` with the fields `meta` in its header: the bytes
 * to write one after the other (the arrays' own bytes, not copied).
 */
export function containerParts(value, meta = {}) {
  const { value: packed, arrays } = packValue(value);
  const header = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: CONTAINER_VERSION, ...meta, arrays: arrays.map((a) => ({ type: a.constructor.name, length: a.length })), value: packed }));
  const head = new Uint8Array(12 + header.length + pad(12 + header.length));
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(8, header.length, true);
  head.set(header, 12);
  const parts = [head];
  for (const a of arrays) {
    // An array in shared memory (thickness workers) is copied: the compression takes only its own buffers.
    const own = typeof SharedArrayBuffer === 'function' && a.buffer instanceof SharedArrayBuffer ? a.slice() : a;
    parts.push(new Uint8Array(own.buffer, own.byteOffset, own.byteLength));
    if (pad(own.byteLength)) parts.push(new Uint8Array(pad(own.byteLength)));
  }
  return parts;
}

/** A stream of the bytes `parts`, by slices of at most 1 MiB (views, not copies). */
export function streamOf(parts) {
  let i = 0;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      while (i < parts.length && offset >= parts[i].length) {
        i++;
        offset = 0;
      }
      if (i >= parts.length) return controller.close();
      const end = Math.min(parts[i].length, offset + CHUNK);
      controller.enqueue(parts[i].subarray(offset, end));
      offset = end;
    },
  });
}

export const gzip = (stream) => stream.pipeThrough(new CompressionStream('gzip'));
export const gunzip = (stream) => stream.pipeThrough(new DecompressionStream('gzip'));

/**
 * A container read from the stream of its bytes (decompressed): {meta (its
 * header, without the value and the arrays), value}. Each typed array gets a
 * buffer of its own, filled as the bytes come. Throws on another format or
 * version, a container cut short or followed by other bytes.
 */
export async function readContainer(stream) {
  const reader = stream.getReader();
  let chunk = new Uint8Array(0);
  let at = 0;
  const fill = async (target) => {
    for (let done = 0; done < target.length; ) {
      if (at >= chunk.length) {
        const { done: end, value } = await reader.read();
        if (end) throw new Error('fichier de résultats incomplet');
        chunk = value;
        at = 0;
        continue;
      }
      const n = Math.min(target.length - done, chunk.length - at);
      target.set(chunk.subarray(at, at + n), done);
      done += n;
      at += n;
    }
  };
  try {
    const head = new Uint8Array(12);
    await fill(head);
    if (new TextDecoder().decode(head.subarray(0, 8)) !== MAGIC) throw new Error("ce n'est pas un fichier de résultats");
    const length = new DataView(head.buffer).getUint32(8, true);
    if (length > MAX_HEADER) throw new Error('fichier de résultats endommagé');
    const bytes = new Uint8Array(length + pad(12 + length));
    await fill(bytes);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    if (header?.format !== FORMAT || header.version !== CONTAINER_VERSION || !Array.isArray(header.arrays)) {
      throw new Error(`fichier de résultats d'un autre format (${header?.format ?? '?'} version ${header?.version ?? '?'})`);
    }
    const arrays = [];
    for (const { type, length: n } of header.arrays) {
      if (!Object.hasOwn(TYPES, type) || !Number.isSafeInteger(n) || n < 0) throw new Error('fichier de résultats endommagé');
      const array = new TYPES[type](n);
      await fill(new Uint8Array(array.buffer));
      await fill(new Uint8Array(pad(array.byteLength)));
      arrays.push(array);
    }
    if (at < chunk.length || !(await reader.read()).done) throw new Error('fichier de résultats endommagé (données en trop)');
    const { value, arrays: _, ...meta } = header;
    reader.releaseLock();
    return { meta, value: unpackValue(value, arrays) };
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
}

// --------------------------------------------------------------------------- names

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));

/** The fields of a key of the cache (cache.js cacheKey "<version>|<sha256>|<options>"): {cache, sha256, options}, or null. */
export function parseKey(key) {
  const m = /^(\d+)\|([0-9a-f]{64})\|(.*)$/s.exec(key ?? '');
  return m ? { cache: Number(m[1]), sha256: m[2], options: m[3] } : null;
}

/** The names of the files of a key: {data, thickness(meshes)} (meshes: meshHash of the analysis), or null for a key that is not one. */
export async function sharedNames(key) {
  const k = parseKey(key);
  if (!k) return null;
  const stem = `${k.sha256}__${(await sha256(`${k.cache}|${k.options}`)).slice(0, 8)}`;
  return { data: `${stem}.r3d.gz`, thickness: (meshes) => `${stem}__epaisseur-${meshes}.r3d.gz` };
}

/** A short hash of the meshes of the bodies of an analysis (their positions and indices): the wall thickness is theirs. */
export async function meshHash(bodies) {
  const all = new Uint8Array(bodies.length * 64);
  for (const [i, b] of bodies.entries()) {
    for (const [j, a] of [b.mesh?.positions, b.mesh?.indices].entries()) {
      if (ArrayBuffer.isView(a)) all.set(new Uint8Array(await crypto.subtle.digest('SHA-256', a)), 64 * i + 32 * j);
    }
  }
  return (await sha256(all)).slice(0, 16);
}

// --------------------------------------------------------------------------- checks

const isArray = (a, Type, multiple = 1) => a instanceof Type && a.length % multiple === 0;

/** Whether `data` reads as an analysis of the browser engine (client.js): bodies with their meshes, a summary. */
export function validData(data) {
  return !!data && typeof data === 'object' && !!data.summary && Array.isArray(data.bodies) && data.bodies.length > 0
    && data.bodies.every((b) => b && isArray(b.mesh?.positions, Float32Array, 3) && isArray(b.mesh?.indices, Uint32Array, 3));
}

/** Whether `thickness` is the wall thickness of the bodies of `data`: per body null, or {ray, sphere, wall} with a value per triangle. */
export function validThickness(thickness, data) {
  return Array.isArray(thickness) && thickness.length === data.bodies.length
    && thickness.every((t, i) => t === null || ['ray', 'sphere', 'wall'].every((k) => t?.[k] instanceof Float32Array && t[k].length === data.bodies[i].mesh.indices.length / 3));
}

// --------------------------------------------------------------------------- the network

const STEP_LIMIT = 5000; // ms for each step before the transfer (the folder, the file)
const STALL_LIMIT = 15000; // ms without a byte during the transfer
const DOWN_FOR = 60000; // ms the network is not asked again after it did not answer
let downUntil = 0;

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Whether the shared folder can be used now: "none" (not chosen), "prompt" (its access to grant: a click) or "granted". */
export async function sharedState() {
  const folder = await sharedFolder();
  return !folder ? 'none' : folder.permission === 'granted' ? 'granted' : 'prompt';
}

/** The subfolder of the analyses: {dir}, or {state: "none" | "prompt" | "error", error} when it cannot be used now. */
async function analysesDir() {
  if (Date.now() < downUntil) return { state: 'error', error: 'le dossier réseau ne répondait pas il y a un instant' };
  const folder = await sharedFolder();
  if (!folder) return { state: 'none' };
  if (folder.permission !== 'granted') return { state: 'prompt' };
  try {
    return { dir: await sharedDir(SUBFOLDERS.analyses, { timeout: STEP_LIMIT }) };
  } catch (err) {
    if (err?.name === 'TimeoutError') downUntil = Date.now() + DOWN_FOR;
    return { state: 'error', error: err?.message || String(err) };
  }
}

/** The bytes of the file `file` as a stream: an error after STALL_LIMIT without a byte, or when `signal` aborts; `onBytes(n)` as they come. */
function watched(file, { signal, onBytes }) {
  const reader = file.stream().getReader();
  const aborted = new Promise((_, reject) => signal?.addEventListener('abort', () => reject(cancelled()), { once: true }));
  aborted.catch(() => {}); // a read that ended before
  return new ReadableStream({
    async pull(controller) {
      try {
        if (signal?.aborted) throw cancelled();
        const { done, value } = await Promise.race([withTimeout(reader.read(), STALL_LIMIT, 'le dossier réseau ne répond plus'), aborted]);
        if (done) return controller.close();
        onBytes?.(value.byteLength);
        controller.enqueue(value);
      } catch (err) {
        reader.cancel().catch(() => {});
        if (err?.name === 'TimeoutError') downUntil = Date.now() + DOWN_FOR;
        throw err;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A file of the folder read and checked: its value; null when it is empty
 * (being written: the browser creates it before writing it); else an error.
 * `key`/`part`: what its header must say.
 */
async function readFile(handle, { key, part, signal, onProgress }) {
  const file = await withTimeout(handle.getFile(), STEP_LIMIT, 'le dossier réseau ne répond pas');
  if (!file.size) return null;
  let read = 0;
  let last = -1;
  const onBytes = (n) => {
    read += n;
    const percent = Math.min(99, Math.floor((read / Math.max(1, file.size)) * 100));
    if (percent !== last) onProgress?.({ stage: 'analyze', step: 'network', percent: (last = percent) });
  };
  const { meta, value } = await readContainer(gunzip(watched(file, { signal, onBytes })));
  const k = parseKey(key);
  if (meta.part !== part || meta.key?.cache !== k.cache || meta.key?.sha256 !== k.sha256 || meta.key?.options !== k.options) throw new Error(`« ${handle.name} » : résultats d'un autre fichier`);
  return value;
}

/**
 * The results of the key `key` in the shared folder: {state, data, thickness, error}.
 * state: "read" (data: the analysis; thickness: of its meshes, or null),
 * "none" (no shared folder), "prompt" (its access to grant), "missing" (no
 * file of this key), "error" (not readable now: `error` says why).
 * Rejects only when `signal` aborts (err.cancelled).
 */
export async function readShared(key, { signal, onProgress } = {}) {
  const names = await sharedNames(key);
  if (!names) return { state: 'missing' };
  const where = await analysesDir();
  if (!where.dir) return where;
  try {
    const handle = await withTimeout(fileIn(where.dir, names.data), STEP_LIMIT, 'le dossier réseau ne répond pas');
    if (!handle) return { state: 'missing' };
    onProgress?.({ stage: 'analyze', step: 'network', percent: 0 });
    const data = await readFile(handle, { key, part: 'analyse', signal, onProgress });
    if (data === null) return { state: 'missing' };
    if (!validData(data)) throw new Error(`« ${handle.name} » : analyse illisible`);
    // The thickness of these meshes, if one was computed: without it, the analysis anyway.
    let thickness = null;
    try {
      const other = await withTimeout(fileIn(where.dir, names.thickness(await meshHash(data.bodies))), STEP_LIMIT, 'le dossier réseau ne répond pas');
      if (other) thickness = await readFile(other, { key, part: 'epaisseur', signal });
      if (thickness && !validThickness(thickness, data)) thickness = null;
    } catch (err) {
      if (err?.cancelled) throw err;
      thickness = null;
    }
    return { state: 'read', data, thickness };
  } catch (err) {
    if (err?.cancelled || signal?.aborted) throw cancelled();
    return { state: 'error', error: err?.message || String(err) };
  }
}

// The files written one after the other, in the background: a slow network never holds the page.
let writing = Promise.resolve();

/**
 * Write the results of the key `key` in the shared folder, in the background:
 *   data      -- the analysis (as cache.js keeps it), or null
 *   thickness -- its wall thickness, or null; with `bodies` (of its analysis) when `data` is not given
 *   replace   -- false: a file already there is left as it is (written by another PC, or before)
 * Resolves to {state: "written" (files: the names written) | "none" | "prompt" | "error", error}.
 */
export function writeShared(key, { data = null, thickness = null, bodies = null, replace = true } = {}) {
  const job = writing.then(async () => {
    const names = await sharedNames(key);
    if (!names) return { state: 'none' };
    const where = await analysesDir();
    if (!where.dir) return where;
    const files = [];
    const put = async (name, part, value) => {
      if (!replace && (await withTimeout(fileIn(where.dir, name), STEP_LIMIT, 'le dossier réseau ne répond pas'))) return;
      const parts = containerParts(value, { key: parseKey(key), part, date: new Date().toISOString() });
      await writeFile(where.dir, name, () => gzip(streamOf(parts)));
      files.push(name);
    };
    try {
      if (data) await put(names.data, 'analyse', data);
      if (thickness) await put(names.thickness(await meshHash(bodies ?? data.bodies)), 'epaisseur', thickness);
      return { state: 'written', files };
    } catch (err) {
      return { state: 'error', error: err?.message || String(err), files };
    }
  });
  writing = job.catch(() => {});
  return job;
}
