// End-to-end test of the section view of the built site (dist/): the solids
// the section plane cuts are closed by a cap lying in the plane (stencil
// buffer), not left open on their inside. The holed block with its riser and
// its ingate shown, cut through the riser and the part: the cut reads as
// material (the riser's orange, opaque; the part's own colour, darker), the
// ingate's arrow tip on the part; the caps follow the plane, go with the
// section. A model of three bodies: an open one and a faded one not capped,
// a hidden one neither.
//
//   npm run build && node --test tests/e2e/section.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { chromium } from 'playwright';

import { createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const CAD_TIMEOUT = 180_000;
const FOV = 40; // the camera of app.js

/** The pixel of the 3D view (CSS px from its top left) where a point (mm) is seen, from reader3d.view. */
async function project(page, p) {
  const { view, width, height } = await page.evaluate(() => {
    const canvas = document.querySelector('#viewport canvas');
    return { view: window.reader3d.view, width: canvas.clientWidth, height: canvas.clientHeight };
  });
  const sub = (a, b) => a.map((x, k) => x - b[k]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const f = unit(sub(view.target, view.position));
  const r = unit(cross(f, view.up));
  const u = cross(r, f);
  const d = sub(p, view.position);
  const t = Math.tan((FOV * Math.PI) / 360);
  const x = dot(d, r) / (dot(d, f) * t * (width / height));
  const y = dot(d, u) / (dot(d, f) * t);
  return [Math.round(((x + 1) / 2) * width), Math.round(((1 - y) / 2) * height)];
}

/** The colours [r, g, b] of the 3D view at these pixels, once drawn again. */
async function pixels(page, points) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await page.locator('#viewport canvas').screenshot();
  return page.evaluate(async ([b64, pts]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, [png.toString('base64'), points]);
}

/** What the section closes, once the view is drawn again: "body riser gate"… (data-caps of the 3D view). */
const capsShown = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.getElementById('viewport').dataset.caps ?? '')));
}));

