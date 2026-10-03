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

// --- The deploy workflow must feed the build ---------------------------------
// import.meta.env is resolved at BUILD time, not at runtime. If the workflow
// stops passing these, the dashboard still builds and deploys successfully and
// simply ships unconfigured - the failure is silent, and only visible to whoever
// tries to sign in. These assert the wiring exists.

const workflowPath = resolve(root, '.github/workflows/deploy.yml');
let workflow = '';
try {
  workflow = readFileSync(workflowPath, 'utf8');
} catch {
  console.error(`\nFATAL: deploy workflow not found at ${workflowPath}\n`);
  process.exit(1);
}

const PUBLIC_FIREBASE_VARS = [
  'PUBLIC_FIREBASE_API_KEY',
  'PUBLIC_FIREBASE_AUTH_DOMAIN',
  'PUBLIC_FIREBASE_PROJECT_ID',
  'PUBLIC_FIREBASE_APP_ID',
  'PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'PUBLIC_FIREBASE_VAPID_KEY',
];

for (const name of PUBLIC_FIREBASE_VARS) {
  await check(`deploy workflow passes ${name} to the build`, () => {
    ok(workflow.includes(`${name}: \${{ vars.${name} }}`),
       `the Build step must export ${name}, or the dashboard ships with no `
       + `Firebase config and sign-in silently fails for the whole family`);
  });
}

await check('all six Firebase vars sit in the Build step env block', () => {
  const after = workflow.split('- name: Build')[1] ?? '';
  const buildStep = after.split('- name:')[0] ?? '';
  ok(buildStep.includes('env:'), 'the Build step needs an env: block');
  for (const name of PUBLIC_FIREBASE_VARS) {
    ok(buildStep.includes(name), `${name} is not in the Build step`);
  }
});

