// End-to-end test of the built static site (dist/) in headless Chromium.
//
//   npm run build && npm run test:e2e
//
// dist/ is served by scripts/serve.mjs on a free port, below the base path it
// was built for (base_path in dist/version.json: "/" by default, "/<repository>/"
// in CI, as on GitHub Pages). Fixture files are opened through the page's file
// input, exactly as a visitor would, and the displayed total volume is compared
// with the Python engine's result (tests/fixtures/generated/expected.json,
// written by tests/make_fixtures.py).
//
// The request handling of serve.mjs is also checked on a small temporary site,
// and the Codespaces start-up commands (.devcontainer/devcontainer.json) with
// stand-in programs.
//
// Browsers come from Playwright (`npx playwright install chromium`) or from the
// directory named by PLAYWRIGHT_BROWSERS_PATH; /opt/pw-browsers is used when
// that variable is not set and the directory exists.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { builtBasePath, createStaticServer } from '../../scripts/serve.mjs';
import { ROOT, approx, fixturePath, loadExpected } from '../js/helpers.mjs';

const DIST = join(ROOT, 'dist');
const SERVE = join(ROOT, 'scripts', 'serve.mjs');
const DEVCONTAINER = join(ROOT, '.devcontainer', 'devcontainer.json');

// CAD files first need the OpenCascade WebAssembly (13 MB download, 48 MB to
// compile), which is slow on CI machines without a GPU or many cores.
const CAD_TIMEOUT = 240_000;
const MESH_TIMEOUT = 90_000;

const FIXTURES = [
  { name: 'holed_block.step', cad: true },
  { name: 'named_assembly.step', cad: true },
  { name: 'box.stl' },
  { name: 'box.3mf' },
  { name: 'box.dae' },
  { name: 'two_objects.glb' },
];

// ------------------------------------------------------------------ server

let server = null; // { url, origin, basePath, stop }: dist/ served by serve.mjs
let serverStart = null;

