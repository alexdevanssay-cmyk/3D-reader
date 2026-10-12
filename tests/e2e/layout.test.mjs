// End-to-end test of the side panel of the "3D analysis" page of the built site
// (dist/): each card folds to its title (the chevron, a click on the title, the
// keyboard), the controls of its head still at hand and never folding it, its
// key value beside the title; kept after a reload, shown folded after the next
// analysis; "Collapse all" / "Expand all"; English and French. Folding a card
// stops a mode of the 3D view started from it; the folded thickness shows the
// thinnest wall the quote uses; the warning of an open body stays in sight. The
// panel's width set by dragging the splitter, the 3D view following as it goes
// (never a blank frame), within limits, the thickness scale drawn again without
// computing the thicknesses again; back to the default width on a double-click;
// from the keyboard; kept after a reload and fitted to a smaller window; no
// splitter on a narrow window (the panel under the view).
//
//   npm run build && node --test tests/e2e/layout.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, fixturePath } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const TIMEOUT = 120_000;
const CARDS = ['summary-card', 'mass-card', 'thickness-card', 'bodies-card', 'parting-card', 'feeding-card', 'memory-card'];

/** An OBJ of two bodies: a closed cube of 20 mm (material a) and an open square sheet above it (material b). */
function cubeAndSheetObj() {
  const lines = [];
  const faces = [];
  let count = 0;
  const vertex = (x, y, z) => {
    lines.push(`v ${x} ${y} ${z}`);
    return ++count;
  };
  const v = [];
  for (let i = 0; i < 8; i++) v.push(vertex(i & 1 ? 20 : 0, i & 2 ? 20 : 0, i & 4 ? 20 : 0));
  faces.push('usemtl a');
  // Counter-clockwise seen from outside.
  for (const q of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) faces.push(`f ${q.map((k) => v[k]).join(' ')}`);
  const sheet = [[0, 0], [20, 0], [20, 20], [0, 20]].map(([x, y]) => vertex(x, y, 40));
  faces.push('usemtl b', `f ${sheet.join(' ')}`);
  return Buffer.from([...lines, ...faces, ''].join('\n'));
}

