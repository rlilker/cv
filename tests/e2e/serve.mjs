/**
 * Minimal static file server for the browser tests.
 *
 * Serves dist/ exactly as CloudFront will, including extensionless URLs for
 * /about-style routes. The dashboard is a single page, so the goal is fidelity
 * in the two ways that matter here: correct MIME types (a .js served as
 * text/html fails to parse as a module worker, which would be a false
 * positive) and a real path hierarchy.
 *
 * Deliberately no dependencies, so the test suite needs nothing installed
 * beyond Playwright itself.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'dist');
const PORT = Number(process.env.PORT ?? 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Resolve a URL path to a file, trying the exact path then <path>.html. */
async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  // Refuse to serve anything outside dist/, whatever the request says.
  const target = resolve(join(ROOT, clean));
  if (!target.startsWith(ROOT)) return null;

  for (const candidate of [target, `${target}.html`, join(target, 'index.html')]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const file = await resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // The dashboard must never be served stale during a test run.
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`e2e server on http://127.0.0.1:${PORT} serving ${ROOT}`);
});