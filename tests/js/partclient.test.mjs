// The parting worker client (web/engine/partclient.js): one job at a time in
// the worker, the jobs of a model no longer shown dropped. A stand-in for the
// Worker of the browser.
//
//   node --test tests/js/partclient.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

class FakeWorker {
  static all = [];
  constructor() {
    this.posted = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }
  postMessage(message) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** The answer to the job it was last given. */
  reply(result) {
    this.onmessage({ data: { type: 'result', id: this.posted.at(-1).id, result } });
  }
  progress(percent) {
    this.onmessage({ data: { type: 'progress', id: this.posted.at(-1).id, percent } });
  }
}

const hadWorker = 'Worker' in globalThis;
const previous = globalThis.Worker;
globalThis.Worker = FakeWorker;
after(() => {
  if (hadWorker) globalThis.Worker = previous;
  else delete globalThis.Worker;
});

const { cancelParting, computeParting, evaluateDirection } = await import('../../web/engine/partclient.js');
const body = { positions: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]) };

test('the long proposal of a closed tab does not hold up the jobs of another one', async () => {
  const closed = {}, shown = {};
  const progress = [];
  const proposal = computeParting([body, null], { owner: closed, onProgress: ({ percent }) => progress.push(percent) });
  const restore = evaluateDirection(body, [0, 1, 0], { owner: closed });
  const mine = evaluateDirection(body, [1, 0, 0], { owner: shown });
  const [first] = FakeWorker.all;
  // One job at a time in the worker: the others wait, in order.
  assert.deepEqual(first.posted.map((m) => m.type), ['propose']);
  first.progress(40);
  assert.deepEqual(progress, [40]);

  // Its tab closed: its jobs dropped, the one running with its worker.
  cancelParting(closed);
  await assert.rejects(proposal, (err) => err.cancelled === true);
  await assert.rejects(restore, (err) => err.cancelled === true);
  assert.equal(first.terminated, true);
  // The other tab's job, at once in a new worker.
  const second = FakeWorker.all[1];
  assert.deepEqual(second.posted.map((m) => [m.type, m.direction]), [['evaluate', [1, 0, 0]]]);
  second.reply({ summary: 'X' });
  assert.deepEqual(await mine, { summary: 'X' });
});

test('a job waiting dropped: the one running goes on in its worker', async () => {
  const closed = {}, shown = {};
  const worker = FakeWorker.all.at(-1);
  const seen = worker.posted.length;
  const running = evaluateDirection(body, [0, 0, 1], { owner: shown });
  const waiting = evaluateDirection(body, [0, 1, 0], { owner: closed });
  const next = evaluateDirection(body, [1, 0, 0], { owner: shown });
  cancelParting(closed);
  await assert.rejects(waiting, (err) => err.cancelled === true);
  assert.equal(worker.terminated, false);
  worker.reply('Z');
  assert.equal(await running, 'Z');
  // Then the next one, not the one dropped.
  assert.deepEqual(worker.posted.slice(seen).map((m) => m.direction), [[0, 0, 1], [1, 0, 0]]);
  worker.reply('X');
  assert.equal(await next, 'X');
  // Nothing of an owner never given: nothing dropped.
  cancelParting(undefined);
  assert.equal(FakeWorker.all.at(-1), worker);
});
