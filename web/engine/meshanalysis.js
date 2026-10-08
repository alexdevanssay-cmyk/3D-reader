// Topology, volume and repair of triangle meshes.
//
// This is the browser counterpart of reader3d/mesh.py `_mesh_body`, which relies on
// trimesh. Every step reproduces the trimesh call it replaces, with the same
// tolerances, so that both engines reach the same verdict (closed / open, repaired,
// inverted) and the same numbers:
//
//   work.merge_vertices()             -> weldVertices()   positions rounded to 8 decimals
//   work.nondegenerate_faces()        -> isNondegenerate()
//   work.unique_faces()               -> dropDuplicateFaces()
//   work.remove_unreferenced_vertices -> compactVertices()
//   work.is_watertight / is_winding_consistent -> buildEdges() + checks
//   trimesh.repair.fix_winding        -> fixWinding()     BFS over face adjacency
//   trimesh.repair.fill_holes         -> fillHoles()      boundary cycles of 3 or 4 edges
//   mesh.py _shell_volume / area      -> shellProperties() / meshArea()
//
// The volume of a closed mesh is the volume enclosed by its triangles (divergence
// theorem, sum of signed tetrahedra), every shell being oriented on its own: material
// when it lies inside an even number of other shells, a void otherwise. Open meshes
// get no volume unless a few missing triangles can be filled, exactly like the Python
// engine.
//
// Everything runs in linear time on typed arrays (open-addressing hash tables keyed
// on integers), so meshes with millions of triangles are fine.

// trimesh.constants.tol.merge: vertices are merged on 8 decimal digits, faces whose
// 2-D oriented box is thinner than this are degenerate.
const TOL_MERGE = 1e-8;
const MERGE_SCALE = 1e8;
// trimesh.util.TOL_ZERO: a triangle with a smaller cross product has no normal.
const TOL_ZERO = 1e-13;

const INWARDS = 'Normals pointed inwards; volume sign corrected';

/**
 * Analyse the parts produced by meshload.js.
 *
 * @param {Array<{name: string, positions: Float64Array|Float32Array, indices: Uint32Array|null, color: number[]|null}>} parts
 *   positions in mm (world coordinates, analysed in their own precision), indices null
 *   for a non-indexed triangle soup.
 * @returns {object[]} one body per part with triangles (see the result contract in SPEC).
 */
export function analyzeMeshParts(parts, onProgress = null) {
  const bodies = [];
  // Progress, weighted by the size of each part.
  const sizeOf = (p) => (p.indices ? p.indices.length : p.positions.length / 3);
  const total = Math.max(1, parts.reduce((n, p) => n + sizeOf(p), 0));
  let done = 0;
  for (const part of parts) {
    const count = sizeOf(part);
    done += count;
    onProgress?.(done / total);
    if (count < 3) continue; // like mesh.py: geometry without faces is skipped
    const body = analyzeMesh(part.name, part.positions, part.indices ?? null, part.color ?? null);
    // Every face had a non-finite vertex: trimesh removes them on load and mesh.py then
    // skips the empty geometry (it must not pull the envelope to the origin).
    if (body.triangles === 0) continue;
    bodies.push(body);
  }
  return bodies;
}

/**
 * Analyse one triangle mesh (mirror of mesh.py `_mesh_body`).
 *
 * @param {string} name
 * @param {Float32Array|Float64Array|number[]} positions  xyz in mm (analysed in this precision)
 * @param {Uint32Array|Uint16Array|Int32Array|number[]|null} indices  3 per triangle, null = sequential
 * @param {number[]|null} color  sRGB 0..1
 */
export function analyzeMesh(name, positions, indices = null, color = null) {
  // The analysis runs on the given precision; the display copy is always float32.
  const pos = ArrayBuffer.isView(positions) ? positions : Float64Array.from(positions);
  const displayPositions = pos instanceof Float32Array ? pos : Float32Array.from(pos);
  const faces = cleanFaces(pos, indices);
  const notes = [];

  const bbox = referencedBounds(pos, faces);
  const size = Math.max(...bbox.size); // L of the volume and centroid thresholds (mesh.py)
  const work = buildWorkMesh(pos, faces);
  const area = meshArea(work.verts, work.faces);

  let volume = null;
  let centroid = null;
  const edges = buildEdges(work.faces, work.nv);
  const closed = isWatertight(edges, work.faces.length / 3);

  if (closed) {
    if (!isWindingConsistent(edges, work.faces)) {
      fixWinding(work.faces, work.nv, edges);
      notes.push('Inconsistent triangle orientation was repaired');
    }
    const shells = shellProperties(work.verts, work.faces, edges, size);
    if (shells.flipped) notes.push(INWARDS);
    volume = shells.volume;
    centroid = shells.centroid;
  } else {
    const openEdges = countBoundaryEdges(edges);
    const repaired = openEdges ? fillHoles(work.verts, work.faces, work.nv, edges) : null;
    if (repaired) {
      // Small holes (missing triangles) could be closed: give an estimate, unless the
      // filling made up most of the surface (a soup of unwelded triangles "closed" by a
      // reversed twin each) or encloses nothing.
      const repairedEdges = buildEdges(repaired, work.nv);
      if (!isWindingConsistent(repairedEdges, repaired)) fixWinding(repaired, work.nv, repairedEdges);
      const filled = shellProperties(work.verts, repaired, repairedEdges, size);
      const before = work.faces.length / 3;
      const added = repaired.length / 3 - before;
      if (added < before && Math.abs(filled.volume) > 1e-9 * size ** 3) {
        volume = filled.volume;
        centroid = filled.centroid;
        if (filled.flipped) notes.push(INWARDS);
        notes.push(`Mesh was not closed (${openEdges} open edges); volume estimated after filling the holes`);
      }
    }
    if (volume === null) {
      notes.push(
        openEdges
          ? `Mesh is not closed (${openEdges} open edges): the enclosed volume is undefined`
          : 'Mesh has non-manifold edges: the enclosed volume is undefined',
      );
    }
  }

  const mesh = { positions: displayPositions, indices: faces };
  // The display copy is float32. When that rounded the analysed coordinates, they are
  // kept for the oriented envelope (summary.js), which the Python engine measures on
  // its double-precision vertices (far from the origin, float32 would not even resolve
  // the body).
  if (!(pos instanceof Float32Array) && !sameValues(pos, displayPositions)) {
    mesh.positions64 = pos instanceof Float64Array ? pos : Float64Array.from(pos);
  }

  return {
    name,
    volume,
    mesh_volume: volume,
    area,
    bbox,
    centroid,
    closed,
    method: 'mesh',
    color: color ? [color[0], color[1], color[2]] : null,
    triangles: faces.length / 3,
    notes,
    mesh,
  };
}

