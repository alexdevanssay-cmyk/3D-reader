// History of the conversations of the IA page (ai-workspace.js), per part.
//
// Every conversation answered at least once is kept in this browser
// (IndexedDB "reader3d-ai", the "Historique local" of the page); those about a
// part are also written in a folder of the company network chosen once
// ("Historique réseau", File System Access API: Chrome or Edge), one JSON file
// per part, merged message by message: two PCs writing about the same part
// keep both their messages. A part is known by the SHA-256 of its file
// (app.js tab.part, "sha256:<hex>"): the same file, under any name, finds its
// conversations; another version of it is another part.
//
// Nothing here goes online: the conversations hold the real names of the
// parts and of the quote (the names are replaced only in what is sent to the
// gateway). They stay on this PC, and in the folder chosen on the network.

export const HISTORY_SCHEMA = "reader3d-historique-ia";
export const HISTORY_VERSION = 1;
const DB_NAME = "reader3d-ai";
const CONVERSATIONS = "conversations"; // key: id; index "part" on part_id ("" without a part)
const SETTINGS = "settings"; // key: "network" -> the folder's handle

/** A new id for a conversation or a message. */
export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The hexadecimal SHA-256 of a part's id, when it is one ("sha256:<hex>"): the parts the network folder keeps. */
export const partHash = (part) => /^sha256:([0-9a-f]{64})$/.exec(part?.id ?? "")?.[1] ?? null;

/** The identity of a file: "sha256:<hex>" of its bytes; without crypto.subtle (a page not served over https), its name and size. */
export async function partIdOf(file) {
  if (globalThis.crypto?.subtle) {
    try {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      // read below by its name
    }
  }
  return `nom:${file.name}|${file.size}`;
}

const text = (v) => (typeof v === "string" ? v : null);
const time = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * A conversation as it is kept, from what was stored (this browser, a file of
 * the network folder, a version of the page before): {id, part: {id, file} |
 * null, file, started, updated, messages, names}. Every message has an id and
 * a date (`at`: when it was written, else when the conversation was); a
 * question and its answer share the date of the question, so that a merge
 * never parts them. Null when it is not a conversation.
 */
export function normalizeConversation(data, at = new Date().toISOString()) {
  if (!data || typeof data !== "object" || !Array.isArray(data.messages)) return null;
  const part = data.part && typeof data.part.id === "string" ? { id: data.part.id, file: text(data.part.file) } : null;
  const fallback = time(data.updated) ?? time(data.started) ?? at;
  let asked = fallback;
  const messages = data.messages
    .filter((m) => m && typeof m === "object" && typeof m.content === "string" && ["user", "assistant"].includes(m.role))
    .map((m) => {
      if (m.role === "user") asked = time(m.date) ?? fallback;
      return { ...m, id: text(m.id) ?? newId(), date: time(m.date) ?? asked };
    });
  return {
    id: text(data.id) ?? newId(),
    part,
    file: text(data.file) ?? part?.file ?? null,
    started: time(data.started) ?? messages[0]?.date ?? fallback,
    updated: time(data.updated) ?? fallback,
    messages,
    names: Array.isArray(data.names) ? data.names.filter((n) => typeof n?.name === "string" && typeof n?.label === "string") : [],
  };
}

/**
 * Two copies of a conversation as one (this PC's and the network's): every
 * message of both once (by its id), in the order of their dates (a question
 * then its answer), the names of both. `a` gives the rest (the newer one).
 */
export function mergeConversation(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const byId = new Map();
  for (const m of [...a.messages, ...b.messages]) if (!byId.has(m.id)) byId.set(m.id, m);
  const messages = [...byId.values()].sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
  const names = [...a.names, ...b.names.filter((x) => !a.names.some((y) => y.name === x.name))];
  const min = (x, y) => (Date.parse(x) <= Date.parse(y) ? x : y);
  const max = (x, y) => (Date.parse(x) >= Date.parse(y) ? x : y);
  return { ...b, ...a, part: a.part ?? b.part, messages, names, started: min(a.started, b.started), updated: max(a.updated, b.updated) };
}

/** What a list of the history shows of a conversation: its first question, its number of messages. */
export function conversationSummary(c) {
  const first = c.messages.find((m) => m.role === "user")?.content ?? "";
  return { question: first.length > 90 ? `${first.slice(0, 89)}…` : first, count: c.messages.length };
}

