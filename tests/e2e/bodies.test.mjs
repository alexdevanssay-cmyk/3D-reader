// End-to-end test of the bodies checked when a file has several (dist/): the
// largest one alone is checked and shown at first, the others unchecked and
// hidden, and the bodies card says so; « all » checks every body again, and
// each tab keeps its own choice. A file of one body as before; a file opened
// again from the results kept in this browser, the same default. Every body
// for the link modes that publish the results (report=1, export=…) and with
// ?bodies=all; ?bodies=largest the default in those modes too.
//
//   npm run build && node --test tests/e2e/bodies.test.mjs

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath, loadExpected } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const SAMPLE_DIR = join(DIST, 'e2e-bodies'); // same origin as the page: no CORS needed
const CAD_TIMEOUT = 180_000;
const NOTE = '2 bodies in the file: only the largest one is checked; check the others to include them.';

/** The rows of the bodies list: [name, checked]. */
const rows = (page) => page.$$eval('#bodies tr[data-index]', (trs) => trs.map((tr) => [tr.querySelector('.name').textContent, tr.querySelector('input').checked]));

/** The note of the bodies card ('' when hidden). */
const note = (page) => page.evaluate(() => (document.getElementById('bodies-note').hidden ? '' : document.getElementById('bodies-note').textContent));

/** The « all » box: [checked, indeterminate]. */
const allBox = (page) => page.evaluate(() => [document.getElementById('bodies-all').checked, document.getElementById('bodies-all').indeterminate]);

/** The status the page settled on, once analysed. */
const settled = async (page) => {
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status), null, { timeout: CAD_TIMEOUT });
  assert.equal(await page.evaluate(() => document.body.dataset.error ?? 'done'), 'done');
};

/** A file opened through the file input of the tab shown, analysed. */
async function open(page, file) {
  await page.evaluate(() => (document.body.dataset.status = ''));
  await page.setInputFiles('#file-input', file);
  await settled(page);
}

/**
 * The body a click on this point of the model (mm) selects, seen from the
 * front: its index, -1 when the click meets no body (a hidden one is not
 * met). Unselected again after.
 */
async function bodyAt(page, point) {
  await page.click('[data-view="front"]');
  const at = await page.evaluate((p) => window.reader3d.screenOf(p), point);
  await page.mouse.click(at.x, at.y);
  const selected = await page.$$eval('#bodies tr.selected', (trs) => trs.map((tr) => Number(tr.dataset.index)));
  if (selected.length) await page.click(`#bodies tr[data-index="${selected[0]}"] td.name`);
  return selected.length ? selected[0] : -1;
}

/** The results of the analysis of a file written in this browser (in the background): its next opening reads them. */
async function kept(page, file) {
  for (const end = Date.now() + 30_000; ; await page.waitForTimeout(100)) {
    const files = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('reader3d-cache');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const store = db.transaction('meta', 'readonly').objectStore('meta');
      const metas = await new Promise((resolve) => (store.getAll().onsuccess = (e) => resolve(e.target.result)));
      db.close();
      return metas.map((m) => m.file);
    });
    if (files.includes(file)) return;
    assert.ok(Date.now() < end, `results of ${file} not kept`);
  }
}

/** An OBJ of cubes, a body each (a material each): [[material, [x, y, z] of a corner, side]]. */
function cubesObj(cubes) {
  const lines = [];
  const faces = [];
  for (const [material, [x0, y0, z0], side] of cubes) {
    const first = lines.length + 1;
    for (let i = 0; i < 8; i++) lines.push(`v ${i & 1 ? x0 + side : x0} ${i & 2 ? y0 + side : y0} ${i & 4 ? z0 + side : z0}`);
    faces.push(`usemtl ${material}`);
    // Counter-clockwise seen from outside.
    for (const q of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) faces.push(`f ${q.map((k) => first + k).join(' ')}`);
  }
  return { name: 'cubes.obj', mimeType: 'text/plain', buffer: Buffer.from([...lines, ...faces, ''].join('\n')) };
}

