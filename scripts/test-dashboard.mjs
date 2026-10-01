/**
 * Tests for the Family Assistant dashboard logic.
 *
 * The dashboard talks to Firestore and FCM, so most of it cannot be exercised in
 * Node. What is testable is everything that decides *what* gets sent and *how* a
 * run is rendered - and that is where the bugs that matter live. An over-broad
 * read leaks history onto the page; a broken token hash means a phone silently
 * never receives notifications.
 *
 * Run with:  node scripts/test-dashboard.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];

/** Async-aware check, since deviceDocumentId uses Web Crypto. */
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push(`${name}\n    ${e.message}`);
  }
}

function eq(actual, expected, why = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`expected ${b}, got ${a}${why ? ` (${why})` : ''}`);
  }
}

function ok(value, why = '') {
  if (!value) throw new Error(`expected truthy${why ? ` (${why})` : ''}`);
}

// pathToFileURL, not a raw path: on Windows the ESM loader rejects a bare
// absolute path (protocol 'c:') and the whole suite dies before it runs.
const D = await import(pathToFileURL(resolve(root, 'src/lib/dashboard.js')).href);

// --- Device token hashing --------------------------------------------------
// The Firestore document id is a SHA-256 hash of the FCM token. This is a
// privacy control: reading the devices collection must not hand over working
// push credentials for the family's phones.

await check('deviceDocumentId is a stable sha256 hex digest', async () => {
  const id = await D.deviceDocumentId('token-abc');
  eq(id, createHash('sha256').update('token-abc').digest('hex'));
});

await check('deviceDocumentId is deterministic', async () => {
  eq(await D.deviceDocumentId('x'), await D.deviceDocumentId('x'));
});

await check('different tokens produce different ids', async () => {
  ok(await D.deviceDocumentId('a') !== await D.deviceDocumentId('b'));
});

await check('deviceDocumentId never contains the raw token', async () => {
  const secret = 'super-secret-fcm-token-value';
  ok(!(await D.deviceDocumentId(secret)).includes(secret));
});

await check('deviceDocumentId is 64 hex chars', async () => {
  ok(/^[0-9a-f]{64}$/.test(await D.deviceDocumentId('t')));
});

await check('empty token is rejected rather than hashed', async () => {
  eq(await D.deviceDocumentId(''), '');
  eq(await D.deviceDocumentId(null), '');
  eq(await D.deviceDocumentId(undefined), '');
});

// --- Push template rendering ----------------------------------------------
// Mirrors render_template in src/firestore_config.py so the preview the family
// sees agrees with what the Pi actually sends.

await check('renderPushTemplate substitutes known placeholders', () => {
  eq(D.renderPushTemplate('{summary} on {date} at {time}', {
    summary: 'Dentist', date: '2026-10-15', time: '14:30',
  }), 'Dentist on 2026-10-15 at 14:30');
});

await check('renderPushTemplate leaves unknown placeholders alone', () => {
  eq(D.renderPushTemplate('Hi {name} re {summary}', { summary: 'X' }),
     'Hi {name} re X');
});

await check('renderPushTemplate leaves a missing placeholder alone', () => {
  eq(D.renderPushTemplate('{summary} at {time}', { summary: 'Dentist' }),
     'Dentist at {time}');
});

await check('renderPushTemplate falls back when the template is blank', () => {
  eq(D.renderPushTemplate('', { summary: 'X' }, '{summary}'), 'X');
});

await check('renderPushTemplate never renders an empty substitution', () => {
  // "Dentist at ." reads as a bug in the notification.
  eq(D.renderPushTemplate('{summary} at {time}',
     { summary: 'Dentist', time: '' }), 'Dentist at {time}');
});

await check('renderPushTemplate escapes HTML in a preview context', () => {
  // Notification bodies carry email text; the preview is injected into the DOM.
  eq(D.renderPushTemplate('{summary}', { summary: '<img onerror=x>' }),
     '&lt;img onerror=x&gt;');
});

// --- Tag list parsing ------------------------------------------------------

await check('parseTagList splits on commas', () => {
  eq(D.parseTagList('school.org, clubs.co.uk'),
     ['school.org', 'clubs.co.uk']);
});

await check('parseTagList trims whitespace', () => {
  eq(D.parseTagList('  a ,  b  '), ['a', 'b']);
});

await check('parseTagList drops blanks from a trailing comma', () => {
  eq(D.parseTagList('a,b,'), ['a', 'b']);
});

await check('parseTagList returns empty for empty input', () => {
  eq(D.parseTagList(''), []);
  eq(D.parseTagList('   '), []);
  eq(D.parseTagList(null), []);
});