// --------------------------------------------------------------------------- this browser

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB indisponible"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(CONVERSATIONS)) d.createObjectStore(CONVERSATIONS, { keyPath: "id" }).createIndex("part", "part_id");
      if (!d.objectStoreNames.contains(SETTINGS)) d.createObjectStore(SETTINGS);
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close(); // a later version opened in another tab
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("historique bloqué par un autre onglet"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = "readonly") {
  return (await db()).transaction(name, mode).objectStore(name);
}

/** Change the record `id` of this browser in one transaction (`change(record or undefined)`: the record to put, or null). */
async function update(id, change) {
  const tx = (await db()).transaction(CONVERSATIONS, "readwrite");
  const conversations = tx.objectStore(CONVERSATIONS);
  let out = null;
  return new Promise((resolve, reject) => {
    const get = conversations.get(id);
    get.onsuccess = () => {
      out = change(get.result);
      if (out) conversations.put(out);
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("historique : écriture annulée"));
  });
}

/** Keep a conversation in this browser, as it is now (when it was last written in the network folder kept). */
export async function saveLocal(conversation) {
  const record = { ...normalizeConversation(conversation), part_id: conversation.part?.id ?? "" };
  return update(record.id, (kept) => ({ ...record, synced: kept?.synced ?? null }));
}

/** The conversation `id` of this browser written in the network folder as it was at `updated`. */
export async function markSynced(id, updated) {
  return update(id, (kept) => (kept ? { ...kept, synced: updated } : null));
}

export async function getLocal(id) {
  const record = await request((await store(CONVERSATIONS)).get(id));
  return record ? { ...normalizeConversation(record), synced: record.synced ?? null } : null;
}

