// End-to-end test of the costing pages of the built site (dist/): import of
// the costing workbook and of a prices file, the three best routes, choice of
// an island in the drop-down lists, settings kept after a reload, trends file
// below the values typed in, traced values, Excel export.
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
    // A calibrated settings file (made-up values), with a misspelled key.
    writeFileSync(join(dir, 'tendances.json'), JSON.stringify({ trs: { CG3: 0.7, SSP: 0.5 }, procceses: { CG3: { qualite: 9 } } }));
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

    // Traceability: the banner at the top, the card of the traced values (folded until asked for).
    assert.match(await page.textContent('#page-chiffrage .ctrace-banner'), /Traçabilité : \d+ valeurs? à valider \/ \d+ alertes?/);
    assert.equal(await page.isVisible('#page-chiffrage #ctrace table'), false);
    await page.click('#page-chiffrage [data-action="show-trace"]');
    await page.waitForSelector('#page-chiffrage #ctrace details[open] table');
    const traced = await page.textContent('#page-chiffrage #ctrace');
    for (const key of ['devis.alliage', 'devis.densite', 'devis.marge', 'devis.metal.coursVente', 'devis.metal.prixAchat', 'piece.poids', 'piece.miseAuMille', 'piece.kgCast', 'piece.cycle', 'piece.empreintes', 'piece.outillage.total', 'piece.prix.vente']) {
      assert.ok(traced.includes(key), key);
    }
    assert.match(await page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.poids' }).textContent(), /1,200 kg\s*saisie du devis\s*hard \(N1\)\s*haute/);
    assert.match(traced, /défaut du code : valeur par défaut du code/);

    // Island and cycle time chosen in the drop-down lists.
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="p.cycle"]'));
    await page.selectOption('#page-chiffrage [data-bind="p.cycle"]', '300');
    await page.waitForFunction(() => /Détail du chiffrage — Pièce : CG3 Coquille gravité \(traditionnel\)/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /300 s × 1 — TRS 75 %/);

    // The in-house steel die, estimated from the part.
    assert.match(await page.textContent('#page-chiffrage'), /Outillage — coquille acier réalisée sur place/);
    assert.match(await page.textContent('#page-chiffrage'), /Usinage 3 axes/);
    assert.match(await page.textContent('#page-chiffrage'), /Méthode du classeur « Outillage fonderie »/);
    assert.match(await page.textContent('#page-chiffrage'), /Ajustage \/ montage/);
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

    // Sand cores: the cores of the piece and their core boxes (added to the tooling).
    await page.check('#page-chiffrage [data-bind="p.noyaux"]');
    await page.waitForSelector('#page-chiffrage [data-bind="p.cores.0.masse"]');
    await typeIn('p.cores.0.masse', 0.5);
    await page.waitForFunction(() => /Boîtes à noyau/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /Noyau 1 — boîte \d+ kg \(dimensions estimées\)/);
    assert.match(await page.textContent('#page-chiffrage'), /moule [\d\s\u202f]+ € \+ boîtes à noyau [\d\s\u202f]+ €/);
    await page.uncheck('#page-chiffrage [data-bind="p.noyaux"]');
    await page.waitForFunction(() => !/Boîtes à noyau/.test(document.getElementById('page-chiffrage').textContent));

    // The tooling: amortised in the piece price, or sold apart.
    const salePrice = async () => Number((/Prix de vente complet[^\d]*([\d\s\u202f]+,\d+)/.exec((await page.textContent('#page-chiffrage')).replace(/\u202f/g, ' ')) ?? [])[1]?.replace(/\s/g, '').replace(',', '.'));
    assert.match(await page.textContent('#page-chiffrage'), /Outillage amorti \(/);
    assert.match(await page.textContent('#page-chiffrage'), /Prix de vente complet[\d\s\u202f,€]+\(outillage compris\)/);
    const withTooling = await salePrice();
    await page.uncheck('#page-chiffrage [data-bind="q.outillageInclus"]');
    await page.waitForFunction(() => /Outillage chiffré à part : [\d\s\u202f]+ € HT/.test(document.getElementById('page-chiffrage').textContent));
    const withoutTooling = await salePrice();
    assert.ok(withoutTooling < withTooling, `${withoutTooling} < ${withTooling}`);
    await page.check('#page-chiffrage [data-bind="q.outillageInclus"]');
    await page.waitForFunction(() => /\(outillage compris\)/.test(document.getElementById('page-chiffrage').textContent));

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

    // Trends (calibrated settings file): their own layer, below the values typed in and the workbook.
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-bind="s.trs.CG3"]');
    await page.setInputFiles('#page-parametres input[data-file="tendances"]', join(dir, 'tendances.json'));
    await page.waitForFunction(() => /Tendances « tendances\.json » importées : 2 valeurs/.test(document.getElementById('page-parametres').textContent));
    assert.match(await page.textContent('#page-parametres .cmsg.warn'), /procceses \(vouliez-vous dire « processes » \?\)/);
    const settingsCell = (bind) => page.locator(`#page-parametres td:has(> .cval [data-bind="${bind}"])`);
    assert.equal(await page.inputValue('#page-parametres [data-bind="s.trs.CG3"]'), '60', 'the value typed in stays');
    assert.match(await settingsCell('s.trs.CG3').textContent(), /^S\s*tendance 70 %, écart [-−]14,3 %\s*Adopter la tendance$/);
    // In the quote, the TRS traced: typed in Paramètres (hard), the trend and the deviation beside it.
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage #ctrace');
    assert.match(await page.locator('#page-chiffrage #ctrace tr', { hasText: 'centre.CG3.trs' }).textContent(), /60,0 %\s*saisie Paramètres[\s\S]*hard \(N2\)\s*haute[\s\S]*[-−]14,3 %\s*tendance 70,0 %\s*non/);
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-bind="s.trs.CG3"]');
    assert.equal(await page.inputValue('#page-parametres [data-bind="s.trs.SSP"]'), '50', 'nothing typed in: the trend');
    assert.equal(await settingsCell('s.trs.SSP').locator('.csrc').textContent(), 'T');
    assert.equal(await page.textContent('#page-parametres label:has([data-bind="s.marge"]) .csrc'), 'classeur');
    assert.equal(await page.textContent('#page-parametres label:has([data-bind="s.densities.AS7G03"]) .csrc'), 'défaut');
    // An emptied field is no longer a value typed in: the trend comes back (not 0).
    await page.fill('#page-parametres [data-bind="s.trs.CG3"]', '');
    await page.dispatchEvent('#page-parametres [data-bind="s.trs.CG3"]', 'change');
    await page.waitForFunction(() => document.querySelector('#page-parametres [data-bind="s.trs.CG3"]')?.value === '70');
    assert.equal(await settingsCell('s.trs.CG3').locator('.csrc').textContent(), 'T');
    // Typed in again, then "Adopter la tendance".
    await page.fill('#page-parametres [data-bind="s.trs.CG3"]', '65');
    await page.dispatchEvent('#page-parametres [data-bind="s.trs.CG3"]', 'change');
    await page.waitForSelector('#page-parametres [data-action="adopt-trend"][data-path="trs.CG3"]');
    await page.click('#page-parametres [data-action="adopt-trend"][data-path="trs.CG3"]');
    await page.waitForFunction(() => document.querySelector('#page-parametres [data-bind="s.trs.CG3"]')?.value === '70');
    assert.equal(await page.locator('#page-parametres [data-action="adopt-trend"]').count(), 0);
    // "Paramètres par défaut": erasing the trends says what is kept; the default of the code comes back.
    const dialog = new Promise((resolve) => page.once('dialog', (d) => resolve(d.message()) || d.accept()));
    await page.click('#page-parametres [data-action="clear-tendances"]');
    assert.match(await dialog, /Effacer les tendances importées \(« tendances\.json », 2 valeurs\)[\s\S]*Sont conservés : vos saisies de Paramètres et le classeur/);
    await page.waitForFunction(() => /Tendances « tendances\.json » effacées/.test(document.getElementById('page-parametres').textContent));
    assert.equal(await page.inputValue('#page-parametres [data-bind="s.trs.CG3"]'), '75');
    assert.equal(await settingsCell('s.trs.CG3').locator('.csrc').textContent(), 'D');
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ctable');
    assert.match(await page.textContent('#page-chiffrage'), /300 s × 1 — TRS 75 %/);

    // The series order of the customer request: volumes per year, MOQ, target price.
    // Dropped on its row of the "Données" card (drag and drop replaces the file in use).
    const rfq = readFileSync(join(dir, 'RFQ.xlsm')).toString('base64');
    await page.evaluate((b64) => {
      const zone = document.querySelector('#page-chiffrage [data-drop="rfq"]');
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'RFQ.xlsm'));
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      if (!zone.classList.contains('drop-target')) throw new Error('the row is not highlighted');
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, rfq);
    await page.waitForFunction(() => /Commande série « RFQ\.xlsm » importée : 4 ans à partir de 2027, 4 800 pièces, MOQ 2000 \/ 500 \/ 50, prix cible 30,00 €/.test(document.getElementById('page-chiffrage').textContent.replace(/\u202f/g, ' ')));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), 'ACME RAIL');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.reference"]'), 'AB-123');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.1"]'), '1500');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.tailleSerie"]'), '1500');
    // The metal of the request's foundry quote, as the defaults of the "Matière" card.
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.alliage"]'), 'AS9U3');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.month"]'), '2026-03');
    for (const [bind, value] of [['coursAchat', '2800'], ['p1020Achat', '400'], ['premiumAchat', '330'], ['premiumVente', '640'], ['pafAchat', '5'], ['pafVente', '7']]) {
      assert.equal(await page.inputValue(`#page-chiffrage [data-bind="q.${bind}"]`), value, bind);
    }
    assert.match(await page.textContent('#page-chiffrage'), /2[\s\u202f]810,00\s*valeur de la demande client/);
    // Prototype: the prototype volumes of the request, without target price.
    assert.equal(await page.isChecked('#page-chiffrage [data-bind="q.prototype"]'), false);
    await page.check('#page-chiffrage [data-bind="q.prototype"]');
    await page.waitForFunction(() => /Prototypes/.test(document.getElementById('page-chiffrage').textContent));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.0"]'), '20');
    assert.match(await page.textContent('#page-chiffrage'), /non utilisé pour des prototypes/);
    await page.uncheck('#page-chiffrage [data-bind="q.prototype"]');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.volumes.1"]')?.value === '1500');
    const moqRows = await page.$$eval('#page-chiffrage .ctable tbody tr', (trs) => trs.map((tr) => tr.textContent).filter((t) => /MOQ \d/.test(t)));
    assert.equal(moqRows.length, 3, moqRows.join('\n'));
    const price = (t) => Number(/(\d[\d\s\u202f]*,\d\d) €(?=[^€]*%)/.exec(t)[1].replace(/[\s\u202f]/g, '').replace(',', '.'));
    assert.ok(price(moqRows[2]) > price(moqRows[0]), moqRows.join('\n'));
    assert.match(await page.textContent('#page-chiffrage'), /Écart au prix cible/);

    // Excel export of the quote.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const workbook = strFromU8(files['xl/workbook.xml']);
    for (const name of ['Synthèse', 'Gammes', 'Projection', 'Outillage', 'Commande série', 'Solutions', 'Traçabilité']) assert.match(workbook, new RegExp(`name="${name}"`));
    const synthese = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert.match(synthese, /CG3 — Coquille gravité \(traditionnel\)/);
    assert.match(synthese, /Mise au mille/);
    assert.match(synthese, /non validé : \d+ valeurs à valider/);
    assert.match(strFromU8(files['xl/worksheets/sheet2.xml']), /CG3/);
    // The sheet "Traçabilité": the data files and their dates, then one row per traced value.
    const tracabilite = strFromU8(files['xl/worksheets/sheet7.xml']);
    for (const text of ['Classeur de chiffrage', 'chiffrage.xlsm', 'Indices matière', 'VALEURS MB LME.xlsx', 'Tendances (paramètres calés)', 'Demande client (RFQ)', 'RFQ.xlsm', 'Statut', 'non validé']) {
      assert.ok(tracabilite.includes(text), text);
    }
    for (const column of ['Clé', 'Valeur', 'Source', 'Autorité', 'Confiance', 'Écart à la tendance', 'Hypothèses', 'Alertes', 'Validation requise']) assert.ok(tracabilite.includes(`<t xml:space="preserve">${column}</t>`), column);
    for (const key of ['devis.metal.coursVente', 'devis.tailleSerie', 'centre.CG3.trs', 'piece.cycle', 'piece.prix.vente']) assert.ok(tracabilite.includes(`>${key}<`), key);
    assert.match(tracabilite, /RFQ\.xlsm<\/t><\/is><\/c><c r="C\d+"[^>]*><is><t xml:space="preserve">\d\d\/\d\d\/\d{4}/, 'the date of the customer request');

    // A new tab of the 3D page: its own quote, without the series order; the workbook and the indices are shared.
    await page.click('.doc-tab-new');
    await page.waitForFunction(() => /Commande série :\s*aucune/.test(document.getElementById('page-chiffrage').textContent));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), '');
    assert.match(await page.textContent('#page-chiffrage'), /Classeur de chiffrage :\s*[^\n]*\.xlsm — importé le/);
    assert.match(await page.textContent('#page-chiffrage'), /Indices matière :\s*VALEURS MB LME\.xlsx/);
    await page.click('.doc-tab:first-child');
    await page.waitForFunction(() => /Commande série :\s*RFQ\.xlsm/.test(document.getElementById('page-chiffrage').textContent));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), 'ACME RAIL');
    // Closing the second tab forgets its quote; the first one keeps its own.
    await page.click('.doc-tab:nth-child(2) .doc-tab-close');
    assert.equal(await page.locator('.doc-tab').count(), 1);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), 'ACME RAIL');

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
    // In the rows of the pieces (the card of the traced values has other sizes in mm, such as 45,00 mm).
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#page-chiffrage .ctable tbody tr')].map((tr) => tr.textContent);
      return rows.some((t) => /Équerre/.test(t) && /5,00 mm/.test(t)) && rows.some((t) => /Pin/.test(t) && /8,00 mm/.test(t));
    }, null, { timeout: 60_000 });

    // The set: one row per piece and the total.
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.piece"]'), 'tout');
    const rows = await page.$$eval('#page-chiffrage .ctable tbody tr', (trs) => trs.map((tr) => tr.textContent));
    assert.ok(rows.some((t) => /Équerre/.test(t) && /5,00 mm/.test(t)), rows.join('\n'));
    assert.ok(rows.some((t) => /Pin/.test(t) && /8,00 mm/.test(t)), rows.join('\n'));
    assert.ok(rows.some((t) => /Ensemble \(2 pièces chiffrées\)/.test(t)), rows.join('\n'));
    assert.match(await page.textContent('#page-chiffrage'), /Prix de l'ensemble/);
    // The traced values of the set: the quote, each piece, the price of the set.
    const traced = await page.textContent('#page-chiffrage #ctrace');
    for (const text of ['Pièce : Équerre', 'Pièce : Pin', 'ensemble.prix.vente', 'piece.volume3d', 'géométrie 3D']) assert.ok(traced.includes(text), text);

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
