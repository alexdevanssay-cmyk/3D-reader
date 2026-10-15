// End-to-end test of the view triad of the built site (dist/): the axes X, Y
// and Z in the bottom left corner of the 3D view, turned with the camera, in
// place of the axes drawn before at the origin of the part. Hidden without a
// model; in its corner, at a pixel ratio of 2, hidden from screen readers; its
// axes where the camera sees them (Iso, Face, Dessus, Droite, a drag of the
// trackball, the « Coulée » view, whose up is not Z), each in its colour where
// it should be on the screen (X to the right and Z up in the Face view…); no
// axes at the origin of the part any more; over the part and its section;
// above the actions of the drawing by hand, back in its corner after.
//
//   npm run build && node --test tests/e2e/triad.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT } from '../js/helpers.mjs';
import { vBar } from '../js/meshes.mjs';

const DIST = join(ROOT, 'dist');
const TIMEOUT = 180_000;
const AXIS = 30; // px from the centre of the triad to the tip of an axis seen across (app.js TRIAD_AXIS)

/** An OBJ of the box from `min` to `max` (mm), as a file to open. */
function boxObj(name, min, max) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push(`v ${i & 1 ? max[0] : min[0]} ${i & 2 ? max[1] : min[1]} ${i & 4 ? max[2] : min[2]}`);
  // Counter-clockwise seen from outside.
  const f = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]].map((q) => `f ${q.map((k) => k + 1).join(' ')}`);
  return { name, mimeType: 'text/plain', buffer: Buffer.from([...v, ...f, ''].join('\n')) };
}

/** A binary STL of a mesh, as a file to open. */
function stlFile(name, { positions: P, indices: I }) {
  const n = I.length / 3;
  const buffer = Buffer.alloc(84 + 50 * n);
  buffer.writeUInt32LE(n, 80);
  for (let f = 0; f < n; f++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) buffer.writeFloatLE(P[3 * I[3 * f + c] + k], 84 + 50 * f + 12 + 12 * c + 4 * k);
  return { name, mimeType: 'application/octet-stream', buffer };
}

/**
 * The axes as the camera of reader3d.view sees them, and as the triad draws
 * them (the tip of each arrow), read together after a frame of the view (the
 * view may still turn, after a drag): each [right, down] on the screen, an
 * axis across the view of length 1. The camera turned to its target as
 * three.js does: z from the target to the eye, x = up × z, y = z × x.
 */
async function seenAndDrawn(page) {
  const { view, tips } = await page.evaluate(async (length) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      view: window.reader3d.view,
      tips: ['x', 'y', 'z'].map((a) => {
        const [tip] = document.querySelector(`#view-triad [data-axis="${a}"] polygon`).getAttribute('points').split(' ');
        return tip.split(',').map((v) => Number(v) / length);
      }),
    };
  }, AXIS);
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = unit(view.position.map((p, k) => p - view.target[k]));
  const x = unit(cross(view.up, z));
  const y = cross(z, x);
  return { seen: [0, 1, 2].map((k) => [x[k], -y[k]]), drawn: tips };
}

/** The triad drawn as the camera sees the axes (within 0.002 of an axis across the view). */
async function asCamera(page, label) {
  const { seen, drawn } = await seenAndDrawn(page);
  for (let k = 0; k < 3; k++) {
    for (let c = 0; c < 2; c++) assert.ok(Math.abs(drawn[k][c] - seen[k][c]) < 2e-3, `${label}: ${'XYZ'[k]} drawn ${drawn[k]}, seen ${seen[k]}`);
  }
}

/** The view zoomed no more (the inertia of the wheel spent: its distance to the target within 0.1 % from one look to the next). */
async function zoomed(page) {
  let last = 0;
  for (let k = 0; k < 60; k++) {
    const d = await page.evaluate(() => {
      const { position, target } = window.reader3d.view;
      return Math.hypot(...position.map((x, i) => x - target[i]));
    });
    if (Math.abs(d - last) < 1e-3 * d) return;
    last = d;
    await page.waitForTimeout(200);
  }
  throw new Error('the view still zooming');
}

