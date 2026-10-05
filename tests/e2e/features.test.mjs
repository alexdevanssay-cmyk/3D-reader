// End-to-end tests of the user-facing features of the built site (dist/):
// French interface, analysis progress, memory gauge, Excel export, and the
// link-driven mode for AI assistants (?url=…&report=1, window.reader3d).
//
//   npm run build && node --test tests/e2e/features.test.mjs

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from '../../node_modules/three/examples/jsm/libs/fflate.module.js';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath, loadExpected } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const SAMPLE_DIR = join(DIST, 'e2e-samples'); // same origin as the page: no CORS needed
const CAD_TIMEOUT = 180_000;

describe('site features (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  const expected = loadExpected();
  let server;
  let base;
  let browser;

  before(async () => {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    for (const name of ['named_assembly.step', 'box.stl']) copyFileSync(fixturePath(name), join(SAMPLE_DIR, name));
    server = createStaticServer(DIST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    rmSync(SAMPLE_DIR, { recursive: true, force: true });
  });

  async function newPage(locale = 'en-US') {
    const context = await browser.newContext({ locale, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { page, errors };
  }

  test('French interface, progress in percent, memory gauge', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    assert.equal(await page.textContent('#open-file'), 'Ouvrir un fichier…');
    // Record every percentage the page shows while analysing.
    await page.evaluate(() => {
      window.__percents = new Set();
      new MutationObserver(() => window.__percents.add(document.getElementById('loading-percent').textContent))
        .observe(document.getElementById('loading-percent'), { childList: true, characterData: true, subtree: true });
    });
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const percents = await page.evaluate(() => [...window.__percents].filter(Boolean));
    assert.ok(percents.length >= 3, `progress shown: ${percents}`);
    assert.ok(percents.every((p) => /^\d{1,3} %$/.test(p)), String(percents));
    assert.match(await page.textContent('#method'), /Volume exact/);
    assert.match(await page.textContent('#total-volume'), /^7,257 cm³$/);
    assert.equal(await page.isVisible('#memory-gauge'), true);
    assert.match(await page.textContent('#memory-percent'), /^\d{1,3} %$/);
    assert.match(await page.textContent('#memory-stats'), /Moteur CAO/);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('Excel export: one value per cell, numbers as numbers', { timeout: CAD_TIMEOUT }, async () => {
    const { page } = await newPage('fr-FR');
    await page.goto(base);
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-xlsx')]);
    assert.equal(download.suggestedFilename(), 'named_assembly_volume.xlsx');
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    assert.ok(files['xl/workbook.xml'] && files['xl/styles.xml'] && files['[Content_Types].xml']);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    const rows = [...sheet.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)];
    assert.equal(rows.length, 1 + 2 + 1, 'header, two bodies, total');
    assert.match(rows[0][2], /Nom/);
    assert.match(rows[1][2], /Équerre/);
    // Column B of the total row: the volume, as a number cell.
    const total = rows[3][2].match(/<c r="B4"[^>]*><v>([^<]+)<\/v><\/c>/);
    assert.ok(total, rows[3][2]);
    approx(Number(total[1]), expected['named_assembly.step'].summary.volume, 1e-9, 0, 'total volume');
    assert.match(sheet, /<autoFilter ref="A1:M4"\/>/);
    await page.context().close();
  });

  test('link for AI assistants: ?url=…&report=1, JSON and window.reader3d', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage();
    await page.goto(`${base}?url=e2e-samples/named_assembly.step&report=1&lang=en`);
    await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status), null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.evaluate(() => document.body.dataset.status), 'done');
    const report = await page.textContent('#reader3d-report');
    assert.match(report, /^file: named_assembly\.step$/m);
    assert.match(report, /^volume: 7256\.63706\d* mm3$/m);
    const json = JSON.parse(await page.textContent('#reader3d-result'));
    approx(json.summary.volume, expected['named_assembly.step'].summary.volume, 1e-9, 0, 'JSON volume');
    assert.deepEqual(json.bodies.map((b) => b.name), ['Équerre', 'Pin']);
    assert.equal(json.bodies[0].mesh, undefined, 'no display meshes in the JSON');

    const viaApi = await page.evaluate(async () => (await window.reader3d.analyze('e2e-samples/box.stl')).summary.volume);
    approx(viaApi, expected['box.stl'].summary.volume, 1e-9, 0, 'reader3d.analyze');

    await page.goto(`${base}?url=e2e-samples/missing.step`);
    await page.waitForFunction(() => document.body.dataset.status === 'error', null, { timeout: 30_000 });
    assert.match(await page.evaluate(() => document.body.dataset.error), /missing\.step/);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
