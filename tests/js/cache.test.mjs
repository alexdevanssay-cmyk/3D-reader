// Results kept in the browser (web/engine/cache.js): their keys.
//
//   node --test tests/js/cache.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheKey } from '../../web/engine/cache.js';

test('the key holds the engine version: results kept by an older engine are not served', async () => {
  const bytes = new TextEncoder().encode('ISO-10303-21;');
  const key = await cacheKey(bytes, { ext: '.step', quality: 'normal' });
  // Version 1 kept CAD bodies without their analytic surfaces.
  assert.match(key, /^2\|[0-9a-f]{64}\|ext=\.step&quality=normal$/);
  assert.equal(await cacheKey(bytes.slice(), { ext: '.step', quality: 'normal' }), key, 'same content, same key');
  assert.notEqual(await cacheKey(bytes, { ext: '.step', quality: 'fine' }), key, 'other options, other key');
});
