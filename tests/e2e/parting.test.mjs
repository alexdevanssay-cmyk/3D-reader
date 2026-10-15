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
import { MUSHROOM, mushroom } from '../js/curved-mesh.mjs';
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
 * The view triad masked (its axes are red, green and blue).
 */
async function viewColours(page) {
  await page.waitForTimeout(300); // a frame drawn
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

// ---- drawing by hand: points aimed on the part through reader3d.screenOf

/** The view turned by the right arrow until the face of normal `n` at `p` faces the camera (outward normal · towards the camera > 0.2). */
async function faceToward(page, p, n) {
  for (let k = 0; k < 8; k++) {
    const seen = await page.evaluate(([q, normal]) => {
      const eye = window.reader3d.view.position;
      const d = [eye[0] - q[0], eye[1] - q[1], eye[2] - q[2]];
      return normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] > 0.2 * Math.hypot(...d);
    }, [p, n]);
    if (seen) return;
    await page.click('#turn-right');
    await page.waitForFunction(() => !document.getElementById('viewport').dataset.turning);
  }
  throw new Error(`face ${n} at ${p} never towards the camera`);
}

/** A click on the 3D view where a point of the model is ([dx, dy] pixels off). */
async function clickModel(page, p, [dx, dy] = [0, 0]) {
  const at = await page.evaluate((q) => window.reader3d.screenOf(q), p);
  assert.ok(at, `${p} in front of the camera`);
  await page.mouse.click(at.x + dx, at.y + dy);
}

/** The segments of the table: their names, and the text of their length. */
const segmentRows = (page) => page.$$eval('#parting-draw-segments tbody tr[data-seg]:not(.seg-arc-edit):not(.parting-seg-error)', (rows) => rows.map((tr) => ({ name: tr.cells[0].textContent, length: tr.cells[2].textContent, type: tr.querySelector('select').value })));

/** The parting card's figures, by their label. */
const partingStats = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#parting-stats dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));

/** Two boxes (DOMRects) overlapping. */
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** An OBJ of a mesh {positions, indices} as it is (each face with its own vertices), its points moved by `move`. */
function meshObj({ positions: P, indices: I }, move = (p) => p) {
  const lines = [];
  for (let i = 0; i < P.length; i += 3) lines.push(`v ${move([P[i], P[i + 1], P[i + 2]]).join(' ')}`);
  for (let i = 0; i < I.length; i += 3) lines.push(`f ${I[i] + 1} ${I[i + 1] + 1} ${I[i + 2] + 1}`);
  return Buffer.from(`${lines.join('\n')}\n`);
}

/** The colours ([r, g, b]) of the 3D view at points of the model, the view drawn. */
async function coloursAt(page, points) {
  await page.waitForTimeout(300);
  const box = await page.locator('#viewport canvas').boundingBox();
  const at = await page.evaluate((ps) => ps.map((p) => window.reader3d.screenOf(p)), points);
  const png = await page.locator('#viewport canvas').screenshot();
  return page.evaluate(async ([b64, xy]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    return xy.map(([x, y]) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]);
  }, [png.toString('base64'), at.map((a) => [a.x - box.x, a.y - box.y])]);
}

