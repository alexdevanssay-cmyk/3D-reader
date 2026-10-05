// Worker of the wall thickness pool (see thickpool.js): prepares meshes and
// computes ranges of triangles of them (both passes of thickness.js for each
// range). Plain JavaScript, no bare imports.
//
// Two modes:
// - shared (the page is cross-origin isolated): a mesh is prepared once, in
//   SharedArrayBuffers, by one worker; all the workers read it, and write the
//   thickness straight into shared result arrays (largest value kept with an
//   atomic compare-and-swap).
// - copies: each worker receives its own copy of the meshes, prepares them,
//   and returns the values of each range.

import { ballPass, coverPass, prepareMesh, withQueries } from './thickness.js';

const meshes = new Map(); // key -> {positions, indices} (copies), or the prepared mesh
const sharedAlloc = (Type, n) => new Type(new SharedArrayBuffer(n * Type.BYTES_PER_ELEMENT));

// Largest value of a triangle, kept atomically: positive floats compare like
// their bits read as integers.
const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
function atomicRaise(bits) {
  return (f, value) => {
    f32[0] = value;
    const want = i32[0];
    for (;;) {
      const old = Atomics.load(bits, f);
      if (old >= want || Atomics.compareExchange(bits, f, old, want) === old) return;
    }
  };
}

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
    if (msg.type === 'prepare') {
      // Shared mode: the prepared mesh, in SharedArrayBuffers, for all the workers.
      const { query, ...data } = prepareMesh(msg.positions, msg.indices, sharedAlloc);
      postMessage({ type: 'result', id: msg.id, prepared: data });
      return;
    }
    if (msg.type !== 'range') return;
    let last = -1;
    const progress = (f) => {
      const percent = Math.floor(f * 100);
      if (percent === last) return;
      last = percent;
      postMessage({ type: 'progress', id: msg.id, fraction: f });
    };
    if (msg.shared) {
      let mesh = meshes.get(msg.key);
      if (!mesh) meshes.set(msg.key, (mesh = withQueries(msg.shared.prepared)));
      const { ray, sphere, sphereBits } = msg.shared;
      const raiseTo = atomicRaise(sphereBits);
      const { samples } = ballPass(mesh, msg.from, msg.to, (f) => progress(0.8 * f), { ray, sphere, raiseTo });
      coverPass(mesh, samples, sphere, 0, samples.length / 7, (f) => progress(0.8 + 0.2 * f), raiseTo);
      postMessage({ type: 'result', id: msg.id });
      return;
    }
    let mesh = meshes.get(msg.key);
    if (!mesh.query) meshes.set(msg.key, (mesh = prepareMesh(mesh.positions, mesh.indices)));
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
