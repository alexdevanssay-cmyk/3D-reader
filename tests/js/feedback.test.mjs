// The shared folder of the company network (web/network-folder.js): its files
// written to be read by other PCs (read back, tried again, never written
// over when asked); and the real cycle times measured in production shared
// there (web/chiffrage/feedback.js): the names of their files, written one
// per record, those of the folder merged into the history (the newer only).
// Made-up records, a folder in memory (fake-folder.mjs).
//
//   node --test tests/js/feedback.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FileExistsError, fileNames, writeFile } from '../../web/network-folder.js';
import { feedbackFile, feedbackFileName, forgetRead, mergeFolder, syncFeedback, writeRecord } from '../../web/chiffrage/feedback.js';
import { SCHEMA, checkRecord, importHistory, mergeHistory } from '../../web/chiffrage/history.js';
import { chooseFakeFolder, fakeFolder } from './fake-folder.mjs';

const record = (over = {}) => checkRecord({
  ref: 'REF-A', fichier_3d: 'piece_a.stp', source: 'production', ilot: 'CG3', temps_cycle_s: 250, pieces_par_cycle: 1, trs: 0.8,
  poids_kg: 2.5, module_mm: 4.5, noyaux: false, serie: 1000, mise_au_mille: 1.6, date: '2026-06-01T10:20:30.456Z', ...over,
}).record;

test('a file of the folder written: read back; tried again while the network or another PC holds it; never over a file when asked', async () => {
  const dir = fakeFolder({ 'autre.json': 'à un autre poste' });
  assert.equal(await writeFile(dir, 'a.json', 'texte é'), 8);
  assert.equal(dir.text('a.json'), 'texte é');
  // Held by another PC twice: written the third time.
  let held = 2;
  const busy = fakeFolder({}, { hooks: { write: () => { if (held-- > 0) throw Object.assign(new Error('held'), { name: 'NoModificationAllowedError' }); } } });
  await writeFile(busy, 'b.json', 'x');
  assert.equal(busy.writes.get('b.json'), 3);
  // A stream of bytes, made again at each try; its size checked once written.
  const chunks = () => new Blob([new Uint8Array([1, 2]), new Uint8Array([3])]).stream();
  assert.equal(await writeFile(dir, 'c.bin', chunks), 3);
  assert.deepEqual([...dir.files.get('c.bin').bytes], [1, 2, 3]);
  // Never over a file there.
  await assert.rejects(writeFile(dir, 'autre.json', 'mien', { overwrite: false }), FileExistsError);
  assert.equal(dir.text('autre.json'), 'à un autre poste');
  // Read back otherwise than written: an error after a few reads, not a silent loss.
  await assert.rejects(writeFile(dir, 'd.json', 'abc', { check: async () => false, tries: 1 }), /relu différent/);
  // An error that does not pass: thrown at once.
  const denied = fakeFolder({}, { hooks: { write: () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } } });
  await assert.rejects(writeFile(denied, 'e.json', 'x'), /denied/);
  assert.equal(denied.writes.get('e.json'), 1);
  // Listing: the .crswap of a write in progress, and the subfolders, left out.
  dir.files.set('a.json.crswap', { bytes: new Uint8Array(1), lastModified: 1 });
  await dir.getDirectoryHandle('sous-dossier', { create: true });
  assert.deepEqual(await fileNames(dir), ['a.json', 'autre.json', 'c.bin', 'd.json']);
});

test('the file of a real time: its reference, island, date and a random id, in a name any file system takes; the format of the history files', () => {
  const name = feedbackFileName(record(), 'abcd1234');
  assert.equal(name, 'REF-A__CG3__2026-06-01T10-20-30__abcd1234.json');
  assert.match(feedbackFileName(record({ ref: 'Carter: côté "A" / B*?', ilot: 'CG 3' }), 'x'), /^Carter_côté_A_B__CG_3__2026-06-01T10-20-30__x\.json$/);
  assert.match(feedbackFileName(record({ ref: '..' })), /^sans-reference__CG3__2026-06-01T10-20-30__[0-9a-z]{8}\.json$/);
  assert.notEqual(feedbackFileName(record()), feedbackFileName(record()), 'a random id each time');
  assert.ok(feedbackFileName(record({ ref: 'R'.repeat(300) })).length < 120);
  // Its content: a history file of one record, imported as it is.
  const file = JSON.parse(feedbackFile(record()));
  assert.deepEqual([file.schema, file.version, file.pieces], [SCHEMA, 1, [record()]]);
  assert.deepEqual(importHistory([], file).pieces, [record()]);
});

test('a real time written in a file of its own, never over another one', async () => {
  const dir = fakeFolder();
  const first = await writeRecord(dir, record());
  const second = await writeRecord(dir, record());
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(dir.text(first)).pieces, [record()]);
  assert.equal(dir.files.size, 2);
});

