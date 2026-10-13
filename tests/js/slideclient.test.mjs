// The slides worker (web/engine/slideworker.js) and its client
// (web/engine/slideclient.js): one job at a time, a job waiting for a body
// replaced by the next definition of that body, the job running never
// stopped for that, the jobs of a model no longer shown dropped; the worker
// keeps the last body prepared. Stand-ins for the Worker of the browser and
// for the global scope of a worker.
//
//   node --test tests/js/slideclient.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { evaluateParting } from '../../web/engine/parting.js';
import { analyseSlides, prepareSlides, slidesSignature, undercutMask } from '../../web/engine/slides.js';
import { voxels } from './meshes.mjs';

class FakeWorker {
  static all = [];
  constructor() {
    this.posted = [];
    this.transfers = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }
  postMessage(message, transfer) {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  /** The answer to the job it was last given. */
  reply(result) {
    this.onmessage({ data: { type: 'result', id: this.posted.at(-1).id, result } });
  }
  fail(message) {
    this.onmessage({ data: { type: 'error', id: this.posted.at(-1).id, message } });
  }
  progress(percent) {
    this.onmessage({ data: { type: 'progress', id: this.posted.at(-1).id, percent } });
  }
}

const saved = { Worker: globalThis.Worker, self: globalThis.self, postMessage: globalThis.postMessage };
globalThis.Worker = FakeWorker;
// The scope of the worker script: what it posts, collected.
const posted = [];
globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => posted.push({ message, transfer });
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});

const { cancelSlides, computeSlides } = await import('../../web/engine/slideclient.js');
await import('../../web/engine/slideworker.js');

const body = { positions: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), bodyKey: 'file|0|1' };
const input = (sig) => ({ direction: [0, 0, 1], mask: Uint8Array.from([1]), flags: Uint8Array.from([0]), side: Uint8Array.from([0]), sig });

test('a definition shown after another of the same body replaces the job waiting, never the one running', async () => {
  const model = {};
  const progress = [];
  const first = computeSlides(body, input('s1'), { owner: model, key: '0', onProgress: ({ percent }) => progress.push(percent) });
  const second = computeSlides(body, input('s2'), { owner: model, key: '0' });
  const other = computeSlides(body, input('o1'), { owner: model, key: '1' });
  const third = computeSlides(body, input('s3'), { owner: model, key: '0' });
  const [worker] = FakeWorker.all;
  // One job at a time; the arrays copied, not transferred.
  assert.deepEqual(worker.posted.map((m) => [m.type, m.sig, m.bodyKey]), [['slides', 's1', 'file|0|1']]);
  assert.deepEqual(worker.transfers, [undefined]);
  await assert.rejects(second, (err) => err.cancelled === true);
  worker.progress(40);
  assert.deepEqual(progress, [40]);
  worker.reply({ sig: 's1' });
  assert.deepEqual(await first, { sig: 's1' });
  assert.equal(worker.terminated, false);
  // Then the other body, then the latest definition of the first.
  assert.deepEqual(worker.posted.slice(1).map((m) => m.sig), ['o1']);
  worker.reply({ sig: 'o1' });
  assert.deepEqual(await other, { sig: 'o1' });
  assert.deepEqual(worker.posted.slice(2).map((m) => m.sig), ['s3']);
  worker.fail('broken');
  await assert.rejects(third, /broken/);
});

test('a model no longer shown: its jobs dropped, the one running with its worker; the others go on in a new one', async () => {
  const closed = {}, shown = {};
  const running = computeSlides(body, input('c1'), { owner: closed, key: '0' });
  const waiting = computeSlides(body, input('c2'), { owner: closed, key: '1' });
  const mine = computeSlides(body, input('m1'), { owner: shown, key: '0' });
  const worker = FakeWorker.all.at(-1);
  cancelSlides(closed);
  await assert.rejects(running, (err) => err.cancelled === true);
  await assert.rejects(waiting, (err) => err.cancelled === true);
  assert.equal(worker.terminated, true);
  const fresh = FakeWorker.all.at(-1);
  assert.notEqual(fresh, worker);
  assert.deepEqual(fresh.posted.map((m) => m.sig), ['m1']);
  fresh.reply('M');
  assert.equal(await mine, 'M');
  cancelSlides(undefined);
  assert.equal(FakeWorker.all.at(-1), fresh);
});

