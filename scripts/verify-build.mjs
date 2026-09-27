/**
 * Post-build sanity check.
 *
 * Astro will happily "successfully" build a page that is missing half its
 * content — a malformed data file just renders an empty section. So this
 * asserts the rendered HTML actually contains the CV data, the Family Planner
 * page, and both legal documents.
 *
 * Run with:  node scripts/verify-build.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(root, 'src/data/cv.json'), 'utf8'));
const app = JSON.parse(readFileSync(resolve(root, 'src/data/family-planner.json'), 'utf8'));

let failures = 0;

const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
};

const section = (name) => console.log(`\n--- ${name} ---`);

/** Astro HTML-escapes text, so compare against an escaped copy of the source. */
const escapeHtml = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Strip style/script/svg so assertions test visible content only. */
const visible = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Astro escapes `&` as `&amp;` in some places and `&#x26;` in others, so
    // decode both named and numeric references before comparing text.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const read = (rel) => {
  const abs = resolve(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};

const PAGES = {
  home: 'dist/index.html',
  app: 'dist/family-planner/index.html',
  privacy: 'dist/family-planner/privacy/index.html',
  terms: 'dist/family-planner/terms/index.html',
};

const html = {};
section('build output');
for (const [key, rel] of Object.entries(PAGES)) {
  html[key] = read(rel);
  check(`${rel} exists`, html[key] !== null);
}
if (Object.values(html).some((h) => h === null)) {
  console.log('\nBuild output missing. Run `npm run build` first.');
  process.exit(1);
}

const all = Object.values(html);

// ═══════════════════════════════════════════════════════════════════════════
//  CV page
// ═══════════════════════════════════════════════════════════════════════════

section(`CV page (${(html.home.length / 1024).toFixed(1)} KB)`);

section('Profile');
check('name', html.home.includes(data.profile.name));
check('role', html.home.includes(data.profile.role));
check('email link', html.home.includes(`mailto:${data.profile.email}`));
check('tel link', html.home.includes('tel:07734567119'));
check('LinkedIn', html.home.includes(data.profile.linkedin));
check('GitHub', html.home.includes(data.profile.github));
check('location', html.home.includes(data.profile.location));
check('intro paragraphs', data.profile.intro.every((p) => html.home.includes(escapeHtml(p.slice(0, 60)))));

section('Employment history');
for (const role of data.roles) {
  check(
    `${role.company} (${role.start}–${role.end})`,
    html.home.includes(escapeHtml(role.company)) &&
      html.home.includes(escapeHtml(role.title)) &&
      html.home.includes(role.start),
  );
}

