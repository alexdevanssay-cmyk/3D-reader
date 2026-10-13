// End-to-end test of the orientation of the part in its die by casting
// process, on the built site (dist/): the process of the parting card from the
// island retained in the costing (low pressure: a horizontal parting plane,
// the upper half on top, up when cast along the draw direction, fed from
// below), chosen for the part instead and kept after a reload, back to the
// costing's; the casting up chosen by hand (a horizontal plane turned over),
// again with the wall thickness; the die blank (« Brut ») on the 3D view and
// its size and steel on the card; the islands' orientation in Paramètres; the
// costing's die block from the part oriented in its die, and its trace. With a
// made-up costing workbook (tests/js/costing-fixture.mjs), in French.
//
//   npm run build && node --test tests/e2e/orientation.test.mjs
//   SHOTS_DIR=… also writes screenshots of the card, the 3D view and the costing there.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath } from '../js/helpers.mjs';
import { costingWorkbook } from '../js/costing-fixture.mjs';

const DIST = join(ROOT, 'dist');
const CAD_TIMEOUT = 180_000;
const SHOTS = process.env.SHOTS_DIR || null;

/** A screenshot of `target` (a selector, or the page) into SHOTS_DIR, when it is set. */
async function shot(page, name, target = null) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  if (target) await page.locator(target).screenshot({ path });
  else await page.screenshot({ path });
}

