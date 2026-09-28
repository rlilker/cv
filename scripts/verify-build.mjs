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

// build.format is 'file', so each page is emitted as <route>.html rather than
// <route>/index.html. See the note in astro.config.mjs: with 'directory', a
// request for /family-planner/ resolves to the S3 key "family-planner/", which
// is a prefix rather than an object, and CloudFront serves the CV homepage
// instead of the page.
const PAGES = {
  home: 'dist/index.html',
  app: 'dist/family-planner.html',
  privacy: 'dist/family-planner/privacy.html',
  terms: 'dist/family-planner/terms.html',
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
check('LinkedIn', html.home.includes(data.profile.linkedin));
check('GitHub', html.home.includes(data.profile.github));
check('location', html.home.includes(data.profile.location));
check('intro paragraphs', data.profile.intro.every((p) => html.home.includes(escapeHtml(p.slice(0, 60)))));

// Contact details are deliberately absent from the CV. LinkedIn and GitHub are
// the routes. The Family Planner legal pages still name an email address
// because GDPR and DSA both require a published point of contact, so this
// section checks the CV page only.
section('No direct contact details on the CV');
const homeText = html.home.replace(/<[^>]*>/g, ' ');
check('no mailto: link', !html.home.includes('mailto:'));
check('no tel: link', !html.home.includes('tel:'));
check('no phone number', !/\b0\d{9,10}\b/.test(homeText), 'a 10-11 digit run that looks like a UK mobile');
check('no email address in the visible text', !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(homeText));
check('no email in JSON-LD', !/"email"/.test(html.home));
check('no telephone in JSON-LD', !/"telephone"/.test(html.home));
check('no tagline claim', !html.home.includes('Seeking'), 'the "Seeking Full Stack Development" tagline');
check('no summary blurb', !html.home.includes('proficiency'), 'the generic "proficient in..." summary');
check('the long second intro paragraph is gone', !html.home.includes('outlives the project'));
// The closing CTA is just "Contact Me" next to the two buttons. It used to
// read "Based in Manchester, UK, and open to new work."
check('closing CTA says Contact Me', html.home.includes('Contact Me'));
check(
  'closing CTA makes no availability claim',
  !/open to new work|open to .* roles/i.test(html.home),
  'the CTA should invite contact, not advertise availability',
);
check('no tagline field left in the CV data', !('tagline' in data.profile));

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

// The stat strip was removed from the hero, so there is no CV-level "highlights"
// array any more. The Family Planner page keeps its own heroStats.
check('no stat strip on the CV', !html.home.includes('class="stat"'), 'the hero stat tiles were removed');
check(
  'no highlights array in the CV data',
  !('highlights' in data),
  'cv.json should not carry an unused highlights array',
);

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
  check('links to the app page', html[key].includes('/family-planner"'));
  check('links back to the CV', html[key].includes('href="/"'));
}

// ═══════════════════════════════════════════════════════════════════════════
//  URL scheme
// ═══════════════════════════════════════════════════════════════════════════
//
// Every internal link must match the emitted filenames, and must not carry a
// trailing slash. build.format 'directory' is what made /family-planner/ serve
// the CV instead of the page, and nothing in the build output would reveal it
// on its own - only a request against the deployed site shows it. These checks
// keep the source and the filenames in agreement so it cannot come back.
section('URL scheme');
const configText = readFileSync(resolve(root, 'astro.config.mjs'), 'utf8');
check("astro build.format is 'file'", /format:\s*'file'/.test(configText), "'directory' breaks directory-style routes on S3");
check("astro trailingSlash is 'never'", /trailingSlash:\s*'never'/.test(configText));

const flatHtml = all.filter((h) => h.includes('href="/family-planner/"'));
check('no link uses a trailing-slash project URL', flatHtml.length === 0, 'a /family-planner/ link resolves to the CV');

for (const [key] of Object.entries(PAGES)) {
  if (key === 'home') continue;
  const canonical = html[key].match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? '';
  // The .html suffix is stripped so canonical matches the public URL. Left in,
  // it points at a URL that returns 404 - which is how a search engine ends up
  // indexing a dead link.
  check(`${key} canonical has no .html suffix`, !canonical.endsWith('.html'), canonical);
  check(`${key} canonical has no trailing slash`, !canonical.endsWith('/'), canonical);
  check(`${key} og:url matches canonical`, html[key].includes(`property="og:url" content="${canonical}"`));
}

