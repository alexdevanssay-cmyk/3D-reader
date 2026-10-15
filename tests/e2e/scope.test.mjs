// End-to-end test of the analysis of the bodies checked (dist/): a file of
// three blocks opens with its largest one alone checked, and every figure is
// of it alone, said so: the mass and the volume, the wall thickness, the
// parting card, the part given to the costing, the AI context and
// reader3d.analyze(). A body checked: what was asked for already follows by
// itself a moment later (its thickness computed, for it alone; the card on
// it proposed), the costing told once it is done; unchecked and checked
// again: back at once, nothing computed again (no job to the workers); none
// checked: said, no figure left; a burst of clicks: one update.
//
//   npm run build && node --test tests/e2e/scope.test.mjs
//
// SCOPE_SHOTS=<folder>: screenshots of the panel at each step, written there.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const SAMPLE_DIR = join(DIST, 'e2e-scope'); // same origin as the page: reader3d.analyze(url) needs no CORS
const TIMEOUT = 120_000;
const SHOTS = process.env.SCOPE_SHOTS || null;

// Three blocks side by side along X (mm): A the largest, B, then C the smallest. Their
// thinnest walls are their smallest sides (20, 12 and 8 mm), their volumes 48 000, 14 400 and 3 200 mm³.
const BLOCKS = [['A', [0, 0, 0], [60, 40, 20]], ['B', [80, 0, 0], [40, 30, 12]], ['C', [140, 0, 0], [20, 20, 8]]];

/** An ASCII STL of boxes, a solid each, their faces cut into n × n squares (the thickness is measured per triangle). */
function boxesStl(boxes, n = 6) {
  const solids = boxes.map(([name, o, l]) => {
    const facets = [];
    // Each face: across axis k, at its side s (0 or 1), the axes a and b along it (a × b = +k).
    for (const k of [0, 1, 2]) {
      for (const s of [0, 1]) {
        const a = (k + 1) % 3, b = (k + 2) % 3;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const at = (di, dj) => {
              const c = [0, 0, 0];
              c[k] = s;
              c[a] = (i + di) / n;
              c[b] = (j + dj) / n;
              return c.map((x, m) => o[m] + x * l[m]);
            };
            // Counter-clockwise seen from +k; the face at s = 0 looks towards -k.
            const q = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
            if (!s) q.reverse();
            for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
              facets.push(`facet normal 0 0 0\nouter loop\n${tri.map((v) => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`);
            }
          }
        }
      }
    }
    return `solid ${name}\n${facets.join('\n')}\nendsolid ${name}`;
  });
  return Buffer.from(`${solids.join('\n')}\n`);
}

const FILE = { name: 'blocks.stl', mimeType: 'text/plain', buffer: boxesStl(BLOCKS) };

/**
 * Every job sent to the workers of the page, logged (window.__jobs): {worker
 * (its script), type, key (the body of a thickness range), bodies (the
 * bodies of a parting or feeding job)}.
 */
function logJobs() {
  const jobs = (window.__jobs = []);
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      this.script = String(url).split('/').pop().split('?')[0];
    }

    postMessage(message, ...rest) {
      try {
        const bodies = Array.isArray(message?.bodies) ? message.bodies.flatMap((b, i) => (b ? [i] : [])) : null;
        jobs.push({ worker: this.script, type: message?.type ?? null, key: message?.key ?? null, bodies });
      } catch {
        // logged or not, the job goes
      }
      return super.postMessage(message, ...rest);
    }
  };
}

/** The status the page settled on, once analysed. */
async function settled(page) {
  await page.waitForFunction(() => ['done', 'error'].includes(document.body.dataset.status), null, { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => document.body.dataset.error ?? 'done'), 'done');
}

/** The update of the bodies analysed done (none waiting nor running). */
const scopeSettled = (page) => page.waitForFunction(() => window.reader3d.scope && !window.reader3d.scope.updating, null, { timeout: TIMEOUT });