/** True when the float32 copy holds exactly the analysed coordinates (NaN aside). */
function sameValues(pos, copy) {
  for (let i = 0; i < pos.length; i++) if (pos[i] !== copy[i] && pos[i] === pos[i]) return false;
  return true;
}

// --------------------------------------------------------------------------- input

/**
 * Display faces: drop triangles with an out-of-range index or a non-finite vertex
 * (trimesh removes non-finite values on load). Returns the indices as Uint32Array.
 */
function cleanFaces(pos, indices) {
  const nv = Math.floor(pos.length / 3);
  let faces;
  if (indices == null) {
    faces = new Uint32Array(nv - (nv % 3));
    for (let i = 0; i < faces.length; i++) faces[i] = i;
  } else {
    faces = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    if (faces.length % 3) faces = faces.subarray(0, faces.length - (faces.length % 3));
  }
  const finite = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    finite[i] = Number.isFinite(pos[3 * i]) && Number.isFinite(pos[3 * i + 1]) && Number.isFinite(pos[3 * i + 2]) ? 1 : 0;
  }
  let bad = 0;
  for (let i = 0; i < faces.length; i++) if (faces[i] >= nv || !finite[faces[i]]) bad++;
  if (!bad) return faces;
  const keep = [];
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2];
    if (a < nv && b < nv && c < nv && finite[a] && finite[b] && finite[c]) keep.push(a, b, c);
  }
  return Uint32Array.from(keep);
}

