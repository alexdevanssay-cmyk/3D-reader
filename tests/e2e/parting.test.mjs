// End-to-end test of the parting line of the built site (dist/): proposed
// from the geometry of a block with a hole through it, another candidate
// chosen, the normal of a face picked, a face moved to the lower half by a
// click on the 3D view and kept after a reload, back to the proposal; the
// semantic contract, the foundry screen and the AI context follow; a phone's
// width.
//
//   npm run build && node --test tests/e2e/parting.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, fixturePath } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const CAD_TIMEOUT = 180_000;

describe('parting line (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
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

  test('proposed, a candidate chosen, a face picked, a face moved and kept after a reload, back to the proposal', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);

    // The block 100 × 60 × 20 mm with a hole Ø 20 through it along Z.
    const open = async () => {
      await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
      await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    };
    const card = () => page.evaluate(() => ({
      axis: document.getElementById('parting-axis').textContent,
      origin: document.getElementById('parting-origin').textContent,
      stats: Object.fromEntries([...document.querySelectorAll('#parting-stats dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
    }));
    const semantic = () => page.evaluate(() => {
      const body = window.reader3d.semantic.bodies[0];
      return { parting: body.parting, rules: body.foundry.rules, ai: window.reader3d.aiContext().bodies[0].parting };
    });
    const waitFor = (axis, origin) => page.waitForFunction(([a, o]) => document.getElementById('parting-axis').textContent === a && document.getElementById('parting-origin').textContent === o, [axis, origin], { timeout: 30_000 });
    // A click in the middle of the 3D view, seen from the front: the face y = 0 of the block.
    const clickFrontFace = async () => {
      await page.click('[data-view="front"]');
      const box = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };

    await open();
    // Proposed: drawn along the hole, no undercut, planar line round the bottom of the block and of the hole.
    let shown = await card();
    assert.deepEqual([shown.axis, shown.origin], ['Z', 'proposé']);
    assert.equal(shown.stats['Contre-dépouilles (noyaux, tiroirs)'], '0 % (0 cm²)');
    assert.match(shown.stats['Faces sans dépouille (< 1°)'], /^40,2 % /);
    assert.equal(shown.stats['Ligne de joint'], 'plane, à Z = 0 mm');
    assert.match(shown.stats['Longueur de la ligne'], /, 2 boucle\(s\)$/);
    const rows = await page.$$eval('#parting-candidates tbody tr', (trs) => trs.map((tr) => tr.textContent));
    assert.deepEqual(rows.map((r) => r.split(/\d/)[0]), ['Z ★', 'Y', 'X']);
    let s = await semantic();
    assert.equal(s.parting.status, 'proposed');
    assert.equal(s.rules.parting_line, 'proposed_from_geometry');
    assert.equal(s.rules.cores, 'no_undercut_for_the_chosen_axis');
    assert.deepEqual(s.ai, { status: 'proposed', axis: 'Z', direction: [0, 0, 1], undercut_share: 0, zero_draft_share: s.parting.zero_draft_share, planar: true });

    // Another candidate: across the hole, an undercut.
    await page.click('#parting-candidates tr[data-candidate] >> text=X');
    await waitFor('X', 'manuel');
    shown = await card();
    assert.match(shown.stats['Contre-dépouilles (noyaux, tiroirs)'], /^6,6 % /);
    s = await semantic();
    assert.deepEqual([s.parting.status, s.parting.source, s.rules.parting_line, s.rules.cores], ['manual', 'candidate', 'manual', 'undercuts_detected']);
    assert.equal(s.ai.status, 'manual');
    await page.click('#parting-reset');
    await waitFor('Z', 'proposé');

    // Shown on the 3D view, then the thickness colours instead.
    await page.check('#parting-show');
    await page.click('#toggle-thickness');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: 60_000 });
    assert.equal(await page.isChecked('#parting-show'), false);

    // The normal of a face picked on the 3D view: the front face, outwards (-Y).
    await page.click('#parting-pick');
    assert.match(await page.textContent('#parting-hint'), /Cliquez une face/);
    await clickFrontFace();
    await waitFor('-Y', 'manuel');
    assert.equal(await page.isVisible('#parting-hint'), false);
    await page.click('#parting-reset');
    await waitFor('Z', 'proposé');

    // The front face moved to the lower half: the line goes up along it, stepped.
    await page.click('#parting-assign');
    assert.equal(await page.isChecked('#parting-show'), true);
    assert.equal(await page.inputValue('#parting-target'), '2');
    await clickFrontFace();
    await waitFor('Z', 'manuel');
    shown = await card();
    assert.equal(shown.stats['Ligne de joint'], 'non plane : étagée sur 20 mm (niveaux 0 / 20 mm)');
    assert.equal(shown.stats['Faces réaffectées à la main'], '1');
    // The body selected did not change.
    assert.equal(await page.$$eval('#bodies tr.selected', (trs) => trs.length), 0);
    s = await semantic();
    assert.deepEqual([s.parting.status, s.parting.reassigned_faces, s.parting.parting.kind], ['manual', 1, 'stepped']);
    assert.deepEqual([s.ai.planar, s.ai.kind, s.ai.height_range_mm], [false, 'stepped', 20]);
    assert.ok(s.parting.candidates.length === 3 && s.parting.proposed.axis === 'Z');

    // Kept in this browser for this part: the same file opened again after a reload.
    await page.reload();
    await open();
    await waitFor('Z', 'manuel');
    shown = await card();
    assert.equal(shown.stats['Ligne de joint'], 'non plane : étagée sur 20 mm (niveaux 0 / 20 mm)');
    assert.equal((await semantic()).rules.parting_line, 'manual');

    // Back to the proposal: forgotten.
    await page.click('#parting-reset');
    await waitFor('Z', 'proposé');
    assert.equal((await card()).stats['Ligne de joint'], 'plane, à Z = 0 mm');
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.parting.v1')), '{}');
    assert.equal((await semantic()).parting.status, 'proposed');

    // A phone: the card within 375 px, no horizontal scroll.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('#parting-card *')].filter((x) => x.offsetParent && x.getBoundingClientRect().right > 375).map((x) => x.id || x.className || x.tagName),
    }));
    assert.deepEqual(overflow, { page: 375, wide: [] });
    assert.deepEqual(errors, []);
    await context.close();
  });
});
