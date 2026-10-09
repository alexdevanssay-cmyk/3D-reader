// The shared folder of the company network, chosen once (Paramètres page, or
// the history of the IA page) and used by every PC, so that the work of one
// benefits all (File System Access API: Chrome or Edge). Its subfolders:
//   analyses-3d         the results of the 3D analyses (engine/shared-cache.js):
//                       a part analysed on one PC opens at once on another;
//   retours-experience  the real cycle times measured in production
//                       (chiffrage/feedback.js);
//   historique-ia       the conversations of the IA page (ai-history.js).
// Its handle is kept in this browser (IndexedDB); the browser asks again for
// its access after a restart ("Autoriser l'accès": a click). Nothing goes
// anywhere else: the files stay in that folder, on the company network.
//
// Other PCs may read a file at any moment: the browser writes each file
// through a file of its own (Chrome's .crswap, left out of every listing) put
// in place once complete; a file written is read back, and a write or a read
// is tried again a few times while the network or another PC holds the file.

export const SUBFOLDERS = { analyses: "analyses-3d", retours: "retours-experience", ia: "historique-ia" };
// Told on the page (document) when the folder is chosen, forgotten or its access granted.
export const CHANGED = "reader3d-network-folder";
const DB_NAME = "reader3d-reseau";
const SETTINGS = "settings"; // key: "dossier" -> the folder's handle

// --------------------------------------------------------------------------- the folder kept

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB indisponible"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SETTINGS);
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close(); // a later version opened in another tab
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("dossier réseau : réglage bloqué par un autre onglet"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function setting(key) {
  const store = (await db()).transaction(SETTINGS, "readonly").objectStore(SETTINGS);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function setSetting(key, value) {
  const tx = (await db()).transaction(SETTINGS, "readwrite");
  if (value == null) tx.objectStore(SETTINGS).delete(key);
  else tx.objectStore(SETTINGS).put(value, key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("dossier réseau : réglage non enregistré"));
  });
}

const changed = () => globalThis.document?.dispatchEvent(new CustomEvent(CHANGED));

/** Whether this browser can open a folder (Chrome, Edge). */
export const folderSupported = () => typeof globalThis.showDirectoryPicker === "function";

/** The shared folder chosen: {handle, name, permission ("granted", "prompt", "denied")}, or null (none, or a browser that cannot open one). */
export async function sharedFolder() {
  if (!folderSupported()) return null;
  const handle = await setting("dossier").catch(() => null);
  if (!handle) return null;
  let permission = "prompt";
  try {
    permission = await handle.queryPermission({ mode: "readwrite" });
  } catch {
    // asked again
  }
  return { handle, name: handle.name, permission };
}

/** Ask the folder (a click of the user): the shared folder from now on. */
export async function chooseSharedFolder() {
  const handle = await globalThis.showDirectoryPicker({ id: "reader3d-dossier-reseau", mode: "readwrite" });
  await setSetting("dossier", handle);
  changed();
  return handle;
}

/** Ask again for the access to the folder kept (a click of the user: the browser asks after a restart). */
export async function grantSharedFolder() {
  const folder = await sharedFolder();
  if (!folder) return false;
  const granted = (await folder.handle.requestPermission({ mode: "readwrite" })) === "granted";
  if (granted) changed();
  return granted;
}

/** No shared folder any more (its files stay where they are). */
export async function forgetSharedFolder() {
  await setSetting("dossier", null);
  changed();
}

/** A promise given up after `ms` (a network that does not answer): rejected with a TimeoutError saying `message`. */
export function withTimeout(promise, ms, message) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The subfolder `name` of the shared folder (created when missing), when its
 * access is granted; else null. Never asks for the access (that needs a click).
 */
export async function sharedDir(name, { timeout = 5000 } = {}) {
  const folder = await sharedFolder();
  if (folder?.permission !== "granted") return null;
  return withTimeout(folder.handle.getDirectoryHandle(name, { create: true }), timeout, `le dossier réseau « ${folder.name} » ne répond pas`);
}

/**
 * The state of the shared folder, for the Paramètres page: {state, name, error}.
 * state: "unsupported" (a browser that cannot open a folder), "none", "prompt"
 * (access to grant), "denied", "unreadable" (granted, but its files cannot be
 * listed within `timeout`: network, folder moved) or "accessible".
 */
