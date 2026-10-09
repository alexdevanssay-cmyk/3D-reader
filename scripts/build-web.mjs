#!/usr/bin/env node
// Static build of the web app (GitHub Pages) and vendoring of its libraries.
//
//   node scripts/build-web.mjs                 vendor step, then build dist/
//   node scripts/build-web.mjs --vendor-only   vendor step only (npm run vendor)
//
// Options:
//   --force            re-compress the OpenCascade wasm even when it is up to date
//   --base-path PATH   URL path the site is published under (e.g. /3D-reader), used
//                      by dist/404.html; defaults to the BASE_PATH environment
//                      variable, else "/" (the site root, as `npm run serve` serves it)
//
// The vendor step copies into web/vendor/ what the page loads at run time:
//   three/   three.js build files, LICENSE and the addons used by the UI and the
//            engine, with every module they import (found by scanning the sources)
//   opencascade/  the emscripten glue of opencascade.js, its LICENSE and the 50 MB
//            wasm binary compressed with gzip -9 (about 14 MB). The page gunzips
//            it itself, so no web server configuration is needed.
// The build then copies web/ to dist/ and adds the files GitHub Pages wants.
//
// Only Node APIs are used (no shell commands), so it runs the same on Linux,
// macOS and Windows.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip, constants as zlibConstants } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DIST = join(ROOT, 'dist');
const NODE_MODULES = join(ROOT, 'node_modules');

const THREE_PKG = join(NODE_MODULES, 'three');
const THREE_BUILD = join(THREE_PKG, 'build');
const THREE_ADDONS = join(THREE_PKG, 'examples', 'jsm');
const THREE_OUT = join(WEB, 'vendor', 'three');

const OCCT_PKG = join(NODE_MODULES, 'opencascade.js');
const OCCT_OUT = join(WEB, 'vendor', 'opencascade');

/**
 * Addons needed at run time, relative to three/examples/jsm. The modules they
 * import are added automatically, and so is any other `three/addons/...`
 * module imported by the files of web/. fflate is listed explicitly because
 * engine/occt.js loads it by URL (gunzip fallback without DecompressionStream).
 */
const REQUIRED_ADDONS = [
  'controls/OrbitControls.js',
  'loaders/GLTFLoader.js',
  'math/ConvexHull.js',
  'libs/fflate.module.js',
];

/** Files of dist/ the published site cannot work without. */
const REQUIRED_DIST_FILES = [
  'index.html',
  'app.js',
  'config.json',
  'engine/client.js',
  'engine/worker.js',
  'engine/thickworker.js',
  'engine/thickpool.js',
  'engine/partworker.js',
  'engine/cache.js',
  'coi-sw.js',
  'vendor/three/three.module.js',
  'vendor/opencascade/opencascade.full.js',
  'vendor/opencascade/opencascade.full.wasm.gz',
];

// ------------------------------------------------------------------ helpers

class BuildError extends Error {}

const toPosix = (p) => p.split(sep).join('/');
const rel = (p) => toPosix(relative(ROOT, p));

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

function isInside(file, dir) {
  const r = relative(dir, file);
  return r !== '' && r.split(sep)[0] !== '..' && !isAbsolute(r); // absolute: another drive (Windows)
}

/** Copy a file unless the destination already has the same content. Returns true if written. */
function copyIfChanged(src, dst) {
  if (existsSync(dst)) {
    const a = statSync(src);
    const b = statSync(dst);
    if (a.size === b.size && readFileSync(src).equals(readFileSync(dst))) return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

/** All files below dir (recursively), as absolute paths, sorted for stable output. */
function listFiles(dir, filter = () => true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (!filter(full, entry)) continue;
    // statSync follows symbolic links, as a web server does.
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listFiles(full, filter));
    else if (stat.isFile()) out.push(full);
  }
  return out.sort();
}

// ------------------------------------------------------------- import scan

/**
 * Module specifiers imported by an ES module source, found with regular
 * expressions (static `import … from`, `export … from`, side-effect `import '…'`
 * and dynamic `import('…')` with a string literal). Imports built from
 * variables are invisible here, as they are to any static analysis. A false
 * match (e.g. inside a comment) shows up as an unresolvable module and stops
 * the build, so it cannot go unnoticed.
 */
function moduleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  const found = new Set();
  for (const re of patterns) for (const m of source.matchAll(re)) found.add(m[2]);
  return [...found];
}

/**
 * Map a specifier imported by a three.js module (or by the app) to the source
 * file in node_modules/three, following the page's import map:
 * "three" -> build/three.module.js, "three/addons/" -> examples/jsm/.
 */
function resolveThreeSpecifier(spec, importer) {
  if (spec === 'three') return join(THREE_BUILD, 'three.module.js');
  if (spec.startsWith('three/addons/')) return join(THREE_ADDONS, ...spec.slice('three/addons/'.length).split('/'));
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(dirname(importer), ...spec.split('/'));
  throw new BuildError(
    `${rel(importer)} imports '${spec}', which the import map of index.html does not provide ` +
      `(only "three" and "three/addons/..." are mapped)`,
  );
}

/** Where a node_modules/three file is published under web/vendor/three/. */
function threeDestination(src) {
  if (isInside(src, THREE_BUILD)) return join(THREE_OUT, relative(THREE_BUILD, src));
  if (isInside(src, THREE_ADDONS)) return join(THREE_OUT, 'addons', relative(THREE_ADDONS, src));
  throw new BuildError(`${rel(src)} is outside three/build and three/examples/jsm`);
}

/** `three/addons/...` modules imported by the app and engine sources of web/. */
function addonsImportedByApp() {
  const sources = listFiles(WEB, (full) => full !== join(WEB, 'vendor')).filter((f) => /\.m?js$/.test(f));
  const addons = new Set();
  for (const file of sources) {
    for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('three/addons/')) addons.add(spec.slice('three/addons/'.length));
    }
  }
  return [...addons];
}

/** The three.js files to vendor: entry points plus the transitive closure of their imports. */
function threeClosure() {
  const entries = [
    join(THREE_BUILD, 'three.module.js'),
    ...new Set([...REQUIRED_ADDONS, ...addonsImportedByApp()].map((a) => join(THREE_ADDONS, ...a.split('/')))),
  ];
  const seen = new Set();
  const queue = entries.map((file) => ({ file, importer: null }));
  while (queue.length) {
    const { file, importer } = queue.shift();
    if (seen.has(file)) continue;
    if (!existsSync(file)) {
      throw new BuildError(`Missing three.js module ${rel(file)}${importer ? ` (imported by ${rel(importer)})` : ''}`);
    }
    seen.add(file);
    for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      queue.push({ file: resolveThreeSpecifier(spec, file), importer: file });
    }
  }
  return [...seen].sort();
}

// ------------------------------------------------------------------ vendor

function vendorThree() {
  if (!existsSync(THREE_BUILD)) throw new BuildError('node_modules/three is missing: run `npm ci` first');
  const files = threeClosure().map((src) => [src, threeDestination(src)]);
  files.push([join(THREE_PKG, 'LICENSE'), join(THREE_OUT, 'LICENSE')]);
  const written = files.filter(([src, dst]) => copyIfChanged(src, dst)).map(([, dst]) => dst);
  console.log(`three.js: ${files.length} files in ${rel(THREE_OUT)}/, ${written.length} updated`);
  for (const dst of written) console.log(`  ${toPosix(relative(THREE_OUT, dst))}`);
}

/**
 * True when dst is a complete gzip of src made after src was last changed.
 * The gzip trailer ends with the uncompressed size (mod 2^32): comparing it
 * catches an interrupted run or a new opencascade.js release, whose files keep
 * the fixed 1985 timestamp npm gives to everything it installs.
 */
function gzipUpToDate(src, dst) {
  if (!existsSync(dst)) return false;
  const input = statSync(src);
  const output = statSync(dst);
  if (output.mtimeMs < input.mtimeMs || output.size < 18) return false;
  const trailer = Buffer.alloc(4);
  const fd = openSync(dst, 'r');
  try {
    readSync(fd, trailer, 0, 4, output.size - 4);
  } finally {
    closeSync(fd);
  }
  return trailer.readUInt32LE(0) === input.size % 2 ** 32;
}

/** gzip -9 src into dst, streamed; written to a temporary file first so a crash leaves no partial output. */
async function gzipFile(src, dst) {
  const tmp = `${dst}.tmp`;
  try {
    await pipeline(createReadStream(src), createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }), createWriteStream(tmp));
    renameSync(tmp, dst);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