test('the body looked at goes ahead of the bodies waiting, behind the job running', async () => {
  const model = {};
  const jobs = ['a', 'b', 'c'].map((sig, k) => computeSlides(body, input(sig), { owner: model, key: String(k + 1) }));
  const card = computeSlides(body, input('card'), { owner: model, key: '0', first: true });
  const worker = FakeWorker.all.at(-1);
  for (const sig of ['a', 'card', 'b', 'c']) {
    assert.equal(worker.posted.at(-1).sig, sig);
    worker.reply(sig);
  }
  assert.deepEqual(await Promise.all([...jobs, card]), ['a', 'b', 'c', 'card']);
});

test('a model closed once its slides are known: the worker idle, keeping its body, ended; for another model, kept', async () => {
  const closed = {}, other = {};
  const done = computeSlides(body, input('k1'), { owner: closed, key: '0' });
  const worker = FakeWorker.all.at(-1);
  worker.reply('K');
  assert.equal(await done, 'K');
  // Idle: another model closed leaves it (and the body it keeps) alone.
  cancelSlides(other);
  assert.equal(worker.terminated, false);
  cancelSlides(closed);
  assert.equal(worker.terminated, true);
  // The next job in a new worker; closing that model again ends nothing more.
  const next = computeSlides(body, input('n1'), { owner: other, key: '0' });
  const fresh = FakeWorker.all.at(-1);
  assert.notEqual(fresh, worker);
  fresh.reply('N');
  assert.equal(await next, 'N');
  cancelSlides(closed);
  assert.equal(fresh.terminated, false);
});

test('the worker: the analysis of a definition, the body kept for the next one, an error reported', () => {
  const mesh = voxels((x, y, z) => !((x < 2 || x >= 8) && y >= 2 && y < 4 && z >= 1 && z < 3), [10, 6, 4], { size: 5 });
  const ev = evaluateParting(mesh.positions, mesh.indices, [0, 0, 1]);
  const mask = undercutMask({ flags: ev.flags });
  const sig = slidesSignature({ nt: mask.length, direction: [0, 0, 1], mask });
  const message = { type: 'slides', id: 7, bodyKey: 'B|0|1120', positions: mesh.positions, indices: mesh.indices, direction: [0, 0, 1], mask, flags: ev.flags, side: ev.side, draftDeg: 1, sig };
  posted.length = 0;
  self.onmessage({ data: message });
  const result = posted.at(-1);
  assert.equal(result.message.type, 'result');
  assert.equal(result.message.id, 7);
  assert.deepEqual(result.transfer, [result.message.result.zone.buffer]);
  const expected = analyseSlides(prepareSlides(mesh.positions, mesh.indices), { direction: [0, 0, 1], mask, flags: ev.flags, side: ev.side, sig });
  assert.deepEqual(result.message.result, expected);
  const progress = posted.filter((p) => p.message.type === 'progress').map((p) => p.message.percent);
  assert.deepEqual(progress, [50, 100]); // two regions
  // The same body, another definition: its prepared body reused (the positions are not read again).
  posted.length = 0;
  self.onmessage({ data: { ...message, id: 8, positions: null, mask: new Uint8Array(mask.length), sig: 'none' } });
  assert.deepEqual([posted.at(-1).message.type, posted.at(-1).message.result.status], ['result', 'none']);
  // A mask of another body: an error, not a crash.
  self.onmessage({ data: { ...message, id: 9, mask: new Uint8Array(3) } });
  assert.deepEqual(posted.at(-1).message, { type: 'error', id: 9, message: 'The undercut mask does not match the body' });
});
