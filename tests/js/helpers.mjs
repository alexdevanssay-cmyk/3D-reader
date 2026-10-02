// Shared helpers for the browser-engine tests (run with `node --test tests/js/`).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(ROOT, 'tests', 'fixtures', 'generated');

/** Python engine results for every fixture (written by tests/make_fixtures.py). */
export function loadExpected() {
  const file = join(FIXTURES, 'expected.json');
  if (!existsSync(file)) {
    throw new Error('Missing fixtures: run `.venv/bin/python tests/make_fixtures.py` first');
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const fixturePath = (name) => join(FIXTURES, name);

/** Fixture content as a Uint8Array that owns its own ArrayBuffer. */
export function fixtureBytes(name) {
  const buf = readFileSync(fixturePath(name));
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Assert |actual - expected| <= max(rel * |expected|, abs). */
export function approx(actual, expected, rel, abs = 0, message = '') {
  if (expected === null || expected === undefined) {
    assert.equal(actual ?? null, null, `${message}: expected null, got ${actual}`);
    return;
  }
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${actual}`);
  const tol = Math.max(rel * Math.abs(expected), abs);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message}: ${actual} != ${expected} (diff ${Math.abs(actual - expected)}, tol ${tol})`,
  );
}

/** Element-wise approx for vectors. */
export function approxVec(actual, expected, rel, abs = 0, message = '') {
  if (expected === null || expected === undefined) {
    assert.equal(actual ?? null, null, `${message}: expected null`);
    return;
  }
  assert.equal(actual.length, expected.length, `${message}: length`);
  expected.forEach((e, i) => approx(actual[i], e, rel, abs, `${message}[${i}]`));
}
