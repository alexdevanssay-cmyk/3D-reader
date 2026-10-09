// Results of the 3D analyses shared on the network (web/engine/shared-cache.js):
// their container (typed arrays out of the JSON, then their bytes), its gzip,
// the names of their files, the checks of what is read.
//
//   node --test tests/js/shared-cache.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheKey } from '../../web/engine/cache.js';
import {
  CONTAINER_VERSION, containerParts, gunzip, gzip, meshHash, packValue, parseKey, readContainer, sharedNames, streamOf, unpackValue, validData, validThickness,
} from '../../web/engine/shared-cache.js';

/** A container written then read back, through gzip when `zip`. */
async function roundTrip(value, meta = {}, { zip = true } = {}) {
  const parts = containerParts(value, meta);
  const stream = streamOf(parts);
  return readContainer(zip ? gunzip(gzip(stream)) : stream);
}

const bytesOf = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

test('the container: typed arrays of every kind, nested objects and arrays, numbers JSON cannot write, a key "$r3d" of the data, back as they were', async () => {
  const shared = new Float32Array([0.5, -1.25, NaN]);
  const value = {
    file: 'Carter 4711.step',
    kind: 'cad',
    units: { length: 'mm' },
    summary: { volume: 1234.5, fill_ratio: null, ratio: Infinity, low: -Infinity, nan: NaN, closed: true, list: [1, 'deux', null, false] },
    bodies: [
      { name: 'a', mesh: { positions: shared, indices: new Uint32Array([0, 1, 2, 4294967295]), positions64: new Float64Array([Math.PI, -0, 1e-300]) }, color: [0.1, 0.2, 0.3] },
      { name: 'b', mesh: { positions: shared, indices: new Uint32Array(0) }, topology: { faces: new Int32Array([-1, 2 ** 31 - 1]), kinds: new Uint8Array([1, 2, 255]), small: new Int8Array([-128, 127]) } },
    ],
    more: [new Int16Array([-32768, 32767]), new Uint16Array([65535]), new Uint8ClampedArray([0, 255]), new BigInt64Array([-(2n ** 63n)]), [[new Float32Array([7])]]],
    odd: { $r3d: 'a key of the data', nested: { $r3d: { t: 0 } } },
    empty: {},
  };
  const { meta, value: back } = await roundTrip(value, { part: 'analyse', key: { cache: 2 } });
  assert.deepEqual(meta, { format: 'reader3d-resultats', version: CONTAINER_VERSION, part: 'analyse', key: { cache: 2 } });
  assert.deepEqual(back, value);
  for (const [a, b] of [[back.bodies[0].mesh.positions, value.bodies[0].mesh.positions], [back.more[3], value.more[3]], [back.more[4][0][0], value.more[4][0][0]]]) {
    assert.equal(a.constructor, b.constructor);
  }
  assert.ok(Object.is(back.bodies[0].mesh.positions64[1], -0), '-0 kept in a typed array');
  // The same array twice: written once, read as one array.
  assert.equal(back.bodies[0].mesh.positions, back.bodies[1].mesh.positions);
  assert.equal(packValue(value).arrays.length, 12);
  // Each array a buffer of its own (not views of one large buffer).
  assert.equal(back.bodies[0].mesh.indices.buffer.byteLength, 16);
  // Without gzip too.
  assert.deepEqual((await roundTrip(value, {}, { zip: false })).value, value);
});

test('the container: its bytes, the arrays aligned for their type; a large array split for the compression', async () => {
  const value = { a: new Uint8Array([1, 2, 3]), b: new Float64Array([1.5]), c: new Float32Array(300_000).fill(2) };
  const parts = containerParts(value);
  const bytes = await bytesOf(streamOf(parts));
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), 'R3DCACHE');
  const length = new DataView(bytes.buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
  assert.deepEqual(header.arrays, [{ type: 'Uint8Array', length: 3 }, { type: 'Float64Array', length: 1 }, { type: 'Float32Array', length: 300_000 }]);
  assert.deepEqual(header.value, { a: { $r3d: { t: 0 } }, b: { $r3d: { t: 1 } }, c: { $r3d: { t: 2 } } });
  const start = 12 + length + ((8 - ((12 + length) % 8)) % 8);
  assert.equal(start % 8, 0);
  assert.deepEqual([...bytes.subarray(start, start + 3)], [1, 2, 3]);
  assert.equal(new DataView(bytes.buffer).getFloat64(start + 8, true), 1.5);
  assert.equal(bytes.length, start + 8 + 8 + 1_200_000);
  // Slices of 1 MiB at most, views of the arrays (not copies).
  const chunks = [];
  const reader = streamOf(parts).getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  assert.ok(chunks.every((c) => c.length <= 2 ** 20));
  assert.ok(chunks.some((c) => c.buffer === value.c.buffer));
  // gzip: much smaller for a repeated value, the same bytes back.
  const zipped = await bytesOf(gzip(streamOf(parts)));
  assert.deepEqual([zipped[0], zipped[1]], [0x1f, 0x8b]);
  assert.ok(zipped.length < bytes.length / 20);
  assert.deepEqual(await bytesOf(gunzip(new Blob([zipped]).stream())), bytes);
});

