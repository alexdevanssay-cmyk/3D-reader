#!/usr/bin/env node
// Zero-dependency static file server, to preview the built site locally.
//
//   node scripts/serve.mjs [DIR] [--port 8080] [--host 127.0.0.1] [--base-path /]
//                          [--quiet] [--no-isolation]
//
// DIR defaults to dist/ (run `npm run build` first); `node scripts/serve.mjs web`
// serves the sources directly. --port 0 picks a free port. The server prints
// "Serving DIR at URL" once it listens.
//
// It behaves like GitHub Pages where it matters for the app: index.html for
// directories, 404.html for missing files, and *.gz files sent as they are
// (application/gzip, no Content-Encoding) because the page decompresses the
// OpenCascade binary itself. A project site is published below
// /<repository>/: --base-path serves DIR there too. It defaults to the
// base_path recorded in DIR/version.json by the build, because the 404.html of
// that build only works below that path.

import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.obj': 'model/obj',
  '': 'text/plain; charset=utf-8', // LICENSE files
};

export const contentType = (file) => MIME_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';

/** "/", or the path with one leading and one trailing slash: "3D-reader" -> "/3D-reader/". */
export function normalizeBasePath(basePath) {
  const segments = String(basePath ?? '').split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** True when path (not resolved further) is root itself or below it. */
function within(root, path) {
  const r = relative(root, path);
  return r.split(sep)[0] !== '..' && !isAbsolute(r); // absolute: another drive (Windows)
}

/**
 * True when the existing file path stays inside root once symbolic links are
 * followed. Every file is checked just before it is sent, including the
 * index.html picked for a directory and the 404 page, which the request path
 * does not name.
 */
export function isServable(root, path) {
  try {
    return within(root, realpathSync(path));
  } catch {
    return false; // vanished, or a dangling link
  }
}

/**
 * Map a request path to a file below root, or null when it must not be served.
 *
 * The path is percent-decoded, then rejected if it contains a NUL byte or a
 * ".." segment (with either kind of slash, for Windows). The resolved file
 * must also stay inside root once symbolic links are followed.
 */
export function resolveRequestPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0') || decoded.split(/[/\\]/).includes('..')) return null;
  const file = join(root, decoded);
  if (!within(root, file)) return null;
  if (existsSync(file) && !isServable(root, file)) return null;
  return file;
}

/**
 * The path of a request target, still percent-encoded, or null if it has none.
 *
 * The usual form "/path?query" is cut at "?" rather than parsed with
 * new URL(target, base): the URL parser reads "//app.js" as a
 * protocol-relative URL whose host is "app.js", and would serve "/" instead.
 * The absolute form "http://host/path" (sent to proxies) is parsed.
 */
function requestPath(target) {
  if (target.startsWith('/')) return target.split(/[?#]/)[0];
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.pathname : null;
  } catch {
    return null;
  }
}

/** File to send for an existing path: the file itself, or index.html for a directory. */
function fileFor(path) {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return { path, stat };
    if (stat.isDirectory()) {
      const index = join(path, 'index.html');
      const indexStat = statSync(index);
      if (indexStat.isFile()) return { path: index, stat: indexStat, directory: true };
    }
  } catch {
    // missing or unreadable: handled as 404
  }
  return null;
}

function sendFile(req, res, status, { path, stat }) {
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': contentType(path),
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    // Always revalidate (cheap 304s) so a rebuild is picked up on reload.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // pipeline() closes the file when the client goes away mid-download (an
  // aborted 13 MB wasm download, a reload); stream.pipe() would leave it open,
  // leaking one file descriptor per aborted request. A read error destroys
  // the response, so the client sees a truncated transfer, not a short file.
  pipeline(createReadStream(path), res, () => {});
}

function sendText(req, res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(req.method === 'HEAD' ? undefined : text);
}

function redirect(res, status, location) {
  res.writeHead(status, { Location: location, 'Content-Length': 0 });
  res.end();
}

/**
 * Create (but do not start) a server for the files below root, published at
 * basePath ("/" or e.g. "/3D-reader/", as GitHub Pages does for a project site).
 * log(req, status) is called once per request; pass null for silence.
 */
