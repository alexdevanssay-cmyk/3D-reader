// Worker of the parting line (see parting.js): the draw direction proposed
// for each body of a model, and a direction chosen by hand. Plain
// JavaScript, no bare imports. A worker of its own: the analysis of the next
// file (engine worker) and the wall thickness (pool) do not wait for it.
//
// Every job carries the casting process ({plan, alimentation}) and the die
// options ({marges, densite, cavities}) of orientation.js: the die options
// rank the directions (their die block), the process orients each one (up
// when cast; it does not rank them).

import { orientationKey, orientationOf } from './orientation.js';
import { PARTING_VERSION, evaluateParting, lineMesh, partingPieces, proposeParting } from './parting.js';

self.onmessage = ({ data: msg }) => {
  try {
    const process = msg.process ?? null;
    const die = msg.die ?? null;
    if (msg.type === 'propose') {
      // Bodies: {positions, indices, thickness (per triangle, or null)} or null (open bodies: no inside, no parting).
      // A body that cannot be proposed: {error} for it alone, the others proposed all the same.
      const total = Math.max(1, msg.bodies.reduce((n, b) => n + (b?.indices?.length ?? 0), 0));
      let done = 0;
      let last = -1;
      const bodies = msg.bodies.map((b) => {
        if (!b || !b.indices?.length) return null;
        const size = b.indices.length;
        try {
          return proposeParting(b.positions, b.indices, {
            process,
            die,
            thickness: b.thickness ?? null,
            onProgress: (f) => {
              const percent = Math.floor(((done + f * size) / total) * 100);
              if (percent === last) return;
              last = percent;
              postMessage({ type: 'progress', id: msg.id, percent });
            },
          });
        } catch (err) {
          return { error: err?.message || String(err) };
        } finally {
          done += size;
        }
      });
      const buffers = bodies.flatMap((r) => (r && !r.error ? [r.side.buffer, r.flags.buffer, r.segments.buffer] : []));
      // The key of the options the bodies were ranked with: kept with them (partclient.js keptParting).
      postMessage({ type: 'result', id: msg.id, result: { version: PARTING_VERSION, options_key: orientationKey(process, die), bodies } }, buffers);
      return;
    }
    if (msg.type === 'evaluate') {
      const r = evaluateParting(msg.positions, msg.indices, msg.direction, { process, die, thickness: msg.thickness ?? null, up: msg.up ?? null, orient: !!msg.orient });
      postMessage({ type: 'result', id: msg.id, result: r }, [r.side.buffer, r.flags.buffer, r.segments.buffer]);
      return;
    }
    if (msg.type === 'pieces') {
      // The triangles its parting line crosses, cut where it crosses them: the colours of the halves (the edges of shadows cast again).
      const { side, flags, plane, fixed, height } = msg;
      const r = partingPieces(lineMesh(msg.positions, msg.indices), side, msg.direction, { flags, plane, fixed, height });
      postMessage({ type: 'result', id: msg.id, result: r }, [r.tri.buffer, r.half.buffer, r.undercut.buffer, r.near.buffer, r.start.buffer, r.points.buffer]);
      return;
    }
    if (msg.type === 'orient') {
      // The orientation alone of a direction (a line drawn by hand, the score again with the thickness).
      const orientation = orientationOf(msg.positions, msg.indices, msg.direction, { process, die, thickness: msg.thickness ?? null, up: msg.up ?? null });
      postMessage({ type: 'result', id: msg.id, result: { orientation, options_key: orientationKey(process, die) } });
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