async function vendorOpenCascade({ force }) {
  const dist = join(OCCT_PKG, 'dist');
  const wasm = join(dist, 'opencascade.full.wasm');
  if (!existsSync(wasm)) throw new BuildError('node_modules/opencascade.js is missing: run `npm ci` first');
  mkdirSync(OCCT_OUT, { recursive: true });
  copyIfChanged(join(dist, 'opencascade.full.js'), join(OCCT_OUT, 'opencascade.full.js'));
  copyIfChanged(join(OCCT_PKG, 'LICENSE'), join(OCCT_OUT, 'LICENSE'));

  const gz = join(OCCT_OUT, 'opencascade.full.wasm.gz');
  const inSize = statSync(wasm).size;
  if (!force && gzipUpToDate(wasm, gz)) {
    console.log(`opencascade.js: ${rel(gz)} is up to date (${formatSize(statSync(gz).size)})`);
    return;
  }
  console.log(`opencascade.js: compressing ${formatSize(inSize)} of WebAssembly with gzip -9…`);
  const start = Date.now();
  await gzipFile(wasm, gz);
  const outSize = statSync(gz).size;
  console.log(
    `opencascade.js: wrote ${rel(gz)} (${formatSize(outSize)}, ${((outSize / inSize) * 100).toFixed(1)} %, ` +
      `${((Date.now() - start) / 1000).toFixed(1)} s)`,
  );
}

async function vendor(options) {
  vendorThree();
  await vendorOpenCascade(options);
}

// ------------------------------------------------------------------- build

/**
 * The commit being built: the checked-out HEAD, else GITHUB_SHA. HEAD comes
 * first because the Pages workflow checks out the commit CI tested, while its
 * GITHUB_SHA is the newest commit of main.
 */
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return process.env.GITHUB_SHA || null; // not a git checkout, or git is not installed
  }
}