/** Axis-aligned bounds of the vertices used by the faces (trimesh `mesh.bounds`). */
function referencedBounds(pos, faces) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < faces.length; i++) {
    const o = 3 * faces[i];
    for (let k = 0; k < 3; k++) {
      const v = pos[o + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!faces.length) {
    min.fill(0);
    max.fill(0);
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// --------------------------------------------------------------------------- hashing

function nextPow2(n) {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

/** Hash of an integer-valued double (|v| < 2^53): mixes its low and high 32-bit words. */
function mixDouble(h, v) {
  const lo = v | 0; // ToInt32 is exact modulo 2^32 for integers
  const hi = (v / 4294967296) | 0;
  h = Math.imul(h ^ lo, 0x9e3779b1);
  h = (h << 15) | (h >>> 17);
  h = Math.imul(h ^ hi, 0x85ebca77);
  return (h << 13) | (h >>> 19);
}

function mixInt(h, v) {
  h = Math.imul(h ^ v, 0x9e3779b1);
  return (h << 15) | (h >>> 17);
}

function finalize(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** numpy `round()`: round half to even. */
function roundHalfEven(v) {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// --------------------------------------------------------------------------- work mesh

/**
 * The analysis copy of the mesh: welded vertices (float64), faces without degenerate
 * triangles nor duplicates, unreferenced vertices removed. Vertex and face order
 * follow trimesh so that order-dependent steps (winding repair start face, hole
 * cycles) behave the same.
 */
function buildWorkMesh(pos, faces) {
  const { verts: welded, remap } = weldVertices(pos, faces);
  const nf = faces.length / 3;
  const t = new Int32Array(faces.length);
  for (let i = 0; i < faces.length; i++) t[i] = remap[faces[i]];

  // update_faces(nondegenerate_faces())
  let kept = 0;
  for (let f = 0; f < nf; f++) {
    if (isNondegenerate(welded, t[3 * f], t[3 * f + 1], t[3 * f + 2])) {
      t[3 * kept] = t[3 * f];
      t[3 * kept + 1] = t[3 * f + 1];
      t[3 * kept + 2] = t[3 * f + 2];
      kept++;
    }
  }
  // update_faces(unique_faces())
  const unique = dropDuplicateFaces(t, kept);
  // remove_unreferenced_vertices()
  return compactVertices(welded, unique);
}

/**
 * trimesh merge_vertices(merge_tex=True, merge_norm=True): vertices whose positions
 * are equal once multiplied by 1e8 and rounded are merged. The representative is the
 * first occurrence (in vertex order, only referenced vertices are considered) and
 * welded vertices are numbered in order of first occurrence.
 */
export function weldVertices(pos, faces) {
  const n = pos.length / 3;
  const referenced = new Uint8Array(n);
  for (let i = 0; i < faces.length; i++) referenced[faces[i]] = 1;
  let nRef = 0;
  for (let i = 0; i < n; i++) nRef += referenced[i];

  const cap = nextPow2(2 * nRef);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const keys = new Float64Array(3 * nRef);
  const first = new Int32Array(nRef);
  const remap = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!referenced[i]) continue;
    const kx = roundHalfEven(pos[3 * i] * MERGE_SCALE);
    const ky = roundHalfEven(pos[3 * i + 1] * MERGE_SCALE);
    const kz = roundHalfEven(pos[3 * i + 2] * MERGE_SCALE);
    let h = finalize(mixDouble(mixDouble(mixDouble(0x2545f491, kx), ky), kz)) & mask;
    for (;;) {
      const slot = table[h];
      if (slot === -1) {
        table[h] = count;
        keys[3 * count] = kx;
        keys[3 * count + 1] = ky;
        keys[3 * count + 2] = kz;
        first[count] = i;
        remap[i] = count++;
        break;
      }
      if (keys[3 * slot] === kx && keys[3 * slot + 1] === ky && keys[3 * slot + 2] === kz) {
        remap[i] = slot;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  const verts = new Float64Array(3 * count);
  for (let j = 0; j < count; j++) {
    const o = 3 * first[j];
    verts[3 * j] = pos[o];
    verts[3 * j + 1] = pos[o + 1];
    verts[3 * j + 2] = pos[o + 2];
  }
  return { verts, remap };
}

/**
 * trimesh triangles.nondegenerate(height=tol.merge): both sides of the triangle's
 * 2-D oriented bounding box (2*area / edge length, for the edges v0v1 and v0v2)
 * must be longer than 1e-8.
 */
function isNondegenerate(v, a, b, c) {
  const ax = v[3 * a], ay = v[3 * a + 1], az = v[3 * a + 2];
  const bx = v[3 * b], by = v[3 * b + 1], bz = v[3 * b + 2];
  const cx = v[3 * c], cy = v[3 * c + 1], cz = v[3 * c + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az; // v1 - v0
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az; // v2 - v0
  const fx = cx - bx, fy = cy - by, fz = cz - bz; // v2 - v1 (trimesh cross uses (v1-v0) x (v2-v1))
  const nx = e1y * fz - e1z * fy, ny = e1z * fx - e1x * fz, nz = e1x * fy - e1y * fx;
  const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2.0;
  const la = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
  const lb = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
  const h0 = la > TOL_MERGE ? (area * 2) / la : 0;
  const h1 = lb > TOL_MERGE ? (area * 2) / lb : 0;
  return h0 > TOL_MERGE && h1 > TOL_MERGE;
}

/** trimesh unique_faces(): keep the first face of every set of faces with the same 3 vertices. */
function dropDuplicateFaces(t, nf) {
  const cap = nextPow2(2 * nf);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const out = new Int32Array(3 * nf);
  const sorted = new Int32Array(3 * nf); // sorted vertex triple of every kept face
  let count = 0;
  for (let f = 0; f < nf; f++) {
    const a = t[3 * f], b = t[3 * f + 1], c = t[3 * f + 2];
    const s0 = Math.min(a, b, c), s2 = Math.max(a, b, c);
    const s1 = a + b + c - s0 - s2;
    let h = finalize(mixInt(mixInt(mixInt(0x27d4eb2f, s0), s1), s2)) & mask;
    let dup = false;
    for (;;) {
      const slot = table[h];
      if (slot === -1) break;
      if (sorted[3 * slot] === s0 && sorted[3 * slot + 1] === s1 && sorted[3 * slot + 2] === s2) {
        dup = true;
        break;
      }
      h = (h + 1) & mask;
    }
    if (dup) continue;
    table[h] = count;
    out[3 * count] = a;
    out[3 * count + 1] = b;
    out[3 * count + 2] = c;
    sorted[3 * count] = s0;
    sorted[3 * count + 1] = s1;
    sorted[3 * count + 2] = s2;
    count++;
  }
  return out.subarray(0, 3 * count);
}

/** trimesh remove_unreferenced_vertices(): renumber the used vertices, keeping their order. */
function compactVertices(verts, t) {
  const n = verts.length / 3;
  const used = new Int32Array(n).fill(-1);
  for (let i = 0; i < t.length; i++) used[t[i]] = 0;
  let nv = 0;
  for (let i = 0; i < n; i++) if (used[i] === 0) used[i] = nv++;
  const out = new Float64Array(3 * nv);
  for (let i = 0; i < n; i++) {
    const j = used[i];
    if (j < 0) continue;
    out[3 * j] = verts[3 * i];
    out[3 * j + 1] = verts[3 * i + 1];
    out[3 * j + 2] = verts[3 * i + 2];
  }
  const faces = new Int32Array(t.length);
  for (let i = 0; i < t.length; i++) faces[i] = used[t[i]];
  return { verts: out, faces, nv };
}

// --------------------------------------------------------------------------- edges

const NEXT = [1, 2, 0];

/** Start / end vertex of half-edge `he` (edge k of face f is he = 3f + k, from vertex k to k+1). */
const heStart = (t, he) => t[he];
const heEnd = (t, he) => t[he - (he % 3) + NEXT[he % 3]];

/**
 * Undirected edges of the faces (trimesh `edges_sorted` grouped): for every edge its
 * sorted vertices, the number of faces using it (saturated at 3) and its first two
 * half-edges.
 */
function buildEdges(t, nv) {
  const nh = t.length;
  const cap = nextPow2(Math.ceil((4 * nh) / 3) + 16);
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const elo = new Int32Array(nh);
  const ehi = new Int32Array(nh);
  const occ0 = new Int32Array(nh);
  const occ1 = new Int32Array(nh);
  const count = new Uint8Array(nh);
  let ne = 0;
  for (let f = 0; f < nh; f += 3) {
    for (let k = 0; k < 3; k++) {
      const he = f + k;
      const a = t[he], b = t[k === 2 ? f : he + 1];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      let h = edgeHash(lo, hi) & mask;
      for (;;) {
        const e = table[h];
        if (e === -1) {
          table[h] = ne;
          elo[ne] = lo;
          ehi[ne] = hi;
          occ0[ne] = he;
          count[ne] = 1;
          ne++;
          break;
        }
        if (elo[e] === lo && ehi[e] === hi) {
          if (count[e] === 1) occ1[e] = he;
          if (count[e] < 3) count[e]++;
          break;
        }
        h = (h + 1) & mask;
      }
    }
  }
  return { table, mask, elo, ehi, occ0, occ1, count, ne, nv };
}

function edgeHash(lo, hi) {
  return finalize(Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi ^ 0x165667b1, 0x85ebca77));
}

/** Edge id of the undirected edge {a, b}, or -1. */
function findEdge(edges, a, b) {
  const lo = a < b ? a : b, hi = a < b ? b : a;
  let h = edgeHash(lo, hi) & edges.mask;
  for (;;) {
    const e = edges.table[h];
    if (e === -1) return -1;
    if (edges.elo[e] === lo && edges.ehi[e] === hi) return e;
    h = (h + 1) & edges.mask;
  }
}

/** trimesh is_watertight: every edge is shared by exactly two faces. */
function isWatertight(edges, nf) {
  if (nf === 0) return false;
  for (let e = 0; e < edges.ne; e++) if (edges.count[e] !== 2) return false;
  return true;
}

/** trimesh is_winding_consistent: every edge shared by two faces is traversed once in each direction. */
function isWindingConsistent(edges, t) {
  for (let e = 0; e < edges.ne; e++) {
    if (edges.count[e] !== 2) continue;
    if (heEnd(t, edges.occ0[e]) !== heStart(t, edges.occ1[e])) return false;
  }
  return true;
}

/** mesh.py `_boundary_edge_count`: edges used by a single face. */
function countBoundaryEdges(edges) {
  let n = 0;
  for (let e = 0; e < edges.ne; e++) if (edges.count[e] === 1) n++;
  return n;
}

// --------------------------------------------------------------------------- repair

/**
 * trimesh.repair.fix_winding, in place on `t`.
 *
 * The face adjacency graph links the two faces of every edge used exactly twice.
 * Each connected component is traversed breadth-first from a start face that keeps
 * its orientation; a newly reached face is reversed when it traverses the shared
 * edge in the same direction as the face it was reached from.
 *
 * The start face decides the orientation of its component, hence whether the
 * "normals pointed inwards" correction follows, so it is chosen exactly like
 * trimesh/networkx do (see startFaces).
 */
function fixWinding(t, nv, edges) {
  const nf = t.length / 3;
  // twin[he] = the other half-edge of an edge shared by exactly two faces;
  // edgeKey[he] = its rank in trimesh `face_adjacency` (sorted by (max vertex, min vertex)).
  const twin = new Int32Array(t.length).fill(-1);
  const edgeKey = new Float64Array(t.length);
  for (let e = 0; e < edges.ne; e++) {
    if (edges.count[e] !== 2) continue;
    const a = edges.occ0[e], b = edges.occ1[e];
    if (((a / 3) | 0) === ((b / 3) | 0)) continue;
    twin[a] = b;
    twin[b] = a;
    const u = heStart(t, a), w = heEnd(t, a);
    edgeKey[a] = edgeKey[b] = Math.max(u, w) * nv + Math.min(u, w);
  }

  const queue = new Int32Array(nf);
  const flipped = new Uint8Array(nf);
  const visited = new Uint8Array(nf);
  for (const start of startFaces(nf, twin, edgeKey, queue)) {
    let head = 0, tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const f = queue[head++];
      for (let k = 0; k < 3; k++) {
        const he = 3 * f + k;
        const o = twin[he];
        if (o < 0) continue;
        const g = (o / 3) | 0;
        if (visited[g]) continue;
        visited[g] = 1;
        // Same direction in the original data? Then same direction now unless f was reversed.
        const same = heStart(t, he) === heStart(t, o);
        if (same !== Boolean(flipped[f])) flipped[g] = 1;
        queue[tail++] = g;
      }
    }
  }
  for (let f = 0; f < nf; f++) {
    if (flipped[f]) {
      const a = t[3 * f];
      t[3 * f] = t[3 * f + 2];
      t[3 * f + 2] = a;
    }
  }
}

/**
 * The start face of every connected component of the face adjacency graph, as
 * picked by `next(iter(graph.subgraph(component).nodes()))` in fix_winding.
 *
 * networkx yields the components in node insertion order; the graph is built from
 * `face_adjacency`, whose rows are sorted by shared edge, so a node's neighbours
 * come in increasing edge key and the first node of a component is the lower face
 * of its smallest edge. For a component holding at least half of the graph the
 * subgraph view iterates the graph's nodes, which gives that first node. For a
 * smaller component it iterates a Python set instead: the set built from the
 * component, itself the `seen` set of a breadth-first search from the first node.
 * Both sets are simulated with CPython's hash table (see PySet).
 */
function startFaces(nf, twin, edgeKey, queue) {
  const neighbours = (f) => {
    const list = [];
    for (let k = 0; k < 3; k++) if (twin[3 * f + k] >= 0) list.push(k);
    list.sort((p, q) => edgeKey[3 * f + p] - edgeKey[3 * f + q]);
    return list.map((k) => (twin[3 * f + k] / 3) | 0);
  };

  // Components, with their first node (the lower face of the smallest edge).
  const comp = new Int32Array(nf).fill(-1);
  const first = [];
  const sizes = [];
  const minKey = [];
  let graphSize = 0;
  for (let f = 0; f < nf; f++) {
    if (comp[f] !== -1 || (twin[3 * f] < 0 && twin[3 * f + 1] < 0 && twin[3 * f + 2] < 0)) continue;
    const c = sizes.length;
    let head = 0, tail = 0, best = Infinity, bestFace = f;
    queue[tail++] = f;
    comp[f] = c;
    while (head < tail) {
      const g = queue[head++];
      for (let k = 0; k < 3; k++) {
        const o = twin[3 * g + k];
        if (o < 0) continue;
        const h = (o / 3) | 0;
        const key = edgeKey[3 * g + k];
        if (key < best || (key === best && Math.min(g, h) < bestFace)) {
          best = key;
          bestFace = Math.min(g, h);
        }
        if (comp[h] === -1) {
          comp[h] = c;
          queue[tail++] = h;
        }
      }
    }
    sizes.push(tail);
    first.push(bestFace);
    minKey.push(best);
    graphSize += tail;
  }

  const starts = [];
  for (let c = 0; c < sizes.length; c++) {
    if (2 * sizes[c] >= graphSize) {
      starts.push(first[c]);
      continue;
    }
    // networkx _plain_bfs: `seen` gets the nodes in breadth-first discovery order.
    const seen = new PySet();
    const order = [first[c]];
    seen.add(first[c]);
    for (let i = 0; i < order.length; i++) {
      for (const g of neighbours(order[i])) {
        if (!seen.has(g)) {
          seen.add(g);
          order.push(g);
        }
      }
    }
    // show_nodes: set(component) filled in the iteration order of `seen`.
    const shown = new PySet();
    for (const g of seen.keys()) shown.add(g);
    starts.push(shown.keys().next().value);
  }
  return starts;
}

/**
 * Minimal model of a CPython 3 `set` of non-negative ints (Objects/setobject.c):
 * an int hashes to itself, collisions are resolved by 9 linear probes then
 * perturbed probing, and the table grows (to the smallest power of two above
 * used*4, or used*2 past 50000 items) once it is 60 % full. Iteration follows the
 * table slots, which is what decides "the first element" of a set.
 */
class PySet {
  constructor() {
    this.table = new Int32Array(8).fill(-1);
    this.used = 0;
    this.index = new Set();
  }

  has(key) {
    return this.index.has(key);
  }

  add(key) {
    if (this.index.has(key)) return;
    this.index.add(key);
    PySet.insert(this.table, key);
    this.used++;
    const mask = this.table.length - 1;
    if (this.used * 5 >= mask * 3) {
      const minused = this.used > 50000 ? this.used * 2 : this.used * 4;
      let size = 8;
      while (size <= minused) size *= 2;
      const old = this.table;
      this.table = new Int32Array(size).fill(-1);
      for (const k of old) if (k >= 0) PySet.insert(this.table, k);
    }
  }

  *keys() {
    for (const k of this.table) if (k >= 0) yield k;
  }

  static insert(table, key) {
    const mask = table.length - 1;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      const probes = i + 9 <= mask ? 9 : 0;
      for (let j = 0; j <= probes; j++) {
        if (table[i + j] < 0) {
          table[i + j] = key;
          return;
        }
      }
      perturb = Math.floor(perturb / 32);
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
  }
}

/**
 * trimesh.repair.fill_holes (use_fan=False): the boundary edges form a graph whose
 * cycle basis (networkx, same traversal order) gives the holes; holes of 3 edges get
 * a triangle, holes of 4 edges two triangles, larger holes are left open. New faces
 * are oriented against the boundary. Returns the extended face array when the result
 * is watertight, else null.
 */
function fillHoles(verts, t, nv, edges) {
  const nf = t.length / 3;
  if (nf < 3) return null;

  // Boundary edges, ordered like trimesh group_rows (by sorted edge, max vertex first).
  const boundary = [];
  for (let e = 0; e < edges.ne; e++) if (edges.count[e] === 1) boundary.push(e);
  if (boundary.length < 3) return null;
  const keys = new Float64Array(boundary.length);
  const keyToEdge = new Map();
  for (let i = 0; i < boundary.length; i++) {
    const he = edges.occ0[boundary[i]];
    const a = heStart(t, he), b = heEnd(t, he);
    keys[i] = Math.max(a, b) * nv + Math.min(a, b);
    keyToEdge.set(keys[i], boundary[i]);
  }
  keys.sort();
  const src = new Int32Array(boundary.length);
  const dst = new Int32Array(boundary.length);
  for (let i = 0; i < keys.length; i++) {
    const he = edges.occ0[keyToEdge.get(keys[i])];
    src[i] = heStart(t, he);
    dst[i] = heEnd(t, he);
  }

  const holes = cycleBasis(src, dst);
  const newFaces = triangulateHoles(holes);
  if (!newFaces.length) return null;

  // A new face that traverses a boundary edge in the boundary's direction is reversed.
  const isBoundaryDirected = (a, b) => {
    const e = findEdge(edges, a, b);
    if (e < 0 || edges.count[e] !== 1) return false;
    const he = edges.occ0[e];
    return heStart(t, he) === a && heEnd(t, he) === b;
  };
  const added = [];
  for (const [a, b, c] of newFaces) {
    let face = [a, b, c];
    if (isBoundaryDirected(a, b) || isBoundaryDirected(b, c) || isBoundaryDirected(c, a)) face = [c, b, a];
    // extend_faces drops triangles without a valid normal
    if (crossNorm(verts, face[0], face[1], face[2]) > TOL_ZERO) added.push(...face);
  }
  if (!added.length) return null;

  const out = new Int32Array(t.length + added.length);
  out.set(t);
  out.set(added, t.length);
  return isWatertight(buildEdges(out, nv), out.length / 3) ? out : null;
}

/** |(v1 - v0) x (v2 - v1)| (trimesh triangles.cross). */
function crossNorm(v, a, b, c) {
  const e1x = v[3 * b] - v[3 * a], e1y = v[3 * b + 1] - v[3 * a + 1], e1z = v[3 * b + 2] - v[3 * a + 2];
  const fx = v[3 * c] - v[3 * b], fy = v[3 * c + 1] - v[3 * b + 1], fz = v[3 * c + 2] - v[3 * b + 2];
  const nx = e1y * fz - e1z * fy, ny = e1z * fx - e1x * fz, nz = e1x * fy - e1y * fx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * networkx.cycle_basis(networkx.from_edgelist(edges)), reproduced step by step: nodes
 * and adjacency lists keep insertion order, each component is rooted at the last
 * remaining node (dict.popitem) and explored depth-first.
 */
function cycleBasis(src, dst) {
  // Compact node ids in insertion order (u then v for every edge).
  const ids = new Map();
  const nodeOf = (v) => {
    let id = ids.get(v);
    if (id === undefined) {
      id = ids.size;
      ids.set(v, id);
    }
    return id;
  };
  const m = src.length;
  const eu = new Int32Array(m), ev = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    eu[i] = nodeOf(src[i]);
    ev[i] = nodeOf(dst[i]);
  }
  const n = ids.size;
  const label = new Int32Array(n);
  for (const [v, id] of ids) label[id] = v;

  // Adjacency (CSR) in insertion order; the boundary graph is simple.
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) {
    deg[eu[i] + 1]++;
    deg[ev[i] + 1]++;
  }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, n);
  const adj = new Int32Array(2 * m);
  for (let i = 0; i < m; i++) {
    adj[fill[eu[i]]++] = ev[i];
    adj[fill[ev[i]]++] = eu[i];
  }

  const removed = new Uint8Array(n);
  const pred = new Int32Array(n);
  const used = new Array(n); // used[node] = array of nodes (a small set), undefined = unseen
  const cycles = [];
  let last = n - 1;
  let remaining = n;
  while (remaining > 0) {
    while (removed[last]) last--;
    const root = last; // gnodes.popitem()
    removed[root] = 1;
    remaining--;
    const component = [root];
    pred[root] = root;
    used[root] = [];
    const stack = [root];
    while (stack.length) {
      const z = stack.pop();
      const zused = used[z];
      for (let j = deg[z]; j < deg[z + 1]; j++) {
        const nbr = adj[j];
        if (used[nbr] === undefined) {
          pred[nbr] = z;
          stack.push(nbr);
          used[nbr] = [z];
          component.push(nbr);
        } else if (nbr === z) {
          cycles.push([label[z]]);
        } else if (!zused.includes(nbr)) {
          const pn = used[nbr];
          const cycle = [label[nbr], label[z]];
          let p = pred[z];
          while (!pn.includes(p)) {
            cycle.push(label[p]);
            p = pred[p];
          }
          cycle.push(label[p]);
          cycles.push(cycle);
          pn.push(z);
        }
      }
    }
    for (const node of component) {
      if (!removed[node]) {
        removed[node] = 1;
        remaining--;
      }
    }
  }
  return cycles;
}

/** trimesh geometry.triangulate_quads(holes, use_fan=False). */
function triangulateHoles(holes) {
  if (!holes.length) return [];
  if (holes.every((h) => h.length === 3)) return holes.map((h) => [h[0], h[1], h[2]]);
  const tri = holes.filter((h) => h.length === 3).map((h) => [h[0], h[1], h[2]]);
  const quad = holes.filter((h) => h.length === 4);
  // all-quad input and mixed input both end with the first halves then the second halves
  return [...tri, ...quad.map((q) => [q[0], q[1], q[2]]), ...quad.map((q) => [q[2], q[3], q[0]])];
}

// --------------------------------------------------------------------------- integrals

/** Sum of the triangle areas (trimesh `mesh.area`). */
function meshArea(v, t) {
  let area = 0;
  for (let f = 0; f < t.length; f += 3) area += crossNorm(v, t[f], t[f + 1], t[f + 2]) / 2.0;
  return area;
}

/**
 * mesh.py `_shell_volume`: volume and centre of mass of a closed, consistently wound
 * triangle mesh (divergence theorem: signed tetrahedra (o, p0, p1, p2) with o the centre
 * of the vertex bounds, which keeps the sums well conditioned far from the origin).
 *
 * Every shell (faces connected through their edges) is oriented on its own: the winding
 * repair keeps whatever orientation each shell started with, so one inside-out shell
 * would otherwise be subtracted from the others. A shell is material (positive volume)
 * when it lies inside an even number of other shells and a void (negative) when the
 * number is odd. The centroid is null when the volume is (numerically) zero compared
 * with `size`, the largest side of the body's bounds.
 *
 * @returns {{volume: number, centroid: number[]|null, flipped: boolean}} flipped: some
 *   shell had to be turned the other way
 */
function shellProperties(v, t, edges, size) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1];
    if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2];
    if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  const o = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const { label, first } = faceComponents(t, edges);
  const count = first.length;

  // Per shell: signed volume and first moment about o, summed over the faces in the
  // order and with the operations of mesh.py, numpy's included (einsum adds the three
  // products of a . (b x c) as (x + z) + y): the sign of a shell of (nearly) zero
  // volume, e.g. a triangle and its reversed twin, is decided by these roundings.
  const vol = new Float64Array(count);
  const moment = new Float64Array(3 * count);
  for (let f = 0; f < t.length / 3; f++) {
    const a = 3 * t[3 * f], b = 3 * t[3 * f + 1], c = 3 * t[3 * f + 2];
    const ax = v[a] - o[0], ay = v[a + 1] - o[1], az = v[a + 2] - o[2];
    const bx = v[b] - o[0], by = v[b + 1] - o[1], bz = v[b + 2] - o[2];
    const qx = v[c] - o[0], qy = v[c + 1] - o[1], qz = v[c + 2] - o[2];
    const tet = (ax * (by * qz - bz * qy) + az * (bx * qy - by * qx) + ay * (bz * qx - bx * qz)) / 6.0;
    const k = label[f];
    vol[k] += tet;
    moment[3 * k] += (tet * (ax + bx + qx)) / 4.0;
    moment[3 * k + 1] += (tet * (ay + by + qy)) / 4.0;
    moment[3 * k + 2] += (tet * (az + bz + qz)) / 4.0;
  }

  const depth = count > 1 ? nestingDepth(v, t, o, label, first) : new Int32Array(1);
  let flipped = false;
  let volume = 0, mx = 0, my = 0, mz = 0;
  for (let k = 0; k < count; k++) {
    const wanted = depth[k] % 2 === 0 ? 1 : -1;
    if (vol[k] !== 0 && Math.sign(vol[k]) !== wanted) {
      vol[k] = -vol[k];
      for (let j = 0; j < 3; j++) moment[3 * k + j] = -moment[3 * k + j];
      flipped = true;
    }
    volume += vol[k];
    mx += moment[3 * k];
    my += moment[3 * k + 1];
    mz += moment[3 * k + 2];
  }
  let centroid = [o[0] + mx / volume, o[1] + my / volume, o[2] + mz / volume];
  // A (numerically) zero volume has no centre of mass; trimesh would return 0/0 noise.
  if (!(Math.abs(volume) > 1e-12 * size ** 3) || !centroid.every(Number.isFinite)) centroid = null;
  return { volume, centroid, flipped };
}

/**
 * Shells: faces connected through a shared edge (union-find over the edges), numbered
 * in the order of their lowest face index. Returns the label of every face and the
 * lowest face of every shell.
 */
function faceComponents(t, edges) {
  const nf = t.length / 3;
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const root = (f) => {
    while (parent[f] !== f) {
      parent[f] = parent[parent[f]];
      f = parent[f];
    }
    return f;
  };
  for (let e = 0; e < edges.ne; e++) {
    if (edges.count[e] < 2) continue;
    const a = root((edges.occ0[e] / 3) | 0), b = root((edges.occ1[e] / 3) | 0);
    if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
  }
  const label = new Int32Array(nf);
  const first = [];
  const rootLabel = new Int32Array(nf).fill(-1);
  for (let f = 0; f < nf; f++) {
    const r = root(f);
    if (rootLabel[r] < 0) {
      rootLabel[r] = first.length;
      first.push(f);
    }
    label[f] = rootLabel[r];
  }
  return { label, first };
}

// Direction of the rays of the inside test: neither along an axis nor a diagonal, so
// that it rarely grazes the edges of axis-aligned meshes (mesh.py `_RAY`).
const RAY = [1 / Math.sqrt(6), Math.sqrt(2) / Math.sqrt(6), Math.sqrt(3) / Math.sqrt(6)];

/**
 * mesh.py `_nesting_depth`: for every shell, the number of other shells containing its
 * test point (the centroid of its lowest face): the point lies in the other shell's
 * bounds (inclusive) and the ray p + t * RAY (t > 0) crosses an odd number of its
 * triangles. Coordinates relative to `o`, like the volume sums.
 */
function nestingDepth(v, t, o, label, first) {
  const count = first.length;
  const nf = t.length / 3;
  const corner = (f, j, k) => v[3 * t[3 * f + j] + k] - o[k];
  const points = new Float64Array(3 * count);
  for (let s = 0; s < count; s++) {
    for (let k = 0; k < 3; k++) points[3 * s + k] = (corner(first[s], 0, k) + corner(first[s], 1, k) + corner(first[s], 2, k)) / 3;
  }
  const lo = new Float64Array(3 * count).fill(Infinity);
  const hi = new Float64Array(3 * count).fill(-Infinity);
  // faces grouped by shell (counting sort, face order kept)
  const start = new Int32Array(count + 1);
  for (let f = 0; f < nf; f++) start[label[f] + 1]++;
  for (let s = 0; s < count; s++) start[s + 1] += start[s];
  const fill = start.slice(0, count);
  const order = new Int32Array(nf);
  for (let f = 0; f < nf; f++) {
    const s = label[f];
    order[fill[s]++] = f;
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        const x = corner(f, j, k);
        if (x < lo[3 * s + k]) lo[3 * s + k] = x;
        if (x > hi[3 * s + k]) hi[3 * s + k] = x;
      }
    }
  }

  // test points sorted by x: the candidates of a shell are a range of this order
  const byX = Array.from({ length: count }, (_, s) => s).sort((a, b) => points[3 * a] - points[3 * b] || a - b);
  const xs = Float64Array.from(byX, (s) => points[3 * s]);
  const lowerBound = (x, strict) => {
    let a = 0, b = count;
    while (a < b) {
      const m = (a + b) >> 1;
      if (strict ? xs[m] <= x : xs[m] < x) a = m + 1;
      else b = m;
    }
    return a;
  };
  const depth = new Int32Array(count);
  for (let j = 0; j < count; j++) {
    const candidates = [];
    for (let i = lowerBound(lo[3 * j], false); i < lowerBound(hi[3 * j], true); i++) {
      const s = byX[i];
      if (s === j) continue;
      let inside = true;
      for (let k = 1; k < 3 && inside; k++) inside = points[3 * s + k] >= lo[3 * j + k] && points[3 * s + k] <= hi[3 * j + k];
      if (inside) candidates.push(s);
    }
    if (!candidates.length) continue;
    const hits = rayCrossings(candidates.map((s) => [points[3 * s], points[3 * s + 1], points[3 * s + 2]]), order.subarray(start[j], start[j + 1]), corner);
    candidates.forEach((s, i) => {
      if (hits[i] % 2 === 1) depth[s]++;
    });
  }
  return depth;
}

