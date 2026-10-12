// End-to-end test of the parting line of the built site (dist/): proposed
// from the geometry of a block with a hole through it, another candidate
// chosen, the normal of a face picked, a face moved to the lower half by a
// click on the 3D view and kept after a reload, back to the proposal; the
// semantic contract, the foundry screen and the AI context follow; a phone's
// width. Then a mesh of several bodies (two blocks and an open sheet): the
// modes of the 3D view and their hint follow the body of the card, and the
// thickness colours turned on in another tab.
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

/**
 * An OBJ of three bodies (one per material): blocks A (x -100..-5) and B
 * (x 5..100), 20 deep and 80 high, and an open square sheet C above them.
 */
function blocksObj() {
  const lines = [];
  let count = 0;
  const vertex = (x, y, z) => {
    lines.push(`v ${x} ${y} ${z}`);
    return ++count;
  };
  const faces = [];
  const box = (material, [x0, y0, z0], [x1, y1, z1]) => {
    const v = [];
    for (let i = 0; i < 8; i++) v.push(vertex(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0));
    faces.push(`usemtl ${material}`);
    // Counter-clockwise seen from outside.
    for (const q of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) faces.push(`f ${q.map((k) => v[k]).join(' ')}`);
  };
  box('a', [-100, -10, -40], [-5, 10, 40]);
  box('b', [5, -10, -40], [100, 10, 40]);
  const sheet = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y]) => vertex(x, y, 60));
  faces.push('usemtl c', `f ${sheet.join(' ')}`);
  return Buffer.from([...lines, ...faces, ''].join('\n'));
}