/**
 * isolate -- send the cross-origin isolation headers (default); false to
 *            serve like GitHub Pages (the page's service worker adds them).
 */
export function createStaticServer(root, { log = null, basePath = '/', isolate = true } = {}) {

  root = realpathSync(resolve(root));
  basePath = normalizeBasePath(basePath);
  const notFound = join(root, '404.html');

  return createServer((req, res) => {
    res.on('finish', () => log?.(req, res.statusCode));
    // Cross-origin isolation (SharedArrayBuffer for the wall thickness workers).
    // GitHub Pages cannot send these headers: there, web/coi-sw.js adds them.
    if (isolate) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(req, res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    const path = requestPath(req.url);
    if (path === null) {
      sendText(req, res, 400, 'Bad request\n');
      return;
    }
    if (!path.startsWith(basePath)) {
      // Outside the site (only possible with a base path): GitHub Pages would
      // answer from another site. Lead the way from "/" and "/3D-reader".
      if (path === basePath.slice(0, -1)) redirect(res, 301, basePath);
      else if (path === '/') redirect(res, 302, basePath);
      else sendText(req, res, 404, `Not found: the site is served below ${basePath}\n`);
      return;
    }
    const pathname = path.slice(basePath.length - 1); // keeps its leading "/"
    const target = resolveRequestPath(root, pathname);
    const found = target === null ? null : fileFor(target);
    if (target === null || (found && !isServable(root, found.path))) {
      sendText(req, res, 403, 'Forbidden\n');
      return;
    }
    if (found?.directory && !pathname.endsWith('/')) {
      // Relative URLs in the page need the trailing slash. Leading slashes are
      // collapsed so that "//host" cannot become a redirect to another site.
      redirect(res, 301, `${basePath}${pathname.replace(/^\/+/, '')}/`);
      return;
    }
    if (found) {
      sendFile(req, res, 200, found);
      return;
    }
    const page = fileFor(notFound);
    if (page && isServable(root, page.path)) sendFile(req, res, 404, page);
    else sendText(req, res, 404, 'Not found\n');
  });
}

/** The base path the build recorded in dir/version.json, or "/" (no build, older build, `web/`). */
export function builtBasePath(dir) {
  try {
    return normalizeBasePath(JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).base_path);
  } catch {
    return '/';
  }
}

function parseArgs(argv) {
  const options = { dir: join(ROOT, 'dist'), port: 8080, host: '127.0.0.1', basePath: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = () => inline ?? argv[++i];
    if (name === '--port' || name === '-p') options.port = Number(value());
    else if (name === '--host') options.host = value();
    else if (name === '--base-path') options.basePath = value() ?? '';
    else if (name === '--quiet' || name === '-q') options.quiet = true;
    else if (name === '--no-isolation') options.isolate = false;
    else if (name === '--help' || name === '-h') {
      console.log('usage: node scripts/serve.mjs [DIR] [--port 8080] [--host 127.0.0.1] [--base-path /] [--quiet] [--no-isolation]');
      process.exit(0);
    } else if (!name.startsWith('-')) options.dir = resolve(name);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { dir, port, host, quiet } = options;
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`${dir} has no index.html${dir === join(ROOT, 'dist') ? ': run `npm run build` first' : ''}`);
    process.exit(1);
  }
  const basePath = normalizeBasePath(options.basePath ?? builtBasePath(dir));

  const log = quiet ? null : (req, status) => console.log(`${status} ${req.method} ${req.url}`);
  const server = createStaticServer(dir, { log, basePath, isolate: options.isolate !== false });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use: choose another one with --port` : err.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const { port: actual } = server.address();
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    const where = relative(process.cwd(), dir);
    const dirShown = where === '' ? '.' : where.startsWith('..') || isAbsolute(where) ? dir : where;
    console.log(`Serving ${dirShown} at http://${shown}:${actual}${basePath}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      server.closeAllConnections?.();
      process.exit(0);
    });
  }
}

/** True when this file is the script node was started with (not imported). */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const started = realpathSync(resolve(process.argv[1]));
    // Windows paths are case-insensitive (the drive letter case varies).
    return process.platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
