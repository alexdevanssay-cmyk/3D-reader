// The real cycle times measured in production (the "Retour d'expérience" of
// the Chiffrage page) shared on the company network, so that the history of
// cycle times grows with the times measured on every PC. Each one saved is
// also written in the subfolder "retours-experience" of the shared folder
// (network-folder.js), one file per record, never written over:
//   <reference>__<island>__<date>__<random id>.json
//   {schema: "reader3d-historique-cycles", version: 1, pieces: [record]}  (history.js)
// The files of that folder are read when the Chiffrage or Paramètres page is
// shown (and on "Actualiser"), their records merged into the history of this
// browser: a record of the same reference and source replaces the one kept
// only when it is newer, so those this PC wrote, read back, change nothing.
// A record that could not be written (the access to the folder to grant, the
// network down) waits in this browser, written at the next reading.

import { FileExistsError, SUBFOLDERS, fileNames, notFound, sharedDir, sharedFolder, writeFile } from "../network-folder.js";
import { exportHistory, mergeHistory, validateHistory } from "./history.js";

const PENDING = "reader3d.reseau.retours-a-ecrire.v1"; // [record]: saved while the folder could not be written

const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(16).slice(2)}0000000000`).replace(/-/g, "").slice(0, 8);
// A part of a file name: letters, digits, ".", "_" and "-" only (what any file system takes).
const namePart = (s, n) => String(s ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, n);

/** The name of the file of a record: its reference, its island, its date (UTC) and a random id. */
export function feedbackFileName(record, id = randomId()) {
  const t = Date.parse(record.date ?? "");
  const date = new Date(Number.isFinite(t) ? t : Date.now()).toISOString().slice(0, 19).replace(/:/g, "-");
  return `${namePart(record.ref, 60) || "sans-reference"}__${namePart(record.ilot, 20) || "ilot"}__${date}__${namePart(id, 16)}.json`;
}

/** The file of a record, in the format of the history files (an import of it gives the record). */
export const feedbackFile = (record) => `${JSON.stringify(exportHistory([record]), null, 1)}\n`;

/**
 * Write the record in the folder `dir` in a file of its own: never over a
 * file there (another name then), read back once written. Resolves to its name.
 */
export async function writeRecord(dir, record) {
  const text = feedbackFile(record);
  for (let i = 1; ; i++) {
    const name = feedbackFileName(record);
    try {
      await writeFile(dir, name, text, { overwrite: false, check: async (file) => (await file.text()) === text });
      return name;
    } catch (err) {
      if (!(err instanceof FileExistsError) || i >= 3) throw err;
    }
  }
}

// --------------------------------------------------------------------------- waiting in this browser

function pending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setPending(list) {
  try {
    if (list.length) localStorage.setItem(PENDING, JSON.stringify(list));
    else localStorage.removeItem(PENDING);
  } catch {
    // storage blocked: written again only during this visit
  }
}

/** The records saved on this PC not written in the folder yet. */
export const pendingCount = () => pending().length;

/**
 * Write a record saved from the Retour d'expérience in the shared folder.
 * Resolves to {state}: "written" (name: its file), "none" (no shared folder:
 * nothing to do) or "pending" (kept here, written at the next reading of the
 * folder; error: why not now).
 */
export async function writeFeedback(record) {
  if (!(await sharedFolder())) return { state: "none" };
  try {
    const dir = await sharedDir(SUBFOLDERS.retours);
    if (!dir) throw new Error("accès au dossier à autoriser");
    return { state: "written", name: await writeRecord(dir, record) };
  } catch (err) {
    setPending([...pending(), record]);
    return { state: "pending", error: err?.message || String(err) };
  }
}

// --------------------------------------------------------------------------- reading

// The files merged during this visit (name -> "size|date"): read again only when they change.
const seen = new Map();

/** Read every file of the folder again at the next reading (the history of this browser erased). */
export const forgetRead = () => seen.clear();

/**
 * The records of the files of the folder `dir` merged into `existing`
 * (mergeHistory, the newer only); a file already merged and unchanged since
 * (`read`: name -> stamp) is not read again. Resolves to {pieces, files (read),
 * records, added, replaced, unreadable (names: being written, or not a history)}.
 */
export async function mergeFolder(dir, existing, read = new Map()) {
  let pieces = existing;
  const out = { files: 0, records: 0, added: 0, replaced: 0, unreadable: [] };
  for (const name of await fileNames(dir, (n) => n.endsWith(".json"))) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      const stamp = `${file.size}|${file.lastModified}`;
      if (read.get(name) === stamp) continue;
      const { pieces: records } = validateHistory(JSON.parse(await file.text()));
      const merged = mergeHistory(pieces, records, { newer: true });
      pieces = merged.pieces;
      out.files++;
      out.records += records.length;
      out.added += merged.added;
      out.replaced += merged.replaced;
      read.set(name, stamp);
    } catch (err) {
      if (!notFound(err)) out.unreadable.push(name); // removed since: nothing to say
    }
  }
  return { pieces, ...out };
}

let syncing = null;

/**
 * The shared folder and the history of this browser brought together: the
 * records waiting written, then the files of the folder merged (`load()` the
 * records of this browser, `save(pieces)` them). One reading at a time.
 * Resolves to {state: "none" | "prompt" (access to grant) | "error" (error) |
 * "done", at, written, files, records, added, replaced, unreadable, waiting}.
 */
export function syncFeedback({ load, save }) {
  syncing ??= (async () => {
    const folder = await sharedFolder();
    if (!folder) return { state: "none" };
    if (folder.permission !== "granted") return { state: "prompt", waiting: pendingCount() };
    try {
      const dir = await sharedDir(SUBFOLDERS.retours);
      const done = new Set();
      for (const record of pending()) {
        try {
          await writeRecord(dir, record);
          done.add(JSON.stringify(record));
        } catch {
          // left for the next reading
        }
      }
      // Those written taken out (one saved meanwhile stays).
      const left = pending().filter((r) => !done.has(JSON.stringify(r)));
      setPending(left);
      const written = done.size;
      const merged = await mergeFolder(dir, load(), seen);
      if (merged.added || merged.replaced) save(merged.pieces);
      const { pieces, ...report } = merged;
      return { state: "done", at: new Date().toISOString(), written, waiting: left.length, ...report };
    } catch (err) {
      return { state: "error", error: err?.message || String(err), waiting: pendingCount() };
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}
