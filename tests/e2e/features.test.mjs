// End-to-end tests of the user-facing features of the built site (dist/):
// French interface, analysis progress, memory gauge, Excel export, wall
// thickness, and the
// link-driven mode for AI assistants (?url=…&report=1, window.reader3d).
//
//   npm run build && node --test tests/e2e/features.test.mjs

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
    assert.match(sheet, /<autoFilter ref="A1:Q4"\/>/);
    // Wall thickness, computed for the export: the bracket is a 5 mm plate, the pin 8 mm across.
    assert.match(rows[0][2], /Toile mini \(mm\)/);
    const cellL = (r) => Number(rows[r][2].match(new RegExp(`<c r="L${r + 1}"[^>]*><v>([^<]+)</v></c>`))?.[1]);
    approx(cellL(1), 5, 0.02, 0, 'thinnest wall of the bracket');
    approx(cellL(2), 8, 0.02, 0, 'thinnest wall of the pin');
    approx(cellL(3), 5, 0.02, 0, 'thinnest wall of the model');
    await page.context().close();
  });

  test('wall thickness: colour scale, graduated scale and highlight', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.isVisible('#thickness-card'), true);
    assert.equal(await page.textContent('#toggle-thickness'), 'Épaisseurs');
    await page.click('#toggle-thickness');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: 60_000 });
    assert.equal(await page.evaluate(() => document.getElementById('toggle-thickness').classList.contains('active')), true);
    assert.equal(await page.isChecked('#thick-colors'), true);
    // The block is 20 mm thick: the scale goes up to a round value above it.
    assert.match(await page.textContent('#thick-stats'), /Médiane \(en surface\)20 mm/);
    assert.equal(await page.textContent('#thick-min'), '20 mm');
    assert.equal(await page.inputValue('#thick-max'), '25');
    // Highlight 20 ± 0.5 mm: the whole surface.
    await page.fill('#thick-tol', '0.5');
    await page.dispatchEvent('#thick-tol', 'change');
    await page.fill('#thick-value', '20');
    await page.dispatchEvent('#thick-value', 'change');
    assert.equal(await page.isChecked('#thick-highlight'), true);
    assert.match(await page.textContent('#thick-share'), /^100 % de la surface entre 19,5 et 20,5 mm/);
    // Moving the slider highlights another thickness: nothing at 5 mm.
    await page.fill('#thick-slider', '200');
    assert.match(await page.textContent('#thick-share'), /^0 % de la surface entre 4,5 et 5,5 mm/);
    // "Locate" highlights the thinnest walls, with the "wall" measure (the
    // large faces of the block; its sides read its length or width).
    await page.click('#thick-locate');
    assert.equal(await page.inputValue('#thick-method'), 'wall');
    assert.equal(await page.inputValue('#thick-value'), '20');
    assert.match(await page.textContent('#thick-share'), /^\d+(,\d)? % de la surface entre 19 et 21 mm/);
    // The JSON export carries the thickness.
    const [json] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
    const exported = JSON.parse(readFileSync(await json.path(), 'utf8'));
    approx(exported.thickness.min, 20, 0.01, 0, 'JSON thinnest wall');
    assert.equal(exported.thickness.method, 'wall');
    approx(exported.bodies[0].thickness.median, 20, 0.01, 0, 'JSON body median');
    // The most frequent and the thickest are links: a click highlights them.
    await page.fill('#thick-value', '5');
    await page.dispatchEvent('#thick-value', 'change');
    await page.click('#thick-stats [data-spot="max"]');
    assert.equal(await page.isChecked('#thick-highlight'), true);
    const shownMax = (await page.textContent('#thick-stats')).match(/point chaud\)([\d,]+) mm/)[1].replace(',', '.');
    approx(Number(await page.inputValue('#thick-value')), Number(shownMax), 0.01, 0, 'highlight at the thickest');
    // The thinnest wall of the quote can be typed in: the detected one stays shown, greyed.
    await page.fill('#thick-min-used', '3.5');
    await page.dispatchEvent('#thick-min-used', 'change');
    assert.equal(await page.textContent('#thick-min'), '20 mm');
    assert.equal(await page.evaluate(() => document.getElementById('thick-min').classList.contains('overridden')), true);
    const used = await page.evaluate(() => window.reader3d.part().thickness);
    assert.equal(used.min, 3.5);
    approx(used.detected, 20, 0.01, 0, 'detected');
    await page.fill('#thick-min-used', '');
    await page.dispatchEvent('#thick-min-used', 'change');
    approx(await page.evaluate(() => window.reader3d.part().thickness.min), 20, 0.01, 0, 'back to the detected one');
    // The name of the part, in the bar; a material set from elsewhere (customer request).
    assert.equal(await page.textContent('.doc-tab.active .doc-tab-name'), 'holed_block');
    await page.evaluate(() => window.reader3d.setMaterial('AS7G06', 2.68));
    assert.equal(await page.inputValue('#density'), '2.68');
    assert.match(await page.textContent('#material'), /AS7G06 \(2,68\)/);
    // The colour filter can be switched off, the highlight stays.
    await page.click('#toggle-thickness');
    assert.equal(await page.isChecked('#thick-colors'), false);
    assert.equal(await page.isVisible('#thick-body'), true);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('results kept in the browser, refresh without reloading the page', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    const open = async () => {
      await page.evaluate(() => (document.body.dataset.status = ''));
      await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    };
    await open();
    assert.doesNotMatch(await page.textContent('#method'), /mémorisés/);
    const volume = await page.textContent('#total-volume');
    await page.evaluate(() => window.reader3d.computeThickness());
    const min = await page.textContent('#thick-min');
    // Kept results are written in the background.
    await page.waitForTimeout(500);

    // Opened again after a reload of the page: the same results, at once, thickness included.
    await page.reload();
    await open();
    assert.match(await page.textContent('#method'), /Résultats mémorisés/);
    assert.equal(await page.textContent('#total-volume'), volume);
    assert.equal(await page.textContent('#thick-min'), min);
    assert.equal(await page.isVisible('#thick-body'), true);

    // The wireframe is built when shown (no error on a model opened from the kept results).
    await page.click('#toggle-wire');
    assert.equal(await page.evaluate(() => document.getElementById('toggle-wire').classList.contains('active')), true);
    await page.click('#toggle-wire');

    // Kept by an earlier version (one record {data, thickness}), with a thickness
    // computed since then in a record of its own: opened again, the same model.
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('reader3d-cache');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const store = db.transaction('data', 'readwrite').objectStore('data');
      const keys = await new Promise((resolve) => (store.getAllKeys().onsuccess = (e) => resolve(e.target.result)));
      const key = keys.find((k) => !String(k).includes('#'));
      const record = await new Promise((resolve) => (store.get(key).onsuccess = (e) => resolve(e.target.result)));
      await new Promise((resolve) => {
        const tx = db.transaction('data', 'readwrite');
        tx.objectStore('data').put({ data: record, thickness: null }, key);
        tx.oncomplete = resolve;
      });
      db.close();
    });
    await page.reload();
    await open();
    assert.match(await page.textContent('#method'), /Résultats mémorisés/);
    assert.equal(await page.textContent('#total-volume'), volume);
    assert.equal(await page.textContent('#thick-min'), min);

    // "Refresh": analysed again, without the kept results.
    await page.evaluate(() => (document.body.dataset.status = ''));
    await page.click('#refresh');
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    assert.doesNotMatch(await page.textContent('#method'), /mémorisés/);
    assert.equal(await page.textContent('#total-volume'), volume);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('open surfaces closed on request ("Fermer le corps")', { timeout: CAD_TIMEOUT }, async () => {
    // A box 40 x 30 x 20 mm given as 5 loose faces: open, a face missing.
    const { loadOcctNode } = await import('../../web/engine/occt.js');
    const oc = await loadOcctNode();
    const box = new oc.BRepPrimAPI_MakeBox_2(40, 30, 20).Shape();
    const faces = new oc.TopoDS_Compound();
    const builder = new oc.BRep_Builder();
    builder.MakeCompound(faces);
    const explorer = new oc.TopExp_Explorer_2(box, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (let n = 0; explorer.More() && n < 5; explorer.Next(), n++) builder.Add(faces, explorer.Current());
    const writer = new oc.STEPControl_Writer_1();
    writer.Transfer(faces, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
    writer.Write('/open_box.step');
    mkdirSync(SAMPLE_DIR, { recursive: true });
    const file = join(SAMPLE_DIR, 'open_box.step');
    writeFileSync(file, oc.FS.readFile('/open_box.step'));

    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    // Open: no volume, and the link under the open bodies (nothing closed during the analysis).
    assert.match(await page.textContent('#bodies'), /ouvert/);
    assert.ok((await page.$$('#bodies .close-body')).length >= 1);
    assert.equal((await page.textContent('#bodies .close-body')).trim(), 'Fermer le corps');
    await page.evaluate(() => (document.body.dataset.status = ''));
    await page.click('#bodies .close-body');
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const part = await page.evaluate(() => window.reader3d.part());
    approx(part.volume, 24000, 1e-6, 0, 'closed volume');
    assert.equal(part.openBodies, 0);
    assert.equal((await page.$$('#bodies .close-body')).length, 0);
    await page.click('#bodies tr[data-index="0"]');
    assert.match(await page.textContent('#body-detail'), /1 trou\(s\) des surfaces bouché\(s\)/);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('wall thickness of several bodies: the values are those of the bodies checked', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.selectOption('#thick-method', 'wall');
    await page.click('#thick-compute');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: CAD_TIMEOUT });
    const maxOf = async () => Number((await page.textContent('#thick-stats')).match(/maxi[^\d]*([\d,]+) mm/i)[1].replace(',', '.'));
    // Both bodies (bracket 5 mm, pin 8 mm across): the thinnest is the bracket's, the thickest the pin's.
    assert.equal(await page.textContent('#thick-min'), '5 mm');
    const maxBoth = await maxOf();
    const uncheck = async (name) => {
      const index = await page.$$eval('#bodies tr', (trs, n) => trs.findIndex((tr) => tr.querySelector('.name')?.textContent === n), name);
      await page.uncheck(`#bodies tr:nth-child(${index + 1}) input`);
    };
    // The pin alone: its own values.
    await uncheck('Équerre');
    assert.equal(await page.textContent('#thick-min'), '8 mm');
    const maxPin = await maxOf();
    assert.equal((await page.evaluate(() => window.reader3d.part().thickness)).min, 8);
    // The bracket alone: its own values.
    await page.check('#bodies-all');
    await uncheck('Pin');
    assert.equal(await page.textContent('#thick-min'), '5 mm');
    const maxBracket = await maxOf();
    // The thickest of the set is the thickest of its bodies; each body alone has its own.
    approx(maxBoth, Math.max(maxPin, maxBracket), 0.01, 0, 'max of the set');
    assert.notEqual(maxPin, maxBracket);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('IA page: a question answered by a local Ollama, streamed; refused origins explained', { timeout: CAD_TIMEOUT }, async () => {
    // A stand-in for Ollama: /api/tags and a streamed /api/chat, CORS as Ollama does it (OLLAMA_ORIGINS).
    let allowed = true;
    const chats = [];
    const ollama = createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin && !allowed) {
        res.writeHead(403);
        return res.end();
      }
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        chats.push(JSON.parse(body));
        const answer = JSON.stringify({ conclusion: 'Deux corps fermés.', observations: ['volume 7,257 cm³'], inferences: [], recommendations: ['Calculer les épaisseurs'], uncertainties: [], needs_human_validation: true, quote: null });
        res.setHeader('Content-Type', 'application/x-ndjson');
        for (let i = 0; i < answer.length; i += 16) res.write(`${JSON.stringify({ message: { role: 'assistant', content: answer.slice(i, i + 16) }, done: false })}\n`);
        res.end(`${JSON.stringify({ done: true })}\n`);
      });
    });
    await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    await page.selectOption('#ai-provider', 'ollama');
    await page.fill('#ai-url', `http://127.0.0.1:${ollama.address().port}`);
    await page.fill('#ai-input', 'Résume la pièce.');
    await page.press('#ai-input', 'Enter');
    await page.waitForFunction(() => /Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    const chat = await page.textContent('#ai-chat');
    assert.match(chat, /Deux corps fermés\./);
    assert.match(chat, /Recommandations :\s*- Calculer les épaisseurs/);
    // Native chat API, streamed, JSON, no hidden reasoning, a compact context sized for the window.
    const [request] = chats;
    assert.equal(request.model, 'qwen3:8b');
    assert.equal(request.stream, true);
    assert.equal(request.think, false);
    assert.equal(request.format, 'json');
    assert.ok(request.options.num_ctx >= 8192);
    assert.match(request.messages[0].content, /"compaction"/);
    assert.ok(request.messages[0].content.length < 20_000, `system prompt of ${request.messages[0].content.length} characters`);
    assert.deepEqual(request.messages.slice(1).map((m) => m.role), ['user']);
    // An origin refused by Ollama: the question fails with the page's own origin in the explanation, and is not kept.
    allowed = false;
    await page.fill('#ai-input', 'Et les noyaux ?');
    await page.press('#ai-input', 'Enter');
    await page.waitForFunction(() => document.getElementById('ai-status').textContent === 'Erreur', null, { timeout: 30_000 });
    assert.match(await page.textContent('#ai-chat .ai-error'), new RegExp(`OLLAMA_ORIGINS contient ${base.replace(/\/$/, '').replace(/[.]/g, '\\.')}`));
    allowed = true;
    await page.fill('#ai-input', 'Et les noyaux ?');
    await page.press('#ai-input', 'Enter');
    await page.waitForFunction(() => /Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    assert.deepEqual(chats[1].messages.slice(1).map((m) => [m.role, m.role === 'user' ? m.content : '']), [['user', 'Résume la pièce.'], ['assistant', ''], ['user', 'Et les noyaux ?']]);
    // A new conversation forgets it.
    await page.click('#ai-clear');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
    await new Promise((resolve) => ollama.close(resolve));
  });

  test('tabs: several parts open side by side, each with its own analysis', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    assert.equal(await page.textContent('.doc-tab.active .doc-tab-name'), 'Nouvel onglet');
    // A file opened while the tab shown is still analysing another one goes to a new tab.
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForSelector('.doc-tab.busy');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    assert.equal(await page.locator('.doc-tab').count(), 2);
    assert.equal(await page.getAttribute('.doc-tab.active', 'title'), 'box.stl');
    await page.waitForFunction(() => !document.querySelector('.doc-tab.busy') && document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const boxVolume = await page.textContent('#total-volume');
    const boxBodies = await page.locator('#bodies tr').count();
    assert.notEqual(boxVolume, '7,257 cm³');
    // Each tab its own model, results and material.
    await page.evaluate(() => window.reader3d.setMaterial('AS7G06', 2.68));
    await page.click('.doc-tab:first-child');
    assert.equal(await page.textContent('.doc-tab.active .doc-tab-name'), 'named_assembly');
    assert.equal(await page.textContent('#total-volume'), '7,257 cm³');
    assert.equal(await page.inputValue('#density'), '2.70');
    assert.equal((await page.evaluate(() => window.reader3d.result)).file, 'named_assembly.step');
    await page.click('.doc-tab:nth-child(2)');
    assert.equal(await page.textContent('#total-volume'), boxVolume);
    assert.equal(await page.locator('#bodies tr').count(), boxBodies);
    assert.equal(await page.inputValue('#density'), '2.68');
    // An empty tab: the drop hint, no results.
    await page.click('.doc-tab-new');
    assert.equal(await page.locator('.doc-tab').count(), 3);
    assert.equal(await page.isVisible('#drop-hint'), true);
    assert.equal(await page.isVisible('#summary-card'), false);
    assert.equal(await page.evaluate(() => window.reader3d.result), null);
    // Closing a tab shows its neighbour.
    await page.click('.doc-tab.active .doc-tab-close');
    assert.equal(await page.locator('.doc-tab').count(), 2);
    assert.equal(await page.textContent('#total-volume'), boxVolume);
    // "3D Reader": start again with one empty tab (after confirmation).
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#brand');
    assert.equal(await page.locator('.doc-tab').count(), 1);
    assert.equal(await page.textContent('.doc-tab.active .doc-tab-name'), 'Nouvel onglet');
    assert.equal(await page.isVisible('#drop-hint'), true);
    assert.equal(await page.isVisible('#summary-card'), false);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('link for AI assistants: ?url=…&report=1, JSON and window.reader3d', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage();
    await page.goto(`${base}?url=e2e-samples/named_assembly.step&report=1&thickness=1&lang=en`);
    await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status), null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.evaluate(() => document.body.dataset.status), 'done');
    const report = await page.textContent('#reader3d-report');
    assert.match(report, /^file: named_assembly\.step$/m);
    assert.match(report, /^volume: 7256\.63706\d* mm3$/m);
    assert.match(report, /^wall_thickness \(sphere\): min 5(\.\d+)? mm, median /m);
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