/** The 3D view zoomed out round its centre (the die blank and the arrows in sight) for a screenshot, when they are taken. */
async function zoomOut(page, steps = 2) {
  if (!SHOTS) return;
  const box = await page.locator('#viewport canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < steps; k++) await page.mouse.wheel(0, 250);
  await page.waitForTimeout(600);
}

/** What the parting card says of the orientation. */
const card = (page) => page.evaluate(() => {
  const el = document.getElementById('parting-card');
  return {
    axis: document.getElementById('parting-axis').textContent,
    origin: document.getElementById('parting-origin').textContent,
    process: document.getElementById('parting-process-line').textContent,
    select: document.getElementById('parting-process-select').value,
    reset: !document.getElementById('parting-process-reset').hidden,
    up: el.dataset.up,
    ups: [...document.getElementById('parting-up').options].map((o) => o.textContent),
    note: document.getElementById('parting-up-note').hidden ? '' : document.getElementById('parting-up-note').textContent,
    orient: Object.fromEntries([...document.querySelectorAll('#parting-orient dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
  };
});

/** The card settled on this process line and this casting up (nothing being computed for the part). */
const settled = (page, process, up) => page.waitForFunction(([p, u]) => {
  const el = document.getElementById('parting-card');
  return document.getElementById('parting-process-line').textContent === p && el.dataset.up === u
    && document.getElementById('parting-status').hidden && !document.getElementById('parting-up').disabled;
}, [process, up], { timeout: 120_000 });

/** The risers card placed for this process (the semantic contract), then the body's parting, feeding, foundry screen and AI context. */
async function exported(page, plan) {
  await page.waitForFunction((p) => window.reader3d.semantic?.bodies?.[0]?.feeding?.process?.plan === p, plan, { timeout: 120_000 });
  return page.evaluate(() => {
    const body = window.reader3d.semantic.bodies[0];
    const ai = window.reader3d.aiContext().bodies[0];
    return { parting: body.parting, feeding: body.feeding, foundry: body.foundry, ai: { process: ai.process, orientation: ai.orientation, feeding: ai.feeding } };
  });
}

const GRAVITY_DEFAULT = 'Procédé : Coquille gravité — plan de joint vertical, coulée par le haut (par défaut : aucun îlot retenu)';
const LOW_PRESSURE = 'Procédé : Basse pression — plan de joint horizontal, alimentation par le bas (îlot BPR retenu dans le chiffrage)';
const GRAVITY_CHOSEN = 'Procédé : Coquille gravité — plan de joint vertical, coulée par le haut (choisi pour cette pièce ; chiffrage : îlot BPR)';

describe('orientation by casting process (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;
  let dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orientation-'));
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

  /** A page in French with the costing workbook imported. */
  async function newPage() {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ccard');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    await page.click('.tab[data-page="viewer"]');
    return { context, page, errors };
  }

  /** A 3D file opened, its parting and its risers proposed. */
  async function open(page, file) {
    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 120_000 });
    await page.waitForSelector('#feeding-main:not([hidden])', { timeout: 120_000 });
  }

  /** The island `code` retained for the piece in the costing page (the page shown again after). */
  async function retain(page, code) {
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage [data-bind="p.procede"]');
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', code);
    await page.waitForFunction((c) => document.querySelector('#page-chiffrage [data-bind="p.procede"]')?.value === c, code);
  }

  test('the process from the costing, chosen for the part and kept, the casting up, the die blank, the islands in Paramètres', { timeout: 4 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    // The block 100 × 60 × 20 mm with a hole Ø 20 through it along Z.
    await open(page, fixturePath('holed_block.step'));

    // No island retained yet: the default, a gravity die with a vertical parting plane; up across the draw
    // direction, the shorter side of the block upright (60 mm along Y), the risers on the face turned up.
    await settled(page, GRAVITY_DEFAULT, '+Y');
    let shown = await card(page);
    assert.deepEqual([shown.axis, shown.select, shown.reset], ['Z', 'vertical-haut', false]);
    assert.deepEqual(shown.ups, ['+X', '-X', '+Y ★', '-Y']);
    // The die blank: 100 × 60 × 20 plus the margins of the costing (60, 60, 50 per side), one cavity, steel 7.8.
    assert.deepEqual(shown.orient, { 'Brut de coquille': "220 × 180 × 120 mm, 37 kg d'acier" });
    assert.match(await page.textContent('#parting-candidates thead'), /Brut \(kg\)/);
    assert.deepEqual(await page.$$eval('#parting-candidates tbody tr', (trs) => trs.map((tr) => tr.cells[5].textContent)), ['37', '38', '39']);
    let s = await exported(page, 'vertical');
    assert.deepEqual(s.parting.process, { plan: 'vertical', alimentation: 'haut', source: 'default', island: null, famille: null });
    assert.deepEqual([s.parting.orientation.up, s.parting.orientation.raw_mm, s.parting.orientation.die_block_mm, s.parting.orientation.steel_kg], [[0, 1, 0], [100, 60, 20], [220, 180, 120], 37.1]);
    const [riser] = s.feeding.risers;
    assert.deepEqual([riser.type, riser.axis], ['top', [0, 1, 0]]);
    approx(riser.position_mm[1], 60, 0, 1e-3, 'the riser on the face turned up (y = 60)');
    assert.ok(s.feeding.gate.on_parting_line && s.feeding.gate.position_mm[1] < 30, `ingate low along up: ${s.feeding.gate.position_mm}`);
    // The 3D view: the arrow « haut », the blank once « Brut » is checked.
    await page.check('#parting-show');
    assert.equal(await page.getAttribute('#parting-card', 'data-orient'), 'up');
    await page.check('#parting-brut');
    assert.deepEqual(await page.evaluate(() => [document.getElementById('parting-card').dataset.orient, document.getElementById('parting-card').dataset.brut]), ['up brut', '220 × 180 × 120']);
    await page.click('[data-view="iso"]');
    await zoomOut(page);
    await shot(page, 'view-gravity-vertical', '#viewport');
    await page.locator('#parting-process').scrollIntoViewIfNeeded();
    await shot(page, 'card-gravity-default', '#parting-card');

    // Low pressure retained in the costing: its die block from the part oriented in its die, traced.
    await retain(page, 'BPR');
    await page.waitForFunction(() => /moule 220 × \d+ × 120 mm = brut orienté du modèle 3D \(direction de démoulage \+Z, pavé minimal\) \+ marges/.test(document.getElementById('page-chiffrage').textContent));
    await page.click('#page-chiffrage [data-action="show-trace"]');
    await page.waitForSelector('#page-chiffrage #ctrace details[open] table');
    const trace = await page.textContent('#page-chiffrage #ctrace');
    assert.match(trace, /piece\.brutOriente/);
    assert.match(trace, /100 × 60 × 20 mm/);
    assert.match(trace, /brut orienté du modèle 3D \(direction de démoulage \+Z, pavé minimal\) \+ marges/);
    await page.locator('#page-chiffrage .ccard', { hasText: 'Outillage — moule basse pression' }).scrollIntoViewIfNeeded();
    await shot(page, 'costing-tooling', '#page-chiffrage .ccard:has(h3:text-matches("^Outillage"))');
    await page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.outillage' }).first().scrollIntoViewIfNeeded();
    await shot(page, 'costing-trace');

    // On the 3D page: low pressure, a horizontal parting plane, the upper half on top (up = +d), fed from below.
    await page.click('.tab[data-page="viewer"]');
    await settled(page, LOW_PRESSURE, '+Z');
    shown = await card(page);
    assert.deepEqual([shown.axis, shown.select, shown.reset, shown.note], ['Z', 'horizontal-bas', false, '']);
    assert.deepEqual(shown.ups, ['+Z ★', '-Z (inverse les chapes)']);
    s = await exported(page, 'horizontal');
    assert.deepEqual(s.parting.process, { plan: 'horizontal', alimentation: 'bas', source: 'costing', island: 'BPR', famille: 'Basse pression' });
    assert.deepEqual([s.parting.direction, s.parting.orientation.up, s.parting.orientation.upper_half_down, s.parting.orientation.block_axes.d], [[0, 0, 1], [0, 0, 1], false, [0, 0, 1]]);
    // The risers card: no riser, a feed point under the part through the lower die.
    await page.waitForFunction(() => /^Basse pression : alimentation par le bas, pas de masselotte/.test(document.getElementById('feeding-mode').textContent));
    assert.equal(await page.textContent('#feeding-count'), '0');
    assert.match(await page.textContent('#feeding-risers tbody'), /^A1par le bas/);
    assert.deepEqual([s.feeding.mode, s.feeding.risers.length, s.feeding.gate.bottom_feed, s.feeding.gate.on_parting_line], ['bottom', 0, true, false]);
    assert.ok(s.feeding.feed_points.length >= 1);
    approx(s.feeding.gate.position_mm[2], 0, 0, 1e-3, 'fed at the bottom of the part');
    // The foundry screen and the AI context: fed from below, not an ingate off the parting line.
    assert.ok(!s.foundry.risks.some((r) => r.code === 'gate_off_parting_line'));
    assert.equal(s.foundry.rules.gating, 'proposed_bottom_feed');
    assert.deepEqual([s.foundry.evidence.process.plan, s.foundry.evidence.orientation.up_axis], ['horizontal', '+Z']);
    assert.deepEqual([s.ai.process.island, s.ai.orientation.up_axis, s.ai.orientation.die_block_mm, s.ai.feeding.mode], ['BPR', '+Z', [220, 180, 120], 'bottom']);
    await page.check('#feeding-show');
    assert.equal(await page.getAttribute('#feeding-card', 'data-markers'), String(s.feeding.feed_points.length));
    await page.click('[data-view="iso"]');
    await zoomOut(page);
    await shot(page, 'view-low-pressure', '#viewport');
    await page.locator('#parting-process').scrollIntoViewIfNeeded();
    await shot(page, 'card-low-pressure', '#parting-card');
    await page.locator('#feeding-card').scrollIntoViewIfNeeded();
    await shot(page, 'risers-low-pressure', '#feeding-card');

    // The casting up chosen by hand: the other side of a horizontal plane turns the halves over.
    await page.selectOption('#parting-up', '-d');
    await page.waitForFunction(() => document.getElementById('parting-axis').textContent === '-Z' && document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 60_000 });
    await settled(page, LOW_PRESSURE, '-Z');
    s = await exported(page, 'horizontal');
    assert.deepEqual([s.parting.direction, s.parting.orientation.up, s.parting.orientation.upper_half_down], [[0, 0, -1], [0, 0, -1], false]);
    await page.waitForFunction(() => Math.abs((window.reader3d.semantic.bodies[0].feeding?.gate?.position_mm?.[2] ?? 0) - 20) < 1e-3, null, { timeout: 60_000 });
    // The slides of the halves turned over: classified along -Z, as many (none: drawn along the hole).
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].slides?.parting?.axis === '-Z' && window.reader3d.semantic.bodies[0].slides.count != null, null, { timeout: 60_000 });
    assert.deepEqual(await page.evaluate(() => [window.reader3d.semantic.bodies[0].slides.count, window.reader3d.semantic.bodies[0].slides.cores]), [0, 0]);
    await page.click('#parting-reset');
    await settled(page, LOW_PRESSURE, '+Z');
    assert.equal(await page.textContent('#parting-axis'), 'Z');

    // Chosen for the part: a gravity die with a vertical plane; up by hand along -X.
    await page.selectOption('#parting-process-select', 'vertical-haut');
    await settled(page, GRAVITY_CHOSEN, '+Y');
    assert.equal((await card(page)).reset, true);
    await page.selectOption('#parting-up', '-u');
    await settled(page, GRAVITY_CHOSEN, '-X');
    assert.equal((await card(page)).note, 'Haut de coulée choisi à la main.');
    s = await exported(page, 'vertical');
    assert.deepEqual([s.parting.process.source, s.parting.orientation.up, s.parting.orientation.up_source, s.feeding.up], ['part', [-1, 0, 0], 'manual', [-1, 0, 0]]);

    // Kept after a reload: the process chosen, the up chosen, the island the costing retained.
    await page.reload();
    await open(page, fixturePath('holed_block.step'));
    await settled(page, GRAVITY_CHOSEN, '-X');
    assert.equal((await card(page)).note, 'Haut de coulée choisi à la main.');
    // Back to the costing's process: low pressure again.
    await page.click('#parting-process-reset');
    await settled(page, LOW_PRESSURE, '+Z');

    // The wall thickness computed: the up chosen again with it (the same: the plate is even).
    await page.evaluate(() => window.reader3d.computeThickness());
    await page.waitForFunction(() => document.getElementById('parting-up-note').textContent.includes('Haut de coulée choisi avec les épaisseurs'), null, { timeout: 120_000 });
    s = await exported(page, 'horizontal');
    assert.deepEqual([s.parting.orientation.feeding_basis, s.parting.orientation.up_source, s.parting.orientation.up], ['thickness', 'thickness', [0, 0, 1]]);

    // Paramètres: the orientation of each island with a die made in-house; BPR made vertical, the card follows.
    await page.click('.tab[data-page="parametres"]');
    await page.waitForSelector('#page-parametres [data-bind="s.processes.BPR.orientation.plan"]');
    const islands = await page.evaluate(() => Object.fromEntries(['BPR', 'CG3', 'SSP'].map((code) => [code, [`s.processes.${code}.orientation.plan`, `s.processes.${code}.orientation.alimentation`].map((b) => document.querySelector(`#page-parametres [data-bind="${b}"]`)?.value ?? null)])));
    assert.deepEqual(islands, { BPR: ['horizontal', 'bas'], CG3: ['vertical', 'haut'], SSP: [null, null] });
    assert.match(await page.textContent('#page-parametres'), /Plan de joint et alimentation/);
    await page.locator('#page-parametres [data-bind="s.processes.BPR.orientation.plan"]').scrollIntoViewIfNeeded();
    await shot(page, 'parametres-islands', '#page-parametres .ccard:has(h3:text("Îlots de coulée et méthodes"))');
    await page.selectOption('#page-parametres [data-bind="s.processes.BPR.orientation.plan"]', 'vertical');
    await page.click('.tab[data-page="viewer"]');
    await page.waitForFunction(() => document.getElementById('parting-process-line').textContent === 'Procédé : Basse pression — plan de joint vertical, alimentation par le bas (îlot BPR retenu dans le chiffrage)', null, { timeout: 60_000 });
    assert.equal(await page.inputValue('#parting-process-select'), 'vertical-bas');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("a box turned in space: the costing's die block from the part oriented in its die, not from its envelope", { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    // A box 40 × 10 × 5 mm turned about an oblique axis: its envelope 34.6 × 31.2 × 26 mm.
    await open(page, fixturePath('rotated_box.stl'));
    // Drawn along its 5 mm side (the least zero-draft surface among dies as heavy): its blank along its sides.
    await page.waitForFunction(() => document.getElementById('parting-orient').textContent.length > 0, null, { timeout: 60_000 });
    assert.deepEqual((await card(page)).orient, { 'Brut de coquille': "160 × 130 × 105 mm, 17 kg d'acier" });
    const part = await page.evaluate(() => window.reader3d.part().parts[0]);
    part.orientedSize.forEach((x, k) => approx(x, [40, 10, 5][k], 0, 0.01, `oriented size ${k}`));
    assert.match(part.orientedAxis, /^\(/);
    // The costing: an in-house die (low pressure) sized from it, 160 long and 105 high (its envelope would give 155 × … × 126).
    await retain(page, 'BPR');
    await page.waitForFunction(() => /moule 160 × \d+ × 105 mm = brut orienté du modèle 3D \(direction de démoulage \(.+\), pavé minimal\) \+ marges/.test(document.getElementById('page-chiffrage').textContent));
    assert.doesNotMatch(await page.textContent('#page-chiffrage'), /moule 155 ×/);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