export async function checkSharedFolder({ timeout = 5000 } = {}) {
  if (!folderSupported()) return { state: "unsupported", name: null, error: null };
  const folder = await sharedFolder();
  if (!folder) return { state: "none", name: null, error: null };
  if (folder.permission !== "granted") return { state: folder.permission === "denied" ? "denied" : "prompt", name: folder.name, error: null };
  try {
    // Its first entry listed: a network that does not answer, or a folder gone, says so.
    await withTimeout(folder.handle.values().next(), timeout, "pas de réponse du réseau");
    return { state: "accessible", name: folder.name, error: null };
  } catch (err) {
    return { state: "unreadable", name: folder.name, error: err?.message || String(err) };
  }
}

// --------------------------------------------------------------------------- files

// A file being written (by this PC or another one): missing or unreadable for a moment.
export const busyFile = (err) => ["NotFoundError", "NotReadableError", "InvalidStateError"].includes(err?.name);
// A write that may work a moment later: the file held by another PC, the network gone for a moment.
const retryWrite = (err) => busyFile(err) || ["NoModificationAllowedError", "AbortError", "TimeoutError"].includes(err?.name) || err?.name === "Error";
export const notFound = (err) => err?.name === "NotFoundError" || err?.name === "TypeMismatchError";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const TRIES = 4;

/** The text of the file `handle`, read again a moment later while it is being written. */
export async function readText(handle, tries = TRIES) {
  for (let i = 1; ; i++) {
    try {
      return await (await handle.getFile()).text();
    } catch (err) {
      if (i >= tries || !busyFile(err)) throw err;
    }
    await pause(100 * i);
  }
}

/** The names of the files of the folder `dir` for which `keep(name)`, in order; Chrome's .crswap of a write in progress left out. */
export async function fileNames(dir, keep = () => true) {
  const names = [];
  for await (const entry of dir.values()) if (entry.kind === "file" && !entry.name.endsWith(".crswap") && keep(entry.name)) names.push(entry.name);
  return names.sort();
}

/** The handle of the file `name` of the folder `dir`, or null when there is none. */
export async function fileIn(dir, name) {
  try {
    return await dir.getFileHandle(name);
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

/** An error for a file that is there already: never written over. */
export class FileExistsError extends Error {
  constructor(name) {
    super(`le fichier « ${name} » existe déjà : il n'est pas remplacé`);
    this.name = "FileExistsError";
  }
}

/**
 * Write the file `name` of the folder `dir`: `data` is text, bytes, or a
 * function giving a ReadableStream of bytes (called again at each try, so
 * that the content is never held twice in memory). Then the file read back:
 * its size, and `check(file)` (resolves to true when it reads right),
 * waiting a moment while the network gives the file of before. Tried again
 * a few times on the errors of a network or of a file held by another PC.
 *   overwrite -- false: a file that is there is never written over (FileExistsError)
 * Resolves to the number of bytes written.
 */
export async function writeFile(dir, name, data, { overwrite = true, check = null, verify = true, tries = 3 } = {}) {
  // Text is written as text (UTF-8), its size counted in bytes.
  const length = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
  for (let attempt = 1; ; attempt++) {
    let writable = null;
    try {
      // Checked before the first try only: a try after a failed one finds its own file.
      if (!overwrite && attempt === 1 && (await fileIn(dir, name))) throw new FileExistsError(name);
      const handle = await dir.getFileHandle(name, { create: true });
      writable = await handle.createWritable();
      let size = 0;
      if (typeof data === "function") {
        const count = new TransformStream({
          transform(chunk, controller) {
            size += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        const target = writable;
        writable = null; // closed by pipeTo, or aborted on an error
        await data().pipeThrough(count).pipeTo(target);
      } else {
        size = length;
        await writable.write(data);
        await writable.close();
      }
      writable = null;
      if (verify) await readBack(handle, size, check);
      return size;
    } catch (err) {
      await writable?.abort().catch(() => {});
      if (attempt >= tries || !retryWrite(err)) throw err;
    }
    await pause(200 * attempt + Math.random() * 300);
  }
}

/** The file `handle` read back once written: `size` bytes, and `check(file)`; read again a moment later while the network gives the file of before. */
async function readBack(handle, size, check) {
  for (let i = 1; ; i++) {
    try {
      const file = await handle.getFile();
      if (file.size === size && (!check || (await check(file)))) return;
    } catch (err) {
      if (!busyFile(err)) throw err;
    }
    if (i >= TRIES) throw Object.assign(new Error(`« ${handle.name} » relu différent de ce qui a été écrit`), { name: "NotReadableError" });
    await pause(100 * i);
  }
}
