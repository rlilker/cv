/**
 * Prints a text outline of the built page, so the rendered structure can be
 * reviewed (and eyeballed in CI logs) without opening a browser.
 *
 * Run with:  node scripts/outline-page.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'dist/index.html'), 'utf8');

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const text = decode(html);

// Section headings, in document order.
const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
  level: Number(m[1]),
  text: decode(m[2]),
}));

// Anchor targets, which is what the nav links to.
const ids = [...html.matchAll(/<(?:section|article|div)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);

console.log('\n=== HEADINGS ===');
for (const h of headings) {
  console.log(`${'  '.repeat(h.level - 1)}${h.level === 1 ? '#' : h.level === 2 ? '##' : '###'} ${h.text}`);
}

console.log('\n=== ANCHOR TARGETS ===');
console.log(ids.map((id) => `  #${id}`).join('\n'));

console.log('\n=== KEY FACTS ===');
const facts = [
  ['title', (html.match(/<title>(.*?)<\/title>/) || [])[1]],
  ['description', ((html.match(/name="description" content="(.*?)"/) || [])[1] || '').slice(0, 100) + '…'],
  ['canonical', (html.match(/rel="canonical" href="(.*?)"/) || [])[1]],
  ['og:url', (html.match(/property="og:url" content="(.*?)"/) || [])[1]],
  ['html lang', (html.match(/<html lang="(.*?)"/) || [])[1]],
  ['total text', `${text.length.toLocaleString()} characters`],
  ['word count', `${text.split(/\s+/).filter(Boolean).length.toLocaleString()} words`],
];
for (const [k, v] of facts) console.log(`  ${k.padEnd(14)} ${v}`);

console.log('\n=== FIRST 400 CHARS OF VISIBLE TEXT ===');
console.log(text.slice(0, 400) + '…\n');
