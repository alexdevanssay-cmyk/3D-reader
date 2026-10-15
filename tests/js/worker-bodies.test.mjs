// The parting and feeding workers (web/engine/partworker.js, feedworker.js)
// with several bodies: one that cannot be computed has {error} of its own,
// the others are computed all the same (the bodies analysed: one bad body
// checked never fails the others, app.js keeps its failure apart). Run here
// with a stand-in for the worker's globals.
//
//   node --test tests/js/worker-bodies.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { voxels } from './meshes.mjs';

const posted = [];
const had = { self: 'self' in globalThis, postMessage: 'postMessage' in globalThis };
const before = { self: globalThis.self, postMessage: globalThis.postMessage };
globalThis.self = {};
globalThis.postMessage = (message) => posted.push(message);
after(() => {
  for (const k of ['self', 'postMessage']) {
    if (had[k]) globalThis[k] = before[k];
    else delete globalThis[k];
  }
});

await import('../../web/engine/partworker.js');
const parting = globalThis.self.onmessage;
await import('../../web/engine/feedworker.js');
const feeding = globalThis.self.onmessage;

/** The answer of a worker to a job: its result (or error) message. */
function run(onmessage, message) {
  posted.length = 0;
  onmessage({ data: { id: 7, ...message } });
  return posted.find((m) => m.type !== 'progress');
}

// A block 6 × 4 × 2 mm, closed; a body whose mesh is broken (no positions): it throws.
const block = voxels(() => true, [6, 4, 2], { subdivide: 2 });
const body = () => ({ positions: Float32Array.from(block.positions), indices: Uint32Array.from(block.indices) });
const broken = () => ({ positions: null, indices: Uint32Array.from(block.indices) });

test('parting: a body that cannot be proposed has its error, the bodies beside it their proposals', () => {
  const answer = run(parting, { type: 'propose', bodies: [body(), broken(), null, body()] });
  assert.equal(answer.type, 'result');
  const [a, b, c, d] = answer.result.bodies;
  assert.ok(a.proposal && d.proposal, 'the healthy bodies proposed');
  assert.equal(typeof b.error, 'string');
  assert.equal(b.proposal, undefined);
  assert.equal(c, null, 'a body not asked for (open, or not checked)');
});

test('feeding: a body whose zones cannot be found has its error, the bodies beside it their zones', () => {
  const answer = run(feeding, { type: 'zones', bodies: [broken(), body()] });
  assert.equal(answer.type, 'result');
  const [a, b] = answer.result.bodies;
  assert.equal(typeof a.error, 'string');
  assert.ok(Array.isArray(b.zones) && ArrayBuffer.isView(b.zone) && ArrayBuffer.isView(b.sphere), 'the healthy body its zones');
});
