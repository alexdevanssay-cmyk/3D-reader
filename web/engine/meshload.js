// Reading of triangle-mesh formats (browser counterpart of reader3d/mesh.py `read_mesh`).
//
// loadMeshFile() turns a file into "parts": triangle meshes in world coordinates,
// scaled to millimetres, ready for meshanalysis.js. The Python engine reads files with
// trimesh (and pycollada for COLLADA); every reader below reproduces the loader of its
// format wherever the results depend on it:
//
//   - coordinates stay in double precision (float32 only where the file stores float32),
//     so models far from the origin keep their exact volume;
//   - vertex order and polygon triangulation follow trimesh: they decide which vertex
//     represents a welded group and which face starts the winding repair, hence the
//     "normals pointed inwards" verdict;
//   - node / item / component transforms are full 4x4 matrices (shear included), and a
//     transform with a negative determinant reverses the triangles (apply_transform);
//   - part names follow the scene graph of trimesh and the naming rule of mesh.py, and
//     colours follow `visual.main_color`.
//
// Only glTF goes through a three.js loader (GLTFLoader decodes accessors, sparse and
// quantized data); STL, OBJ, PLY, OFF, 3MF and COLLADA have small parsers here (with a
// minimal XML scanner), so every format parses in a page, a Web Worker or Node.
//
// Deliberate differences with the Python engine (where it is wrong or cannot apply):
//   - OBJ material libraries (.mtl) are never available: a single file is uploaded. The
//     Python server analyses uploads alone in a temporary directory, so it behaves the same.
//   - glTF colours are reported in sRGB (glTF stores linear factors; the viewer expects sRGB).
//   - COLLADA `<unit meter="...">` is applied whatever its value; mesh.py only recognises
//     1 m (trimesh reports "0.01 * meters", which _auto_unit reads as mm without scaling).
//   - OFF comments are removed line by line and polygons with more than 4 vertices are
//     fanned (trimesh's comment_strip duplicates text before a mid-file comment, and its
//     OFF reader fails on such polygons).
//   - Files trimesh rejects but that are unambiguous are read: binary PLY with polygons of
//     mixed sizes, 3MF whose model part is not 3D/3dmodel.model, COLLADA without <scene>,
//     old Mac (CR-only) line endings in OBJ.
//   - glTF meshes with several primitives give parts named "<node>_<k>" (trimesh appends
//     a random suffix to the node name).

import { UNITS, unitFactor, unitFromName } from './units.js';

/** Extensions handled by this module. */
export const MESH_EXTENSIONS = Object.freeze(['.stl', '.obj', '.ply', '.off', '.glb', '.gltf', '.3mf', '.dae', '.zae']);

const NO_TRIANGLES = 'The file does not contain any triangle geometry';

/**
 * Formats parsed with a three.js loader, which imports "three": the main thread can
 * load them (the page's import map resolves "three"), a Web Worker cannot.
 */
export function needsMainThread(fileName) {
  return ['.glb', '.gltf'].includes(extensionOf(fileName));
}

/**
 * Formats that can only be parsed where DOMParser exists. None any more: 3MF and COLLADA
 * have their own XML reader. Kept so that callers written for the earlier API still work.
 */
export function needsDomParser(_fileName) {
  return false;
}

/**
 * Parse a mesh file.
 *
 * @param {ArrayBuffer|Uint8Array} bytes  file content
 * @param {string} fileName  used for the format (extension) and the default body name (stem)
 * @param {{unit?: string}} options  'auto' or one of UNITS ('mm', 'cm', 'm', 'in', 'ft')
 * @returns {Promise<{parts: Array<{name: string, positions: Float64Array|Float32Array,
 *   indices: Uint32Array|null, color: number[]|null}>, source_unit: string}>}
 *   world coordinates in mm (Float32Array only when the file stores float32 values that
 *   need no transform); every typed array owns its buffer (safe to transfer).
 */
export async function loadMeshFile(bytes, fileName, { unit = 'auto' } = {}) {
  const ext = extensionOf(fileName);
  const base = baseName(fileName);
  const stem = stemOf(base);
  if (unit !== 'auto') unitFactor(unit); // throws "Unknown unit '...'"
  const buffer = toArrayBuffer(bytes);

  let loaded;
  switch (ext) {
    case '.stl': loaded = readStl(buffer); break;
    case '.obj': loaded = readObj(buffer, base); break;
    case '.ply': loaded = readPly(buffer); break;
    case '.off': loaded = readOff(buffer); break;
    case '.glb':
    case '.gltf': loaded = await readGltf(buffer); break;
    case '.3mf': loaded = await read3mf(buffer); break;
    case '.dae': loaded = readCollada(decodeText(buffer)); break;
    case '.zae': loaded = readCollada(await zaeDocument(buffer)); break;
    default:
      throw new Error(`Unsupported mesh file type '${ext}'. Supported: ${MESH_EXTENSIONS.join(', ')}`);
  }

  let sourceUnit = 'mm';
  let factor = 1.0;
  if (unit !== 'auto') {
    sourceUnit = unit;
    factor = UNITS[unit];
  } else if (loaded.unit) {
    sourceUnit = loaded.unit.name;
    factor = loaded.unit.factor;
  }

  const owned = new Set();
  const parts = [];
  for (const p of loaded.parts) {
    const positions = ownBuffer(toWorld(p.positions, p.matrix, factor), owned);
    let indices = p.indices ? ownBuffer(p.indices, owned) : null;
    if (p.matrix && flipsWinding(p.matrix)) indices = reversedFaces(indices, positions.length / 3);
    // mesh.py skips geometry without faces (trimesh drops faces on non-finite vertices).
    if (!hasValidTriangle(positions, indices)) continue;
    // mesh.py: `node if node != geom_name or len(scene.geometry) > 1 else path.stem`
    const name = p.node !== p.geometry || loaded.geometryCount > 1 ? p.node : stem;
    parts.push({ name, positions, indices, color: p.color ?? null });
  }
  if (!parts.length) throw new Error(NO_TRIANGLES);
  return { parts, source_unit: sourceUnit };
}

// =========================================================================== helpers

function baseName(fileName) {
  return String(fileName).split(/[\\/]/).pop();
}

