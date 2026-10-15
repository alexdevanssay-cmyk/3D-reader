// Worker of the feeding zones (see feeding.js): the hot spots of each body of
// a model and the zones they feed, and the risers and the ingate placed for
// the parting line shown (feedclient.js runs a second one of this script for
// those). Plain JavaScript, no bare imports. A worker of its own: the parting
// line (its worker) and the wall thickness (pool) do not wait for it, nor a
// direction chosen by hand for the parting line.

import { FEEDING_VERSION, feedingZones, placeFeeding } from './feeding.js';

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'place') {
      // Bodies: {positions, indices, zones ({zone, sphere, zones, body}), parting (or null), up and process (the
      // orientation of the parting for the casting process: up when cast, fed from the top or from below; else
      // those of the parting, else up along its draw direction, fed from the top)}.
      const result = msg.bodies.map((b) => placeFeeding(b.positions, b.indices, b.zones, { parting: b.parting ?? null, up: b.up ?? null, process: b.process ?? null }));
      postMessage({ type: 'result', id: msg.id, result });
      return;
    }
    if (msg.type !== 'zones') return;
    // Bodies: {positions, indices, sphere (inscribed diameters, or null)} or null (open bodies: no inside).
    // A body whose zones cannot be found: {error} for it alone, the others found all the same.
    const total = Math.max(1, msg.bodies.reduce((n, b) => n + (b?.indices?.length ?? 0), 0));
    let done = 0;
    let last = -1;
    const bodies = msg.bodies.map((b) => {
      if (!b || !b.indices?.length) return null;
      const size = b.indices.length;
      try {
        const { zone, sphere, ...rest } = feedingZones(b.positions, b.indices, {
          sphere: b.sphere ?? null,
          onProgress: (f) => {
            const percent = Math.floor(((done + f * size) / total) * 100);
            if (percent === last) return;
            last = percent;
            postMessage({ type: 'progress', id: msg.id, percent });
          },
        });
        return { ...rest, zone, sphere };
      } catch (err) {
        return { error: err?.message || String(err) };
      } finally {
        done += size;
      }
    });
    const buffers = bodies.flatMap((r) => (r && !r.error ? [r.zone.buffer, r.sphere.buffer] : []));
    postMessage({ type: 'result', id: msg.id, result: { version: FEEDING_VERSION, bodies } }, buffers);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
