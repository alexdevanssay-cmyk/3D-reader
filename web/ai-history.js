// History of the conversations of the IA page (ai-workspace.js), per part.
//
// Every conversation answered at least once is kept in this browser
// (IndexedDB "reader3d-ai", the "Historique local" of the page); those about a
// part are also written in a folder of the company network chosen once
// ("Historique réseau", File System Access API: Chrome or Edge), one JSON file
// per part, merged message by message: two PCs writing about the same part
// keep both their messages (each one reads the file again after writing it,
// and writes again what the other one's write left out). A part is known by
// the SHA-256 of its file (app.js tab.part, "sha256:<hex>"): the same file,
// under any name, finds its conversations; another version of it is another
// part.
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
 * A message as it is kept: its known fields, of their types (a file of the
 * network folder may come from another version of the page, or be edited).
 */
function cleanMessage(m, id, date) {
  const out = { id, role: m.role, content: m.content, date };
  if (time(m.answered)) out.answered = m.answered;
  for (const k of ["provider", "model", "gateway", "notice"]) if (typeof m[k] === "string") out[k] = m[k];
  for (const k of ["local", "amounts"]) if (m[k] === true) out[k] = true;
  const c = m.costing;
  if (c && typeof c === "object" && Array.isArray(c.inconnus)) {
    out.costing = { verifiee: c.verifiee === true, nombres: Number.isFinite(c.nombres) ? c.nombres : 0, inconnus: c.inconnus.filter((x) => typeof x === "string") };
  }
  if (Array.isArray(m.numbers)) out.numbers = m.numbers.filter((x) => typeof x === "string");
  if (Array.isArray(m.names)) out.names = m.names.filter((n) => Array.isArray(n) && n.length === 2 && n.every((x) => typeof x === "string"));
  return out;
}

/**
 * A conversation as it is kept, from what was stored (this browser, a file of
 * the network folder, a version of the page before): {id, part: {id, file} |
 * null, file, started, updated, messages, names}. Every message has an id and
 * a date (`at`: when it was written, else when the conversation started); a
 * question and its answer share the date of the question, so that a merge
 * never parts them. The messages of a version before, without id, get the
 * same ones at every reading ("<conversation>:<rank>"): two copies of them
 * merge. Null when it is not a conversation.
 */
export function normalizeConversation(data, at = new Date().toISOString()) {
  if (!data || typeof data !== "object" || !Array.isArray(data.messages)) return null;
  const part = data.part && typeof data.part.id === "string" ? { id: data.part.id, file: text(data.part.file) } : null;
  const id = text(data.id) ?? newId();
  const fallback = time(data.started) ?? time(data.updated) ?? at;
  let asked = fallback;
  const messages = data.messages
    .filter((m) => m && typeof m === "object" && typeof m.content === "string" && ["user", "assistant"].includes(m.role))
    .map((m, i) => {
      if (m.role === "user") asked = time(m.date) ?? fallback;
      return cleanMessage(m, text(m.id) ?? `${id}:${i}`, time(m.date) ?? asked);
    });
  return {
    id,
    part,
    file: text(data.file) ?? part?.file ?? null,
    started: time(data.started) ?? messages[0]?.date ?? fallback,
    updated: time(data.updated) ?? fallback,
    messages,
    names: Array.isArray(data.names) ? data.names.filter((n) => typeof n?.name === "string" && typeof n?.label === "string") : [],
  };
}

/**
 * Two copies of a conversation as one (this PC's and the network's, two tabs'):
 * every message of both once (by its id), in the order of their dates (a
 * question then its answer), the names of both. `a` gives the rest (the newer one).
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

async function store(name) {
  return (await db()).transaction(name, "readonly").objectStore(name);
}

/**
 * Change the store `name` in one transaction (`act(store)`, its requests
 * made at once; its result given back): done once the transaction is
 * committed (a quota exceeded fails then, not when the request succeeds).
 */
