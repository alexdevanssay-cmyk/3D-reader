// End-to-end test of the slides (« tiroirs ») of the built site (dist/): the
// undercuts of the parting line shown grouped into slides in the parting
// line card (count, table, pull directions), coloured on the 3D view with an
// arrow each; zones edited by hand (a new slide, a merge, back to the
// proposal) and kept after a reload; the editing of the zones ended (the
// slides gone, a riser placed); a face reassigned (the half of the slide);
// two bodies (each its own selection); a closed cavity, a probable core; the
// semantic contract, the foundry screen and the AI context; the count
// proposed to « Tiroirs du moule » on the Chiffrage page, used by a click,
// traced, shown stale when the parting line changes, never replacing a value
// typed; a phone's width.
//
//   npm run build && node --test tests/e2e/slides.test.mjs

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
const CAD_TIMEOUT = 180_000;

/**
 * The card's body cast in a gravity die with a horizontal parting plane (the
 * process of the parting card; by default a vertical one, up across the draw
 * direction): up when cast along the draw direction, the risers on top along
 * it, as this test reads them. Kept for the part; once the risers are placed
 * for it.
 */
async function horizontalPlane(page, body = 0) {
  await page.selectOption('#parting-process-select', 'horizontal-haut');
  await page.waitForFunction((i) => window.reader3d.semantic?.bodies?.[i]?.feeding?.process?.plan === 'horizontal', body, { timeout: 120_000 });
}

/**
 * An OBJ of the union of cubes `size` mm (cells x, y, z of an nx × ny × nz
 * grid where filled(x, y, z)), each body a material (parting.test.mjs).
 */
function voxelsObj(bodies, [nx, ny, nz], size) {
  const lines = [];
  const faces = [];
  let count = 0;
  for (const [material, filled, offset = [0, 0, 0]] of bodies) {
    const at = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && filled(x, y, z);
    const ids = new Map();
    const vertex = (p) => {
      const key = p.join(',');
      if (!ids.has(key)) {
        lines.push(`v ${p.map((c, k) => c * size + offset[k]).join(' ')}`);
        ids.set(key, ++count);
      }
      return ids.get(key);
    };
    faces.push(`usemtl ${material}`);
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      if (!at(x, y, z)) continue;
      for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
        const q = [x, y, z];
        q[k] += s;
        if (at(...q)) continue;
        const a = (k + 1) % 3, b = (k + 2) % 3;
        const base = [x, y, z];
        if (s > 0) base[k] += 1;
        const corner = (da, db) => {
          const p = [...base];
          p[a] += da;
          p[b] += db;
          return vertex(p);
        };
        const quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
        faces.push(`f ${(s > 0 ? quad : quad.reverse()).join(' ')}`);
      }
    }
  }
  return Buffer.from([...lines, ...faces, ''].join('\n'));
}

/** A block 60 × 40 × 40 mm with two slots 10 wide, 10 high and 10 deep in its front face (y = 0), at x 10..20 and 40..50. */
const slotted = (x, y, z) => !(((x >= 2 && x < 4) || (x >= 8 && x < 10)) && y < 2 && z >= 3 && z < 5);
const twoSlots = () => voxelsObj([['a', slotted]], [12, 8, 8], 5);
/** Two of them, the second 100 mm along +X. */
const twoBlocks = () => voxelsObj([['a', slotted], ['b', slotted, [100, 0, 0]]], [12, 8, 8], 5);

/**
 * Pixels of the 3D view by colour (parting.test.mjs), and teal (the second
 * slide's colour, #00a6b8, shaded).
 */
async function viewColours(page) {
  await page.waitForTimeout(300); // a frame drawn
  const png = await page.locator('#viewport canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
    const n = { red: 0, yellow: 0, teal: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gr = data[i + 1], b = data[i + 2];
      if (r > 170 && gr < 80 && b < 80) n.red++;
      else if (r > 150 && gr > 120 && b < 80 && r - b > 100) n.yellow++;
      else if (gr > r + 60 && b > r + 60 && Math.abs(gr - b) < 60) n.teal++;
    }
    return n;
  }, png.toString('base64'));
}