/** What the page shows of the bodies analysed, read at once: the cards, their statuses, the part given to the costing. */
function shown() {
  const text = (id) => (document.getElementById(id).hidden ? '' : document.getElementById(id).textContent.trim());
  const part = window.reader3d.part();
  return {
    rows: [...document.querySelectorAll('#bodies tr[data-index]')].map((tr) => [tr.querySelector('.name').textContent, tr.querySelector('input').checked]),
    scope: text('summary-scope'),
    mass: text('mass'),
    method: text('method'),
    thickScope: text('thick-scope'),
    thickStatus: text('thick-status'),
    thickMin: document.getElementById('thick-body').hidden ? '' : text('thick-min'),
    partingBody: text('parting-body'),
    partingStatus: text('parting-status'),
    partingMain: !document.getElementById('parting-main').hidden,
    feedingStatus: text('feeding-status'),
    part: { volume: part.volume, thickness: part.thickness?.min ?? null, thicknessUpdating: part.thicknessUpdating, selected: part.selected, updating: part.updating },
  };
}

describe('the analysis covers the bodies checked (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;

  before(async () => {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    writeFileSync(join(SAMPLE_DIR, FILE.name), FILE.buffer);
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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

  async function newPage(locale) {
    const context = await browser.newContext({ locale, acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
    await context.addInitScript(logJobs);
    await context.addInitScript({ content: `window.__shown = ${shown}` });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  }

  /** The cards of the panel (in this order: the first ones while an update runs) and the page as they look, for the eye (SCOPE_SHOTS). */
  async function shot(page, name, cards = ['summary-card', 'mass-card', 'thickness-card', 'bodies-card', 'parting-card', 'feeding-card']) {
    if (!SHOTS) return;
    for (const id of cards) {
      const card = page.locator(`#${id}`);
      if (await card.isVisible()) await card.screenshot({ path: join(SHOTS, `${name}-${id}.png`) });
    }
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }

  test('largest body alone by default; a body checked updates by itself; unchecked and checked again, nothing computed again; none checked; a burst of clicks', { timeout: 6 * TIMEOUT }, async () => {
    const { context, page, errors } = await newPage('fr-FR');
    await page.goto(`${base}?lang=fr`);
    await page.setInputFiles('#file-input', FILE);
    await settled(page);
    const names = await page.evaluate(() => window.reader3d.part().parts.map((p) => p.name));
    const [A, B, C] = ['A', 'B', 'C'].map((n) => names.indexOf(n));
    assert.deepEqual([A, B, C].sort(), [0, 1, 2], names.join(', '));
    const box = (i) => `#bodies tr[data-index="${i}"] input`;
    // The jobs sent to the workers from now on: [{worker, type, key, bodies}].
    const jobsSince = async (mark) => (await page.evaluate(() => window.__jobs.length)) > mark ? page.evaluate((m) => window.__jobs.slice(m), mark) : [];
    const mark = () => page.evaluate(() => window.__jobs.length);
    const ofWorker = (jobs, worker, type = null) => jobs.filter((j) => j.worker === worker && (!type || j.type === type));
    // The bodies whose thickness was computed (the meshes or ranges sent to the thickness workers).
    const thicknessBodies = (jobs) => [...new Set(ofWorker(jobs, 'thickworker.js').filter((j) => ['mesh', 'prepare', 'range'].includes(j.type)).map((j) => j.key))].sort();
    // The costing page is told the part by "reader3d-part": what it reads then (reader3d.part()).
    await page.evaluate(() => {
      window.__told = [];
      document.addEventListener('reader3d-part', () => window.__told.push(window.reader3d.part()));
    });
    const told = () => page.evaluate(() => window.__told.map((p) => ({ volume: p.volume, thickness: p.thickness?.min ?? null, selected: p.selected, updating: p.updating })));

    // ---- By default: the largest block alone, every figure its own, said so.
    let s = await page.evaluate(() => window.__shown());
    assert.deepEqual(s.rows, names.map((n) => [n, n === 'A']));
    assert.equal(s.scope, 'Analyse sur 1 corps sur 3 (corps cochés)');
    assert.equal(s.mass, '129,6 g');
    approx(s.part.volume, 48000, 1e-9, 0, 'volume costed');
    assert.deepEqual(s.part.selected, [A]);
    const result = await page.evaluate(() => window.reader3d.result);
    assert.deepEqual(result.bodies.map((b) => b.name), ['A']);
    assert.deepEqual(result.scope, { mode: 'checked', bodies: 1, bodies_in_file: 3, indices: [A] });
    approx(result.summary.volume, 48000, 1e-9, 0, 'volume of the results');
    approx(result.summary.mass, 129.6, 1e-9, 0, 'mass of the results');
    // The AI context and the semantic contract: that block, said so.
    const ai = await page.evaluate(() => ({ context: window.reader3d.aiContext(), part: window.reader3d.aiPart({ withSemantic: false }).scope }));
    assert.deepEqual(ai.context.bodies.map((b) => b.name), ['A']);
    assert.deepEqual(ai.context.model.scope, { mode: 'checked', bodies: 1, bodies_in_file: 3, indices: [A] });
    assert.deepEqual([ai.part.mode, ai.part.bodies_sent, ai.part.bodies_in_file], ['checked', 1, 3]);
    // The parting line card on it, proposed for it alone (nor are the feeding zones of the others looked for).
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: TIMEOUT });
    await page.waitForFunction(() => document.getElementById('feeding-card').dataset.status === 'proposed', null, { timeout: TIMEOUT });
    assert.equal(await page.textContent('#parting-body'), 'Corps : A');
    let jobs = await jobsSince(0);
    assert.deepEqual(ofWorker(jobs, 'partworker.js', 'propose').map((j) => j.bodies), [[A]]);
    assert.deepEqual(ofWorker(jobs, 'feedworker.js', 'zones').map((j) => j.bodies), [[A]]);
    // The bodies not checked, listed for the costing page without any result of the analysis.
    const parts = await page.evaluate(() => window.reader3d.part().parts);
    for (const i of [B, C]) {
      assert.equal(parts[i].checked, false);
      assert.equal(parts[i].thickness, null);
      assert.equal(parts[i].slides.status, 'idle');
      assert.equal(parts[i].orientedSize, undefined);
    }
    // The wall thickness, asked for: of that block alone.
    await page.click('#thick-compute');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: TIMEOUT });
    s = await page.evaluate(() => window.__shown());
    assert.equal(s.thickMin, '20 mm');
    assert.equal(s.thickScope, 'Analyse sur 1 corps sur 3 (corps cochés)');
    assert.equal(s.part.thickness, 20);
    assert.deepEqual(thicknessBodies(await jobsSince(0)), [A]);
    // Its parting shown on the 3D view.
    await page.check('#parting-show');
    assert.equal(await page.getAttribute('#parting-card', 'data-overlay'), 'lower upper line');
    await shot(page, '1-largest-alone');

    // ---- B's row selected, unchecked: the card stays on a body checked.
    await page.click(`#bodies tr[data-index="${B}"] td.name`);
    assert.equal(await page.textContent('#parting-body'), 'Corps : A');

    // ---- B checked: the summary at once; its thickness and its parting (the card goes to it, selected) a moment later, by themselves.
    await scopeSettled(page);
    let since = await mark();
    const updates = await page.evaluate(() => window.reader3d.scope.updates);
    await page.evaluate(() => (window.__told = []));
    s = await page.evaluate((sel) => {
      document.querySelector(sel).click();
      // What the cards say before the update starts, and the jobs sent to the workers by then.
      const cards = ['thickness-card', 'parting-card', 'feeding-card'].map((id) => document.getElementById(id).dataset.updating);
      return { ...window.__shown(), cards, jobs: window.__jobs.length };
    }, box(B));
    // Nothing sent to the workers before the update starts.
    assert.equal(s.jobs, since);
    assert.deepEqual(s.cards, ['1', '1', '1']);
    assert.equal(s.scope, 'Analyse sur 2 corps sur 3 (corps cochés)');
    assert.equal(s.mass, '168,48 g');
    approx(s.part.volume, 62400, 1e-9, 0, 'volume costed at once');
    // No figure of A alone left as if it were the set's: « mise à jour… » instead.
    assert.equal(s.thickMin, '');
    assert.equal(s.thickStatus, 'Mise à jour… (épaisseurs des corps cochés à l\'instant)');
    assert.equal(s.part.thickness, null);
    assert.equal(s.part.thicknessUpdating, true);
    assert.equal(s.part.updating, true);
    assert.deepEqual([s.partingBody, s.partingStatus, s.partingMain], ['Corps : B', 'Mise à jour…', false]);
    assert.equal(s.feedingStatus, 'Mise à jour…');
    await shot(page, '2-checked-updating', ['thickness-card', 'parting-card', 'feeding-card', 'summary-card']);
    await scopeSettled(page);
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: TIMEOUT });
    s = await page.evaluate(() => window.__shown());
    assert.equal(s.thickMin, '12 mm');
    assert.equal(s.part.thickness, 12);
    assert.deepEqual([s.partingBody, s.partingStatus], ['Corps : B', '']);
    assert.equal(await page.evaluate(() => window.reader3d.scope.updates), updates + 1);
    // Computed for B alone: its thickness, its parting proposal, its feeding zones.
    jobs = await jobsSince(since);
    assert.deepEqual(thicknessBodies(jobs), [B]);
    assert.deepEqual(ofWorker(jobs, 'partworker.js', 'propose').map((j) => j.bodies), [[B]]);
    assert.deepEqual(ofWorker(jobs, 'feedworker.js', 'zones').map((j) => j.bodies), [[B]]);
    // Its parting shown on the view, A faded, C hidden (not faded).
    await page.waitForFunction(() => document.getElementById('parting-card').dataset.overlay === 'lower upper line', null, { timeout: TIMEOUT });
    assert.equal(await page.evaluate(() => document.getElementById('viewport').dataset.faded), '1');
    // The costing page told the new part once the update is done.
    const last = (await told()).at(-1);
    approx(last.volume, 62400, 1e-9, 0, 'volume told');
    assert.deepEqual([last.thickness, last.selected, last.updating], [12, [A, B].sort(), false]);
    const part = await page.evaluate(() => window.reader3d.part());
    assert.equal(part.parts[B].checked, true);
    assert.equal(part.parts[B].thickness.min, 12);
    assert.notEqual(part.parts[B].slides.status, 'idle');
    // The AI context, the semantic contract and the results: both blocks.
    assert.deepEqual(await page.evaluate(() => window.reader3d.aiContext().bodies.map((b) => b.name).sort()), ['A', 'B']);
    assert.deepEqual(await page.evaluate(() => window.reader3d.semantic.model.scope), { mode: 'checked', bodies: 2, bodies_in_file: 3, indices: [A, B].sort() });
    const published = JSON.parse(await page.textContent('#reader3d-result'));
    assert.deepEqual([published.bodies.length, published.scope.bodies, published.thickness.min], [2, 2, 12]);
    await shot(page, '3-checked-updated');

    // ---- B unchecked: back at once (the card on A again, its thickness its own); nothing computed.
    await page.waitForTimeout(1000); // the slides, orientation and risers of B, asked for by its card, in by now
    since = await mark();
    s = await page.evaluate((sel) => {
      document.querySelector(sel).click();
      return window.__shown();
    }, box(B));
    assert.deepEqual([s.mass, s.thickMin, s.thickStatus, s.partingBody, s.part.thickness], ['129,6 g', '20 mm', '', 'Corps : A', 20]);
    await scopeSettled(page);
    await page.waitForTimeout(500);
    assert.deepEqual(await jobsSince(since), []);
    // ---- Checked again: its figures at once, kept; nothing computed again.
    s = await page.evaluate((sel) => {
      document.querySelector(sel).click();
      return window.__shown();
    }, box(B));
    assert.deepEqual([s.mass, s.thickMin, s.thickStatus, s.partingBody, s.partingMain, s.part.thickness], ['168,48 g', '12 mm', '', 'Corps : B', true, 12]);
    await scopeSettled(page);
    await page.waitForTimeout(500);
    assert.deepEqual(await jobsSince(since), [], 'no job sent to the workers: each body\'s results kept');
    assert.equal((await told()).at(-1).thickness, 12);

    // ---- A burst of clicks (C on, off, on; B off, on): one update, C computed once.
    since = await mark();
    const before = await page.evaluate(() => window.reader3d.scope.updates);
    await page.evaluate(async ([c, b]) => {
      for (const sel of [c, c, c, b, b]) {
        document.querySelector(sel).click();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }, [box(C), box(B)]);
    await scopeSettled(page);
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: TIMEOUT });
    assert.equal(await page.evaluate(() => window.reader3d.scope.updates), before + 1);
    jobs = await jobsSince(since);
    assert.deepEqual(thicknessBodies(jobs), [C]);
    assert.deepEqual(ofWorker(jobs, 'partworker.js', 'propose').map((j) => j.bodies), [[C]]);
    assert.deepEqual(ofWorker(jobs, 'feedworker.js', 'zones').map((j) => j.bodies), [[C]]);
    s = await page.evaluate(() => window.__shown());
    assert.deepEqual([s.scope, s.mass, s.thickMin], ['Analyse sur les 3 corps (tous cochés)', '177,12 g', '8 mm']);

    // ---- None checked: said, no figure left anywhere.
    await page.uncheck('#bodies-all');
    s = await page.evaluate(() => window.__shown());
    const NONE = 'Aucun corps coché : cochez au moins un corps dans la liste pour l\'analyser.';
    assert.deepEqual([s.scope, s.mass, s.method, s.thickMin, s.thickStatus, s.partingStatus, s.partingMain, s.feedingStatus],
      ['', '—', NONE, '', NONE, NONE, false, NONE]);
    assert.equal(await page.textContent('#total-volume'), '—');
    assert.deepEqual([s.part.volume, s.part.thickness, s.part.selected], [null, null, []]);
    const none = await page.evaluate(() => ({ result: window.reader3d.result, ai: window.reader3d.aiPart().semantic, context: window.reader3d.aiContext() }));
    assert.deepEqual([none.result.bodies, none.result.summary.volume, none.result.summary.mass, none.result.scope.mode, none.result.thickness], [[], null, null, 'none', undefined]);
    assert.equal(none.ai, null);
    assert.deepEqual(none.context.bodies, []);
    await scopeSettled(page);
    const nothing = JSON.parse(await page.textContent('#reader3d-result'));
    assert.deepEqual([nothing.bodies, nothing.summary.volume, nothing.scope.mode], [[], null, 'none']);
    // An export: nothing to export, said.
    let downloaded = false;
    page.on('download', () => (downloaded = true));
    await page.click('#export-json');
    await page.waitForSelector('#error:not([hidden])');
    assert.equal(await page.textContent('#error'), 'Aucun corps coché : rien à exporter.');
    await page.waitForTimeout(300);
    assert.equal(downloaded, false);
    await shot(page, '4-none-checked');

    // ---- All checked again: every figure back at once, nothing computed again.
    since = await mark();
    await page.check('#bodies-all');
    s = await page.evaluate(() => window.__shown());
    assert.deepEqual([s.scope, s.mass, s.thickMin], ['Analyse sur les 3 corps (tous cochés)', '177,12 g', '8 mm']);
    await scopeSettled(page);
    await page.waitForTimeout(500);
    assert.deepEqual(thicknessBodies(await jobsSince(since)), []);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('reader3d.analyze() and the English cards: the largest body checked alone, said so; every body with ?bodies=all', { timeout: 3 * TIMEOUT }, async () => {
    const { context, page, errors } = await newPage('en-US');
    await page.goto(`${base}?lang=en`);
    const result = await page.evaluate(() => window.reader3d.analyze('e2e-scope/blocks.stl'));
    assert.deepEqual(result.bodies.map((b) => b.name), ['A']);
    assert.deepEqual([result.scope.mode, result.scope.bodies, result.scope.bodies_in_file], ['checked', 1, 3]);
    approx(result.summary.volume, 48000, 1e-9, 0, 'volume analysed');
    assert.equal(await page.textContent('#summary-scope'), 'Analysis of 1 body of 3 (checked bodies)');
    assert.equal(await page.textContent('#thick-scope'), 'Analysis of 1 body of 3 (checked bodies)');
    // The thickness of the bodies checked through the API: of A alone.
    const part = await page.evaluate(() => window.reader3d.computeThickness());
    assert.deepEqual([part.thickness.min, part.parts.filter((p) => p.thickness).map((p) => p.name)], [20, ['A']]);
    // A second body by a script: the summary at once, the rest after the update.
    const two = await page.evaluate(() => {
      const names = window.reader3d.part().parts.map((p) => p.name);
      return window.reader3d.setSelection([names.indexOf('A'), names.indexOf('B')]);
    });
    approx(two.volume, 62400, 1e-9, 0, 'volume of A and B');
    assert.equal(two.thickness, null);
    await scopeSettled(page);
    assert.equal(await page.textContent('#summary-scope'), 'Analysis of 2 bodies of 3 (checked bodies)');
    assert.equal((await page.evaluate(() => window.reader3d.part())).thickness.min, 12);
    await shot(page, '5-english-two-of-three');

    // Every body asked for in the page's address: analysed whole.
    await page.goto(`${base}?lang=en&bodies=all`);
    const all = await page.evaluate(() => window.reader3d.analyze('e2e-scope/blocks.stl'));
    assert.deepEqual(all.bodies.map((b) => b.name).sort(), ['A', 'B', 'C']);
    assert.equal(all.scope.mode, 'all');
    approx(all.summary.volume, 65600, 1e-9, 0, 'volume of every body');
    assert.equal(await page.textContent('#summary-scope'), 'Analysis of the 3 bodies (all checked)');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