describe('bodies checked by default (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  const expected = loadExpected();
  let server;
  let base;
  let browser;

  before(async () => {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    copyFileSync(fixturePath('named_assembly.step'), join(SAMPLE_DIR, 'named_assembly.step'));
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

  async function newPage() {
    const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  }

  test('several bodies: the largest one alone checked and shown, said in the card; « all », the tabs, a file of one body, the file opened again', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(base);
    // The bracket (6000 mm³) and the pin (1257 mm³) standing on it.
    await open(page, fixturePath('named_assembly.step'));
    const reference = expected['named_assembly.step'];
    const [bracket, pin] = reference.bodies;
    assert.deepEqual([bracket.name, pin.name], ['Équerre', 'Pin']);
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', false]]);
    assert.deepEqual(await allBox(page), [false, true]);
    assert.equal(await note(page), NOTE);
    // The volume, the summary, the published result and the part costed: the bracket's.
    await page.selectOption('#vol-unit', 'mm3');
    assert.equal(await page.textContent('#total-volume'), '6,000 mm³');
    assert.equal(await page.textContent('#body-count'), '1 (selected, of 2)');
    const result = await page.evaluate(() => window.reader3d.result);
    assert.deepEqual(result.bodies.map((b) => b.name), ['Équerre']);
    approx(result.summary.volume, bracket.volume, 1e-9, 0, 'volume of the largest body');
    assert.deepEqual((await page.evaluate(() => window.reader3d.part())).selected, [0]);
    // On the 3D view: the bracket shown, the pin hidden (a click on it meets nothing).
    assert.equal(await bodyAt(page, [5, 15, 2.5]), 0);
    assert.equal(await bodyAt(page, [20, 15, 20]), -1);

    // A file of one body in another tab: checked, nothing said.
    await page.click('.doc-tab-new');
    await open(page, fixturePath('box.stl'));
    assert.deepEqual((await rows(page)).map(([, checked]) => checked), [true]);
    assert.deepEqual(await allBox(page), [true, false]);
    assert.equal(await note(page), '');
    // Back to the first tab: its own choice, the note with it.
    await page.click('.doc-tab:first-child');
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', false]]);
    assert.equal(await note(page), NOTE);

    // « all »: every body checked and shown, the note gone; kept by the tab.
    await page.check('#bodies-all');
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', true]]);
    assert.equal(await note(page), '');
    assert.equal(await page.textContent('#total-volume'), '7,256.637 mm³');
    assert.equal(await page.textContent('#body-count'), '2');
    approx((await page.evaluate(() => window.reader3d.result)).summary.volume, reference.summary.volume, 1e-9, 0, 'volume of every body');
    assert.equal(await bodyAt(page, [20, 15, 20]), 1);
    await page.click('.doc-tab:nth-child(2)');
    await page.click('.doc-tab:first-child');
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', true]]);
    assert.equal(await note(page), '');
    // The selection changed by hand: not said again, the largest body alone checked again or not.
    await page.uncheck('#bodies tr[data-index="1"] input');
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', false]]);
    assert.equal(await note(page), '');

    // Opened again after a reload, from the results kept in this browser: the largest one alone again.
    await kept(page, 'named_assembly.step');
    await page.reload();
    await open(page, fixturePath('named_assembly.step'));
    assert.match(await page.textContent('#method'), /Results kept from an earlier opening/);
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', false]]);
    assert.equal(await note(page), NOTE);
    assert.deepEqual((await page.evaluate(() => window.reader3d.result)).bodies.map((b) => b.name), ['Équerre']);
    assert.equal(await bodyAt(page, [20, 15, 20]), -1);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the largest body is the largest volume, wherever it is in the file', { timeout: CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(base);
    // Three cubes of 10, 30 and 20 mm: the largest in the middle, whichever way the groups are read.
    await open(page, cubesObj([['small', [0, 0, 0], 10], ['large', [20, 0, 0], 30], ['medium', [60, 0, 0], 20]]));
    const parts = await page.evaluate(() => window.reader3d.part().parts.map((p) => [p.name, Math.round(p.volume)]));
    assert.equal(parts.length, 3);
    const largest = parts.findIndex(([, v]) => v === 27000);
    assert.equal(largest, 1, JSON.stringify(parts));
    assert.deepEqual((await rows(page)).map(([, checked]) => checked), [false, true, false]);
    assert.equal(await note(page), '3 bodies in the file: only the largest one is checked; check the others to include them.');
    approx((await page.evaluate(() => window.reader3d.result)).summary.volume, 27000, 1e-9, 0, 'volume of the largest cube');
    await page.check('#bodies-all');
    approx((await page.evaluate(() => window.reader3d.result)).summary.volume, 1000 + 27000 + 8000, 1e-9, 0, 'volume of the three cubes');
    assert.equal(await note(page), '');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('every body with ?bodies=all, and in the link modes that publish the results (report, export) unless ?bodies=largest', { timeout: 3 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    const names = async () => (await page.evaluate(() => window.reader3d.result)).bodies.map((b) => b.name);

    // Opened by hand with ?bodies=all: every body checked, nothing said.
    await page.goto(`${base}?bodies=all`);
    await open(page, fixturePath('named_assembly.step'));
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', true]]);
    assert.equal(await note(page), '');

    // The report for a script: every body, in the report, the JSON and window.reader3d.
    await page.goto(`${base}?url=e2e-bodies/named_assembly.step&report=1`);
    await settled(page);
    assert.match(await page.textContent('#reader3d-report'), /^bodies: 2 \(0 open\)$/m);
    assert.deepEqual(JSON.parse(await page.textContent('#reader3d-result')).bodies.map((b) => b.name), ['Équerre', 'Pin']);
    assert.deepEqual(await names(), ['Équerre', 'Pin']);
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', true]]);
    assert.equal(await note(page), '');

    // The same with bodies=largest: the largest one alone.
    await page.goto(`${base}?url=e2e-bodies/named_assembly.step&report=1&bodies=largest`);
    await settled(page);
    assert.match(await page.textContent('#reader3d-report'), /^bodies: 1 \(0 open\)$/m);
    assert.deepEqual(await names(), ['Équerre']);
    assert.equal(await note(page), NOTE);

    // The export downloaded once analysed: every body.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: CAD_TIMEOUT }),
      page.goto(`${base}?url=e2e-bodies/named_assembly.step&export=json`),
    ]);
    assert.equal(download.suggestedFilename(), 'named_assembly_volume.json');
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.deepEqual(exported.bodies.map((b) => b.name), ['Équerre', 'Pin']);
    approx(exported.summary.volume, expected['named_assembly.step'].summary.volume, 1e-9, 0, 'volume exported');
    assert.deepEqual(await rows(page), [['Équerre', true], ['Pin', true]]);

    // A link only showing the file (no report, no export): the largest one alone, as when opened by hand.
    await page.goto(`${base}?url=e2e-bodies/named_assembly.step`);
    await settled(page);
    assert.deepEqual(await names(), ['Équerre']);
    assert.equal(await note(page), NOTE);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