/**
 * An OBJ of the union of cubes `size` mm (cells x, y, z of an nx × ny × nz
 * grid where filled(x, y, z)), each body a material: bodies [[material,
 * filled, [dx, dy, dz] (its offset in mm)], …]; each square face counter-clockwise seen from outside.
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

/**
 * Pixels of the 3D view by colour: red (the parting line), yellow (the
 * undercuts), bluish and greenish (the halves of the mould over the page).
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
    const n = { red: 0, yellow: 0, blue: 0, green: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gr = data[i + 1], b = data[i + 2];
      if (r > 170 && gr < 80 && b < 80) n.red++;
      else if (r > 150 && gr > 120 && b < 80 && r - b > 100) n.yellow++;
      else if (b > r + 25 && b > gr + 10) n.blue++;
      else if (gr > r + 15 && gr > b + 5) n.green++;
    }
    return n;
  }, png.toString('base64'));
}

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
    assert.match(await page.textContent('#parting-hint'), /Cliquez sur une face/);
    await clickFrontFace();
    await waitFor('-Y', 'manuel');
    assert.equal(await page.isVisible('#parting-hint'), false);
    await page.click('#parting-reset');
    await waitFor('Z', 'proposé');

    // A direction typed as the card writes an oblique one.
    await page.fill('#parting-vector', '(0.6, 0, 0.8)');
    await page.click('#parting-apply');
    await waitFor('(0.6, 0, 0.8)', 'manuel');
    assert.equal(await page.isVisible('#parting-hint'), false);
    await page.click('#parting-reset');
    await waitFor('Z', 'proposé');

    // While a direction typed in is classified: a candidate clicked is not
    // taken (its radio not checked); 'Z' typed next stands once the first
    // one is classified.
    const during = await page.evaluate(() => {
      const rows = () => [...document.querySelectorAll('#parting-candidates tr[data-candidate]')];
      const vector = document.getElementById('parting-vector');
      vector.value = '0 1 1';
      document.getElementById('parting-apply').click();
      const status = document.getElementById('parting-status').textContent;
      rows().find((tr) => tr.cells[1].textContent === 'Y').querySelector('input').click();
      const checked = rows().find((tr) => tr.querySelector('input').checked)?.cells[1].textContent;
      vector.value = 'Z';
      document.getElementById('parting-apply').click();
      return { status, checked };
    });
    assert.deepEqual(during, { status: 'Classement des faces pour cette direction…', checked: 'Z ★' });
    await page.waitForSelector('#parting-status', { state: 'hidden' });
    shown = await card();
    assert.deepEqual([shown.axis, shown.origin], ['Z', 'proposé']);

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
    // The row of the direction in use clicked: as it is, its face reassigned kept.
    await page.click('#parting-candidates tr[data-candidate] >> text=Z');
    shown = await card();
    assert.deepEqual([shown.axis, shown.origin, shown.stats['Faces réaffectées à la main']], ['Z', 'manuel', '1']);
    const kept = Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('reader3d.parting.v1'))));
    assert.deepEqual(kept.map((part) => Object.keys(part.bodies[0].overrides).length), [1]);

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

  test('the modes of the 3D view and their hint follow the body of the card; the thickness colours of another tab', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    await page.setInputFiles('#file-input', { name: 'blocks.obj', mimeType: 'text/plain', buffer: blocksObj() });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    // The bodies by their place: A on the left, B on the right, the open sheet C.
    const bodies = await page.evaluate(() => window.reader3d.result.bodies.map((b) => ({ closed: b.closed, x: b.bbox.min[0] })));
    const A = bodies.findIndex((b) => b.closed && b.x < 0), B = bodies.findIndex((b) => b.closed && b.x > 0), C = bodies.findIndex((b) => !b.closed);
    assert.deepEqual([A, B, C].sort(), [0, 1, 2]);
    const row = (i) => page.click(`#bodies tr[data-index="${i}"] td.name`);
    const selected = () => page.$$eval('#bodies tr.selected', (trs) => trs.map((tr) => Number(tr.dataset.index)));
    const hint = () => page.evaluate(() => (document.getElementById('parting-hint').hidden ? '' : document.getElementById('parting-hint').textContent));
    // Seen from the front: A at a quarter of the width, B at three quarters, nothing in the middle.
    await page.click('[data-view="front"]');
    const click3d = async (at) => {
      const view = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(view.x + at * view.width, view.y + view.height / 2);
    };

    // Reassigning faces of A, a click on B: to select it first; selected in the list, that hint is gone.
    await row(A);
    await page.click('#parting-assign');
    await click3d(0.75);
    assert.match(await hint(), /autre corps/);
    assert.deepEqual(await selected(), [A]);
    await row(B);
    assert.deepEqual(await selected(), [B]);
    assert.match(await hint(), /^Cliquez sur des faces de la pièce/);

    // The open sheet selected: no parting, its buttons hidden; a click on the 3D view selects again.
    await row(C);
    assert.equal(await page.isHidden('#parting-main'), true);
    assert.match(await page.textContent('#parting-status'), /Corps ouvert/);
    await click3d(0.25);
    assert.deepEqual(await selected(), [A]);
    await click3d(0.5);
    assert.deepEqual(await selected(), []);
    // The same while picking a face.
    await row(A);
    await page.click('#parting-pick');
    await row(C);
    await click3d(0.25);
    assert.deepEqual(await selected(), [A]);
    assert.equal(await page.isHidden('#error'), true);
    assert.equal(await page.evaluate(() => document.getElementById('parting-pick').classList.contains('active')), false);

    // The parting of A shown (its thickness computed); in another tab, the thickness colours turned on.
    await page.click('#toggle-thickness');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: 60_000 });
    await page.check('#parting-show');
    assert.equal(await page.evaluate(() => document.getElementById('toggle-thickness').classList.contains('active')), false);
    await page.click('.doc-tab-new');
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.tab.file === 'box.stl', null, { timeout: CAD_TIMEOUT });
    await page.click('#toggle-thickness');
    await page.waitForSelector('#thick-body:not([hidden])', { timeout: 60_000 });
    // Back to the first tab: coloured by thickness, its parting no longer shown.
    await page.click('.doc-tab:first-child');
    await page.waitForFunction(() => window.reader3d.tab.file === 'blocks.obj', null, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.getElementById('toggle-thickness').classList.contains('active')), true);
    assert.equal(await page.isChecked('#parting-show'), false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('shown: the halves of the mould as translucent blocks, the line thick and red, the undercuts yellow; "Mould halves" hides the blocks', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A block 60 × 40 × 40 mm with a slot 40 wide, 20 deep and 10 high in its front face (y = 0): drawn along Z, the slot is an undercut.
    const slotted = voxelsObj([['a', (x, y, z) => !(x >= 2 && x < 10 && y < 4 && z >= 3 && z < 5)]], [12, 8, 8], 5);
    await page.setInputFiles('#file-input', { name: 'slotted.obj', mimeType: 'text/plain', buffer: slotted });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.click('#parting-candidates tr[data-candidate] >> text=Z');
    await page.waitForFunction(() => document.getElementById('parting-axis').textContent === 'Z', null, { timeout: 30_000 });
    const overlay = () => page.evaluate(() => {
      const card = document.getElementById('parting-card');
      return { overlay: card.dataset.overlay ?? '', undercuts: Number(card.dataset.undercuts || 0), faded: document.getElementById('viewport').dataset.faded ?? '0' };
    });
    assert.deepEqual(await overlay(), { overlay: '', undercuts: 0, faded: '0' });
    // The "Mould halves" checkbox: on by default, next to "Show".
    assert.equal(await page.isChecked('#parting-blocks'), true);
    assert.equal(await page.textContent('label:has(#parting-blocks)'), ' Chapes');

    await page.check('#parting-show');
    await page.click('[data-view="front"]');
    let shown = await overlay();
    assert.equal(shown.overlay, 'lower upper line');
    assert.ok(shown.undercuts > 0, 'the walls of the slot coloured as undercuts');
    const withBlocks = await viewColours(page);
    assert.ok(withBlocks.red > 200, `the line, thick and red: ${JSON.stringify(withBlocks)}`);

    // Without the blocks: the line and the colours stay; the walls of the slot in yellow.
    await page.uncheck('#parting-blocks');
    shown = await overlay();
    assert.equal(shown.overlay, 'line');
    assert.ok(shown.undercuts > 0);
    const without = await viewColours(page);
    assert.ok(without.red > 200, JSON.stringify(without));
    assert.ok(without.yellow > 500, `the undercuts in yellow: ${JSON.stringify(without)}`);
    // The blocks: blue above the line, green under it, over the page.
    assert.ok(withBlocks.blue > without.blue + 5000 && withBlocks.green > without.green + 5000, `${JSON.stringify(withBlocks)} / ${JSON.stringify(without)}`);
    await page.check('#parting-blocks');
    assert.equal((await overlay()).overlay, 'lower upper line');
    assert.match(await page.textContent('#parting-legend'), /^ligne de joint contre-dépouille faces de la pièce \(plus clair : sans dépouille\) chape supérieure chape inférieure/);

    // Not shown: no overlay, the part in its own colour.
    await page.uncheck('#parting-show');
    assert.deepEqual(await overlay(), { overlay: '', undercuts: 0, faded: '0' });
    // (The axes of the frame: a few red and orange pixels.)
    const plain = await viewColours(page);
    assert.ok(plain.red < 0.1 * without.red && plain.yellow < 0.05 * without.yellow, `${JSON.stringify(plain)} / ${JSON.stringify(without)}`);
    // In English.
    await page.selectOption('#language', 'en');
    assert.equal(await page.textContent('label:has(#parting-blocks)'), ' Mould halves');
    assert.match(await page.textContent('#parting-legend'), /^parting line undercut faces of the part \(lighter: no draft\) upper half lower half/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('two bodies, one in front of the other: a click on the front one acts on the body of the card behind it', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // Two blocks 60 × 20 × 20 mm: A at y -40..-20, in front of B at y 20..40 seen from the front.
    const box = () => true;
    const obj = voxelsObj([['a', box, [-30, -40, 0]], ['b', box, [-30, 20, 0]]], [12, 4, 4], 5);
    await page.setInputFiles('#file-input', { name: 'front_back.obj', mimeType: 'text/plain', buffer: obj });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    const bodies = await page.evaluate(() => window.reader3d.result.bodies.map((b) => b.bbox.min[1]));
    const A = bodies.findIndex((y) => y < 0), B = bodies.findIndex((y) => y > 0);
    assert.deepEqual([A, B].sort(), [0, 1]);
    const parting = (i) => page.evaluate((k) => window.reader3d.semantic.bodies.find((b) => b.source_index === k).parting, i);

    // The card on B, behind A: its faces reassigned by clicks; A drawn faded.
    await page.click(`#bodies tr[data-index="${B}"] td.name`);
    await page.click('#parting-assign');
    assert.equal(await page.evaluate(() => document.getElementById('viewport').dataset.faded), '1');
    await page.click('[data-view="front"]');
    const view = await page.locator('#viewport canvas').boundingBox();
    await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
    // The front face of B (y = 20), not of A, moved to the lower half.
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 30_000 });
    assert.doesNotMatch(await page.textContent('#parting-hint'), /autre corps/);
    const b = await parting(B);
    assert.deepEqual([b.status, b.reassigned_faces], ['manual', 1]);
    assert.equal((await parting(A)).status, 'proposed');
    // B still selected.
    assert.deepEqual(await page.$$eval('#bodies tr.selected', (trs) => trs.map((tr) => Number(tr.dataset.index))), [B]);

    // Both displays off: nothing faded.
    await page.click('#parting-assign');
    await page.uncheck('#parting-show');
    assert.equal(await page.evaluate(() => document.getElementById('viewport').dataset.faded), '0');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