// Every internal page link must correspond to a file the build actually
// emitted. Assets under /_astro and files with an extension are checked to
// exist as-is instead, because those are already their final path.
section('Every internal link resolves');
const internalHrefs = new Set(
  all.join(' ').match(/href="\/[^"#]*"/g)?.map((h) => h.slice(6, -1)) ?? [],
);
for (const href of internalHrefs) {
  if (href === '/') continue;
  const isAsset = /\.[a-z0-9]+$/i.test(href);
  const target = isAsset ? `dist${href}` : `dist${href}.html`;
  check(
    `internal link ${href} maps to a built file`,
    existsSync(resolve(root, target)),
    `${target} does not exist`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-page navigation
// ═══════════════════════════════════════════════════════════════════════════

section('Cross-page navigation');
check('home links to the app', html.home.includes('/family-planner"'));
check('app links to the CV', html.app.includes('href="/"'));
check('legal pages link to each other', html.privacy.includes('/family-planner/terms"') && html.terms.includes('/family-planner/privacy"'));
check('nav present on every page', all.every((h) => h.includes('class="nav-pill nav-links"')));
check('app reachable from the nav on every page', all.every((h) => h.includes('href="/family-planner"')));
check('CV sections reachable from the nav on every page', all.every((h) => h.includes('href="/#experience"')));

// The brand lozenge was removed. The name still appears elsewhere (footer,
// JSON-LD, headings), so the check is for the chip element specifically, not
// for the absence of the name.
check('no brand lozenge in the nav', all.every((h) => !h.includes('brand-chip')));
check('no nav-brand pill', all.every((h) => !h.includes('nav-brand')));

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
check('decorative svgs are aria-hidden', all.every((h) => h.includes('aria-hidden="true"')));

// ═══════════════════════════════════════════════════════════════════════════
//  Nav behaviour
// ═══════════════════════════════════════════════════════════════════════════
//
// Read from source rather than the bundle, because these are the declarations
// that decide whether the menu stays pinned and whether the project link stays
// inside its pill. Both were wrong, and neither is visible in the HTML.
section('Nav behaviour');

const navSrc = readFileSync(resolve(root, 'src/components/Nav.astro'), 'utf8');
const globalSrc = readFileSync(resolve(root, 'src/styles/global.css'), 'utf8');

check('nav header is position: sticky', /\.top-nav\s*\{[^}]*position:\s*sticky/.test(navSrc));
check('nav header is pinned to the top', /\.top-nav\s*\{[^}]*top:\s*0\b/.test(navSrc));

// 'hidden' on body propagates to the viewport and silently breaks sticky, so
// the menu scrolled away instead of staying pinned. 'clip' contains overflow
// without becoming a scroll container. This is the check that stops it
// coming back.
check(
  'body does not use overflow-x: hidden (breaks position: sticky)',
  !/overflow-x:\s*hidden/.test(globalSrc),
  'use overflow-x: clip instead',
);
check('body uses overflow-x: clip', /overflow-x:\s*clip/.test(globalSrc));

// The Family Planner link used to spill past the pill's rounded right edge
// because the pill could not shrink below its content.
check(
  'nav pill can shrink so the project link stays inside it',
  /\.nav-links\s*\{[^}]*min-width:\s*0/.test(navSrc),
);
check('nav project link does not shrink', /\.nav-project\s*\{[^}]*flex:\s*0 0 auto/.test(navSrc));
check('nav links sit on the right', /\.nav-links\s*\{[^}]*margin-left:\s*auto/.test(navSrc));

// Below 720px the six labels no longer fit on one line. Without letting the
// pill wrap, the project link was pushed past the right edge and the document
// scrolled sideways. Verified in a real browser at 380px.
check(
  'nav pill wraps its items on narrow screens',
  /@media \(max-width: 720px\)[\s\S]*?\.nav-links\s*\{[^}]*flex-wrap:\s*wrap/.test(navSrc),
);
check(
  'nav pill drops white-space: nowrap on narrow screens',
  /@media \(max-width: 720px\)[\s\S]*?\.nav-links\s*\{[^}]*white-space:\s*normal/.test(navSrc),
);

// A long section count ("62 technologies") with white-space: nowrap forced the
// whole page into horizontal scroll on a phone. The row now wraps instead.
const sectionTitleSrc = readFileSync(resolve(root, 'src/components/SectionTitle.astro'), 'utf8');
check(
  'section heading row can shrink',
  /\.section-head\s*\{[^}]*min-width:\s*0/.test(sectionTitleSrc),
);
check(
  'section heading row wraps on narrow screens',
  /@media \(max-width: 720px\)[\s\S]*?\.section-head\s*\{[^}]*flex-wrap:\s*wrap/.test(sectionTitleSrc),
);

// Dead code left behind by removing the brand lozenge.
check('no dead --chip-h token', !/--chip-h/.test(globalSrc));
check('no dead .brand-chip rule', !/\.brand-chip\s*\{/.test(navSrc));
check('no dead .nav-brand rule', !/\.nav-brand\s*\{/.test(navSrc));

// The nav is still a real, labelled landmark.
check('nav has aria-label', all.every((h) => h.includes('aria-label="Sections"')));
check('nav is a <nav> landmark on every page', all.every((h) => h.includes('<nav class="nav-pill nav-links"')));

section('Source hygiene');

/** Recursively list files under a directory matching a predicate. */
const walk = (dir, match = () => true) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? walk(p, match) : match(p) ? [p] : [];
  });

// A stray tag inside a <style> block is silently shipped as broken CSS — Astro
// only emits a minifier warning and the build still passes. Catch it at source.
{
  const offenders = [];
  for (const file of walk(resolve(root, 'src'), (p) => p.endsWith('.astro'))) {
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

section('Shell script hygiene');
// A CRLF line ending inside a .sh file makes bash fail with a syntax error,
// which is baffling when the script looks correct in an editor.
{
  const shFiles = walk(resolve(root, 'scripts')).filter((f) => f.endsWith('.sh'));
  const crlf = shFiles.filter((f) => readFileSync(f, 'utf8').includes('\r\n'));
  check(`shell scripts use LF (${shFiles.length} found)`, crlf.length === 0, crlf.map((f) => relative(root, f)).join(' '));
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

