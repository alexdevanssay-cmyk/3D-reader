import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_SCHEMA, conversationSummary, listFolder, mergeConversation, mergePartFile, normalizeConversation,
  parsePartFile, partFileName, partHash, readPartFile, writePartFile,
} from "../../web/ai-history.js";

const HASH = "ab".repeat(32);
const PART = { id: `sha256:${HASH}`, file: "Carter 4711.step" };

/** A folder of the network as the File System Access API gives it, in memory: {name: text}. */
function folder(files = {}) {
  const store = new Map(Object.entries(files));
  const handle = (name) => ({
    kind: "file",
    name,
    async getFile() {
      if (!store.has(name)) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
      const text = store.get(name);
      return { text: async () => text };
    },
    async createWritable() {
      let text = "";
      return { write: async (data) => void (text += data), close: async () => void store.set(name, text) };
    },
  });
  return {
    store,
    async getFileHandle(name, { create = false } = {}) {
      if (!store.has(name)) {
        if (!create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
        store.set(name, "");
      }
      return handle(name);
    },
    async *values() {
      for (const name of [...store.keys()]) yield handle(name);
    },
  };
}

const conversation = (id, messages, over = {}) => normalizeConversation({ id, part: PART, file: PART.file, started: messages[0]?.date, updated: messages.at(-1)?.date, messages, names: [], ...over });
const message = (id, role, content, date) => ({ id, role, content, date });

test("a conversation kept: each message an id and a date given once, a question and its answer the same date", () => {
  const c = normalizeConversation({ file: "a.step", updated: "2026-10-09T10:00:00.000Z", messages: [{ role: "user", content: "Q1" }, { role: "assistant", content: "R1" }, { role: "system", content: "x" }, { role: "user" }] }, "2026-10-09T11:00:00.000Z");
  assert.equal(c.messages.length, 2, "only questions and answers with a text");
  assert.ok(c.id && c.messages.every((m) => m.id));
  assert.deepEqual(c.messages.map((m) => m.date), ["2026-10-09T10:00:00.000Z", "2026-10-09T10:00:00.000Z"]);
  assert.equal(c.part, null);
  assert.equal(c.started, "2026-10-09T10:00:00.000Z");
  // Kept again: the same ids.
  assert.deepEqual(normalizeConversation(c), c);
  assert.equal(normalizeConversation({ messages: "x" }), null);
  assert.equal(normalizeConversation(null), null);
});

test("two copies of a conversation merged: every message once, a question right before its answer, the names of both", () => {
  const a = conversation("c1", [message("1", "user", "Q1", "2026-10-09T10:00:00Z"), message("2", "assistant", "R1", "2026-10-09T10:00:00Z"), message("5", "user", "Q3", "2026-10-09T10:20:00Z"), message("6", "assistant", "R3", "2026-10-09T10:20:00Z")], { names: [{ name: "Dupont", label: "Client" }] });
  const b = conversation("c1", [message("1", "user", "Q1", "2026-10-09T10:00:00Z"), message("2", "assistant", "R1", "2026-10-09T10:00:00Z"), message("3", "user", "Q2", "2026-10-09T10:10:00Z"), message("4", "assistant", "R2", "2026-10-09T10:10:00Z")], { names: [{ name: "Martin", label: "Référence" }] });
  const m = mergeConversation(a, b);
  assert.deepEqual(m.messages.map((x) => x.content), ["Q1", "R1", "Q2", "R2", "Q3", "R3"]);
  assert.deepEqual(m.names.map((n) => n.name), ["Dupont", "Martin"]);
  assert.equal(m.started, a.started);
  assert.equal(m.updated, a.updated);
  assert.equal(mergeConversation(a, null), a);
  assert.deepEqual(conversationSummary(m), { question: "Q1", count: 6 });
  assert.equal(conversationSummary(conversation("c2", [message("1", "user", "x".repeat(200), "2026-10-09T10:00:00Z")])).question.length, 90);
});

test("the file of a conversation in the network folder: its part's name, the part's hash, its id; only a part known by its file's hash", () => {
  assert.equal(partHash(PART), HASH);
  assert.equal(partFileName(PART, "c1"), `Carter 4711__${HASH.slice(0, 16)}__c1.json`);
  assert.equal(partFileName({ id: PART.id, file: 'a/b:c*?"<>|.stp' }, "x/y"), `a_b_c___${HASH.slice(0, 16)}__x_y.json`);
  assert.equal(partFileName({ id: PART.id, file: null }, "c"), `piece__${HASH.slice(0, 16)}__c.json`);
  // The one file per part of the first version, still read.
  assert.equal(partFileName(PART), `Carter 4711__${HASH.slice(0, 16)}.json`);
  assert.equal(partFileName({ id: "nom:a.step|12", file: "a.step" }, "c"), null);
  assert.equal(partHash({ id: "sha256:xyz" }), null);
  assert.equal(parsePartFile("{"), null);
  assert.equal(parsePartFile({ schema: "autre", part: PART, conversations: [] }), null);
});

test("a part's conversations written in the network folder, one file each; one continued on another PC merged; found under another name; listed", async () => {
  const dir = folder({ "notes.txt": "rien", "autre.json": JSON.stringify({ schema: "x" }) });
  const mine = conversation("c1", [message("1", "user", "Q1", "2026-10-09T10:00:00Z"), message("2", "assistant", "R1", "2026-10-09T10:00:00Z")]);
  assert.equal(await writePartFile(dir, mine), true);
  const c1 = partFileName(PART, "c1");
  const doc = JSON.parse(dir.store.get(c1));
  assert.equal(doc.schema, HISTORY_SCHEMA);
  assert.deepEqual(doc.part, PART);
  assert.deepEqual(doc.conversations.map((c) => [c.id, c.part]), [["c1", undefined]], "the part once, at the top");
  // Another PC continues it, and writes a conversation of its own (its own file).
  const other = { ...mine, messages: [...mine.messages, message("3", "user", "Q2", "2026-10-09T10:05:00Z"), message("4", "assistant", "R2", "2026-10-09T10:05:00Z")], updated: "2026-10-09T10:05:00Z" };
  await writePartFile(dir, other);
  await writePartFile(dir, conversation("c2", [message("5", "user", "Autre", "2026-10-09T11:00:00Z")]));
  assert.ok(dir.store.has(partFileName(PART, "c2")));
  // This PC writes its copy again, without the other's answer: kept all the same.
  await writePartFile(dir, mine);
  const read = await readPartFile(dir, PART);
  assert.deepEqual(read.map((c) => [c.id, c.messages.map((m) => m.content)]).sort(), [["c1", ["Q1", "R1", "Q2", "R2"]], ["c2", ["Autre"]]]);
  // Its file renamed (another name of the part): found by the hash and the id, written there.
  const renamed = `renommé__${HASH.slice(0, 16)}__c1.json`;
  dir.store.set(renamed, dir.store.get(c1));
  dir.store.delete(c1);
  await writePartFile(dir, { ...mine, part: { ...PART, file: "Carter 4711 v2.step" }, messages: [...mine.messages, message("6", "user", "Q3", "2026-10-09T12:00:00Z")], updated: "2026-10-09T12:00:00Z" });
  assert.deepEqual([...dir.store.keys()].filter((n) => n.endsWith(".json")).sort(), ["autre.json", partFileName(PART, "c2"), renamed].sort());
  // A file of the first version (one per part): read with the others, each conversation once.
  dir.store.set(partFileName(PART), JSON.stringify(mergePartFile(null, conversation("c0", [message("0", "user", "Ancienne", "2026-10-08T10:00:00Z")]))));
  const listed = await listFolder(dir);
  assert.deepEqual(listed.map((c) => c.id), ["c1", "c2", "c0"]);
  assert.deepEqual(listed[0].messages.map((m) => m.content), ["Q1", "R1", "Q2", "R2", "Q3"]);
  // A part not known by its hash is not written there.
  assert.equal(await writePartFile(dir, conversation("c4", [message("7", "user", "Q", "2026-10-09T12:00:00Z")], { part: { id: "nom:a.step|1", file: "a.step" } })), false);
  // A file being written (not JSON yet): the others listed.
  dir.store.set(`x__${HASH.slice(0, 16)}__z.json`, "{");
  assert.equal((await listFolder(dir)).length, 3);
  assert.deepEqual(mergePartFile(null, conversation("c9", [])).conversations.map((c) => c.id), ["c9"]);
});

test("messages of an earlier version, without id: the same ids at every reading, before the questions asked since", () => {
  const legacy = { id: "c1", started: "2026-10-09T09:00:00.000Z", updated: "2026-10-09T09:05:00.000Z", messages: [{ role: "user", content: "Ancienne" }, { role: "assistant", content: "R0" }, { id: "n1", role: "user", content: "Nouvelle", date: "2026-10-09T09:00:00.000Z" }, { id: "n2", role: "assistant", content: "R1", date: "2026-10-09T09:00:00.000Z" }] };
  const a = normalizeConversation(legacy);
  const b = normalizeConversation(legacy);
  assert.deepEqual(a.messages.map((m) => m.id), ["c1:0", "c1:1", "n1", "n2"]);
  assert.deepEqual(b, a);
  // Merged with itself (this PC's and the folder's copies): each message once, the old exchange first.
  assert.deepEqual(mergeConversation(a, b).messages.map((m) => m.content), ["Ancienne", "R0", "Nouvelle", "R1"]);
});

test("a message from the folder is kept with its known fields of their types only", () => {
  const c = normalizeConversation({ id: "c", messages: [
    { id: "1", role: "assistant", content: "x", date: "2026-10-09T10:00:00Z", costing: true, numbers: "12", names: [["Corps 1", "Carter"], ["bad"]], local: "yes", provider: "Groq", onclick: "alert(1)" },
    { id: "2", role: "assistant", content: "y", date: "2026-10-09T10:00:00Z", costing: { verifiee: false, nombres: 2, inconnus: ["7,5", 3] }, numbers: ["9"] },
  ] });
  assert.deepEqual(c.messages[0], { id: "1", role: "assistant", content: "x", date: "2026-10-09T10:00:00Z", provider: "Groq", names: [["Corps 1", "Carter"]] });
  assert.deepEqual(c.messages[1].costing, { verifiee: false, nombres: 2, inconnus: ["7,5"] });
  assert.deepEqual(c.messages[1].numbers, ["9"]);
});

test("the network folder: a conversation written by two PCs at once keeps both their messages; another conversation's unreadable file left; its own never replaced", async () => {
  const dir = folder();
  const name = partFileName(PART, "shared");
  const theirs = conversation("shared", [message("t1", "user", "Leur question", "2026-10-09T10:00:00Z"), message("t2", "assistant", "R", "2026-10-09T10:00:00Z")]);
  // Another PC closes its write right after ours: its copy, without our messages, replaces ours once.
  let raced = false;
  const getFileHandle = dir.getFileHandle;
  dir.getFileHandle = async (n, options) => {
    const handle = await getFileHandle.call(dir, n, options);
    const write = handle.createWritable;
    handle.createWritable = async () => {
      const w = await write.call(handle);
      const close = w.close;
      w.close = async () => {
        await close();
        if (!raced) {
          raced = true;
          dir.store.set(n, JSON.stringify(mergePartFile(null, theirs)));
        }
      };
      return w;
    };
    return handle;
  };
  const mine = conversation("shared", [message("m1", "user", "Ma question", "2026-10-09T10:01:00Z"), message("m2", "assistant", "R", "2026-10-09T10:01:00Z")]);
  assert.equal(await writePartFile(dir, mine), true);
  assert.deepEqual(JSON.parse(dir.store.get(name)).conversations[0].messages.map((m) => m.id), ["t1", "t2", "m1", "m2"]);
  dir.getFileHandle = getFileHandle;
  // Another conversation's file that does not read: left as it is, this one written all the same.
  const broken = partFileName(PART, "autre");
  dir.store.set(broken, "{ coupé");
  assert.equal(await writePartFile(dir, conversation("c5", [message("c5", "user", "Q", "2026-10-09T11:00:00Z")])), true);
  assert.equal(dir.store.get(broken), "{ coupé");
  // Its own file that does not read (cut, edited): an error, and the file left as it is.
  dir.store.set(name, "{ coupé");
  await assert.rejects(writePartFile(dir, mine), /n'est pas un historique lisible/);
  assert.equal(dir.store.get(name), "{ coupé");
});