async function write(name, act) {
  const tx = (await db()).transaction(name, "readwrite");
  let out = null;
  return new Promise((resolve, reject) => {
    out = act(tx.objectStore(name), (value) => (out = value));
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("historique : écriture annulée"));
  });
}

/** Change the record `id` of this browser (`change(record or undefined)`: the record to put, or null). */
function update(id, change) {
  return write(CONVERSATIONS, (conversations, result) => {
    const get = conversations.get(id);
    get.onsuccess = () => {
      const out = change(get.result);
      result(out);
      if (out) conversations.put(out);
    };
  });
}

/**
 * Keep a conversation in this browser, merged with what is kept of it (the
 * same conversation may be continued in two tabs or two windows: the
 * messages of both stay). Resolves to the record kept.
 */
export async function saveLocal(conversation) {
  const record = normalizeConversation(conversation);
  return update(record.id, (kept) => {
    const merged = mergeConversation(record, kept ? normalizeConversation(kept) : null);
    return { ...merged, part_id: merged.part?.id ?? "", synced: kept?.synced ?? null };
  });
}

/** The conversation `id` of this browser written in the network folder as it was at `updated` (not when it changed since). */
export async function markSynced(id, updated) {
  return update(id, (kept) => (kept && Date.parse(kept.updated) <= Date.parse(updated) ? { ...kept, synced: updated } : null));
}

const fromRecord = (r) => ({ ...normalizeConversation(r), synced: r.synced ?? null });
const latestFirst = (a, b) => Date.parse(b.updated) - Date.parse(a.updated);

export async function getLocal(id) {
  const record = await request((await store(CONVERSATIONS)).get(id));
  return record ? fromRecord(record) : null;
}

/** The conversations of this browser, the latest first. */
export async function listLocal() {
  return (await request((await store(CONVERSATIONS)).getAll())).map(fromRecord).sort(latestFirst);
}

/** The conversations of this browser about the part `partId`, the latest first. */
export async function localFor(partId) {
  return (await request((await store(CONVERSATIONS)).index("part").getAll(partId))).map(fromRecord).sort(latestFirst);
}

export async function deleteLocal(id) {
  await write(CONVERSATIONS, (conversations) => void conversations.delete(id));
}

async function setting(key) {
  return request((await store(SETTINGS)).get(key));
}

