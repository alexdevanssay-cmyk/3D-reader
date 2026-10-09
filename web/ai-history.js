// History of the conversations of the IA page (ai-workspace.js), per part.
//
// Every conversation answered at least once is kept in this browser
// (IndexedDB "reader3d-ai", the "Historique local" of the page); those about a
// part are also written in a folder of the company network chosen once
// ("Historique réseau", File System Access API: Chrome or Edge), one JSON file
// per conversation, named by its part: a PC never writes over the
// conversations of another one; the same conversation continued on two PCs is
// merged message by message (each one reads its file again after writing it,
// and writes again what the other one's write left out). A part is known by
// the SHA-256 of its file (app.js tab.part, "sha256:<hex>"): the same file,
// under any name, finds its conversations; another version of it is another
// part.
//
// Nothing here goes online: the conversations hold the real names of the
// parts and of the quote (the names are replaced only in what is sent to the
// gateway). They stay on this PC, and in the folder chosen on the network.
//
// The folder on the network: the subfolder "historique-ia" of the shared
// folder of the company (network-folder.js, chosen in Paramètres or in this
// page), once one is chosen. A folder chosen in this page before the shared
// folder existed is still used while there is no shared folder; when one is
// chosen, the conversations of this PC are written in the new place, and those
// of the folder of before are copied there (moveLegacyFolder), then that
// folder is forgotten.

import { SUBFOLDERS, TRIES, chooseSharedFolder, fileNames, notFound, pause, readText, sharedDir, sharedFolder, writeFile } from "./network-folder.js";

export { CHANGED as FOLDER_CHANGED, folderSupported } from "./network-folder.js";

export const HISTORY_SCHEMA = "reader3d-historique-ia";
export const HISTORY_VERSION = 1;
const DB_NAME = "reader3d-ai";
const CONVERSATIONS = "conversations"; // key: id; index "part" on part_id ("" without a part)
const SETTINGS = "settings"; // key: "network" -> the folder chosen in this page before the shared folder

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
  // Costing: the values the AI proposed for a piece (chiffrage/ai-apply.js), the piece they are for, their application.
  const value = (v) => (["number", "string", "boolean"].includes(typeof v) ? v : null);
  if (Array.isArray(m.proposals)) {
    out.proposals = m.proposals.filter((p) => p && typeof p === "object" && typeof p.cle === "string").slice(0, 20).map((p) => ({
      cle: p.cle, valeur: value(p.valeur),
      ...Object.fromEntries(["piece", "cle_piece", "champ", "unite", "source", "justification", "refus", "ilot_mode"].filter((k) => typeof p[k] === "string").map((k) => [k, p[k]])),
    }));
  }
  const t = m.target;
  if (t && typeof t === "object" && Number.isInteger(t.tab)) out.target = { tab: t.tab, file: text(t.file) };
  const a = m.application;
  if (a && typeof a === "object" && typeof a.message === "string") {
    out.application = {
      message: a.message, undone: a.undone === true,
      changes: (Array.isArray(a.changes) ? a.changes : []).filter((x) => x && typeof x.label === "string").map((x) => ({ label: x.label, avant: value(x.avant), apres: value(x.apres), unite: text(x.unite) ?? "" })),
    };
  }
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

/**
 * The name of a file in the network folder: the part's file's name, its hash
 * (by which its files are found, under any name), and the conversation's id:
 * one file per conversation, so that a PC never writes over the conversations
 * of another one. Without `conversationId`: the one file per part of the first
 * version (still read).
 */
