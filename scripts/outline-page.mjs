/**
 * Prints a text outline of the built pages, so the rendered structure can be
 * reviewed (and eyeballed in CI logs) without opening a browser.
 *
 * Run with:  node scripts/outline-page.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Strip <style>, <script> and JSON-LD so only visible prose is measured.
const visibleText = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const pages = [
  // Paths match build.format: 'file', so pages are emitted as <route>.html.
  ['Home (CV)', 'dist/index.html'],
  ['Family Planner', 'dist/family-planner.html'],
  ['Privacy policy', 'dist/family-planner/privacy.html'],
  ['Terms & conditions', 'dist/family-planner/terms.html'],
];

const only = process.argv[2];

for (const [label, rel] of pages) {
  if (only && !label.toLowerCase().includes(only.toLowerCase())) continue;

  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    console.log(`\n### ${label} — MISSING (${rel})`);
    continue;
  }

  const html = readFileSync(abs, 'utf8');
  const headings = [...html.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: visibleText(m[2]),
  }));

  console.log(`\n=== ${label}  (${rel}) ===`);
  console.log(`  ${(html.length / 1024).toFixed(1)} KB html, ${visibleText(html).split(/\s+/).length} words visible\n`);

  for (const h of headings) {
    console.log(`${'    '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`);
  }

  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  const internal = [...new Set(links.filter((l) => l.startsWith('/')))];
  console.log(`\n  internal links: ${internal.join('  ')}`);
}
console.log('');
