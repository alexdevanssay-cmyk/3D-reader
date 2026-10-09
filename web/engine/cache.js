// Results kept in this browser (IndexedDB), so that a file opened again shows
// at once: the analysis and the wall thickness, keyed by the SHA-256 of the
// file's content (same content = same results, whatever its name or date) and
// by the options that change the results. Nothing leaves the computer. The
// oldest results are dropped above a total size.

// Bump when the engine gives different results for the same file.
// 2: analytic surfaces of the CAD bodies (surface_types, geometric_surfaces),
// topology of the mesh of every body.
const VERSION = 2;
const DB_NAME = 'reader3d-cache';
const MAX_BYTES = 768 * 2 ** 20;
const MAX_ENTRIES = 60;

let dbPromise = null;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        // meta: small records (for the eviction); data: the results.
        req.result.createObjectStore('meta', { keyPath: 'key' });
        req.result.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('cache blocked'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Key of a file's results: null when it cannot be computed (no crypto.subtle: page not served over https). */
export async function cacheKey(bytes, options) {
  if (!globalThis.crypto?.subtle) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${VERSION}|${hex}|${Object.entries(options).map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/** Size in bytes of the typed arrays of a value (what the cache costs). */
function sizeOf(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  seen.add(value);
  let n = 0;
  for (const v of Array.isArray(value) ? value : Object.values(value)) n += typeof v === 'object' ? sizeOf(v, seen) : 16;
  return n;
}

// Each part of the results is a record of its own: the thickness and the
// parting line, computed later, are added without reading and writing again
// the (large) analysis.
const PARTS = ['data', 'thickness', 'parting'];
const partKey = (key, part) => (part === 'data' ? key : `${key}#${part}`);

/** The results kept for this key ({data, thickness, parting}), or null. Never throws. */
export async function loadResult(key) {
  if (!key) return null;
  try {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    const [data, thickness, parting] = await Promise.all(PARTS.map((part) => request(tx.objectStore('data').get(partKey(key, part)))));
    const meta = await request(tx.objectStore('meta').get(key));
    if (meta) tx.objectStore('meta').put({ ...meta, usedAt: Date.now() });
    await done(tx);
    // Kept by an earlier version: one record {data, thickness}; a thickness
    // computed since then is a record of its own.
    if (data && 'data' in data) return { data: data.data, thickness: thickness ?? data.thickness ?? null, parting: parting ?? null };
    return data ? { data, thickness: thickness ?? null, parting: parting ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Keep a part of the results: record {data} (the analysis, first),
 * {thickness} or {parting} (added to the analysis already kept). Never throws: the cache
 * is an extra, a full disk or a private window just leave it out.
 */
export async function saveResult(key, record, { file = '' } = {}) {
  if (!key) return;
  try {
    const d = await db();
    const [part] = Object.keys(record);
    const bytes = sizeOf(record[part]);
    if (bytes > MAX_BYTES / 2) return; // one model would push out everything else
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    const meta = await request(tx.objectStore('meta').get(key));
    if (part !== 'data' && !meta) return; // the analysis is no longer kept
    tx.objectStore('data').put(record[part], partKey(key, part));
    // A new analysis (refreshed, or its open surfaces closed): the thickness kept was of the former one.
    const former = part === 'data' ? {} : meta?.parts;
    if (part === 'data') for (const other of PARTS) if (other !== 'data') tx.objectStore('data').delete(partKey(key, other));
    const parts = { ...former, [part]: bytes };
    tx.objectStore('meta').put({ key, file: meta?.file ?? file, savedAt: meta?.savedAt ?? Date.now(), parts, bytes: Object.values(parts).reduce((a, b) => a + b, 0), usedAt: Date.now() });
    await done(tx);
    await evict(d);
  } catch {
    // not kept
  }
}

/** Drop the least recently used results above the limits. */
async function evict(d) {
  const metas = await request(d.transaction('meta').objectStore('meta').getAll());
  metas.sort((a, b) => b.usedAt - a.usedAt);
  let total = 0;
  const drop = metas.filter((m, i) => (total += m.bytes || 0) > MAX_BYTES || i >= MAX_ENTRIES);
  if (!drop.length) return;
  const tx = d.transaction(['meta', 'data'], 'readwrite');
  for (const m of drop) {
    tx.objectStore('meta').delete(m.key);
    for (const part of PARTS) tx.objectStore('data').delete(partKey(m.key, part));
  }
  await done(tx);
}

/** Forget everything kept. */
export async function clearCache() {
  try {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('data').clear();
    await done(tx);
  } catch {
    // nothing kept
  }
}

/** {entries, bytes} kept. */
export async function cacheInfo() {
  try {
    const metas = await request((await db()).transaction('meta').objectStore('meta').getAll());
    return { entries: metas.length, bytes: metas.reduce((n, m) => n + (m.bytes || 0), 0) };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