/** sRGB 0-255 to linear light 0-1. */
const linear = (c) => c.map((v) => ((v / 255) <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
const isOrange = ([r, g, b]) => r > 170 && b < 80 && r - g > 50 && g > 60;
const isPurple = ([r, g, b]) => r > 120 && b > 120 && g < 90;

describe('section view: closed cuts (dist/)', { skip: !existsSync(join(DIST, 'index.html')) && 'run `npm run build` first' }, () => {
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

  test('the part, its riser and its ingate cut: closed by caps that follow the plane', { timeout: 2 * CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // The block 100 × 60 × 20 mm with a hole Ø 20 through it along Z, at (50, 30).
    await page.setInputFiles('#file-input', fixturePath('holed_block.step'));
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    await page.waitForFunction(() => document.getElementById('feeding-card').dataset.status === 'proposed', null, { timeout: 120_000 });
    const caps = () => capsShown(page);
    const bbox = await page.evaluate(() => window.reader3d.result.summary.bbox);
    const setSection = async (axis, at) => {
      const k = 'XYZ'.indexOf(axis);
      await page.selectOption('#section-axis', axis);
      const t = Math.round(((at - bbox.min[k]) / (bbox.max[k] - bbox.min[k])) * 1000);
      await page.$eval('#section-pos', (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input'));
      }, t);
      return bbox.min[k] + ((bbox.max[k] - bbox.min[k]) * t) / 1000; // where the plane is
    };
    assert.equal(await caps(), '');

    // The part alone, seen from the front: its front face y = 0, then cut along Y (the
    // front removed, ⇄): the cut faces the view as the front face did, the same light
    // on it, but darker (its own colour × 0.75), not the inside of the far wall.
    await page.click('[data-view="front"]');
    const inPart = await project(page, [20, 0, 10]);
    const [face] = await pixels(page, [inPart]);
    await page.click('#toggle-section');
    await page.click('#section-flip');
    const { feeding } = await page.evaluate(() => window.reader3d.semantic.bodies[0]);
    const [riser] = feeding.risers;
    const y = await setSection('Y', riser.position_mm[1]);
    assert.equal(await caps(), 'body');
    const [cut] = await pixels(page, [inPart]);
    const ratio = linear(cut).map((v, k) => v / linear(face)[k]);
    for (const x of ratio) assert.ok(x > 0.6 && x < 0.9, `the cut ${cut} against the face ${face}: ${ratio}`);

    // The risers and the ingate shown, with the parting line: the riser cut through its
    // axis, its cap opaque orange where its inside was open (the background behind it).
    await page.check('#feeding-show');
    await page.check('#parting-show');
    assert.equal(await page.evaluate(() => document.getElementById('feeding-card').dataset.markers), '2');
    assert.equal(await caps(), 'body riser');
    const inRiser = await project(page, [riser.position_mm[0], y, riser.position_mm[2] + riser.height_mm / 2]);
    const inBlock = await project(page, [20, y, 10]);
    let [riserCut, blockCut] = await pixels(page, [inRiser, inBlock]);
    assert.ok(isOrange(riserCut), `riser cut ${riserCut}`);
    // The part's cut in the neutral grey of the parting display, darker: grey, not blue nor yellow.
    assert.ok(Math.max(...blockCut) - Math.min(...blockCut) < 25 && Math.max(...blockCut) < 140, `part cut ${blockCut}`);

    // The arrow of the ingate: its tip on the part, at the ingate's point (on the parting line, bottom outline).
    const tipOnPart = async () => {
      const gate = (await page.evaluate(() => window.reader3d.semantic.bodies[0].feeding)).gate;
      const tip = JSON.parse(await page.evaluate(() => document.getElementById('feeding-card').dataset.gateTip));
      tip.forEach((x, k) => approx(x, gate.position_mm[k], 0, 1e-3, `tip ${k}`));
      // On the surface of the block: within it, on one of its faces.
      const inside = tip.every((x, k) => x >= bbox.min[k] - 1e-3 && x <= bbox.max[k] + 1e-3);
      const onFace = Math.min(...tip.flatMap((x, k) => [Math.abs(x - bbox.min[k]), Math.abs(x - bbox.max[k])]));
      assert.ok(inside && onFace < 1e-3, `tip ${tip} on the block`);
      return { gate, tip };
    };
    const proposed = await tipOnPart();
    approx(proposed.tip[2], 0, 0, 1e-3, 'on the bottom outline');

    // The plane moved past the riser: the part still cut, the riser no longer.
    const past = riser.position_mm[1] + riser.diameter_mm / 2 + 5;
    assert.ok(past < bbox.max[1], `the riser reaches y = ${past - 5}`);
    await setSection('Y', past);
    assert.equal(await caps(), 'body');
    [riserCut] = await pixels(page, [inRiser]);
    assert.ok(!isOrange(riserCut), `riser removed: ${riserCut}`);
    await setSection('Y', riser.position_mm[1]);
    assert.equal(await caps(), 'body riser');

    // Through the ingate (x = 50, the half x > 50 removed), seen from the right: its cone and shaft closed, purple.
    await page.click('#section-flip');
    const x = await setSection('X', proposed.gate.position_mm[0]);
    await page.click('[data-view="right"]');
    assert.equal(await caps(), 'body gate gate');
    // 12 mm out of the part from the tip, inside the cone, in the plane.
    const inGate = proposed.gate.position_mm.map((v, k) => (k === 0 ? x : v - 12 * proposed.gate.direction[k]));
    const [gateCut] = await pixels(page, [await project(page, inGate)]);
    assert.ok(isPurple(gateCut), `ingate cut ${gateCut}`);

    // The ingate placed by a click on the front face, with the section on (the plane x = 50 keeps the
    // front left): brought onto the parting line, the arrow's tip still on the part.
    await page.click('[data-view="front"]');
    await page.click('#feeding-gate');
    const view = await page.locator('#viewport canvas').boundingBox();
    const [cx, cy] = await project(page, [25, 0, 10]);
    await page.mouse.click(view.x + cx, view.y + cy);
    await page.waitForFunction(() => window.reader3d.semantic.bodies[0].feeding?.gate?.source === 'manual', null, { timeout: 10_000 });
    const placed = await tipOnPart();
    approx(placed.tip[1], 0, 0, 1e-3, 'on the front side');
    approx(placed.tip[2], 0, 0, 1e-3, 'on the bottom outline');

    // The section off: no cap left; on again: back.
    await page.click('#toggle-section');
    assert.equal(await caps(), '');
    assert.equal(await page.evaluate(() => document.getElementById('section-controls').hidden), true);
    await page.click('#toggle-section');
    assert.ok((await caps()).startsWith('body'));
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('an open body and a faded one are not capped, nor a hidden one; another model, other caps', { timeout: CAD_TIMEOUT }, async () => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?lang=fr`);
    // Three bodies 20 mm side by side along X: A a closed cube, B a box without its top (open), C a closed cube.
    const lines = [];
    const faces = [];
    let count = 0;
    const box = (material, x0, open = false) => {
      const v = [];
      for (let i = 0; i < 8; i++) {
        lines.push(`v ${i & 1 ? x0 + 20 : x0} ${i & 2 ? 20 : 0} ${i & 4 ? 20 : 0}`);
        v.push(++count);
      }
      faces.push(`usemtl ${material}`);
      // Counter-clockwise seen from outside; the last one is the top.
      const quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
      for (const q of open ? quads.slice(0, 5) : quads) faces.push(`f ${q.map((k) => v[k]).join(' ')}`);
    };
    box('a', 0);
    box('b', 40, true);
    box('c', 80);
    await page.setInputFiles('#file-input', { name: 'three_boxes.obj', mimeType: 'text/plain', buffer: Buffer.from([...lines, ...faces, ''].join('\n')) });
    await page.waitForFunction(() => document.body.dataset.status === 'done', null, { timeout: CAD_TIMEOUT });
    const bodies = await page.evaluate(() => window.reader3d.result.bodies.map((b) => ({ x: b.bbox.min[0], closed: b.closed })));
    const index = (x0) => bodies.findIndex((b) => Math.abs(b.x - x0) < 1e-6);
    const [A, B, C] = [index(0), index(40), index(80)];
    assert.deepEqual([bodies[A].closed, bodies[B].closed, bodies[C].closed], [true, false, true]);
    const caps = () => capsShown(page);

    // Cut along Z at mid height, seen from the top: the two closed cubes capped, the open box not.
    await page.click('[data-view="top"]');
    await page.click('#toggle-section');
    assert.equal(await caps(), 'body body');

    // C hidden (unchecked in the list): not capped; shown again: capped.
    await page.uncheck(`#bodies tr[data-index="${C}"] input`);
    assert.equal(await caps(), 'body');
    await page.check(`#bodies tr[data-index="${C}"] input`);
    assert.equal(await caps(), 'body body');

    // The parting line of A shown: C faded, not capped; hidden again: capped.
    await page.click(`#bodies tr[data-index="${A}"] td.name`);
    await page.waitForSelector('#parting-main:not([hidden])', { timeout: 60_000 });
    await page.check('#parting-show');
    assert.equal(await page.evaluate(() => document.getElementById('viewport').dataset.faded), '2');
    assert.equal(await caps(), 'body');
    await page.uncheck('#parting-show');
    assert.equal(await caps(), 'body body');

    // Another model in this tab: its own caps (one closed body).
    await page.setInputFiles('#file-input', fixturePath('box.stl'));
    await page.waitForFunction(() => document.body.dataset.status === 'done' && window.reader3d.tab.file === 'box.stl', null, { timeout: CAD_TIMEOUT });
    assert.equal(await caps(), 'body');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
