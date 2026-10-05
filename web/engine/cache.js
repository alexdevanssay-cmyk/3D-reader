// Results kept in this browser (IndexedDB), so that a file opened again shows
// at once: the analysis and the wall thickness, keyed by the SHA-256 of the
// file's content (same content = same results, whatever its name or date) and
// by the options that change the results. Nothing leaves the computer. The
// oldest results are dropped above a total size.

// Bump when the engine gives different results for the same file.
const VERSION = 1;
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

/** The results kept for this key ({data, thickness}), or null. Never throws. */
export async function loadResult(key) {
  if (!key) return null;
  try {
    const d = await db();
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    const record = await request(tx.objectStore('data').get(key));
    const meta = await request(tx.objectStore('meta').get(key));
    if (meta) tx.objectStore('meta').put({ ...meta, usedAt: Date.now() });
    await done(tx);
    return record ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep results (record: {data, thickness}); `patch` merges into the record
 * already kept (e.g. the thickness, computed later). Never throws: the cache
 * is an extra, a full disk or a private window just leave it out.
 */
export async function saveResult(key, record, { patch = false, file = '' } = {}) {
  if (!key) return;
  try {
    const d = await db();
    let value = record;
    if (patch) {
      const old = await request(d.transaction('data').objectStore('data').get(key));
      if (!old) return;
      value = { ...old, ...record };
    }
    const bytes = sizeOf(value);
    if (bytes > MAX_BYTES / 2) return; // one model would push out everything else
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('data').put(value, key);
    const meta = (await request(tx.objectStore('meta').get(key))) ?? { key, file, savedAt: Date.now() };
    tx.objectStore('meta').put({ ...meta, bytes, usedAt: Date.now() });
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
    tx.objectStore('data').delete(m.key);
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