/** The conversations of this browser, the latest first. */
export async function listLocal() {
  const all = await request((await store(CONVERSATIONS)).getAll());
  return all.map((r) => ({ ...normalizeConversation(r), synced: r.synced ?? null })).filter((c) => c.id).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

/** The conversations of this browser about the part `partId`, the latest first. */
export async function localFor(partId) {
  const all = await request((await store(CONVERSATIONS)).index("part").getAll(partId));
  return all.map((r) => ({ ...normalizeConversation(r), synced: r.synced ?? null })).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

export async function deleteLocal(id) {
  await request((await store(CONVERSATIONS, "readwrite")).delete(id));
}

async function setting(key) {
  return request((await store(SETTINGS)).get(key));
}

async function setSetting(key, value) {
  const s = await store(SETTINGS, "readwrite");
  await request(value == null ? s.delete(key) : s.put(value, key));
}

// --------------------------------------------------------------------------- the network folder

/** The name of a part's file in the network folder: its file's name, then its hash (found by it under any name). */
export function partFileName(part) {
  const hash = partHash(part);
  if (!hash) return null;
  const stem = String(part.file ?? "").replace(/\.[^./\\]+$/, "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 60);
  return `${stem || "piece"}__${hash.slice(0, 16)}.json`;
}

/** A file of the network folder read: {part, conversations}, or null when it is not one of this history. */
export function parsePartFile(json) {
  let data = null;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (data?.schema !== HISTORY_SCHEMA || !partHash(data.part) || !Array.isArray(data.conversations)) return null;
  const part = { id: data.part.id, file: text(data.part.file) };
  const conversations = data.conversations.map((c) => normalizeConversation({ ...c, part })).filter(Boolean);
  return { part, conversations };
}

/** The file of a part with `conversation` in it, merged with what the file held (`existing`, parsePartFile). */
export function mergePartFile(existing, conversation) {
  const conversations = [...(existing?.conversations ?? [])];
  const i = conversations.findIndex((c) => c.id === conversation.id);
  const { synced, part_id, ...plain } = conversation;
  if (i >= 0) conversations[i] = mergeConversation(plain, conversations[i]);
  else conversations.push(plain);
  const part = { id: conversation.part.id, file: conversation.part.file ?? existing?.part.file ?? null };
  return {
    schema: HISTORY_SCHEMA,
    version: HISTORY_VERSION,
    part,
    updated: conversations.reduce((t, c) => (Date.parse(c.updated) > Date.parse(t) ? c.updated : t), conversation.updated),
    conversations: conversations.map(({ part: _, ...c }) => c).sort((a, b) => Date.parse(a.started) - Date.parse(b.started)),
  };
}

const notFound = (err) => err?.name === "NotFoundError" || err?.name === "TypeMismatchError";
// A file being written (by this PC or another one): missing or unreadable for a moment.
const busyFile = (err) => ["NotFoundError", "NotReadableError", "InvalidStateError"].includes(err?.name);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRIES = 4;

/** The file of the part `part` in the folder `dir`: its handle, found by its hash whatever the file's name; null when none. */
async function partFileHandle(dir, part) {
  const name = partFileName(part);
  if (!name) return null;
  try {
    return await dir.getFileHandle(name);
  } catch (err) {
    if (!notFound(err)) throw err;
  }
  const suffix = name.slice(name.lastIndexOf("__"));
  for await (const entry of dir.values()) if (entry.kind === "file" && entry.name.endsWith(suffix)) return entry;
  return null;
}

/**
 * The file of the part `part` in the folder `dir`, read: {handle (null: no
 * file yet), existing (parsePartFile; null: empty)}. A file being written,
 * by this PC or another one, is read again a moment later; one that stays
 * unreadable is an error, so that it is never replaced by this PC's copy
 * alone (the conversations of the others would be lost).
 */
async function readPart(dir, part) {
  for (let i = 1; ; i++) {
    try {
      const handle = await partFileHandle(dir, part);
      const text = handle ? await (await handle.getFile()).text() : "";
      const existing = text.trim() ? parsePartFile(text) : null;
      if (!text.trim() || existing) return { handle, existing };
      if (i >= TRIES) throw new Error(`le fichier « ${handle.name} » n'est pas un historique lisible : il n'est pas remplacé`);
    } catch (err) {
      if (i >= TRIES || !busyFile(err)) throw err;
    }
    await pause(100 * i);
  }
}

/** The conversations of the part `part` kept in the folder `dir` ([] when none). */
export async function readPartFile(dir, part) {
  return (await readPart(dir, part)).existing?.conversations ?? [];
}

/** Write `conversation` (about a part) in the folder `dir`, merged with what its part's file holds. */
export async function writePartFile(dir, conversation) {
  if (!partHash(conversation.part)) return false;
  const { handle, existing } = await readPart(dir, conversation.part);
  const doc = mergePartFile(existing, conversation);
  const target = handle ?? (await dir.getFileHandle(partFileName(conversation.part), { create: true }));
  const writable = await target.createWritable();
  await writable.write(JSON.stringify(doc, null, 1));
  await writable.close();
  return true;
}

/** Every conversation of the folder `dir`, the latest first ({...conversation, part}); the files that are not of this history are left. */
export async function listFolder(dir) {
  const out = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    for (let i = 1; i <= TRIES; i++) {
      try {
        const parsed = parsePartFile(await (await entry.getFile()).text());
        if (parsed) out.push(...parsed.conversations);
        break;
      } catch (err) {
        // A file being written: read again a moment later; unreadable: the others are listed.
        if (!busyFile(err)) break;
        await pause(100 * i);
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
}

/** Whether this browser can open a folder (Chrome, Edge). */
export const folderSupported = () => typeof globalThis.showDirectoryPicker === "function";

/** The network folder chosen: {handle, name, permission ("granted", "prompt", "denied")}, or null. */
export async function networkFolder() {
  const handle = await setting("network").catch(() => null);
  if (!handle) return null;
  let permission = "prompt";
  try {
    permission = await handle.queryPermission({ mode: "readwrite" });
  } catch {
    // an older handle: asked again
  }
  return { handle, name: handle.name, permission };
}

/** Ask the folder (a click of the user): the network folder from now on. */
export async function chooseNetworkFolder() {
  const handle = await globalThis.showDirectoryPicker({ id: "reader3d-historique-ia", mode: "readwrite" });
  await setSetting("network", handle);
  return handle;
}

/** Ask again for the folder kept (a click of the user: the browser asks after a restart). */
export async function grantNetworkFolder(handle) {
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function forgetNetworkFolder() {
  await setSetting("network", null);
}

/**
 * Write in the network folder the conversations of this browser about a part
 * not written there since they changed. `all`: the conversations of before
 * the folder was chosen too (else they are marked as written, and stay here).
 */
export async function syncFolder(dir, { all = true } = {}) {
  let written = 0;
  for (const { id } of await listLocal()) {
    const c = await getLocal(id); // as it is now: an answer may have come since the list
    if (!c || !partHash(c.part) || (c.synced && Date.parse(c.synced) >= Date.parse(c.updated))) continue;
    if (all) {
      await writePartFile(dir, c);
      written++;
    }
    await markSynced(c.id, c.updated);
  }
  return written;
}