/** Start scripts/serve.mjs on a free port and resolve once it prints its URL. */
function startServer(dir, basePath) {
  const args = [SERVE, dir, '--port', '0', '--host', '127.0.0.1', '--base-path', basePath, '--quiet'];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve.mjs did not start in time:\n${output}`)), 15_000);
    const collect = (chunk) => {
      output += chunk;
      const m = /http:\/\/\S+\//.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`serve.mjs exited with code ${code}:\n${output}`));
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  return url.then(
    (u) => ({ url: u, origin: new URL(u).origin, basePath, stop }),
    async (err) => {
      await stop();
      throw err;
    },
  );
}

/** dist/ served below its base path; started once, by the first suite that needs it. */
function distServer() {
  serverStart ??= (async () => {
    assert.ok(existsSync(join(DIST, 'index.html')), 'dist/ is missing: run `npm run build` first');
    server = await startServer(DIST, builtBasePath(DIST));
    return server;
  })();
  return serverStart;
}

after(async () => {
  await server?.stop();
});

/**
 * Raw HTTP request (the path is sent as is, unlike fetch which normalises
 * ".." and "//"). With abortAfterFirstChunk the download is cut short, as a
 * closed tab does.
 */
function httpGet(origin, path, { method = 'GET', headers = {}, abortAfterFirstChunk = false } = {}) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (abortAfterFirstChunk) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', (err) => (abortAfterFirstChunk ? undefined : reject(err)));
    req.end();
  });
}

/** Request path of a site file below the base path of dist/ ("app.js" -> "/3D-reader/app.js"). */
const site = (path) => `${server.basePath}${path}`;

describe('static server (scripts/serve.mjs) on dist/', () => {
  before(distServer);

  test('serves index.html for the site root and the site files with their MIME types', async () => {
    const index = await httpGet(server.origin, site(''));
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.match(index.body.toString(), /<title>3D Reader<\/title>/);

    for (const [path, type] of [
      ['app.js', /^text\/javascript/],
      ['engine/client.js', /^text\/javascript/],
      ['engine/worker.js', /^text\/javascript/],
      ['vendor/three/three.module.js', /^text\/javascript/],
      ['vendor/opencascade/opencascade.full.js', /^text\/javascript/],
      ['style.css', /^text\/css/],
      ['config.json', /^application\/json/],
      ['version.json', /^application\/json/],
    ]) {
      const res = await httpGet(server.origin, site(path), { method: 'HEAD' });
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'], type, path);
    }
  });

  test('sends the compressed OpenCascade binary as it is (the page gunzips it)', async () => {
    const res = await httpGet(server.origin, site('vendor/opencascade/opencascade.full.wasm.gz'), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/gzip');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.ok(Number(res.headers['content-length']) > 5_000_000, 'wasm.gz looks truncated');
  });

  test('build metadata: version.json, .nojekyll, 404.html pinned to the base path', async () => {
    const version = JSON.parse((await httpGet(server.origin, site('version.json'))).body.toString());
    assert.ok(version.commit === null || /^[0-9a-f]{40}$/.test(version.commit), `commit: ${version.commit}`);
    assert.ok(!Number.isNaN(Date.parse(version.built_at)), `built_at: ${version.built_at}`);
    assert.equal(version.base_path, server.basePath);
    assert.ok(existsSync(join(DIST, '.nojekyll')));
    const missing = await httpGet(server.origin, site('no/such/page'));
    assert.equal(missing.status, 404);
    const html = missing.body.toString();
    assert.match(html, /<title>3D Reader<\/title>/);
    // Without <base>, the relative URLs of the page would resolve below
    // /no/such/ (the browser test below opens such a page).
    const base = /<base href="([^"]*)">/.exec(html);
    assert.equal(base?.[1], server.basePath, '404.html must pin its URLs to the site root');
    assert.ok(html.indexOf('<base ') < html.indexOf('<link '), '<base> must come before the stylesheet');
  });

  test('refuses paths outside the served directory', async () => {
    assert.ok(existsSync(join(ROOT, 'package.json')));
    for (const path of ['../package.json', '%2e%2e/package.json', 'vendor/..%2f..%2fpackage.json', '..%5cpackage.json']) {
      const res = await httpGet(server.origin, site(path));
      assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
      assert.doesNotMatch(res.body.toString(), /"devDependencies"/, path);
    }
  });
});

describe('static server (scripts/serve.mjs): request edge cases', () => {
  let dir; // temporary directory: site/ (the served files) and outside/
  const servers = [];

  /** Serve root in this process on a free port; resolves to its origin. */
  async function listen(root, options = {}) {
    const s = createStaticServer(root, options);
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    servers.push(s);
    return `http://127.0.0.1:${s.address().port}`;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'reader3d-serve-'));
    const files = {
      'site/index.html': '<title>root</title>',
      'site/404.html': '<title>missing</title>',
      'site/app.js': 'export const app = 1;\n',
      'site/engine/client.js': 'export const client = 1;\n',
      'site/sub/index.html': '<title>sub</title>',
      'outside/secret.txt': 'SECRET\n',
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    // Larger than the socket buffers, so that a download is still running when cut short.
    writeFileSync(join(dir, 'site', 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 1));
  });

  after(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('a path starting with "//" names a file of the site, not a host', async () => {
    const origin = await listen(join(dir, 'site'));
    for (const [path, content] of [
      ['//app.js', 'export const app = 1;\n'],
      ['//engine/client.js', 'export const client = 1;\n'],
      ['/engine//client.js', 'export const client = 1;\n'],
      ['//app.js?v=2', 'export const app = 1;\n'],
    ]) {
      const res = await httpGet(origin, path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'], /^text\/javascript/, path);
      assert.equal(res.body.toString(), content, path);
    }
    // The trailing-slash redirect cannot point to another host either.
    const res = await httpGet(origin, '//sub');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/sub/');
  });

  test('never sends a file that a symbolic link places outside the site', async (t) => {
    const linked = join(dir, 'linked');
    mkdirSync(join(linked, 'sub'), { recursive: true });
    writeFileSync(join(linked, 'index.html'), '<title>root</title>');
    try {
      // index.html of a directory and the 404 page are picked by the server,
      // not named by the request: they must be checked too.
      symlinkSync(join('..', '..', 'outside', 'secret.txt'), join(linked, 'sub', 'index.html'));
      symlinkSync(join('..', 'outside', 'secret.txt'), join(linked, '404.html'));
      symlinkSync(join('..', 'outside'), join(linked, 'linkdir'), 'dir');
    } catch (err) {
      t.skip(`cannot create symbolic links here (${err.code})`);
      return;
    }
    const origin = await listen(linked);
    for (const [path, status] of [
      ['/sub/', 403],
      ['/sub/index.html', 403],
      ['/linkdir/secret.txt', 403],
      ['/404.html', 403],
      ['/missing', 404], // plain-text answer instead of the linked 404.html
    ]) {
      const res = await httpGet(origin, path);
      assert.equal(res.status, status, path);
      assert.doesNotMatch(res.body.toString(), /SECRET/, path);
    }
    assert.equal((await httpGet(origin, '/')).status, 200);
  });

  test(
    'closes the file of a download cut short by the client',
    { skip: process.platform !== 'linux' && 'counts open files in /proc/self/fd (Linux only)' },
    async () => {
      const file = realpathSync(join(dir, 'site', 'big.bin'));
      const openCount = () =>
        readdirSync('/proc/self/fd').filter((fd) => {
          try {
            return readlinkSync(`/proc/self/fd/${fd}`) === file;
          } catch {
            return false; // closed meanwhile (e.g. the descriptor of readdirSync itself)
          }
        }).length;
      const origin = await listen(join(dir, 'site'));
      for (let i = 0; i < 20; i++) {
        const res = await httpGet(origin, '/big.bin', { abortAfterFirstChunk: true });
        assert.equal(res.status, 200);
      }
      // The server learns about each abort asynchronously.
      const deadline = Date.now() + 5_000;
      while (openCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal(openCount(), 0, 'file descriptors of aborted downloads are still open');
    },
  );

  test('serves a site below a base path, as GitHub Pages does for a project site', async () => {
    const origin = await listen(join(dir, 'site'), { basePath: 'repo' });
    const expectations = [
      ['/', 302, { location: '/repo/' }],
      ['/repo', 301, { location: '/repo/' }],
      ['/repo/', 200, { body: '<title>root</title>' }],
      ['/repo/sub', 301, { location: '/repo/sub/' }],
      ['/repo//sub', 301, { location: '/repo/sub/' }],
      ['/repo/sub/', 200, { body: '<title>sub</title>' }],
      ['/repo//app.js', 200, { body: 'export const app = 1;\n' }],
      ['/repo/no/such/page', 404, { body: '<title>missing</title>' }],
      ['/app.js', 404, { notBody: 'export const' }], // outside the base path
      ['/repository/', 404, { notBody: '<title>' }],
      ['/repo/../site/app.js', 403, {}],
    ];
    for (const [path, status, { location, body, notBody }] of expectations) {
      const res = await httpGet(origin, path);
      assert.equal(res.status, status, path);
      if (location) assert.equal(res.headers.location, location, path);
      if (body) assert.equal(res.body.toString(), body, path);
      if (notBody) assert.ok(!res.body.toString().includes(notBody), path);
    }
  });
});

// ----------------------------------------------------------- Codespaces

/** JSON with comments (devcontainer.json): line and block comments outside strings are dropped. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      out += m[0];
      i += m[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('unterminated /* comment');
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out);
}

describe('Codespaces start-up (.devcontainer/devcontainer.json)', { skip: process.platform === 'win32' && 'POSIX shell' }, () => {
  const LOG = '/tmp/reader3d.log';
  let config;
  let dir; // one directory per run: stand-in programs, their state and the log

  before(() => {
    config = parseJsonc(readFileSync(DEVCONTAINER, 'utf8'));
    dir = mkdtempSync(join(tmpdir(), 'reader3d-devcontainer-'));
  });

  after(() => {
    // Stop the stand-in servers left running in the background.
    for (const run of readdirSync(dir)) {
      try {
        process.kill(Number(readFileSync(join(dir, run, 'python.pid'), 'utf8')));
      } catch {
        // never started, or already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Run postAttachCommand with /bin/sh, as the dev container tools do, with
   * `python`, `curl` and `sleep` replaced by the given shell scripts and the
   * log written to the temporary directory.
   */
  function runPostAttach(name, stubs) {
    const bin = join(dir, name);
    mkdirSync(bin);
    for (const [program, script] of Object.entries(stubs)) {
      writeFileSync(join(bin, program), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    }
    const log = join(bin, 'reader3d.log');
    assert.ok(config.postAttachCommand.includes(LOG), `postAttachCommand no longer logs to ${LOG}`);
    const command = config.postAttachCommand.replaceAll(LOG, log);
    const result = spawnSync('/bin/sh', ['-c', command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUBS: bin, NODE: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { ...result, log };
  }

  test('installs libGL before the Python packages (OpenCascade needs libGL.so.1 to import)', () => {
    const command = config.postCreateCommand;
    const gl = command.search(/apt-get install [^&;|]*\blibgl1\b/);
    assert.ok(gl >= 0, `postCreateCommand does not install libgl1: ${command}`);
    assert.ok(gl < command.indexOf('pip install'), 'libgl1 must be installed before the Python packages');
    assert.match(command, /\bsudo\b[^&;|]*apt-get install/, 'apt-get needs sudo: the codespace user is not root');
  });

  test('postAttachCommand shows why the server did not start, instead of failing silently', () => {
    const result = runPostAttach('failing', {
      curl: 'exit 7', // nothing answers on port 8000
      sleep: 'exit 0',
      python: [
        'echo "Traceback (most recent call last):" >&2',
        'echo "ImportError: libGL.so.1: cannot open shared object file: No such file or directory" >&2',
        'exit 1',
      ].join('\n'),
    });
    assert.equal(result.error, undefined, `postAttachCommand: ${result.error}`);
    assert.equal(result.status, 1, `exit status ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /did not start/);
    assert.match(result.stderr, /ImportError: libGL\.so\.1/, 'the end of the server log must be shown');
  });

  test('postAttachCommand leaves a working server running in the background', () => {
    const result = runPostAttach('working', {
      // Port 8000 answers from the second check on (the first one is the
      // "already running?" check, before the server is started).
      curl: 'n=$(cat "$STUBS/curl.count" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUBS/curl.count"; [ "$n" -ge 1 ]',
      sleep: 'exit 0',
      python: 'echo $$ > "$STUBS/python.pid"; echo "Uvicorn running"; exec "$NODE" -e "setTimeout(() => {}, 60000)"',
    });
    assert.equal(result.status, 0, `exit status ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /running on port 8000/);
    const pid = Number(readFileSync(join(dir, 'working', 'python.pid'), 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0), 'the server must keep running after postAttachCommand');
    assert.match(readFileSync(result.log, 'utf8'), /Uvicorn running/);
  });
});

// ----------------------------------------------------------------- browser

let browser = null;
let context = null;

/** A fresh page at path (below the site root) that records everything that looks like a failure. */
async function openPage(path = '') {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('crash', () => problems.push('the page crashed'));
  page.on('console', (msg) => {
    const where = msg.location()?.url;
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}${where ? ` (${where})` : ''}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) problems.push(`HTTP ${res.status()} for ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    // ERR_ABORTED: downloads cut short when a test closes its page.
    const reason = req.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) problems.push(`request failed: ${req.url()} (${reason})`);
  });
  const url = server.url + path;
  const response = await page.goto(url);
  return { page, problems, response, url };
}

/** Open a fixture through the file input and wait for its results (or the error banner). */
async function analyzeInPage(page, name, timeout) {
  await page.setInputFiles('#file-input', fixturePath(name));
  const outcome = await page.waitForFunction(
    (fileName) => {
      const $ = (id) => document.getElementById(id);
      const error = $('error');
      if (!error.hidden && error.textContent.trim()) return { error: error.textContent.trim() };
      const done = $('loading').hidden && !$('summary-card').hidden;
      return done && $('file-name').textContent === fileName ? { ok: true } : false;
    },
    name,
    { timeout, polling: 100 },
  );
  const state = await outcome.jsonValue();
  if (state.error) assert.fail(`${name}: the page shows an error: ${state.error}`);
}

/**
 * Parse the total volume as app.js prints it (fmtNum, en-US locale):
 * "113,716.815 mm³" (rounded to 3 decimals) or "6.0000e+12 mm³" (5 significant
 * digits, used from 1e12 on). Returns the value and half the display step.
 */
function parseVolume(text, label) {
  const m = new RegExp(`^(-?[\\d,]*\\.?\\d+(?:e[+-]?\\d+)?)\\s*${label}$`, 'i').exec(text.replace(/ /g, ' ').trim());
  assert.ok(m, `unexpected volume text "${text}"`);
  const raw = m[1].replace(/,/g, '');
  const exponent = /e([+-]?\d+)$/i.exec(raw);
  return { value: Number(raw), halfStep: exponent ? 0.5 * 10 ** (Number(exponent[1]) - 4) : 0.0005 };
}

/** Select a unit in #vol-unit and read #total-volume converted back to mm³. */
async function displayedVolume(page, unit, label, factor) {
  await page.selectOption('#vol-unit', unit);
  await page.waitForFunction((l) => document.getElementById('total-volume').textContent.trim().endsWith(` ${l}`), label);
  const text = await page.textContent('#total-volume');
  const { value, halfStep } = parseVolume(text, label);
  return { text, mm3: value * factor, halfStep: halfStep * factor };
}

/** Compare the displayed total volume and number of bodies with the Python engine's result. */
async function checkResults(t, page, name, reference) {
  const want = reference.summary.volume;
  const shown = await displayedVolume(page, 'mm3', 'mm³', 1);
  t.diagnostic(`${name}: displayed "${shown.text.trim()}", Python engine ${want} mm³`);
  // Tolerance: 1e-6 relative, or the rounding of the display if coarser.
  const abs = Math.max(0.001, shown.halfStep * (1 + 1e-9));
  approx(shown.mm3, want, 1e-6, abs, `${name} volume "${shown.text}"`);
  if (shown.halfStep > 1e-6 * Math.abs(want)) {
    // Very large values are printed in exponent notation in mm³: check
    // them again in m³, where all their significant digits are shown.
    const m3 = await displayedVolume(page, 'm3', 'm³', 1e9);
    approx(m3.mm3, want, 1e-6, Math.max(0.001, m3.halfStep * (1 + 1e-9)), `${name} volume "${m3.text}"`);
  }
  const bodies = Number.parseInt(await page.textContent('#body-count'), 10);
  assert.equal(bodies, reference.summary.bodies, `${name}: number of bodies`);
}

describe('built site in Chromium', () => {
  let expected;

  before(async () => {
    await distServer();
    expected = loadExpected();
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
    }
    const { chromium } = await import('playwright');
    // No GPU on CI machines: let WebGL (three.js viewer) fall back to SwiftShader.
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
  });

  after(async () => {
    await browser?.close();
  });

  test('the page loads without errors', { timeout: MESH_TIMEOUT }, async () => {
    const { page, problems } = await openPage();
    try {
      assert.equal(await page.title(), '3D Reader');
      // app.js has run: the three.js renderer added its canvas to the viewport.
      await page.waitForSelector('#viewport canvas', { state: 'attached', timeout: 30_000 });
      const config = await page.evaluate(() => fetch('config.json').then((r) => r.json()));
      assert.equal(config.server, false, 'the static site must not expect the Python server');
      await page.waitForTimeout(500); // let late module errors surface
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  for (const { name, cad } of FIXTURES) {
    const timeout = cad ? CAD_TIMEOUT : MESH_TIMEOUT;
    test(`${name}: total volume matches the Python engine`, { timeout }, async (t) => {
      const reference = expected[name];
      assert.ok(reference, `${name} is missing from expected.json`);
      const { page, problems } = await openPage();
      try {
        await analyzeInPage(page, name, timeout - 15_000);
        await checkResults(t, page, name, reference);
        assert.deepEqual(problems, [], `${name}: errors in the page`);
      } finally {
        await page.close();
      }
    });
  }

  // GitHub Pages answers a mistyped or stale link with 404.html, whatever its
  // depth: the app must start there and compute (its URLs, the worker's and
  // the OpenCascade download's all resolve against the site root).
  test('a missing URL deep below the site gets a working app (404.html)', { timeout: CAD_TIMEOUT + MESH_TIMEOUT }, async (t) => {
    const { page, problems, response, url } = await openPage('no/such/deep/page');
    try {
      assert.equal(response.status(), 404);
      assert.equal(await page.title(), '3D Reader');
      await page.waitForSelector('#viewport canvas', { state: 'attached', timeout: 30_000 });
      for (const [name, timeout] of [
        ['box.stl', MESH_TIMEOUT - 15_000],
        ['holed_block.step', CAD_TIMEOUT - 15_000],
      ]) {
        assert.ok(expected[name], `${name} is missing from expected.json`);
        await analyzeInPage(page, name, timeout);
        await checkResults(t, page, name, expected[name]);
      }
      // The 404 status of the page itself is expected (and logged by Chromium).
      const own404 = [`HTTP 404 for ${url}`, `console error: Failed to load resource: the server responded with a status of 404 (Not Found) (${url})`];
      assert.deepEqual(problems.filter((p) => !own404.includes(p)), [], 'errors in the page');
    } finally {
      await page.close();
    }
  });
});
