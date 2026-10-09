// End-to-end tests of the user-facing features of the built site (dist/):
// French interface, analysis progress, memory gauge, Excel export, wall
// thickness, the IA page (a local Ollama, the AI gateway, a conversation per
// tab, anonymised names, the fallback on the local model, a phone's width),
// and the link-driven mode for AI assistants (?url=…&report=1, window.reader3d).
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
    // Each method too, whichever the view shows: the AI context reads the
    // hot spots on the spheres and the thinnest wall on the "wall" method.
    assert.equal(exported.thickness.wall.min, exported.thickness.min);
    assert.ok(Number.isFinite(exported.thickness.sphere.median) && Number.isFinite(exported.thickness.sphere.max));
    const semantic = await page.evaluate(() => window.reader3d.semantic.bodies[0]);
    assert.equal(semantic.foundry.evidence.thickness.hotspot_method, 'sphere');
    assert.equal(semantic.manufacturing.functional_thickness.status, 'measured');
    assert.equal(semantic.manufacturing.functional_thickness.minimum_wall_thickness_mm, semantic.foundry.evidence.thickness.min_mm);
    approx(semantic.foundry.evidence.thickness.min_mm, 20, 0.01, 0, 'foundry thinnest wall');
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
    // Analysed again, cancelled at once: the model of before stays, its status with it (not "analysing" for good).
    await page.click('#refresh');
    await page.evaluate(() => document.getElementById('cancel').click());
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: 10_000 });
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
        const request = JSON.parse(body);
        chats.push(request);
        const answer = 'Conclusion : Deux corps fermés.\n\nMesuré :\n- volume 7,257 cm³\n\nRecommandations :\n- Calculer les épaisseurs';
        res.setHeader('Content-Type', 'application/x-ndjson');
        const write = () => {
          for (let i = 0; i < answer.length; i += 16) res.write(`${JSON.stringify({ message: { role: 'assistant', content: answer.slice(i, i + 16) }, done: false })}\n`);
          res.end(`${JSON.stringify({ done: true, load_duration: 2e9, prompt_eval_count: 900, prompt_eval_duration: 3e9, eval_count: 40, eval_duration: 1e9 })}\n`);
        };
        // A model reads its prompt before writing: the first words come after a while.
        setTimeout(() => {
          if (!request.think) return write();
          // Asked to reason: the reasoning first, then the answer.
          for (const words of ['Le volume est donné ', 'par le contexte ; ', 'je vérifie les corps fermés.']) res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', thinking: words }, done: false })}\n`);
          setTimeout(write, 800);
        }, 600);
      });
    });
    await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    // Without a 3D model: general questions are allowed.
    await page.click('.tab[data-page="ia"]');
    await page.selectOption('#ai-provider', 'ollama');
    await page.fill('#ai-url', `http://127.0.0.1:${ollama.address().port}`);
    await page.fill('#ai-input', 'Quelles règles de dépouille en coquille gravité ?');
    await page.press('#ai-input', 'Enter');
    // While the model thinks: a grey italic placeholder in the answer bubble.
    assert.equal(await page.textContent('#ai-chat .ai-thinking'), 'Réflexion en cours…');
    await page.waitForFunction(() => /Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    assert.match(chats[0].messages[0].content, /"no_model_loaded":true/);
    await page.click('#ai-clear');
    chats.length = 0;
    await page.click('.tab[data-page="viewer"]');
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
    // Plain French text (a forced JSON form made the small model copy an empty template).
    assert.equal(request.format, undefined);
    assert.match(request.messages[0].content, /en texte \(jamais de JSON ; gras, listes et petits tableaux Markdown permis\)/);
    assert.match(request.messages[0].content, /qwen3:8b\) qui tourne en local sur ce PC/);
    assert.equal(request.keep_alive, '15m');
    assert.equal(request.options.num_ctx, 8192);
    // A general question: a summary of the part only, read in seconds by a local model.
    assert.match(request.messages[0].content, /"summary_only":true/);
    assert.ok(request.messages[0].content.length < 6000, `system prompt of ${request.messages[0].content.length} characters`);
    assert.match(await page.textContent('#ai-status'), /chargement du modèle 2 s, lecture de 900 tokens 3 s, rédaction de 40 tokens 1 s/);
    assert.deepEqual(request.messages.slice(1).map((m) => m.role), ['user']);
    // A task clicked: its question asked. An origin refused by Ollama: the question fails with the page's own
    // origin in the explanation, and is not kept.
    allowed = false;
    await page.click('.ai-task[data-task="manufacturing_analysis"]');
    await page.waitForFunction(() => document.getElementById('ai-status').textContent === 'Erreur', null, { timeout: 30_000 });
    assert.match(await page.textContent('#ai-chat'), /Quels procédés et quelles opérations pour fabriquer cette pièce \?/);
    assert.match(await page.textContent('#ai-chat .ai-error'), new RegExp(`OLLAMA_ORIGINS contient ${base.replace(/\/$/, '').replace(/[.]/g, '\\.')}`));
    allowed = true;
    await page.fill('#ai-input', 'Et les noyaux ?');
    await page.press('#ai-input', 'Enter');
    await page.waitForFunction(() => /Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    assert.deepEqual(chats[1].messages.slice(1).map((m) => [m.role, m.role === 'user' ? m.content : '']), [['user', 'Résume la pièce.'], ['assistant', ''], ['user', 'Et les noyaux ?']]);
    // An analysis task: the detailed context, compacted to fit, with the same window.
    assert.match(chats[1].messages[0].content, /"compaction"/);
    assert.ok(chats[1].messages[0].content.length < 20_000, `system prompt of ${chats[1].messages[0].content.length} characters`);
    assert.equal(chats[1].options.num_ctx, 8192);
    // The model's reasoning, when asked for: one grey line under the answer while it is written, then folded.
    await page.check('#ai-think');
    await page.fill('#ai-input', 'Combien de noyaux ?');
    await page.press('#ai-input', 'Enter');
    await page.waitForSelector('#ai-chat .ai-thought:not([hidden])', { timeout: 30_000 });
    // Rewritten at every word: not read out by a screen reader (the folded reasoning is).
    assert.equal(await page.getAttribute('#ai-chat .ai-thought', 'aria-hidden'), 'true');
    assert.match(await page.textContent('#ai-chat .ai-thought'), /je vérifie les corps fermés\.$/);
    await page.waitForFunction(() => /Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    assert.equal(chats[2].think, true);
    assert.equal(await page.locator('#ai-chat .ai-thought').count(), 0);
    assert.match(await page.textContent('#ai-chat .ai-thought-details'), /Voir la réflexion\s*Le volume est donné par le contexte ; je vérifie les corps fermés\./);
    // The task "Chiffrage" (no costing workbook here): the costing trace, read only, in place of the
    // quote and the rates the model was asked for; the answer labelled, its numbers checked.
    await page.uncheck('#ai-think');
    await page.click('.ai-task[data-task="costing"]');
    await page.waitForSelector('#ai-chat .ai-check', { timeout: 30_000 });
    assert.match(chats[3].messages.at(-1).content, /^Explique le chiffrage de cette pièce/);
    const costing = chats[3].messages[0].content;
    assert.match(costing, /"costing_trace":null/);
    assert.doesNotMatch(costing, /costing_contract|costing_inputs|"quote"/);
    assert.match(costing, /Tâche « Chiffrage »/);
    assert.match(costing, /Ne cite que des nombres présents dans costing_trace/);
    assert.equal(await page.textContent('#ai-chat .ai-msg:last-child .ai-label'), "Raisonnement IA — rien n'est appliqué sans votre accord");
    // "7,257 cm³" is in no trace: the answer is not verified.
    assert.match(await page.textContent('#ai-chat .ai-msg:last-child .ai-check.bad'), /Réponse non vérifiée : un nombre absent de la trace du chiffrage \(7,257\)/);
    // A new conversation forgets it.
    await page.click('#ai-clear');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
    await new Promise((resolve) => ollama.close(resolve));
  });

  test('IA page: the body selected (else the bodies checked) is what the AI gets, said on the page; answers in Markdown laid out; no drop hint left over the model', { timeout: CAD_TIMEOUT }, async (t) => {
    const { default: gatewayHandler } = await import('../../api/ai.js');
    const completions = [];
    // An answer in Markdown, with a tag of its own that must stay text.
    const answer = '**Conclusion** : proposition à valider.\n\n| Élément | Valeur |\n|---|---|\n| Noyaux | 1 <b>gras</b> |\n\n- tiroir *proposé*';
    const groq = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        completions.push(JSON.parse(text));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }));
      });
    });
    const gateway = createServer((req, res) => {
      req.headers['x-forwarded-for'] = '198.51.100.3';
      return gatewayHandler(req, res);
    });
    await Promise.all([groq, gateway].map((x) => new Promise((resolve) => x.listen(0, '127.0.0.1', resolve))));
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(groq_api_key|ai_|openai_|reader3d_)/i.test(k)) delete process.env[k];
    Object.assign(process.env, { GROQ_API_KEY: 'gsk_made_up', AI_BASE_URL: `http://127.0.0.1:${groq.address().port}/openai/v1`, READER3D_ALLOWED_ORIGINS: base.replace(/\/$/, ''), READER3D_PUBLIC: '1' });
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      return Promise.all([groq, gateway].map((x) => new Promise((resolve) => {
        x.closeAllConnections();
        x.close(resolve);
      })));
    });
    const contextOf = (body) => JSON.parse(body.messages[1].content.replace(/^[\s\S]*?<<<DONNEES_3D_READER\n/, '').replace(/\nDONNEES_3D_READER>>>$/, ''));
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.click('.tab[data-page="ia"]');
    assert.equal(await page.textContent('#ai-scope'), 'Aucune pièce ouverte : questions générales seulement.');
    await page.selectOption('#ai-provider', 'openai');
    await page.fill('#ai-url', `http://127.0.0.1:${gateway.address().port}/api/ai`);
    await page.dispatchEvent('#ai-url', 'change');
    const ask = async (question = 'Combien de noyaux ?') => {
      await page.fill('#ai-input', question);
      await page.press('#ai-input', 'Enter');
      await page.waitForFunction(() => /^Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
      return contextOf(completions.at(-1));
    };
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    // The IA page shown while the part is analysed: told when it is done, without leaving the page.
    await page.click('.tab[data-page="ia"]');
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.textContent('#ai-status'), 'Modèle analysé : posez votre question');

    // The whole part: both bodies, said so.
    assert.equal(await page.textContent('#ai-scope'), "Envoyé à l'IA : toute la pièce « named_assembly.step » (2 corps).");
    let sent = await ask();
    assert.deepEqual([sent.bodies.length, sent.selection.mode, sent.selection.bodies_sent, sent.selection.bodies_in_file], [2, 'all', 2, 2]);
    // The answer laid out: bold, a table, a list; the tag of the answer kept as text.
    const reply = page.locator('#ai-chat .ai-assistant').last();
    assert.equal(await reply.locator('.ai-md strong').first().textContent(), 'Conclusion');
    assert.equal(await reply.locator('.ai-table td').nth(1).textContent(), '1 <b>gras</b>');
    assert.equal(await reply.locator('.ai-md b').count(), 0);
    assert.equal(await reply.locator('.ai-md li em').textContent(), 'proposé');
    assert.doesNotMatch(await reply.locator('.ai-text').textContent(), /\*\*|\|---/);

    // A body selected in the list: that body only, its name never sent.
    await page.click('.tab[data-page="viewer"]');
    const name = (await page.textContent('#bodies tr[data-index="1"] td.name')).trim();
    const other = (await page.textContent('#bodies tr[data-index="0"] td.name')).trim();
    await page.click('#bodies tr[data-index="1"] td.name');
    await page.click('.tab[data-page="ia"]');
    assert.match(await page.textContent('#ai-scope'), /^Envoyé à l'IA : le corps sélectionné « .+ » seulement \(1 sur 2\)\./);
    sent = await ask();
    assert.deepEqual([sent.bodies.length, sent.model.body_count, sent.selection.mode, sent.selection.bodies_sent], [1, 1, 'selected', 1]);
    assert.match(sent.selection.note, /Seul le corps sélectionné/);
    assert.ok(!JSON.stringify(completions.at(-1)).includes(name), 'the real name stays in the browser');
    // The other body, not sent, named in the question (then in the history): replaced all the same.
    await ask(`Et ${other} ?`);
    const online = JSON.stringify(completions.at(-1).messages);
    assert.ok(!online.includes(other) && online.includes('Et Corps 1 ?'), 'a body not sent, named in the question, stays in the browser');

    // Unselected, one body unchecked: the body checked only.
    await page.click('.tab[data-page="viewer"]');
    await page.click('#bodies tr[data-index="1"] td.name');
    await page.uncheck('#bodies tr[data-index="1"] input');
    await page.click('.tab[data-page="ia"]');
    assert.match(await page.textContent('#ai-scope'), /^Envoyé à l'IA : le corps coché « .+ » seulement \(1 sur 2\)\.$/);
    sent = await ask();
    assert.deepEqual([sent.bodies.length, sent.selection.mode], [1, 'checked']);
    // None checked: the part is not sent.
    await page.click('.tab[data-page="viewer"]');
    await page.uncheck('#bodies tr[data-index="0"] input');
    await page.click('.tab[data-page="ia"]');
    assert.equal(await page.textContent('#ai-scope'), "Aucun corps coché dans la liste : l'IA ne reçoit pas la pièce.");
    sent = await ask();
    assert.equal(sent.no_model_loaded, true);
    assert.match(sent.note, /aucun de ses corps n'est coché/);

    // A file dragged over the 3D view, then dropped on a data file row of the settings page (which keeps the drop):
    // the hint does not stay over the model; dragged over the costing page, it is not shown.
    await page.click('.tab[data-page="viewer"]');
    const drag = (selector, type, json) => page.evaluate(({ selector, type, json }) => {
      const data = new DataTransfer();
      if (json) data.items.add(new File([json], 'historique.json', { type: 'application/json' }));
      (selector ? document.querySelector(selector) : document.body).dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { selector, type, json });
    await drag(null, 'dragover');
    assert.equal(await page.isVisible('#drop-hint'), true);
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-drop="historique"]'); // the costing pages are loaded when first shown
    await drag('#page-parametres [data-drop="historique"]', 'dragover');
    await drag('#page-parametres [data-drop="historique"]', 'drop', JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: [] }));
    await page.click('.tab[data-page="viewer"]');
    assert.equal(await page.isVisible('#drop-hint'), false);
    await page.click('.tab[data-page="chiffrage"]');
    await drag('#page-chiffrage', 'dragover');
    await page.click('.tab[data-page="viewer"]');
    assert.equal(await page.isVisible('#drop-hint'), false);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('IA page through the gateway (api/ai.js, a stand-in for Groq): closed without an access code, configuration, access code, context to its budget, models, quota, errors', { timeout: CAD_TIMEOUT }, async (t) => {
    // The gateway itself in a node:http server; its provider a stand-in for Groq's chat completions.
    const { default: gatewayHandler } = await import('../../api/ai.js');
    const completions = [];
    let reply = () => ({ status: 200, body: { model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: 'Conclusion : une boîte fermée.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4200, completion_tokens: 800, total_tokens: 5000 } } });
    const groq = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        completions.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
        const { status, body, headers = {} } = reply();
        res.writeHead(status, { 'Content-Type': 'application/json', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': String(1000 - completions.length), 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '5000', ...headers });
        res.end(JSON.stringify(body));
      });
    });
    // Each test its own client address: the limit per address of the gateway (20 requests a minute) is not shared.
    const gateway = createServer((req, res) => {
      req.headers['x-forwarded-for'] = '198.51.100.1';
      return gatewayHandler(req, res);
    });
    await Promise.all([groq, gateway].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
    const saved = { ...process.env };
    // Only these settings (none of this machine's): the key named as it was created in Vercel; the page
    // served from another port, an origin to allow.
    for (const k of Object.keys(process.env)) if (/^(groq_api_key|ai_|openai_|reader3d_)/i.test(k)) delete process.env[k];
    Object.assign(process.env, {
      Groq_API_KEY: 'gsk_made_up',
      AI_BASE_URL: `http://127.0.0.1:${groq.address().port}/openai/v1`,
      READER3D_ALLOWED_ORIGINS: base.replace(/\/$/, ''),
      AI_CONTEXT_CHARS: '2500',
    });
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      return Promise.all([groq, gateway].map((s) => new Promise((resolve) => {
        s.closeAllConnections();
        s.close(resolve);
      })));
    });
    const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/api/ai`;
    const status = () => page.textContent('#ai-status');
    const waitStatus = (re) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById('ai-status').textContent), re.source, { timeout: 30_000 });
    const answered = () => page.waitForFunction(() => !document.getElementById('ai-send').disabled && !/Analyse/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    const ask = async (question) => {
      await page.fill('#ai-input', question);
      await page.press('#ai-input', 'Enter');
      await answered();
    };
    // A task clicked: its own question asked.
    const askTask = async (name) => {
      await page.click(`.ai-task[data-task="${name}"]`);
      await answered();
    };
    const contextOf = (completion) => completion.body.messages[1].content.replace(/^[\s\S]*?<<<DONNEES_3D_READER\n/, '').replace(/\nDONNEES_3D_READER>>>$/, '');

    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.click('.tab[data-page="ia"]');
    await page.selectOption('#ai-provider', 'openai');
    assert.equal(await page.textContent('#ai-provider option[value="openai"]'), 'En ligne via la passerelle (Groq…)');
    // Not on Vercel (GitHub Pages here): no address until it is pasted, the placeholder tells which.
    assert.equal(await page.inputValue('#ai-url'), '');
    assert.equal(await page.getAttribute('#ai-url', 'placeholder'), "Collez l'adresse Vercel : https://<projet>.vercel.app/api/ai");
    await ask('Bonjour');
    assert.match(await page.textContent('#ai-chat .ai-error'), /^Erreur\s*Renseignez l'adresse de la passerelle : collez son adresse Vercel/);
    await page.click('#ai-clear');

    // Only the key, as created first: the gateway closed until an access code is set, and says so.
    await page.fill('#ai-url', gatewayUrl);
    await page.click('#ai-test');
    await waitStatus(/^Passerelle inaccessible$/);
    assert.match(await page.textContent('#ai-chat .ai-error'), /Aucun code d'accès sur la passerelle : créez la variable READER3D_ACCESS_CODE dans Vercel/);
    await page.click('#ai-clear');

    // Opened on purpose (READER3D_PUBLIC=1). The connection test: provider, model, no access code; the model fixed by the gateway.
    process.env.READER3D_PUBLIC = '1';
    await page.click('#ai-test');
    await waitStatus(/^Passerelle connectée/);
    assert.equal(await status(), "Passerelle connectée : Groq · openai/gpt-oss-120b · sans code d'accès");
    assert.equal(await page.isVisible('#ai-code-field'), false);
    assert.equal(await page.getAttribute('#ai-model', 'placeholder'), 'openai/gpt-oss-120b (fixé par la passerelle)');
    assert.equal(await page.isDisabled('#ai-model'), true);

    // An access code on the gateway: the field shown, a question without it refused, the provider not asked.
    process.env.READER3D_ACCESS_CODE = 'made-up code';
    await page.click('#ai-test');
    await waitStatus(/code d'accès requis$/);
    assert.equal(await page.isVisible('#ai-code-field'), true);
    assert.equal(await page.getAttribute('#ai-code', 'type'), 'password');
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.ai.gatewayCodeRequired')), '1', 'its field shown at once next time');
    await ask('Quelles règles de dépouille en coquille gravité ?');
    assert.match(await page.textContent('#ai-chat .ai-error'), /Code d'accès requis : saisissez le code de la passerelle\./);
    assert.equal(completions.length, 0);
    await page.fill('#ai-code', 'wrong code');
    await page.click('#ai-test');
    await waitStatus(/^Code d'accès incorrect\.$/);
    await page.fill('#ai-code', 'made-up code');
    await page.click('#ai-test');
    await waitStatus(/code d'accès accepté$/);
    await page.click('#ai-clear');

    // A general question without a 3D model: the answer, then where it comes from and the questions left today.
    await ask('Quelles règles de dépouille en coquille gravité ?');
    assert.match(await page.textContent('#ai-chat .ai-assistant'), /Conclusion : une boîte fermée\./);
    assert.match(await status(), /^Réponse en \d+ s · Groq · openai\/gpt-oss-120b$/);
    // The questions left today: a framed badge beside the title, hidden for the local model. Estimated from the
    // tokens of a day of the free tier (200 000), less the request already made (5 000 tokens), at 5 000 a question.
    assert.equal(await page.textContent('#ai-quota'), "≈ 39 questions restantes aujourd'hui");
    assert.match(await page.getAttribute('#ai-quota', 'title'), /^Estimation d'après la dernière réponse \(\d\d:\d\d\) : 200\u202f000 tokens par jour de Groq ; une question en prend 5\u202f000 en moyenne \(1 réponse de ce navigateur\) ; 1 requête déjà faite aujourd'hui avec la clé de la passerelle, depuis tous les PC \(≈ 5\u202f000 tokens\) ; 999 requêtes restantes sur 1\u202f000\. Au plus 1 question par minute \(8\u202f000 tokens par minute\)\.$/);
    assert.ok(await page.isVisible('#ai-quota'));
    assert.equal(completions[0].url, '/openai/v1/chat/completions');
    assert.equal(completions[0].authorization, 'Bearer gsk_made_up');
    assert.equal(completions[0].body.model, 'openai/gpt-oss-120b');
    assert.equal(completions[0].body.reasoning_effort, 'low');
    assert.equal(completions[0].body.max_completion_tokens, 1200);
    assert.deepEqual(completions[0].body.messages.map((m) => m.role), ['system', 'user', 'user']);
    assert.match(contextOf(completions[0]), /"no_model_loaded":true/);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.ai.gatewayCode')), 'made-up code');

    // A part: the analysis tasks get its detail compacted to the gateway's budget, the general questions a summary.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    await askTask('feature_analysis');
    assert.match(completions[1].body.messages.at(-1).content, /^Liste les features de la pièce par type/);
    const detail = contextOf(completions[1]);
    const whole = await page.evaluate(() => JSON.stringify(window.reader3d.aiContext({ task: 'feature_analysis' })).length);
    assert.match(detail, /"compaction"/);
    assert.ok(detail.length <= 2500 && whole > 2500, `context of ${detail.length} characters, ${whole} whole`);
    // The conversation goes with it.
    assert.deepEqual(completions[1].body.messages.slice(2).map((m) => m.role), ['user', 'assistant', 'user']);
    // The general questions too get the detail (the gateway reads it in seconds), within its budget, with the bodies sent.
    await askTask('general');
    const general = contextOf(completions[2]);
    assert.doesNotMatch(general, /"summary_only"/);
    assert.ok(general.length <= 2500, `context of ${general.length} characters`);
    assert.match(general, /"selection":\{"mode":"all","bodies_sent":1,"bodies_in_file":1\}/);

    // The free quota reached: the message of the gateway as it is, the question not kept.
    t.mock.method(console, 'error', () => {}); // the gateway logs the provider's refusal
    reply = () => ({ status: 429, headers: { 'retry-after': '12' }, body: { error: { message: 'Rate limit reached for model openai/gpt-oss-120b', type: 'tokens' } } });
    const kept = await page.locator('#ai-chat .ai-msg').count();
    await ask('Et les noyaux ?');
    assert.equal(await status(), 'Erreur');
    assert.equal(await page.textContent('#ai-chat .ai-msg:last-child .ai-text'), 'Quota de Groq (offre gratuite) atteint. Réessayez dans 12 s.');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), kept + 2, 'the question and the error');
    // The conversation of the first tab of the 3D page, about its part.
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('reader3d.ai.messages')));
    assert.deepEqual([stored.file, stored.messages.length], ['box.stl', 6]);

    // Models the page may choose (AI_MODELS): offered in the field; another one typed is not asked for, and the page says so.
    process.env.AI_MODELS = 'openai/gpt-oss-20b';
    reply = (n) => ({ status: 200, body: { model: completions.at(-1).body.model, choices: [{ message: { role: 'assistant', content: 'Une boîte.' }, finish_reason: 'stop' }] } });
    await page.click('#ai-test');
    await waitStatus(/code d'accès accepté$/);
    assert.equal(await page.isDisabled('#ai-model'), false);
    assert.equal(await page.getAttribute('#ai-model', 'placeholder'), 'openai/gpt-oss-120b (par défaut)');
    assert.deepEqual(await page.$$eval('#ai-models option', (os) => os.map((o) => o.value)), ['openai/gpt-oss-20b']);
    const last = () => page.locator('#ai-chat .ai-msg').last();
    await page.fill('#ai-model', 'made-up-model');
    await ask('Et les faces ?');
    assert.equal(completions.at(-1).body.model, 'openai/gpt-oss-120b');
    assert.equal(await last().locator('.ai-notice').textContent(), 'Modèle « made-up-model » non proposé par la passerelle (variable AI_MODELS dans Vercel) : réponse de son modèle par défaut');
    await page.fill('#ai-model', 'openai/gpt-oss-20b');
    await ask('Et les arêtes ?');
    assert.equal(completions.at(-1).body.model, 'openai/gpt-oss-20b');
    assert.equal(await last().locator('.ai-notice').count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('IA page: one conversation per tab, names anonymised online in every task, the local model when the quota is reached and its answers kept offline, numbers checked, phone width', { timeout: CAD_TIMEOUT }, async (t) => {
    // The gateway (api/ai.js) and a stand-in for Groq, as above; a stand-in for Ollama.
    const { default: gatewayHandler } = await import('../../api/ai.js');
    const completions = [];
    const contextOf = (body) => JSON.parse(body.messages[1].content.replace(/^[\s\S]*?<<<DONNEES_3D_READER\n/, '').replace(/\nDONNEES_3D_READER>>>$/, ''));
    // The answer cites the volume of the part sent (in cm³) and a made-up thickness.
    const volumeOf = (context) => (context.model.metrics.volume_mm3 / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
    let reply = (body) => ({ status: 200, body: { model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: `Corps 1 : ${volumeOf(contextOf(body))} cm³, paroi de 99,9 mm ; Corps 2 à part.` }, finish_reason: 'stop' }] } });
    const groq = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        const body = JSON.parse(text);
        completions.push(body);
        const { status, body: answer, headers = {} } = reply(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'x-ratelimit-remaining-requests': String(1000 - completions.length), ...headers });
        res.end(JSON.stringify(answer));
      });
    });
    const gateway = createServer((req, res) => {
      req.headers['x-forwarded-for'] = '198.51.100.2';
      return gatewayHandler(req, res);
    });
    const chats = [];
    const ollama = createServer((req, res) => {
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
      }
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        chats.push(JSON.parse(text));
        res.setHeader('Content-Type', 'application/x-ndjson');
        // It was given the real names and amounts: it may quote them (a made-up rate).
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Réponse locale : une boîte, taux 42,5 €/h.' }, done: false })}\n`);
        res.end(`${JSON.stringify({ done: true })}\n`);
      });
    });
    await Promise.all([groq, gateway, ollama].map((x) => new Promise((resolve) => x.listen(0, '127.0.0.1', resolve))));
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(groq_api_key|ai_|openai_|reader3d_)/i.test(k)) delete process.env[k];
    Object.assign(process.env, { GROQ_API_KEY: 'gsk_made_up', AI_BASE_URL: `http://127.0.0.1:${groq.address().port}/openai/v1`, READER3D_ALLOWED_ORIGINS: base.replace(/\/$/, ''), READER3D_PUBLIC: '1' });
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      return Promise.all([groq, gateway, ollama].map((x) => new Promise((resolve) => {
        x.closeAllConnections();
        x.close(resolve);
      })));
    });
    t.mock.method(console, 'error', () => {}); // the gateway logs the refusals of the provider

    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    // A phone: every field and button of the IA page within 375 px, no horizontal scroll, for both providers.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.click('.tab[data-page="ia"]');
    for (const provider of ['openai', 'ollama']) {
      await page.selectOption('#ai-provider', provider);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll('#page-ia input, #page-ia select, #page-ia button, #page-ia textarea, #page-ia label')]
          .filter((el) => el.offsetParent).map((el) => [el.id || el.textContent.trim().slice(0, 30), Math.round(el.getBoundingClientRect().right)]).filter(([, right]) => right > 375),
      }));
      assert.deepEqual(overflow, { page: 375, controls: [] }, provider);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // The local model of this browser: the one of the fallback.
    await page.fill('#ai-url', `http://127.0.0.1:${ollama.address().port}`);
    await page.dispatchEvent('#ai-url', 'change');
    await page.selectOption('#ai-provider', 'openai');
    await page.fill('#ai-url', `http://127.0.0.1:${gateway.address().port}/api/ai`);
    assert.equal(await page.isChecked('#ai-anon'), true);
    assert.equal(await page.isChecked('#ai-fallback'), true);
    const answered = () => page.waitForFunction(() => !document.getElementById('ai-send').disabled && !/Analyse|Lecture|Rédaction/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
    const ask = async (question) => {
      await page.fill('#ai-input', question);
      await page.press('#ai-input', 'Enter');
      await answered();
      return page.locator('#ai-chat .ai-msg').last();
    };
    // A task clicked: its own question asked.
    const askTask = async (name) => {
      await page.click(`.ai-task[data-task="${name}"]`);
      await answered();
    };

    // Tab 1: a part of two named bodies. Online, the labels in place of its names, in the context and the question.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('named_assembly.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    await askTask('feature_analysis');
    let answer = await ask("Quel est le volume de l'Équerre ?");
    let sent = contextOf(completions[1]);
    assert.equal(sent.source.file, 'Pièce.step');
    assert.deepEqual(sent.bodies.map((b) => b.name), ['Corps 1', 'Corps 2']);
    for (const name of ['Équerre', 'named_assembly']) assert.ok(!JSON.stringify(completions.slice(0, 2).map((c) => c.messages)).includes(name), name);
    assert.equal(completions[1].messages.at(-1).content, "Quel est le volume de l'Corps 1 ?");
    // Under the answer: the real names of its labels; its made-up number counted, the volume of the part is not.
    assert.equal(await answer.locator('.ai-names').textContent(), 'Noms réels : Corps 1 = Équerre ; Corps 2 = Pin');
    assert.equal(await answer.locator('.ai-numbers').textContent(), '1 nombre ne vient pas des données envoyées');
    assert.equal(await answer.locator('.ai-numbers').getAttribute('title'), '99,9');
    // Unticked: the real names.
    await page.uncheck('#ai-anon');
    await ask('Et la Pin ?');
    assert.match(JSON.stringify(contextOf(completions[2])), /Équerre/);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.ai.anonymize')), '0');
    await page.check('#ai-anon');

    // The names of the quote of the tab (no costing workbook needed), in any task: the customer named in a general question.
    const quote = (over) => page.evaluate((q) => localStorage.setItem('reader3d.chiffrage.quote.v1', JSON.stringify(q)), { client: 'Fonderie Exemple', reference: 'REF-EX-1', ...over });
    await quote({});
    await askTask('general');
    await ask('Et pour Fonderie Exemple, avec la REF-EX-1 ?');
    assert.equal(completions.at(-1).messages.at(-1).content, 'Et pour Client, avec la Référence ?');
    // The customer changed since in the quote: its former name, in the conversation, still replaced.
    await quote({ client: 'Autre Client SA' });
    await ask('Et pour Autre Client SA ?');
    const online = JSON.stringify(completions.at(-1).messages);
    for (const name of ['Fonderie Exemple', 'Autre Client SA', 'REF-EX-1', 'Équerre', 'named_assembly']) assert.ok(!online.includes(name), name);
    assert.ok(online.includes('Et pour Client, avec la Référence ?'));
    assert.equal(completions.at(-1).messages.at(-1).content, 'Et pour Client ?');
    await page.evaluate(() => localStorage.removeItem('reader3d.chiffrage.quote.v1'));
    await askTask('feature_analysis');

    // Tab 2: its own conversation, empty; its question sent without the conversation of tab 1.
    await page.click('.doc-tab-new');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.tab.file === 'box.stl', null, { timeout: CAD_TIMEOUT });
    await ask('Résume la pièce.');
    assert.deepEqual(completions.at(-1).messages.map((m) => m.role), ['system', 'user', 'user']);
    assert.equal(contextOf(completions.at(-1)).source.file, 'Pièce.stl');
    // Back to tab 1: its conversation; to tab 2: its own.
    await page.click('.doc-tab:first-child');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 14);
    assert.match(await page.textContent('#ai-chat'), /Noms réels : Corps 1 = Équerre ; Corps 2 = Pin/);
    await page.click('.doc-tab:nth-child(2)');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 2);
    assert.match(await page.textContent('#ai-chat'), /Résume la pièce\./);

    // The free quota reached: the local model answers, with the real names, and says so.
    reply = () => ({ status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'Rate limit reached', type: 'requests' } } });
    answer = await ask('Et ses arêtes ?');
    assert.equal(await answer.locator('.ai-notice').textContent(), 'Quota en ligne atteint : réponse du modèle local (qwen3:8b)');
    assert.equal(await answer.locator('.ai-text').textContent(), 'Réponse locale : une boîte, taux 42,5 €/h.');
    assert.match(await page.textContent('#ai-status'), /^Réponse en \d+ s · repli local : Ollama · qwen3:8b$/);
    assert.match(chats[0].messages[0].content, /"file":"box\.stl"/);
    assert.deepEqual(chats[0].messages.slice(1).map((m) => [m.role, m.role === 'user' ? m.content : '']), [['user', 'Résume la pièce.'], ['assistant', ''], ['user', 'Et ses arêtes ?']]);
    // Without the fallback: the message of the gateway. Its request without the exchange the local model answered.
    await page.uncheck('#ai-fallback');
    answer = await ask('Et ses faces ?');
    assert.equal(await answer.locator('.ai-text').textContent(), 'Quota de Groq (offre gratuite) atteint. Réessayez dans 30 s.');
    assert.equal(chats.length, 1);
    assert.deepEqual(completions.at(-1).messages.slice(2).map((m) => [m.role, m.role === 'user' ? m.content : '']), [['user', 'Résume la pièce.'], ['assistant', ''], ['user', 'Et ses faces ?']]);
    assert.doesNotMatch(JSON.stringify(completions.at(-1).messages), /Réponse locale|42,5|Et ses arêtes/);
    await page.check('#ai-fallback');
    reply = (body) => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: `Volume ${volumeOf(contextOf(body))} cm³.` }, finish_reason: 'stop' }] } });

    // Closing tab 2 forgets its conversation; tab 1's is shown.
    assert.ok(await page.evaluate(() => sessionStorage.getItem('reader3d.ai.messages.2')));
    await page.click('.doc-tab:nth-child(2) .doc-tab-close');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('reader3d.ai.messages.2')), null);
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 14);
    // Another part opened in tab 1: not its conversation, but the one of that part kept in the history (tab 2's, closed).
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => window.reader3d.tab.file === 'box.stl' && document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForFunction(() => document.querySelectorAll('#ai-chat .ai-msg').length === 4, null, { timeout: 10_000 });
    assert.match(await page.textContent('#ai-chat'), /Résume la pièce\.[\s\S]*Réponse locale/);
    assert.doesNotMatch(await page.textContent('#ai-chat'), /Équerre/);
    answer = await ask('Quel volume ?');
    // Sent with it: its exchange with the gateway; not the one the local model answered, nor the other part's.
    assert.deepEqual(completions.at(-1).messages.map((m) => m.role), ['system', 'user', 'user', 'assistant', 'user']);
    assert.doesNotMatch(JSON.stringify(completions.at(-1).messages), /Réponse locale|Équerre|Fonderie|Et ses arêtes/);
    assert.equal(await answer.locator('.ai-numbers').count(), 0, 'every number of the answer comes from the context');
    // A new conversation about it: empty, sent alone; the one before stays in the history.
    await page.click('#ai-clear');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    await ask('Quelle masse ?');
    assert.deepEqual(completions.at(-1).messages.map((m) => m.role), ['system', 'user', 'user']);
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-local .ai-hist-item').length === 3, null, { timeout: 10_000 });
    assert.deepEqual(await page.$$eval('#ai-hist-list-local .ai-hist-item', (items) => items.map((li) => [li.querySelector('.ai-hist-part').textContent, li.classList.contains('current'), li.classList.contains('this-part')])),
      [['box', true, true], ['box', false, true], ['named_assembly', false, false]]);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('IA page: the conversation down to the bottom of the window; its history kept per part, on this PC and in a network folder; a conversation of it opened in a tab of its own', { timeout: CAD_TIMEOUT }, async (t) => {
    const { default: gatewayHandler } = await import('../../api/ai.js');
    const completions = [];
    const groq = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        completions.push(JSON.parse(text));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: `Réponse ${completions.length}.` }, finish_reason: 'stop' }] }));
      });
    });
    const gateway = createServer((req, res) => {
      req.headers['x-forwarded-for'] = '198.51.100.4';
      return gatewayHandler(req, res);
    });
    await Promise.all([groq, gateway].map((x) => new Promise((resolve) => x.listen(0, '127.0.0.1', resolve))));
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(groq_api_key|ai_|openai_|reader3d_)/i.test(k)) delete process.env[k];
    Object.assign(process.env, { GROQ_API_KEY: 'gsk_made_up', AI_BASE_URL: `http://127.0.0.1:${groq.address().port}/openai/v1`, READER3D_ALLOWED_ORIGINS: base.replace(/\/$/, ''), READER3D_PUBLIC: '1' });
    t.after(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      return Promise.all([groq, gateway].map((x) => new Promise((resolve) => {
        x.closeAllConnections();
        x.close(resolve);
      })));
    });
    const { page, errors } = await newPage('fr-FR');
    // The network folder: the private file system of the browser, in place of the folder one would choose.
    await page.addInitScript(() => {
      window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    });
    page.on('dialog', (dialog) => dialog.accept());
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.click('.tab[data-page="ia"]');
    await page.selectOption('#ai-provider', 'openai');
    await page.fill('#ai-url', `http://127.0.0.1:${gateway.address().port}/api/ai`);
    await page.dispatchEvent('#ai-url', 'change');
    const ask = async (question) => {
      const n = completions.length;
      await page.fill('#ai-input', question);
      await page.press('#ai-input', 'Enter');
      await page.waitForFunction(() => /^Réponse en/.test(document.getElementById('ai-status').textContent), null, { timeout: 30_000 });
      assert.equal(completions.length, n + 1);
    };
    const items = (list) => page.$$eval(`#ai-hist-list-${list} .ai-hist-item`, (els) => els.map((li) => [li.querySelector('.ai-hist-part').textContent, /\d+ messages?/.exec(li.querySelector('.ai-hist-meta').textContent)[0], li.querySelector('.ai-hist-q').textContent]));
    // Its .json files (Chrome writes each through a .crswap file of its own, there for a moment), read once written.
    const folderFiles = () => page.evaluate(async () => {
      for (let i = 0; ; i++) {
        try {
          const out = {};
          const dir = await navigator.storage.getDirectory();
          for await (const entry of dir.values()) if (entry.name.endsWith('.json')) out[entry.name] = JSON.parse(await (await (await dir.getFileHandle(entry.name)).getFile()).text());
          return out;
        } catch (err) {
          if (i > 20) throw err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    });

    // As a chat: the question field at the bottom of the window, the page itself not scrolled; the history on the right.
    const box = await page.evaluate(() => ({ form: document.getElementById('ai-form').getBoundingClientRect().bottom, side: document.querySelector('.ai-history').getBoundingClientRect(), height: innerHeight, scroll: document.documentElement.scrollHeight }));
    assert.ok(box.height - box.form < 60 && box.scroll <= box.height, JSON.stringify(box));
    assert.ok(box.side.left > 1000 && box.height - box.side.bottom < 40, JSON.stringify(box.side));
    assert.equal(await page.getAttribute('#ai-hist-tab-local', 'aria-selected'), 'true');
    assert.equal(await page.textContent('#ai-hist-list-local'), 'Aucune discussion gardée sur ce PC.');

    // A part, a question: its conversation kept on this PC, under its name.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.tab.part, null, { timeout: CAD_TIMEOUT });
    const part = await page.evaluate(() => window.reader3d.tab.part);
    assert.match(part.id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(part.file, 'box.stl');
    await page.click('.tab[data-page="ia"]');
    await ask('Quel volume ?');
    await page.waitForFunction(() => document.querySelector('#ai-hist-list-local .ai-hist-item.current.this-part'), null, { timeout: 10_000 });
    assert.deepEqual(await items('local'), [['box', '2 messages', '« Quel volume ? »']]);

    // The network folder chosen: the conversation written there, one file per part named by its file and its hash.
    await page.click('#ai-hist-tab-reseau');
    await page.waitForFunction(() => /Aucun dossier réseau choisi/.test(document.getElementById('ai-hist-folder').textContent), null, { timeout: 10_000 });
    await page.click('[data-hist-action="choose"]');
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-reseau .ai-hist-item').length === 1, null, { timeout: 10_000 });
    let files = await folderFiles();
    // One file per conversation: the part's name, its hash, the conversation's id.
    const conversationId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('reader3d.ai.messages')).id);
    const name = `box__${part.id.slice(7, 23)}__${conversationId}.json`;
    assert.deepEqual(Object.keys(files), [name]);
    assert.equal(files[name].schema, 'reader3d-historique-ia');
    assert.deepEqual(files[name].part, part);
    // The next answer written there too, merged in the same conversation.
    await ask('Et sa masse ?');
    // Its file as written: the four messages, and still them a moment later (a file that went back to two
    // would be a write lost; Chromium's own file system may give a read of before for a moment).
    const written = (file) => page.waitForFunction(async (f) => {
      try {
        const dir = await navigator.storage.getDirectory();
        const messages = JSON.parse(await (await (await dir.getFileHandle(f)).getFile()).text()).conversations[0].messages;
        return JSON.stringify(messages.map((m) => [m.role, m.role === 'user' ? m.content : m.provider])) === JSON.stringify([['user', 'Quel volume ?'], ['assistant', 'Groq'], ['user', 'Et sa masse ?'], ['assistant', 'Groq']]);
      } catch {
        return false; // being written
      }
    }, file, { timeout: 10_000 });
    await written(name);
    await page.waitForTimeout(300);
    await written(name);
    assert.equal(await page.getAttribute('#ai-hist-tab-reseau', 'aria-selected'), 'true');

    // The tab closed, the same file opened again: its conversation back.
    await page.click('.doc-tab:first-child .doc-tab-close');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    await page.waitForFunction(() => document.querySelectorAll('#ai-chat .ai-msg').length === 4, null, { timeout: 10_000 });
    assert.match(await page.textContent('#ai-chat'), /Quel volume \?[\s\S]*Et sa masse \?/);

    // The same part under another name (renamed, downloaded again): its conversation goes on, kept and sent.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', { name: 'box (1).stl', mimeType: 'application/octet-stream', buffer: readFileSync(fixturePath('box.stl')) });
    await page.waitForFunction(() => window.reader3d.tab.file === 'box (1).stl' && document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 4);
    await ask('Et sa surface ?');
    assert.deepEqual(completions.at(-1).messages.slice(2).map((m) => m.content), ['Quel volume ?', 'Réponse 1.', 'Et sa masse ?', 'Réponse 2.', 'Et sa surface ?']);
    await page.waitForFunction(() => /6 messages/.test(document.querySelector('#ai-hist-list-reseau .ai-hist-item .ai-hist-meta')?.textContent), null, { timeout: 10_000 });
    // The same part opened in a second tab: a conversation of its own there, not the same one twice.
    await page.click('.doc-tab-new');
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => window.reader3d.tab.id === 2 && document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.click('.tab[data-page="ia"]');
    await page.waitForTimeout(500); // the history read for the part
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 0);
    await page.click('.doc-tab:nth-child(2) .doc-tab-close');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 6);

    // A new conversation; the one before, clicked in the history: a tab of its own, its model not open.
    await page.click('#ai-clear');
    await ask('Une autre question ?');
    await page.click('#ai-hist-tab-local');
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-local .ai-hist-item').length === 2, null, { timeout: 10_000 });
    // Under the name the part was last opened under.
    assert.deepEqual(await items('local'), [['box (1)', '2 messages', '« Une autre question ? »'], ['box (1)', '6 messages', '« Quel volume ? »']]);
    assert.equal(await page.getAttribute('#ai-hist-list-local .ai-hist-item:nth-child(1) .ai-hist-open', 'aria-current'), 'true');
    await page.click('#ai-hist-list-local .ai-hist-item:nth-child(2) .ai-hist-open');
    await page.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 2 && window.reader3d.tab.id !== 1, null, { timeout: 10_000 });
    const archiveTab = await page.evaluate(() => window.reader3d.tab.id);
    assert.equal(await page.isVisible('#page-ia'), true);
    assert.equal(await page.textContent('.doc-tab.active .doc-tab-name'), 'box (1)');
    assert.equal(await page.getAttribute('.doc-tab.active', 'class'), 'doc-tab active chat-only');
    assert.match(await page.getAttribute('.doc-tab.active', 'title'), /^box \(1\)\.stl : discussion de l'historique, modèle non ouvert/);
    assert.equal(await page.evaluate(() => [window.reader3d.status, window.reader3d.result]).then(([s, r]) => `${s} ${r}`), 'idle null');
    assert.equal(await page.locator('#ai-chat .ai-msg').count(), 6);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ai-input');
    assert.equal(await page.textContent('#ai-scope'), 'Aucune pièce ouverte : questions générales seulement.');
    // Clicked again: the tab that shows it, not another one.
    await page.click('.doc-tab:first-child');
    await page.click('#ai-hist-list-local .ai-hist-item:nth-child(2) .ai-hist-open');
    await page.waitForFunction((id) => window.reader3d.tab.id === id, archiveTab, { timeout: 10_000 });
    assert.equal(await page.locator('.doc-tab').count(), 2);

    // After a reload: the history of this PC and the folder still there (this folder: its access kept).
    await page.reload();
    await page.click('.tab[data-page="ia"]');
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-local .ai-hist-item').length === 2, null, { timeout: 10_000 });
    await page.click('#ai-hist-tab-reseau');
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-reseau .ai-hist-item').length === 2, null, { timeout: 10_000 });
    assert.match(await page.textContent('#ai-hist-folder'), /les discussions des pièces y sont écrites/);
    // Deleted from this PC: the folder keeps its copy.
    await page.click('#ai-hist-tab-local');
    await page.click('#ai-hist-list-local .ai-hist-item:nth-child(1) .ai-hist-del');
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-local .ai-hist-item').length === 1, null, { timeout: 10_000 });
    assert.equal(Object.values(await folderFiles()).flatMap((f) => f.conversations).length, 2);
    // From an empty tab (a new conversation, no part): the conversation opened there, no empty tab left behind.
    await page.click('#ai-clear');
    await page.click('#ai-hist-list-local .ai-hist-item:nth-child(1) .ai-hist-open');
    await page.waitForFunction(() => document.querySelectorAll('#ai-chat .ai-msg').length === 6, null, { timeout: 10_000 });
    assert.equal(await page.locator('.doc-tab').count(), 1);
    assert.equal(await page.getAttribute('.doc-tab.active', 'class'), 'doc-tab active chat-only');

    // A phone: one column, the history under the conversation, nothing wider than the screen.
    await page.setViewportSize({ width: 375, height: 800 });
    const narrow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, chat: document.querySelector('.ai-convo').getBoundingClientRect().bottom, side: document.querySelector('.ai-history').getBoundingClientRect().top }));
    assert.ok(narrow.width === 375 && narrow.side > narrow.chat, JSON.stringify(narrow));
    assert.deepEqual(errors, []);
    await page.context().close();
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
    await page.waitForFunction(() => JSON.parse(document.getElementById('reader3d-semantic-result').textContent)?.source.file === 'box.stl');
    // An empty tab: the drop hint, no results.
    await page.click('.doc-tab-new');
    assert.equal(await page.locator('.doc-tab').count(), 3);
    assert.equal(await page.isVisible('#drop-hint'), true);
    assert.equal(await page.isVisible('#summary-card'), false);
    assert.equal(await page.evaluate(() => window.reader3d.result), null);
    assert.equal(await page.textContent('#reader3d-semantic-result'), 'null');
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

  test('a model dropped on the IA page is analysed in the 3D view', { timeout: CAD_TIMEOUT }, async () => {
    const { page, errors } = await newPage('fr-FR');
    await page.goto(base);
    await page.click('.tab[data-page="ia"]');
    const stl = readFileSync(fixturePath('box.stl')).toString('base64');
    await page.evaluate((b64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'box.stl'));
      document.getElementById('page-ia').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, stl);
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.isVisible('#page-viewer'), true);
    assert.equal((await page.evaluate(() => window.reader3d.result)).file, 'box.stl');
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
    // The semantic contract, written once the page is idle: the topology of the
    // meshes, and the bodies by their index in the file.
    await page.waitForFunction(() => document.getElementById('reader3d-semantic-result').textContent !== 'null');
    const semantic = JSON.parse(await page.textContent('#reader3d-semantic-result'));
    assert.deepEqual(semantic.bodies.map((b) => [b.id, b.name, b.topology?.watertight]), [['body-0', 'Équerre', true], ['body-1', 'Pin', true]]);
    assert.ok(semantic.bodies.every((b) => b.features.some((f) => f.type === 'closed_solid')));
    const checked = await page.evaluate(() => (window.reader3d.setSelection([1]), window.reader3d.semantic.bodies.map((b) => [b.id, b.source_index, b.name])));
    assert.deepEqual(checked, [['body-1', 1, 'Pin']]);
    // A listener of "reader3d-part" gets the contract of the new selection.
    const seen = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener('reader3d-part', () => resolve(window.reader3d.semantic.bodies.map((b) => b.id)), { once: true });
      window.reader3d.setSelection([0]);
    }));
    assert.deepEqual(seen, ['body-0']);
    // Another thickness method: its statistics, the contract built again.
    const rebuilt = await page.evaluate(() => {
      const before = window.reader3d.semantic;
      const method = document.getElementById('thick-method');
      method.value = 'wall';
      method.dispatchEvent(new Event('change'));
      return window.reader3d.semantic !== before && window.reader3d.result.thickness.method === 'wall';
    });
    assert.equal(rebuilt, true);

    const viaApi = await page.evaluate(async () => (await window.reader3d.analyze('e2e-samples/box.stl')).summary.volume);
    approx(viaApi, expected['box.stl'].summary.volume, 1e-9, 0, 'reader3d.analyze');

    await page.goto(`${base}?url=e2e-samples/missing.step`);
    await page.waitForFunction(() => document.body.dataset.status === 'error', null, { timeout: 30_000 });
    assert.match(await page.evaluate(() => document.body.dataset.error), /missing\.step/);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