await check('parseTagList lowercases and strips a leading @', () => {
  eq(D.parseTagList('@School.ORG'), ['school.org']);
});

await check('formatTagList round-trips', () => {
  eq(D.formatTagList(['a', 'b']), 'a, b');
});

// --- Run history rendering -------------------------------------------------

await check('summariseRuns counts by status', () => {
  const s = D.summariseRuns([
    { status: 'SUCCESS' }, { status: 'SUCCESS' }, { status: 'WARN' },
    { status: 'ERROR' }, { status: 'WAT' },
  ]);
  eq(s.total, 5);
  eq(s.success, 2);
  eq(s.warn, 1);
  eq(s.error, 1);
  eq(s.unknown, 1);
});

await check('summariseRuns totals the metrics', () => {
  const s = D.summariseRuns([
    { status: 'SUCCESS', emails_scanned: 4, events_created: 1 },
    { status: 'WARN', emails_scanned: 2, events_created: 0 },
  ]);
  eq(s.emailsScanned, 6);
  eq(s.eventsCreated, 1);
});

await check('summariseRuns tolerates missing and malformed fields', () => {
  const s = D.summariseRuns([{}, { status: 'SUCCESS' }, { emails_scanned: 'x' }]);
  eq(s.total, 3);
  eq(s.emailsScanned, 0, 'a non-numeric metric must not become NaN');
});

await check('summariseRuns handles an empty history', () => {
  const s = D.summariseRuns([]);
  eq(s.total, 0);
  eq(s.success, 0);
});

await check('summariseRuns handles a non-array', () => {
  eq(D.summariseRuns(null).total, 0);
});

await check('formatRunId is human readable', () => {
  eq(D.formatRunId('20260930_210507'), '30 Sep 2026, 21:05');
});

await check('formatRunId leaves an unparseable id alone', () => {
  eq(D.formatRunId('nonsense'), 'nonsense');
});

await check('formatRunId handles an empty id', () => {
  eq(D.formatRunId(''), '');
  eq(D.formatRunId(null), '');
});

await check('sortRunsNewestFirst sorts descending', () => {
  const sorted = D.sortRunsNewestFirst([
    { run_id: '20260929_050000' },
    { run_id: '20261001_050000' },
    { run_id: '20260930_050000' },
  ]);
  eq(sorted.map((r) => r.run_id),
     ['20261001_050000', '20260930_050000', '20260929_050000']);
});

await check('sortRunsNewestFirst does not mutate the input', () => {
  const input = [{ run_id: 'b' }, { run_id: 'a' }];
  D.sortRunsNewestFirst(input);
  eq(input.map((r) => r.run_id), ['b', 'a']);
});

await check('sortRunsNewestFirst handles a non-array', () => {
  eq(D.sortRunsNewestFirst(null), []);
});

// --- Query bounds ----------------------------------------------------------
// An unbounded "order by timestamp" read is a billing problem and a bulk history
// export. dashboard-plan asks for the latest 15.

await check('RUNS_QUERY_LIMIT is bounded and sane', () => {
  ok(Number.isInteger(D.RUNS_QUERY_LIMIT) && D.RUNS_QUERY_LIMIT > 0);
  ok(D.RUNS_QUERY_LIMIT <= 15, 'dashboard-plan Task 4 asks for the latest 15');
});

// --- Config validation before writing --------------------------------------
// The dashboard writes config/app_settings, which the Pi reads at 05:00
// unattended. A blank prompt saved by accident would not surface until morning.

await check('validateConfig accepts a complete config', () => {
  eq(D.validateConfig({
    llm_prompt_template: 'Extract events.',
    push_template: '{summary}',
    whitelist_domains: ['school.org'],
  }), []);
});

await check('validateConfig rejects a blank prompt', () => {
  eq(D.validateConfig({ llm_prompt_template: '   ' }).length, 1);
});

await check('validateConfig accepts a config with no lists', () => {
  eq(D.validateConfig({ llm_prompt_template: 'x' }).length, 0);
});

await check('validateConfig accepts a prompt with placeholder braces', () => {
  eq(D.validateConfig({ llm_prompt_template: 'Today is {date}, do {x}' }).length, 0);
});

await check('validateConfig flags a malformed domain', () => {
  const errs = D.validateConfig({
    llm_prompt_template: 'x',
    whitelist_domains: ['not a domain'],
  });
  ok(errs.length > 0, 'a malformed domain should be reported before saving');
});

await check('validateConfig accepts a subdomain', () => {
  eq(D.validateConfig({
    llm_prompt_template: 'x',
    whitelist_domains: ['mail.school.org'],
  }).length, 0);
});

