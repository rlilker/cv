/**
 * Post-build sanity check.
 *
 * Astro will happily "successfully" build a page that is missing half its
 * content, so this asserts the rendered HTML actually contains the CV data.
 * Run with:  node scripts/verify-build.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = resolve(root, 'dist/index.html');
const data = JSON.parse(readFileSync(resolve(root, 'src/data/cv.json'), 'utf8'));

let failures = 0;

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
};

console.log('\n--- build output ---');
check('dist/index.html exists', existsSync(distIndex));
if (!existsSync(distIndex)) {
  console.log('\nBuild output missing. Run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(distIndex, 'utf8');
console.log(`\n--- rendered HTML: ${(html.length / 1024).toFixed(1)} KB ---\n`);

console.log('Profile');
check('name', html.includes(data.profile.name));
check('role', html.includes(data.profile.role));
check('email link', html.includes(`mailto:${data.profile.email}`));
check('tel link', html.includes('tel:07734567119'));
check('LinkedIn', html.includes(data.profile.linkedin));
check('GitHub', html.includes(data.profile.github));
check('location', html.includes(data.profile.location));
check('intro paragraphs', data.profile.intro.every((p) => html.includes(p.slice(0, 60))));

console.log('\nEmployment history');
// Astro HTML-escapes text, so compare against an escaped copy of the source.
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

for (const role of data.roles) {
  const ok = html.includes(escapeHtml(role.company)) && html.includes(escapeHtml(role.title)) && html.includes(role.start);
  check(`${role.company} (${role.start}–${role.end})`, ok);
}

console.log('\nContent integrity');
// Match the <h3> specifically — `class="role-titles` is the wrapper element.
const renderedRoles = (html.match(/<h3 class="role-title/g) || []).length;
check('every role rendered', renderedRoles === data.roles.length, `${renderedRoles}/${data.roles.length}`);

const bullets = data.roles.reduce((n, r) => n + r.highlights.length, 0);
const renderedBullets = (html.match(/class="role-points"/g) || []).length;
check('bullet lists rendered', renderedBullets === data.roles.filter((r) => r.highlights.length).length, `${renderedBullets}`);

const skillCards = (html.match(/class="skill-card/g) || []).length;
check('every skill group rendered', skillCards === data.skillGroups.length, `${skillCards}/${data.skillGroups.length}`);

const pills = (html.match(/class="interest-pill"/g) || []).length;
check('every interest rendered', pills === data.interests.length, `${pills}/${data.interests.length}`);

const stats = (html.match(/class="stat"/g) || []).length;
check('stat tiles rendered', stats === data.highlights.length, `${stats}/${data.highlights.length}`);

console.log('\nSEO / metadata');
check('<title>', html.includes(`<title>${data.profile.name} — ${data.profile.role}</title>`));
check('meta description', html.includes('name="description"'));
check('canonical link', html.includes('rel="canonical"'));
check('Open Graph', html.includes('property="og:title"') && html.includes('property="og:image"'));
check('Twitter card', html.includes('name="twitter:card"'));
check('JSON-LD Person', html.includes('"@type": "Person"') || html.includes('"@type":"Person"'));
check('favicon', html.includes('favicon.svg'));
check('webmanifest', html.includes('site.webmanifest'));
check('html lang set', html.includes('<html lang="en-GB"'));
check('viewport meta', html.includes('name="viewport"'));

console.log('\nSections & assets');
for (const section of data.navSections) {
  check(`section #${section.id}`, html.includes(`id="${section.id}"`));
}
check('stylesheet linked', html.includes('stylesheet'));
check('self-hosted font (no Google Fonts CDN)', !html.includes('fonts.googleapis.com'));
check('robots.txt', existsSync(resolve(root, 'dist/robots.txt')));

console.log('\nAccessibility');
check('skip link', html.includes('class="skip-link"'));
check('single h1', (html.match(/<h1/g) || []).length === 1, `${(html.match(/<h1/g) || []).length} found`);
check('nav has aria-label', html.includes('aria-label="Sections"'));
check('aria-hidden on decorative svg', html.includes('aria-hidden="true"'));

console.log('\nEncoding');
check('UTF-8 pound sign intact', html.includes('£7m'));
check('UTF-8 en-dash intact', html.includes('–'));
check('no mojibake', !html.includes('Ã') && !html.includes('â€'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