test('the container: a file cut short, followed by other bytes, of another format or version, or damaged is refused', async () => {
  const value = { positions: new Float32Array([1, 2, 3]) };
  const bytes = await bytesOf(streamOf(containerParts(value)));
  const read = (b) => readContainer(new Blob([b]).stream());
  await assert.rejects(read(bytes.subarray(0, bytes.length - 2)), /incomplet/);
  await assert.rejects(read(new Uint8Array([...bytes, 0])), /données en trop/);
  await assert.rejects(read(new TextEncoder().encode('{"schema": "autre"}')), /pas un fichier de résultats/);
  const other = await bytesOf(streamOf(containerParts(value, { version: 99 })));
  await assert.rejects(read(other), /autre format \(reader3d-resultats version 99\)/);
  const damaged = bytes.slice();
  damaged[20] ^= 0xff; // in the header
  await assert.rejects(read(damaged));
  await assert.rejects(readContainer(gunzip(new Blob([new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3])]).stream())));
  // What JSON and the arrays cannot hold is refused when written (the results are then kept on this PC only).
  assert.throws(() => packValue({ m: new Map() }), /objet non enregistrable \(Map\)/);
  assert.throws(() => packValue({ f: () => 1 }), /valeur non enregistrable/);
  const cycle = { a: {} };
  cycle.a.b = cycle;
  assert.throws(() => packValue(cycle), /circulaire/);
  assert.throws(() => packValue({ d: new DataView(new ArrayBuffer(2)) }), /tableau non enregistrable \(DataView\)/);
  // A reference to an array that is not there, an unknown marker.
  assert.throws(() => unpackValue({ a: { $r3d: { t: 3 } } }, []), /référence inconnue/);
  // A key "__proto__" of a file stays a key.
  const back = unpackValue(JSON.parse('{"__proto__": {"x": 1}}'), []);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.deepEqual(Object.keys(back), ['__proto__']);
});

test('the names of the files: the SHA-256 of the file and a short hash of the options and of the cache version; the thickness by the meshes it is of', async () => {
  const bytes = new TextEncoder().encode('ISO-10303-21;');
  const key = await cacheKey(bytes, { ext: '.step', quality: 'normal' });
  const k = parseKey(key);
  assert.deepEqual([k.cache, k.options], [2, 'ext=.step&quality=normal']);
  assert.match(k.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parseKey('no key'), null);
  assert.equal(await sharedNames(null), null);
  const names = await sharedNames(key);
  assert.match(names.data, new RegExp(`^${k.sha256}__[0-9a-f]{8}\\.r3d\\.gz$`));
  assert.equal((await sharedNames(key)).data, names.data, 'the same key, the same name');
  const fine = await sharedNames(await cacheKey(bytes, { ext: '.step', quality: 'fine' }));
  assert.notEqual(fine.data, names.data, 'other options, another name');
  assert.equal(fine.data.slice(0, 64), names.data.slice(0, 64));
  const older = await sharedNames(key.replace(/^2\|/, '1|'));
  assert.notEqual(older.data, names.data, 'another cache version, another name');

  const body = (positions, indices) => ({ mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) } });
  const bodies = [body([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]), body([0, 0, 1, 1, 0, 1, 0, 1, 1], [0, 1, 2])];
  const meshes = await meshHash(bodies);
  assert.match(meshes, /^[0-9a-f]{16}$/);
  assert.equal(await meshHash(structuredClone(bodies)), meshes, 'the same meshes, the same hash');
  assert.notEqual(await meshHash([bodies[0], body([0, 0, 2, 1, 0, 1, 0, 1, 1], [0, 1, 2])]), meshes, 'a vertex moved');
  assert.notEqual(await meshHash([bodies[1], bodies[0]]), meshes, 'the bodies in another order');
  assert.equal(names.thickness(meshes), `${names.data.replace(/\.r3d\.gz$/, '')}__epaisseur-${meshes}.r3d.gz`);
});

test('what is read is checked: an analysis has bodies with their meshes; a thickness, a value per triangle of each body', () => {
  const data = { summary: {}, bodies: [{ mesh: { positions: new Float32Array(9), indices: new Uint32Array(6) } }, { mesh: { positions: new Float32Array(9), indices: new Uint32Array(3) } }] };
  assert.equal(validData(data), true);
  assert.equal(validData({ ...data, bodies: [] }), false);
  assert.equal(validData({ bodies: data.bodies }), false);
  assert.equal(validData({ summary: {}, bodies: [{ mesh: { positions: [0, 0, 0], indices: new Uint32Array(3) } }] }), false);
  assert.equal(validData({ summary: {}, bodies: [{ mesh: { positions: new Float32Array(8), indices: new Uint32Array(3) } }] }), false);
  const values = (n) => ({ ray: new Float32Array(n), sphere: new Float32Array(n), wall: new Float32Array(n) });
  assert.equal(validThickness([values(2), null], data), true);
  assert.equal(validThickness([values(2)], data), false, 'a body missing');
  assert.equal(validThickness([values(1), null], data), false, 'of other meshes');
  assert.equal(validThickness([{ ...values(2), wall: new Float64Array(2) }, null], data), false);
});