await check('validateConfig tolerates a missing document', () => {
  ok(D.validateConfig(null).length > 0, 'null config is not valid');
});

await check('validateConfig flags a list that is not a list', () => {
  ok(D.validateConfig({
    llm_prompt_template: 'x',
    blacklist_keywords: 'a,b',
  }).length > 0);
});

// --- Static assertions on the dashboard source -----------------------------
// These catch what unit tests cannot: the page shipping without the SDK wiring
// or config plumbing the rest of this file assumes exists.

const pagePath = resolve(root, 'src/pages/family-assistant/dashboard.astro');
const swPath = resolve(root, 'public/family-assistant/firebase-sw.js');

let page = '';
let sw = '';
try {
  page = readFileSync(pagePath, 'utf8');
} catch {
  console.error(`\nFATAL: dashboard page not found at ${pagePath}\n`);
  process.exit(1);
}
try {
  sw = readFileSync(swPath, 'utf8');
} catch {
  console.error(`\nFATAL: service worker not found at ${swPath}\n`);
  process.exit(1);
}

await check('dashboard gates the settings form on admin status', () => {
  ok(page.includes('ADMIN_EMAILS'), 'the page must know who is an admin');
  ok(page.includes('isAdmin'), 'the form must switch on admin status');
});

await check('non-admins are told why the form is read-only', () => {
  // Without a reason, a disabled form just looks like a broken page.
  ok(/read-only|administrator|admin/i.test(page));
});

await check('a denied save is reported, not swallowed', () => {
  // The rules are authoritative. If this list ever drifts from the rules file,
  // a non-admin clicking save must see a clear message, not a silent no-op.
  ok(/permission|denied/i.test(page), (
    'a permission-denied response from Firestore must be surfaced to the user'));
});


await check('dashboard loads the Google Identity Services SDK', () => {
  ok(page.includes('accounts.google.com/gsi/client'),
     'sign-in uses GIS, per dashboard-plan Task 3');
});

await check('dashboard loads the Firebase SDK modules', () => {
  ok(page.includes('firebase-app'));
  ok(page.includes('firebase-auth'));
  ok(page.includes('firebase-firestore'));
});

await check('dashboard does not hardcode an API key', () => {
  // Keys come from PUBLIC_ env vars at build time. A committed key would sit in
  // git history forever.
  ok(!/apiKey:\s*['"][A-Za-z0-9_-]{20,}/.test(page),
     'found what looks like a hardcoded Firebase API key');
});

await check('dashboard reads its config from PUBLIC_ env vars', () => {
  ok(page.includes('PUBLIC_FIREBASE_API_KEY'));
  ok(page.includes('PUBLIC_FIREBASE_VAPID_KEY'));
});

await check('dashboard uses the service worker for push', () => {
  ok(page.includes('getToken'), 'push subscription uses getToken');
  ok(page.includes('vapidKey'), 'getToken needs the VAPID key');
});

await check('dashboard stores the device token in Firestore', () => {
  ok(page.includes("'devices'") || page.includes('"devices"'));
  ok(page.includes('deviceDocumentId'),
     'the document id must be the hashed token, not the token itself');
});

await check('service worker handles push and displays notifications', () => {
  ok(sw.includes('addEventListener'), 'a worker must register listeners');
  ok(sw.includes('showNotification'), 'push must be shown to the user');
});

await check('service worker uses the modular messaging imports', () => {
  // The compat script is incompatible with getToken(), which is what this page
  // calls. Getting this wrong fails silently at subscribe time.
  ok(sw.includes('firebase-messaging-sw.js'));
  // Match the actual import specifier, not the prose that discusses it.
  ok(!/from\s+'[^']*firebase-messaging-compat/.test(sw),
     'must not import the compat build alongside the modular one');
});

await check('dashboard exposes the config form fields from the plan', () => {
  for (const id of ['llm-prompt', 'whitelist', 'blacklist', 'push-template']) {
    ok(page.includes(id), `missing control: ${id}`);
  }
});

await check('dashboard gates the save on validation', () => {
  ok(page.includes('validateConfig'),
     'a blank prompt saved by accident would not surface until 05:00');
});

await check('dashboard is a static page, not a server route', () => {
  // output: 'static' with no adapter; an onRequest export would break the build.
  ok(!/export\s+(const\s+)?(onRequest|POST|GET|PUT|DELETE)\b/.test(page));
});

// --- Report ---------------------------------------------------------------

console.log(`\nDashboard: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL  ${f}\n`);
  process.exit(1);
}