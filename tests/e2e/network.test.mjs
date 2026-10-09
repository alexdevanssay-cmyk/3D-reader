// End-to-end test of the shared folder of the company network (dist/), with
// the private file system of the browser (OPFS) in place of the folder one
// would choose: chosen in Paramètres; a part analysed written in its
// subfolder "analyses-3d", with its wall thickness, and opened from there
// without being analysed once this browser's own results are gone (another
// PC); a real cycle time saved in the costing written in "retours-experience",
// and the files of other PCs merged into the history (the newer record only);
// the conversations of a folder chosen in the IA page before, moved into
// "historique-ia". With a made-up workbook (tests/js/costing-fixture.mjs).
//
//   npm run build && node --test tests/e2e/network.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, fixturePath } from '../js/helpers.mjs';
import { costingWorkbook } from '../js/costing-fixture.mjs';

const DIST = join(ROOT, 'dist');
const TIMEOUT = 180_000;

describe('shared network folder (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;
  let dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reseau-'));
    writeFileSync(join(dir, 'chiffrage.xlsm'), costingWorkbook());
    server = createStaticServer(DIST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  /** A page whose folder picker gives the private file system of the browser; the messages posted to the workers recorded (window.__posted). */
  async function newPage() {
    const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.addInitScript(() => {
      window.showDirectoryPicker = async () => navigator.storage.getDirectory();
      // A browser restarted (the flag "test.prompt"): the access to the folder to grant again, by a click.
      const query = FileSystemHandle.prototype.queryPermission;
      FileSystemHandle.prototype.queryPermission = function (options) {
        return localStorage.getItem('test.prompt') ? Promise.resolve('prompt') : query.call(this, options);
      };
      FileSystemHandle.prototype.requestPermission = async () => {
        localStorage.removeItem('test.prompt');
        return 'granted';
      };
      window.__posted = [];
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        window.__posted.push(message?.type ?? null);
        return post.call(this, message, ...rest);
      };
    });
    return { context, page, errors };
  }

  /** The files of a subfolder of the shared folder: {name: size}; Chrome's .crswap of a write in progress left out. */
  const folderFiles = (page, sub) => page.evaluate(async (name) => {
    const out = {};
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name).catch(() => null);
    if (dir) for await (const entry of dir.values()) if (!entry.name.endsWith('.crswap')) out[entry.name] = await entry.getFile().then((f) => f.size, () => -1);
    return out;
  }, sub);

  /** Wait until `fn(arg)` (async, in the page) is true: page.waitForFunction takes the promise of an async function for a true value. */
  async function until(page, fn, arg, timeout = 30_000) {
    for (const end = Date.now() + timeout; !(await page.evaluate(fn, arg)); ) {
      if (Date.now() > end) throw new Error(`still false after ${timeout} ms: ${fn}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Wait until the subfolder `sub` holds `n` files ending with `suffix`, each one written (not empty), no write in progress. */
  const filesWritten = (page, sub, suffix, n) => until(page, async ([name, end, count]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name).catch(() => null);
    if (!dir) return false;
    let done = 0;
    for await (const entry of dir.values()) {
      if (entry.name.endsWith('.crswap')) return false;
      if (entry.name.endsWith(end) && (await entry.getFile().then((f) => f.size, () => 0)) > 0) done++;
    }
    return done === count;
  }, [sub, suffix, n]);

  /** Choose the shared folder in Paramètres: accessible. */
  async function chooseFolder(page) {
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres #cnetwork [data-action="network-choose"]');
    assert.match(await page.textContent('#cnetwork .crow'), /Dossier réseau partagé :\s*aucun/);
    await page.click('#cnetwork [data-action="network-choose"]');
    await page.waitForFunction(() => /— accessible/.test(document.querySelector('#cnetwork .crow')?.textContent));
  }

  test('a part analysed written in analyses-3d with its thickness, opened from there on a PC without it, without being analysed', { timeout: TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(`${base}?lang=fr`);
    await chooseFolder(page);
    const row = await page.textContent('#cnetwork');
    assert.match(row, /analyses-3d[\s\S]*retours-experience[\s\S]*historique-ia/);
    assert.match(row, /rien n'est envoyé sur Internet/);
    assert.deepEqual(await page.$$eval('#cnetwork button', (bs) => bs.map((b) => b.textContent)), ['Actualiser', 'Changer de dossier…', 'Ne plus utiliser']);

    // Analysed here: written in the folder, then its thickness once computed.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    assert.doesNotMatch(await page.textContent('#method'), /mémorisés|réseau/);
    assert.ok((await page.evaluate(() => window.__posted)).includes('analyze'), 'analysed on this PC');
    const volume = await page.textContent('#total-volume');
    await page.evaluate(() => window.reader3d.computeThickness());
    const min = await page.textContent('#thick-min');
    const key = await page.evaluate(() => window.reader3d.tab.part.id.slice(7));
    await filesWritten(page, 'analyses-3d', '.r3d.gz', 2);
    const names = Object.keys(await folderFiles(page, 'analyses-3d')).sort();
    assert.match(names[0], new RegExp(`^${key}__[0-9a-f]{8}\\.r3d\\.gz$`));
    assert.match(names[1], new RegExp(`^${key}__[0-9a-f]{8}__epaisseur-[0-9a-f]{16}\\.r3d\\.gz$`));
    // gzip of the container: its magic, its header (the key, the part), then the bytes of its arrays.
    const header = await page.evaluate(async (name) => {
      const file = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('analyses-3d')).getFileHandle(name)).getFile();
      const bytes = new Uint8Array(await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const length = new DataView(bytes.buffer).getUint32(8, true);
      return { magic: new TextDecoder().decode(bytes.subarray(0, 8)), header: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) };
    }, names[0]);
    assert.equal(header.magic, 'R3DCACHE');
    assert.deepEqual([header.header.format, header.header.version, header.header.part, header.header.key.sha256], ['reader3d-resultats', 1, 'analyse', key]);
    assert.ok(header.header.arrays.some((a) => a.type === 'Float32Array') && header.header.arrays.some((a) => a.type === 'Uint32Array'));

    // Another PC: this browser's results gone, the shared folder still chosen. Opened from the folder, nothing analysed, thickness included.
    await page.evaluate(async () => (await import(new URL('engine/client.js', location.href).href)).clearCache());
    await page.reload();
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    assert.match(await page.textContent('#method'), /Analyse lue dans le dossier réseau partagé \(« Actualiser » la recalcule\)/);
    assert.equal(await page.textContent('#total-volume'), volume);
    assert.equal(await page.isVisible('#thick-body'), true);
    assert.equal(await page.textContent('#thick-min'), min);
    const posted = await page.evaluate(() => window.__posted);
    assert.deepEqual(posted.filter((type) => ['analyze', 'mesh', 'prepare', 'range'].includes(type)), [], `nothing analysed: ${posted}`);

    // Kept in this browser now: opened again, from it.
    await page.waitForTimeout(500);
    await page.reload();
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    assert.match(await page.textContent('#method'), /Résultats mémorisés/);
    assert.equal(await page.textContent('#thick-min'), min);

    // A damaged file in the folder, on a PC without the results: analysed again here, and the file written again.
    await page.evaluate(async (name) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('analyses-3d');
      const writable = await (await dir.getFileHandle(name)).createWritable();
      await writable.write(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]));
      await writable.close();
    }, names[0]);
    await page.evaluate(async () => (await import(new URL('engine/client.js', location.href).href)).clearCache());
    await page.reload();
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    assert.match(await page.textContent('#method'), /Dossier réseau partagé non lu \(.+\) : analyse faite sur ce poste/);
    assert.equal(await page.textContent('#total-volume'), volume);
    assert.ok((await page.evaluate(() => window.__posted)).includes('analyze'));
    await until(page, async (name) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('analyses-3d');
      return (await (await dir.getFileHandle(name)).getFile().then((f) => f.size, () => 0)) > 100;
    }, names[0]);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('retours d\'expérience: a real time saved written in retours-experience; those of other PCs merged, the newer only; a phone\'s width', { timeout: TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(`${base}?lang=fr`);
    await chooseFolder(page);
    const text = (selector) => page.textContent(selector).then((t) => t.replace(/[\u202f\u00a0]/g, ' '));
    const waitText = (re, selector) => page.waitForFunction(([source, s]) => new RegExp(source).test(document.querySelector(s)?.textContent.replace(/[\u202f\u00a0]/g, ' ')), [re.source, selector]);

    // A part typed in, cast on CG3, its real time saved.
    await page.click('.tab[data-page="chiffrage"]');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    const typeIn = async (bind, value) => {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    };
    for (const [bind, value] of [['p.poids', 1.2], ['p.toileMini', 5], ['p.epaisseurMax', 10], ['p.moduleMm', 3], ['p.dimMax', 250]]) await typeIn(bind, value);
    await page.waitForSelector('#page-chiffrage .ctable tr.retained');
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await waitText(/Îlot retenu : CG3/, '#cfeedback');
    await typeIn('q.reference', 'REF-RESEAU');
    await typeIn('p.cycleReel', 250);
    await page.waitForSelector('#cfeedback [data-action="save-feedback"]:not([disabled])');
    await page.click('#cfeedback [data-action="save-feedback"]');
    await waitText(/Retour « REF-RESEAU » écrit aussi dans le dossier réseau partagé \(retours-experience\/REF-RESEAU__CG3__\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d__[0-9a-f]{8}\.json\)/, '#cfeedback-net');
    const files = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('retours-experience');
      const out = {};
      for await (const entry of dir.values()) if (entry.name.endsWith('.json')) out[entry.name] = JSON.parse(await (await entry.getFile()).text());
      return out;
    });
    const [[name, file]] = Object.entries(files);
    assert.match(name, /^REF-RESEAU__CG3__/);
    assert.deepEqual([file.schema, file.version, file.pieces.length], ['reader3d-historique-cycles', 1, 1]);
    const mine = file.pieces[0];
    assert.deepEqual([mine.ref, mine.source, mine.ilot, mine.temps_cycle_s, mine.poids_kg], ['REF-RESEAU', 'production', 'CG3', 250, 1.2]);

    // Files of other PCs: a part of their own, a newer time of this part, an older one; a file being written (not JSON yet).
    const later = new Date(Date.parse(mine.date) + 3600e3).toISOString();
    const earlier = new Date(Date.parse(mine.date) - 3600e3).toISOString();
    const record = (over) => ({ ...mine, fichier_3d: null, estimation_ia: undefined, ...over });
    await page.evaluate(async (dropped) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('retours-experience');
      for (const [n, content] of Object.entries(dropped)) {
        const writable = await (await dir.getFileHandle(n, { create: true })).createWritable();
        await writable.write(content);
        await writable.close();
      }
    }, {
      'AUTRE-PC__CG3__2026-01-01T00-00-00__aaaaaaaa.json': JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: [record({ ref: 'AUTRE-PC', temps_cycle_s: 300, poids_kg: 2.5 })] }),
      'REF-RESEAU__CG3__plus-recent__bbbbbbbb.json': JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: [record({ temps_cycle_s: 260, date: later })] }),
      'REF-RESEAU__CG3__plus-ancien__cccccccc.json': JSON.stringify({ schema: 'reader3d-historique-cycles', version: 1, pieces: [record({ temps_cycle_s: 999, date: earlier })] }),
      'EN-COURS__CG3__x__dddddddd.json': '{"schema": "reader3d-histo',
    });

    // Paramètres shown: the folder read, its records merged; this PC's own record not twice.
    await page.click('.tab[data-page="parametres"]');
    await waitText(/1 temps mesuré ajouté à l'historique, 1 mis à jour depuis l'ouverture de la page ; fichier illisible : EN-COURS__CG3__x__dddddddd\.json/, '#cnetwork');
    await waitText(/Historique des temps de cycle :\s*2 enregistrements : 0 temps de devis, 2 temps mesurés en production/, '#chisto-file');
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.chiffrage.historique.v1')).pieces);
    assert.deepEqual(kept.map((r) => [r.ref, r.temps_cycle_s]).sort(), [['AUTRE-PC', 300], ['REF-RESEAU', 260]]);
    // Read again ("Actualiser"): nothing new.
    await page.click('#cnetwork [data-action="network-refresh"]');
    await waitText(/1 temps mesuré ajouté à l'historique, 1 mis à jour depuis l'ouverture de la page/, '#cnetwork');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.chiffrage.historique.v1')).pieces)).length, 2);
    // The card of Chiffrage says it too, with the history counted.
    await page.click('.tab[data-page="chiffrage"]');
    await waitText(/Retours d'expérience du dossier réseau partagé, lu à \d\d:\d\d : 1 temps mesuré ajouté/, '#chistorique');
    assert.match(await text('#chistorique'), /Historique :\s*2 enregistrements : 0 temps de devis, 2 temps mesurés en production/);

    // A phone: the row of the folder within 375 px.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#cnetwork [data-action="network-refresh"]');
    const overflow = await page.evaluate(() => [document.getElementById('cnetwork'), ...document.querySelectorAll('#cnetwork button, #cnetwork p, #cnetwork strong')]
      .map((x) => [x.textContent.trim().slice(0, 30), Math.round(x.getBoundingClientRect().right)]).filter(([, right]) => right > 375));
    assert.deepEqual(overflow, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);

    // No longer used: said, the files stay.
    await page.click('#cnetwork [data-action="network-forget"]');
    await page.waitForFunction(() => /Dossier réseau partagé :\s*aucun/.test(document.querySelector('#cnetwork .crow')?.textContent));
    assert.equal(Object.keys(await folderFiles(page, 'retours-experience')).length, 5);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the browser restarted: the access to grant said; a real time saved meanwhile waits, written once the access is granted', { timeout: TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(`${base}?lang=fr`);
    await chooseFolder(page);
    await page.evaluate(() => localStorage.setItem('test.prompt', '1'));
    await page.reload();
    await page.click('.tab[data-page="parametres"]');
    await page.waitForFunction(() => /« *» — accès à autoriser/.test(document.querySelector('#cnetwork .crow')?.textContent));
    assert.deepEqual(await page.$$eval('#cnetwork button', (bs) => bs.map((b) => b.textContent)), ["Autoriser l'accès", 'Changer de dossier…', 'Ne plus utiliser']);

    // A part analysed: said not shared.
    await page.click('.tab[data-page="viewer"]');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    assert.match(await page.textContent('#method'), /Dossier réseau partagé : accès à autoriser \(page Paramètres\), l'analyse n'y est pas partagée\./);

    // A real time saved: kept here, waiting for the folder.
    await page.click('.tab[data-page="chiffrage"]');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    const typeIn = async (bind, value) => {
      await page.fill(`#page-chiffrage [data-bind="${bind}"]`, String(value));
      await page.dispatchEvent(`#page-chiffrage [data-bind="${bind}"]`, 'change');
    };
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await page.waitForSelector('#cfeedback');
    await typeIn('q.reference', 'REF-ATTENTE');
    await typeIn('p.cycleReel', 120);
    await page.waitForSelector('#cfeedback [data-action="save-feedback"]:not([disabled])');
    await page.click('#cfeedback [data-action="save-feedback"]');
    await page.waitForFunction(() => /Retour « REF-ATTENTE » pas encore écrit dans le dossier réseau partagé \(accès au dossier à autoriser\) : il le sera à la prochaine lecture du dossier/.test(document.getElementById('cfeedback-net')?.textContent));
    assert.deepEqual(await folderFiles(page, 'retours-experience'), {});

    // The access granted in Paramètres: written, said.
    await page.click('.tab[data-page="parametres"]');
    await page.waitForFunction(() => /1 retour d'expérience de ce poste à écrire dans le dossier réseau partagé dès que son accès est autorisé/.test(document.getElementById('cnetwork')?.textContent));
    await page.click('#cnetwork [data-action="network-grant"]');
    await page.waitForFunction(() => /— accessible/.test(document.querySelector('#cnetwork .crow')?.textContent) && /1 retour de ce poste écrit/.test(document.getElementById('cnetwork').textContent));
    const files = Object.keys(await folderFiles(page, 'retours-experience'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^REF-ATTENTE__CG3__/);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.reseau.retours-a-ecrire.v1')), null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('IA page: the conversations of a folder chosen there before moved into historique-ia when the shared folder is chosen', { timeout: TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await page.goto(`${base}?lang=fr`);
    // A folder chosen in the IA page by a version before: "ancien", with a conversation about a part.
    const part = { id: `sha256:${'ab'.repeat(32)}`, file: 'Carter.step' };
    await page.evaluate(async (p) => {
      const history = await import(new URL('ai-history.js', location.href).href);
      await history.listLocal(); // its database created
      const old = await (await navigator.storage.getDirectory()).getDirectoryHandle('ancien', { create: true });
      const conversation = history.normalizeConversation({ id: 'c-ancien', part: p, file: p.file, messages: [{ id: 'm1', role: 'user', content: 'Quel volume ?', date: '2026-01-01T00:00:00.000Z' }] });
      await history.writePartFile(old, conversation);
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('reader3d-ai');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(old, 'network');
        tx.oncomplete = resolve;
      });
      db.close();
    }, part);
    await page.click('.tab[data-page="ia"]');
    await page.click('#ai-hist-tab-reseau');
    await page.waitForFunction(() => /Dossier « ancien » : les discussions des pièces y sont écrites/.test(document.getElementById('ai-hist-folder').textContent), null, { timeout: 10_000 });

    // The shared folder chosen in Paramètres: the conversation copied into its historique-ia, the folder of before forgotten.
    await chooseFolder(page);
    await filesWritten(page, 'historique-ia', '.json', 1);
    assert.deepEqual(Object.keys(await folderFiles(page, 'historique-ia')), [`Carter__${'ab'.repeat(8)}__c-ancien.json`]);
    await page.click('.tab[data-page="ia"]');
    // (The private file system of the browser has no name.)
    await page.waitForFunction(() => /Dossier réseau partagé « *», sous-dossier « historique-ia » : les discussions des pièces y sont écrites/.test(document.getElementById('ai-hist-folder').textContent), null, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll('#ai-hist-list-reseau .ai-hist-item').length === 1, null, { timeout: 10_000 });
    assert.match(await page.textContent('#ai-hist-list-reseau'), /Carter[\s\S]*Quel volume \?/);
    assert.doesNotMatch(await page.textContent('#ai-hist-folder'), /à recopier/);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