section('Content integrity');
const roles = (html.home.match(/<h3 class="role-title/g) || []).length;
check('every role rendered', roles === data.roles.length, `${roles}/${data.roles.length}`);

const bullets = (html.home.match(/class="role-points"/g) || []).length;
check('bullet lists rendered', bullets === data.roles.filter((r) => r.highlights.length).length, `${bullets}`);

const cards = (html.home.match(/class="skill-card/g) || []).length;
check('every skill group rendered', cards === data.skillGroups.length, `${cards}/${data.skillGroups.length}`);

const pills = (html.home.match(/class="interest-pill"/g) || []).length;
check('every interest rendered', pills === data.interests.length, `${pills}/${data.interests.length}`);

const stats = (html.home.match(/class="stat"/g) || []).length;
check('stat tiles rendered', stats === data.highlights.length, `${stats}/${data.highlights.length}`);

// ═══════════════════════════════════════════════════════════════════════════
//  Family Planner page
// ═══════════════════════════════════════════════════════════════════════════

section(`Family Planner page (${(html.app.length / 1024).toFixed(1)} KB)`);
check('name', html.app.includes(app.name));
check('tagline', html.app.includes(escapeHtml(app.tagline)));
check('summary', html.app.includes(escapeHtml(app.summary.slice(0, 70))));
check('status badge', html.app.includes(app.status));
check('repository link', html.app.includes(app.repoUrl));
check('every pipeline stage', app.pipeline.every((s) => html.app.includes(escapeHtml(s.title))));
check(
  'every constraint',
  app.engineering.constraints.every((c) => html.app.includes(escapeHtml(c.title.slice(0, 30)))),
);
check('every solution bullet', app.engineering.solution.every((s) => html.app.includes(escapeHtml(s.slice(0, 60)))));
check('every stack item', app.stack.every((s) => html.app.includes(escapeHtml(s.label))));
check('hero stat tiles', (html.app.match(/class="stat"/g) || []).length === app.heroStats.length);

// ═══════════════════════════════════════════════════════════════════════════
//  Legal pages
// ═══════════════════════════════════════════════════════════════════════════

for (const [key, source, title] of [
  ['privacy', 'src/data/privacypolicy.md', 'Privacy Policy'],
  ['terms', 'src/data/tandcs.md', 'Terms & Conditions'],
]) {
  section(`${title} (${(html[key].length / 1024).toFixed(1)} KB)`);

  const md = readFileSync(resolve(root, source), 'utf8');
  const page = visible(html[key]);

  check('page title', html[key].includes(escapeHtml(title)));
  check('exactly one h1', (html[key].match(/<h1/g) || []).length === 1);

  // Every substantive line of the markdown must survive into the rendered
  // page — this is the check that catches a markdown import silently failing.
  // Strip list markers, emphasis and inline HTML so the comparison is against
  // plain text on both sides.
  const lines = md
    .split(/\r?\n/)
    .map((l) =>
      l
        // markdown link [text](url) -> text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^[*\-\d.\s]+/, '')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l.length > 45);
  const missing = lines.filter((l) => !page.includes(l.slice(0, 60)));
  check(
    `all ${lines.length} content paragraphs rendered`,
    missing.length === 0,
    missing.length ? `first missing: "${missing[0].slice(0, 60)}…"` : '',
  );

  check('markdown became real HTML', (html[key].match(/<p[ >]/g) || []).length > 20);
  check('document title not duplicated in the body', !page.startsWith(title + ' This'));
  check('links to the app page', html[key].includes('/family-planner/'));
  check('links back to the CV', html[key].includes('href="/"'));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-page navigation
// ═══════════════════════════════════════════════════════════════════════════

section('Cross-page navigation');
check('home links to the app', html.home.includes('/family-planner/'));
check('app links to the CV', html.app.includes('href="/"'));
check('legal pages link to each other', html.privacy.includes('/family-planner/terms/') && html.terms.includes('/family-planner/privacy/'));
check('nav present on every page', all.every((h) => h.includes('class="nav-pill nav-links"')));
check('app reachable from the nav on every page', all.every((h) => h.includes('href="/family-planner/"')));
check('CV sections reachable from the nav on every page', all.every((h) => h.includes('href="/#experience"')));

// ═══════════════════════════════════════════════════════════════════════════
//  Per-page metadata
// ═══════════════════════════════════════════════════════════════════════════

for (const [key, name] of [
  ['home', 'CV'],
  ['app', 'app'],
  ['privacy', 'privacy'],
  ['terms', 'terms'],
]) {
  const h = html[key];
  const metaOk =
    /<title>[^<]+<\/title>/.test(h) &&
    h.includes('name="description"') &&
    h.includes('rel="canonical"') &&
    h.includes('property="og:title"') &&
    h.includes('name="twitter:card"') &&
    h.includes('<html lang="en-GB"') &&
    h.includes('name="viewport"');
  check(`${name}: title, description, canonical, OG, lang, viewport`, metaOk);
}

section('CV page extras');
check('JSON-LD Person', html.home.includes('"@type": "Person"') || html.home.includes('"@type":"Person"'));
check('favicon + manifest', html.home.includes('favicon.svg') && html.home.includes('site.webmanifest'));

// ═══════════════════════════════════════════════════════════════════════════
//  Assets, accessibility, encoding
// ═══════════════════════════════════════════════════════════════════════════

section('Assets & accessibility');
check('stylesheet linked on every page', all.every((h) => h.includes('stylesheet')));
check('self-hosted font (no Google Fonts CDN)', !all.some((h) => h.includes('fonts.googleapis.com')));
check('robots.txt present', existsSync(resolve(root, 'dist/robots.txt')));
check('skip link on every page', all.every((h) => h.includes('class="skip-link"')));
check('exactly one h1 per page', all.every((h) => (h.match(/<h1/g) || []).length === 1));
check('nav has aria-label', all.every((h) => h.includes('aria-label="Sections"')));
check('decorative svgs are aria-hidden', all.every((h) => h.includes('aria-hidden="true"')));

section('Source hygiene');
// A stray tag inside a <style> block is silently shipped as broken CSS — Astro
// only emits a minifier warning and the build still passes. Catch it at source.
{
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : p.endsWith('.astro') ? [p] : [];
    });

  const offenders = [];
  for (const file of walk(resolve(root, 'src'))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inStyle = false;
    for (const [i, line] of lines.entries()) {
      if (/^\s*<style[^>]*>\s*$/.test(line)) inStyle = true;
      else if (/^\s*<\/style>\s*$/.test(line)) inStyle = false;
      // Any Astro/HTML tag inside a style block means a block was misplaced.
      else if (inStyle && /<\/?[A-Za-z]/.test(line) && !/^\s*(\/\*|\*|<!--)/.test(line)) {
        offenders.push(`${relative(root, file)}:${i + 1}`);
      }
    }
  }
  check('no markup inside <style> blocks', offenders.length === 0, offenders.join(' '));
}

section('Encoding');
check('UTF-8 pound sign intact', html.home.includes('£7m'));
check('UTF-8 en-dash intact', html.home.includes('–'));
check('no mojibake anywhere', !all.some((h) => h.includes('Ã') || h.includes('â€')));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);

// When a content assertion fails, print the exact needle and the closest
// region of the page so the mismatch is obvious rather than a guess.
if (process.env.VERIFY_DEBUG) {
  for (const [key, source] of [
    ['privacy', 'src/data/privacypolicy.md'],
    ['terms', 'src/data/tandcs.md'],
  ]) {
    const md = readFileSync(resolve(root, source), 'utf8');
    const page = visible(html[key]);
    const lines = md
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/<[^>]+>/g, ' ')
          .replace(/^[*\-\d.\s]+/, '')
          .replace(/[*_`]/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((l) => l.length > 45);

    const missing = lines.filter((l) => !page.includes(l.slice(0, 60)));
    console.log(`\n### ${key}: ${lines.length} lines, ${missing.length} missing`);
    for (const m of missing) {
      const needle = m.slice(0, 60);
      // Find the best-matching 60-char window in the page.
      const words = needle.split(' ');
      const anchor = words.slice(0, 4).join(' ');
      const at = page.indexOf(anchor);
      console.log(`  NEEDLE : ${JSON.stringify(needle)}`);
      console.log(`  ANCHOR : ${JSON.stringify(anchor)} @ ${at}`);
      if (at >= 0) console.log(`  IN PAGE: ${JSON.stringify(page.slice(at, at + 90))}`);
      const codes = [...needle].map((c) => c.codePointAt(0)).filter((c) => c > 126);
      console.log(`  NON-ASCII in needle: ${JSON.stringify(codes)} @ ${JSON.stringify([...needle].filter((c) => c.codePointAt(0) > 126))}`);
    }
  }
}

process.exit(failures === 0 ? 0 : 1);