/** What the card says of the slides: its datasets, the summary, the status, the rows (a list: its choice). */
const slidesCard = (page) => page.evaluate(() => {
  const card = document.getElementById('parting-card');
  const text = (id) => (document.getElementById(id).hidden ? '' : document.getElementById(id).textContent);
  return {
    status: card.dataset.slideStatus ?? '',
    slides: card.dataset.slides ?? '',
    cores: card.dataset.slideCores ?? '',
    arrows: card.dataset.slideArrows ?? '',
    colours: card.dataset.slideColours ?? '',
    left: Number(card.dataset.slideLeft || 0),
    undercuts: card.dataset.undercuts ?? '',
    overlay: card.dataset.overlay ?? '',
    peek: document.getElementById('slides-peek').textContent,
    title: document.querySelector('#slides > summary > span').textContent,
    text: text('slides-status'),
    origin: text('slides-origin'),
    hint: text('slides-hint'),
    rows: [...document.querySelectorAll('#slides-table tbody tr')].map((tr) => [...tr.cells].map((c) => c.querySelector('select')?.selectedOptions[0]?.textContent ?? c.textContent)),
    stats: Object.fromEntries([...document.querySelectorAll('#slides-stats dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
  };
});

/** The slides ready for the definition shown (`count`: that many). */
const slidesReady = (page, count = null) => page.waitForFunction((n) => {
  const card = document.getElementById('parting-card');
  return card.dataset.slideStatus === 'ready' && (n === null || card.dataset.slides === String(n));
}, count, { timeout: 60_000 });

/** Σ of the triangles of each colour + those left yellow = the undercut triangles (data-undercuts). */
const colourSum = (shown) => shown.colours.split(' ').filter(Boolean).reduce((n, x) => n + Number(x.split(':')[1]), 0) + shown.left;

describe('slides (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;
  let dir;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'slides-'));
    writeFileSync(join(dir, 'chiffrage.xlsm'), costingWorkbook());
    server = createStaticServer(DIST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A page in French, its errors kept; `query`: more parameters of its address. */
  async function newPage(viewport = { width: 1280, height: 900 }, query = '') {
    const context = await browser.newContext({ locale: 'fr-FR', viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr${query}`);
    return { context, page, errors };
  }

  async function open(page, file) {
    if (typeof file === 'string') await page.setInputFiles('#file-input', fixturePath(file));
    else await page.setInputFiles('#file-input', file);
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
  }

  const candidate = async (page, axis, origin = 'manuel') => {
    await page.click(`#parting-candidates tr[data-candidate] >> text=${axis}`);
    await page.waitForFunction(([a, o]) => document.getElementById('parting-axis').textContent === a && document.getElementById('parting-origin').textContent === o, [axis, origin], { timeout: 30_000 });
  };

  test('a block with a hole: none along the hole, one slide across it; coloured with its arrow; the exports', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await open(page, 'holed_block.step');
    // Proposed along the hole: no undercut, no slide.
    await slidesReady(page, 0);
    let shown = await slidesCard(page);
    assert.deepEqual([shown.status, shown.slides, shown.cores, shown.text], ['ready', '0', '0', 'Aucune contre-dépouille : aucun tiroir.']);
    assert.equal(await page.isHidden('#slides-main'), true);

    // Across the hole: one slide along the hole, out of its top.
    await candidate(page, 'X');
    await slidesReady(page, 1);
    shown = await slidesCard(page);
    assert.equal(shown.peek, '1 tiroir(s) · 0 noyau(x) probable(s)');
    assert.equal(shown.title, 'Tiroirs et noyaux');
    assert.equal(shown.origin, 'proposés');
    assert.equal(shown.rows.length, 1);
    assert.deepEqual(shown.rows[0].slice(0, 2), ['T1', '+Z (100 %)']);
    assert.deepEqual(shown.rows[0].slice(2), ['25 mm', '20 × 20 mm', '1']);
    // Its other pull direction: down the hole.
    assert.deepEqual(await page.$$eval('#slides-table select option', (os) => os.map((o) => o.textContent)), ['+Z (100 %)', '−Z (100 %)']);
    assert.deepEqual(shown.stats, {});

    // Shown on the 3D view: the halves and the line as before; the slide in its colour (the yellow of the undercuts), its arrow.
    await page.check('#parting-show');
    shown = await slidesCard(page);
    assert.equal(shown.overlay, 'lower upper line');
    assert.equal(shown.arrows, '1');
    assert.match(shown.colours, /^T1:\d+$/);
    assert.equal(colourSum(shown), Number(shown.undercuts));
    assert.match(await page.textContent('#parting-legend'), /^ligne de joint contre-dépouille .* tiroirs T1, T2… \(flèche : direction de sortie\) noyau probable/);
    // « Tiroirs » unchecked: the undercuts in yellow as before, no arrow.
    const undercuts = shown.undercuts;
    await page.uncheck('#parting-slides-show');
    shown = await slidesCard(page);
    assert.deepEqual([shown.arrows, shown.colours, shown.undercuts, shown.overlay], ['0', '', undercuts, 'lower upper line']);
    assert.doesNotMatch(await page.textContent('#parting-legend'), /tiroirs T1/);
    await page.check('#parting-slides-show');
    assert.equal((await slidesCard(page)).arrows, '1');

    // The semantic contract, the foundry screen, the AI context.
    const s = await page.evaluate(() => {
      const body = window.reader3d.semantic.bodies[0];
      const ai = window.reader3d.aiContext().bodies[0];
      return { slides: body.slides, rules: body.foundry.rules, risks: body.foundry.risks.map((r) => r.code), ai: ai.slides, parting: ai.parting };
    });
    assert.deepEqual([s.slides.status, s.slides.count, s.slides.cores, s.slides.slides[0].axis, s.slides.slides[0].stroke_mm], ['proposed', 1, 0, 'Z', 25]);
    assert.deepEqual(s.slides.parting, { axis: 'X', status: 'manual', source: 'candidate', direction: [1, 0, 0] });
    assert.match(s.slides.signature, /^s1:\d+:\d+:[0-9a-f]{8}#[0-9a-f]{8}$/);
    assert.equal(s.rules.slides, 'proposed_from_undercut_regions');
    assert.equal(s.rules.cores, 'undercuts_detected');
    assert.ok(s.risks.includes('slides_proposed') && s.risks.includes('undercut_requires_core_or_slide'));
    assert.equal(s.ai.count, 1);
    assert.deepEqual(Object.keys(s.parting).sort(), ['axis', 'direction', 'planar', 'status', 'undercut_share', 'zero_draft_share']);
    // What the costing reads.
    const brief = await page.evaluate(() => window.reader3d.part().parts[0].slides);
    assert.deepEqual([brief.status, brief.count, brief.parting, brief.slides.map((x) => [x.id, x.reference_axis, x.stroke_mm])], ['ready', 1, { axis: 'X', status: 'manual', source: 'candidate' }, [['T1', '+Z', 25]]]);

    // In English.
    await page.selectOption('#language', 'en');
    shown = await slidesCard(page);
    assert.deepEqual([shown.title, shown.peek, shown.origin], ['Slides and cores', '1 slide(s) · 0 probable core(s)', 'proposed']);
    assert.equal(await page.textContent('label:has(#parting-slides-show)'), ' Slides');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('zones edited by hand: a new slide, kept after a reload, merged, back to the proposal', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    const file = { name: 'two_slots.obj', mimeType: 'text/plain', buffer: twoSlots() };
    await open(page, file);
    await candidate(page, 'Z');
    await slidesReady(page, 1);
    let shown = await slidesCard(page);
    assert.deepEqual(shown.rows, [['T1', '−Y', '15 mm', '40 × 10 mm', '2']]);

    // The zones edited on the 3D view, seen from the front: the back wall of the second slot.
    await page.click('[data-view="front"]');
    await page.click('#slides-edit');
    assert.equal(await page.isChecked('#parting-show'), true, 'shown to be clicked');
    assert.equal(await page.textContent('#slides-hint'), 'Cliquez une zone colorée de la pièce.');
    const at = await page.evaluate(() => window.reader3d.screenOf([45, 10, 20]));
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#slides-zone:not([hidden])');
    assert.match(await page.textContent('#slides-zone'), /^Zone 2 : 5 cm², profondeur 10 mm, libérée par −Y/);
    // Its own slide.
    await page.selectOption('#slides-zone-to', 'new');
    await slidesReady(page, 2);
    shown = await slidesCard(page);
    assert.equal(shown.origin, 'modifiés à la main');
    assert.deepEqual(shown.rows.map((r) => r.slice(0, 3)), [['T1', '−Y', '15 mm'], ['T2', '−Y', '15 mm']]);
    assert.match(shown.colours, /^T1:\d+ T2:\d+$/);
    assert.equal(colourSum(shown), Number(shown.undercuts));
    assert.equal(shown.arrows, '2');
    // Out of the editing (Esc): the second slide teal on the view.
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('slides-edit').classList.contains('active')), false);
    const colours = await viewColours(page);
    assert.ok(colours.teal > 300, `the second slide teal: ${JSON.stringify(colours)}`);
    assert.ok(colours.red > 200, `the parting line still red: ${JSON.stringify(colours)}`);
    // The semantic contract: edited by hand.
    const edited = await page.evaluate(() => window.reader3d.semantic.bodies[0].slides);
    assert.deepEqual([edited.status, edited.count, edited.proposed, edited.edited], ['manual', 2, { count: 1, cores: 0 }, { zones: 2, slides: 2 }]);
    assert.equal(await page.evaluate(() => window.reader3d.semantic.bodies[0].foundry.rules.slides), 'edited_manually');

    // Kept in this browser for this part: the same file opened again after a reload.
    await page.reload();
    await open(page, file);
    await page.waitForFunction(() => document.getElementById('parting-axis').textContent === 'Z', null, { timeout: 30_000 });
    await slidesReady(page, 2);
    assert.equal((await slidesCard(page)).origin, 'modifiés à la main');

    // The first slide selected, merged with the second one (a pull direction common to all their zones).
    await page.click('#slides-table tr[data-slide] td:first-child >> nth=0');
    await page.waitForSelector('#slides-slide:not([hidden])');
    assert.match(await page.textContent('#slides-slide'), /^T1 — −Y, course 15 mm, 1 zone\(s\), 5 cm², /);
    const other = await page.$eval('#slides-merge option:not([value=""])', (o) => o.value);
    await page.selectOption('#slides-merge', other);
    await slidesReady(page, 1);
    assert.deepEqual((await slidesCard(page)).rows.map((r) => r.slice(0, 5)), [['T1', '−Y', '15 mm', '40 × 10 mm', '2']]);

    // Back to the proposal: kept as chosen (an explicit entry, not the edits again on the next reload).
    await page.click('#slides-reset');
    await page.waitForFunction(() => document.getElementById('slides-origin').textContent === 'proposés');
    shown = await slidesCard(page);
    assert.deepEqual([shown.slides, shown.rows.length, shown.rows[0][4]], ['1', 1, '2']);
    assert.equal(await page.isDisabled('#slides-reset'), true);
    const sig = await page.evaluate(() => window.reader3d.semantic.bodies[0].slides.signature.split('#')[0]);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('reader3d.slides.v1')));
    const entries = Object.values(kept)[0].bodies[0];
    assert.equal(entries[0].sig, sig);
    assert.equal(entries[0].state, null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the zones edited: no longer once the slides are gone (the card folded leaves the view), nor once a riser is placed (the zones coloured again); a face reassigned, the half of the slide', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await open(page, { name: 'two_slots.obj', mimeType: 'text/plain', buffer: twoSlots() });
    // The riser placed on top along Z, not on the front face before the camera.
    await horizontalPlane(page);
    await candidate(page, 'Z');
    await slidesReady(page, 1);
    const active = (id) => page.evaluate((x) => document.getElementById(x).classList.contains('active'), id);
    const exported = () => page.evaluate(() => window.reader3d.semantic.bodies[0].slides);
    let slides = await exported();
    assert.deepEqual(slides.slides.map((x) => x.half), ['upper']);

    // A zone picked, the other one greyed; a riser to place: the editing ends, the zones in their colours again.
    await page.click('[data-view="front"]');
    await page.click('#slides-edit');
    const all = await viewColours(page);
    const at = await page.evaluate(() => window.reader3d.screenOf([45, 10, 20]));
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#slides-zone:not([hidden])');
    const picked = await viewColours(page);
    assert.ok(picked.yellow < 0.7 * all.yellow, `the other zone greyed: ${picked.yellow} of ${all.yellow}`);
    await page.click('#feeding-add');
    assert.deepEqual([await active('slides-edit'), await page.isHidden('#slides-zone')], [false, true]);
    const placing = await viewColours(page);
    assert.ok(placing.yellow > 0.95 * all.yellow, `coloured again: ${placing.yellow} of ${all.yellow}`);
    await page.click('#feeding-add');

    // The front face (no undercut) moved to the lower half: the same undercuts, the slide now in the lower half.
    await page.click('#parting-assign');
    assert.equal(await page.inputValue('#parting-target'), '2');
    const front = await page.evaluate(() => window.reader3d.screenOf([30, 0, 5]));
    await page.mouse.click(front.x, front.y);
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 30_000 });
    await page.click('#parting-assign');
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].slides?.slides?.[0]?.half === 'lower', null, { timeout: 60_000 });
    const after = await exported();
    assert.equal(after.signature, slides.signature, 'the same undercuts');
    await page.click('#slides-table tr[data-slide] td:first-child');
    assert.match(await page.textContent('#slides-slide'), /, chape inférieure/);

    // Editing the zones, then the parting line back to its proposal (along Y, no undercut): no longer pressed; the
    // overlay hidden, the card folded and opened again leaves it hidden.
    await page.click('#slides-edit');
    assert.equal(await active('slides-edit'), true);
    await page.click('#parting-reset');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'proposé', null, { timeout: 30_000 });
    await slidesReady(page, 0);
    assert.equal(await active('slides-edit'), false);
    await page.uncheck('#parting-show');
    await page.click('#parting-card .card-toggle');
    await page.click('#parting-card .card-toggle');
    assert.equal(await page.isChecked('#parting-show'), false);
    assert.equal((await slidesCard(page)).overlay, '');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('two bodies: the slide selected and the zone picked stay with their body', { timeout: 2 * CAD_TIMEOUT }, async () => {
    // Every body checked (a file of several bodies shows its largest one alone by default): both shown.
    const { context, page, errors } = await newPage(undefined, '&bodies=all');
    await open(page, { name: 'two_blocks.obj', mimeType: 'text/plain', buffer: twoBlocks() });
    const body = async (i) => {
      await page.click(`#bodies tr[data-index="${i}"] td.name`);
      await page.waitForFunction((k) => document.querySelector('#bodies tr.selected')?.dataset.index === String(k), i);
    };
    await body(1);
    await candidate(page, 'Z');
    await slidesReady(page, 1);
    await body(0);
    await candidate(page, 'Z');
    await slidesReady(page, 1);
    // On the first body: T1 selected, the zones edited, zone 2 picked.
    await page.click('#slides-table tr[data-slide] td:first-child');
    await page.waitForSelector('#slides-slide:not([hidden])');
    await page.click('[data-view="front"]');
    await page.click('#slides-edit');
    const at = await page.evaluate(() => window.reader3d.screenOf([window.reader3d.result.bodies[0].bbox.min[0] + 45, 10, 20]));
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('#slides-zone:not([hidden])');
    // The other body: its own slide, nothing selected nor picked on it.
    await body(1);
    await slidesReady(page, 1);
    const shown = await page.evaluate(() => ({
      selected: document.querySelectorAll('#slides-table tr.selected').length,
      slide: document.getElementById('slides-slide').hidden,
      zone: document.getElementById('slides-zone').hidden,
      hint: document.getElementById('slides-hint').textContent,
    }));
    assert.deepEqual(shown, { selected: 0, slide: true, zone: true, hint: 'Cliquez une zone colorée de la pièce.' });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a closed cavity: a probable core, not a slide', { timeout: CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await open(page, 'cube_with_void.stl');
    await slidesReady(page, 0);
    const shown = await slidesCard(page);
    assert.equal(shown.peek, '0 tiroir(s) · 1 noyau(x) probable(s)');
    assert.equal(shown.cores, '1');
    assert.deepEqual(shown.stats, { 'Noyaux probables (non comptés comme tiroirs)': '1 (1,5 cm²) : cavité fermée' });
    await page.check('#parting-show');
    const painted = await slidesCard(page);
    assert.match(painted.colours, /^N:\d+$/);
    assert.equal(colourSum(painted), Number(painted.undercuts));
    assert.equal(painted.arrows, '0');
    const risks = await page.evaluate(() => window.reader3d.semantic.bodies[0].foundry.risks.map((r) => [r.code, r.severity]));
    assert.deepEqual(risks.filter(([code]) => ['probable_sand_core', 'enclosed_cavity', 'slides_proposed'].includes(code)), [['probable_sand_core', 'review'], ['enclosed_cavity', 'high']]);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the costing: the count proposed under « Tiroirs du moule », used by a click, traced, stale, never replacing a value typed', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage();
    await open(page, 'holed_block.step');
    await candidate(page, 'X');
    await slidesReady(page, 1);
    // The costing workbook, the island CG3 imposed (an in-house die).
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForSelector('#page-chiffrage .ccard');
    await page.setInputFiles('#page-chiffrage input[data-file="workbook"]', join(dir, 'chiffrage.xlsm'));
    await page.waitForSelector('#page-chiffrage .cmsg.ok');
    await page.selectOption('#page-chiffrage [data-bind="p.procede"]', 'CG3');
    await page.waitForSelector('#page-chiffrage [data-slides-3d]');
    const line = () => page.textContent('#page-chiffrage [data-slides-3d]');
    const field = () => page.inputValue('#page-chiffrage [data-bind="p.outillageTiroirs"]');
    const traceRow = async () => {
      if (!(await page.isVisible('#page-chiffrage #ctrace details[open] table'))) {
        await page.click('#page-chiffrage [data-action="show-trace"]');
        await page.waitForSelector('#page-chiffrage #ctrace details[open] table');
      }
      return page.locator('#page-chiffrage #ctrace tr', { hasText: 'piece.outillage.tiroirs' }).first().textContent();
    };
    assert.equal(await line(), 'Analyse 3D : 1 tiroir par pièce (T1 +Z, course 25 mm), plan de joint X défini à la main. Utiliser 1 tiroir');
    assert.equal(await field(), '');
    assert.match(await traceRow(), /sources divergentes/);

    // Used: the field holds it, traced « analyse 3D validée ».
    await page.click('#page-chiffrage [data-action="use-slides-3d"]');
    await page.waitForFunction(() => /analyse 3D validée le/.test(document.querySelector('#page-chiffrage [data-slides-3d]')?.textContent ?? ''));
    assert.equal(await field(), '1');
    assert.match(await line(), /^1 tiroir : analyse 3D validée le \d\d\/\d\d\/\d{4} \(1 par pièce, plan de joint X défini à la main\)\. Ne plus utiliser l'analyse 3D$/);
    assert.match(await page.textContent('#page-chiffrage .cmsg.ok'), /^Tiroirs du moule : 1, analyse 3D validée \(T1 \+Z ; 1 × 1 empreinte\)\. Avant : vide \(défaut 0\)\./);
    let row = await traceRow();
    assert.match(row, /analyse 3D validée/);
    assert.doesNotMatch(row, /sources divergentes/);

    // The parting line back to its proposal on the 3D page: no slide now; the value stays 1, shown stale.
    await page.click('.tab[data-page="viewer"]');
    await page.click('#parting-reset');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'proposé', null, { timeout: 30_000 });
    await slidesReady(page, 0);
    await page.click('.tab[data-page="chiffrage"]');
    await page.waitForFunction(() => /propose maintenant/.test(document.querySelector('#page-chiffrage [data-slides-3d]')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.match(await line(), /^⚠ L'analyse 3D propose maintenant 0 tiroir \(validés : 1 le \d\d\/\d\d\/\d{4}\) : plan de joint, tiroirs ou empreintes modifiés depuis\. La valeur reste 1\. Utiliser 0 tiroir Garder 1$/);
    assert.equal(await field(), '1');
    row = await traceRow();
    assert.match(row, /sources divergentes/);
    assert.match(row, /analyse 3D modifiée depuis la validation/);

    // « Garder 1 »: a value typed, the analysis beside it.
    await page.click('#page-chiffrage [data-action="keep-slides-3d"]');
    await page.waitForFunction(() => !/propose maintenant/.test(document.querySelector('#page-chiffrage [data-slides-3d]')?.textContent ?? ''));
    row = await traceRow();
    assert.match(row, /saisie du devis/);
    assert.match(await line(), /^Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé \(saisi : 1\)\./);

    // A value typed: never replaced.
    await page.fill('#page-chiffrage [data-bind="p.outillageTiroirs"]', '2');
    await page.dispatchEvent('#page-chiffrage [data-bind="p.outillageTiroirs"]', 'change');
    await page.waitForFunction(() => /saisi : 2/.test(document.querySelector('#page-chiffrage [data-slides-3d]')?.textContent ?? ''));
    assert.match(await line(), /^Analyse 3D : 0 tiroir par pièce, plan de joint Z proposé \(saisi : 2\)\. Utiliser 0 tiroir$/);
    assert.equal(await field(), '2');
    // The semantic contract and the AI context carry the slides.
    const ai = await page.evaluate(() => [window.reader3d.semantic.bodies[0].slides.count, window.reader3d.aiContext().bodies[0].slides.count]);
    assert.deepEqual(ai, [0, 0]);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a phone: the card within the page, the table of the slides scrolls inside it', { timeout: CAD_TIMEOUT }, async () => {
    const { context, page, errors } = await newPage({ width: 390, height: 844 });
    await open(page, { name: 'two_slots.obj', mimeType: 'text/plain', buffer: twoSlots() });
    await candidate(page, 'Z');
    await slidesReady(page, 1);
    await page.click('#slides-table tr[data-slide] td:first-child');
    await page.waitForSelector('#slides-slide:not([hidden])');
    const sizes = await page.evaluate(() => {
      const scroll = document.querySelector('.slides-scroll');
      const page = () => document.documentElement.scrollWidth;
      const before = { page: page(), scroll: scroll.scrollWidth, client: scroll.clientWidth };
      // A row wider than the phone (a slide with all its tags): it scrolls inside the table's box, not the page.
      document.querySelector('#slides-table tbody td').insertAdjacentHTML('beforeend', '<span class="slide-tag">aussi formable par une chape</span>'.repeat(4));
      const wide = { page: page(), scroll: scroll.scrollWidth, client: scroll.clientWidth };
      return { before, wide, inner: innerWidth, overflow: getComputedStyle(scroll).overflowX, open: document.getElementById('slides').open };
    });
    assert.equal(sizes.open, true);
    assert.equal(sizes.overflow, 'auto');
    assert.ok(sizes.before.page <= sizes.inner && sizes.before.scroll <= sizes.before.client, JSON.stringify(sizes));
    assert.ok(sizes.wide.scroll > sizes.wide.client && sizes.wide.page <= sizes.inner, JSON.stringify(sizes));
    const wide = await page.evaluate(() => [...document.querySelectorAll('#slides *')].filter((x) => x.offsetParent && !x.closest('.slides-scroll') && x.getBoundingClientRect().right > innerWidth + 0.5).map((x) => x.id || x.className || x.tagName));
    assert.deepEqual(wide, []);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
