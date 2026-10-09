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

test("the file of a part in the network folder: its name, then its hash; only a part known by its file's hash", () => {
  assert.equal(partHash(PART), HASH);
  assert.equal(partFileName(PART), `Carter 4711__${HASH.slice(0, 16)}.json`);
  assert.equal(partFileName({ id: PART.id, file: 'a/b:c*?"<>|.stp' }), `a_b_c_.stp`.replace(".stp", "") + `__${HASH.slice(0, 16)}.json`);
  assert.equal(partFileName({ id: PART.id, file: null }), `piece__${HASH.slice(0, 16)}.json`);
  assert.equal(partFileName({ id: "nom:a.step|12", file: "a.step" }), null);
  assert.equal(partHash({ id: "sha256:xyz" }), null);
  assert.equal(parsePartFile("{"), null);
  assert.equal(parsePartFile({ schema: "autre", part: PART, conversations: [] }), null);
});

test("a part's conversations written in the network folder, merged with what another PC wrote; found under another name; listed", async () => {
  const dir = folder({ "notes.txt": "rien", "autre.json": JSON.stringify({ schema: "x" }) });
  const mine = conversation("c1", [message("1", "user", "Q1", "2026-10-09T10:00:00Z"), message("2", "assistant", "R1", "2026-10-09T10:00:00Z")]);
  assert.equal(await writePartFile(dir, mine), true);
  const name = partFileName(PART);
  assert.ok(dir.store.has(name));
  const doc = JSON.parse(dir.store.get(name));
  assert.equal(doc.schema, HISTORY_SCHEMA);
  assert.deepEqual(doc.part, PART);
  assert.equal(doc.conversations[0].part, undefined, "the part once, at the top");
  // Another PC adds its answer to the same conversation, and a conversation of its own.
  const other = { ...mine, messages: [...mine.messages, message("3", "user", "Q2", "2026-10-09T10:05:00Z"), message("4", "assistant", "R2", "2026-10-09T10:05:00Z")], updated: "2026-10-09T10:05:00Z" };
  await writePartFile(dir, other);
  await writePartFile(dir, conversation("c2", [message("5", "user", "Autre", "2026-10-09T11:00:00Z")]));
  // This PC writes its copy again, without the other's answer: kept all the same.
  await writePartFile(dir, mine);
  const read = await readPartFile(dir, PART);
  assert.deepEqual(read.map((c) => [c.id, c.messages.map((m) => m.content)]), [["c1", ["Q1", "R1", "Q2", "R2"]], ["c2", ["Autre"]]]);
  // The file renamed (another name of the part): found by its hash, written there.
  dir.store.set("renommé__" + HASH.slice(0, 16) + ".json", dir.store.get(name));
  dir.store.delete(name);
  await writePartFile(dir, conversation("c3", [message("6", "user", "Q", "2026-10-09T12:00:00Z")], { part: { ...PART, file: "Carter 4711 v2.step" } }));
  assert.deepEqual([...dir.store.keys()].filter((n) => n.endsWith(".json")), ["autre.json", "renommé__" + HASH.slice(0, 16) + ".json"]);
  // Listed, the latest first; the files that are not of this history left.
  const listed = await listFolder(dir);
  assert.deepEqual(listed.map((c) => c.id), ["c3", "c2", "c1"]);
  assert.deepEqual(listed[0].part, { id: PART.id, file: "Carter 4711 v2.step" });
  // A part not known by its hash is not written there.
  assert.equal(await writePartFile(dir, conversation("c4", [message("7", "user", "Q", "2026-10-09T12:00:00Z")], { part: { id: "nom:a.step|1", file: "a.step" } })), false);
  // A file being written (not JSON yet): the others listed.
  dir.store.set("x__0000000000000000.json", "{");
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

test("the network folder: a part written by two PCs at once keeps both; its files under two names read together; an unreadable one never replaced", async () => {
  const dir = folder();
  const name = partFileName(PART);
  const theirs = conversation("theirs", [message("t1", "user", "Leur question", "2026-10-09T10:00:00Z"), message("t2", "assistant", "R", "2026-10-09T10:00:00Z")]);
  // Another PC closes its write right after ours: its file, without our conversation, replaces ours once.
  let raced = false;
  const createWritable = dir.getFileHandle;
  dir.getFileHandle = async (n, options) => {
    const handle = await createWritable.call(dir, n, options);
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
  const mine = conversation("mine", [message("m1", "user", "Ma question", "2026-10-09T10:01:00Z"), message("m2", "assistant", "R", "2026-10-09T10:01:00Z")]);
  assert.equal(await writePartFile(dir, mine), true);
  assert.deepEqual(JSON.parse(dir.store.get(name)).conversations.map((c) => c.id), ["theirs", "mine"]);
  // The same part written under another of its names by another PC: both files read, and listed once each.
  dir.getFileHandle = createWritable;
  const other = `Autre nom__${HASH.slice(0, 16)}.json`;
  dir.store.set(other, JSON.stringify(mergePartFile(null, { ...theirs, messages: [...theirs.messages, message("t3", "user", "Suite", "2026-10-09T10:02:00Z")], updated: "2026-10-09T10:02:00Z" })));
  assert.deepEqual((await readPartFile(dir, PART)).map((c) => [c.id, c.messages.length]).sort(), [["mine", 2], ["theirs", 3]]);
  assert.deepEqual((await listFolder(dir)).map((c) => [c.id, c.messages.length]), [["theirs", 3], ["mine", 2]]);
  // A file that does not read as a history (cut, edited): an error, and the file left as it is.
  dir.store.set(name, "{ coupé");
  await assert.rejects(writePartFile(dir, mine), /n'est pas un historique lisible/);
  assert.equal(dir.store.get(name), "{ coupé");
});
