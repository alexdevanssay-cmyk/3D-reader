// End-to-end test of the wall thickness on all the cores (dist/): the page is
// cross-origin isolated (headers of the server, or the service worker
// coi-sw.js where the server cannot send them, like GitHub Pages), the
// workers then share one copy of the model; without isolation they get their
// own copies. Both give the same thickness.
//
//   npm run build && node --test tests/e2e/cores.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, fixturePath } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const TIMEOUT = 180_000;

describe('wall thickness on all the cores (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  const servers = [];
  let browser;
  const serve = async (isolate) => {
    const server = createStaticServer(DIST, { isolate });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/`;
  };

  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const s of servers) await new Promise((resolve) => s.close(resolve));
  });

  /** Thickness of the torus (one smooth NURBS body) in a page, and how it was computed. */
  async function thickness(url, contextOptions = {}) {
    const context = await browser.newContext({ locale: 'fr-FR', ...contextOptions });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}?lang=fr`);
    // Without the headers, the service worker reloads the page once.
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.waitForTimeout(500);
    await page.waitForLoadState('load');
    const isolated = await page.evaluate(() => window.crossOriginIsolated);
    await page.setInputFiles('#file-input', fixturePath('nurbs_torus.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    const texts = [];
    const watch = setInterval(() => page.textContent('#loading-text').then((t) => texts.push(t), () => {}), 100);
    const result = await page.evaluate(async () => {
      const r = await window.reader3d.computeThickness();
      return r.thickness;
    });
    clearInterval(watch);
    assert.deepEqual(errors, []);
    await context.close();
    return { isolated, result, texts };
  }

  test('isolated by the server: shared model, calculations in parallel, same result as with copies', { timeout: TIMEOUT }, async () => {
    const shared = await thickness(await serve(true));
    assert.equal(shared.isolated, true);
    assert.ok(shared.texts.some((t) => /calculs en parallèle/.test(t)), shared.texts.join(' | '));
    // No isolation and no service worker: each worker with its copy of the model.
    const copies = await thickness(await serve(false), { serviceWorkers: 'block' });
    assert.equal(copies.isolated, false);
    assert.deepEqual(copies.result, shared.result);
  });

  test('isolated by the service worker where the server cannot send the headers (GitHub Pages)', { timeout: TIMEOUT }, async () => {
    const url = await serve(false);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    // First visit: the service worker is installed and the page reloaded once.
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30_000 });
    // Next visits: isolated at once, no reload.
    await page.reload();
    assert.equal(await page.evaluate(() => window.crossOriginIsolated), true);
    await context.close();
  });
});