function extensionOf(fileName) {
  const base = baseName(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function stemOf(base) {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    // the readers never write into the buffer: a view of a whole buffer needs no copy
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new TypeError('loadMeshFile expects an ArrayBuffer or a Uint8Array');
}

function decodeText(buffer) {
  return new TextDecoder().decode(buffer);
}

/** The array itself if it owns a buffer no other part uses, else a copy (transfer lists reject duplicates). */
function ownBuffer(array, owned) {
  const whole = array.byteOffset === 0 && array.byteLength === array.buffer.byteLength;
  const out = whole && !owned.has(array.buffer) ? array : array.slice();
  owned.add(out.buffer);
  return out;
}

/** True when at least one triangle has three in-range vertices with finite coordinates. */
function hasValidTriangle(positions, indices) {
  const nv = positions.length / 3;
  const finite = (i) =>
    i < nv && Number.isFinite(positions[3 * i]) && Number.isFinite(positions[3 * i + 1]) && Number.isFinite(positions[3 * i + 2]);
  const count = indices ? indices.length - (indices.length % 3) : nv - (nv % 3);
  for (let f = 0; f < count; f += 3) {
    if (indices ? finite(indices[f]) && finite(indices[f + 1]) && finite(indices[f + 2]) : finite(f) && finite(f + 1) && finite(f + 2)) {
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------- Python-isms

const WHITESPACE = /\s+/;
/** Separators of numpy.fromstring(sep=" "): C isspace. */
const C_SPACE = /[ \t\n\v\f\r]+/;
/** Line boundaries of Python str.splitlines(). */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.split()` (no argument). */
function pySplit(s) {
  const t = s.trim();
  return t ? t.split(WHITESPACE) : [];
}

/** Python `str.splitlines()`: no trailing empty line after a final line break. */
function pySplitlines(s) {
  if (!s) return [];
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const FLOAT_TOKEN = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;
const INT_TOKEN = /^[+-]?\d+$/;

/** Python float() of a token (nan / inf accepted), undefined when it is not a number. */
function pyFloat(token) {
  const t = token.trim();
  if (!FLOAT_TOKEN.test(t)) return undefined;
  const lower = t.toLowerCase();
  if (lower.endsWith('nan')) return NaN;
  if (lower.includes('inf')) return lower.startsWith('-') ? -Infinity : Infinity;
  return Number(t);
}

/** Python int() of a token, undefined when it is not an integer. */
function pyInt(token) {
  const t = token.trim();
  return INT_TOKEN.test(t) ? Number(t) : undefined;
}

/** numpy.fromstring(text, sep=" "): numbers up to the first token that is not one. */
function fromString(text, parse = pyFloat) {
  const out = [];
  for (const token of text.split(C_SPACE)) {
    if (!token) continue;
    const v = parse(token);
    if (v === undefined) break;
    out.push(v);
  }
  return out;
}

/** numpy round(): half to even. */
function roundHalfEven(v) {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * trimesh.util.unique_name: `start` if unused, else "start_N" with the first free N
 * (counting on from an existing numeric suffix), "geometry_N" for an empty name.
 * `counts` (optional Map) remembers the last N tried per start, like trimesh.
 */
function uniqueName(start, contains, counts = null) {
  if (start && !contains.has(start)) return start;
  let increment = counts ? counts.get(start) ?? 0 : 0;
  let prefix = 'geometry';
  if (start) {
    prefix = start;
    const cut = start.lastIndexOf('_');
    if (cut >= 0 && increment === 0) {
      const tail = pyInt(start.slice(cut + 1));
      if (tail !== undefined) {
        increment = tail;
        prefix = start.slice(0, cut);
      }
    }
  }
  for (let i = increment + 1; i < 2 + increment + contains.size; i++) {
    const check = `${prefix}_${i}`;
    if (!contains.has(check)) {
      if (counts) counts.set(start, i);
      return check;
    }
  }
  throw new Error('Unable to establish unique name');
}

// --------------------------------------------------------------------------- polygons
//
// Polygons are kept as flat lists (no array per polygon, which matters for files with
// millions of faces): polygon k has `sizes[k]` vertex references, stored in order in `refs`.

/**
 * trimesh geometry.triangulate_quads (also what the Trimesh constructor does with
 * (n, 4) faces): triangles first, then the first halves (0, 1, 2) of the quads, then
 * their second halves (2, 3, 0), then larger polygons as fans from their first vertex.
 * Polygons with fewer than 3 vertices are dropped.
 */
function triangulatePolygons({ sizes, refs }) {
  let nTri = 0, nQuad = 0, nFan = 0;
  for (const n of sizes) {
    if (n === 3) nTri++;
    else if (n === 4) nQuad++;
    else if (n > 4) nFan += n - 2;
  }
  const out = new Uint32Array(3 * (nTri + 2 * nQuad + nFan));
  let o = 0;
  const each = (visit) => {
    let at = 0;
    for (const n of sizes) {
      visit(n, at);
      at += n;
    }
  };
  const put = (a, b, c) => {
    out[o++] = refs[a];
    out[o++] = refs[b];
    out[o++] = refs[c];
  };
  each((n, at) => n === 3 && put(at, at + 1, at + 2));
  each((n, at) => n === 4 && put(at, at + 1, at + 2));
  each((n, at) => n === 4 && put(at + 2, at + 3, at));
  each((n, at) => {
    for (let k = 1; n > 4 && k + 1 < n; k++) put(at, at + k, at + k + 1);
  });
  return out;
}

/** Check the references of the polygons that make triangles (trimesh fails with an IndexError). */
function checkRefs({ sizes, refs }, nv, format) {
  let at = 0;
  for (const n of sizes) {
    for (let k = 0; n >= 3 && k < n; k++) {
      const i = refs[at + k];
      if (!(Number.isInteger(i) && i >= 0 && i < nv)) throw new Error(`${format} file has a face index out of range`);
    }
    at += n;
  }
}

// --------------------------------------------------------------------------- transforms
//
// Matrices are row-major 4x4 Float64Arrays (numpy layout): m[4 * row + col].

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function matMul(a, b) {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[4 * r + c] = a[4 * r] * b[c] + a[4 * r + 1] * b[4 + c] + a[4 * r + 2] * b[8 + c] + a[4 * r + 3] * b[12 + c];
    }
  }
  return out;
}

/** trimesh util.allclose(a, b, atol): numpy.ptp(a - b) < atol. */
function allClose(a, b, atol, size = 4, n = 4) {
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const d = a[size * r + c] - b[size * r + c];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  return hi - lo < atol;
}

/** trimesh apply_transform reverses the faces when the matrix has a rotation part with det < 0. */
function flipsWinding(m) {
  if (allClose(m, IDENTITY, 1e-8) || allClose(m, IDENTITY, 1e-6, 4, 3)) return false;
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  return det < 0;
}

/**
 * Apply the part transform, then the unit factor (mesh.py: apply_transform, apply_scale),
 * in double precision. Returns the input array itself when there is nothing to apply.
 */
function toWorld(positions, matrix, factor) {
  const n = positions.length;
  const m = matrix && !allClose(matrix, IDENTITY, 1e-8) ? matrix : null;
  if (!m && factor === 1) return positions;
  const out = new Float64Array(n);
  if (!m) {
    for (let i = 0; i < n; i++) out[i] = positions[i] * factor;
    return out;
  }
  for (let i = 0; i < n; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = (m[0] * x + m[1] * y + m[2] * z + m[3]) * factor;
    out[i + 1] = (m[4] * x + m[5] * y + m[6] * z + m[7]) * factor;
    out[i + 2] = (m[8] * x + m[9] * y + m[10] * z + m[11]) * factor;
  }
  return out;
}

/** numpy.fliplr(faces): every triangle (a, b, c) becomes (c, b, a). */
function reversedFaces(indices, nv) {
  const count = indices ? indices.length - (indices.length % 3) : nv - (nv % 3);
  const out = new Uint32Array(count);
  for (let f = 0; f < count; f += 3) {
    out[f] = indices ? indices[f + 2] : f + 2;
    out[f + 1] = indices ? indices[f + 1] : f + 1;
    out[f + 2] = indices ? indices[f] : f;
  }
  return out;
}

// --------------------------------------------------------------------------- colours

/**
 * trimesh visual.color.to_rgba of one float channel: clip(c * 255), rounded half to even.
 * With `float32`, the product is rounded to float32 first, as numpy does for a float32
 * array (0.9f * 255 is exactly 229.5 in float32, hence 230).
 */
function floatToByte(c, float32 = false) {
  if (!Number.isFinite(c)) return 0;
  const v = float32 ? Math.fround(c * 255) : c * 255;
  return roundHalfEven(Math.min(Math.max(v, 0), 255));
}

/** trimesh DEFAULT_COLOR (102, 102, 102): main colour of a texture visual without a colour. */
const DEFAULT_COLOR = Object.freeze([0.4, 0.4, 0.4]);

/**
 * trimesh ColorVisuals.main_color: the most frequent RGBA row. Ties go to the row that
 * numpy.unique sorts first: rows are packed with alpha in the most significant bits,
 * then blue, green and red. `rgba` holds 4 bytes per row; `rows` lists the rows to
 * count (default: all). Returns sRGB 0..1 or null.
 */
function mainColor(rgba, rows = null) {
  const counts = new Map();
  let best = -1, bestCount = 0;
  const visit = (i) => {
    const o = 4 * i;
    const key = ((rgba[o + 3] * 256 + rgba[o + 2]) * 256 + rgba[o + 1]) * 256 + rgba[o];
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > bestCount || (c === bestCount && key < best)) {
      bestCount = c;
      best = key;
    }
  };
  if (rows) for (const i of rows) visit(i);
  else for (let i = 0; i < rgba.length / 4; i++) visit(i);
  if (best < 0) return null;
  return [(best % 256) / 255, (Math.floor(best / 256) % 256) / 255, (Math.floor(best / 65536) % 256) / 255];
}

/**
 * The vertex rows a processed trimesh keeps (Trimesh(process=True) -> merge_vertices):
 * the referenced vertices with finite coordinates, one per position rounded to 8
 * decimals (and per normal rounded to 2 decimals when the file has normals), first
 * occurrence first. Their colours are the ones main_color counts.
 */
function mergedVertexRows(positions, faces, normals = null) {
  const nv = positions.length / 3;
  const used = new Uint8Array(nv);
  for (let i = 0; i < faces.length; i++) if (faces[i] < nv) used[faces[i]] = 1;
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < nv; i++) {
    if (!used[i]) continue;
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    let key = `${roundHalfEven(x * 1e8)},${roundHalfEven(y * 1e8)},${roundHalfEven(z * 1e8)}`;
    if (normals) key += `|${roundHalfEven(normals[3 * i] * 100)},${roundHalfEven(normals[3 * i + 1] * 100)},${roundHalfEven(normals[3 * i + 2] * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(i);
  }
  return rows;
}

const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// =========================================================================== STL

/**
 * STL like trimesh.exchange.stl.load_stl: binary when the length is exactly
 * 84 + 50 * (face count of the header), otherwise ASCII. trimesh never reads STL
 * colours (nor does this reader).
 */
function readStl(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    if (bytes.length - 84 === count * 50) {
      const positions = new Float32Array(9 * count);
      for (let f = 0; f < count; f++) {
        const o = 84 + 50 * f + 12; // skip the normal
        for (let k = 0; k < 9; k++) positions[9 * f + k] = view.getFloat32(o + 4 * k, true);
      }
      return single(positions, null, null);
    }
  }
  return readStlAscii(decodeText(buffer).trim());
}

/**
 * ASCII STL, one geometry per `solid ... endsolid` block. The vertices are the numbers
 * after every "vertex" keyword up to the end of its line (numpy.fromstring semantics:
 * parsing stops at the first token that is not a number); blocks with fewer than 3
 * numbers are skipped; names come from the `solid` line, made unique like trimesh.
 */
function readStlAscii(text) {
  // trimesh searches a lower-cased copy; case-insensitive searches avoid the copy
  const find = (re, from) => {
    re.lastIndex = from;
    return re.exec(text)?.index ?? -1;
  };
  const SOLID = /solid/gi, ENDSOLID = /endsolid/gi, VERTEX = /vertex/gi;
  const geometries = new Map(); // name -> positions
  let position = 0;
  for (let guard = 0; guard < text.length; guard++) {
    const start = find(SOLID, position);
    const end = find(ENDSOLID, position);
    position = end + 8;
    if (end < 0 || start < 0) break;
    if (start > end) throw new Error('`endsolid` precedes `solid`!');

    const values = [];
    let stopped = false;
    let at = find(VERTEX, start);
    while (at >= 0 && at + 6 <= end && !stopped) {
      const from = at + 6;
      let next = find(VERTEX, from);
      if (next < 0 || next + 6 > end) next = end;
      const nl = text.indexOf('\n', from);
      // `line[:line.find("\n")]` over the text between two "vertex": no newline drops the last character
      const stop = nl >= 0 && nl < next ? nl : next - 1;
      for (const token of text.slice(from, Math.max(stop, from)).split(C_SPACE)) {
        if (!token) continue;
        const v = pyFloat(token);
        if (v === undefined) {
          stopped = true;
          break;
        }
        values.push(v);
      }
      at = next < end ? next : -1;
    }
    if (values.length < 3) continue;
    if (values.length % 9 !== 0) throw new Error('incorrect number of vertices');

    const nl = text.indexOf('\n', start);
    let headerEnd = nl >= 0 && nl < end ? nl : start - 1;
    if (headerEnd < 0) headerEnd += text.length; // Python negative slice index
    const name = uniqueName(text.slice(start, Math.max(headerEnd, start)).slice(6).trim(), geometries);
    geometries.set(name, Float64Array.from(values));
  }
  if (geometries.size === 1) return single(geometries.values().next().value, null, null);
  return {
    parts: [...geometries].map(([name, positions]) => ({ node: name, geometry: name, positions, indices: null, matrix: null, color: null })),
    geometryCount: geometries.size,
  };
}

/** A file holding one geometry (named after the file by mesh.py). */
function single(positions, indices, color) {
  return { parts: [{ node: '', geometry: '', positions, indices, matrix: null, color }], geometryCount: 1 };
}

// =========================================================================== OBJ

/**
 * Wavefront OBJ like trimesh.exchange.obj.load_obj (group_material=True, no material
 * library). Faces of every `o` / `g` block are gathered per `usemtl` material; each
 * group keeps the referenced `v` vertices in file order; polygons are triangulated like
 * trimesh (see objFaces). Group names: the first `o` name when it starts the face
 * section, else the file name, made unique (material names are only used when a
 * material library is loaded, which never happens for an uploaded file). Colour: faces
 * with valid texture coordinates make a texture visual (trimesh's default grey), else
 * the vertex colours.
 */
function readObj(buffer, fileName) {
  let text = decodeText(buffer).trim().replace(/\r\n?/g, '\n');
  text = `\n${text}\n`.replace(/\\\n/g, '');

  const { vertices, colors } = objVertices(text);
  let textureCount = 0;
  for (let at = text.indexOf('\nvt '); at >= 0; at = text.indexOf('\nvt ', at + 4)) textureCount++;
  const tuples = objFaceChunks(text);
  if (!tuples.length) return { parts: [], geometryCount: 0 }; // a point cloud
  if (!vertices) throw new Error('OBJ file has faces but no vertices');
  const nv = vertices.length / 3;

  const geometry = new Map(); // name -> part (insertion order = trimesh dict order)
  while (tuples.length) {
    const { object, chunk } = tuples.pop();
    const lines = [];
    for (const line of chunk.split('\n')) if (line.startsWith('f')) lines.push(line.slice(1).trim());
    const { sizes, refs, texture } = objFaces(lines);
    // Compact the referenced vertices, keeping their order (negative indices count from the end).
    const used = new Int32Array(nv).fill(-1);
    for (let k = 0; k < refs.length; k++) {
      let i = refs[k];
      if (i < 0) i += nv;
      if (!(i >= 0 && i < nv)) throw new Error('OBJ file has a face index out of range');
      refs[k] = i;
      used[i] = 0;
    }
    let count = 0;
    for (let i = 0; i < nv; i++) if (used[i] === 0) used[i] = count++;
    const positions = new Float64Array(3 * count);
    const rgba = colors ? new Uint8Array(4 * count) : null;
    for (let i = 0; i < nv; i++) {
      const j = used[i];
      if (j < 0) continue;
      positions.set(vertices.subarray(3 * i, 3 * i + 3), 3 * j);
      if (rgba) rgba.set(colors.subarray(4 * i, 4 * i + 4), 4 * j);
    }
    for (let k = 0; k < refs.length; k++) refs[k] = used[refs[k]];
    const indices = triangulatePolygons({ sizes, refs });
    const name = uniqueName(object ?? fileName, geometry);
    // `uv = vt[mask_vt]` only succeeds when every texture index is in range
    const textured = texture !== null && texture.every((t) => t >= -textureCount && t < textureCount);
    let color = null;
    if (textured) color = [...DEFAULT_COLOR];
    else if (rgba) color = mainColor(rgba, mergedVertexRows(positions, indices));
    geometry.set(name, { node: name, geometry: name, positions, indices, matrix: null, color });
  }
  return { parts: [...geometry.values()], geometryCount: geometry.size };
}

/**
 * `v` lines (trimesh _parse_vertices): the coordinates are the first 3 values, a vertex
 * colour the next 3 when every row has at least 6 values. Rows of different lengths are
 * clipped to the shortest one; a value that is not a number in the kept columns fails.
 */
function objVertices(text) {
  let n = 0;
  for (let at = text.indexOf('\nv '); at >= 0; at = text.indexOf('\nv ', at + 3)) n++;
  if (!n) return { vertices: null, colors: null };
  const values = new Float64Array(6 * n);
  const invalid = new Uint8Array(n); // bit k: value k is not a number
  let width = Infinity;
  let row = 0;
  for (let at = text.indexOf('\nv '); at >= 0; at = text.indexOf('\nv ', at + 3), row++) {
    const end = text.indexOf('\n', at + 3);
    const tokens = pySplit(text.slice(at + 3, end));
    width = Math.min(width, tokens.length);
    for (let k = 0; k < 6 && k < tokens.length; k++) {
      const v = pyFloat(tokens[k]);
      if (v === undefined) invalid[row] |= 1 << k;
      values[6 * row + k] = v ?? NaN;
    }
  }
  if (width < 3) throw new Error('OBJ vertices need 3 coordinates');
  const kept = (1 << Math.min(width, 6)) - 1;
  if (invalid.some((bits) => bits & kept)) throw new Error('OBJ vertex has a value that is not a number');
  const vertices = new Float64Array(3 * n);
  const colors = width >= 6 ? new Uint8Array(4 * n) : null;
  for (let i = 0; i < n; i++) {
    vertices.set(values.subarray(6 * i, 6 * i + 3), 3 * i);
    if (!colors) continue;
    for (let k = 0; k < 3; k++) colors[4 * i + k] = floatToByte(values[6 * i + 3 + k]);
    colors[4 * i + 3] = 255;
  }
  return { vertices, colors };
}

/**
 * trimesh _preprocess_faces + _group_by: the face section (from the first usemtl / o /
 * f / g / s line to the last face) is cut at every "usemtl " and the chunks are grouped
 * per material in order of first use. A chunk starting with "o " sets the object name
 * (only the first chunk can, since chunks are not cut at objects).
 */
function objFaceChunks(text) {
  let fStart = text.length;
  for (const st of ['\nusemtl ', '\no ', '\nf ', '\ng ', '\ns ']) {
    const s = text.indexOf(st);
    if (s >= 0 && s < fStart) fStart = s;
  }
  const fEnd = text.indexOf('\n', text.lastIndexOf('\nf ') + 3);
  const fChunk = fEnd >= 0 ? (fEnd > fStart ? text.slice(fStart, fEnd) : '') : text.slice(fStart);

  const cuts = [0, fChunk.length];
  for (let at = fChunk.indexOf('usemtl '); at >= 0; at = fChunk.indexOf('usemtl ', at + 7)) cuts.push(at);
  const splits = [...new Set(cuts)].sort((a, b) => a - b);

  const groups = new Map(); // material -> {object, chunks}
  let object = null, material = null;
  for (let k = 0; k + 1 < splits.length; k++) {
    let chunk = `${fChunk.slice(splits[k], splits[k + 1]).trim()}\n`;
    const nl = chunk.indexOf('\n');
    if (chunk.startsWith('o ')) {
      object = chunk.slice(2, nl).trim();
      chunk = chunk.slice(nl + 1);
    } else if (chunk.startsWith('usemtl')) {
      material = chunk.slice(6, nl).trim();
      chunk = chunk.slice(nl + 1);
    } else if (chunk.startsWith('g ')) {
      chunk = chunk.slice(nl + 1);
    }
    if (chunk.startsWith('f ') || chunk.includes('\nf')) {
      if (!groups.has(material)) groups.set(material, { object, chunks: [] });
      const g = groups.get(material);
      g.object = object;
      g.chunks.push(chunk);
    }
  }
  return [...groups.values()].map((g) => ({ object: g.object, chunk: g.chunks.join('\n') }));
}

/**
 * Face lines of one group as a polygon list of 0-based vertex indices (negative indices
 * kept), plus the texture (`vt`) index of every corner when trimesh finds one (else null).
 * When every line has the same number of values, trimesh parses them as one array and
 * reads the vertex index every `per_ref` values (quads and n-gons are triangulated later,
 * all first halves before all second halves). Otherwise each line is triangulated in
 * place: quads as (0, 1, 2), (2, 3, 0) and larger polygons as fans.
 */
function objFaces(lines) {
  const sizes = [], refs = [];
  if (!lines.length) return { sizes, refs, texture: null };
  const valueCount = (line) => pySplit(line.replace(/\//g, ' ')).length;
  const toIndex = (token) => {
    const v = pyInt(token);
    if (v === undefined) throw new Error(`OBJ face has an invalid vertex reference '${token}'`);
    return v > 0 ? v - 1 : v;
  };
  const columns = valueCount(lines[0]);
  if (lines.every((l) => valueCount(l) === columns)) {
    const sample = pySplit(lines[0]);
    const groupCount = sample.length;
    const perRef = Math.trunc(columns / groupCount);
    // "v/vt" (one slash per reference) or "v/vt/vn": the second value is the texture index
    const slashes = sample.map((r) => r.replace(/^\/+|\/+$/g, '')).join('').split('/').length - 1;
    const hasTexture = columns === 3 * groupCount || (columns === 2 * groupCount && slashes === columns / 2);
    const texture = hasTexture ? [] : null;
    for (const line of lines) {
      const values = pySplit(line.replace(/\//g, ' '));
      for (let g = 0; g < groupCount; g++) {
        refs.push(toIndex(values[g * perRef]));
        if (texture) texture.push(toIndex(values[g * perRef + 1]));
      }
      sizes.push(groupCount);
    }
    return { sizes, refs, texture };
  }
  let texture = [];
  for (const line of lines) {
    const words = pySplit(line);
    if (words.length < 3) continue; // trimesh skips the line
    const r = words.map((w) => toIndex(w.split('/')[0]));
    const t = words.map((w) => pyInt(w.split('/')[1] ?? ''));
    if (texture && t.some((x) => x === undefined)) texture = null;
    const corners = [];
    if (r.length === 3) corners.push(0, 1, 2);
    else if (r.length === 4) corners.push(0, 1, 2, 2, 3, 0);
    else for (let k = 1; k + 1 < r.length; k++) corners.push(0, k, k + 1);
    for (const c of corners) {
      refs.push(r[c]);
      if (texture) texture.push(t[c] > 0 ? t[c] - 1 : t[c]);
    }
    for (let c = 0; c < corners.length; c += 3) sizes.push(3);
  }
  return { sizes, refs, texture };
}

// =========================================================================== PLY

/** PLY property types as numpy types. */
const PLY_TYPES = {
  char: 'i1', uchar: 'u1', short: 'i2', ushort: 'u2', int: 'i4', int8: 'i1', int16: 'i2', int32: 'i4',
  int64: 'i8', uint: 'u4', uint8: 'u1', uint16: 'u2', uint32: 'u4', uint64: 'u8',
  float: 'f4', float16: 'f2', float32: 'f4', float64: 'f8', double: 'f8',
};
const TYPE_SIZE = { i1: 1, u1: 1, i2: 2, u2: 2, i4: 4, u4: 4, i8: 8, u8: 8, f2: 2, f4: 4, f8: 8 };

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function readBinary(view, offset, type, little) {
  switch (type) {
    case 'i1': return view.getInt8(offset);
    case 'u1': return view.getUint8(offset);
    case 'i2': return view.getInt16(offset, little);
    case 'u2': return view.getUint16(offset, little);
    case 'i4': return view.getInt32(offset, little);
    case 'u4': return view.getUint32(offset, little);
    case 'i8': return Number(view.getBigInt64(offset, little));
    case 'u8': return Number(view.getBigUint64(offset, little));
    case 'f2': return halfToFloat(view.getUint16(offset, little));
    case 'f4': return view.getFloat32(offset, little);
    default: return view.getFloat64(offset, little);
  }
}

/** numpy astype(type) of a parsed ASCII value: float32 rounding, integer truncation and wrap. */
function castTo(type, v) {
  switch (type) {
    case 'f8':
    case 'f2':
      return v;
    case 'f4':
      return Math.fround(v);
    default: {
      if (!Number.isFinite(v)) return 0;
      const bits = 8 * TYPE_SIZE[type];
      if (bits >= 53) return Math.trunc(v);
      const span = 2 ** bits;
      let w = ((Math.trunc(v) % span) + span) % span;
      if (type[0] === 'i' && w >= span / 2) w -= span;
      return w;
    }
  }
}

/**
 * PLY like trimesh.exchange.ply.load_ply. ASCII values are cast to their declared type
 * (a `float` coordinate is rounded to float32, as numpy does); polygons are triangulated
 * like trimesh; colours follow trimesh's visuals: per-vertex colours, else per-face
 * colours, and texture coordinates (per vertex or per face) make a texture visual whose
 * main colour is trimesh's default grey.
 */
function readPly(buffer) {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  let headerLines = 0;
  const readLine = () => {
    if (pos >= bytes.length) throw new Error('Header not terminated properly!');
    let nl = bytes.indexOf(10, pos);
    if (nl < 0) nl = bytes.length;
    const line = new TextDecoder().decode(bytes.subarray(pos, nl));
    pos = nl + 1;
    headerLines++;
    return line;
  };
  if (!readLine().toLowerCase().includes('ply')) throw new Error('Not a ply file!');
  const encoding = readLine().trim().toLowerCase();
  const ascii = encoding.includes('ascii');
  const little = !encoding.includes('big');

  const elements = new Map(); // name -> {length, props: Map(name -> {type, countType?})}
  let last = null;
  const plyType = (t) => {
    if (!(t in PLY_TYPES)) throw new Error(`Unknown PLY property type '${t}'`);
    return PLY_TYPES[t];
  };
  for (;;) {
    const raw = readLine().trim();
    const tokens = pySplit(raw);
    if (tokens.includes('end_header')) break;
    if (!tokens.length) continue;
    if (tokens[0].includes('element')) {
      const length = tokens.length === 3 ? pyInt(tokens[2]) : undefined;
      if (!(length >= 0)) throw new Error(`Malformed PLY element line '${raw}'`);
      last = { length, props: new Map() };
      elements.set(tokens[1], last);
    } else if (tokens[0].includes('property')) {
      if (!last) throw new Error('Property defined before any element!');
      if (tokens.length === 3) last.props.set(tokens[2], { type: plyType(tokens[1]) });
      else if (tokens[1].includes('list') && tokens.length === 5) {
        last.props.set(tokens[4], { type: plyType(tokens[3]), countType: plyType(tokens[2]) });
      }
    }
  }
  const data = ascii ? plyAscii(elements, bytes.subarray(pos), headerLines + 1) : plyBinary(elements, buffer, pos, little);

  const vertex = data.get('vertex');
  if (!vertex || !vertex.length) return { parts: [], geometryCount: 0 };
  for (const k of ['x', 'y', 'z']) if (!vertex.columns.has(k)) throw new Error(`PLY vertices have no '${k}' property`);
  const nv = vertex.length;
  const positions = interleave(vertex.columns, ['x', 'y', 'z'], nv);

  const face = data.get('face');
  const indexName = face && ['vertex_index', 'vertex_indices', ...face.lists.keys()].find((k) => face.lists.has(k));
  if (!face || !face.length || !indexName) return { parts: [], geometryCount: 0 }; // a point cloud
  const polygons = face.lists.get(indexName);
  checkRefs(polygons, nv, 'PLY');
  const indices = triangulatePolygons(polygons);

  // texture coordinates, per face (wedge) or per vertex under one of trimesh's names
  const hasTexture =
    face.lists.has('texcoord') ||
    [['texture_u', 'texture_v'], ['u', 'v'], ['s', 't']].some(([u, v]) => vertex.columns.has(u) && vertex.columns.has(v));
  let color = null;
  if (hasTexture) {
    color = [...DEFAULT_COLOR];
  } else {
    const vertexColors = plyColors(vertex.columns, nv);
    const faceColors = plyColors(face.columns, face.length);
    const normals = ['nx', 'ny', 'nz'].every((k) => vertex.columns.has(k)) ? interleave(vertex.columns, ['nx', 'ny', 'nz'], nv) : null;
    if (vertexColors) color = mainColor(vertexColors, mergedVertexRows(positions, indices, normals));
    else if (faceColors) color = mainColor(faceColors);
  }
  return single(positions, indices, color);
}

function interleave(columns, keys, n) {
  const out = new Float64Array(keys.length * n);
  keys.forEach((k, j) => {
    const col = columns.get(k);
    for (let i = 0; i < n; i++) out[keys.length * i + j] = col[i];
  });
  return out;
}

/** trimesh _element_colors + to_rgba: red/green/blue(/alpha) properties as RGBA bytes. */
function plyColors(columns, n) {
  const keys = ['red', 'green', 'blue', 'alpha'].filter((k) => columns.has(k));
  if (keys.length < 3 || !n) return null;
  const isFloat = keys.some((k) => columns.get(k).type[0] === 'f');
  const float32 = isFloat && keys.every((k) => columns.get(k).type !== 'f8');
  const rgba = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      if (j >= keys.length) {
        rgba[4 * i + j] = 255;
        continue;
      }
      const v = columns.get(keys[j])[i];
      rgba[4 * i + j] = isFloat ? floatToByte(v, float32) : ((Math.trunc(v) % 256) + 256) % 256;
    }
  }
  return rgba;
}

/**
 * Storage of one parsed element: scalar columns (Float64Array tagged with their PLY type)
 * and list properties (flat polygon lists).
 */
function plyElement(spec) {
  const columns = new Map();
  const lists = new Map();
  for (const [name, p] of spec.props) {
    if (p.countType) lists.set(name, { sizes: [], refs: [] });
    else {
      const col = new Float64Array(spec.length);
      col.type = p.type;
      columns.set(name, col);
    }
  }
  return { length: spec.length, columns, lists };
}

/**
 * ASCII data (trimesh _ply_ascii): one line per element row (Python splitlines), in
 * header order. When all rows of an element have the same number of values and it has
 * at most one list, the list length of the first row is used for every row
 * (_load_element_single). Like numpy.fromstring (which trimesh runs on every line of
 * the data), a value that is not a number fails, wherever it is; so does a vertex
 * without all of its x, y, z values. `firstLine`: line number of the data's first line.
 */
function plyAscii(elements, body, firstLine) {
  const text = new TextDecoder().decode(body);
  const breaks = new RegExp(LINE_BREAK.source, 'g');
  let pos = 0;
  let lineNumber = firstLine - 1; // of the last line read
  const nextLine = () => {
    if (pos >= text.length) return null;
    breaks.lastIndex = pos;
    const m = breaks.exec(text);
    const line = text.slice(pos, m ? m.index : text.length);
    pos = m ? m.index + m[0].length : text.length;
    lineNumber++;
    return line;
  };
  const numbers = (line, visit) => {
    for (const token of line.split(C_SPACE)) {
      if (!token) continue;
      const v = pyFloat(token);
      if (v === undefined) {
        const shown = token.length > 20 ? `${token.slice(0, 20)}...` : token;
        throw new Error(`PLY file has a value that is not a number on line ${lineNumber}: '${shown}'`);
      }
      visit(v);
    }
  };
  const out = new Map();
  for (const [name, spec] of elements) {
    if (!spec.length) continue;
    // all numbers of the element's rows, flat, with the start of every row
    const values = [];
    const push = (v) => values.push(v);
    const starts = new Uint32Array(spec.length + 1);
    const firstRow = lineNumber + 1;
    for (let i = 0; i < spec.length; i++) {
      const line = nextLine();
      if (line === null) throw new Error('PLY file is shorter than its header declares');
      starts[i] = values.length;
      numbers(line, push);
    }
    starts[spec.length] = values.length;
    const width = starts[1] - starts[0];
    const listCount = [...spec.props.values()].filter((p) => p.countType).length;
    let uniform = listCount <= 1;
    for (let i = 1; uniform && i < spec.length; i++) uniform = starts[i + 1] - starts[i] === width;

    const el = plyElement(spec);
    const fixed = []; // list lengths of the first row, used for every row when uniform
    const coordinates = name === 'vertex' ? ['x', 'y', 'z'].filter((k) => spec.props.has(k) && !spec.props.get(k).countType) : [];
    for (let i = 0; i < spec.length; i++) {
      let at = starts[i];
      const end = starts[i + 1];
      let li = 0;
      let read = 0; // coordinates of the row read
      for (const [prop, p] of spec.props) {
        if (at >= end) break;
        if (p.countType) {
          let n = Math.trunc(values[at]);
          if (uniform) n = fixed[li] ??= n;
          li++;
          const list = el.lists.get(prop);
          const stop = Math.min(at + 1 + n, end);
          for (let k = at + 1; k < stop; k++) list.refs.push(castTo(p.type, values[k]));
          list.sizes.push(Math.max(stop - at - 1, 0));
          at += n + 1;
        } else {
          el.columns.get(prop)[i] = castTo(p.type, values[at]);
          if (coordinates.includes(prop)) read++;
          at += 1;
        }
      }
      if (read < coordinates.length) throw new Error(`PLY vertex on line ${firstRow + i} has fewer values than its coordinates`);
    }
    out.set(name, el);
  }
  // trimesh parses every line of the data, also those after the last element
  for (let line = nextLine(); line !== null; line = nextLine()) numbers(line, () => {});
  return out;
}

/** Binary data, read row by row (trimesh requires every list of a property to have the first row's length). */
function plyBinary(elements, buffer, start, little) {
  const view = new DataView(buffer);
  const out = new Map();
  let at = start;
  const need = (n) => {
    if (at + n > buffer.byteLength) throw new Error('PLY is unexpected length!');
  };
  for (const [name, spec] of elements) {
    const el = plyElement(spec);
    for (let i = 0; i < spec.length; i++) {
      for (const [prop, p] of spec.props) {
        if (p.countType) {
          need(TYPE_SIZE[p.countType]);
          const n = readBinary(view, at, p.countType, little);
          at += TYPE_SIZE[p.countType];
          const size = TYPE_SIZE[p.type];
          need(n * size);
          const list = el.lists.get(prop);
          for (let k = 0; k < n; k++) list.refs.push(readBinary(view, at + k * size, p.type, little));
          list.sizes.push(n);
          at += n * size;
        } else {
          need(TYPE_SIZE[p.type]);
          el.columns.get(prop)[i] = readBinary(view, at, p.type, little);
          at += TYPE_SIZE[p.type];
        }
      }
    }
    out.set(name, el);
  }
  return out;
}

// =========================================================================== OFF

/**
 * Object File Format like trimesh.exchange.off.load_off: header "OFF" / "COFF", vertex
 * and face counts, then the vertices (first 3 values of a line) and the faces, which
 * are triangulated like trimesh. `#` comments run to the end of their line.
 */
function readOff(buffer) {
  const text = decodeText(buffer).replace(/#[^\r\n]*/g, '').trim();
  const header = /(COFF|OFF)/.exec(text);
  if (!header) throw new Error('Not an OFF file! Header was not found');
  const lines = pySplitlines(text.slice(header.index + header[0].length))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) throw new Error('OFF file is missing the vertex/face count line');
  const counts = pySplit(lines[0]).map(pyInt);
  if (counts.length < 2 || counts[0] === undefined || counts[1] === undefined) {
    throw new Error('OFF file has a malformed vertex/face count line');
  }
  const [nv, nf] = counts;
  if (lines.length < 1 + nv) throw new Error('OFF file has fewer vertices than declared');
  const positions = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    const v = pySplit(lines[1 + i]);
    for (let k = 0; k < 3; k++) {
      const x = v[k] === undefined ? undefined : pyFloat(v[k]);
      if (x === undefined) throw new Error('OFF file has a malformed vertex line');
      positions[3 * i + k] = x;
    }
  }
  const polygons = { sizes: [], refs: [] };
  for (let i = 0; i < nf && 1 + nv + i < lines.length; i++) {
    const f = pySplit(lines[1 + nv + i]);
    const n = pyInt(f[0]);
    if (n === undefined) throw new Error('OFF file has a malformed face line');
    const refs = f.slice(1, n + 1);
    for (const r of refs) polygons.refs.push(pyInt(r));
    polygons.sizes.push(refs.length);
  }
  checkRefs(polygons, nv, 'OFF');
  return single(positions, triangulatePolygons(polygons), null);
}

// =========================================================================== glTF

/**
 * glTF / GLB. three's GLTFLoader decodes the primitives (accessors, sparse and quantized
 * data, strips); the node hierarchy is walked here like trimesh: node names (or their
 * index) made unique, transforms composed as matrix * T * R * S in double precision.
 * Textures are never loaded. Units: metres by specification.
 */
async function readGltf(buffer) {
  checkGltfSupport(buffer);
  if (!isGlb(buffer)) buffer = embeddedGltfToGlb(JSON.parse(decodeText(buffer)));
  const json = glbJson(buffer);
  checkGltfAccessors(json, buffer);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  // Skip every texture, before the built-in texture plugins get a chance to load images.
  loader.pluginCallbacks.unshift(() => ({ name: 'READER3D_no_textures', loadTexture: () => Promise.resolve(null) }));
  const gltf = await new Promise((resolve, reject) => {
    try {
      loader.parse(buffer, '', resolve, (err) => reject(err instanceof Error ? err : new Error(String(err?.message ?? err))));
    } catch (err) {
      reject(err);
    }
  });
  const parser = gltf.parser;

  // Geometries: one per primitive, named like trimesh (mesh name or "GLTF", made unique).
  const meshNames = new Set();
  const meshCounts = new Map();
  const meshPrims = [];
  for (let m = 0; m < (json.meshes ?? []).length; m++) {
    const def = json.meshes[m];
    const decoded = await parser.getDependency('mesh', m);
    const objects = decoded.isGroup
      ? decoded.children.filter((c) => parser.associations.get(c)?.meshes === m && parser.associations.get(c)?.primitives !== undefined)
      : [decoded];
    const prims = [];
    for (const obj of objects) {
      const p = def.primitives[parser.associations.get(obj)?.primitives ?? 0];
      const mode = p.mode ?? 4;
      // trimesh keeps points, lines, triangles and strips (fans are read here, it drops them)
      if (![0, 1, 4, 5, 6].includes(mode)) continue;
      const name = uniqueName(def.name ?? 'GLTF', meshNames, meshCounts);
      meshNames.add(name);
      prims.push(obj.isMesh ? { name, ...gltfPrimitive(obj.geometry, p, json) } : { name, positions: null });
    }
    meshPrims.push(prims);
  }
  const geometryCount = meshNames.size;

  // Node names: the glTF name or the node index, made unique ("world" is the base frame).
  const nodes = json.nodes ?? [];
  const nodeNames = new Set();
  const nodeCounts = new Map();
  const names = nodes.map((n, i) => {
    const name = uniqueName(n.name ?? String(i), nodeNames, nodeCounts);
    nodeNames.add(name);
    return name;
  });
  const world = names.indexOf('world');
  if (world >= 0) names[world] = uniqueName('world', new Set(names));

  const parts = [];
  const scene = json.scenes?.[json.scene ?? 0];
  const visited = new Set();
  const visit = (index, parent) => {
    if (visited.has(index) || !nodes[index]) return;
    visited.add(index);
    const node = nodes[index];
    const matrix = matMul(parent, gltfNodeMatrix(node));
    const prims = node.mesh !== undefined ? meshPrims[node.mesh] ?? [] : [];
    prims.forEach((prim, k) => {
      if (!prim.positions) return;
      const frame = prims.length > 1 ? `${names[index]}_${k}` : names[index];
      parts.push({ node: frame, geometry: prim.name, positions: prim.positions, indices: prim.indices, matrix, color: prim.color });
    });
    for (const child of node.children ?? []) visit(child, matrix);
  };
  for (const root of scene?.nodes ?? []) visit(root, IDENTITY);
  return { parts, geometryCount, unit: unitFromName('meters') };
}

/** Positions (double), indices and colour of one triangle primitive. */
function gltfPrimitive(geometry, primitive, json) {
  const attr = geometry.attributes.position;
  const positions = new Float64Array(3 * attr.count);
  for (let i = 0; i < attr.count; i++) {
    positions[3 * i] = attr.getX(i);
    positions[3 * i + 1] = attr.getY(i);
    positions[3 * i + 2] = attr.getZ(i);
  }
  const indices = geometry.index ? Uint32Array.from(geometry.index.array.subarray(0, geometry.index.count)) : null;
  // trimesh: a material makes a texture visual (colour = baseColorFactor, default grey);
  // otherwise COLOR_0 gives vertex colours. Colours are linear in glTF: reported as sRGB.
  let color = null;
  const material = primitive.material !== undefined ? json.materials?.[primitive.material] : undefined;
  if (material) {
    const factor = material.pbrMetallicRoughness?.baseColorFactor;
    color = factor ? [0, 1, 2].map((k) => linearToSrgb(Math.min(Math.max(factor[k], 0), 1))) : [...DEFAULT_COLOR];
  } else if (geometry.attributes.color) {
    const c = geometry.attributes.color;
    const rgba = new Uint8Array(4 * c.count);
    for (let i = 0; i < c.count; i++) {
      rgba[4 * i] = floatToByte(linearToSrgb(c.getX(i)));
      rgba[4 * i + 1] = floatToByte(linearToSrgb(c.getY(i)));
      rgba[4 * i + 2] = floatToByte(linearToSrgb(c.getZ(i)));
      rgba[4 * i + 3] = c.itemSize > 3 ? floatToByte(c.getW(i)) : 255;
    }
    color = mainColor(rgba);
  }
  return { positions, indices, color };
}

/** Local matrix of a glTF node, like trimesh: matrix (if any) * T * R * S. */
function gltfNodeMatrix(node) {
  let m = node.matrix ? transpose(node.matrix) : IDENTITY;
  if (node.translation) {
    const [x, y, z] = node.translation;
    m = matMul(m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
  }
  if (node.rotation) m = matMul(m, quaternionMatrix(node.rotation));
  if (node.scale) {
    const [x, y, z] = node.scale;
    m = matMul(m, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  }
  return m;
}

/** Column-major 16 values (glTF) as a row-major matrix. */
function transpose(values) {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[4 * r + c] = values[4 * c + r];
  return out;
}

/** trimesh transformations.quaternion_matrix of a glTF (x, y, z, w) rotation (normalised). */
function quaternionMatrix([x, y, z, w]) {
  const n = w * w + x * x + y * y + z * z;
  if (n < 4 * Number.EPSILON) return IDENTITY;
  const s = Math.sqrt(2.0 / n);
  const q = [w * s, x * s, y * s, z * s];
  const o = (i, j) => q[i] * q[j];
  return [
    1 - o(2, 2) - o(3, 3), o(1, 2) - o(3, 0), o(1, 3) + o(2, 0), 0,
    o(1, 2) + o(3, 0), 1 - o(1, 1) - o(3, 3), o(2, 3) - o(1, 0), 0,
    o(1, 3) - o(2, 0), o(2, 3) + o(1, 0), 1 - o(1, 1) - o(2, 2), 0,
    0, 0, 0, 1,
  ];
}

const isGlb = (buffer) => buffer.byteLength >= 20 && decodeText(new Uint8Array(buffer, 0, 4)) === 'glTF';

/** The JSON chunk of a GLB. */
function glbJson(buffer) {
  const length = new DataView(buffer).getUint32(12, true);
  return JSON.parse(decodeText(new Uint8Array(buffer, 20, length)));
}

/** Length of the BIN chunk of a GLB, or -1 when it has none. */
function glbBinLength(buffer) {
  const view = new DataView(buffer);
  const at = 20 + view.getUint32(12, true);
  if (at + 8 > buffer.byteLength || view.getUint32(at + 4, true) !== 0x004e4942) return -1;
  return Math.min(view.getUint32(at, true), buffer.byteLength - at - 8);
}

const GLTF_COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GLTF_TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * The accessors must fit in the data of the file. GLTFLoader allocates whatever an
 * accessor declares (one without buffer view is zero-filled), and glTF is decoded on
 * the main thread: a 267-byte file declaring 60 million vertices froze the page for a
 * minute. An accessor reading past its buffer view, or a view past its buffer, is
 * refused, and so are accessors declaring, in all, far more data than the file holds.
 */
function checkGltfAccessors(json, buffer) {
  const bin = glbBinLength(buffer);
  const bufferBytes = (i) => (i === 0 && bin >= 0 ? bin : Number(json.buffers?.[i]?.byteLength ?? 0));
  let declared = 0;
  (json.accessors ?? []).forEach((accessor, i) => {
    const size = GLTF_COMPONENT_BYTES[accessor.componentType] * GLTF_TYPE_COMPONENTS[accessor.type];
    const count = accessor.count;
    if (!(size > 0) || !Number.isSafeInteger(count) || count < 0) return; // malformed: the loader reports it
    declared += count * size;
    if (accessor.bufferView === undefined || count === 0) return; // zero-filled (sparse) data
    const view = json.bufferViews?.[accessor.bufferView];
    const end = (accessor.byteOffset ?? 0) + (count - 1) * (view?.byteStride ?? size) + size;
    if (!view || end > view.byteLength || (view.byteOffset ?? 0) + view.byteLength > bufferBytes(view.buffer)) {
      throw new Error(`The glTF file is damaged: accessor ${i} needs more data than its buffer holds`);
    }
  });
  if (declared > Math.max(64 * buffer.byteLength, 2 ** 24)) {
    throw new Error('The glTF file is damaged: its accessors declare far more data than the file holds');
  }
}

/**
 * Repack a .gltf whose buffers are embedded data URIs as an in-memory GLB (one binary
 * chunk), so that the loader never fetches anything (fetching data URIs needs browser
 * APIs that Node lacks).
 */
function embeddedGltfToGlb(json) {
  const chunks = [];
  const offsets = [];
  let total = 0;
  for (const def of json.buffers ?? []) {
    const uri = def.uri ?? '';
    const comma = uri.indexOf(',');
    const data = uri.slice(comma + 1);
    const bytes = /;base64$/i.test(uri.slice(0, comma))
      ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(data));
    offsets.push(total);
    chunks.push(bytes);
    total += bytes.length + ((4 - (bytes.length % 4)) % 4);
  }
  const packed = {
    ...json,
    buffers: total ? [{ byteLength: total }] : [],
    bufferViews: (json.bufferViews ?? []).map((v) => ({ ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + offsets[v.buffer] })),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(packed));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const length = 12 + 8 + jsonBytes.length + jsonPad + (total ? 8 + total : 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (total) {
    const at = 20 + jsonBytes.length + jsonPad;
    view.setUint32(at, total, true);
    view.setUint32(at + 4, 0x004e4942, true); // "BIN"
    chunks.forEach((bytes, i) => out.set(bytes, at + 8 + offsets[i]));
  }
  return out.buffer;
}

/**
 * Clear errors for what a single uploaded glTF file cannot provide: buffers stored in
 * separate files, and compressed geometry (no Draco / meshopt decoder is shipped).
 */
function checkGltfSupport(buffer) {
  let json;
  try {
    json = isGlb(buffer) ? glbJson(buffer) : JSON.parse(decodeText(buffer));
  } catch {
    return; // let the loader report malformed files
  }
  const compressed = (json.extensionsRequired ?? []).filter((e) =>
    ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression'].includes(e),
  );
  if (compressed.length) {
    throw new Error(`Compressed glTF geometry (${compressed.join(', ')}) is not supported: export it without compression`);
  }
  const external = (json.buffers ?? []).map((b) => b.uri).find((uri) => uri !== undefined && !/^data:/i.test(uri));
  if (external !== undefined) {
    throw new Error(`The glTF file stores its geometry in a separate file ('${external}'): open the .glb version or a .gltf with embedded buffers`);
  }
}

// =========================================================================== XML

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}

/** Element and attribute names without their namespace prefix (lxml `{*}name`). */
const localName = (qname) => qname.slice(qname.indexOf(':') + 1);

const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Attributes of a start tag (names as written, values with entities decoded). */
function parseAttributes(s) {
  const out = Object.create(null);
  ATTRIBUTE.lastIndex = 0;
  let m;
  while ((m = ATTRIBUTE.exec(s)) !== null) out[m[1]] = decodeXml(m[2] ?? m[3]);
  return out;
}

function endOf(text, marker, from) {
  const at = text.indexOf(marker, from);
  if (at < 0) throw new Error('Malformed XML: unterminated markup');
  return at + marker.length;
}

/**
 * Minimal non-validating XML scanner (enough for 3MF and COLLADA, no DOM needed):
 * calls handler.open(name, attributeText), handler.close(name) (also right after a
 * self-closing tag) and handler.text(text) for character data inside elements. Names
 * lose their namespace prefix. Comments, processing instructions and DOCTYPE are skipped;
 * mismatched tags throw like a strict parser.
 */
function scanXml(text, handler) {
  const n = text.length;
  const stack = [];
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const stop = lt < 0 ? n : lt;
    if (stop > i && stack.length && handler.text) handler.text(decodeXml(text.slice(i, stop)));
    if (lt < 0) break;
    const c1 = text.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      if (text.startsWith('<!--', lt)) i = endOf(text, '-->', lt + 4);
      else if (text.startsWith('<![CDATA[', lt)) {
        i = endOf(text, ']]>', lt + 9);
        if (stack.length && handler.text) handler.text(text.slice(lt + 9, i - 3));
      } else {
        // <!DOCTYPE ...> with an optional [internal subset]
        let depth = 0, j = lt + 2;
        for (; j < n; j++) {
          const c = text.charCodeAt(j);
          if (c === 91) depth++;
          else if (c === 93) depth--;
          else if (c === 62 && depth <= 0) break;
        }
        i = j + 1;
      }
      continue;
    }
    if (c1 === 63 /* ? */) {
      i = endOf(text, '?>', lt + 2);
      continue;
    }
    if (c1 === 47 /* / */) {
      const gt = text.indexOf('>', lt + 2);
      if (gt < 0) throw new Error('Malformed XML: unterminated closing tag');
      const name = localName(text.slice(lt + 2, gt).trim());
      if (stack.pop() !== name) throw new Error(`Malformed XML: unexpected closing tag </${name}>`);
      handler.close(name);
      i = gt + 1;
      continue;
    }
    // start tag, up to the first '>' outside quotes
    let j = lt + 1, quote = 0;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
    }
    if (j >= n) throw new Error('Malformed XML: unterminated tag');
    const selfClosing = text.charCodeAt(j - 1) === 47;
    const end = selfClosing ? j - 1 : j;
    let k = lt + 1;
    while (k < end && text.charCodeAt(k) > 32) k++;
    const name = localName(text.slice(lt + 1, k));
    handler.open(name, text.slice(k, end));
    if (selfClosing) handler.close(name);
    else stack.push(name);
    i = j + 1;
  }
  if (stack.length) throw new Error(`Malformed XML: element <${stack.pop()}> is not closed`);
}

/** XML document as a tree of {name, attrs, children, text} (text: all character data inside). */
function parseXmlTree(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '', parts: null };
  const stack = [root];
  scanXml(text, {
    open(name, attrText) {
      const el = { name, attrs: parseAttributes(attrText), children: [], text: '', parts: null };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    },
    close() {
      const el = stack.pop();
      if (el.parts) el.text = el.parts.join('');
      el.parts = null;
    },
    text(s) {
      (stack[stack.length - 1].parts ??= []).push(s);
    },
  });
  return root;
}

const childOf = (el, name) => el?.children.find((c) => c.name === name);
const childrenOf = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);

// =========================================================================== 3MF

// Bare specifiers ("three/...") are resolved by the page's import map, or by Node;
// import maps do not apply inside Web Workers, hence the URL fallback to the
// vendored copy next to this file.
async function fflate() {
  try {
    return await import('three/addons/libs/fflate.module.js');
  } catch {
    return import(new URL('../vendor/three/addons/libs/fflate.module.js', import.meta.url).href);
  }
}

/**
 * 3MF like trimesh.exchange.threemf.load_3MF: one geometry per object with a mesh,
 * placed by the build items through the component tree (transforms multiplied in
 * double precision); scene node names come from the object names (or ids) or the item
 * part numbers, made unique; SolidWorks-style "Body" meshes take their parent's name.
 * trimesh reads no 3MF colours, so neither does this reader. Units: the `unit`
 * attribute of the model (default millimetre).
 */
async function read3mf(buffer) {
  const { unzipSync, strFromU8 } = await fflate();
  const files = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(files);
  const rels = files['_rels/.rels'] ? strFromU8(files['_rels/.rels']) : '';
  const relTarget = /Target\s*=\s*["']\/?([^"']+\.model)["']/i.exec(rels)?.[1];
  const modelName =
    names.find((k) => k.toLowerCase().includes('3d/3dmodel.model')) ??
    (relTarget && files[relTarget] ? relTarget : names.find((k) => /\.model$/i.test(k)));
  if (!modelName) throw new Error('The 3MF archive does not contain a 3D model');

  const { unit: declared, events } = parse3mfModel(strFromU8(files[modelName]));
  const unit = unitFromName(declared ?? 'millimeters') ?? { name: 'mm', factor: 1.0 };

  const idName = new Map();
  const consumed = new Set();
  const consumedCounts = new Map();
  const meshes = new Map(); // object id -> [{v, f}]
  const components = new Map(); // object id -> [[child id, matrix]]
  const buildItems = [];
  const addMesh = (id, mesh) => {
    if (!meshes.has(id)) meshes.set(id, []);
    meshes.get(id).push(mesh);
  };
  for (const ev of events) {
    if (ev.type === 'build') {
      for (const item of ev.items) buildItems.push([item.objectid, threeMfTransform(item), item.partnumber ?? null]);
      continue;
    }
    const id = ev.attrs.id;
    const name = uniqueName(ev.attrs.name ?? String(id), consumed, consumedCounts);
    consumed.add(name);
    idName.set(id, name);
    for (const mesh of ev.meshes) addMesh(id, mesh);
    for (const c of ev.components) {
      const child = c.objectid;
      if (!components.has(id)) components.set(id, []);
      components.get(id).push([child, threeMfTransform(c)]);
      // production extension: the component's mesh lives in another model part
      const key = Object.keys(c).find((k) => k.endsWith('path'));
      const path = key === undefined ? undefined : c[key].replace(/^\/+|\/+$/g, '');
      if (path !== undefined && files[path]) {
        const sub = uniqueName(ev.attrs.name ?? String(child), consumed, consumedCounts);
        consumed.add(sub);
        idName.set(child, sub);
        for (const mesh of parse3mfModel(strFromU8(files[path]), true).meshes) addMesh(child, mesh);
      }
    }
  }

  // one geometry per object id with meshes (trimesh util.append_faces)
  const geometry = new Map(); // geometry name -> {positions, indices}
  for (const [id, list] of meshes) {
    const nv = list.reduce((s, m) => s + m.v.length / 3, 0);
    const positions = new Float64Array(3 * nv);
    const indices = new Uint32Array(list.reduce((s, m) => s + m.f.length, 0));
    let vo = 0, fo = 0;
    for (const m of list) {
      positions.set(m.v, 3 * vo);
      for (let i = 0; i < m.f.length; i++) {
        if (!(m.f[i] >= 0 && m.f[i] < m.v.length / 3)) throw new Error('3MF triangle refers to a missing vertex');
        indices[fo + i] = m.f[i] + vo;
      }
      vo += m.v.length / 3;
      fo += m.f.length;
    }
    geometry.set(idName.get(id), { positions, indices });
  }

  // scene graph: build items under "world", components under their object
  const graph = new MultiDiGraph();
  for (const [gid, matrix, partnumber] of buildItems) graph.addEdge('world', gid, partnumber, matrix);
  for (const [start, group] of components) for (const [gid, matrix] of group) graph.addEdge(start, gid, null, matrix);

  const frames = [];
  const used = new Set();
  const parents = new Map();
  for (const path of graph.paths('world')) {
    const last = path[path.length - 1][0];
    if (!idName.has(last)) continue;
    let matrix = IDENTITY;
    for (let k = 1; k < path.length; k++) matrix = matMul(matrix, graph.matrix(path[k - 1][0], path[k][0], path[k][1]));
    const key = path[path.length - 1][1];
    const name = uniqueName(path.length > 1 && typeof key === 'string' ? key : idName.get(last), used);
    used.add(name);
    if (path.length > 2) {
      const parent = path[path.length - 2][0];
      if (!parents.has(parent)) parents.set(parent, new Set());
      parents.get(parent).add(last);
    }
    frames.push({ node: name, geometry: idName.get(last), matrix });
  }

  // SolidWorks exports every body as its own mesh named "Body...": use the part name
  const rename = new Map([...geometry.keys()].map((k) => [k, k]));
  if ([...geometry.keys()].every((k) => k.toLowerCase().includes('body'))) {
    for (const [parent, children] of parents) {
      if (children.size !== 1) continue;
      rename.set(idName.get([...children][0]), idName.get(parent).split('(')[0]);
    }
  }
  const renamed = new Map([...geometry].map(([k, g]) => [rename.get(k), g]));

  const parts = [];
  for (const f of frames) {
    const name = rename.get(f.geometry) ?? f.geometry;
    const g = renamed.get(name);
    if (!g) continue; // an object without mesh (trimesh would fail)
    parts.push({ node: f.node, geometry: name, positions: g.positions, indices: g.indices, matrix: f.matrix, color: null });
  }
  return { parts, geometryCount: renamed.size, unit };
}

/**
 * Events of a 3MF model part, in document order like trimesh's iterparse: one per
 * `object` (its attributes, meshes and components) and one per `build` (its items).
 * With `meshesOnly`, every mesh of the part (production extension sub-models).
 */
function parse3mfModel(text, meshesOnly = false) {
  const events = [];
  const allMeshes = [];
  const stack = [];
  let unit = null;
  let first = true;
  let object = null, mesh = null, build = null;
  const number = (attrs, key, parse, what) => {
    const v = attrs[key] === undefined ? undefined : parse(attrs[key]);
    if (v === undefined) throw new Error(`3MF ${what} has an invalid '${key}' attribute`);
    return v;
  };
  scanXml(text, {
    open(name, attrText) {
      const parent = stack[stack.length - 1];
      stack.push(name);
      if (first) {
        first = false;
        if (name === 'model') unit = parseAttributes(attrText).unit ?? null;
      }
      if (name === 'object' && !object) object = { attrs: parseAttributes(attrText), meshes: [], components: [], depth: stack.length };
      else if (name === 'mesh' && !mesh && (object || meshesOnly)) mesh = { v: [], f: [], depth: stack.length, vState: 0, tState: 0 };
      else if (mesh && parent === 'mesh' && name === 'vertices' && mesh.vState === 0) mesh.vState = stack.length;
      else if (mesh && parent === 'mesh' && name === 'triangles' && mesh.tState === 0) mesh.tState = stack.length;
      else if (mesh && name === 'vertex' && mesh.vState > 0) {
        const a = parseAttributes(attrText);
        mesh.v.push(number(a, 'x', pyFloat, 'vertex'), number(a, 'y', pyFloat, 'vertex'), number(a, 'z', pyFloat, 'vertex'));
      } else if (mesh && name === 'triangle' && mesh.tState > 0) {
        const a = parseAttributes(attrText);
        mesh.f.push(number(a, 'v1', pyInt, 'triangle'), number(a, 'v2', pyInt, 'triangle'), number(a, 'v3', pyInt, 'triangle'));
      } else if (name === 'component' && object) object.components.push(parseAttributes(attrText));
      else if (name === 'build' && !build) build = { items: [], depth: stack.length };
      else if (name === 'item' && build) build.items.push(parseAttributes(attrText));
    },
    close(name) {
      const depth = stack.length;
      stack.pop();
      if (mesh && name === 'vertices' && depth === mesh.vState) mesh.vState = -1;
      else if (mesh && name === 'triangles' && depth === mesh.tState) mesh.tState = -1;
      else if (mesh && name === 'mesh' && depth === mesh.depth) {
        const done = { v: Float64Array.from(mesh.v), f: mesh.f };
        if (object) object.meshes.push(done);
        allMeshes.push(done);
        mesh = null;
      } else if (object && name === 'object' && depth === object.depth) {
        events.push({ type: 'object', ...object });
        object = null;
      } else if (build && name === 'build' && depth === build.depth) {
        events.push({ type: 'build', items: build.items });
        build = null;
      }
    },
  });
  return { unit, events, meshes: allMeshes };
}

/** trimesh _attrib_to_transform: "m00 m01 m02 m10 ... m32" (3MF row vectors) as a 4x4 matrix. */
function threeMfTransform(attrs) {
  if (attrs.transform === undefined) return IDENTITY;
  const v = pySplit(attrs.transform).map(pyFloat);
  if (v.length !== 12 || v.some((x) => x === undefined)) throw new Error(`3MF transform '${attrs.transform}' must hold 12 numbers`);
  return [v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1];
}

/**
 * The subset of networkx.MultiDiGraph used by trimesh's 3MF scene: insertion-ordered
 * adjacency, integer edge keys allocated like new_edge_key, and graph.multigraph_paths
 * (depth-first, the first edge continues the current path, the others are queued LIFO).
 */
class MultiDiGraph {
  constructor() {
    this.adj = new Map(); // node -> Map(child -> Map(key -> matrix))
  }

  addEdge(u, v, key, matrix) {
    if (!this.adj.has(u)) this.adj.set(u, new Map());
    if (!this.adj.has(v)) this.adj.set(v, new Map());
    const children = this.adj.get(u);
    if (!children.has(v)) children.set(v, new Map());
    const keys = children.get(v);
    if (key === null || key === undefined) {
      key = keys.size;
      while (keys.has(key)) key++;
    }
    keys.set(key, matrix);
  }

  matrix(u, v, key) {
    return this.adj.get(u).get(v).get(key);
  }

  *paths(source) {
    if (!this.adj.has(source)) return;
    let edges = 0;
    for (const children of this.adj.values()) for (const keys of children.values()) edges += keys.size;
    const cutoff = edges * this.adj.size + 1;
    let current = [[source, 0]];
    const queue = [];
    for (let step = 0; step < cutoff; step++) {
      const children = this.adj.get(current[current.length - 1][0]);
      if (children.size === 0) {
        yield current;
        if (!queue.length) return;
        current = queue.pop();
        continue;
      }
      let firstEdge = true;
      for (const [node, keys] of children) {
        for (const key of keys.keys()) {
          if (firstEdge) {
            current.push([node, key]);
            firstEdge = false;
          } else {
            queue.push([...current.slice(0, -1), [node, key]]);
          }
        }
      }
    }
  }
}

// =========================================================================== COLLADA

/** The COLLADA document of a .zae archive: like trimesh, the first file ending in .dae. */
async function zaeDocument(buffer) {
  const { unzipSync, strFromU8 } = await fflate();
  const files = unzipSync(new Uint8Array(buffer));
  const name = Object.keys(files).find((f) => f.toLowerCase().endsWith('.dae'));
  if (!name) throw new Error('The .zae archive does not contain a COLLADA (.dae) document');
  return strFromU8(files[name]);
}

/** Unit declared by the root `<asset><unit meter="..."/>` (COLLADA default: 1 metre). */
function colladaUnit(root) {
  const meter = Number(childOf(childOf(root, 'asset'), 'unit')?.attrs.meter ?? 1);
  const metres = Number.isFinite(meter) && meter > 0 ? meter : 1;
  const factor = metres * 1000; // mm per file unit
  for (const [name, value] of Object.entries(UNITS)) {
    if (Math.abs(value - factor) <= 1e-9 * value) return { name, factor: value };
  }
  return { name: `${metres} m`, factor };
}

/** numpy.fromstring(text, float32, sep=" ") as doubles holding float32 values. */
const float32Values = (text) => fromString(text ?? '').map(Math.fround);
const intValues = (text) => fromString(text ?? '', pyInt);

/**
 * COLLADA like trimesh.exchange.dae.load_collada (pycollada): every instance of a
 * geometry gives one part per triangle primitive (triangles, tristrips, trifans,
 * polylist, polygons; fans from the first vertex), as a triangle soup of float32
 * values; node transforms (matrix, translate, rotate, scale, lookat) are multiplied in
 * order. Parts are named after their geometry id, made unique. Colour: the diffuse
 * colour of the bound material (white without one), else the vertex colours.
 */
function readCollada(text) {
  const doc = parseXmlTree(text);
  const root = childOf(doc, 'COLLADA');
  if (!root) throw new Error('Not a COLLADA document');
  const library = (lib, tag) => {
    const map = new Map();
    for (const l of childrenOf(root, lib)) for (const el of childrenOf(l, tag)) if (el.attrs.id !== undefined) map.set(el.attrs.id, el);
    return map;
  };
  const ctx = {
    geometries: library('library_geometries', 'geometry'),
    materials: library('library_materials', 'material'),
    effects: library('library_effects', 'effect'),
    nodes: library('library_nodes', 'node'),
    loadedGeometries: new Map(),
    loadedNodes: new Map(),
    sceneNodes: new Map(),
  };
  const scenes = library('library_visual_scenes', 'visual_scene');
  const url = childOf(childOf(root, 'scene'), 'instance_visual_scene')?.attrs.url;
  const scene = (url && scenes.get(url.slice(1))) ?? scenes.values().next().value;

  const parts = [];
  const names = new Set();
  const counts = new Map();
  const walk = (node, parentMatrix) => {
    for (const child of node.children) {
      if (child.kind === 'geometry') {
        for (const prim of child.geometry.primitives) {
          const name = uniqueName(child.geometry.id, names, counts);
          names.add(name);
          const color = child.materials.has(prim.material) ? colladaMaterialColor(child.materials.get(prim.material), ctx) : prim.color;
          parts.push({ node: name, geometry: name, positions: prim.positions, indices: null, matrix: parentMatrix, color });
        }
      } else {
        walk(child.node, matMul(parentMatrix, child.node.matrix));
      }
    }
  };
  if (scene) {
    const top = childrenOf(scene, 'node');
    for (const el of top) if (el.attrs.id) ctx.sceneNodes.set(el.attrs.id, el);
    for (const el of top) {
      const node = colladaNode(el, ctx, 0);
      walk({ children: [{ kind: 'node', node }] }, IDENTITY);
    }
  }
  return { parts, geometryCount: names.size, unit: colladaUnit(root) };
}

/**
 * pycollada Node: its transforms multiplied in order (float32 matrix) and its children:
 * nodes, geometry instances (with their material bindings) and instanced nodes.
 */
function colladaNode(el, ctx, depth) {
  if (ctx.loadedNodes.has(el)) return ctx.loadedNodes.get(el);
  const node = { matrix: IDENTITY, children: [] };
  ctx.loadedNodes.set(el, node);
  if (depth > 64) return node; // instance cycle
  const transforms = [];
  for (const sub of el.children) {
    switch (sub.name) {
      case 'node':
        node.children.push({ kind: 'node', node: colladaNode(sub, ctx, depth + 1) });
        break;
      case 'translate': case 'rotate': case 'scale': case 'matrix': case 'lookat': {
        const m = colladaTransform(sub);
        if (m) transforms.push(m);
        break;
      }
      case 'instance_geometry': {
        const geometry = colladaGeometry(String(sub.attrs.url ?? '').slice(1), ctx);
        if (!geometry) break;
        const materials = new Map();
        for (const bind of childrenOf(sub, 'bind_material')) {
          for (const tech of childrenOf(bind, 'technique_common')) {
            for (const im of childrenOf(tech, 'instance_material')) materials.set(im.attrs.symbol, String(im.attrs.target ?? '').slice(1));
          }
        }
        node.children.push({ kind: 'geometry', geometry, materials });
        break;
      }
      case 'instance_node': {
        const id = String(sub.attrs.url ?? '').slice(1);
        const target = ctx.sceneNodes.get(id) ?? ctx.nodes.get(id);
        if (target) node.children.push({ kind: 'node', node: colladaNode(target, ctx, depth + 1) });
        break;
      }
      default:
        break; // cameras, lights, controllers, extras: no triangle geometry for trimesh
    }
  }
  if (transforms.length) {
    let m = transforms[0];
    for (let k = 1; k < transforms.length; k++) m = matMul(m, transforms[k]);
    node.matrix = Float64Array.from(m, Math.fround);
  }
  return node;
}

/** pycollada transform elements as float32 4x4 matrices (malformed ones are ignored, like pycollada). */
function colladaTransform(el) {
  const v = float32Values(el.text);
  switch (el.name) {
    case 'translate':
      return v.length === 3 ? [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1] : null;
    case 'scale':
      return v.length === 3 ? [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1] : null;
    case 'matrix':
      return v.length === 16 ? v : null;
    case 'rotate': {
      if (v.length !== 4) return null;
      const [x, y, z] = v;
      const angle = (v[3] * Math.PI) / 180;
      const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
      return [
        t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
        t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
        0, 0, 0, 1,
      ].map(Math.fround);
    }
    case 'lookat': {
      if (v.length !== 9) return null;
      const unit = (a) => {
        const l = Math.hypot(a[0], a[1], a[2]);
        return a.map((x) => x / l);
      };
      const eye = v.slice(0, 3), up = v.slice(6, 9);
      const front = unit([eye[0] - v[3], eye[1] - v[4], eye[2] - v[5]]);
      const cross = [front[1] * up[2] - front[2] * up[1], front[2] * up[0] - front[0] * up[2], front[0] * up[1] - front[1] * up[0]];
      const side = unit(cross).map((x) => -x);
      // pycollada's layout, eye in the last row
      return [...side, 0, ...up, 0, ...front, 0, ...eye, 1].map(Math.fround);
    }
    default:
      return null;
  }
}

/**
 * pycollada Geometry with trimesh's use of it: the triangle primitives as soups
 * (positions of every corner), their material symbol and their vertex colour. A
 * geometry pycollada cannot load (unknown primitive type, missing data, index out of
 * range) is left out, as pycollada's ignored errors do.
 */
function colladaGeometry(id, ctx) {
  if (ctx.loadedGeometries.has(id)) return ctx.loadedGeometries.get(id);
  let geometry = null;
  try {
    const el = ctx.geometries.get(id);
    geometry = el ? loadColladaGeometry(el) : null;
  } catch (err) {
    if (!(err instanceof ColladaSkip)) throw err;
    geometry = null;
  }
  ctx.loadedGeometries.set(id, geometry);
  return geometry;
}

/** A geometry pycollada would refuse (its error is in trimesh's ignore list). */
class ColladaSkip extends Error {}

function loadColladaGeometry(el) {
  const mesh = childOf(el, 'mesh');
  if (!mesh) throw new ColladaSkip('Unknown geometry node');
  const sources = new Map(); // id -> {data, width} | {inputs: Map(semantic -> source)}
  let vertices = null;
  const primitiveEls = [];
  for (const sub of mesh.children) {
    if (sub.name === 'source') {
      const array = childOf(sub, 'float_array');
      const params = childrenOf(childOf(childOf(sub, 'technique_common'), 'accessor'), 'param');
      if (array) {
        if (!params.length) throw new ColladaSkip('No accessor info in source node');
        const data = float32Values(array.text).map((x) => (Number.isNaN(x) ? 0 : x));
        sources.set(sub.attrs.id, { data, width: params.length });
      }
    } else if (sub.name === 'vertices') vertices = sub;
    else if (['triangles', 'tristrips', 'trifans', 'polylist', 'polygons', 'lines'].includes(sub.name)) primitiveEls.push(sub);
    else if (sub.name !== 'extra') throw new ColladaSkip(`Unknown geometry tag ${sub.name}`);
  }
  if (vertices) {
    const inputs = new Map();
    for (const input of childrenOf(vertices, 'input')) {
      const src = input.attrs.source;
      if (!input.attrs.semantic || !src?.startsWith('#')) throw new ColladaSkip('Bad input definition inside vertices');
      inputs.set(input.attrs.semantic, sources.get(src.slice(1)));
    }
    if (!vertices.attrs.id || !inputs.has('POSITION')) throw new ColladaSkip('Bad vertices definition in mesh');
    sources.set(vertices.attrs.id, { inputs });
  }

  const primitives = [];
  for (const pel of primitiveEls) {
    if (pel.name === 'lines') continue; // line sets: no triangles
    const prim = colladaPrimitive(pel, sources);
    if (prim) primitives.push(prim);
  }
  return { id: el.attrs.id ?? '', primitives };
}

/** One triangle primitive: inputs by semantic (VERTEX expanded from <vertices>), triangulated index rows. */
function colladaPrimitive(el, sources) {
  const inputs = new Map(); // semantic -> [{offset, source}]
  let maxOffset = 0;
  for (const input of childrenOf(el, 'input')) {
    const offset = pyInt(String(input.attrs.offset ?? ''));
    if (offset === undefined) throw new ColladaSkip('Corrupted offsets in primitive');
    const ref = String(input.attrs.source ?? '');
    const src = sources.get(ref.slice(1));
    const add = (semantic, source) => {
      if (!inputs.has(semantic)) inputs.set(semantic, []);
      inputs.get(semantic).push({ offset, source });
    };
    if (input.attrs.semantic === 'VERTEX' && src?.inputs) {
      for (const [semantic, source] of src.inputs) add(semantic === 'POSITION' ? 'VERTEX' : semantic, source);
    } else {
      if (!src) throw new ColladaSkip(`Source input id "${ref}" not found`);
      add(input.attrs.semantic, src);
    }
    maxOffset = Math.max(maxOffset, offset);
  }
  const stride = maxOffset + 1;
  const ps = childrenOf(el, 'p');
  // triangle corners as rows of `stride` indices
  let rows = [];
  const split = (values) => {
    if (values.length % stride) throw new ColladaSkip('Corrupted index');
    const out = [];
    for (let i = 0; i < values.length; i += stride) out.push(values.slice(i, i + stride));
    return out;
  };
  const fan = (poly) => {
    for (let k = 1; k + 1 < poly.length; k++) rows.push(poly[0], poly[k], poly[k + 1]);
  };
  switch (el.name) {
    case 'triangles':
      if (!ps.length) throw new ColladaSkip('Missing index in triangle set');
      rows = split(intValues(ps[0].text));
      break;
    case 'tristrips':
      for (const p of ps) {
        const s = split(intValues(p.text));
        for (let k = 0; k + 2 < s.length; k += 2) rows.push(s[k], s[k + 1], s[k + 2]);
        for (let k = 1; k + 2 < s.length; k += 2) rows.push(s[k + 1], s[k], s[k + 2]);
      }
      break;
    case 'trifans':
      for (const p of ps) fan(split(intValues(p.text)));
      break;
    case 'polylist': {
      const vcount = intValues(childOf(el, 'vcount')?.text);
      const all = split(intValues(ps[0]?.text));
      let at = 0;
      for (const n of vcount) {
        fan(all.slice(at, at + n));
        at += n;
      }
      break;
    }
    case 'polygons':
      for (const p of ps) fan(split(intValues(p.text)));
      break;
    default:
      return null;
  }
  if (rows.length % 3) throw new ColladaSkip('Corrupted index');
  const vertex = inputs.get('VERTEX')?.[0];
  if (!vertex) throw new ColladaSkip('Triangle set requires vertex input');
  if (!rows.length) return null; // pycollada: no vertex data, trimesh skips it
  if (!vertex.source?.data || vertex.source.width < 3) throw new ColladaSkip('Positions need X, Y and Z');

  const { data, width } = vertex.source;
  const nPositions = Math.floor(data.length / width);
  const positions = new Float64Array(3 * rows.length);
  rows.forEach((row, i) => {
    const v = row[vertex.offset];
    if (!(v >= 0 && v < nPositions)) throw new ColladaSkip('Vertex index out of range');
    for (let k = 0; k < 3; k++) positions[3 * i + k] = data[width * v + k];
  });

  // vertex colours, counted over the corners trimesh's merge keeps (position + normal)
  let color = null;
  const colorInput = inputs.get('COLOR')?.[0];
  if (colorInput?.source?.data) {
    const { data: c, width: cw } = colorInput.source;
    const rgba = new Uint8Array(4 * rows.length);
    let ok = true;
    rows.forEach((row, i) => {
      const j = row[colorInput.offset];
      if (!(j >= 0 && (j + 1) * cw <= c.length)) ok = false;
      for (let k = 0; k < 4; k++) rgba[4 * i + k] = k < cw ? floatToByte(c[cw * j + k], true) : 255;
    });
    const normalInput = inputs.get('NORMAL')?.[0];
    let normals = null;
    if (normalInput?.source?.data) {
      const { data: nd, width: nw } = normalInput.source;
      normals = new Float64Array(3 * rows.length);
      rows.forEach((row, i) => {
        for (let k = 0; k < 3; k++) normals[3 * i + k] = nd[nw * row[normalInput.offset] + k];
      });
    }
    if (ok) color = mainColor(rgba, mergedVertexRows(positions, Uint32Array.from(rows.keys()), normals));
  }
  return { positions, material: el.attrs.material, color };
}

/**
 * trimesh _parse_material: the diffuse colour of the material's effect (profile_COMMON,
 * first of phong / lambert / blinn / constant), white when it has none or a texture.
 */
function colladaMaterialColor(materialId, ctx) {
  const material = ctx.materials.get(materialId);
  const effectUrl = childOf(material, 'instance_effect')?.attrs.url;
  const effect = effectUrl ? ctx.effects.get(effectUrl.slice(1)) : undefined;
  const technique = childOf(childOf(effect, 'profile_COMMON'), 'technique');
  const shader = ['phong', 'lambert', 'blinn', 'constant'].map((s) => childOf(technique, s)).find(Boolean);
  const value = childOf(shader, 'diffuse')?.children[0];
  let rgb = [1, 1, 1];
  if (value?.name === 'color') {
    const c = pySplit(value.text).map(pyFloat);
    if (c.every((x) => x !== undefined)) rgb = [0, 1, 2].map((k) => c[k] ?? 0);
  }
  return rgb.map((x) => floatToByte(x) / 255);
}