await check('firebase config is a repo variable, not a secret', () => {
  // These values are public by design. Storing them as secrets would imply they
  // need protecting, and they do not: access is the security rules' job.
  ok(!/PUBLIC_FIREBASE_\w+:\s*\$\{\{\s*secrets\./.test(workflow),
     'Firebase web config should use vars.* not secrets.* - it is public by '
     + 'design, and calling it a secret misleads the next person');
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


await check('dashboard explains a missing VAPID key rather than failing obscurely', () => {
  // getToken() throws an opaque error when vapidKey is empty. A user who has
  // completed sign-in and pressed the button deserves to be told the push setup
  // is unfinished, not handed a raw SDK error.
  ok(/vapid/i.test(page), 'the page must reference the VAPID key by name');
  ok(/not.*configured|not.*set|missing/i.test(page), (
    'there should be a human-readable message for the unset-VAPID case'));
});

await check('deploy workflow passes the OAuth client id to the build', () => {
  ok(workflow.includes('PUBLIC_GOOGLE_CLIENT_ID: ${{ vars.PUBLIC_GOOGLE_CLIENT_ID }}'),
     'the Build step must export PUBLIC_GOOGLE_CLIENT_ID. Without it the '
     + 'dashboard loads no Google Identity Services script and renders no '
     + 'sign-in button, with nothing on screen to say why.');
  ok(workflow.includes('PUBLIC_GOOGLE_CLIENT_ID: ${{ vars.PUBLIC_GOOGLE_CLIENT_ID }}')
     && /- name: Build[\s\S]*?env:[\s\S]*PUBLIC_GOOGLE_CLIENT_ID/.test(workflow),
     'PUBLIC_GOOGLE_CLIENT_ID must sit in the Build step env block');
});

await check('dashboard says so when the OAuth client id is missing', () => {
  // A page that silently renders an empty sign-in box reads as a broken site.
  ok(page.includes('PUBLIC_GOOGLE_CLIENT_ID'));
  ok(/sign[- ]?in.*not|not.*configured|no sign/i.test(page), (
    'there should be a human-readable message when sign-in cannot be set up'));
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

// --- Sign-in button -------------------------------------------------------
// The deployed page showed the heading "Sign in" with nothing under it. The
// cause was a race: the GIS <script> is injected async, onAuthStateChanged
// fires with a null user first, renderGoogleButton() bails out because
// window.google is undefined, and nothing ever called it again.

await check('the sign-in button is rendered when the GIS script loads', () => {
  // Without a load handler the button is never drawn.
  ok(/addEventListener\(\s*['"]load['"]\s*,\s*renderGoogleButton\s*\)/.test(page),
     'the injected GIS script must render the button on load. onAuthStateChanged '
     + 'fires long before the script arrives, so the only reliable moment to '
     + 'render is the load event.');
});

await check('the sign-in button is not drawn twice', () => {
  ok(/window\.google\?\.accounts\?\.id/.test(page),
     'renderGoogleButton must check the SDK is present before use, and must not '
     + 're-initialize when it already is (GIS errors on a second initialize)');
  ok(/auth\?\.currentUser/.test(page),
     'renderGoogleButton must bail out once someone is signed in, or signing '
     + 'back in leaves two buttons on the page');
});

await check('the button reads "Sign in with Google"', () => {
  ok(page.includes("text: 'signin_with'"),
     "renderButton needs text: 'signin_with' to say \"Sign in with Google\"");
  ok(!page.includes("text: 'continue_with'"),
     "'continue_with' renders \"Continue with Google\", which contradicts the "
     + 'heading above it');
});

await check('a sign-in failure is reported next to the sign-in card', () => {
  // It used to be written into the settings form, far below the fold.
  ok(page.includes("id=\"auth-error\""));
  ok(/say\(\$\('auth-error'\)/.test(page),
     'sign-in errors belong in the auth card, not the config form');
});

// --- Gating the panel on sign-in ------------------------------------------

await check('the panel is hidden until someone signs in', () => {
  for (const id of ['history', 'config', 'push']) {
    ok(new RegExp(`id="${id}"[^>]*hidden`).test(page),
       `the #${id} section must start hidden, so a signed-out visitor is not `
       + 'shown a control panel they cannot use');
  }
  ok(page.includes('setPanelVisible'), 'sign-in must reveal the panel');
  ok(/function onSignedIn[\s\S]*?setPanelVisible\(true\)/.test(page),
     'onSignedIn must reveal the panel');
  ok(/function onSignedOut[\s\S]*?setPanelVisible\(false\)/.test(page),
     'onSignedOut must hide it again, or signing out leaves the panel visible');
});

await check('hidden actually hides, despite author display rules', () => {
  // An author `display` beats the user-agent's `[hidden] { display: none }`.
  // .summary is a grid, so `hidden` was already a no-op on it before this
  // rule existed - the summary strip could never be hidden.
  ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(page),
     'the page needs an explicit [hidden] rule, or any element with an author '
     + 'display rule stays visible when hidden is set');
});

await check('gating the panel is not mistaken for access control', () => {
  // A future reader must not "simplify" this into a security boundary.
  ok(/firestore\.rules/i.test(page),
     'the page should say that the rules, not the hidden attribute, are what '
     + 'authorise access');
});

// --- DOM lookups ----------------------------------------------------------
// The real cause of the missing button. $ is a getElementById shorthand, so
// $('#fb-config') searches for an id of literally "#fb-config" and returns
// null. That threw on the first line of the module and killed the whole
// script: no boot(), no Google script, no button - and no error on screen.

await check('getElementById shorthand is never given a CSS selector', () => {
  // Comments are stripped first: this file's own explanation of the bug quotes
  // the broken form, and matching that prose would fail the build forever.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bad = [...code.matchAll(/\$\(\s*['"]#/g)];
  eq(bad.length, 0,
     `found ${bad.length} call(s) like $('#some-id'). $ wraps `
     + 'document.getElementById, which wants a bare id with no "#". This threw '
     + 'a TypeError that silently disabled the entire dashboard.');
});

await check('the dashboard reads its build config from the DOM', () => {
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(code.includes("$('fb-config')"), 'the config block is read by id');
  ok(code.includes("$('g_id_onload')"), 'the client id is read by id');
});

await check('a missing config block fails loudly, not silently', () => {
  // The failure mode that hid this for so long: the page rendered, looked
  // plausible, and simply never did anything.
  ok(/missing from the page/.test(page),
     'readBuildConfig must throw a named error when the config block is absent');
  ok(/could not start/i.test(page),
     'a startup failure must be shown to the user rather than swallowed');
});

await check('startup waits for the DOM before reading it', () => {
  ok(/DOMContentLoaded|readyState/.test(page),
     'the module must not assume its elements are parsed; defer to '
     + "DOMContentLoaded or check document.readyState");
});

await check('the config is read once, not at module scope', () => {
  // Module-scope consts reading the DOM are what made this fragile. The
  // values are assigned inside a function called from start() instead.
  ok(/function readBuildConfig\(\)/.test(page),
     'build config should be read by a function, not a top-level const');
  ok(!/const FIREBASE_CONFIG\s*=/.test(page),
     'FIREBASE_CONFIG must not be initialised from the DOM at module scope');
});

// --- Reading measure ------------------------------------------------------
// Body copy was capped at 68-70ch inside a 1366px page with 40px gutters, so
// on a desktop it used under half the width while the cards and buttons beside
// it spanned the full page. The measure is now a token in global.css.

const cssPath = resolve(root, 'src/styles/global.css');
const introPath = resolve(root, 'src/components/Intro.astro');
let css = '';
let intro = '';
try {
  css = readFileSync(cssPath, 'utf8');
  intro = readFileSync(introPath, 'utf8');
} catch (e) {
  console.error(`\nFATAL: could not read layout sources: ${e.message}\n`);
  process.exit(1);
}

await check('the reading measure is a shared token', () => {
  // One place to retune, rather than a hard-coded number in five components.
  ok(/--measure:\s*\d+ch/.test(css), 'global.css must define --measure');
  ok(/--measure-lead:\s*\d+ch/.test(css),
     'global.css must define --measure-lead for lead paragraphs');
});

await check('the measure is wider than the old 70ch cap', () => {
  // The regression: a narrower token would put the site back where it started.
  const measure = Number(/--measure:\s*(\d+)ch/.test(css)
    && css.match(/--measure:\s*(\d+)ch/)[1]);
  ok(measure >= 88, `--measure is ${measure}ch; body copy was 68-70ch and read `
     + 'as half a column on a desktop. 88ch or wider restores the width.');
});

await check('body copy uses the token, not a hard-coded ch cap', () => {
  for (const name of ['Experience', 'Interests', 'Skills']) {
    const src = readFileSync(resolve(root, `src/components/${name}.astro`), 'utf8');
    ok(!/max-width:\s*\d+ch/.test(src),
       `${name}.astro still caps text at a hard-coded ch width, so it will keep `
       + 'the narrow column on a desktop');
  }
  const fa = readFileSync(
    resolve(root, 'src/pages/family-assistant/index.astro'), 'utf8');
  ok(!/max-width:\s*(68|70)ch/.test(fa),
     'the Family Assistant summary and prose are still capped at 68/70ch');
});

await check('a single intro paragraph is not trapped in one grid column', () => {
  // cv.json ships one intro paragraph. In a fixed two-column grid it sat in
  // column one at ~470px, directly above two buttons spanning 1286px.
  ok(/grid-template-columns:\s*repeat\(auto-fit,/.test(intro),
     '.intro-cols must use auto-fit so an empty track collapses when there is '
     + 'only one paragraph');
  // A media query re-forcing two columns silently undoes the above. Comments
  // are stripped first: they discuss this very rule, and matching prose in a
  // comment would fail the build for doing the right thing.
  const rules = intro.replace(/\/\*[\s\S]*?\*\//g, '');
  const forced = /@media[^{]*\{[^}]*\.intro-cols[^{]*\{[^}]*grid-template-columns:\s*repeat\(\s*2/.test(rules);
  ok(!forced,
     'no media query may force .intro-cols back to two fixed columns, or the '
     + 'narrow column returns');
});

// --- Service worker registration ------------------------------------------
// The subscription flow asks for permission, then fails to register the worker:
// "ServiceWorker script evaluation failed".
//
// firebase-sw.js uses top-level `import`, which is only legal in a MODULE
// worker. register() defaults to classic, where `import` is a SyntaxError, so
// the script never evaluates and registration rejects. Permission was already
// granted by then, which is why it looked like the browser was at fault.

await check('the service worker is registered as a module', () => {
  // The explanatory comment sits between the call and the options, so the
  // window has to be generous; 400 chars was not enough.
  ok(/serviceWorker\.register\([\s\S]{0,800}?type:\s*'module'/.test(page),
     'the worker uses top-level `import`, so it must be registered with '
     + "{ type: 'module' }; the default classic worker cannot parse it");
});

await check('the service worker script really does use import', () => {
  // Guards the test above from passing vacuously: if the worker were rewritten
  // to use importScripts, requiring type:'module' would become wrong.
  const sw = readFileSync(
    resolve(root, 'public/family-assistant/firebase-sw.js'), 'utf8');
  ok(/^import\s/m.test(sw),
     'firebase-sw.js is expected to use ESM imports; if this changed, revisit '
     + "the { type: 'module' } registration");
});

// --- Config form must not render empty -------------------------------------
// config/app_settings does not exist until somebody saves it. The dashboard
// rendered four blank inputs, which read as broken and uneditable rather than
// as "showing defaults".

await check('the config form falls back to the service defaults', () => {
  ok(/llm-prompt'\)\.value = data\.llm_prompt_template \?\? DEFAULT_LLM_PROMPT/.test(page),
     'an absent settings document must show DEFAULT_LLM_PROMPT, not an empty box');
  ok(/push-template'\)\.value = data\.push_template \?\? DEFAULT_PUSH_TEMPLATE/.test(page),
     'an absent settings document must show DEFAULT_PUSH_TEMPLATE');
});

await check('the default prompt matches the Pi constant', () => {
  // Two copies exist by necessity (JS vs Python). They must agree, or the
  // dashboard describes a prompt the service is not running.
  ok(typeof D.DEFAULT_LLM_PROMPT === 'string' && D.DEFAULT_LLM_PROMPT.includes('{date}'),
     'dashboard.js must export a DEFAULT_LLM_PROMPT containing {date}');
  const planner = readFileSync(
    resolve(process.cwd(), '..', 'family-planner', 'src', 'firestore_config.py'),
    'utf8');
  const fromPy = /DEFAULT_LLM_PROMPT = \(([\s\S]*?)\)\n/.exec(planner);
  ok(fromPy, 'could not read DEFAULT_LLM_PROMPT from firestore_config.py');
  const pyText = fromPy[1].replace(/["\s]/g, '');
  eq(D.DEFAULT_LLM_PROMPT.replace(/\s/g, ''), pyText,
     'DEFAULT_LLM_PROMPT has drifted between dashboard.js and firestore_config.py');
});

// --- Disallowed sender domains ---------------------------------------------

await check('there is a disallowed-domains field, wired end to end', () => {
  ok(/id="blacklist-domains"/.test(page), 'the form needs a blacklist-domains input');
  ok(/blacklist_domains:\s*parseTagList\(\$\('blacklist-domains'\)\.value\)/.test(page),
     'the save payload must include blacklist_domains');
  ok(/\$\('blacklist-domains'\)\.value = formatTagList\(data\.blacklist_domains/.test(page),
     'loadConfig must populate the disallowed-domains field');
  ok(/DEFAULT_LLM_PROMPT/.test(page), 'sanity: the defaults import is still present');
});

await check('the admin/read-only field list includes the new input', () => {
  // Missing from these lists means the field stays enabled and writable for
  // non-admins, or stays disabled for admins.
  const mentions = (page.match(/blacklist-domains/g) || []).length;
  ok(mentions >= 4,
     `blacklist-domains appears ${mentions} time(s); it must be in the markup, `
     + 'loadConfig, the save payload, and both enable/read-only loops');
});

await check('disallowed domains are validated as domains', () => {
  eq(D.validateConfig({ llm_prompt_template: 'p', blacklist_domains: ['bad domain'] }).length, 1,
     'a malformed domain must be rejected before it reaches the Pi');
  eq(D.validateConfig({ llm_prompt_template: 'p', blacklist_domains: ['amazon.co.uk'] }).length, 0,
     'a valid domain must be accepted');
  eq(D.validateConfig({ llm_prompt_template: 'p', blacklist_keywords: ['unsubscribe now'] }).length, 0,
     'keywords are free text and must not be domain-validated');
});

// --- Mobile layout ---------------------------------------------------------
// Two separate overflow bugs, both reported from a phone.

await check('run logs cannot overflow their card', () => {
  // pre-wrap alone is not sufficient: the box still sizes to its longest line.
  const runPre = /\.run pre \{([^}]*)\}/.exec(page);
  ok(runPre, 'could not find the .run pre rule');
  ok(/max-width:\s*100%/.test(runPre[1]),
     '.run pre needs max-width:100% or a long log line widens the card');
  ok(/overflow-wrap:\s*anywhere|word-break:\s*break-word/.test(runPre[1]),
     '.run pre needs break-word/anywhere so long tokens wrap');
  const runCard = /\.run \{([^}]*)\}/.exec(page);
  ok(runCard && /min-width:\s*0/.test(runCard[1]),
     '.run needs min-width:0; a grid item defaults to min-width:auto and is '
     + 'sized by its longest child');
});

await check('the Google button is sized to its container', () => {
  ok(!/width:\s*320\b/.test(page.replace(/\/\*[\s\S]*?\*\//g, '')),
     'a hard-coded 320px button overflows a 360px phone');
  ok(/getBoundingClientRect\(\)\.width/.test(page),
     'the button width should be measured from the slot, not fixed');
});

// --- Decision history and mark-as-incorrect ------------------------------
// Runs only ever carried counters, so "why is this on the calendar" could not
// be answered anywhere except the Pi console at 05:00. One record per email,
// with the verdict, the reason and the calendar event id, makes it answerable.

await check('there is a decision history section', () => {
  ok(/id="decisions-list"/.test(page), 'the page needs a list for the history');
  ok(/id="decisions"/.test(page), 'and a panel to hold it');
  ok(/loadDecisions\(\)/.test(page), 'it must be loaded when signed in');
});

await check('the decisions panel is hidden until sign-in', () => {
  // Same reasoning as the other panels: the markup is public, so the gate is
  // cosmetic, but it must still be there.
  const section = /<section class="card" id="decisions"[^>]*>/.exec(page);
  ok(section, 'could not find the decisions section');
  ok(/hidden/.test(section[0]),
     'the decisions panel must start hidden like history, config and push');
  ok(/PANEL_IDS = \[[^\]]*'decisions'/.test(page),
     "'decisions' must be in PANEL_IDS or it never becomes visible");
});

await check('decision reads are bounded', () => {
  // An unbounded read is both a billing problem and a bulk export of the
  // family's email subjects and senders.
  ok(/DECISIONS_QUERY_LIMIT/.test(page), 'the query needs an explicit limit');
  const m = /DECISIONS_QUERY_LIMIT = (\d+)/.exec(page);
  ok(m && Number(m[1]) <= 200,
     `limit is ${m?.[1]}; keep it well under an unbounded export`);
  ok(/\.limit\(DECISIONS_QUERY_LIMIT\)/.test(page),
     'the query must actually apply the limit');
});

await check('marking incorrect writes only the flag', () => {
  ok(/incorrect:\s*true/.test(page), 'the write must set the incorrect flag');
  ok(/\{ merge: true \}/.test(page),
     'the write must merge; overwriting would discard the sender and subject '
     + 'that make the flag useful');
  // The rules restrict this to those three keys. Writing more from the browser
  // would be rejected, so the payload must match.
  const rules = readFileSync(
    resolve(root, '..', 'family-planner', 'firebase', 'firestore.rules'), 'utf8');
  ok(/match \/decisions\/\{messageId\}/.test(rules),
     'firestore.rules must have a decisions rule or the write is denied');
  ok(/'incorrect', 'incorrect_note', 'marked_incorrect_at'/.test(rules),
     'the rules must permit exactly the keys the dashboard writes');
  ok(/match \/decisions\/\{messageId\}/.test(rules)
     && /allow create, delete: if false/.test(rules),
     'decisions must not be creatable or deletable from the browser');
});

await check('decision rows escape email-derived text', () => {
  // Subjects and senders come from email, which an outside party controls.
  const block = page.slice(page.indexOf('function renderDecisions'));
  ok(/escapeHtml\(record\.subject/.test(block),
     'the subject must be escaped');
  ok(/\.map\(escapeHtml\)/.test(block),
     'sender/summary must be escaped');
});

await check('the incorrect flag is only offered to admins', () => {
  const block = page.slice(page.indexOf('function markIncorrectControl'));
  ok(/if \(!isAdmin\)/.test(block),
     'the mark-incorrect control must check isAdmin');
  ok(/permission|denied/i.test(page),
     'a rules rejection must be reported plainly, not swallowed');
});

// --- Report ---------------------------------------------------------------

console.log(`\nDashboard: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL  ${f}\n`);
  process.exit(1);
}