export function partFileName(part, conversationId = null) {
  const hash = partHash(part);
  if (!hash) return null;
  const stem = String(part.file ?? "").replace(/\.[^./\\]+$/, "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 60);
  const id = conversationId == null ? "" : `__${String(conversationId).replace(/[^A-Za-z0-9-]+/g, "_").slice(0, 64)}`;
  return `${stem || "piece"}__${hash.slice(0, 16)}${id}.json`;
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

/**
 * The files of the part `part` in the folder `dir` (of its conversations, and
 * the one of the first version), under any of its names; Chrome's .crswap
 * files of a write in progress left out. Each one opened by its name: what the
 * folder lists may be the file as it was before its last write.
 */
async function partFiles(dir, part) {
  const hash = `__${partHash(part).slice(0, 16)}`;
  const names = await fileNames(dir, (n) => n.endsWith(".json") && (n.endsWith(`${hash}.json`) || n.includes(`${hash}__`)));
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

/**
 * A file of the folder read: parsePartFile, or null when empty (created, not
 * written yet). One that does not read as a history: read again a moment
 * later (being written), then an error when `strict` (it is never replaced:
 * what it holds would be lost), else left out.
 */
async function readFile(handle, strict) {
  for (let i = 1; ; i++) {
    const content = await readText(handle);
    if (!content.trim()) return null;
    const parsed = parsePartFile(content);
    if (parsed) return parsed;
    if (i >= TRIES) {
      if (strict) throw new Error(`le fichier « ${handle.name} » n'est pas un historique lisible : il n'est pas remplacé`);
      return null;
    }
    await pause(100 * i);
  }
}

/** The conversations of the part `part` in the folder `dir`, each one once (merged by its id): {handles, conversations}. */
async function readPart(dir, part, own = null) {
  const handles = await partFiles(dir, part);
  const conversations = [];
  for (const handle of handles) {
    const parsed = await readFile(handle, handle.name === own).catch((err) => {
      if (handle.name === own) throw err;
      return null; // unreadable: another conversation's, left as it is
    });
    if (parsed) conversations.push(...parsed.conversations);
  }
  return { handles, conversations: mergeAll(conversations) };
}

/** The conversations of the part `part` kept in the folder `dir` ([] when none). */
export async function readPartFile(dir, part) {
  return (await readPart(dir, part)).conversations;
}

/**
 * Write `conversation` (about a part) in the folder `dir`: in its own file
 * (found by the part's hash and its id, under any name of the part), merged
 * with every copy of it there (another PC may have continued it). Read
 * again once written: another PC writing it at the same moment may have
 * replaced it (the last write wins); written again then, merged with what it
 * wrote. Resolves to false for a part not known by its file's hash (not
 * written).
 */
export async function writePartFile(dir, conversation) {
  if (!partHash(conversation.part)) return false;
  const suffix = partFileName(conversation.part, conversation.id).replace(/^.*?(__[0-9a-f]{16}__)/, "$1");
  for (let attempt = 1; ; attempt++) {
    const handles = await partFiles(dir, conversation.part);
    const mine = handles.find((h) => h.name.endsWith(suffix)) ?? null;
    const { conversations } = await readPart(dir, conversation.part, mine?.name ?? null);
    const copies = conversations.filter((c) => c.id === conversation.id);
    const name = mine?.name ?? partFileName(conversation.part, conversation.id);
    // Read back below: another PC's write meanwhile is merged, never written over by a retry.
    await writeFile(dir, name, JSON.stringify(mergePartFile(copies.length ? { part: conversation.part, conversations: copies } : null, conversation), null, 1), { verify: false });
    const target = await dir.getFileHandle(name);
    const back = (await readFile(target, false).catch(() => null))?.conversations.find((c) => c.id === conversation.id);
    if (back && conversation.messages.every((m) => back.messages.some((k) => k.id === m.id))) return true;
    if (attempt >= TRIES) throw new Error("la discussion est écrite en même temps par un autre poste : réessayé plus tard");
    await pause(150 * attempt + Math.random() * 300);
  }
}

/** Every conversation of the folder `dir`, the latest first ({...conversation, part}); the files that are not of this history are left. */
export async function listFolder(dir) {
  const out = [];
  for (const name of await fileNames(dir, (n) => n.endsWith(".json"))) {
    try {
      const parsed = parsePartFile(await readText(await dir.getFileHandle(name)));
      if (parsed) out.push(...parsed.conversations);
    } catch {
      // unreadable, or removed since: the others are listed
    }
  }
  return mergeAll(out).sort(latestFirst);
}

/**
 * The folder of the history on the network, or null when none is chosen:
 * {handle, name, permission ("granted", "prompt", "denied"), shared, legacy, error}.
 *   shared     -- true: the shared folder of the company (`name`), the
 *                 conversations in its subfolder "historique-ia"; false: the
 *                 folder chosen in this page before the shared folder
 *   handle     -- the access granted: the folder of the conversations; else
 *                 the folder to ask the access of (grantNetworkFolder)
 *   legacy     -- with the shared folder: the name of the folder chosen in
 *                 this page before, its conversations still to copy (moveLegacyFolder)
 *   error      -- the shared folder granted but not reachable (permission "prompt" then)
 */
export async function networkFolder() {
  const legacy = await setting("network").catch(() => null);
  const shared = await sharedFolder();
  if (shared) {
    const out = { handle: shared.handle, name: shared.name, permission: shared.permission, shared: true, legacy: legacy?.name ?? null, error: null };
    if (shared.permission !== "granted") return out;
    try {
      const dir = await sharedDir(SUBFOLDERS.ia);
      return dir ? { ...out, handle: dir } : { ...out, permission: "prompt" };
    } catch (err) {
      return { ...out, permission: "prompt", error: err?.message || String(err) };
    }
  }
  if (!legacy) return null;
  let permission = "prompt";
  try {
    permission = await legacy.queryPermission({ mode: "readwrite" });
  } catch {
    // an older handle: asked again
  }
  return { handle: legacy, name: legacy.name, permission, shared: false, legacy: null, error: null };
}

/**
 * Ask the folder (a click of the user): the shared folder of the company from
 * now on (network-folder.js), also chosen in Paramètres. Resolves to the folder
 * of the conversations in it, those of the folder of before copied there.
 */
export async function chooseNetworkFolder() {
  await chooseSharedFolder();
  const dir = await sharedDir(SUBFOLDERS.ia);
  if (!dir) throw new Error("accès au dossier refusé");
  await moveLegacyFolder(dir).catch(() => null);
  return dir;
}

/** Ask again for the folder kept (a click of the user: the browser asks after a restart). */
export async function grantNetworkFolder(handle) {
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function forgetNetworkFolder() {
  await setSetting("network", null);
}

/**
 * The conversations of the folder chosen in this page before the shared
 * folder, copied into `dir` (the subfolder "historique-ia" of the shared
 * folder), each one merged with its copy there; then that folder forgotten.
 * Done when its access is granted (`ask`: asked for, on a click), else left
 * for later. Resolves to {copied, failed}, or null (none, or not readable now).
 */
export async function moveLegacyFolder(dir, { ask = false } = {}) {
  const legacy = await setting("network").catch(() => null);
  if (!legacy || !dir) return null;
  let permission = await legacy.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
  if (permission !== "granted" && ask) permission = await legacy.requestPermission({ mode: "readwrite" }).catch(() => "denied");
  if (permission !== "granted") return null;
  let copied = 0;
  let failed = 0;
  if (!(await legacy.isSameEntry(dir).catch(() => false))) {
    for (const conversation of await listFolder(legacy)) {
      try {
        if (await writePartFile(dir, conversation)) copied++;
      } catch {
        failed++;
      }
    }
  }
  if (!failed) await setSetting("network", null);
  return { copied, failed };
}

/**
 * The shared folder just chosen in Paramètres: the conversations of this PC
 * about a part written in its subfolder "historique-ia" — all of them when a
 * folder was used before (they were on the network already), else those of
 * before only when `ask(count)` says so, as when the folder is chosen in the
 * IA page — and those of the folder of before copied there. Resolves to
 * {written, failed, moved}, or null without the access to the folder.
 */
export async function adoptSharedFolder({ ask = () => true } = {}) {
  const dir = await sharedDir(SUBFOLDERS.ia);
  if (!dir) return null;
  const legacy = await setting("network").catch(() => null);
  const moved = await moveLegacyFolder(dir).catch(() => null);
  const before = legacy ? 0 : (await listLocal()).filter((c) => partHash(c.part)).length;
  const all = !before || ask(before);
  return { ...(await syncFolder(dir, { all, force: true })), moved };
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