const escapeAttribute = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** "/", or the path with one leading and one trailing slash: "3D-reader" -> "/3D-reader/". */
function normalizeBasePath(basePath) {
  const segments = String(basePath ?? '').split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/**
 * GitHub Pages answers unknown URLs with 404.html. It is a copy of the app so
 * that a mistyped URL still shows something useful. Its relative URLs resolve
 * against the requested path, which can be deeper than the site root, so a
 * <base> element pins them to the root the site is published at (basePath,
 * normalised). The page therefore only works below that path: version.json
 * records it, and scripts/serve.mjs serves the build there.
 */
function notFoundPage(indexHtml, basePath) {
  const base = `<base href="${escapeAttribute(basePath)}">`;
  // <base> must precede every element with a URL (stylesheet, import map).
  const anchor = /<meta\s+charset=[^>]*>/i.exec(indexHtml) || /<head[^>]*>/i.exec(indexHtml);
  if (!anchor) throw new BuildError('web/index.html has no <head>: cannot add <base> to 404.html');
  const at = anchor.index + anchor[0].length;
  return `${indexHtml.slice(0, at)}\n  ${base}${indexHtml.slice(at)}`;
}

/** Copy web/ to dist/, leaving out temporary files of an interrupted vendor step. */
function copySite() {
  rmSync(DIST, { recursive: true, force: true });
  const files = listFiles(WEB, (full) => !full.endsWith('.tmp'));
  for (const src of files) {
    const dst = join(DIST, relative(WEB, src));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  return files.length;
}

/**
 * Add ?v=<tag> to the URLs of the site's own modules and stylesheet. GitHub
 * Pages lets browsers cache files for 10 minutes: right after a deployment a
 * visitor could otherwise run the new app.js with the old worker.js. Every
 * reference to a module gets the same tag, so each module is still loaded once.
 * (vendor/ files change only with their package version and keep plain URLs.)
 */
function versionUrls(tag) {
  const relativeJs = /(['"])(\.{1,2}\/(?!vendor\/)[^'"?\s]+\.js)\1/g;
  for (const file of listFiles(DIST, (full) => !isInside(full, join(DIST, 'vendor')))) {
    if (/\.m?js$/.test(file)) {
      const source = readFileSync(file, 'utf8');
      writeFileSync(file, source.replace(relativeJs, `$1$2?v=${tag}$1`));
    } else if (/\.html$/.test(file)) {
      const html = readFileSync(file, 'utf8')
        .replace(/(<script type="module" src=")([^"?]+\.js)(")/g, `$1$2?v=${tag}$3`)
        .replace(/(<link rel="stylesheet" href=")([^"?]+\.css)(")/g, `$1$2?v=${tag}$3`);
      writeFileSync(file, html);
    }
  }
}

/**
 * Check that every module the app imports with a static specifier exists in
 * dist/ (relative imports, and "three" / "three/addons/..." through the import
 * map), so a missing file fails the build instead of the published page.
 */
function checkImports() {
  const problems = [];
  const sources = listFiles(DIST, (full) => full !== join(DIST, 'vendor')).filter((f) => /\.m?js$/.test(f));
  for (const file of sources) {
    for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      let target;
      if (spec === 'three') target = join(DIST, 'vendor', 'three', 'three.module.js');
      else if (spec.startsWith('three/addons/')) target = join(DIST, 'vendor', 'three', 'addons', ...spec.slice(13).split('/'));
      else if (spec.startsWith('./') || spec.startsWith('../')) target = resolve(dirname(file), ...spec.split('?')[0].split('/'));
      else continue; // a URL, or a Node-only module loaded through a variable
      if (!existsSync(target)) problems.push(`${toPosix(relative(DIST, file))} imports '${spec}', missing from dist/`);
    }
  }
  if (problems.length) throw new BuildError(`Unresolved imports:\n  ${problems.join('\n  ')}`);
}

function sizeReport() {
  const files = listFiles(DIST).map((f) => ({ name: toPosix(relative(DIST, f)), size: statSync(f).size }));
  const total = files.reduce((sum, f) => sum + f.size, 0);
  files.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const shown = files.filter((f) => f.size >= 10 * 1024);
  const rest = files.slice(shown.length);
  console.log(`\n${rel(DIST)}/: ${files.length} files, ${formatSize(total)}`);
  for (const f of shown) console.log(`  ${formatSize(f.size).padStart(9)}  ${f.name}`);
  if (rest.length) {
    console.log(`  ${formatSize(rest.reduce((s, f) => s + f.size, 0)).padStart(9)}  ${rest.length} smaller files`);
  }
  // Published GitHub Pages sites may be no larger than 1 GB.
  if (total > 1024 ** 3) console.warn('warning: the site exceeds the 1 GB limit of GitHub Pages');
}

async function build(options) {
  await vendor(options);

  const count = copySite();
  writeFileSync(join(DIST, '.nojekyll'), ''); // serve files as they are, no Jekyll processing
  writeFileSync(join(DIST, '404.html'), notFoundPage(readFileSync(join(DIST, 'index.html'), 'utf8'), options.basePath));
  const version = { commit: gitCommit(), built_at: new Date().toISOString(), base_path: options.basePath };
  writeFileSync(join(DIST, 'version.json'), `${JSON.stringify(version, null, 2)}\n`);
  versionUrls((version.commit ?? version.built_at.replace(/\D/g, '')).slice(0, 12));
  console.log(
    `\nCopied ${count} files from ${rel(WEB)}/ to ${rel(DIST)}/ ` +
      `(commit ${version.commit ?? 'unknown'}, base path ${options.basePath})`,
  );

  const missing = REQUIRED_DIST_FILES.filter((f) => !existsSync(join(DIST, ...f.split('/'))));
  if (missing.length) throw new BuildError(`Missing from dist/: ${missing.join(', ')}`);
  checkImports();
  sizeReport();
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  // BASE_PATH is set by the Pages workflow; it is "" for a site at the domain root.
  const options = { vendorOnly: false, force: false, basePath: process.env.BASE_PATH ?? '/' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--vendor-only') options.vendorOnly = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--base-path') options.basePath = argv[++i] ?? '';
    else if (arg.startsWith('--base-path=')) options.basePath = arg.slice('--base-path='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/build-web.mjs [--vendor-only] [--force] [--base-path PATH]');
      process.exit(0);
    } else throw new BuildError(`Unknown option ${arg}`);
  }
  options.basePath = normalizeBasePath(options.basePath);
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.vendorOnly) await vendor(options);
  else await build(options);
} catch (err) {
  console.error(`\nbuild failed: ${err instanceof BuildError ? err.message : err.stack || err}`);
  process.exitCode = 1;
}