describe('3D analysis panel: folded cards, width (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
  let server;
  let base;
  let browser;

  before(async () => {
    server = createStaticServer(DIST);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  });

  after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  async function newPage() {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { page, errors };
  }

  async function analyse(page) {
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
  }

  const folded = (page, id) => page.evaluate((card) => document.getElementById(card).classList.contains('is-collapsed'), id);
  const toggleOf = (page, id) => page.evaluate((card) => {
    const button = document.querySelector(`#${card} > .card-head > .card-toggle`);
    return button && { expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'), title: button.title, name: document.getElementById(button.getAttribute('aria-labelledby'))?.textContent };
  }, id);

  test('cards fold to their title: chevron, title, keyboard; head controls kept; remembered', { timeout: 3 * TIMEOUT }, async () => {
    const { page, errors } = await newPage();
    await page.goto(base);

    // Every card of the panel: a chevron at the start of its head, named by the title, unfolded.
    for (const id of CARDS) assert.deepEqual(await toggleOf(page, id), { expanded: 'true', controls: id, title: 'Collapse', name: (await page.textContent(`#${id} h3`)) }, id);
    // No card shown yet: no "Collapse all".
    assert.equal(await page.isVisible('.panel-fold-all'), false);

    await analyse(page);
    assert.equal(await page.textContent('.panel-fold-all'), 'Collapse all');

    // The chevron folds the summary: its head only, the unit list still there and usable.
    await page.click('#summary-card .card-toggle');
    assert.equal(await folded(page, 'summary-card'), true);
    assert.deepEqual(await toggleOf(page, 'summary-card'), { expanded: 'false', controls: 'summary-card', title: 'Expand', name: 'Real volume' });
    assert.equal(await page.isVisible('#total-volume'), false);
    assert.equal(await page.isVisible('#bbox-size'), false);
    assert.equal(await page.isVisible('#vol-unit'), true);
    // The volume beside the title, following the unit chosen in the head.
    assert.equal(await page.textContent('#summary-card .card-peek'), await page.textContent('#total-volume'));
    assert.equal(await page.isVisible('#summary-card .card-peek'), true);
    await page.selectOption('#vol-unit', 'mm3');
    assert.equal(await folded(page, 'summary-card'), true, 'a control of the head does not unfold the card');
    await page.waitForFunction(() => document.querySelector('#summary-card .card-peek').textContent === document.getElementById('total-volume').textContent);
    assert.match(await page.textContent('#summary-card .card-peek'), /mm³$/);
    // Compact: the head only.
    const height = await page.evaluate(() => document.getElementById('summary-card').getBoundingClientRect().height);
    assert.ok(height < 60, `folded card ${height} px high`);

    // A click on the title folds the bodies; their export buttons stay and do not unfold them.
    await page.click('#bodies-card h3');
    assert.equal(await folded(page, 'bodies-card'), true);
    assert.equal(await page.isVisible('table.bodies'), false);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-json')]);
    assert.match(download.suggestedFilename(), /\.json$/);
    assert.equal(await folded(page, 'bodies-card'), true);
    await page.click('#bodies-card h3');
    assert.equal(await folded(page, 'bodies-card'), false);
    assert.equal(await page.isVisible('table.bodies'), true);

    // The keyboard: Enter and Space on the chevron.
    await page.focus('#mass-card .card-toggle');
    await page.keyboard.press('Enter');
    assert.equal(await folded(page, 'mass-card'), true);
    assert.equal(await page.isVisible('#material'), false);
    assert.equal(await page.textContent('#mass-card .card-peek'), await page.textContent('#mass'));
    await page.keyboard.press('Space');
    assert.equal(await folded(page, 'mass-card'), false);
    assert.equal(await page.isVisible('#material'), true);
    await page.click('#mass-card h3');
    assert.equal(await folded(page, 'mass-card'), true);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('reader3d.panel.collapsed'))).sort(), ['mass-card', 'summary-card']);

    // Kept after a reload: folded before the analysis, and when the cards are shown by it.
    await page.reload();
    assert.equal(await folded(page, 'summary-card'), true);
    assert.equal(await folded(page, 'mass-card'), true);
    assert.equal(await folded(page, 'bodies-card'), false);
    await analyse(page);
    assert.equal(await page.isVisible('#summary-card'), true);
    assert.equal(await folded(page, 'summary-card'), true);
    assert.equal(await page.isVisible('#total-volume'), false);
    assert.equal(await page.isVisible('#vol-unit'), true);
    assert.equal(await page.isVisible('table.bodies'), true);

    // Collapse all, expand all (the cards shown).
    const shown = () => page.evaluate(() => [...document.querySelectorAll('#page-viewer .panel > section.card')].filter((c) => !c.hidden).map((c) => [c.id, c.classList.contains('is-collapsed')]));
    await page.click('.panel-fold-all');
    assert.ok((await shown()).every(([, f]) => f), JSON.stringify(await shown()));
    assert.equal(await page.textContent('.panel-fold-all'), 'Expand all');
    // In French.
    await page.selectOption('#language', 'fr');
    assert.equal(await page.textContent('.panel-fold-all'), 'Tout déplier');
    assert.equal(await page.getAttribute('#summary-card .card-toggle', 'title'), 'Déplier');
    assert.equal(await page.getAttribute('.panel-splitter', 'aria-label'), 'Largeur du panneau');
    assert.match(await page.getAttribute('.panel-splitter', 'title'), /^Largeur du panneau : glissez pour ajuster, double-clic pour revenir à la largeur par défaut/);
    await page.click('.panel-fold-all');
    assert.ok((await shown()).every(([, f]) => !f), JSON.stringify(await shown()));
    assert.equal(await page.textContent('.panel-fold-all'), 'Tout replier');
    assert.equal(await page.getAttribute('#summary-card .card-toggle', 'title'), 'Replier');
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.panel.collapsed')), null);

    // Only on the 3D analysis page.
    await page.click('[data-page="parametres"]');
    assert.equal(await page.isVisible('.panel-splitter'), false);
    assert.equal(await page.locator('#page-parametres .card-toggle').count(), 0);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('folded: a mode of the 3D view stops, the thinnest wall used is shown, an open body\'s warning stays', { timeout: 3 * TIMEOUT }, async () => {
    const { page, errors } = await newPage();
    await page.goto(base);
    await analyse(page);
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: TIMEOUT });
    await page.waitForSelector('#feeding-main:not([hidden])', { timeout: TIMEOUT });
    const active = (id) => page.evaluate((button) => document.getElementById(button).classList.contains('active'), id);
    const selected = () => page.$$eval('#bodies tr.selected', (trs) => trs.length);
    const clickPart = async () => {
      const box = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    assert.equal(await page.textContent('#parting-origin'), 'proposed');
    const risers = await page.textContent('#feeding-count');
    const feedingOrigin = await page.textContent('#feeding-origin');

    // Reassigning faces, then the card folded by its chevron: the mode stops with its button and its hint out of
    // sight, and a click on the part selects it, the parting line as proposed.
    await page.click('#parting-assign');
    assert.equal(await page.isVisible('#parting-hint'), true);
    await page.click('#parting-card .card-toggle');
    assert.equal(await active('parting-assign'), false);
    await clickPart();
    assert.equal(await selected(), 1);
    assert.equal(await page.textContent('#parting-origin'), 'proposed');
    assert.equal(await page.isDisabled('#parting-reset'), true);
    await page.click('#parting-card .card-toggle');
    assert.equal(await page.isVisible('#parting-hint'), false);
    assert.equal(await active('parting-assign'), false);
    // Adding a riser, then "Collapse all": no riser added by the next click.
    await page.click('#feeding-add');
    assert.equal(await active('feeding-add'), true);
    await page.click('.panel-fold-all');
    assert.equal(await active('feeding-add'), false);
    await clickPart();
    assert.equal(await page.textContent('#feeding-count'), risers);
    assert.equal(await page.textContent('#feeding-origin'), feedingOrigin);
    await page.click('.panel-fold-all');

    // The thinnest wall typed in for the quote: beside the folded title in place of the one detected.
    await page.click('#thick-compute');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: TIMEOUT });
    const detected = await page.textContent('#thick-min');
    assert.match(detected, /^\d+(\.\d+)? mm$/);
    await page.fill('#thick-min-used', '2.5');
    await page.press('#thick-min-used', 'Tab');
    await page.waitForFunction(() => document.getElementById('thick-min').classList.contains('overridden'));
    await page.click('#thickness-card .card-toggle');
    const peek = () => page.evaluate(() => {
      const el = document.querySelector('#thickness-card .card-peek');
      return { text: el.textContent, title: el.title, shown: !el.hidden };
    });
    assert.deepEqual(await peek(), { text: '2.5 mm', title: 'Thinnest wall used', shown: true });
    await page.selectOption('#language', 'fr');
    assert.deepEqual(await peek(), { text: '2,5 mm', title: 'Toile mini prise en compte', shown: true });
    await page.selectOption('#language', 'en');
    // Back to the one detected.
    await page.click('#thickness-card .card-toggle');
    await page.fill('#thick-min-used', '');
    await page.press('#thick-min-used', 'Tab');
    await page.waitForFunction(() => !document.getElementById('thick-min').classList.contains('overridden'));
    await page.click('#thickness-card .card-toggle');
    assert.deepEqual(await peek(), { text: detected, title: '', shown: true });

    // The summary folded: no warning for a part whose bodies are all closed...
    await page.click('#summary-card .card-toggle');
    assert.equal(await page.isVisible('#method'), false);
    // ... the one of a part with an open body left out of the volume, kept under the folded title.
    await page.setInputFiles('#file-input', { name: 'cube_and_sheet.obj', mimeType: 'text/plain', buffer: cubeAndSheetObj() });
    await page.waitForFunction(() => document.body.dataset.status === 'done' && document.getElementById('body-count').textContent.includes('open'), null, { timeout: TIMEOUT });
    assert.equal(await folded(page, 'summary-card'), true);
    assert.equal(await page.isVisible('#summary-card .card-peek'), true);
    assert.equal(await page.isVisible('#total-volume'), false);
    assert.equal(await page.isVisible('#method.warn'), true);
    assert.match(await page.textContent('#method'), /1 open body\/bodies excluded from the volume/);
    const height = await page.evaluate(() => document.getElementById('summary-card').getBoundingClientRect().height);
    assert.ok(height < 110, `folded card with its warning ${height} px high`);
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('panel width: dragged within limits, the 3D view following; double-click, keyboard, reload, window resized, narrow window', { timeout: 2 * TIMEOUT }, async () => {
    const { page, errors } = await newPage();
    await page.goto(base);
    await analyse(page);
    await page.click('#thick-compute');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: TIMEOUT });
    // Watched while the splitter is dragged: the thicknesses computed again (the share of the band written again),
    // the 3D view blank in the frame where it changed size (its centre, on the part, cleared).
    await page.evaluate(() => {
      window.watched = { shares: 0, frames: 0, blank: 0 };
      new MutationObserver((records) => (window.watched.shares += records.length)).observe(document.getElementById('thick-share'), { childList: true, characterData: true, subtree: true });
      const canvas = document.querySelector('#viewport canvas');
      const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      // Called after those of app.js (observers are called in the order they were made).
      new ResizeObserver(() => {
        probe.clearRect(0, 0, 1, 1);
        probe.drawImage(canvas, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, 0, 0, 1, 1);
        window.watched.frames += 1;
        if (probe.getImageData(0, 0, 1, 1).data[3] === 0) window.watched.blank += 1;
      }).observe(document.getElementById('viewport'));
    });
    const watched = () => page.evaluate(() => window.watched);
    // The thickness scale drawn at the width it is shown.
    const scaleFits = () => page.waitForFunction(() => {
      const canvas = document.getElementById('thick-scale');
      return canvas.clientWidth > 0 && canvas.width === Math.round(canvas.clientWidth * devicePixelRatio);
    });
    const width = () => page.evaluate(() => Math.round(document.querySelector('#page-viewer > .panel').getBoundingClientRect().width));
    // The canvas drawn at the size it is shown: never stretched.
    const view = () => page.evaluate(() => {
      const canvas = document.querySelector('#viewport canvas');
      return { shown: canvas.clientWidth, drawn: canvas.width / devicePixelRatio, viewport: document.getElementById('viewport').clientWidth };
    });
    const splitter = page.locator('.panel-splitter');
    const value = () => splitter.evaluate((el) => ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map((a) => Number(el.getAttribute(a))));
    const center = async () => {
      const box = await splitter.boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const drag = async (dx) => {
      const { x, y } = await center();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 6 });
      await page.mouse.up();
    };

    assert.equal(await width(), 380);
    assert.equal(await splitter.getAttribute('role'), 'separator');
    assert.equal(await splitter.getAttribute('aria-label'), 'Panel width');
    assert.deepEqual(await value(), [260, 380, 768]);
    assert.deepEqual(await view(), { shown: 900, drawn: 900, viewport: 900 });

    // Dragged to the left: the panel widens as the pointer goes, the 3D view narrows with it.
    {
      const { x, y } = await center();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 100, y, { steps: 4 });
      await page.waitForFunction(() => Math.round(document.querySelector('#page-viewer > .panel').getBoundingClientRect().width) === 480);
      await page.waitForFunction(() => document.querySelector('#viewport canvas').width === 800);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('panel-resizing')), true);
      await page.mouse.move(x - 200, y, { steps: 4 });
      await page.mouse.up();
    }
    assert.equal(await width(), 580);
    await page.waitForFunction(() => document.querySelector('#viewport canvas').width === 700);
    assert.deepEqual(await view(), { shown: 700, drawn: 700, viewport: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('panel-resizing')), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.panel.width')), '580');
    // Focused by the mouse (the arrow keys then move it), without the focus ring of the keyboard.
    assert.equal(await splitter.evaluate((el) => document.activeElement === el && !el.matches(':focus-visible')), true);
    assert.equal(await page.evaluate(() => getSelection().toString()), '', 'no text selected by the drag');
    // The 3D view drawn in every frame it changed size; the thickness scale drawn again, the thicknesses not
    // computed again; nor when their card is folded and unfolded.
    await scaleFits();
    {
      const { shares, frames, blank } = await watched();
      assert.ok(frames >= 3, `${frames} frames`);
      assert.deepEqual({ shares, blank }, { shares: 0, blank: 0 });
    }
    await page.click('#thickness-card .card-toggle');
    await page.click('#thickness-card .card-toggle');
    await scaleFits();
    assert.equal((await watched()).shares, 0);

    // Within its limits: at most 60 % of the page (the 3D view keeps 320 px at least), at least 260 px.
    await drag(-1000);
    assert.equal(await width(), 768);
    assert.deepEqual(await value(), [260, 768, 768]);
    await drag(2000);
    assert.equal(await width(), 260);
    await page.waitForFunction(() => document.querySelector('#viewport canvas').width === 1020);
    // Narrow, nothing sticks out of the panel.
    assert.equal(await page.evaluate(() => { const p = document.querySelector('#page-viewer > .panel'); return p.scrollWidth <= p.clientWidth; }), true);

    // A double-click: back to the default width, forgotten.
    const { x, y } = await center();
    await page.mouse.dblclick(x, y);
    assert.equal(await width(), 380);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.panel.width')), null);

    // The keyboard on the splitter: ← widens, → narrows (Shift: by more), Home / End, Enter: the default.
    await splitter.focus();
    const keys = [['ArrowLeft', 400], ['Shift+ArrowLeft', 480], ['ArrowRight', 460], ['Home', 260], ['End', 768], ['Enter', 380], ['ArrowRight', 360]];
    for (const [key, expected] of keys) {
      await page.keyboard.press(key);
      assert.equal(await width(), expected, key);
      assert.equal((await value())[1], expected, key);
    }

    // Kept after a reload.
    await drag(-340);
    assert.equal(await width(), 700);
    await page.reload();
    assert.equal(await width(), 700);
    await analyse(page);
    await page.waitForFunction(() => document.querySelector('#viewport canvas').width === 580);

    // A smaller window: within the new limits (60 % of 1000 px); the width chosen again when it grows back.
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForFunction(() => Math.round(document.querySelector('#page-viewer > .panel').getBoundingClientRect().width) === 600);
    assert.deepEqual(await value(), [260, 600, 600]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => Math.round(document.querySelector('#page-viewer > .panel').getBoundingClientRect().width) === 700);

    // A narrow window: the panel under the 3D view, the whole width, no splitter.
    await page.setViewportSize({ width: 800, height: 800 });
    assert.equal(await splitter.isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#page-viewer > .panel').getBoundingClientRect().width === 800);
    await page.waitForFunction(() => document.querySelector('#viewport canvas').width === 800);
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await splitter.isVisible(), true);
    await page.waitForFunction(() => Math.round(document.querySelector('#page-viewer > .panel').getBoundingClientRect().width) === 700);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