async function setSetting(key, value) {
  await write(SETTINGS, (settings) => void (value == null ? settings.delete(key) : settings.put(value, key)));
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

/** Conversations of several copies as one list: each conversation once (merged by its id). */
function mergeAll(conversations) {
  const byId = new Map();
  for (const c of conversations) byId.set(c.id, mergeConversation(byId.get(c.id), c));
  return [...byId.values()];
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

// A file being written (by this PC or another one): missing or unreadable for a moment.
const busyFile = (err) => ["NotFoundError", "NotReadableError", "InvalidStateError"].includes(err?.name);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRIES = 4;

/** The text of the file `handle`, read again a moment later while it is being written. */
async function readText(handle) {
  for (let i = 1; ; i++) {
    try {
      return await (await handle.getFile()).text();
    } catch (err) {
      if (i >= TRIES || !busyFile(err)) throw err;
    }
    await pause(100 * i);
  }
}

/**
 * The files of the part `part` in the folder `dir`: its own name first, then
 * the others of its hash (the part written under another of its names, by
 * another PC); Chrome's .crswap files of a write in progress left out.
 */
async function partFiles(dir, part) {
  const name = partFileName(part);
  const suffix = name.slice(name.lastIndexOf("__"));
  const names = [];
  for await (const entry of dir.values()) if (entry.kind === "file" && entry.name.endsWith(suffix)) names.push(entry.name);
  names.sort((a, b) => (a === name ? -1 : b === name ? 1 : a.localeCompare(b)));
  // Each one by its name: what the folder lists may be the file as it was before its last write.
  const out = [];
  for (const n of names) {
    try {
      out.push(await dir.getFileHandle(n));
    } catch (err) {
      if (!notFound(err)) throw err; // removed since
    }
  }
  return out;
}

const notFound = (err) => err?.name === "NotFoundError" || err?.name === "TypeMismatchError";

/**
 * The files of the part `part` in the folder `dir`, read: {handles,
 * existing (their conversations merged; null: none, or empty)}. A file that
 * stays unreadable is an error: it is never replaced by this PC's copy alone
 * (the conversations of the others would be lost).
 */
async function readPart(dir, part) {
  const handles = await partFiles(dir, part);
  const conversations = [];
  for (const handle of handles) {
    let parsed = null;
    for (let i = 1; ; i++) {
      const content = await readText(handle);
      if (!content.trim()) break; // created, not written yet: nothing to keep
      parsed = parsePartFile(content);
      if (parsed) break;
      if (i >= TRIES) throw new Error(`le fichier « ${handle.name} » n'est pas un historique lisible : il n'est pas remplacé`);
      await pause(100 * i);
    }
    if (parsed) conversations.push(...parsed.conversations);
  }
  return { handles, existing: conversations.length ? { part, conversations: mergeAll(conversations) } : null };
}

/** The conversations of the part `part` kept in the folder `dir` ([] when none). */
export async function readPartFile(dir, part) {
  return (await readPart(dir, part)).existing?.conversations ?? [];
}

/**
 * Write `conversation` (about a part) in the folder `dir`, merged with what
 * its part's files hold. Read again once written: another PC writing the
 * same file at the same moment may have replaced it (the last write wins);
 * written again then, merged with what it wrote. Resolves to false for a part
 * not known by its file's hash (not written).
 */
export async function writePartFile(dir, conversation) {
  if (!partHash(conversation.part)) return false;
  for (let attempt = 1; ; attempt++) {
    const { handles, existing } = await readPart(dir, conversation.part);
    const target = handles[0] ?? (await dir.getFileHandle(partFileName(conversation.part), { create: true }));
    const writable = await target.createWritable();
    await writable.write(JSON.stringify(mergePartFile(existing, conversation), null, 1));
    await writable.close();
    const back = parsePartFile(await readText(target).catch(() => ""))?.conversations.find((c) => c.id === conversation.id);
    if (back && conversation.messages.every((m) => back.messages.some((k) => k.id === m.id))) return true;
    if (attempt >= TRIES) throw new Error("le fichier de la pièce est écrit en même temps par un autre poste : réessayé plus tard");
    await pause(150 * attempt + Math.random() * 300);
  }
}

/** Every conversation of the folder `dir`, the latest first ({...conversation, part}); the files that are not of this history are left. */
export async function listFolder(dir) {
  const out = [];
  const names = [];
  for await (const entry of dir.values()) if (entry.kind === "file" && entry.name.endsWith(".json")) names.push(entry.name);
  for (const name of names) {
    try {
      const parsed = parsePartFile(await readText(await dir.getFileHandle(name)));
      if (parsed) out.push(...parsed.conversations);
    } catch {
      // unreadable, or removed since: the others are listed
    }
  }
  return mergeAll(out).sort(latestFirst);
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
 * not written there since they changed (`force`: all of them, another folder
 * chosen). `all`: the conversations of before the folder was chosen too (else
 * they are marked as written, and stay here). One that cannot be written is
 * left for the next time; the others are written. Resolves to {written, failed}.
 */
export async function syncFolder(dir, { all = true, force = false } = {}) {
  let written = 0;
  let failed = 0;
  for (const { id } of await listLocal()) {
    const c = await getLocal(id); // as it is now: an answer may have come since the list
    if (!c || !partHash(c.part) || (!force && c.synced && Date.parse(c.synced) >= Date.parse(c.updated))) continue;
    try {
      if (all) {
        await writePartFile(dir, c);
        written++;
      }
      await markSynced(c.id, c.updated);
    } catch {
      failed++;
    }
  }
  return { written, failed };
}