/**
 * The pixels of the triad (a screenshot of the page where it is, over the 3D
 * view) within its disc, by the colour of each axis: for X (red), Y (green)
 * and Z (blue) how many, and where they are on average ([right, down] CSS px
 * from its centre); and the colour of the corner of its box (outside the disc:
 * the view under it).
 */
async function triadColours(page) {
  await page.waitForTimeout(300); // a frame drawn
  const box = await page.locator('#view-triad').boundingBox();
  const png = await page.locator('#view-triad').screenshot();
  return page.evaluate(async ([b64, css]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, img.width, img.height);
    const scale = img.width / css; // device px per CSS px
    const sums = { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] };
    for (let j = 0; j < img.height; j++) {
      for (let i = 0; i < img.width; i++) {
        const dx = (i + 0.5) / scale - css / 2, dy = (j + 0.5) / scale - css / 2;
        if (Math.hypot(dx, dy) > 0.45 * css) continue;
        const p = 4 * (j * img.width + i), r = data[p], gr = data[p + 1], b = data[p + 2];
        const axis = r > 150 && r - gr > 90 && r - b > 90 ? 'x' : gr > 100 && gr - r > 50 && gr - b > 40 ? 'y' : b > 150 && b - r > 110 && b - gr > 70 ? 'z' : null;
        if (!axis) continue;
        sums[axis][0] += 1;
        sums[axis][1] += dx;
        sums[axis][2] += dy;
      }
    }
    const out = { scale, size: img.width, corner: [...data.slice(4 * (2 * img.width + 2), 4 * (2 * img.width + 2) + 3)] };
    for (const [axis, [n, x, y]] of Object.entries(sums)) out[axis] = { n, at: n ? [x / n, y / n] : null };
    return out;
  }, [png.toString('base64'), box.width]);
}

/** Pixels of the 3D view, the triad masked: red and green (the X and Y of axes drawn at the origin of the part). */
async function redGreen(page) {
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
    const { data } = g.getImageData(0, 0, img.width, img.height);
    const n = { red: 0, green: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gr = data[i + 1], b = data[i + 2];
      if (r > 150 && r - gr > 90 && r - b > 90) n.red++;
      else if (gr > 100 && gr - r > 50 && gr - b > 40) n.green++;
    }
    return n;
  }, png.toString('base64'));
}

