// Worker of the wall thickness pool (see thickpool.js): receives the meshes
// once, then computes ranges of triangles of them (both passes of
// thickness.js for each range). Plain JavaScript, no bare imports.

import { ballPass, coverPass, prepareMesh } from './thickness.js';

const meshes = new Map(); // key -> {positions, indices} or the prepared mesh

self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'mesh') {
      meshes.set(msg.key, { positions: msg.positions, indices: msg.indices });
      return;
    }
    if (msg.type === 'clear') {
      meshes.clear();
      return;
    }
    if (msg.type !== 'range') return;
    let mesh = meshes.get(msg.key);
    if (!mesh.query) meshes.set(msg.key, (mesh = prepareMesh(mesh.positions, mesh.indices)));
    let last = -1;
    const progress = (f) => {
      const percent = Math.floor(f * 100);
      if (percent === last) return;
      last = percent;
      postMessage({ type: 'progress', id: msg.id, fraction: f });
    };
    // The balls of the range, then the surface they reach (80 % / 20 % of the work).
    const { ray, sphere, samples } = ballPass(mesh, msg.from, msg.to, (f) => progress(0.8 * f));
    coverPass(mesh, samples, sphere, 0, samples.length / 7, (f) => progress(0.8 + 0.2 * f));
    // The ray only within the range; the balls can reach the whole mesh.
    const rays = ray.slice(msg.from, msg.to);
    postMessage({ type: 'result', id: msg.id, ray: rays, sphere }, [rays.buffer, sphere.buffer]);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