/**
 * mesh.py `_ray_crossings`: number of the triangles `faces` crossed by the ray
 * p + t * RAY (t > 0) of every point (Möller–Trumbore; triangles parallel to the ray
 * are skipped, a crossing on an edge or a corner counts). The dot products that numpy
 * computes with einsum add their terms in its order, (x + z) + y.
 */
function rayCrossings(points, faces, corner) {
  const hits = new Int32Array(points.length);
  const [rx, ry, rz] = RAY;
  for (const f of faces) {
    const ax = corner(f, 0, 0), ay = corner(f, 0, 1), az = corner(f, 0, 2);
    const e1x = corner(f, 1, 0) - ax, e1y = corner(f, 1, 1) - ay, e1z = corner(f, 1, 2) - az;
    const e2x = corner(f, 2, 0) - ax, e2y = corner(f, 2, 1) - ay, e2z = corner(f, 2, 2) - az;
    const px = ry * e2z - rz * e2y, py = rz * e2x - rx * e2z, pz = rx * e2y - ry * e2x; // RAY x e2
    const det = e1x * px + e1z * pz + e1y * py;
    const n1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z), n2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
    if (!(Math.abs(det) > 1e-12 * n1 * n2)) continue;
    const inv = 1.0 / det;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const tx = p[0] - ax, ty = p[1] - ay, tz = p[2] - az;
      const u = (tx * px + tz * pz + ty * py) * inv;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x; // tvec x e1
      const w = (qx * rx + qy * ry + qz * rz) * inv;
      const d = (qx * e2x + qz * e2z + qy * e2y) * inv;
      if (d > 0 && u >= 0 && w >= 0 && u + w <= 1) hits[i]++;
    }
  }
  return hits;
}
