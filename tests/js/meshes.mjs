// Synthetic closed meshes shared by the engine tests: unions of cubes,
// extruded profiles, profiles turned about z.

/**
 * Closed mesh of a union of cubes (cells x, y, z of an nx × ny × nz grid where
 * filled(x, y, z)), `size` mm each, every square face cut into `subdivide`²
 * squares. perFace: each planar face with its own vertices (as a CAD body).
 */
export function voxels(filled, [nx, ny, nz], { size = 1, subdivide = 1, perFace = false } = {}) {
  const at = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && filled(x, y, z);
  const positions = [];
  const indices = [];
  const n = subdivide;
  // Vertices by their integer position on the grid of the squares (and their
  // plane, perFace), numbered in the order they are first met.
  const NY = ny * n + 1, NZ = nz * n + 1, cells = (nx * n + 1) * NY * NZ;
  const ids = new Map();
  const vertex = (p, g, plane) => {
    const key = (g[0] * NY + g[1]) * NZ + g[2] + (perFace ? plane * cells : 0);
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(p[0] * size, p[1] * size, p[2] * size);
      ids.set(key, id);
    }
    return id;
  };
  const span = Math.max(nx, ny, nz) + 2;
  const p = [0, 0, 0], g = [0, 0, 0];
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (!at(x, y, z)) continue;
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
      const q = [x, y, z];
      q[k] += s;
      if (at(...q)) continue;
      const a = (k + 1) % 3, b = (k + 2) % 3;
      const base = [x, y, z];
      if (s > 0) base[k] += 1;
      const plane = (2 * k + (s > 0 ? 1 : 0)) * span + base[k];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const corner = (da, db) => {
          p[k] = base[k];
          p[a] = base[a] + (i + da) / n;
          p[b] = base[b] + (j + db) / n;
          g[k] = base[k] * n;
          g[a] = base[a] * n + i + da;
          g[b] = base[b] * n + j + db;
          return vertex(p, g, plane);
        };
        const p00 = corner(0, 0), p10 = corner(1, 0), p11 = corner(1, 1), p01 = corner(0, 1);
        if (s > 0) indices.push(p00, p10, p11, p00, p11, p01);
        else indices.push(p00, p11, p10, p00, p01, p11);
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/**
 * A profile (x, z), counter-clockwise and star-shaped from `kernel`, extruded
 * along y over `depth`: its two flat faces as fans of long triangles, each
 * side one quad, every face with its own vertices (the mesh of a CAD body).
 */
export function prism(profile, depth, kernel) {
  const positions = [];
  const indices = [];
  const vertex = (x, y, z) => positions.push(x, y, z) / 3 - 1;
  const n = profile.length;
  for (const [y, sense] of [[0, 1], [depth, -1]]) {
    const k = vertex(kernel[0], y, kernel[1]);
    const ring = profile.map(([x, z]) => vertex(x, y, z));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(...(sense > 0 ? [k, ring[i], ring[j]] : [k, ring[j], ring[i]]));
    }
  }
  for (let i = 0; i < n; i++) {
    const [x0, z0] = profile[i], [x1, z1] = profile[(i + 1) % n];
    const a = vertex(x0, 0, z0), b = vertex(x1, 0, z1), c = vertex(x1, depth, z1), d = vertex(x0, depth, z0);
    indices.push(a, d, c, a, c, b);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Closed mesh of a profile (r, z) turned about z: from ring to ring, closed into a loop or capped at its ends. */
export function revolve(profile, segments, { loop = false, poles = null } = {}) {
  const positions = [];
  const indices = [];
  const rings = profile.map(([r, z]) => {
    const first = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
    }
    return first;
  });
  const n = profile.length;
  for (let k = 0; k < (loop ? n : n - 1); k++) {
    const a = rings[k], b = rings[(k + 1) % n];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  if (poles) {
    const south = positions.push(0, 0, poles[0]) / 3 - 1, north = positions.push(0, 0, poles[1]) / 3 - 1;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      indices.push(south, rings[0] + j, rings[0] + i, north, rings[n - 1] + i, rings[n - 1] + j);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
