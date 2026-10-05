// End-to-end test of the costing pages of the built site (dist/): import of
// the costing workbook and of a prices file, the three best routes, choice of
// an island in the drop-down lists, settings kept after a reload, Excel export.
// With a made-up workbook (tests/js/costing-fixture.mjs).
//
//   npm run build && node --test tests/e2e/costing.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from '../../node_modules/three/examples/jsm/libs/fflate.module.js';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT } from '../js/helpers.mjs';
import { costingWorkbook, indicesWorkbook } from '../js/costing-fixture.mjs';

const DIST = join(ROOT, 'dist');

describe('costing pages (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;
  let dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'costing-'));
    writeFileSync(join(dir, 'chiffrage.xlsm'), costingWorkbook());
    writeFileSync(join(dir, 'VALEURS MB LME.xlsx'), indicesWorkbook(100));
    server = createStaticServer(DIST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  test('import, best routes, choice of an island, settings kept, export', { timeout: 120_000 }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);

    // The costing tab asks for the workbook first.
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ccard');
    assert.match(await page.textContent('#page-chiffrage'), /Importez d'abord le classeur de chiffrage/);
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    assert.match(await page.textContent('#page-chiffrage .cmsg.ok'), /18 centres de profit/);
    // The defaults come from the workbook (no 3D model: the part is typed in).
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.coursAchat"]'), '2500');
    assert.match(await page.textContent('#page-chiffrage'), /Ouvrez un modèle 3D/);

    const typeIn = async (bind, value) => {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    };
    for (const [bind, value] of [['q.poids', 1.2], ['q.toileMini', 5], ['q.epaisseurMax', 10], ['q.moduleMm', 3], ['q.dimMax', 250]]) await typeIn(bind, value);
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');
    const islands = await page.$$eval('#page-chiffrage .ctable tbody tr td:nth-child(2) strong', (els) => els.map((e) => e.textContent));
    assert.equal(islands.length, 3);
    assert.equal(new Set(islands).size, 3);
    assert.match(await page.textContent('#page-chiffrage'), /PRI complet/);

    // Island and cycle time chosen in the drop-down lists.
    await page.selectOption('#page-chiffrage [data-bind="q.procede"]', 'CG3');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.cycle"]'));
    await page.selectOption('#page-chiffrage [data-bind="q.cycle"]', '300');
    await page.waitForFunction(() => /Détail du chiffrage — CG3 Coquille gravité \(traditionnel\)/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /300 s × 1 — TRS 75 %/);

    // A prices file replaces the indices of the workbook.
    await page.setInputFiles('#page-chiffrage input[data-file="indices"]', join(dir, 'VALEURS MB LME.xlsx'));
    await page.waitForFunction(() => /Indices « VALEURS MB LME\.xlsx » importés/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /fichier des cours/);

    // Settings: TRS changed, kept after a reload, and used by the quote.
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-bind="s.trs.CG3"]');
    await page.fill('#page-parametres [data-bind="s.trs.CG3"]', '60');
    await page.dispatchEvent('#page-parametres [data-bind="s.trs.CG3"]', 'change');
    await page.reload();
    await page.waitForSelector('#page-parametres [data-bind="s.trs.CG3"]');
    assert.equal(await page.inputValue('#page-parametres [data-bind="s.trs.CG3"]'), '60');
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ctable');
    assert.match(await page.textContent('#page-chiffrage'), /300 s × 1 — TRS 60 %/);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.poids"]'), '1.2', 'inputs kept too');

    // Excel export of the quote.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const workbook = strFromU8(files['xl/workbook.xml']);
    for (const name of ['Devis', 'Gamme', 'Projection', 'Solutions']) assert.match(workbook, new RegExp(`name="${name}"`));
    assert.match(strFromU8(files['xl/worksheets/sheet2.xml']), /CG3/);

    assert.deepEqual(errors, []);
    await context.close();
  });
});
