// End-to-end test of the orientation of the part in its die by casting
// process, on the built site (dist/): the process of the parting card from the
// island retained in the costing (low pressure: a horizontal parting plane,
// the upper half on top, up when cast along the draw direction, fed from
// below), chosen for the part instead and kept after a reload, back to the
// costing's; the casting up chosen by hand (a horizontal plane turned over),
// again with the wall thickness; the die blank (« Brut ») on the 3D view and
// its size and steel on the card; the islands' orientation in Paramètres; the
// costing's die block from the part oriented in its die, and its trace; the
// mould halves cut out of that blank and the « Vue de coulée » turned with the
// process (a V bent bar). With a made-up costing workbook
// (tests/js/costing-fixture.mjs), in French.
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
import { prism, vBar } from '../js/meshes.mjs';

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

// An inverted T: a base 60 (x) × 30 (z), a wall 4 thick and 80 high on its middle, 100 deep along y.
const T_PROFILE = [[0, 0], [60, 0], [60, 30], [32, 30], [32, 110], [28, 110], [28, 30], [0, 30]];
const tPart = (scale = 1) => {
  const m = prism(T_PROFILE, 100, [30, 25]);
  return { positions: m.positions.map((x) => x * scale), indices: m.indices };
};

/** A binary STL of a mesh, as a file to open. */
function stlFile(name, { positions: P, indices: I }) {
  const n = I.length / 3;
  const buffer = Buffer.alloc(84 + 50 * n);
  buffer.writeUInt32LE(n, 80);
  for (let f = 0; f < n; f++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) buffer.writeFloatLE(P[3 * I[3 * f + c] + k], 84 + 50 * f + 12 + 12 * c + 4 * k);
  return { name, mimeType: 'application/octet-stream', buffer };
}

/** An OBJ of meshes, a body each (the faces of a material each, as trimesh groups them), as a file to open. */
function objFile(name, objects) {
  const vertices = [], faces = [];
  let first = 1;
  for (const { name: object, positions: P, indices: I } of objects) {
    for (let i = 0; i < P.length; i += 3) vertices.push(`v ${P[i]} ${P[i + 1]} ${P[i + 2]}`);
    faces.push(`o ${object}`, `usemtl ${object}`);
    for (let f = 0; f < I.length; f += 3) faces.push(`f ${I[f] + first} ${I[f + 1] + first} ${I[f + 2] + first}`);
    first += P.length / 3;
  }
  return { name, mimeType: 'text/plain', buffer: Buffer.from(`${[...vertices, ...faces].join('\n')}\n`) };
}