test('the files of the folder merged into the history: the newer record only, this PC\'s own not twice, those read already not opened again', async () => {
  const mine = record();
  const dir = fakeFolder({
    'REF-A__CG3__mine.json': feedbackFile(mine),
    'REF-A__CG3__newer.json': feedbackFile(record({ temps_cycle_s: 260, date: '2026-07-01T00:00:00.000Z' })),
    'REF-A__CG3__older.json': feedbackFile(record({ temps_cycle_s: 999, date: '2026-01-01T00:00:00.000Z' })),
    'AUTRE__SSP__x.json': feedbackFile(record({ ref: 'AUTRE', ilot: 'SSP', temps_cycle_s: 40 })),
    'EN-COURS__x.json': '{"schema": "reader3d-histo',
    'notes.txt': 'not read',
  });
  // The files opened, over the network: those not merged yet only, however many the folder holds.
  const opened = [];
  const open = dir.getFileHandle;
  dir.getFileHandle = (name, options) => (opened.push(name), open(name, options));
  const read = new Set();
  const first = await mergeFolder(dir, [mine], read);
  assert.deepEqual([first.files, first.records, first.added, first.replaced], [4, 4, 1, 1]);
  assert.deepEqual(first.unreadable, ['EN-COURS__x.json']);
  assert.deepEqual(first.pieces.map((r) => [r.ref, r.temps_cycle_s]), [['REF-A', 260], ['AUTRE', 40]]);
  assert.deepEqual(first.incoming.map((r) => r.temps_cycle_s).sort(), [250, 260, 40, 999]);
  assert.equal(opened.length, 5);
  // Read again: only the file being written, now written; those merged not even opened.
  opened.length = 0;
  dir.files.set('EN-COURS__x.json', { bytes: new TextEncoder().encode(feedbackFile(record({ ref: 'EN-COURS' }))), lastModified: 99 });
  const again = await mergeFolder(dir, first.pieces, read);
  assert.deepEqual([again.files, again.added, again.replaced, again.unreadable], [1, 1, 0, []]);
  assert.equal(again.pieces.length, 3);
  assert.deepEqual(opened, ['EN-COURS__x.json']);
  opened.length = 0;
  const nothing = await mergeFolder(dir, again.pieces, read);
  assert.deepEqual([nothing.files, nothing.added, nothing.replaced, nothing.incoming], [0, 0, 0, []]);
  assert.equal(nothing.pieces, again.pieces);
  assert.deepEqual(opened, []);
});

test('a reading of the shared folder merged into the history as it is once read: an import, a clear made while it reads kept', async () => {
  const retours = fakeFolder({ 'AUTRE__CG3__1.json': feedbackFile(record({ ref: 'AUTRE' })) }, { name: 'retours-experience' });
  chooseFakeFolder(fakeFolder({ 'retours-experience': retours }, { name: 'reseau' }));
  // The history of this browser (store.js), and what the user does while a file is opened over the network.
  let history = [record({ ref: 'LOCAL' })];
  const load = () => history;
  const save = (pieces) => {
    history = pieces;
  };
  let meanwhile = null;
  const open = retours.getFileHandle;
  retours.getFileHandle = async (name, options) => {
    const handle = await open(name, options);
    await new Promise((resolve) => setTimeout(resolve, 10));
    meanwhile?.();
    meanwhile = null;
    return handle;
  };
  const refs = () => history.map((r) => r.ref).sort();

  // A history file imported meanwhile (times of quotes, on this PC only): kept, with the record of the other PC.
  meanwhile = () => {
    history = mergeHistory(history, [record({ ref: 'IMPORTE', source: 'devis' })]).pieces;
  };
  const first = await syncFeedback({ load, save });
  assert.deepEqual([first.state, first.files, first.added, first.replaced], ['done', 1, 1, 0]);
  assert.deepEqual(refs(), ['AUTRE', 'IMPORTE', 'LOCAL']);

  // The history cleared meanwhile: the records of the folder come back, never those of this PC only.
  retours.files.set('TROISIEME__CG3__2.json', { bytes: new TextEncoder().encode(feedbackFile(record({ ref: 'TROISIEME' }))), lastModified: 5 });
  meanwhile = () => {
    history = [];
    forgetRead();
  };
  const second = await syncFeedback({ load, save });
  assert.deepEqual([second.state, second.files, second.added], ['done', 1, 1]);
  assert.deepEqual(refs(), ['TROISIEME']);
  // The file read before the clear: back at the next reading.
  const third = await syncFeedback({ load, save });
  assert.deepEqual([third.files, third.added], [1, 1]);
  assert.deepEqual(refs(), ['AUTRE', 'TROISIEME']);
});
