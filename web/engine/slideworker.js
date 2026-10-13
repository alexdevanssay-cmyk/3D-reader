// Worker of the slides (see slides.js): the undercuts of the parting line
// shown for a body grouped into slides. Plain JavaScript, no bare imports. A
// worker of its own: the parting line (its worker) and the feeding zones do
// not wait for it. It keeps the last body prepared (its mesh and the
// hierarchy its lines are cast on): another definition of the same body
// (a candidate, a direction typed, faces reassigned, a drawing) casts its
// lines only.

import { analyseSlides, prepareSlides } from './slides.js';

let kept = null; // {key, prepared}: the last body

self.onmessage = ({ data: msg }) => {
  if (msg.type !== 'slides') return;
  try {
    const nt = msg.indices.length / 3;
    let prepared = msg.bodyKey != null && kept?.key === msg.bodyKey && kept.prepared.mesh.nt === nt ? kept.prepared : null;
    if (!prepared) {
      kept = null; // the body before freed first
      prepared = prepareSlides(msg.positions, msg.indices);
      if (msg.bodyKey != null) kept = { key: msg.bodyKey, prepared };
    }
    reply(msg, prepared);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};

function reply(msg, prepared) {
  let last = -1;
  const result = analyseSlides(prepared, {
    direction: msg.direction, mask: msg.mask, flags: msg.flags ?? null, side: msg.side ?? null, draftDeg: msg.draftDeg ?? 1, sig: msg.sig ?? null,
  }, {
    onProgress: (f) => {
      const percent = Math.floor(f * 100);
      if (percent === last) return;
      last = percent;
      postMessage({ type: 'progress', id: msg.id, percent });
    },
  });
  postMessage({ type: 'result', id: msg.id, result }, [result.zone.buffer]);
}
