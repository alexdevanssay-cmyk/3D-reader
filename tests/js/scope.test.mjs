// The bodies an analysis covers (web/engine/scope.js): those checked in the
// list of the 3D page; the card's body among them; what is missing for them;
// the results of each body merged as they come; no figure when none is
// checked. The semantic contract and the AI context say which bodies.
//
//   node --test tests/js/scope.test.mjs

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cardBody, emptySummary, mergeBodies, missingBodies, scopeInfo, scopeOf } from '../../web/engine/scope.js';
import { buildSemantic3D } from '../../web/engine/semantic.js';
import { buildAIContext } from '../../web/engine/ai-context.js';

// Three bodies: A large and closed, B smaller and closed, C an open sheet (no volume).
const BODIES = [
  { name: 'A', closed: true, volume: 48000 },
  { name: 'B', closed: true, volume: 14400 },
  { name: 'C', closed: false, volume: null },
];

describe('the bodies analysed', () => {
  test('scopeOf: the bodies checked, in the order of the file; all, some or none', () => {
    assert.deepEqual(scopeOf(3, new Set([2, 0])), { indices: [0, 2], count: 2, total: 3, all: false, none: false });
    assert.deepEqual(scopeOf(3, new Set([0, 1, 2])), { indices: [0, 1, 2], count: 3, total: 3, all: true, none: false });
    assert.deepEqual(scopeOf(3, new Set()), { indices: [], count: 0, total: 3, all: false, none: true });
    // An index beyond the file (a model of fewer bodies): left out.
    assert.deepEqual(scopeOf(2, new Set([1, 5])).indices, [1]);
  });

  test('scopeInfo: what the results say of the bodies they cover, without their names', () => {
    assert.deepEqual(scopeInfo(BODIES, [0]), { mode: 'checked', bodies: 1, bodies_in_file: 3, indices: [0] });
    assert.deepEqual(scopeInfo(BODIES, [0, 1, 2]), { mode: 'all', bodies: 3, bodies_in_file: 3, indices: [0, 1, 2] });
    assert.deepEqual(scopeInfo(BODIES, []), { mode: 'none', bodies: 0, bodies_in_file: 3, indices: [] });
    const indices = [1];
    const info = scopeInfo(BODIES, indices);
    indices.push(2);
    assert.deepEqual(info.indices, [1], 'a copy of the indices');
  });

  test('cardBody: the body selected when it is checked, else the largest closed body checked, never one left out', () => {
    // Nothing selected: the largest closed body checked.
    assert.equal(cardBody(BODIES, [0, 1, 2]), 0);
    assert.equal(cardBody(BODIES, [1, 2]), 1);
    // Selected and checked: that one, open or not.
    assert.equal(cardBody(BODIES, [0, 1], 1), 1);
    assert.equal(cardBody(BODIES, [0, 2], 2), 2);
    // Selected but unchecked: the card moves to the largest closed body checked.
    assert.equal(cardBody(BODIES, [1], 0), 1);
    assert.equal(cardBody(BODIES, [0, 2], 1), 0);
    // No closed body checked, or none at all: none.
    assert.equal(cardBody(BODIES, [2]), -1);
    assert.equal(cardBody(BODIES, [], 0), -1);
    // A selection out of the file: as none.
    assert.equal(cardBody(BODIES, [1], 7), 1);
  });

  test('missingBodies: the closed bodies checked without a result, nor being computed', () => {
    assert.deepEqual(missingBodies(BODIES, [0, 1, 2], null), [0, 1]);
    assert.deepEqual(missingBodies(BODIES, [0, 1, 2], [{ v: 1 }, null, null]), [1]);
    assert.deepEqual(missingBodies(BODIES, [1], [{ v: 1 }, null, null], new Set([1])), []);
    assert.deepEqual(missingBodies(BODIES, [1], [{ v: 1 }, null, null], new Map([[1, {}]])), []);
    // A body not checked is never missing; an open one has nothing to compute.
    assert.deepEqual(missingBodies(BODIES, [0], [null, null, null]), [0]);
    assert.deepEqual(missingBodies(BODIES, [2], [null, null, null]), []);
    assert.deepEqual(missingBodies(BODIES, [], null), []);
  });

  test('mergeBodies: each body its newest result, the others kept (a body checked again is not computed again)', () => {
    const a = { body: 'A' }, b = { body: 'B' }, b2 = { body: 'B again' };
    assert.deepEqual(mergeBodies(null, [a, null, null], 3), [a, null, null]);
    assert.deepEqual(mergeBodies([a, null, null], [null, b, null], 3), [a, b, null]);
    const merged = mergeBodies([a, b, null], [null, b2, null], 3);
    assert.deepEqual(merged, [a, b2, null]);
    assert.equal(merged[0], a, 'the same object: what is keyed by it stays');
    // As many as the bodies of the file, whatever the arrays given.
    assert.equal(mergeBodies([a], null, 3).length, 3);
  });

  test('emptySummary: no figure of any body', () => {
    const s = emptySummary();
    assert.equal(s.bodies, 0);
    for (const v of [s.volume, s.area, s.centroid, s.obb, s.fill_ratio, s.bbox.volume, ...s.bbox.size]) assert.equal(v, null);
    assert.notEqual(emptySummary(), s, 'a new one each time');
  });

  test('the semantic contract and the AI context say which bodies of the file they cover', () => {
    const body = { name: 'A', closed: true, volume: 1000, area: 600, bbox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] }, centroid: [5, 5, 5], notes: [] };
    const result = { file: 'three.stl', kind: 'mesh', bodies: [body], summary: { volume: 1000, area: 600, bodies: 1, bbox: body.bbox }, scope: scopeInfo(BODIES, [0]) };
    const semantic = buildSemantic3D(result);
    assert.deepEqual(semantic.model.scope, { mode: 'checked', bodies: 1, bodies_in_file: 3, indices: [0] });
    assert.equal(semantic.model.body_count, 1);
    assert.deepEqual(buildAIContext(semantic).model.scope, semantic.model.scope);
    // Every body of the file: said by the contract; the AI context, as small as before, says nothing.
    const whole = buildSemantic3D({ ...result, scope: scopeInfo([body], [0]) });
    assert.equal(whole.model.scope.mode, 'all');
    assert.equal('scope' in buildAIContext(whole).model, false);
    // A result that does not say it (a script's own): no scope, as before.
    const { scope, ...plain } = result;
    assert.equal('scope' in buildSemantic3D(plain).model, false);
    assert.equal('scope' in buildAIContext(buildSemantic3D(plain)).model, false);
  });
});