/** A field of the costing typed in (then left: its change). */
async function setField(page, selector, value) {
  await page.waitForSelector(selector);
  await page.fill(selector, String(value));
  await page.dispatchEvent(selector, 'change');
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
    // No riser by design: the feed points sized by the modulus, not risers.
    assert.equal(s.foundry.rules.risering, 'none_bottom_feed');
    assert.ok(s.foundry.evidence.confirmed.includes('feed_points_sized_by_modulus') && !s.foundry.evidence.confirmed.includes('risers_proposed_from_geometry'));
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

  test('the costing and the 3D page agree at once: the draw direction and its blank the same whatever the island retained', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    // Islands rated so that low pressure and the gravity die CG4 are close: when the process ranked the draw
    // directions, each one was the better under the other's orientation, and the costing and the 3D page
    // retained them in turn for ever (some 30 times a second).
    await page.click('.tab[data-page="parametres"]');
    for (const [code, quality] of Object.entries({ SSP: 0.01, CG1: 0.01, CG2: 0.01, CG3: 0.01, CG5: 0.01, CG4: 7, BPR: 7.83 })) {
      await setField(page, `#page-parametres [data-bind="s.processes.${code}.qualite"]`, quality);
    }
    await page.click('.tab[data-page="chiffrage"]');
    await setField(page, '#page-chiffrage [data-bind="q.volumeAnnuel"]', 100);
    await page.click('.tab[data-page="viewer"]');
    // The inverted T scaled × 2.03: drawn across it (X), the base up for a gravity die (no island retained yet).
    await open(page, stlFile('T.stl', tPart(2.03)));
    await settled(page, GRAVITY_DEFAULT, '-Z');
    const gravity = await page.evaluate(() => window.reader3d.part().parts[0].orientedSize);
    assert.deepEqual(gravity, [223.3, 203, 121.8]);
    // What the costing tells the 3D page, each time.
    await page.evaluate(() => {
      const api = window.reader3d;
      const setProcess = api.setProcess;
      window.told = [];
      api.setProcess = (key, info) => {
        const changed = setProcess.call(api, key, info);
        window.told.push({ key, info, changed });
        return changed;
      };
    });
    await page.click('.tab[data-page="chiffrage"]');
    // Settled: nothing told for 3 s, within a minute.
    let told = [];
    for (let quiet = 0, k = 0; quiet < 3; k++) {
      assert.ok(k < 60, `still told after a minute: ${told.length} times`);
      await page.waitForTimeout(1000);
      const now = await page.evaluate(() => window.told);
      quiet = now.length === told.length ? quiet + 1 : 0;
      told = now;
    }
    assert.ok(told.length <= 20, `told ${told.length} times`);
    assert.deepEqual(told.filter((x) => x.changed).map((x) => x.info.code), ['BPR'], 'one island retained, not one then the other in turn');
    // The 3D page: low pressure, the same draw direction and blank (up along it: the T is even across).
    await page.click('.tab[data-page="viewer"]');
    await settled(page, LOW_PRESSURE, '+X');
    assert.equal(await page.textContent('#parting-axis'), 'X');
    assert.deepEqual(await page.evaluate(() => window.reader3d.part().parts[0].orientedSize), gravity);
    // Told the same again: nothing changes, nothing drawn or proposed again.
    const last = told.at(-1);
    assert.equal(await page.evaluate(([key, info]) => window.reader3d.setProcess(key, info), [last.key, last.info]), false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('every body proposed again for its process, whichever body the card shows (an open one)', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    // An open square (body 0: the groups of an OBJ are read last first) beside the inverted T (body 1).
    const square = { positions: Float32Array.from([-100, 0, 0, -50, 0, 0, -50, 50, 0, -100, 50, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
    await open(page, objFile('T et plaque.obj', [{ name: 'T', ...tPart() }, { name: 'plaque', ...square }]));
    assert.deepEqual(await page.evaluate(() => window.reader3d.part().parts.map((b) => b.closed)), [false, true]);
    const body = () => page.evaluate(() => {
      const o = window.reader3d.semantic?.bodies?.[1]?.parting?.orientation;
      return { plan: o?.process?.plan, feeding: window.reader3d.semantic?.bodies?.[1]?.feeding?.process?.plan, margin: o?.margins_mm?.longueur, block: o?.die_block_mm };
    });
    await page.waitForFunction(() => window.reader3d.semantic?.bodies?.[1]?.feeding?.process?.plan === 'vertical', null, { timeout: 120_000 });
    // The card on the open body: nothing to show.
    await page.click('#bodies tr[data-index="0"] td.name');
    await page.waitForFunction(() => document.getElementById('parting-main').hidden && !document.getElementById('parting-status').hidden);
    // Low pressure retained in the costing for the T: proposed again, its risers placed again (fed from below).
    await retain(page, 'BPR');
    await page.click('.tab[data-page="viewer"]');
    await page.waitForFunction(() => {
      const b = window.reader3d.semantic?.bodies?.[1];
      return b?.parting?.orientation?.process?.plan === 'horizontal' && b?.feeding?.process?.plan === 'horizontal';
    }, null, { timeout: 120_000 });
    assert.deepEqual(await body(), { plan: 'horizontal', feeding: 'horizontal', margin: 60, block: [230, 220, 160] });
    assert.ok(await page.evaluate(() => document.getElementById('parting-main').hidden), 'the card still on the open body');
    // The margins of the dies changed in Paramètres: proposed again with them.
    await page.click('.tab[data-page="parametres"]');
    await setField(page, '#page-parametres [data-bind="s.tooling.marges.longueur"]', 80);
    await page.click('.tab[data-page="viewer"]');
    await page.waitForFunction(() => window.reader3d.semantic?.bodies?.[1]?.parting?.orientation?.margins_mm?.longueur === 80, null, { timeout: 120_000 });
    assert.deepEqual(await body(), { plan: 'horizontal', feeding: 'horizontal', margin: 80, block: [270, 220, 160] });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a V bent bar: the mould halves are its die blank cut in two; the « Vue de coulée » turned with the process, what changed said', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    assert.equal(await page.isDisabled('#view-casting'), true, 'no model, no casting view');
    // Two arms 120 × 20 mm, 150° apart, 8 thick, turned 20° about Z: drawn along Z, its blank along the line joining
    // the ends of its arms (231.8 × 51.8 × 8 mm), not along X and Y; cast in a gravity die, its shorter side (v) upright.
    const turn = (20 * Math.PI) / 180;
    const u = [Math.cos(turn), Math.sin(turn), 0];
    await open(page, stlFile('V.stl', vBar({ turn: 20, offset: [30, -15, 5] })));
    await settled(page, GRAVITY_DEFAULT, '(-0.342, 0.94, 0)');
    assert.equal(await page.isDisabled('#view-casting'), false);
    const o = (await exported(page, 'vertical')).parting.orientation;
    assert.equal(o.block_axes.d.join(), '0,0,1');
    o.block_axes.u.forEach((x, k) => approx(x, u[k], 0, 1e-6, `u [${k}]`));
    o.raw_mm.forEach((x, k) => approx(x, [231.82, 51.76, 8][k], 0, 0.006, `raw [${k}]`));
    // Centred on the part: half-way between the ends of the arms along u, between the bend and the ends along v.
    const mid = (Math.cos((75 * Math.PI) / 180) * 120) / 2;
    o.raw_centre_mm.forEach((x, k) => approx(x, [30 - Math.sin(turn) * mid, -15 + Math.cos(turn) * mid, 9][k], 0, 1e-3, `centre [${k}]`));
    assert.deepEqual(o.die_block_mm, [351.8, 171.8, 108]);
    assert.match((await card(page)).orient['Brut de coquille'], /^352 × 172 × 108 mm, \d+ kg d'acier$/);
    // Up when cast: v (as the card rounds it), the arms of the V up.
    const g = o.up.map((x) => x / Math.hypot(...o.up));
    g.forEach((x, k) => approx(x, [-Math.sin(turn), Math.cos(turn), 0][k], 0, 1e-5, `up [${k}]`));

    // The halves of the mould and the « Brut » box: the same box, the blank of the orientation (one cavity, the margins of the costing).
    await page.check('#parting-show');
    await page.check('#parting-brut');
    assert.equal(await page.getAttribute('#parting-card', 'data-overlay'), 'lower upper line');
    const outline = () => page.evaluate(() => {
      const el = document.getElementById('parting-card');
      return { chapes: JSON.parse(el.dataset.chapes || 'null'), brut: JSON.parse(el.dataset.brutBox || 'null') };
    });
    const { chapes, brut } = await outline();
    const half = [o.raw_mm[0] / 2 + 60, o.raw_mm[1] / 2 + 60, o.raw_mm[2] / 2 + 50];
    const axes = [o.block_axes.u, o.block_axes.v, o.block_axes.d];
    const blank = [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [-1, 1].map((c) => [0, 1, 2].map((k) => o.raw_centre_mm[k] + [a, b, c].reduce((s, sign, j) => s + sign * half[j] * axes[j][k], 0)))));
    const near = (p, list, label) => {
      const gap = Math.min(...list.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
      assert.ok(gap < 1e-3, `${label} ${p}: ${gap} mm from the nearest corner of the blank`);
    };
    assert.deepEqual([chapes.length, brut.length], [8, 8]);
    for (const p of chapes) near(p, brut, 'corner of the mould halves');
    for (const p of brut) near(p, chapes, 'corner of the « Brut » box');
    for (const p of brut) near(p, blank, 'corner of the « Brut » box against the orientation');
    await page.click('[data-view="iso"]');
    await shot(page, 'v-cad', '#viewport');

    // Seen where it is screened: the « Vue de coulée », g up on the screen.
    const screen = (points) => page.evaluate((list) => list.map((p) => window.reader3d.screenOf(p)), points);
    const along = (w, s) => o.raw_centre_mm.map((x, k) => x + s * w[k]);
    const view = async (up, across, label) => {
      const shown = await page.evaluate(() => window.reader3d.view);
      shown.up.forEach((x, k) => approx(x, up[k], 0, 1e-9, `${label}: camera up [${k}]`));
      const [c, top, minus, plus] = await screen([o.raw_centre_mm, along(up, 50), along(o.block_axes.d, -50), along(o.block_axes.d, 50)]);
      assert.ok(c.y - top.y > 40 && Math.abs(top.x - c.x) < 1, `${label}: up when cast upright on the screen (${JSON.stringify([c, top])})`);
      const [dx, dy] = [plus.x - minus.x, plus.y - minus.y];
      // A vertical parting plane: the halves side by side (the upper one on the right); a horizontal one: one over the other.
      assert.ok(across ? dx > 2 * Math.abs(dy) : -dy > 2 * Math.abs(dx), `${label}: the draw direction ${across ? 'across' : 'upright on'} the screen (${dx}, ${dy})`);
    };
    await page.click('#view-casting');
    await view(g, true, 'gravity, vertical parting plane');
    assert.equal(await page.isHidden('#parting-process-change'), true, 'no change of process yet');
    await page.waitForTimeout(300);
    await shot(page, 'v-casting-gravity', '#viewport');

    // Low pressure chosen for the part: the view turned once its orientation is in, the change said; the blank and the halves the same.
    await page.click('[data-view="iso"]');
    await page.selectOption('#parting-process-select', 'horizontal-bas');
    await settled(page, 'Procédé : Basse pression — plan de joint horizontal, alimentation par le bas (choisi pour cette pièce)', '+Z');
    await page.waitForSelector('#parting-process-change:not([hidden])');
    assert.match(await page.textContent('#parting-process-change'),
      /^Procédé changé : haut de coulée \(-0\.342, 0\.94, 0\) → \+Z ; alimentation par le bas( \(\d+ points?\))? ; brut et chapes inchangés \(même direction de démoulage\)$/);
    await view([0, 0, 1], false, 'low pressure');
    assert.deepEqual(await outline(), { chapes, brut });
    await page.waitForTimeout(300);
    await shot(page, 'v-casting-low-pressure', '#viewport');
    await page.locator('#parting-process').scrollIntoViewIfNeeded();
    await shot(page, 'v-card-low-pressure', '#parting-card');
    // Its feed points once placed, from below.
    await page.waitForFunction(() => / \(\d+ points?\) ; /.test(document.getElementById('parting-process-change').textContent), null, { timeout: 60_000 });

    // Back to the costing's process (none retained: the default): the gravity die again, the view turned back.
    await page.click('[data-view="top"]');
    await page.click('#parting-process-reset');
    await settled(page, GRAVITY_DEFAULT, '(-0.342, 0.94, 0)');
    await page.waitForFunction(() => /^Procédé changé : haut de coulée \+Z → \(-0\.342, 0\.94, 0\) ; coulée par le haut/.test(document.getElementById('parting-process-change').textContent), null, { timeout: 60_000 });
    await view(g, true, 'gravity again');
    // Another up chosen by hand: the line no longer said (it was about the process).
    await page.selectOption('#parting-up', '-v');
    await page.waitForFunction(() => document.getElementById('parting-card').dataset.up === '(0.342, -0.94, 0)', null, { timeout: 60_000 });
    assert.equal(await page.isHidden('#parting-process-change'), true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a malformed entry kept in this browser: the process chosen all the same and kept; an error of the 3D page does not stop the costing', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    // Entries of another version or edited by hand: a part that is not an object, bodies that are not one.
    await page.evaluate(() => localStorage.setItem('reader3d.orientation.v1', JSON.stringify({
      parts: { stale: null, text: 'x', list: [1, 2], old: { bodies: 'x', savedAt: 'yesterday' }, kept: { bodies: { 0: null, 1: { process: { plan: 'horizontal', alimentation: 'haut' } } }, savedAt: 1 } },
    })));
    await open(page, stlFile('T.stl', tPart()));
    await settled(page, GRAVITY_DEFAULT, '-Z');
    await page.selectOption('#parting-process-select', 'horizontal-bas');
    await settled(page, 'Procédé : Basse pression — plan de joint horizontal, alimentation par le bas (choisi pour cette pièce)', '+X');
    // Kept for the part; the malformed entries left out, the others kept.
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.orientation.v1')));
    const ours = Object.entries(saved.parts).filter(([id]) => id.startsWith('sha256:'));
    assert.equal(ours.length, 1);
    assert.deepEqual(ours[0][1].bodies, { 0: { process: { plan: 'horizontal', alimentation: 'bas' } } });
    assert.deepEqual(Object.keys(saved.parts).filter((id) => !id.startsWith('sha256:')).sort(), ['kept', 'old']);
    assert.deepEqual([saved.parts.kept.bodies, saved.parts.old.bodies], [{ 1: { process: { plan: 'horizontal', alimentation: 'haut' } } }, {}]);
    // A 3D page that fails when told the island retained: the costing drawn all the same.
    await page.evaluate(() => {
      window.reader3d.setProcess = () => {
        throw new Error('3D page broken');
      };
    });
    await page.click('.tab[data-page="chiffrage"]');
    await setField(page, '#page-chiffrage [data-bind="q.client"]', 'ACME');
    await page.waitForFunction(() => document.querySelector('#page-chiffrage [data-bind="q.client"]')?.value === 'ACME');
    assert.match(await page.textContent('#page-chiffrage'), /Outillage/);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