// The colours of the parting display: the grey of the faces, the yellow of the undercuts (and of slide T1), the teal of slide T2.
const isGrey = ([r, g, b]) => r > 80 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
const isYellow = ([r, g, b]) => r > 150 && g > 120 && b < 80;
const isTeal = ([r, g, b]) => b > r + 60 && g > r + 60;

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
    // Every body checked (a file of several bodies shows its largest one alone by default): all of them shown.
    await page.goto(`${base}?lang=fr&bodies=all`);
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
    // Above the part (its top at z = 40), in front of the part: inside the upper half only.
    const above = [[10, 0, 50], [50, 0, 50]];
    const aboveWith = await coloursAt(page, above);

    // Without the blocks: the line and the colours stay; the walls of the slot in yellow.
    await page.uncheck('#parting-blocks');
    shown = await overlay();
    assert.equal(shown.overlay, 'line');
    assert.ok(shown.undercuts > 0);
    const without = await viewColours(page);
    assert.ok(without.red > 200, JSON.stringify(without));
    assert.ok(without.yellow > 500, `the undercuts in yellow: ${JSON.stringify(without)}`);
    const aboveWithout = await coloursAt(page, above);
    // The blocks, over the page: the die blank cut in two, wider than this view framed on the part. Above the
    // part only the upper half is crossed: blue there, the page without the blocks (under the line both halves
    // are crossed, their colours mixed). Seen whole in the casting view: blue and green (side by side on this
    // vertical parting plane).
    const isBlue = ([r, g, b]) => b > r + 25 && b > g + 10;
    assert.ok(aboveWith.every(isBlue) && !aboveWithout.some(isBlue), `above the part: ${JSON.stringify(aboveWith)} / ${JSON.stringify(aboveWithout)}`);
    await page.check('#parting-blocks');
    assert.equal((await overlay()).overlay, 'lower upper line');
    await page.click('#view-casting');
    const die = await viewColours(page);
    await page.uncheck('#parting-blocks');
    const dieWithout = await viewColours(page);
    assert.ok(die.blue > dieWithout.blue + 5000 && die.green > dieWithout.green + 5000, `${JSON.stringify(die)} / ${JSON.stringify(dieWithout)}`);
    await page.check('#parting-blocks');
    await page.click('[data-view="front"]');
    assert.match(await page.textContent('#parting-legend'), /^ligne de joint contre-dépouille faces de la pièce \(plus clair : sans dépouille\) chape supérieure chape inférieure/);

    // Not shown: no overlay, the part in its own colour.
    await page.uncheck('#parting-show');
    assert.deepEqual(await overlay(), { overlay: '', undercuts: 0, faded: '0' });
    // (No axes at the origin of the part any more; the triad masked.)
    const plain = await viewColours(page);
    assert.ok(plain.red < 0.1 * without.red && plain.yellow < 0.05 * without.yellow, `${JSON.stringify(plain)} / ${JSON.stringify(without)}`);
    // In English.
    await page.selectOption('#language', 'en');
    assert.equal(await page.textContent('label:has(#parting-blocks)'), ' Mould halves');
    assert.match(await page.textContent('#parting-legend'), /^parting line undercut faces of the part \(lighter: no draft\) upper half lower half/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the colours cut along the line across long triangles: each side of it in its own; a click picks the triangle clicked; the section', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // The mushroom of the unit tests (tests/js/curved-mesh.mjs: each face its
    // own vertices, its flat faces fans of long triangles) turned over about X:
    // along -Z, the underside of its cap (up, z = -25) is an undercut over the
    // base (x < 30), the lower half beyond it; the edge of the base's shadow,
    // x = 30, crosses the fan of the underside.
    const part = mushroom();
    const turn = ([x, y, z]) => [x, -y, -z];
    await page.setInputFiles('#file-input', { name: 'mushroom.obj', mimeType: 'text/plain', buffer: meshObj(part, turn) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.fill('#parting-vector', '0 0 -1');
    await page.click('#parting-apply');
    await page.waitForFunction(() => document.getElementById('parting-axis').textContent === '-Z', null, { timeout: 60_000 });
    // Pairs of points 1.5 mm on either side of the line, on the underside: both of a pair in one long triangle crossing it
    // for most (by triangle, of one colour).
    const ys = [-15, -12, -9, -3, 0, 3, 6, 9, 15];
    const pairs = ys.map((y) => [[28.5, y, MUSHROOM.stem.top], [31.5, y, MUSHROOM.stem.top]]);
    const P = part.positions, I = part.indices;
    const triangleAt = ([x, y, z]) => {
      for (let f = 0; f < I.length / 3; f++) {
        const c = [0, 1, 2].map((k) => [P[3 * I[3 * f + k]], P[3 * I[3 * f + k] + 1], P[3 * I[3 * f + k] + 2]]);
        if (!c.every((p) => Math.abs(p[2] - z) < 1e-4)) continue;
        const s = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        const d = [s(c[0], c[1]), s(c[1], c[2]), s(c[2], c[0])];
        if (d.every((v) => v >= 0) || d.every((v) => v <= 0)) return f;
      }
      return -1;
    };
    assert.ok(pairs.filter(([a, b]) => triangleAt(a) === triangleAt(b) && triangleAt(a) >= 0).length >= 6, 'pairs across one triangle');
    const inside = pairs.map(([a]) => turn(a)), outside = pairs.map(([, b]) => turn(b));
    const card = () => page.evaluate(() => ({ ...document.getElementById('parting-card').dataset, caps: document.getElementById('viewport').dataset.caps }));

    // Shown without the blocks nor the slides, the section keeping the cap (z < -15), seen from the top.
    await page.check('#parting-show');
    await page.uncheck('#parting-blocks');
    await page.uncheck('#parting-slides-show');
    await page.click('#toggle-section');
    await page.$eval('#section-pos', (el) => {
      el.value = '375';
      el.dispatchEvent(new Event('input'));
    });
    await page.click('[data-view="top"]');
    await page.waitForFunction(() => Number(document.getElementById('parting-card').dataset.pieces) > 0, null, { timeout: 60_000 });
    let shown = await card();
    assert.equal(shown.caps, 'body', 'the section closed');
    let inner = await coloursAt(page, inside), outer = await coloursAt(page, outside);
    ys.forEach((y, k) => {
      assert.ok(isYellow(inner[k]), `y = ${y}: over the base, the undercut: ${inner[k]}`);
      assert.ok(isGrey(outer[k]), `y = ${y}: beyond it, the lower half: ${outer[k]}`);
    });
    // The slides: over the base their colours, never the grey of the faces; beyond it grey.
    await page.check('#parting-slides-show');
    await page.waitForFunction(() => document.getElementById('parting-card').dataset.slideStatus === 'ready' && document.getElementById('parting-card').dataset.slideColours !== '', null, { timeout: 60_000 });
    inner = await coloursAt(page, inside);
    outer = await coloursAt(page, outside);
    ys.forEach((y, k) => {
      assert.ok(isYellow(inner[k]) || isTeal(inner[k]), `y = ${y}: a slide's colour: ${inner[k]}`);
      assert.ok(isGrey(outer[k]), `y = ${y}: ${outer[k]}`);
    });

    // Its zones edited: a click on the colour of a slide in a long triangle picks its zone; on the grey beyond the line in the same triangle, none.
    await page.click('#slides-edit');
    const click = async (p) => {
      const at = await page.evaluate((q) => window.reader3d.screenOf(q), p);
      await page.mouse.click(at.x, at.y);
    };
    await click(inside[4]);
    await page.waitForSelector('#slides-zone:not([hidden])');
    assert.match(await page.textContent('#slides-zone'), /^Zone \d+ : /);
    await click(outside[4]);
    await page.waitForFunction(() => document.getElementById('slides-hint').textContent.startsWith('Pas une zone'));
    await page.keyboard.press('Escape');

    // The faces reassigned by a click: the underside beyond the line moved to the upper half, cut no more (no pieces left), grey.
    await page.click('#parting-assign');
    await page.selectOption('#parting-target', '1');
    await click(outside[4]);
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => window.reader3d.semantic.bodies[0].parting.reassigned_faces), 1);
    await page.waitForFunction(() => document.getElementById('parting-card').dataset.pieces === '0', null, { timeout: 60_000 });
    inner = await coloursAt(page, inside);
    ys.forEach((y, k) => assert.ok(isGrey(inner[k]), `y = ${y}: ${inner[k]}`));
    await page.click('#parting-assign');

    // A face picked: the underside (its normal up), clicked over the base.
    await page.click('#parting-pick');
    await click(inside[4]);
    await page.waitForFunction(() => document.getElementById('parting-axis').textContent === 'Z', null, { timeout: 60_000 });
    shown = await card();
    assert.equal(shown.caps, 'body');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel : les teintes des chapes changent sur la ligne tracée, à travers les grands triangles', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A block 60 × 40 × 20 mm, each face two triangles with vertices of its own (a CAD body); a loop drawn round its
    // sides at z = 8 crosses them all.
    const corner = (i) => [i & 1 ? 60 : 0, i & 2 ? 40 : 0, i & 4 ? 20 : 0];
    const quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    const box = { positions: Float32Array.from(quads.flatMap((q) => q.flatMap(corner))), indices: Uint32Array.from(quads.flatMap((_, k) => [0, 1, 2, 0, 2, 3].map((j) => 4 * k + j))) };
    await page.setInputFiles('#file-input', { name: 'block.obj', mimeType: 'text/plain', buffer: meshObj(box) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.click('#parting-draw');
    const points = [[[10, 0, 8], [0, -1, 0]], [[50, 0, 8], [0, -1, 0]], [[60, 30, 8], [1, 0, 0]], [[30, 40, 8], [0, 1, 0]], [[0, 20, 8], [-1, 0, 0]]];
    for (const [p, n] of points) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    await faceToward(page, ...points[0]);
    await clickModel(page, points[0][0], [4, 0]);
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.getElementById('parting-card').dataset.draw), 'halves');
    // Each side's two triangles in two parts.
    assert.equal(await page.evaluate(() => document.getElementById('parting-card').dataset.pieces), '16');
    // Seen from the front: 1 mm above the line the tint of the upper chape (blue: 84,94,122), under it that of the lower
    // one (green: 84,102,96). By triangle, a blend of both from the top of the face to its bottom (84,98,108 above,
    // 84,99,106 under it).
    await faceToward(page, [30, 0, 10], [0, -1, 0]);
    const xs = [8, 20, 30, 40];
    const above = await coloursAt(page, xs.map((x) => [x, 0, 9])), below = await coloursAt(page, xs.map((x) => [x, 0, 7]));
    xs.forEach((x, k) => {
      assert.ok(above[k][2] >= above[k][1] + 15, `x = ${x}: the upper chape above the line: ${above[k]}`);
      assert.ok(below[k][1] >= below[k][2] + 3, `x = ${x}: the lower chape under it: ${below[k]}`);
    });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('two bodies, one in front of the other: a click through the faded front one acts on the body of the card behind it, never through an opaque one', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Every body checked (a file of several bodies shows its largest one alone by default): all of them shown.
    await page.goto(`${base}?lang=fr&bodies=all`);
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
    const faded = () => page.evaluate(() => document.getElementById('viewport').dataset.faded ?? '0');
    const overlay = () => page.evaluate(() => document.getElementById('parting-card').dataset.overlay ?? '');
    const selected = () => page.$$eval('#bodies tr.selected', (trs) => trs.map((tr) => Number(tr.dataset.index)));
    // A click in the middle of the 3D view, seen from the front: on A, B behind it.
    const clickMiddle = async () => {
      const view = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
    };

    // The card on B, nothing shown: A opaque in front of it. A face picked
    // there is A's: B's direction unchanged, the hint says so.
    await page.click(`#bodies tr[data-index="${B}"] td.name`);
    await page.click('[data-view="front"]');
    assert.equal(await faded(), '0');
    const proposed = (await parting(B)).direction;
    await page.click('#parting-pick');
    await clickMiddle();
    assert.match(await page.textContent('#parting-hint'), /autre corps/);
    assert.deepEqual([(await parting(B)).status, (await parting(B)).direction], ['proposed', proposed]);
    await page.click('#parting-pick');

    // Its faces reassigned by clicks: A drawn faded, the click goes through it.
    await page.click('#parting-assign');
    assert.equal(await faded(), '1');
    await clickMiddle();
    // The front face of B (y = 20), not of A, moved to the lower half.
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 30_000 });
    assert.doesNotMatch(await page.textContent('#parting-hint'), /autre corps/);
    const b = await parting(B);
    assert.deepEqual([b.status, b.reassigned_faces], ['manual', 1]);
    assert.equal((await parting(A)).status, 'proposed');
    // B still selected.
    assert.deepEqual(await selected(), [B]);

    // No mode, the parting still shown: a click through the faded A selects B, seen behind it.
    await page.click('#parting-assign');
    assert.equal(await overlay(), 'lower upper line');
    await clickMiddle();
    assert.deepEqual(await selected(), [B]);
    assert.equal(await faded(), '1');

    // B unchecked in the list: hidden with its overlays, A in its own look again; checked again, A faded.
    await page.uncheck(`#bodies tr[data-index="${B}"] input`);
    assert.equal(await faded(), '0');
    await page.check(`#bodies tr[data-index="${B}"] input`);
    assert.equal(await faded(), '1');

    // The thickness colours instead: the parting no longer shown, nor said to be.
    await page.click('#toggle-thickness');
    assert.equal(await page.isChecked('#parting-show'), false);
    assert.equal(await overlay(), '');
    await page.waitForFunction(() => document.getElementById('toggle-thickness').classList.contains('active') && document.getElementById('viewport').dataset.faded === '0', null, { timeout: 60_000 });

    // Shown again, then another file of one body opened in this tab: nothing faded, nothing shown.
    await page.check('#parting-show');
    assert.deepEqual([await overlay(), await faded()], ['lower upper line', '1']);
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.tab.file === 'box.stl', null, { timeout: CAD_TIMEOUT });
    assert.deepEqual([await overlay(), await faded()], ['', '0']);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel : plan, flèches, points autour de la pièce, boucle fermée, une courbe, chapes par partie, gardé après rechargement', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A block 60 × 40 × 20 mm, drawn along Z.
    const box = voxelsObj([['a', () => true]], [12, 8, 4], 5);
    const open = async () => {
      await page.setInputFiles('#file-input', { name: 'box.obj', mimeType: 'text/plain', buffer: box });
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
      await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    };
    const hint = () => page.textContent('#parting-hint');
    const card = () => page.evaluate(() => {
      const el = document.getElementById('parting-card');
      return { origin: document.getElementById('parting-origin').textContent, stage: el.dataset.draw ?? '', overlay: el.dataset.overlay ?? '' };
    });
    const semantic = () => page.evaluate(() => {
      const body = window.reader3d.semantic.bodies[0];
      return { parting: body.parting, foundry: body.foundry, ai: window.reader3d.aiContext().bodies[0].parting };
    });
    await open();
    assert.equal(await page.isHidden('#draw-overlay'), true);

    // 1. Dessin manuel: the plane of the direction shown (Z), the side view (Z upright), the arrows and the step on the view.
    await page.click('#parting-draw');
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw').classList.contains('active')), true);
    assert.equal(await page.inputValue('#parting-draw-plane'), 'Z');
    for (const id of ['#turn-left', '#turn-right', '#turn-step', '#draw-actions']) assert.equal(await page.isVisible(id), true, id);
    assert.equal(await page.getAttribute('#turn-step [data-step="4"]', 'aria-checked'), 'true');
    const up = (await page.evaluate(() => window.reader3d.view)).up;
    assert.ok(Math.abs(up[0]) < 1e-9 && Math.abs(up[1]) < 1e-9 && Math.abs(up[2] - 1) < 1e-9, `up ${up}`);
    const layout = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      return { view: r('viewport'), left: r('turn-left'), right: r('turn-right'), step: r('turn-step') };
    });
    const middle = layout.view.top + layout.view.height / 2;
    for (const arrow of [layout.left, layout.right]) assert.ok(Math.abs(arrow.top + arrow.height / 2 - middle) <= 5, JSON.stringify(layout));
    assert.ok(layout.left.left - layout.view.left < layout.view.width / 4 && layout.right.right - layout.view.left > (3 * layout.view.width) / 4);
    assert.ok(layout.step.right <= layout.view.right - 10 && layout.step.bottom <= layout.view.bottom && layout.step.left > layout.view.left + layout.view.width / 2);
    assert.match(await hint(), /point 1\b/);
    assert.match(await page.textContent('#draw-hint'), /point 1\b/);
    assert.match(await page.getAttribute('#turn-left', 'aria-label'), /vers la gauche de 1\/4 de tour autour de l'axe Z/);

    // 2. Two points on the front face (placed by hand: not quite level), then a quarter turn: still drawing.
    const front = [0, -1, 0];
    await faceToward(page, [20, 0, 10], front);
    await clickModel(page, [20, 0, 10.2]);
    await clickModel(page, [40, 0, 9.9]);
    assert.deepEqual((await segmentRows(page)).map((r) => r.name), ['1-2']);
    const turned = await page.evaluate(() => document.getElementById('viewport').dataset.turn);
    await page.click('#turn-right');
    assert.equal(await page.evaluate(() => document.getElementById('viewport').dataset.turn), String((Number(turned) + 90) % 360));
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw').classList.contains('active')), true);
    assert.match(await hint(), /^Point 3 : cliquez sur la pièce/);

    // 3. Round the part, the arrows turning it to each face; undone, redone.
    for (const [p, n] of [[[60, 20, 10.1], [1, 0, 0]], [[40, 40, 9.8], [0, 1, 0]], [[20, 40, 10.2], [0, 1, 0]], [[0, 20, 10], [-1, 0, 0]]]) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    assert.equal((await segmentRows(page)).length, 5);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+z');
    assert.equal((await segmentRows(page)).length, 4);
    await page.keyboard.press('Control+y');
    assert.equal((await segmentRows(page)).length, 5);

    // 4. A click 5 px from point 1: the loop closed, the halves proposed and applied.
    await faceToward(page, [20, 0, 10.2], front);
    await clickModel(page, [20, 0, 10.2], [5, 0]);
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.deepEqual((await segmentRows(page)).map((r) => r.name), ['1-2', '2-3', '3-4', '4-5', '5-6', '6-1']);
    let shown = await card();
    assert.equal(shown.stage, 'halves');
    assert.ok(shown.overlay.split(' ').includes('drawing'), shown.overlay);
    let stats = await partingStats(page);
    assert.equal(stats['Contre-dépouilles (noyaux, tiroirs)'], '0 % (0 cm²)');
    assert.match(stats['Dessin manuel'], /^6 points, 6 segments \(0 courbe\(s\)\), 1 boucle\(s\), 2 parties$/);
    assert.match(await page.textContent('#parting-draw-parts'), /^2 parties : 1 en chape supérieure, 1 en chape inférieure$/);
    // The points not quite level: aligned at Z = 10, the line planar there, 200 mm round the block.
    assert.equal(await page.isVisible('#parting-draw-align'), true);
    assert.match(await page.textContent('#parting-draw-align-label'), /^Aligner les points de la boucle 1 à Z =$/);
    await page.fill('#parting-draw-level', '10');
    await page.click('#parting-draw-align-apply');
    await page.waitForFunction(() => [...document.querySelectorAll('#parting-stats dt')].some((dt) => dt.textContent === 'Ligne de joint' && dt.nextElementSibling.textContent === 'plane, à Z = 10 mm'), null, { timeout: 30_000 });
    stats = await partingStats(page);
    assert.equal(stats['Longueur de la ligne'], '200 mm, 1 boucle(s)');
    assert.equal(await page.isHidden('#parting-draw-align'), true);
    let s = await semantic();
    assert.deepEqual([s.parting.status, s.parting.source, s.parting.undercut_basis, s.parting.drawn.segments.length], ['manual', 'drawn', 'drawn_halves', 6]);
    assert.ok(s.parting.drawn.segments.every((seg) => seg.on_parting_line && seg.type === 'straight'));
    assert.equal(s.foundry.rules.parting_line, 'manual');
    assert.ok(s.foundry.evidence.confirmed.includes('parting_line_drawn_by_hand'));
    assert.deepEqual([s.ai.source, s.ai.drawn_loops, s.ai.curved_segments, s.ai.planar], ['drawn', 1, 0, true]);

    // 5. The top part given to the lower chape: undercuts (the top cannot leave downwards); swapped: none.
    await page.click('#parting-draw-lower');
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw-lower').classList.contains('active')), true);
    await page.click('[data-view="top"]');
    await clickModel(page, [30, 20, 20]);
    await page.waitForFunction(() => !/^0 %/.test([...document.querySelectorAll('#parting-stats dt')].find((dt) => dt.textContent.startsWith('Contre-dépouilles')).nextElementSibling.textContent), null, { timeout: 30_000 });
    await page.click('#parting-draw-swap');
    await page.waitForFunction(() => [...document.querySelectorAll('#parting-stats dt')].find((dt) => dt.textContent.startsWith('Contre-dépouilles')).nextElementSibling.textContent === '0 % (0 cm²)', null, { timeout: 30_000 });

    // 6. The step 1/8: the right arrow key turns by 45°, the drawing goes on.
    await page.click('#turn-step [data-step="8"]');
    assert.equal(await page.getAttribute('#turn-step [data-step="8"]', 'aria-checked'), 'true');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ArrowRight');
    const before = Number(await page.evaluate(() => document.getElementById('viewport').dataset.turn));
    await page.keyboard.press('ArrowRight');
    // (Seen from the top, the axis towards the viewer: the right arrow turns the part clockwise on the screen, -45° about +Z.)
    const after = Number(await page.evaluate(() => document.getElementById('viewport').dataset.turn));
    assert.equal(after, (before + 315) % 360);
    assert.equal(await page.textContent('#turn-angle'), `Rotation : ${String(after).replace('.', ',')}°`);
    assert.equal((await card()).stage, 'halves');

    // 7. Segment 1-2 curved: radius 20 by default; 9 refused (under half the chord); 15: an arc 21,9 mm, the line no longer planar.
    const row = '#parting-draw-segments tr[data-seg="0:0"]';
    const edit = '#parting-draw-segments tr.seg-arc-edit[data-seg="0:0"]';
    await page.selectOption(`${row} select`, 'arc');
    await page.waitForSelector(edit);
    assert.ok(Math.abs(Number(await page.inputValue(`${edit} input[data-field="radius"]`)) - 20) < 0.1);
    const lengthBefore = (await segmentRows(page))[0].length;
    await page.fill(`${edit} input[data-field="radius"]`, '9');
    await page.dispatchEvent(`${edit} input[data-field="radius"]`, 'change');
    assert.match(await page.textContent('#parting-draw-segments tr.parting-seg-error[data-seg="0:0"]'), /^Rayon trop petit : au moins 10(,\d+)? mm/);
    assert.equal(await page.getAttribute(`${edit} input[data-field="radius"]`, 'aria-invalid'), 'true');
    assert.equal((await segmentRows(page))[0].length, lengthBefore);
    await page.fill(`${edit} input[data-field="radius"]`, '15');
    await page.dispatchEvent(`${edit} input[data-field="radius"]`, 'change');
    await page.waitForFunction(() => /^non plane/.test([...document.querySelectorAll('#parting-stats dt')].find((dt) => dt.textContent === 'Ligne de joint').nextElementSibling.textContent), null, { timeout: 30_000 });
    assert.deepEqual((await segmentRows(page))[0], { name: '1-2', length: '21,9 mm', type: 'arc' });
    assert.equal(await page.isHidden('#parting-draw-segments tr.parting-seg-error[data-seg="0:0"]'), true);
    const centreZ = async () => Number((await page.inputValue(`${edit} input[data-field="centre"]`)).split(' ; ')[2].replace(',', '.'));
    assert.ok((await centreZ()) < 10, 'the centre under the line: the arc rises');
    s = await semantic();
    assert.deepEqual([s.parting.drawn.segments[0].type, s.parting.drawn.segments[0].radius_mm, s.ai.curved_segments, s.ai.planar], ['curved', 15, 1, false]);
    // '⇅': the centre above the line, the arc dips.
    await page.click(`${edit} button[data-action="centreFlip"]`);
    await page.waitForFunction(() => {
      const input = document.querySelector('#parting-draw-segments tr.seg-arc-edit[data-seg="0:0"] input[data-field="centre"]');
      return input && Number(input.value.split(' ; ')[2].replace(',', '.')) > 10;
    });
    assert.ok((await centreZ()) > 10);
    // A gentle arc (radius 2 m): its centre over a metre away, its field taken back as it is shown (the thousands not grouped).
    await page.fill(`${edit} input[data-field="radius"]`, '2000');
    await page.dispatchEvent(`${edit} input[data-field="radius"]`, 'change');
    const far = await page.inputValue(`${edit} input[data-field="centre"]`);
    assert.ok((await centreZ()) > 1000 && !/[\u00a0\u202f]/.test(far), far);
    await page.dispatchEvent(`${edit} input[data-field="centre"]`, 'change');
    assert.equal(await page.isHidden('#parting-draw-segments tr.parting-seg-error[data-seg="0:0"]'), true, far);
    assert.ok(Math.abs(Number(await page.inputValue(`${edit} input[data-field="radius"]`)) - 2000) < 0.1);
    await page.fill(`${edit} input[data-field="radius"]`, '15');
    await page.dispatchEvent(`${edit} input[data-field="radius"]`, 'change');
    assert.deepEqual((await segmentRows(page))[0], { name: '1-2', length: '21,9 mm', type: 'arc' });
    assert.ok((await centreZ()) > 10);

    // 8. Terminer: the drawn line shown as any definition (blocks, line), the controls of the view gone.
    await page.click('#parting-draw-done');
    assert.equal(await page.isHidden('#draw-overlay'), true);
    shown = await card();
    assert.deepEqual([shown.overlay, shown.origin, shown.stage], ['lower upper line', 'dessin manuel', '']);
    const kept = Object.values(JSON.parse(await page.evaluate(() => localStorage.getItem('reader3d.parting.v1'))))[0];
    assert.equal(kept.bodies[0].source, 'drawn');
    assert.equal(kept.bodies[0].drawing.loops[0].pts.length, 6);
    assert.equal(kept.drafts, undefined);
    stats = await partingStats(page);

    // 9. Kept in this browser: after a reload, the same line, the same drawing to go on with.
    await page.reload();
    await open();
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.deepEqual(await partingStats(page), stats);
    await page.click('#parting-draw');
    const rows = await segmentRows(page);
    assert.deepEqual(rows.map((r) => r.name), ['1-2', '2-3', '3-4', '4-5', '5-6', '6-1']);
    assert.deepEqual([rows[0].type, rows[0].length], ['arc', '21,9 mm']);
    assert.equal((await card()).origin, 'dessin manuel');

    // 10. Cleared (confirmed): the proposal back. Two points, then Esc: kept as a draft, after a reload too.
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#parting-draw-clear');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'proposé');
    assert.equal((await segmentRows(page)).length, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('reader3d.parting.v1')), '{}');
    await page.click('#parting-draw-side'); // from the top view: the side view, the axis upright
    assert.ok(Math.abs((await page.evaluate(() => window.reader3d.view)).up[2] - 1) < 1e-9);
    await faceToward(page, [20, 0, 10], front);
    await clickModel(page, [20, 0, 10]);
    await clickModel(page, [40, 0, 10]);
    // 1-2 curved, its centre to place, then both points deleted: the centre no longer placed, a click places point 1.
    await page.selectOption('#parting-draw-segments tr[data-seg="0:0"] select', 'arc');
    await page.click('#parting-draw-segments tr.seg-arc-edit[data-seg="0:0"] button[data-action="placeCentre"]');
    assert.match(await hint(), /centre de l'arc 1-2/);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    assert.equal(await page.$$eval('#draw-labels span', (s) => s.length), 0);
    assert.match(await hint(), /placer le point 1\b/);
    await clickModel(page, [20, 0, 10]);
    await clickModel(page, [40, 0, 10]);
    assert.deepEqual((await segmentRows(page)).map((r) => [r.name, r.type]), [['1-2', 'straight']]);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#parting-draw-panel'), true);
    assert.equal(await page.textContent('#parting-draw-kept'), 'Tracé en cours gardé : 2 point(s)');
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('reader3d.parting.v1') ?? '{}'))[0]?.drafts?.[0]);
    await page.reload();
    await open();
    await page.waitForSelector('#parting-draw-kept:not([hidden])');
    assert.equal(await page.textContent('#parting-draw-kept'), 'Tracé en cours gardé : 2 point(s)');

    // 11. A view too narrow for the step and the actions side by side with their labels (beside the panel, windows of
    // 1024 and 1100 px): their compact form, none over another, nor the view triad (above the actions). A phone: within
    // the view too; no horizontal scroll. A view too short for the triad at its size under the left arrow: smaller.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.click('#parting-draw');
    for (const width of [1024, 1100]) {
      await page.setViewportSize({ width, height: 768 });
      const narrow = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
        return { view: r('viewport'), boxes: ['turn-left', 'turn-right', 'turn-step', 'draw-actions', 'view-triad'].map(r) };
      });
      assert.ok(narrow.view.width < 800, JSON.stringify(narrow.view));
      for (const b of narrow.boxes) assert.ok(b.left >= narrow.view.left && b.right <= narrow.view.right && b.bottom <= narrow.view.bottom, JSON.stringify(narrow));
      for (let a = 0; a < narrow.boxes.length; a++) for (let b = a + 1; b < narrow.boxes.length; b++) assert.ok(!overlap(narrow.boxes[a], narrow.boxes[b]), `${width}: ${a} over ${b}: ${JSON.stringify(narrow.boxes)}`);
    }
    await page.setViewportSize({ width: 375, height: 800 });
    assert.deepEqual((await segmentRows(page)).map((r) => r.name), ['1-2']);
    const phone = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      return {
        page: document.documentElement.scrollWidth,
        view: r('viewport'),
        boxes: ['turn-left', 'turn-right', 'turn-step', 'draw-actions', 'view-triad'].map(r),
        table: r('parting-draw-segments'),
        wide: [...document.querySelectorAll('#parting-card *')].filter((x) => x.offsetParent && x.getBoundingClientRect().right > 375).map((x) => x.id || x.className || x.tagName),
      };
    });
    assert.equal(phone.page, 375);
    assert.deepEqual(phone.wide, []);
    assert.ok(phone.table.right <= 375);
    for (const b of phone.boxes) assert.ok(b.left >= phone.view.left && b.right <= phone.view.right && b.top >= phone.view.top && b.bottom <= phone.view.bottom, JSON.stringify(phone));
    for (let a = 0; a < phone.boxes.length; a++) for (let b = a + 1; b < phone.boxes.length; b++) assert.ok(!overlap(phone.boxes[a], phone.boxes[b]), `${a} over ${b}: ${JSON.stringify(phone.boxes)}`);
    await page.setViewportSize({ width: 1280, height: 420 });
    const short = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      return { view: r('viewport'), boxes: ['turn-left', 'turn-right', 'turn-step', 'draw-actions', 'view-triad'].map(r) };
    });
    const triad = short.boxes[4];
    assert.ok(short.view.height < 400 && triad.width < 96 && triad.width >= 56 && Math.abs(triad.width - triad.height) < 0.5, JSON.stringify(short));
    for (let a = 0; a < short.boxes.length; a++) for (let b = a + 1; b < short.boxes.length; b++) assert.ok(!overlap(short.boxes[a], short.boxes[b]), `short: ${a} over ${b}: ${JSON.stringify(short.boxes)}`);

    // 12. In English.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.selectOption('#language', 'en');
    assert.equal(await page.textContent('#parting-draw'), 'Draw by hand');
    assert.equal(await page.textContent('.turn-step-label'), 'Step');
    assert.match(await page.textContent('#parting-hint'), /^Point 3: click the part/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel : un clic sur le dernier point posé le retire (annulable), le placement continue ; glissé, il se déplace ; caché ou la boucle fermée, il reste', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A block 60 × 40 × 20 mm, drawn along Z.
    await page.setInputFiles('#file-input', { name: 'box.obj', mimeType: 'text/plain', buffer: voxelsObj([['a', () => true]], [12, 8, 4], 5) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    const hint = () => page.textContent('#parting-hint');
    const stage = () => page.evaluate(() => document.getElementById('parting-card').dataset.draw ?? '');
    const labels = () => page.$$eval('#draw-labels span', (s) => s.map((x) => x.textContent));
    const names = async () => (await segmentRows(page)).map((r) => r.name);
    const blur = () => page.evaluate(() => document.activeElement?.blur());
    await page.click('#parting-draw');
    assert.equal(await page.inputValue('#parting-draw-plane'), 'Z');

    // 1. A single point clicked: taken off, still placing (point 1 next); Ctrl+Z puts it back, Ctrl+Y takes it off again.
    const [front, right, back, left] = [[[30, 0, 10], [0, -1, 0]], [[60, 20, 10], [1, 0, 0]], [[30, 40, 10], [0, 1, 0]], [[0, 20, 10], [-1, 0, 0]]];
    await faceToward(page, ...front);
    await clickModel(page, front[0]);
    assert.deepEqual(await labels(), ['1']);
    assert.match(await hint(), /^Point 2 : .* ; cliquez sur le dernier point pour le retirer\.$/);
    await clickModel(page, front[0]);
    assert.deepEqual(await labels(), []);
    assert.equal(await stage(), 'points');
    assert.match(await hint(), /placer le point 1\b/);
    await blur();
    await page.keyboard.press('Control+z');
    assert.deepEqual(await labels(), ['1']);
    await page.keyboard.press('Control+y');
    assert.deepEqual(await labels(), []);

    // 2. Four points round the part, the last one clicked: three left, still placing; « Annuler » puts it back,
    // « Rétablir » takes it off again. The next click adds point 4, its segment from point 3.
    for (const [p, n] of [front, right, back, left]) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    assert.deepEqual(await names(), ['1-2', '2-3', '3-4']);
    await clickModel(page, left[0]);
    assert.deepEqual(await labels(), ['1', '2', '3']);
    assert.deepEqual(await names(), ['1-2', '2-3']);
    assert.equal(await stage(), 'points');
    assert.match(await hint(), /^Point 4 : cliquez sur la pièce/);
    await page.click('#parting-draw-undo');
    assert.deepEqual(await names(), ['1-2', '2-3', '3-4']);
    await page.click('#parting-draw-redo');
    assert.deepEqual(await names(), ['1-2', '2-3']);
    await clickModel(page, [0, 10, 10]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4']);
    const length34 = async () => Number((await segmentRows(page))[2].length.replace(' mm', '').replace(',', '.'));
    const added = (await segmentRows(page))[2];
    // (Round the corner: 30 mm along the back face, 30 along the left one.)
    assert.deepEqual([added.name, added.type], ['3-4', 'straight']);
    assert.ok(Math.abs((await length34()) - 60) < 2, `3-4 from point 3: ${added.length}`);

    // 3. The last point pressed and dragged: moved along the face, not taken off.
    const from = await page.evaluate(() => window.reader3d.screenOf([0, 10, 10]));
    const to = await page.evaluate(() => window.reader3d.screenOf([0, 25, 10]));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((l) => document.querySelector('#parting-draw-segments tr[data-seg="0:2"] td:nth-child(3)').textContent !== l, added.length);
    assert.ok(Math.abs((await length34()) - 45) < 2, `point 4 dragged: ${(await segmentRows(page))[2].length}`);
    assert.deepEqual(await labels(), ['1', '2', '3', '4']);

    // 4. Turned away, the last point behind the part: a click beside it is on the part in front, a point added there.
    await faceToward(page, ...right);
    const behind = await page.evaluate(() => window.reader3d.screenOf([0, 25, 10]));
    await page.mouse.click(behind.x + 6, behind.y);
    assert.deepEqual(await labels(), ['1', '2', '3', '4', '5']);
    await blur();
    await page.keyboard.press('Control+z');
    assert.deepEqual(await labels(), ['1', '2', '3', '4']);

    // 5. The loop closed (Enter): placing stopped, a click on the last point selects it, nothing taken off.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.equal(await stage(), 'halves');
    await faceToward(page, ...left);
    await clickModel(page, [0, 25, 10]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4']);
    assert.deepEqual(await names(), ['1-2', '2-3', '3-4', '4-1']);
    assert.equal(await page.textContent('#parting-draw-point-label'), 'Point 4 :');
    assert.equal(await stage(), 'halves');

    // 6. A second loop: its single point clicked, taken off, still placing it (loop 1 kept); point 4, of the loop
    // closed, only selected.
    await page.click('#parting-draw-new');
    await clickModel(page, [0, 15, 15]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4', '5']);
    await clickModel(page, [0, 25, 10]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4', '5']);
    assert.equal(await page.textContent('#parting-draw-point-label'), 'Point 4 :');
    await clickModel(page, [0, 15, 15]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4']);
    assert.equal(await stage(), 'points');
    assert.match(await hint(), /placer le point 5\b/);
    assert.deepEqual(await names(), ['1-2', '2-3', '3-4', '4-1']);
    await clickModel(page, [0, 15, 15]);
    assert.deepEqual(await labels(), ['1', '2', '3', '4', '5']);

    // 7. In English.
    await page.selectOption('#language', 'en');
    assert.match(await hint(), /^Point 6: .*; click the last point to remove it\.$/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel, bloc percé : la boucle extérieure seule ne sépare pas la pièce ; une boucle dans le trou en plus, deux parties', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // The block 100 × 60 × 20 mm with a hole Ø 20 through it along Z, round (50, 30).
    await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.click('#parting-draw');
    assert.equal(await page.inputValue('#parting-draw-plane'), 'Z');

    // Round the outside at mid-height, closed by Enter: a hole goes through the loop, nothing applied.
    for (const [p, n] of [[[30, 0, 10], [0, -1, 0]], [[100, 30, 10], [1, 0, 0]], [[70, 60, 10], [0, 1, 0]], [[0, 30, 10], [-1, 0, 0]]]) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /ne sépare pas la pièce/.test(document.getElementById('parting-hint').textContent), null, { timeout: 30_000 });
    assert.equal(await page.textContent('#parting-origin'), 'proposé');
    assert.equal(await page.isEnabled('#parting-draw-new'), true);
    assert.equal(await page.isHidden('#parting-draw-parts'), true);

    // A new loop on the wall of the hole at mid-height, seen from above into it (Iso), turned a quarter at a time.
    await page.click('#parting-draw-new');
    assert.equal(await page.evaluate(() => document.getElementById('parting-card').dataset.draw), 'points');
    await page.click('[data-view="iso"]');
    for (let k = 0; k < 4; k++) {
      // The far side of the hole: its wall faces the camera.
      const p = await page.evaluate(() => {
        const eye = window.reader3d.view.position;
        const az = Math.atan2(eye[1] - 30, eye[0] - 50) + Math.PI;
        return [50 + 10 * Math.cos(az), 30 + 10 * Math.sin(az), 10];
      });
      await clickModel(page, p);
      assert.equal(await page.$$eval('#draw-labels span', (s) => s.length), 5 + k, `point ${5 + k} placed in the hole`);
      await page.click('#turn-right');
    }
    await page.click('#parting-draw-close');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.equal(await page.textContent('#parting-draw-parts'), '2 parties : 1 en chape supérieure, 1 en chape inférieure');
    const rows = await segmentRows(page);
    assert.deepEqual(rows.map((r) => r.name), ['1-2', '2-3', '3-4', '4-1', '5-6', '6-7', '7-8', '8-5']);
    assert.ok(await page.isVisible('#parting-draw-segments tr.loop-head'));
    const stats = await partingStats(page);
    assert.equal(stats['Contre-dépouilles (noyaux, tiroirs)'], '0 % (0 cm²)');
    assert.match(stats['Longueur de la ligne'], /, 2 boucle\(s\)$/);
    assert.match(stats['Ligne de joint'], /^plane, à Z = 10 mm$/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel, deux corps : un clic sur l\'autre corps, un tour puis un point glissé, une masselotte quitte le dessin, la coupe', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Every body checked (a file of several bodies shows its largest one alone by default): all of them shown.
    await page.goto(`${base}?lang=fr&bodies=all`);
    await page.setInputFiles('#file-input', { name: 'blocks.obj', mimeType: 'text/plain', buffer: blocksObj() });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    const bodies = await page.evaluate(() => window.reader3d.result.bodies.map((b) => ({ closed: b.closed, x: b.bbox.min[0] })));
    const A = bodies.findIndex((b) => b.closed && b.x < 0);
    await page.click(`#bodies tr[data-index="${A}"] td.name`);
    await page.click('#parting-draw');
    await page.selectOption('#parting-draw-plane', 'Z');
    await page.click('#parting-draw-side');
    const points = () => page.$$eval('#draw-labels span', (s) => s.length);
    const front = [0, -1, 0];

    // B (faded) clicked: no point, the hint says so.
    await faceToward(page, [50, -10, 0], front);
    await clickModel(page, [50, -10, 0]);
    assert.match(await page.textContent('#parting-hint'), /autre corps/);
    assert.equal(await points(), 0);
    // Two points on A's front face.
    await faceToward(page, [-50, -10, 0], front);
    await clickModel(page, [-80, -10, 0]);
    await clickModel(page, [-30, -10, 0]);
    assert.equal(await points(), 2);
    const length = async () => (await segmentRows(page))[0].length;
    const first = await length();
    assert.equal(first, '50 mm');

    // A turn there and back, the view dragged by hand: the drawing goes on, nothing lost.
    await page.click('#turn-right');
    await page.click('#turn-left');
    const view = await page.locator('#viewport canvas').boundingBox();
    const eye = (await page.evaluate(() => window.reader3d.view)).position;
    await page.mouse.move(view.x + 0.5 * view.width, view.y + 0.85 * view.height);
    await page.mouse.down();
    await page.mouse.move(view.x + 0.53 * view.width, view.y + 0.85 * view.height, { steps: 5 });
    await page.mouse.up();
    assert.notDeepEqual((await page.evaluate(() => window.reader3d.view)).position, eye);
    assert.equal(await points(), 2);
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw').classList.contains('active')), true);
    // Point 2 dragged along the face: its segment laid again, the view not turned; undone.
    await faceToward(page, [-30, -10, 0], front);
    const eye2 = (await page.evaluate(() => window.reader3d.view)).position;
    const from = await page.evaluate(() => window.reader3d.screenOf([-30, -10, 0]));
    const to = await page.evaluate(() => window.reader3d.screenOf([-55, -10, 0]));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((l) => document.querySelector('#parting-draw-segments tr[data-seg="0:0"] td:nth-child(3)').textContent !== l, first);
    const moved = Number((await length()).replace(' mm', '').replace(',', '.'));
    assert.ok(Math.abs(moved - 25) < 2, `point 2 dragged: ${moved}`);
    assert.deepEqual((await page.evaluate(() => window.reader3d.view)).position, eye2);
    assert.equal(await points(), 2);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+z');
    assert.equal(await length(), first);
    // Dragged again, Esc before the button is released: the point back where it was, still drawing.
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await length(), first);
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw').classList.contains('active')), true);

    // A riser to place: the drawing left (kept), the view's controls gone.
    await page.waitForSelector('#feeding-main:not([hidden])', { timeout: 60_000 });
    await page.click('#feeding-add');
    assert.equal(await page.evaluate(() => document.getElementById('parting-draw').classList.contains('active')), false);
    assert.equal(await page.isHidden('#draw-overlay'), true);
    assert.equal(await page.textContent('#parting-draw-kept'), 'Tracé en cours gardé : 2 point(s)');
    await page.click('#feeding-add');

    // Back to the drawing, the section on (Z at mid-height: z ≤ 10 kept): a point on the kept side placed, one on the side cut away not.
    await page.click('#parting-draw');
    assert.equal(await points(), 2);
    await page.click('#toggle-section');
    await page.click('#parting-draw-side');
    await faceToward(page, [-50, -10, 0], front);
    await clickModel(page, [-50, -10, 0]);
    assert.equal(await points(), 3);
    await clickModel(page, [-50, -10, 30]);
    assert.equal(await points(), 3);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel, deux boucles : la deuxième appliquée, l\'axe inversé puis annulé, le plan au clavier, les touches sur une autre page, un tracé fermé gardé puis repris', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A block 60 × 40 × 20 mm, drawn along Z: a loop round it at Z = 7.5, another at Z = 12.5 (three parts).
    const box = voxelsObj([['a', () => true]], [12, 8, 4], 5);
    const open = async () => {
      await page.setInputFiles('#file-input', { name: 'box.obj', mimeType: 'text/plain', buffer: box });
      await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
      await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    };
    const hint = () => page.textContent('#parting-hint');
    const stage = () => page.evaluate(() => document.getElementById('parting-card').dataset.draw ?? '');
    const labels = () => page.$$eval('#draw-labels span', (s) => s.length);
    const kept = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('reader3d.parting.v1') ?? '{}'))[0]);
    const view = () => page.evaluate(() => ({ up: window.reader3d.view.up, turn: document.getElementById('viewport').dataset.turn }));
    const drawnAxis = (z) => page.waitForFunction((v) => window.reader3d.semantic.bodies[0].parting?.drawn?.rotation_axis?.[2] === v, z, { timeout: 30_000 });
    const blur = () => page.evaluate(() => document.activeElement?.blur());
    const round = (z) => [[[30, 0, z], [0, -1, 0]], [[60, 20, z], [1, 0, 0]], [[30, 40, z], [0, 1, 0]], [[0, 20, z], [-1, 0, 0]]];
    await open();
    await page.click('#parting-draw');
    assert.equal(await page.inputValue('#parting-draw-plane'), 'Z');

    // 1. Loop 1, kept as a draft while open; closed by Enter: applied, its draft forgotten at once (a reload now finds none).
    for (const [p, n] of round(7.5)) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('reader3d.parting.v1') ?? '{}'))[0]?.drafts?.[0]);
    await blur();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.equal((await kept()).drafts, undefined);

    // 2. Nouvelle boucle: its points numbered on from 5, closed on point 5.
    await page.click('#parting-draw-new');
    assert.equal(await stage(), 'points');
    assert.match(await hint(), /placer le point 5\b/);
    const second = round(12.5);
    for (const [p, n] of second.slice(0, 3)) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    assert.match(await hint(), /^Point 8 : .* le point 5 \(/);
    assert.deepEqual((await segmentRows(page)).map((r) => r.name), ['1-2', '2-3', '3-4', '4-1', '5-6', '6-7']);

    // 3. On another page, the drawing's keys do nothing, and no point of the model is on the page. Back on the 3D view
    // (its tab clicked and the question asked at once, before the view's next frame): each point where it was, the
    // same points, the same turn.
    const before = await view();
    const at = (p) => page.evaluate((q) => window.reader3d.screenOf(q), p);
    const seen = await at(second[3][0]);
    assert.ok(seen);
    await page.click('.tabs .tab[data-page="chiffrage"]');
    for (const key of ['Backspace', 'Delete', 'ArrowRight']) await page.keyboard.press(key);
    assert.equal(await at(second[3][0]), null);
    assert.deepEqual(await page.evaluate((q) => {
      document.querySelector('.tabs .tab[data-page="viewer"]').click();
      return window.reader3d.screenOf(q);
    }, second[3][0]), seen);
    assert.equal(await labels(), 7);
    assert.equal((await view()).turn, before.turn);

    // 4. Point 8, Enter: both loops applied, three parts.
    await faceToward(page, ...second[3]);
    await clickModel(page, second[3][0]);
    await blur();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^8 points, 8 segments \(0 courbe\(s\)\), 2 boucle\(s\), 3 parties$/.test([...document.querySelectorAll('#parting-stats dt')].find((dt) => dt.textContent === 'Dessin manuel')?.nextElementSibling.textContent ?? ''), null, { timeout: 30_000 });
    assert.equal(await page.textContent('#parting-origin'), 'dessin manuel');
    assert.deepEqual((await segmentRows(page)).map((r) => r.name), ['1-2', '2-3', '3-4', '4-1', '5-6', '6-7', '7-8', '8-5']);
    assert.match(await page.textContent('#parting-draw-parts'), /^3 parties : /);

    // 5. The top given to the upper chape (towards +Z); the axis reversed (0 0 -1): that choice forgotten, the halves
    // proposed again along -Z (no undercut), the side view along -Z. Undone: +Z, the top chosen, the side view along +Z.
    await page.click('[data-view="top"]');
    await clickModel(page, [30, 20, 20]);
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('reader3d.parting.v1') ?? '{}'))[0]?.bodies?.[0]?.drawing?.seeds?.length === 1, null, { timeout: 30_000 });
    await page.selectOption('#parting-draw-plane', 'vector');
    await page.fill('#parting-draw-vector', '0 0 -1');
    await page.click('#parting-draw-vector-apply');
    await drawnAxis(-1);
    assert.equal((await partingStats(page))['Contre-dépouilles (noyaux, tiroirs)'], '0 % (0 cm²)');
    assert.deepEqual((await kept()).bodies[0].drawing.seeds, []);
    assert.ok(Math.abs((await view()).up[2] + 1) < 1e-9);
    await blur();
    await page.keyboard.press('Control+z');
    await drawnAxis(1);
    assert.equal((await kept()).bodies[0].drawing.seeds.length, 1);
    assert.ok(Math.abs((await view()).up[2] - 1) < 1e-9);

    // 6. A plane chosen in the list: the focus leaves it, → turns the part (the plane stays); undone, the side view
    // along Z again. « Face », then Esc: back to the drawing.
    await page.focus('#parting-draw-plane');
    await page.selectOption('#parting-draw-plane', 'X');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'parting-draw-plane');
    const alongX = await view();
    assert.ok(Math.abs(alongX.up[0] - 1) < 1e-9, JSON.stringify(alongX));
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.inputValue('#parting-draw-plane'), 'X');
    assert.notEqual((await view()).turn, alongX.turn);
    await page.keyboard.press('Control+z');
    assert.ok(Math.abs((await view()).up[2] - 1) < 1e-9);
    await page.focus('#parting-draw-plane');
    await page.selectOption('#parting-draw-plane', 'face');
    assert.equal(await stage(), 'axis-face');
    await page.keyboard.press('Escape');
    assert.equal(await stage(), 'halves');
    assert.notEqual(await page.inputValue('#parting-draw-plane'), 'face');
    await drawnAxis(1);

    // 7. Terminer, then another direction: the drawing kept as a draft. After a reload, taken back: its halves (three
    // parts) computed again and shown, the direction chosen still the one applied.
    await page.click('#parting-draw-done');
    const other = await page.$$eval('#parting-candidates tr[data-candidate]', (trs) => trs.find((tr) => !/^Z/.test(tr.cells[1].textContent))?.dataset.candidate);
    await page.click(`#parting-candidates tr[data-candidate="${other}"] input`);
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'manuel', null, { timeout: 30_000 });
    await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('reader3d.parting.v1') ?? '{}'))[0]?.drafts?.[0]);
    await page.reload();
    await open();
    await page.waitForSelector('#parting-draw-kept:not([hidden])');
    assert.equal(await page.textContent('#parting-draw-kept'), 'Tracé en cours gardé : 8 point(s)');
    await page.click('#parting-draw');
    await page.waitForSelector('#parting-draw-parts:not([hidden])', { timeout: 30_000 });
    assert.equal(await stage(), 'halves');
    assert.match(await page.textContent('#parting-draw-parts'), /^3 parties : /);
    assert.equal(await page.textContent('#parting-origin'), 'manuel');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('dessin manuel, barre à rainure : les contre-dépouilles du dessin écartent l\'attaque de coulée', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A bar 160 × 30 × 40 mm, a slot x 130..150, z 15..25, 10 deep in its front face (y = 0).
    const slot = (x, y, z) => x >= 26 && x < 30 && y < 2 && z >= 3 && z < 5;
    await page.setInputFiles('#file-input', { name: 'bar.obj', mimeType: 'text/plain', buffer: voxelsObj([['a', (x, y, z) => !slot(x, y, z)]], [32, 6, 8], 5) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.click('#parting-draw');
    await page.selectOption('#parting-draw-plane', 'Z');
    await page.click('#parting-draw-side');

    // A loop round it at Z = 12.5, under the slot: the slot, in the upper chape, cannot leave upwards (800 mm²).
    for (const [p, n] of [[[80, 0, 12.5], [0, -1, 0]], [[160, 15, 12.5], [1, 0, 0]], [[80, 30, 12.5], [0, 1, 0]], [[0, 15, 12.5], [-1, 0, 0]]]) {
      await faceToward(page, p, n);
      await clickModel(page, p);
    }
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('parting-origin').textContent === 'dessin manuel', null, { timeout: 30_000 });
    assert.match((await partingStats(page))['Contre-dépouilles (noyaux, tiroirs)'], /\(8 cm²\)$/);

    // The ingate placed on the drawn line, away from the slot (a slide there).
    await page.waitForSelector('#feeding-main:not([hidden])', { timeout: 120_000 });
    await page.waitForFunction(() => {
      const f = window.reader3d.semantic.bodies[0].feeding;
      return f?.draw_direction?.[2] === 1 && f.gate?.position_mm?.[2] === 12.5;
    }, null, { timeout: 60_000 });
    const gate = await page.evaluate(() => window.reader3d.semantic.bodies[0].feeding.gate);
    const off = (v, a, b) => Math.max(a - v, 0, v - b);
    const [x, y, z] = gate.position_mm;
    const away = Math.hypot(off(x, 130, 150), off(y, 0, 10), off(z, 15, 25));
    assert.ok(away > 40, `ingate ${gate.position_mm}, ${away.toFixed(1)} mm from the slot`);
    assert.equal(gate.near_undercut, false);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
