// Worker of the parting line (see parting.js): the draw direction proposed
// for each body of a model, and a direction chosen by hand. Plain
// JavaScript, no bare imports. A worker of its own: the analysis of the next
// file (engine worker) and the wall thickness (pool) do not wait for it.

import { PARTING_VERSION, evaluateParting, proposeParting } from './parting.js';

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'propose') {
      // Bodies: {positions, indices} or null (open bodies: no inside, no parting).
      const total = Math.max(1, msg.bodies.reduce((n, b) => n + (b ? b.indices.length : 0), 0));
      let done = 0;
      let last = -1;
      const bodies = msg.bodies.map((b) => {
        if (!b || !b.indices.length) return null;
        const size = b.indices.length;
        const result = proposeParting(b.positions, b.indices, {
          onProgress: (f) => {
            const percent = Math.floor(((done + f * size) / total) * 100);
            if (percent === last) return;
            last = percent;
            postMessage({ type: 'progress', id: msg.id, percent });
          },
        });
        done += size;
        return result;
      });
      const buffers = bodies.flatMap((r) => (r ? [r.side.buffer, r.flags.buffer, r.segments.buffer] : []));
      postMessage({ type: 'result', id: msg.id, result: { version: PARTING_VERSION, bodies } }, buffers);
      return;
    }
    if (msg.type === 'evaluate') {
      const r = evaluateParting(msg.positions, msg.indices, msg.direction);
      postMessage({ type: 'result', id: msg.id, result: r }, [r.side.buffer, r.flags.buffer, r.segments.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
