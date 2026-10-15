// End-to-end test of the risers and gating of the built site (dist/): proposed
// from the geometry of a block with a hole through it, shown on the 3D view
// beside the parting line, a riser added by a click on the part, resized, the
// ingate placed by a click (brought onto the parting line), all kept after a
// reload, a riser deleted, back to the proposal; the semantic contract, the
// foundry screen and the AI context follow; a phone's width. On an inside-out
// mesh, the risers placed by hand on the faces clicked, not put back once the
// file is read in another unit; "Move" stopped when another body is shown.
//
//   npm run build && node --test tests/e2e/feeding.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath } from '../js/helpers.mjs';

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

describe('risers and gating (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
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

  test('proposed, shown, a riser added by a click and resized, the ingate placed, kept after a reload, back to the proposal', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);

    // The block 100 × 60 × 20 mm with a hole Ø 20 through it along Z, at (50, 30).
    const open = async () => {
      await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
      await page.waitForSelector('#feeding-main:not([hidden])', { timeout: 120_000 });
    };
    const card = () => page.evaluate(() => {
      const el = document.getElementById('feeding-card');
      return {
        status: el.dataset.status,
        markers: el.dataset.markers,
        count: document.getElementById('feeding-count').textContent,
        origin: document.getElementById('feeding-origin').textContent,
        rows: [...document.querySelectorAll('#feeding-risers tbody tr[data-riser]')].map((tr) => tr.textContent),
        stats: Object.fromEntries([...document.querySelectorAll('#feeding-stats dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
      };
    });
    const semantic = () => page.evaluate(() => {
      const body = window.reader3d.semantic.bodies[0];
      return { feeding: body.feeding, rules: body.foundry.rules, risks: body.foundry.risks.map((r) => r.code), ai: window.reader3d.aiContext().bodies[0].feeding };
    });
    const waitStatus = (status, count) => page.waitForFunction(([s, n]) => document.getElementById('feeding-card').dataset.status === s && document.getElementById('feeding-count').textContent === n, [status, count], { timeout: 30_000 });
    // A click in the middle of the 3D view, seen from the front: the face y = 0 of the block, at (50, 0, 10).
    const clickFrontFace = async () => {
      await page.click('[data-view="front"]');
      const box = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };

    await open();
    await horizontalPlane(page);
    await waitStatus('proposed', '1');
    // Proposed: one zone (a plate of 20 mm), one open riser on the top face, its footprint clear of the hole.
    let shown = await card();
    assert.equal(shown.origin, 'proposé');
    assert.equal(shown.rows.length, 1);
    assert.match(shown.rows[0], /^R1dessus, ouverte/);
    assert.match(shown.stats['Attaque'], / ; 0 mm$/);
    assert.match(shown.stats['Rendement de coulée (pièce / pièce + masselottes + attaque)'], /^\d+(,\d)? %$/);
    let s = await semantic();
    assert.equal(s.feeding.status, 'proposed');
    assert.equal(s.feeding.parting_known, true);
    assert.equal(s.feeding.zones.length, 1);
    approx(s.feeding.zones[0].sphere_mm, 20, 0.05, 0, 'hot spot: the wall of the block');
    const [riser] = s.feeding.risers;
    assert.deepEqual([riser.id, riser.type, riser.open, riser.source], ['R1', 'top', true, 'proposed']);
    approx(riser.position_mm[2], 20, 0, 1e-3, 'on the top face');
    assert.ok(Math.hypot(riser.position_mm[0] - 50, riser.position_mm[1] - 30) >= 10 + riser.diameter_mm / 2 - 2, `riser at ${riser.position_mm}, over the hole`);
    assert.equal(riser.height_mm, Math.ceil(1.5 * riser.diameter_mm));
    // The ingate on the parting line (the bottom outline, z = 0), inwards in its plane.
    const gate = s.feeding.gate;
    assert.equal(gate.on_parting_line, true);
    approx(gate.position_mm[2], 0, 0, 1e-3, 'ingate on the bottom outline');
    approx(gate.direction[2], 0, 0, 1e-6, 'ingate in the parting plane');
    assert.deepEqual([s.rules.risering, s.rules.gating], ['proposed_by_modulus_heuristic', 'proposed_on_parting_line']);
    assert.equal(s.ai.status, 'proposed');
    assert.deepEqual(s.ai.risers.map((r) => r.type), ['top']);
    assert.equal(s.ai.gate.on_parting_line, true);

    // Shown on the 3D view: a cylinder for the riser, an arrow for the ingate; with the parting line shown too.
    await page.check('#feeding-show');
    assert.equal((await card()).markers, '2');
    await page.check('#parting-show');
    assert.equal((await card()).markers, '2');
    assert.ok(await page.isChecked('#feeding-show'));

    // A riser added by a click on the part: on the front face, a blind riser on the side.
    await page.click('#feeding-add');
    assert.match(await page.textContent('#feeding-hint'), /Cliquez sur la vue 3D/);
    await clickFrontFace();
    await waitStatus('manual', '2');
    shown = await card();
    assert.equal(shown.origin, 'manuel');
    assert.equal(shown.markers, '3');
    assert.match(shown.rows[1], /^M1latérale, borgne/);
    assert.equal(await page.isVisible('#feeding-hint'), false);
    s = await semantic();
    const added = s.feeding.risers[1];
    assert.deepEqual([added.id, added.type, added.source, added.zone], ['M1', 'side', 'manual', 0]);
    approx(added.position_mm[1], 0, 0, 1e-3, 'on the front face');
    assert.deepEqual(added.offset, [0, -1, 0]);
    assert.equal(s.feeding.status, 'manual');
    assert.equal(s.rules.risering, 'placed_manually');
    // The body selected did not change.
    assert.equal(await page.$$eval('#bodies tr.selected', (trs) => trs.length), 0);

    // Another parting line (the candidate X): the ingate proposed again on it, the risers placed by hand kept.
    await page.click('#parting-candidates tr[data-candidate] >> text=X');
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].feeding?.draw_direction[0] === 1, null, { timeout: 30_000 });
    s = await semantic();
    assert.deepEqual(s.feeding.risers.map((r) => r.id), ['R1', 'M1']);
    assert.equal(s.feeding.gate.source, 'proposed');
    approx(s.feeding.gate.direction[0], 0, 0, 1e-6, 'ingate in the plane of the new parting line');
    await page.click('#parting-reset');
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].feeding?.draw_direction[2] === 1, null, { timeout: 30_000 });
    assert.deepEqual((await semantic()).feeding.gate.position_mm, gate.position_mm);

    // M1 selected (a riser added is), R1 selected by a click in the list, then M1 again: its D and H typed in.
    assert.ok(await page.isVisible('#feeding-editor'));
    assert.equal(await page.$eval('#feeding-risers tr.selected', (tr) => tr.dataset.riser), 'M1');
    await page.click('#feeding-risers tr[data-riser="R1"]');
    assert.equal(await page.$eval('#feeding-risers tr.selected', (tr) => tr.dataset.riser), 'R1');
    assert.match(await page.textContent('#feeding-why'), /^Point chaud Ø 20(,\d)? mm .* masselotte ouverte sur le dessus/);
    await page.click('#feeding-risers tr[data-riser="M1"]');
    assert.ok(await page.isVisible('#feeding-editor'));
    await page.fill('#feeding-d', '30');
    await page.press('#feeding-d', 'Enter');
    await page.fill('#feeding-h', '40');
    await page.press('#feeding-h', 'Enter');
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].feeding?.risers[1]?.height_mm === 40, null, { timeout: 10_000 });
    s = await semantic();
    assert.deepEqual([s.feeding.risers[1].diameter_mm, s.feeding.risers[1].height_mm, s.feeding.risers[1].sized_by_hand], [30, 40, true]);
    approx(s.feeding.risers[1].volume_mm3, Math.PI * 225 * 40, 1e-6, 0.1, 'volume');
    assert.match(await page.textContent('#feeding-why'), /^Placée et dimensionnée à la main/);

    // The ingate placed by a click on the front face: brought onto the parting line under it.
    await page.click('#feeding-gate');
    await clickFrontFace();
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].feeding?.gate?.source === 'manual', null, { timeout: 10_000 });
    s = await semantic();
    assert.equal(s.feeding.gate.on_parting_line, true);
    approx(s.feeding.gate.position_mm[0], 50, 0, 2, 'ingate under the click');
    approx(s.feeding.gate.position_mm[1], 0, 0, 1e-3, 'on the front side');
    approx(s.feeding.gate.position_mm[2], 0, 0, 1e-3, 'on the bottom outline');
    assert.deepEqual(s.feeding.gate.direction, [0, 1, 0]);
    assert.equal(s.rules.gating, 'placed_manually');

    // Esc stops placing.
    await page.click('#feeding-add');
    assert.ok(await page.isVisible('#feeding-hint'));
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#feeding-hint'), false);
    assert.equal(await page.$eval('#feeding-add', (b) => b.classList.contains('active')), false);

    // Kept in this browser for this part: the same file opened again after a reload.
    await page.reload();
    await open();
    await waitStatus('manual', '2');
    s = await semantic();
    assert.deepEqual(s.feeding.risers.map((r) => [r.id, r.diameter_mm]), [['R1', riser.diameter_mm], ['M1', 30]]);
    assert.equal(s.feeding.gate.source, 'manual');

    // M1 deleted: still by hand (the ingate).
    await page.click('#feeding-risers tr[data-riser="M1"]');
    await page.click('#feeding-delete');
    await waitStatus('manual', '1');

    // Back to the proposal: forgotten.
    await page.click('#feeding-reset');
    await waitStatus('proposed', '1');
    s = await semantic();
    assert.equal(s.feeding.status, 'proposed');
    assert.equal(s.feeding.gate.source, 'proposed');
    assert.deepEqual(s.feeding.risers.map((r) => r.id), ['R1']);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.feeding.v1')), '{}');

    // In English: the reasons too.
    await page.selectOption('#language', 'en');
    await page.click('#feeding-risers tr[data-riser="R1"]');
    assert.match(await page.textContent('#feeding-why'), /^Hot spot Ø 20(\.\d)? mm/);
    assert.equal(await page.textContent('#feeding-card h3'), 'Risers and gating');
    await page.selectOption('#language', 'fr');

    // A phone: the card within 375 px, no horizontal scroll.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('#feeding-card *')].filter((x) => x.offsetParent && x.getBoundingClientRect().right > 375).map((x) => x.id || x.className || x.tagName),
    }));
    assert.deepEqual(overflow, { page: 375, wide: [] });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('an inside-out mesh: risers placed by hand on the face clicked, outwards; not put back in another unit', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);

    // A box 10 × 20 × 30 mm round the origin whose triangles all turn inwards (shown as they are).
    const open = async () => {
      await page.evaluate(() => (document.body.dataset.status = ''));
      await page.setInputFiles('#file-input', fixturePath('inverted.obj'));
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    };
    const feeding = () => page.evaluate(() => window.reader3d.semantic.bodies[0].feeding ?? null);
    const waitStatus = (status, count) => page.waitForFunction(([s, n]) => document.getElementById('feeding-card').dataset.status === s && document.getElementById('feeding-count').textContent === n, [status, count], { timeout: 60_000 });
    const clickView = async (view) => {
      await page.click(`[data-view="${view}"]`);
      const box = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await open();
    await horizontalPlane(page);
    // Drawn along Z: its top face z = 15 turned up, its front face y = -10 on the side.
    await page.waitForSelector('#parting-candidates tr[data-candidate]', { timeout: 60_000 });
    await page.click('#parting-candidates tr[data-candidate] >> text=Z');
    await page.waitForFunction(() => Math.abs(window.reader3d.semantic.bodies[0].feeding?.draw_direction[2] ?? 0) === 1, null, { timeout: 60_000 });
    const up = (await feeding()).draw_direction[2];
    await waitStatus('proposed', '1');

    // On the face turned up: an open riser standing on it (not a side one without an offset).
    await page.click('#feeding-add');
    await clickView('top');
    if (up > 0) {
      await waitStatus('manual', '2');
      const riser = (await feeding()).risers.find((r) => r.id === 'M1');
      assert.deepEqual([riser.type, riser.open, riser.offset], ['top', true, null]);
      approx(riser.position_mm[2], 15, 0, 1e-3, 'on the top face');
    } else {
      // Drawn the other way: that face is turned down, refused; another face asked for.
      assert.match(await page.textContent('#feeding-hint'), /tournée vers le bas/);
      assert.equal((await feeding()).risers.length, 1);
      await page.keyboard.press('Escape');
    }
    // On the front face: a blind riser beside it, outwards (not inside the part).
    await page.click('#feeding-add');
    await clickView('front');
    const count = up > 0 ? '3' : '2';
    await waitStatus('manual', count);
    const side = (await feeding()).risers.at(-1);
    assert.deepEqual([side.type, side.open, side.offset], ['side', false, [0, -1, 0]]);
    approx(side.position_mm[1], -10, 0, 1e-3, 'on the front face');

    // The same file read in inches: 25.4 × larger, the risers placed in mm not put back on it.
    await page.selectOption('#unit', 'in');
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.semantic.bodies[0].metrics?.bbox_mm?.size?.[2] > 700, null, { timeout: CAD_TIMEOUT });
    await waitStatus('proposed', '1');
    assert.ok((await feeding()).risers.every((r) => r.source === 'proposed'));
    // Back in mm: put back.
    await page.selectOption('#unit', 'mm');
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.semantic.bodies[0].metrics?.bbox_mm?.size?.[2] < 31, null, { timeout: CAD_TIMEOUT });
    await waitStatus('manual', count);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('two bodies: "Move" stops when the card shows another body', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Every body checked (a file of several bodies shows its largest one alone by default): both shown.
    await page.goto(`${base}?lang=fr&bodies=all`);
    // A cube and a cylinder, two bodies (glTF, read in mm).
    await page.selectOption('#unit', 'mm');
    await page.setInputFiles('#file-input', fixturePath('two_objects.glb'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const waitProposed = () => page.waitForFunction(() => document.getElementById('feeding-card').dataset.status === 'proposed', null, { timeout: 60_000 });
    await page.click('#bodies tr[data-index="0"] td.name');
    await waitProposed();
    await page.click('#feeding-risers tr[data-riser="R1"]');
    await page.click('#feeding-move');
    assert.ok(await page.$eval('#feeding-move', (b) => b.classList.contains('active')));
    assert.ok(await page.isVisible('#feeding-hint'));
    // The other body: its R1 is not the one selected; nothing to move, no selection.
    await page.click('#bodies tr[data-index="1"] td.name');
    await waitProposed();
    assert.equal(await page.$eval('#feeding-move', (b) => b.classList.contains('active')), false);
    assert.equal(await page.isVisible('#feeding-hint'), false);
    assert.equal(await page.$$eval('#feeding-risers tr.selected', (trs) => trs.length), 0);
    assert.equal(await page.isVisible('#feeding-editor'), false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('two identical bodies, one over the other: the risers of the card\'s body shown with the parting line, a click places them on it', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Every body checked (a file of several bodies shows its largest one alone by default): both shown.
    await page.goto(`${base}?lang=fr&bodies=all`);
    // Two versions of a block 80 × 40 × 20 mm, in the same place: an ASCII STL of two solids.
    const facets = [];
    const v = (i) => [i & 1 ? 80 : 0, i & 2 ? 40 : 0, i & 4 ? 20 : 0];
    for (const q of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) {
      for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) facets.push(`facet normal 0 0 0\nouter loop\n${t.map((k) => `vertex ${v(k).join(' ')}`).join('\n')}\nendloop\nendfacet`);
    }
    const stl = ['first', 'second'].map((name) => `solid ${name}\n${facets.join('\n')}\nendsolid ${name}`).join('\n');
    await page.setInputFiles('#file-input', { name: 'two_versions.stl', mimeType: 'text/plain', buffer: Buffer.from(stl) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    assert.equal(await page.evaluate(() => window.reader3d.result.bodies.length), 2);
    // The card on the second one (under the first one, for the ray of a click).
    await page.click('#bodies tr[data-index="1"] td.name');
    await page.waitForFunction(() => document.getElementById('feeding-card').dataset.status === 'proposed', null, { timeout: 60_000 });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await horizontalPlane(page, 1);
    const faded = () => page.evaluate(() => document.getElementById('viewport').dataset.faded);
    // Orange pixels of the 3D view: the risers (the view triad masked: the edges of its red axis are orange).
    const orange = async () => {
      await page.waitForTimeout(300);
      const png = await page.locator('#viewport canvas').screenshot({ mask: [page.locator('#view-triad')] });
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
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 170 && data[i] - data[i + 2] > 70 && data[i] - data[i + 1] > 35 && data[i + 1] > 90) n++;
        return n;
      }, png.toString('base64'));
    };

    // Both displays on: the markers on the card's body, visible inside the upper half of the mould; the other body faded.
    await page.check('#parting-show');
    assert.equal(await page.evaluate(() => document.getElementById('parting-card').dataset.overlay), 'lower upper line');
    const before = await orange();
    await page.check('#feeding-show');
    assert.equal((await page.evaluate(() => document.getElementById('feeding-card').dataset.markers)), '2');
    assert.equal(await faded(), '1');
    const shown = await orange();
    assert.ok(shown > before + 2000, `the riser seen through the upper half: ${before} -> ${shown} orange pixels`);
    // The parting line hidden: the risers still shown, the other body still faded.
    await page.uncheck('#parting-show');
    assert.equal(await faded(), '1');
    await page.check('#parting-show');

    // A riser added by a click on the front face: on the card's body, though the ray meets the other one first.
    await page.click('#feeding-add');
    await page.click('[data-view="front"]');
    const view = await page.locator('#viewport canvas').boundingBox();
    await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
    await page.waitForFunction(() => document.getElementById('feeding-card').dataset.status === 'manual', null, { timeout: 30_000 });
    assert.equal(await page.isVisible('#feeding-hint'), false);
    const risers = await page.evaluate(() => window.reader3d.semantic.bodies.map((b) => (b.feeding?.risers ?? []).map((r) => r.id)));
    assert.ok(risers[1].includes('M1') && !risers[0].includes('M1'), JSON.stringify(risers));
    assert.equal(await page.evaluate(() => document.getElementById('feeding-card').dataset.markers), '3');

    // Both displays off: no body faded.
    await page.uncheck('#parting-show');
    await page.uncheck('#feeding-show');
    assert.equal(await faded(), '0');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