/** Where elements are on the page (DOMRects), by id. */
const rects = (page, ids) => page.evaluate((list) => Object.fromEntries(list.map((id) => [id, document.getElementById(id).getBoundingClientRect().toJSON()])), ids);
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('view triad (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
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

  test('in the bottom left corner, turned with the camera, in its colours; no axes at the origin; over the part and the section; above the actions of the drawing by hand', { timeout: 2 * TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // No model: no triad.
    assert.equal(await page.isHidden('#view-triad'), true);

    // A box 60 × 40 × 30 mm off the origin, which the axes drawn before at the origin stood beside.
    await page.setInputFiles('#file-input', boxObj('box.obj', [10, 10, 0], [70, 50, 30]));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    await page.waitForSelector('#view-triad:not([hidden])');
    assert.equal(await page.getAttribute('#view-triad', 'aria-hidden'), 'true');
    assert.equal(await page.$eval('#view-triad', (el) => getComputedStyle(el).pointerEvents), 'none');
    let at = await rects(page, ['viewport', 'view-triad']);
    const place = (r) => [r['view-triad'].left - r.viewport.left, r.viewport.bottom - r['view-triad'].bottom, r['view-triad'].width, r['view-triad'].height].map(Math.round);
    assert.deepEqual(place(at), [12, 12, 96, 96]);

    // Iso: X to the right and down, Y to the right and up, Z up.
    await asCamera(page, 'Iso');
    let c = await triadColours(page);
    for (const axis of ['x', 'y', 'z']) assert.ok(c[axis].n > 60, `Iso: ${axis} drawn: ${JSON.stringify(c)}`);
    assert.ok(c.x.at[0] > 8 && c.x.at[1] > 3 && c.y.at[0] > 8 && c.y.at[1] < -3 && Math.abs(c.z.at[0]) < 3 && c.z.at[1] < -15, `Iso: ${JSON.stringify(c)}`);

    // No axes at the origin of the part any more: they would be seen here, beside the box (red and green lines).
    const screen = await page.evaluate(() => [[0, 0, 0], [15, 0, 0], [0, 15, 0]].map((p) => window.reader3d.screenOf(p)));
    at = await rects(page, ['viewport', 'view-triad']);
    for (const p of screen) assert.ok(p && p.x > at.viewport.left && p.x < at.viewport.right && p.y > at.viewport.top && p.y < at.viewport.bottom && !overlap({ left: p.x, right: p.x + 1, top: p.y, bottom: p.y + 1 }, at['view-triad']), `the origin's axes in sight: ${JSON.stringify(screen)}`);
    assert.deepEqual(await redGreen(page), { red: 0, green: 0 });

    // The named views: X to the right and Z up from the front, Y seen end-on away (⊗) at the centre…
    const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
    await page.click('[data-view="front"]');
    await asCamera(page, 'Face');
    c = await triadColours(page);
    assert.ok(c.x.at[0] > 12 && Math.abs(c.x.at[1]) < 3 && c.z.at[1] < -12 && Math.abs(c.z.at[0]) < 3 && c.y.n > 30 && near(c.y.at, [0, 0], 14), `Face: ${JSON.stringify(c)}`);
    assert.equal(await page.getAttribute('#view-triad [data-axis="y"]', 'class'), 'triad-axis');
    // … from above, X to the right and Y up, Z towards the viewer (⊙); from the right, Y to the right and Z up, X towards the viewer.
    await page.click('[data-view="top"]');
    await asCamera(page, 'Dessus');
    c = await triadColours(page);
    assert.ok(c.x.at[0] > 12 && Math.abs(c.x.at[1]) < 3 && c.y.at[1] < -12 && Math.abs(c.y.at[0]) < 3 && c.z.n > 30 && near(c.z.at, [0, 0], 14), `Dessus: ${JSON.stringify(c)}`);
    assert.equal(await page.getAttribute('#view-triad [data-axis="z"]', 'class'), 'triad-axis toward');
    await page.click('[data-view="right"]');
    await asCamera(page, 'Droite');
    c = await triadColours(page);
    assert.ok(c.y.at[0] > 12 && Math.abs(c.y.at[1]) < 3 && c.z.at[1] < -12 && Math.abs(c.z.at[0]) < 3 && c.x.n > 30 && near(c.x.at, [0, 0], 14), `Droite: ${JSON.stringify(c)}`);

    // The trackball turned freely (its up turned with it): the triad still as the camera sees the axes.
    const view = await page.locator('#viewport canvas').boundingBox();
    const drag = async (dx, dy) => {
      await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
      await page.mouse.down();
      await page.mouse.move(view.x + view.width / 2 + dx, view.y + view.height / 2 + dy, { steps: 8 });
      await page.mouse.up();
    };
    await drag(160, 90);
    await drag(-40, 150);
    const up = (await page.evaluate(() => window.reader3d.view)).up;
    assert.ok(Math.abs(up[2]) < 0.99, `the camera's up turned: ${up}`);
    await asCamera(page, 'dragged');
    // A drag that starts on the triad turns the view too (no pointer events on it).
    at = await rects(page, ['view-triad']);
    const before = JSON.stringify(await page.evaluate(() => window.reader3d.view));
    await page.mouse.move(at['view-triad'].left + 48, at['view-triad'].top + 48);
    await page.mouse.down();
    await page.mouse.move(at['view-triad'].left + 148, at['view-triad'].top - 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.notEqual(JSON.stringify(await page.evaluate(() => window.reader3d.view)), before);
    await asCamera(page, 'dragged from the triad');

    // Over the part and its section: from the front, zoomed in until the part fills the corner, cut at mid-height.
    await page.click('[data-view="front"]');
    const plain = await triadColours(page);
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    for (let k = 0; k < 10; k++) await page.mouse.wheel(0, -400);
    await zoomed(page);
    await page.click('#toggle-section');
    await page.waitForFunction(() => document.getElementById('viewport').dataset.caps === 'body');
    c = await triadColours(page);
    assert.notDeepEqual(c.corner, plain.corner, `the part behind the triad: ${c.corner} / ${plain.corner}`);
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(c[axis].n - plain[axis].n) <= 0.05 * plain[axis].n && near(c[axis].at, plain[axis].at, 1), `${axis} over the section: ${JSON.stringify(c)} / ${JSON.stringify(plain)}`);
    await page.click('#toggle-section');

    // Drawing the parting line by hand: the triad above its actions (bottom left), clear of the arrow and of the step; back in its corner after.
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.click('#parting-draw');
    await page.waitForSelector('#draw-overlay:not([hidden])');
    at = await rects(page, ['viewport', 'view-triad', 'draw-actions', 'turn-left', 'turn-step']);
    const triad = at['view-triad'];
    assert.ok(Math.round(triad.left - at.viewport.left) === 12 && triad.bottom <= at['draw-actions'].top - 4 && Math.round(triad.width) === 96, JSON.stringify(at));
    for (const id of ['draw-actions', 'turn-left', 'turn-step']) assert.ok(!overlap(triad, at[id]), `the triad over ${id}: ${JSON.stringify(at)}`);
    await asCamera(page, 'drawing by hand');
    await page.click('#parting-draw-done');
    await page.waitForSelector('#draw-overlay', { state: 'hidden' });
    assert.deepEqual(place(await rects(page, ['viewport', 'view-triad'])), [12, 12, 96, 96]);

    // Another tab without a model: no triad; back to the box: the triad again.
    await page.click('.doc-tab-new');
    assert.equal(await page.isHidden('#view-triad'), true);
    await page.click('.doc-tab:first-child');
    await page.waitForSelector('#view-triad:not([hidden])');
    await asCamera(page, 'back to the tab');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the « Coulée » view: the up of the casting on the screen, the triad turned with it; at a pixel ratio of 2', { timeout: TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // A V bent bar turned 20° about Z: cast in a gravity die, the arms of the V up, along (-0.342, 0.94, 0).
    await page.setInputFiles('#file-input', stlFile('V.stl', vBar({ turn: 20, offset: [30, -15, 5] })));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: TIMEOUT });
    await page.waitForFunction(() => !document.getElementById('view-casting').disabled, null, { timeout: 120_000 });
    await page.click('#view-casting');
    const up = (await page.evaluate(() => window.reader3d.view)).up;
    const g = [-Math.sin(Math.PI / 9), Math.cos(Math.PI / 9), 0];
    assert.ok(up.every((x, k) => Math.abs(x - g[k]) < 1e-5), `the camera's up ${up}`);
    await asCamera(page, 'Coulée');
    // Y upright on the screen within 20° (the up of the casting is 20° off Y), X and Z to the right; drawn at the pixel ratio of the page.
    const c = await triadColours(page);
    assert.deepEqual([c.scale, c.size], [2, 192]);
    assert.ok(c.y.at[1] < -10 && Math.abs(c.y.at[0]) < 0.4 * -c.y.at[1] && c.x.at[0] > 8 && c.z.at[0] > 8, `Coulée: ${JSON.stringify(c)}`);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
