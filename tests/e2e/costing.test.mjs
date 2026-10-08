// End-to-end test of the costing pages of the built site (dist/): import of
// the costing workbook and of a prices file, the three best routes, choice of
// an island in the drop-down lists, settings kept after a reload, trends file
// below the values typed in, traced values, Excel export; the traced values
// read by the AI page (task "Chiffrage"), read only, and its answers kept
// with the quote (sheet "Analyses IA" of the export); the cycle time estimated
// by the AI, used in the quote once adopted, and undone; the backtest of the
// AI on the history of cycle times, against a stand-in gateway.
// With a made-up workbook (tests/js/costing-fixture.mjs).
//
//   npm run build && node --test tests/e2e/costing.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
    // The weights, the mise au mille and the scrap rate of the request: compared with the costing, not applied.
    const compared = await page.textContent('#page-chiffrage .cdemande');
    for (const text of ['Poids brut vendu', 'Poids vendu par pièce', 'Mise au mille', 'Taux de rebuts usinage']) assert.ok(compared.includes(text), text);
    const scrapRow = page.locator('#page-chiffrage .cdemande tr', { hasText: 'Taux de rebuts usinage' });
    assert.match(await scrapRow.textContent(), /Taux de rebuts usinage\s*3,00 %\s*2,00 %\s*[-−]33,3 % \(tolérance 10 %\)/);
    assert.equal(await scrapRow.getAttribute('class'), 'calert');
    assert.match(await page.textContent('#page-chiffrage'), /ne sont pas appliquées automatiquement \(les appliquer est une décision à prendre\)/);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.poids"]'), '1.2');
    assert.match(await page.textContent('#page-chiffrage #ctrace'), /écart à la demande client : Taux de rebuts usinage de la demande client 3 %/);
    // The alloy of the request and its density, on the 3D page too; and at each change of the alloy.
    const material = () => page.$eval('#material', (s) => s.selectedOptions[0].textContent);
    assert.equal(await material(), 'AS9U3 (2,76)');
    await page.selectOption('#page-chiffrage [data-bind="q.alliage"]', 'AS7G03');
    await page.waitForFunction(() => document.querySelector('#material').selectedOptions[0].textContent === 'AS7G03 (2,68)');
    await page.selectOption('#page-chiffrage [data-bind="q.alliage"]', 'AS9U3');
    await page.waitForFunction(() => document.querySelector('#material').selectedOptions[0].textContent === 'AS9U3 (2,76)');
    // Prototype: the prototype volumes of the request, without target price.
    assert.equal(await page.isChecked('#page-chiffrage [data-bind="q.prototype"]'), false);
    await page.check('#page-chiffrage [data-bind="q.prototype"]');
    await page.waitForFunction(() => /Prototypes/.test(document.getElementById('page-chiffrage').textContent));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.0"]'), '20');
    assert.match(await page.textContent('#page-chiffrage'), /non utilisé pour des prototypes/);
    await page.uncheck('#page-chiffrage [data-bind="q.prototype"]');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.volumes.1"]')?.value === '1500');
    // A volume typed in: the prototype box keeps it (only the volumes of the request change).
    const series = () => page.waitForFunction(() => ![...document.querySelectorAll('#page-chiffrage h3')].some((h) => h.textContent.startsWith('Prototypes')));
    await typeIn('q.volumes.1', 1600);
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.volumes.1"]')?.value === '1600');
    await page.check('#page-chiffrage [data-bind="q.prototype"]');
    await page.waitForFunction(() => /Volumes saisis conservés : les volumes proto de la demande client/.test(document.getElementById('page-chiffrage').textContent));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.1"]'), '1600');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.volumes.0"]'), '1000');
    await page.uncheck('#page-chiffrage [data-bind="q.prototype"]');
    await series();
    await typeIn('q.volumes.1', 1500);
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

    // "Retirer" the request: the fields it filled are said, kept until the values of before the import are put back.
    await page.click('#page-chiffrage [data-action="remove-rfq"]');
    await page.waitForFunction(() => /Commande série :\s*aucune/.test(document.getElementById('page-chiffrage').textContent));
    assert.match(await page.textContent('#page-chiffrage'), /Demande client « RFQ\.xlsm » retirée\. Ces champs gardent les valeurs qu'elle avait remplies : client, référence, désignation, n° de plan, [^.]*alliage/);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.client"]'), 'ACME RAIL');
    await page.click('#page-chiffrage [data-action="restore-before-rfq"]');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.client"]')?.value === '');
    assert.match(await page.textContent('#page-chiffrage'), /Valeurs d'avant l'import de « RFQ\.xlsm » remises/);
    assert.doesNotMatch(await page.textContent('#page-chiffrage'), /gardent les valeurs/);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.alliage"]'), 'AS7G03');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="q.coursAchat"]'), '2500');
    assert.equal(await material(), 'AS7G03 (2,68)');

    assert.deepEqual(errors, []);
    await context.close();
  });

  test('history of cycle times: import, a real time kept from the quote, compared with the formula, export, erase', { timeout: 120_000 }, async () => {
    // A history file (made-up values): a record refused, a field unknown.
    const record = (over) => ({
      ref: 'H-1', fichier_3d: 'h1.stp', source: 'devis', ilot: 'CG3', temps_cycle_s: 180, pieces_par_cycle: 1, trs: 0.8, poids_kg: 1.5, module_mm: 3.5,
      volume_cm3: 560, surface_cm2: 1600, encombrement_mm: [150, 90, 40], noyaux: false, sable_kg: null, serie: 800, mise_au_mille: 1.7, ...over,
    });
    writeFileSync(join(dir, 'historique.json'), JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, description: 'test', pieces: [
      record({ atelier: 'B' }), record({ ref: 'H-2', fichier_3d: null, ilot: 'SSP', temps_cycle_s: 40, pieces_par_cycle: 4, module_mm: null, volume_cm3: null, surface_cm2: null, encombrement_mm: null }),
      record({ ref: 'H-3', temps_cycle_s: 0 }),
    ] }));
    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    await page.click('.tab[data-page="chiffrage"]');
    const text = (selector = '#page-chiffrage') => page.textContent(selector).then((t) => t.replace(/[  ]/g, ' '));
    const waitText = (re) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById('page-chiffrage').textContent.replace(/[  ]/g, ' ')), re.source);

    // Before the workbook already: the card of the history.
    await page.waitForSelector('#page-chiffrage #chistorique');
    assert.match(await text('#chistorique'), /Historique :\s*aucun/);
    assert.equal(await page.isDisabled('#chistorique [data-action="export-historique"]'), true);
    await page.setInputFiles('#page-chiffrage input[data-file="historique"]', join(dir, 'historique.json'));
    await waitText(/Historique « historique\.json » importé/);
    assert.match(await text('#page-chiffrage .cmsg.warn'), /^Historique « historique\.json » importé : 2 enregistrements \(2 ajoutés, 0 remplacé : même référence et même source\)\. Enregistrements refusés : H-3 \(temps_cycle_s : nombre > 0 attendu\)\. Champs inconnus, ignorés : atelier\.$/);
    assert.match(await text('#chistorique'), /Historique :\s*2 enregistrements : 2 temps de devis, 0 temps mesuré en production/);
    assert.deepEqual(await page.$$eval('#chistorique .chisto-count tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent))), [
      ['CG3 Coquille gravité (traditionnel)', '1', '0'], ['SSP Sous pression', '1', '0'],
    ]);
    assert.match(await text('#chistorique'), /Aucun temps mesuré en production/);
    // Dropped again on its row: its records replaced, not added twice.
    const json = readFileSync(join(dir, 'historique.json'), 'utf8');
    await page.evaluate((content) => {
      const zone = document.querySelector('#page-chiffrage [data-drop="historique"]');
      const data = new DataTransfer();
      data.items.add(new File([content], 'historique.json', { type: 'application/json' }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, json);
    await waitText(/0 ajouté, 2 remplacés/);
    assert.match(await text('#chistorique'), /Historique :\s*2 enregistrements/);

    // A part typed in, cast on CG3.
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    const typeIn = async (bind, value) => {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    };
    for (const [bind, value] of [['p.poids', 1.2], ['p.toileMini', 5], ['p.epaisseurMax', 10], ['p.moduleMm', 3], ['p.dimMax', 250]]) await typeIn(bind, value);
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await waitText(/Retour d'expérience — Pièce\s*Îlot retenu : CG3/);
    const estimated = Number(/cycle du chiffrage (\d+) s × 1 \(estimé\)/.exec(await text('#cfeedback'))[1]);
    // No reference nor 3D file: nothing to keep the time under.
    assert.equal(await page.isDisabled('#cfeedback [data-action="save-feedback"]'), true);
    assert.match(await text('#cfeedback'), /saisissez la référence \(carte Pièce\)/);
    await typeIn('q.reference', 'REF-RETOUR');
    await page.waitForFunction(() => /saisissez le temps mesuré/.test(document.getElementById('cfeedback').textContent));
    const pri = async () => /PRI complet(?: \(outillage compris\))?(\d[\d\s]*,\d+) €/.exec(await text())[1];
    const priBefore = await pri();
    await typeIn('p.cycleReel', 250);
    await page.waitForSelector('#cfeedback [data-action="save-feedback"]:not([disabled])');
    await page.click('#cfeedback [data-action="save-feedback"]');
    await waitText(/Temps de cycle réel enregistré dans le retour d'expérience : « REF-RETOUR », 250 s sur CG3\. Le chiffrage ne change pas\./);
    assert.equal(await pri(), priBefore, 'the costing does not change');
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.cycleReel"]'), '');
    assert.match(await text('#cfeedback'), /Déjà enregistré pour « REF-RETOUR » : 250 s sur CG3 le \d\d\/\d\d\/\d{4}/);
    assert.match(await text('#chistorique'), /Historique :\s*3 enregistrements : 2 temps de devis, 1 temps mesuré en production/);

    // The real time against the formula of the settings: the cycle of the quote, the same values.
    const row = async () => page.$$eval('#chistorique .chisto tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.replace(/[  ]/g, ' '))));
    const number = (s) => Number(s.replace(/[^\d,+−-]/g, '').replace(',', '.').replace('−', '-'));
    let [cells] = await row();
    assert.equal((await row()).length, 1, 'the times measured in production only');
    assert.match(cells[0], /^REF-RETOUR \d\d\/\d\d\/\d{4}/);
    assert.deepEqual(cells.slice(1, 3), ['CG3', '250 s']);
    const formula = number(cells[3]);
    assert.ok(Math.abs(formula - estimated) <= 0.5, `${formula} vs ${estimated}`);
    assert.match(cells[4], new RegExp(`^${(formula - 250) / 250 > 0 ? '\\+' : '[-−]'}\\d+,\\d %$`));
    assert.deepEqual(await page.$$eval('#chistorique .chisto-ilots thead th', (ths) => ths.map((th) => th.textContent)), ['Îlot', 'Pièces mesurées', 'Écart moyen : formule']);
    const summary = await page.$$eval('#chistorique .chisto-ilots tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.replace(/[  ]/g, ' '))));
    assert.deepEqual(summary, [['CG3', '1', cells[4].replace(/^[+−-]/, '')]]);

    // A cycle coefficient typed in Paramètres: the formula recomputed with it; the trends file adds its column.
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-bind="s.processes.CG3.cycle.base"]');
    const cycleBase = Number(await page.inputValue('#page-parametres [data-bind="s.processes.CG3.cycle.base"]'));
    await page.fill('#page-parametres [data-bind="s.processes.CG3.cycle.base"]', String(cycleBase + 100));
    await page.dispatchEvent('#page-parametres [data-bind="s.processes.CG3.cycle.base"]', 'change');
    await page.waitForFunction(() => document.querySelector('#page-parametres .cval:has([data-bind="s.processes.CG3.cycle.base"]) .csrc')?.textContent === 'S');
    writeFileSync(join(dir, 'tendances-cycle.json'), JSON.stringify({ processes: { CG3: { cycle: { base: cycleBase - 50 } } } }));
    await page.setInputFiles('#page-parametres input[data-file="tendances"]', join(dir, 'tendances-cycle.json'));
    await page.waitForFunction(() => /Tendances « tendances-cycle\.json » importées/.test(document.getElementById('page-parametres').textContent));
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#chistorique .chisto');
    [cells] = await row();
    assert.ok(Math.abs(number(cells[3]) - (formula + 100)) <= 0.1, `${cells[3]} vs ${formula + 100}`);
    assert.ok(Math.abs(number(cells[5]) - (formula - 50)) <= 0.1, `trend ${cells[5]} vs ${formula - 50}`);
    assert.deepEqual(await page.$$eval('#chistorique .chisto thead th', (ths) => ths.map((th) => th.textContent)), ['Référence', 'Îlot', 'Réel', 'Formule', 'Écart', 'Tendance', 'Écart']);

    // Kept after a reload; exported as a history file, the time measured with the geometry of the part.
    await page.reload();
    await page.waitForSelector('#page-chiffrage #chistorique');
    assert.match(await text('#chistorique'), /Historique :\s*3 enregistrements/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#chistorique [data-action="export-historique"]')]);
    assert.equal(download.suggestedFilename(), 'historique_cycles.json');
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.deepEqual([exported.schema, exported.version, exported.pieces.length], ['reader3d-historique-cycles', 1, 3]);
    const measured = exported.pieces.find((r) => r.source === 'production');
    const { date, mise_au_mille: mam, ...rest } = measured;
    assert.deepEqual(rest, {
      ref: 'REF-RETOUR', fichier_3d: null, source: 'production', ilot: 'CG3', temps_cycle_s: 250, pieces_par_cycle: 1, trs: 0.75, poids_kg: 1.2, module_mm: 3,
      volume_cm3: null, surface_cm2: null, encombrement_mm: null, noyaux: false, sable_kg: null, serie: 1000, toile_mini_mm: 5, epaisseur_max_mm: 10,
    });
    assert.ok(mam > 1 && !Number.isNaN(Date.parse(date)));
    assert.deepEqual(exported.pieces.filter((r) => r.source === 'devis').map((r) => r.ref), ['H-1', 'H-2']);

    // A phone: the cards of the history within 375 px (their tables scroll inside them).
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#chistorique, #cfeedback')].flatMap((card) => [card, ...card.querySelectorAll('button, input, .cscroll')])
      .filter((x) => x.offsetParent).map((x) => [x.id || x.textContent.trim().slice(0, 30) || x.className, Math.round(x.getBoundingClientRect().right)]).filter(([, right]) => right > 375));
    assert.deepEqual(overflow, []);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Erased, after a confirmation that says what is lost.
    const dialog = new Promise((resolve) => page.once('dialog', (d) => resolve(d.message()) || d.accept()));
    await page.click('#chistorique [data-action="clear-historique"]');
    assert.match(await dialog, /Effacer l'historique des temps de cycle \(3 enregistrements, dont 1 temps mesuré en production\)[\s\S]*exportez-le d'abord/);
    await waitText(/Historique des temps de cycle effacé/);
    assert.match(await text('#chistorique'), /Historique :\s*aucun/);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.chiffrage.historique.v1')), null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('IA page, task « Chiffrage »: the traced values sent read only, the numbers of the answer checked, the amounts masked for the gateway, the answers kept with the quote', { timeout: 120_000 }, async (t) => {
    // Stand-ins for Ollama (/api/tags, a streamed /api/chat) and for the AI gateway, CORS as they do it.
    const chats = [];
    const gatewayRequests = [];
    let answer = () => '';
    const cors = (req, res) => {
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      if (req.method !== 'OPTIONS') return false;
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
      res.end();
      return true;
    };
    const body = (req) => new Promise((resolve) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => resolve(JSON.parse(text)));
    });
    const traceOf = (system) => JSON.parse(system.slice(system.indexOf('CONTEXTE :\n') + 'CONTEXTE :\n'.length)).costing_trace;
    const ollama = createServer(async (req, res) => {
      if (cors(req, res)) return;
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
      }
      const request = await body(req);
      chats.push(request);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: answer(traceOf(request.messages[0].content)) }, done: false })}\n`);
      res.end(`${JSON.stringify({ done: true })}\n`);
    });
    const gateway = createServer(async (req, res) => {
      if (cors(req, res)) return;
      res.setHeader('Content-Type', 'application/json');
      // Its configuration: the context budget the page compacts to.
      if (req.method === 'GET') return res.end(JSON.stringify({ provider: 'Groq', model: 'openai/gpt-oss-120b', models: [], context_chars: 6000, access_code_required: false }));
      const request = await body(req);
      gatewayRequests.push(request);
      res.end(JSON.stringify({ output: JSON.stringify({
        conclusion: 'Prix à valider.', observations: [], inferences: [], recommendations: [], uncertainties: [], needs_human_validation: true,
        analyse_chiffrage: { explications: [answer(request.context.costing_trace)], ecarts_signales: [{ cle: 'devis.densite', commentaire: 'défaut du code' }], questions: [], hypotheses: [] },
      }), provider: 'Groq', model: 'openai/gpt-oss-120b', quota: { requests_remaining_day: 997, requests_limit_day: 1000 } }));
    });
    await Promise.all([ollama, gateway].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
    // Closed even when an assertion fails: a server left open would keep the test process running.
    t.after(() => Promise.all([ollama, gateway].map((s) => new Promise((resolve) => {
      s.closeAllConnections();
      s.close(resolve);
    }))));
    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // A quote of a part typed in, in the Chiffrage page.
    await page.goto(`${base}?lang=fr`);
    await page.click('.tab[data-page="chiffrage"]');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    for (const [bind, value] of [['p.poids', 1.2], ['p.toileMini', 5], ['p.epaisseurMax', 10], ['p.moduleMm', 3], ['p.dimMax', 250]]) {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    }
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');

    // The AI page alone, in a new visit: the costing page is not opened, the quote is read from this browser's storage.
    await page.goto(`${base}?lang=fr&page=ia`);
    // What the costing keeps in this browser, but the answers of the AI kept with the quote (a record, see below).
    const costingStorage = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([k]) => k.startsWith('reader3d.chiffrage')).sort().map(([k, v]) => {
      if (k !== 'reader3d.chiffrage.quote.v1') return [k, v];
      const { analysesIA, ...quote } = JSON.parse(v);
      return [k, JSON.stringify(quote)];
    })));
    const analyses = () => page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.chiffrage.quote.v1')).analysesIA);
    const stored = await costingStorage();
    await page.selectOption('#ai-provider', 'ollama');
    await page.fill('#ai-url', `http://127.0.0.1:${ollama.address().port}`);
    await page.click('.ai-task[data-task="costing"]');
    assert.equal(await page.isVisible('#ai-amounts-field'), false, 'the local model gets the whole trace');
    const fr = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    const ask = async (question) => {
      const n = await page.locator('#ai-chat .ai-check').count();
      await page.fill('#ai-input', question);
      await page.press('#ai-input', 'Enter');
      await page.waitForFunction((count) => document.querySelectorAll('#ai-chat .ai-check').length > count, n, { timeout: 30_000 });
      return page.locator('#ai-chat .ai-msg').last();
    };
    // The stand-in cites the sale price of the trace it was given.
    answer = (trace) => `Le prix de vente (piece.prix.vente) est de ${typeof trace.pieces[0].valeurs['piece.prix.vente'].valeur === 'number' ? `${fr(trace.pieces[0].valeurs['piece.prix.vente'].valeur)} €` : 'masqué'}.`;
    let reply = await ask('Pourquoi ce prix ?');
    const system = chats[0].messages[0].content;
    assert.doesNotMatch(system, /costing_contract|costing_inputs|"quote"/);
    assert.match(system, /N'invente jamais de prix, de taux, de temps de cycle ni de nombre de noyaux\. Ne cite que des nombres présents dans costing_trace/);
    const trace = traceOf(system);
    assert.equal(trace.lecture_seule, true);
    assert.equal(trace.fichiers.classeur.nom, 'chiffrage.xlsm');
    assert.deepEqual(trace.pieces.map((p) => [p.nom, p.chiffree]), [['Pièce', true]]);
    const price = trace.pieces[0].valeurs['piece.prix.vente'];
    assert.ok(price.valeur > 0 && price.autorite === 'calcul');
    assert.equal(trace.pieces[0].valeurs['piece.poids'].valeur, 1.2);
    assert.ok(trace.pieces[0].routes.length >= 1 && trace.pieces[0].routes.some((r) => r.retenue));
    assert.ok(system.length < 20_000, `system prompt of ${system.length} characters`);
    assert.equal(await reply.locator('.ai-label').textContent(), "Raisonnement IA — aucune valeur n'est appliquée");
    assert.equal(await reply.locator('.ai-check').getAttribute('class'), 'ai-check ok');
    assert.match(await reply.locator('.ai-text').textContent(), new RegExp(`est de ${fr(price.valeur).replace(/\s/g, '\\s')} €`));

    // An invented rate: the answer is marked "non vérifiée".
    answer = () => 'Avec un taux de 85 €/h sur piece.va, le prix baisserait.';
    reply = await ask('Et avec un autre taux ?');
    assert.match(await reply.locator('.ai-check.bad').textContent(), /Réponse non vérifiée : un nombre absent de la trace du chiffrage \(85\)/);
    // The AI wrote nothing: the costing data of this browser are unchanged. Its answers are kept with the quote, for the record.
    assert.equal(await costingStorage(), stored);
    const kept = await analyses();
    assert.deepEqual(kept.map((a) => [a.provider, a.model, a.question, a.verified]), [['Ollama', 'qwen3:8b', 'Pourquoi ce prix ?', true], ['Ollama', 'qwen3:8b', 'Et avec un autre taux ?', false]]);
    assert.match(kept[1].answer, /Avec un taux de 85 €\/h/);
    assert.ok(kept.every((a) => !Number.isNaN(Date.parse(a.date))));

    // The AI gateway: the internal amounts masked, unless the box is ticked.
    await page.selectOption('#ai-provider', 'openai');
    await page.fill('#ai-url', `http://127.0.0.1:${gateway.address().port}/api/ai`);
    assert.equal(await page.isVisible('#ai-amounts-field'), true);
    assert.equal(await page.isChecked('#ai-amounts'), false);
    answer = (trace) => `Le prix de vente (piece.prix.vente) est ${typeof trace.pieces[0].valeurs['piece.prix.vente'].valeur === 'number' ? `de ${fr(trace.pieces[0].valeurs['piece.prix.vente'].valeur)} €` : 'masqué'}.`;
    reply = await ask('Pourquoi ce prix ?');
    const masked = gatewayRequests[0].context.costing_trace;
    assert.match(masked.masque, /montants internes masqués/);
    assert.equal(masked.pieces[0].valeurs['piece.prix.vente'].valeur, 'masqué');
    assert.equal(masked.pieces[0].valeurs['piece.poids'].valeur, 1.2);
    assert.doesNotMatch(JSON.stringify(masked), new RegExp(`\\b${String(price.valeur).replace('.', '\\.')}\\b`));
    assert.equal(gatewayRequests[0].context.costing_contract, undefined);
    assert.ok(gatewayRequests[0].messages.every((m) => Object.keys(m).join() === 'role,content'));
    // The costing task named; the trace within two thirds of the gateway's budget, the whole context within it.
    assert.equal(gatewayRequests[0].task, 'costing');
    assert.ok(JSON.stringify(masked).length <= 4000, `trace of ${JSON.stringify(masked).length} characters`);
    assert.ok(JSON.stringify(gatewayRequests[0].context).length <= 6000);
    assert.match(await page.textContent('#ai-status'), /^Réponse en \d+ s · Groq · openai\/gpt-oss-120b · 997 questions restantes aujourd'hui$/);
    assert.match(await reply.locator('.ai-text').textContent(), /Analyse du chiffrage :\nExplications :\n- Le prix de vente \(piece\.prix\.vente\) est masqué\.\nÉcarts signalés :\n- devis\.densite : défaut du code/);
    assert.equal(await reply.locator('.ai-check').textContent(), 'Aucun nombre cité.');
    await page.check('#ai-amounts');
    reply = await ask('Et le détail ?');
    assert.equal(gatewayRequests[1].context.costing_trace.masque, undefined);
    assert.equal(gatewayRequests[1].context.costing_trace.pieces[0].valeurs['piece.prix.vente'].valeur, price.valeur);
    assert.equal(await reply.locator('.ai-check').getAttribute('class'), 'ai-check ok');
    assert.equal(await costingStorage(), stored);

    // The answers keep their label and their check after a reload.
    await page.reload();
    await page.waitForSelector('#ai-chat .ai-label');
    assert.equal(await page.locator('#ai-chat .ai-label').count(), 4);
    assert.equal(await page.locator('#ai-chat .ai-check.bad').count(), 1);

    // The Excel export of the quote: the answers of the AI in their own sheet, none of their values applied.
    assert.deepEqual((await analyses()).map((a) => a.provider), ['Ollama', 'Ollama', 'Groq', 'Groq']);
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage [data-action="export-xlsx"]:not([disabled])');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    assert.match(strFromU8(files['xl/workbook.xml']), /name="Analyses IA"/);
    const sheet = strFromU8(files['xl/worksheets/sheet8.xml']);
    for (const text of ["aucune valeur n'a été appliquée au devis ni aux paramètres", 'Fournisseur', 'Pourquoi ce prix ?', 'Et avec un autre taux ?', 'Et le détail ?', 'qwen3:8b', 'openai/gpt-oss-120b', 'non : nombres absents de la trace']) {
      assert.ok(sheet.includes(text), text);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('cycle time estimated by the AI: the data sent to the gateway, the proposal shown, used in the quote and traced, kept with the real time, undone', { timeout: 120_000 }, async (t) => {
    // A stand-in for the AI gateway (CORS as it does it), answering the task cycle_time from the data it is given.
    const requests = [];
    const cors = (req, res) => {
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      if (req.method !== 'OPTIONS') return false;
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
      res.end();
      return true;
    };
    const gateway = createServer(async (req, res) => {
      if (cors(req, res)) return;
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ provider: 'Groq', model: 'openai/gpt-oss-120b', models: [], context_chars: 9000, access_code_required: false }));
      let text = '';
      for await (const chunk of req) text += chunk;
      const request = JSON.parse(text);
      requests.push(request);
      const f = request.context.formule.valeur_s;
      const e = Math.round(f * 1.1);
      const similar = request.context.pieces_similaires ?? [];
      res.end(JSON.stringify({ output: JSON.stringify({
        estimation_s: e, fourchette_s: [e - 20, e + 20], confiance: 'moyenne',
        decomposition: [
          { etape: 'Poteyage et fermeture', secondes: 15, justification: 'coquille poteyée à chaque cycle' },
          { etape: 'Coulée', secondes: 10, justification: 'débit supposé de 0,7 kg/s' },
          { etape: 'Solidification', secondes: e - 50, justification: 'module de 0,3 cm, règle de Chvorinov' },
          { etape: 'Ouverture et éjection', secondes: 25, justification: 'extraction de la grappe' },
        ],
        comparaison: { formule_commentaire: `formule à ${Math.round(f)} s : estimation 10 % au-dessus`, tendance_commentaire: '', pieces_similaires_commentaire: similar.length ? `proche de ${similar[0].ref}` : '' },
        pieces_similaires_utilisees: similar.slice(0, 1).map((x) => x.ref),
        hypotheses: ['coquille à température de régime'],
        a_verifier: ['temps de solidification au point chaud'],
      }), provider: 'Groq', model: 'openai/gpt-oss-120b', quota: { requests_remaining_day: 990 } }));
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
      gateway.closeAllConnections();
      gateway.close(resolve);
    }));
    // A history of cycle times (made-up values).
    const record = (over) => ({
      ref: 'HX-1', fichier_3d: 'hx1_confidentiel.stp', source: 'devis', ilot: 'CG3', temps_cycle_s: 210, pieces_par_cycle: 1, trs: 0.8, poids_kg: 1.4, module_mm: 3.2,
      volume_cm3: 520, surface_cm2: 1500, encombrement_mm: [150, 90, 40], noyaux: false, sable_kg: null, serie: 800, mise_au_mille: 1.7, ...over,
    });
    writeFileSync(join(dir, 'historique-ia.json'), JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: [
      record(), record({ ref: 'HX-2', source: 'production', temps_cycle_s: 190, poids_kg: 1.1 }), record({ ref: 'HX-3', ilot: 'BPR', temps_cycle_s: 150 }),
    ] }));

    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // The AI chosen on the IA page: the gateway (names anonymised, by default).
    await page.evaluate((url) => {
      localStorage.setItem('reader3d.ai.provider', 'openai');
      localStorage.setItem('reader3d.ai.gateway', url);
    }, `http://127.0.0.1:${gateway.address().port}/api/ai`);
    await page.click('.tab[data-page="chiffrage"]');
    const text = (selector = '#page-chiffrage') => page.textContent(selector).then((x) => x.replace(/[\u202f\u00a0]/g, ' '));
    const waitText = (re) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById('page-chiffrage').textContent.replace(/[\u202f\u00a0]/g, ' ')), re.source);
    await page.setInputFiles('#page-chiffrage input[data-file="historique"]', join(dir, 'historique-ia.json'));
    await waitText(/Historique « historique-ia\.json » importé/);
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    const typeIn = async (bind, value) => {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    };
    for (const [bind, value] of [['q.client', 'ACME ESSAI'], ['q.reference', 'REF-CYCLE-IA'], ['p.poids', 1.2], ['p.toileMini', 5], ['p.epaisseurMax', 10], ['p.moduleMm', 3], ['p.dimMax', 250]]) await typeIn(bind, value);
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');
    const estimated = Number(/Temps de cycle\s*(\d+) s \(estimé\)/.exec(await text())[1]);
    // The PRI of the detail of the costing (the note of the solutions says "PRI complet" first, without an amount).
    const pri = async () => /PRI complet(?: \(outillage compris\))?(\d[\d\s]*,\d+) €/.exec(await text())[1];
    const priBefore = await pri();
    // The button, beside the cycle of the route; the AI asked; the box of the similar parts, ticked.
    assert.match(await text(), /IA de la page IA \/ analyse : passerelle en ligne, noms anonymisés\. Historique : 3 enregistrements, les 3 plus semblables envoyés/);
    assert.equal(await page.isChecked('#page-chiffrage [data-pref="cycle-similar"]'), true);
    await page.click('#page-chiffrage [data-action="estimate-cycle"]');
    await page.waitForSelector('#ccycle-ia .ccycle-value');

    // What the gateway was sent: the task, the data of the piece and of its casting, the formula, the similar parts; no name.
    const [request] = requests;
    assert.equal(request.task, 'cycle_time');
    assert.deepEqual(request.messages.map((m) => m.role), ['user']);
    const data = request.context;
    const island = data.coulee.ilot;
    assert.deepEqual([data.piece.nom, data.piece.poids_kg, data.piece.module_mm, data.piece.toile_mini_mm, data.piece.epaisseur_max_mm], ['Pièce', 1.2, 3, 5, 10]);
    assert.ok(Math.abs(data.formule.valeur_s - estimated) <= 0.5, `${data.formule.valeur_s} vs ${estimated}`);
    assert.ok(data.formule.termes_s.base > 0 && data.cycle_devis.source === "formule de l'îlot");
    assert.deepEqual(data.pieces_similaires.map((x) => x.ref), ['Historique 1', 'Historique 2', 'Historique 3']);
    assert.ok(data.pieces_similaires.every((x) => x.temps_cycle_s > 0 && ['devis', 'production'].includes(x.source)));
    const sent = JSON.stringify(request);
    for (const name of ['HX-1', 'HX-2', 'HX-3', 'hx1_confidentiel', 'ACME ESSAI', 'REF-CYCLE-IA']) assert.ok(!sent.includes(name), name);
    assert.ok(JSON.stringify(data).length <= 9000);

    // The proposal: value, range, confidence, breakdown, comparison, hypotheses, points to verify, model, date; the numbers flagged.
    const e = Math.round(data.formule.valeur_s * 1.1);
    const card = await text('#ccycle-ia');
    assert.match(card, /Proposition IA — rien n'est appliqué sans votre validation/);
    assert.match(card, new RegExp(`${e} s par cycle — fourchette de ${e - 20} s à ${e + 20} s, confiance moyenne — îlot ${island}`));
    assert.match(card, /Groq · openai\/gpt-oss-120b · \d\d\/\d\d\/\d{4}/);
    assert.equal(await page.locator('#ccycle-ia .ccycle-steps tbody tr').count(), 4);
    assert.match(card, new RegExp(`Total de la décomposition${e} s`));
    assert.match(card, new RegExp(`Formule \\([\\d,]+ s\\) : formule à ${Math.round(data.formule.valeur_s)} s`));
    // The references of the history: their labels sent, the real ones shown.
    const first = /^Noms réels : Historique 1 = (HX-\d)$/.exec(await page.textContent('#ccycle-ia .ai-names'))?.[1];
    assert.ok(first);
    assert.match(card, new RegExp(`Pièces semblables \\(3 envoyées\\) : proche de Historique 1 — utilisées : ${first}`));
    assert.match(card, /Hypothèses\s*coquille à température de régime/);
    assert.match(card, /À vérifier\s*temps de solidification au point chaud/);
    assert.equal(await page.textContent('#ccycle-ia .ai-numbers'), "1 nombre ne vient pas des données envoyées ni de l'estimation");
    assert.equal(await page.getAttribute('#ccycle-ia .ai-numbers', 'title'), '0,7');
    // Nothing applied yet: the same price; the estimate is another source of the cycle in the trace.
    assert.equal(await pri(), priBefore);
    await page.click('#page-chiffrage [data-action="show-trace"]');
    await page.waitForSelector('#page-chiffrage #ctrace details[open] table');
    let row = await page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.cycle' }).first().textContent();
    assert.match(row, /calcul/);
    assert.match(row, new RegExp(`autre source : estimation IA non validée \\(Groq · openai/gpt-oss-120b · \\d\\d/\\d\\d/\\d{4}, fourchette de ${e - 20} à ${e + 20} s\\) ${e} s`));

    // "Utiliser cette valeur": the cycle of the quote, its island imposed; traced « estimation IA validée ».
    await page.click('#ccycle-ia [data-action="adopt-cycle"]');
    await waitText(new RegExp(`Temps de cycle de ${e} s utilisé dans le devis : estimation IA validée \\(Groq · openai/gpt-oss-120b\\), îlot ${island} désormais imposé`));
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.procede"]'), island);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.cycle"]'), String(e));
    assert.notEqual(await pri(), priBefore, 'the price of the cycle adopted');
    row = await page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.cycle' }).first().textContent();
    assert.match(row, new RegExp(`${e} s\\s*estimation IA validée, \\d\\d/\\d\\d/\\d{4}`));
    assert.match(row, /hard \(N1\)\s*moyenne/);
    assert.match(row, /fourchette de \d+ à \d+ s, confiance moyenne/);
    assert.match(row, new RegExp(`îlot ${island} imposé avec l'estimation`));
    assert.match(await text('#ccycle-ia'), new RegExp(`Utilisée dans le devis : ${e} s depuis le`));
    // Kept with the quote: after a reload, the proposal and its use.
    await page.reload();
    await page.waitForSelector('#ccycle-ia [data-action="undo-cycle"]');
    // The Excel export: the value with its source in Traçabilité, the estimate in "Analyses IA".
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#page-chiffrage [data-action="export-xlsx"]')]);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    const sheets = Object.entries(files).filter(([k]) => k.startsWith('xl/worksheets/')).map(([, v]) => strFromU8(v));
    assert.ok(sheets.some((x) => x.includes('piece.cycle') && x.includes('estimation IA validée')));
    assert.ok(sheets.some((x) => x.includes(`Estimation du temps de cycle de coulée (îlot ${island}) : ${e} s`) && x.includes('non : nombres absents des données envoyées')));

    // The real time measured: kept with the estimate, compared with it.
    await typeIn('p.cycleReel', e + 10);
    await page.waitForSelector('#cfeedback [data-action="save-feedback"]:not([disabled])');
    await page.click('#cfeedback [data-action="save-feedback"]');
    await waitText(/Temps de cycle réel enregistré dans le retour d'expérience : « REF-CYCLE-IA »/);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.chiffrage.historique.v1')).pieces.find((x) => x.source === 'production' && x.ref === 'REF-CYCLE-IA'));
    assert.deepEqual({ ...kept.estimation_ia, date: null }, { temps_cycle_s: e, fournisseur: 'Groq', modele: 'openai/gpt-oss-120b', date: null, adoptee: true });
    assert.deepEqual(await page.$$eval('#chistorique .chisto thead th', (ths) => ths.map((th) => th.textContent)), ['Référence', 'Îlot', 'Réel', 'Formule', 'Écart', 'Estimation IA', 'Écart']);

    // A new estimate: a proposal again, the value of the quote still the one adopted, with its source.
    await page.click('#page-chiffrage [data-action="estimate-cycle"]');
    await page.waitForSelector('#ccycle-ia [data-action="adopt-cycle"]:not([disabled])');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].context.cycle_devis.source, 'estimation IA validée');
    assert.match(await text('#ccycle-ia'), new RegExp(`Utilisée dans le devis : ${e} s, estimation du \\d\\d/\\d\\d/\\d{4} \\d\\d:\\d\\d validée le`));
    assert.match(await page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.cycle' }).first().textContent(), /estimation IA validée/);

    // "Ne plus utiliser cette valeur": the formula and the automatic island again, the price of before.
    await page.click('#ccycle-ia [data-action="undo-cycle"]');
    await waitText(/Estimation IA retirée du devis : temps de cycle estimé par la formule, îlot choisi automatiquement\./);
    assert.equal(await page.inputValue('#page-chiffrage [data-bind="p.procede"]'), 'auto');
    assert.equal(await pri(), priBefore);
    assert.equal(await page.isDisabled('#ccycle-ia [data-action="adopt-cycle"]'), false);

    // The box unticked: no similar part sent.
    await page.uncheck('#page-chiffrage [data-pref="cycle-similar"]');
    await waitText(/Historique : 4 enregistrements, non envoyé\./); // with the real time kept above
    await page.click('#page-chiffrage [data-action="estimate-cycle"]');
    await page.waitForFunction(() => !document.querySelector('#ccycle-status'));
    assert.equal(requests.length, 3);
    assert.equal('pieces_similaires' in requests[2].context, false);
    assert.match(await text('#ccycle-ia'), /Pièces semblables \(0 envoyée\)/);

    // A phone: the card within 375 px (its table scrolls inside it).
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#ccycle-ia')].flatMap((card) => [card, ...card.querySelectorAll('button, .cscroll, p')])
      .filter((x) => x.offsetParent).map((x) => [x.textContent.trim().slice(0, 30) || x.className, Math.round(x.getBoundingClientRect().right)]).filter(([, right]) => right > 375));
    assert.deepEqual(overflow, []);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('backtest of the AI on the history: paced against the stand-in gateway, kept over a reload, stopped by its quota and resumed, read and exported', { timeout: 180_000 }, async (t) => {
    // A stand-in for the AI gateway (CORS as it does it): an estimate from the weight sent; the request number `refuse` refused for quota.
    const requests = [];
    let refuse = 0;
    const cors = (req, res) => {
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      if (req.method !== 'OPTIONS') return false;
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
      res.end();
      return true;
    };
    const gateway = createServer(async (req, res) => {
      if (cors(req, res)) return;
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ provider: 'Groq', model: 'openai/gpt-oss-120b', models: [], context_chars: 9000, access_code_required: false }));
      let text = '';
      for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      if (requests.length === refuse) {
        res.writeHead(429, { 'Retry-After': '1' });
        return res.end(JSON.stringify({ error: 'Quota de Groq (offre gratuite) atteint. Réessayez dans 1 s.', retry_after: 1 }));
      }
      const e = Math.round(requests.at(-1).context.piece.poids_kg * 100 + 100);
      res.end(JSON.stringify({ output: JSON.stringify({
        estimation_s: e, fourchette_s: [e - 20, e + 20], confiance: 'moyenne',
        decomposition: [{ etape: 'Solidification', secondes: e - 40, justification: 'règle de Chvorinov' }, { etape: 'Ouverture et éjection', secondes: 40, justification: 'extraction' }],
        comparaison: { formule_commentaire: '', tendance_commentaire: '', pieces_similaires_commentaire: '' },
        pieces_similaires_utilisees: [], hypotheses: [], a_verifier: [],
      }), provider: 'Groq', model: 'openai/gpt-oss-120b', quota: { requests_remaining_day: 1000 - requests.length, tokens_limit_minute: 8000, tokens_remaining_minute: 7800 }, usage: { total_tokens: 100 } }));
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
      gateway.closeAllConnections();
      gateway.close(resolve);
    }));
    // A history (made-up values): BX-1 quoted and measured, an island without the settings' formula of the quote, a record without modulus (not run).
    const record = (over) => ({
      ref: 'BX-1', fichier_3d: 'bx1_confidentiel.stp', source: 'devis', ilot: 'CG3', temps_cycle_s: 210, pieces_par_cycle: 1, trs: 0.8, poids_kg: 1, module_mm: 3,
      volume_cm3: 370, surface_cm2: 1100, encombrement_mm: [120, 80, 30], noyaux: false, sable_kg: null, serie: 600, mise_au_mille: 1.7, ...over,
    });
    const history = [
      record(), record({ source: 'production', temps_cycle_s: 190 }), record({ ref: 'BX-2', temps_cycle_s: 260, poids_kg: 1.6, module_mm: 4 }),
      record({ ref: 'BX-3', ilot: 'BPR', temps_cycle_s: 150, poids_kg: 2.2, module_mm: 5 }), record({ ref: 'BX-4', temps_cycle_s: 90, poids_kg: 0.4, module_mm: null }),
    ];
    writeFileSync(join(dir, 'historique-banc.json'), JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: history }));

    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}?lang=fr`);
    await page.evaluate((url) => {
      localStorage.setItem('reader3d.ai.provider', 'openai');
      localStorage.setItem('reader3d.ai.gateway', url);
    }, `http://127.0.0.1:${gateway.address().port}/api/ai`);
    await page.click('.tab[data-page="chiffrage"]');
    const text = (selector = '#chistorique') => page.textContent(selector).then((x) => x.replace(/[  ]/g, ' '));
    const waitText = (re) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById('chistorique')?.textContent.replace(/[  ]/g, ' ')), re.source);
    const kept = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('reader3d.chiffrage.banc-essai-ia.v1') ?? '{}').resultats ?? {}).length);
    await page.setInputFiles('#page-chiffrage input[data-file="historique"]', join(dir, 'historique-banc.json'));
    await waitText(/Historique :\s*5 enregistrements/);
    assert.match(await text(), /Pour chaque enregistrement qui a un poids et un module \(4 pièces sur 5\)/);
    assert.match(await text(), /IA de la page IA \/ analyse \(passerelle en ligne, noms anonymisés\)/);
    assert.match(await text(), /Une demande à la fois, une toutes les 20 s puis au rythme que permet le quota renvoyé par la passerelle/);
    assert.equal(await page.isDisabled('#chistorique [data-action="export-backtest"]'), true);

    // The run: one record, then the wait the quota of the gateway sets (6 s at least); a reload during it.
    await page.click('#chistorique [data-action="backtest"]');
    await page.waitForSelector('#cbacktest-status');
    assert.equal(await page.isDisabled('#chistorique [data-action="backtest"]'), true);
    assert.equal((await page.textContent('#chistorique [data-action="backtest"]')).trim(), "Banc d'essai IA en cours");
    await page.waitForFunction(() => /Pièce 2 sur 4 \(BX-1\) : prochaine demande dans \d s, au rythme du quota en ligne/.test(document.getElementById('cbacktest-status')?.textContent));
    assert.equal(await kept(), 1);
    await page.reload();
    await page.waitForSelector('#chistorique .cbacktest');
    assert.equal(requests.length, 1);
    assert.match(await text(), /Banc d'essai interrompu : la page a été fermée ou rechargée pendant la série ; les résultats obtenus sont gardés\. « Reprendre » continue avec les 3 pièces restantes\./);
    assert.equal((await page.textContent('#chistorique [data-action="backtest"]')).trim(), "Reprendre le banc d'essai IA (3 pièces à estimer)");
    assert.match(await text(), /Sur 1 pièce chiffrée \(1 temps de devis\), l'IA s'écarte en moyenne de 4,8 % du temps de référence, la formule de [\d,]+ %\./);

    // Resumed: the second record, then the third refused for quota: stopped cleanly, two left.
    refuse = 3;
    await page.click('#chistorique [data-action="backtest"]');
    await waitText(/Banc d'essai arrêté par le quota en ligne : Quota de Groq \(offre gratuite\) atteint\. Réessayez dans 1 s\. « Reprendre » continue avec les 2 pièces restantes/);
    assert.deepEqual([requests.length, await kept()], [3, 2]);
    // Resumed again: the record refused first, then the last one.
    await page.click('#chistorique [data-action="backtest"]');
    await waitText(/Banc d'essai IA terminé/);
    assert.deepEqual([requests.length, await kept()], [5, 4]);
    assert.equal(await page.isDisabled('#chistorique [data-action="backtest"]'), true);

    // What was sent: the task, the record anonymised, never its own time nor a record of its reference.
    for (const request of requests) {
      assert.equal(request.task, 'cycle_time');
      const data = request.context;
      assert.equal(data.piece.nom, 'Pièce');
      assert.equal('cycle_devis' in data, false);
      assert.ok(data.pieces_similaires.length >= 2);
      assert.ok(data.pieces_similaires.every((x) => x.poids_kg !== data.piece.poids_kg && /^Historique \d$/.test(x.ref)), JSON.stringify(data.pieces_similaires));
      assert.doesNotMatch(JSON.stringify(request), /BX-\d|bx1_confidentiel/);
    }
    assert.deepEqual(requests.map((x) => x.context.piece.poids_kg), [1, 1, 1.6, 1.6, 2.2]);
    assert.equal('formule' in requests[4].context, true, 'BPR: the formula of the settings');

    // The table: each record with its time, the formula, the AI and its range, the errors; the summary; the reading.
    const rows = await page.$$eval('#chistorique .cbacktest tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.replace(/[  ]/g, ' '))));
    assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3], r[6], r[7], r[8]]), [
      ['BX-1', 'CG3', 'devis', '210 s', '200 s (180–220)', '-4,8 %', 'oui'],
      ['BX-1', 'CG3', 'production', '190 s', '200 s (180–220)', '+5,3 %', 'oui'],
      ['BX-2', 'CG3', 'devis', '260 s', '260 s (240–280)', '0,0 %', 'oui'],
      ['BX-3', 'BPR', 'devis', '150 s', '320 s (300–340)', '+113,3 %', 'non'],
    ]);
    assert.ok(rows.every((r) => /^\d[\d ]*(,\d)? s$/.test(r[4]) && /^[+-]?\d+,\d %$/.test(r[5])), JSON.stringify(rows));
    const summary = await page.$$eval('#chistorique .cbacktest-summary tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.replace(/[  ]/g, ' '))));
    assert.deepEqual(summary.map((r) => [r[0], r[1], r[3], r[4]]), [
      ['Îlot BPR', '1', '113,3 %', '0 sur 1'], ['Îlot CG3', '3', '3,3 %', '3 sur 3'],
      ['Temps de devis', '3', '39,4 %', '2 sur 3'], ['Temps mesurés en production', '1', '5,3 %', '1 sur 1'], ['Toutes les pièces', '4', '30,8 %', '3 sur 4'],
    ]);
    const reading = await text('#chistorique .cbacktest-reading');
    assert.match(await text(), /Réponses de : Groq · openai\/gpt-oss-120b \(4 pièces\)\./);
    assert.match(reading, /^Sur 4 pièces chiffrées \(3 temps de devis, 1 temps mesuré en production\), l'IA s'écarte en moyenne de 30,8 % du temps de référence, la formule de [\d,]+ %\. Le temps de référence est dans la fourchette de l'IA pour 3 pièces sur 4 \(75 %\)\. Sur les seuls temps mesurés \(1\) : l'IA 5,3 %, la formule [\d,]+ %\. Les temps « devis » sont des estimations des chiffreurs, pas des mesures/);

    // The CSV export.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#chistorique [data-action="export-backtest"]')]);
    assert.equal(download.suggestedFilename(), 'banc_essai_ia.csv');
    const csv = readFileSync(await download.path(), 'utf8').split('\r\n');
    assert.equal(csv[0], '﻿reference;ilot;source;temps_reference_s;formule_s;ecart_formule_pct;ia_s;ia_min_s;ia_max_s;ecart_ia_pct;dans_fourchette;confiance;fournisseur;modele;date;erreur');
    assert.match(csv[1], /^"BX-1";"CG3";"devis";210;[\d,]+;-?[\d,]+;200;180;220;-4,8;oui;"moyenne";"Groq";"openai\/gpt-oss-120b";"\d{4}-\d\d-\d\dT[\d:.]+Z";$/);
    assert.equal(csv.length, 6);

    // A phone: the card within 375 px (its tables scroll inside it).
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#chistorique')].flatMap((card) => [card, ...card.querySelectorAll('button, .cscroll, p')])
      .filter((x) => x.offsetParent).map((x) => [x.textContent.trim().slice(0, 30) || x.className, Math.round(x.getBoundingClientRect().right)]).filter(([, right]) => right > 375));
    assert.deepEqual(overflow, []);

    // With Ollama: no quota, slower, said so. Erased: back to the start.
    await page.evaluate(() => localStorage.setItem('reader3d.ai.provider', 'ollama'));
    await page.reload();
    await page.waitForSelector('#chistorique .cbacktest');
    assert.match(await text(), /IA de la page IA \/ analyse \(Ollama local \(qwen3:8b\)\)[\s\S]*Ollama local : aucun quota, mais plus lent — de quelques secondes à quelques minutes par pièce selon le PC/);
    await page.click('#chistorique [data-action="clear-backtest"]');
    await page.waitForFunction(() => document.querySelector('#chistorique [data-action="backtest"]')?.textContent.trim() === "Banc d'essai IA");
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.chiffrage.banc-essai-ia.v1')), null);
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
