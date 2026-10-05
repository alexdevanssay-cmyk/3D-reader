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
import { ROOT, fixturePath } from '../js/helpers.mjs';
import { costingWorkbook, indicesWorkbook, seriesOrderWorkbook } from '../js/costing-fixture.mjs';

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
    writeFileSync(join(dir, 'RFQ.xlsm'), seriesOrderWorkbook());
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
    for (const [bind, value] of [['p.poids', 1.2], ['p.toileMini', 5], ['p.epaisseurMax', 10], ['p.moduleMm', 3], ['p.dimMax', 250]]) await typeIn(bind, value);
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');
    const islands = await page.$$eval('#page-chiffrage .ctable tbody tr td:nth-child(2) strong', (els) => els.map((e) => e.textContent));
    assert.equal(islands.length, 3);
    assert.equal(new Set(islands).size, 3);
    assert.match(await page.textContent('#page-chiffrage'), /PRI complet/);

    // Island and cycle time chosen in the drop-down lists.
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="p.cycle"]'));
    await page.selectOption('#page-chiffrage [data-bind="p.cycle"]', '300');
    await page.waitForFunction(() => /Détail du chiffrage — Pièce : CG3 Coquille gravité \(traditionnel\)/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /300 s × 1 — TRS 75 %/);

    // The in-house steel die, estimated from the part.
    assert.match(await page.textContent('#page-chiffrage'), /Outillage — coquille acier réalisée sur place/);
    assert.match(await page.textContent('#page-chiffrage'), /Fraisage CNC — ébauche des empreintes/);
    assert.match(await page.textContent('#page-chiffrage'), /Montage, ajustage et assemblage du moule/);
    // Heat treatment chosen in the list: a T5 costs less than a T6.
    const pri = async () => Number((/PRI complet[^\d]*([\d\s\u202f]+,\d+)/.exec((await page.textContent('#page-chiffrage')).replace(/\u202f/g, ' ')) ?? [])[1]?.replace(/\s/g, '').replace(',', '.'));
    const noTth = await pri();
    await page.selectOption('#page-chiffrage [data-bind="p.tth"]', 'T6');
    await page.waitForSelector('#page-chiffrage [data-bind="p.tthMode"]');
    const t6 = await pri();
    await page.selectOption('#page-chiffrage [data-bind="p.tth"]', 'T5');
    await page.waitForFunction(() => /6 h à 200 °C/.test(document.getElementById('page-chiffrage').textContent));
    const t5 = await pri();
    assert.ok(t6 > t5 && t5 > noTth, `T6 ${t6}, T5 ${t5}, none ${noTth}`);

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
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.poids"]'), '1.2', 'inputs kept too');

    // The series order of the customer request: volumes per year, MOQ, target price.
    await page.setInputFiles('#page-chiffrage input[data-file="rfq"]', join(dir, 'RFQ.xlsm'));
    await page.waitForFunction(() => /Commande série « RFQ\.xlsm » importée : 4 ans à partir de 2027, 4 800 pièces, MOQ 2000 \/ 500 \/ 50, prix cible 30,00 €/.test(document.getElementById('page-chiffrage').textContent.replace(/\u202f/g, ' ')));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), 'ACME RAIL');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.reference"]'), 'AB-123');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.1"]'), '1500');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.tailleSerie"]'), '1500');
    const moqRows = await page.$$eval('#page-chiffrage .ctable tbody tr', (trs) => trs.map((tr) => tr.textContent).filter((t) => /MOQ \d/.test(t)));
    assert.equal(moqRows.length, 3, moqRows.join('\n'));
    const price = (t) => Number(/(\d[\d\s\u202f]*,\d\d) €(?=[^€]*%)/.exec(t)[1].replace(/[\s\u202f]/g, '').replace(',', '.'));
    assert.ok(price(moqRows[2]) > price(moqRows[0]), moqRows.join('\n'));
    assert.match(await page.textContent('#page-chiffrage'), /Écart au prix cible/);

    // Excel export of the quote.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const workbook = strFromU8(files['xl/workbook.xml']);
    for (const name of ['Synthèse', 'Gammes', 'Projection', 'Outillage', 'Commande série', 'Solutions']) assert.match(workbook, new RegExp(`name="${name}"`));
    const synthese = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert.match(synthese, /CG3 — Coquille gravité \(traditionnel\)/);
    assert.match(synthese, /Mise au mille/);
    assert.match(strFromU8(files['xl/worksheets/sheet2.xml']), /CG3/);

    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a 3D model of several pieces: quote of the set or of one piece', { timeout: 240_000 }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: 180_000 });
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ccard');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage [data-bind="q.piece"]');
    // Wall thickness of each piece (bracket 5 mm, pin 8 mm across).
    await page.click('#page-chiffrage [data-action="thickness"]');
    await page.waitForFunction(() => /5,00 mm/.test(document.getElementById('page-chiffrage').textContent), null, { timeout: 60_000 });

    // The set: one row per piece and the total.
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.piece"]'), 'tout');
    const rows = await page.$$eval('#page-chiffrage .ctable tbody tr', (trs) => trs.map((tr) => tr.textContent));
    assert.ok(rows.some((t) => /Équerre/.test(t) && /5,00 mm/.test(t)), rows.join('\n'));
    assert.ok(rows.some((t) => /Pin/.test(t) && /8,00 mm/.test(t)), rows.join('\n'));
    assert.ok(rows.some((t) => /Ensemble \(2 pièces chiffrées\)/.test(t)), rows.join('\n'));
    assert.match(await page.textContent('#page-chiffrage'), /Prix de l'ensemble/);

    // One piece: its casting parameters and its estimated mise au mille; the 3D page follows.
    const volumeAll = await page.textContent('#total-volume');
    const pin = await page.$eval('#page-chiffrage [data-bind="q.piece"]', (s) => [...s.options].find((o) => o.textContent === 'Pin').value);
    await page.selectOption('#page-chiffrage [data-bind="q.piece"]', pin);
    await page.waitForSelector('#page-chiffrage [data-bind="p.procede"]');
    assert.match(await page.textContent('#page-chiffrage'), /Paramètres de coulée — Pin/);
    assert.match(await page.textContent('#page-chiffrage'), /Estimation de la mise au mille : \d,\d\d \(rendement \d+ %\)/);
    const checks = () => page.$$eval('#bodies tr', (trs) => trs.map((tr) => [tr.querySelector('.name').textContent, tr.querySelector('input').checked]));
    assert.deepEqual(await checks(), [['Équerre', false], ['Pin', true]]);
    const volumePin = await page.textContent('#total-volume');
    assert.notEqual(volumePin, volumeAll);

    // The other way: the bodies checked on the 3D page are the pieces costed.
    await page.click('.tab[data-page="viewer"]');
    await page.click('#bodies-all');
    await page.waitForFunction((v) => document.getElementById('total-volume').textContent === v, volumeAll);
    await page.locator('#bodies tr', { hasText: 'Pin' }).locator('input').uncheck();
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForFunction(() => /Paramètres de coulée — Équerre/.test(document.getElementById('page-chiffrage').textContent));
    await page.click('.tab[data-page="viewer"]');
    await page.locator('#bodies tr', { hasText: 'Équerre' }).locator('input').uncheck();
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForFunction(() => /Aucune pièce sélectionnée/.test(document.getElementById('page-chiffrage').textContent));

    // Export of the set: a synthesis with both pieces.
    await page.selectOption('#page-chiffrage [data-bind="q.piece"]', 'tout');
    await page.waitForSelector('#page-chiffrage [data-action="piece"]');
    assert.deepEqual(await checks(), [['Équerre', true], ['Pin', true]]);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const synthese = strFromU8(files['xl/worksheets/sheet1.xml']);
    for (const text of ['Équerre', 'Pin', 'TOTAL ensemble', 'named_assembly.step']) assert.ok(synthese.includes(text), text);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
