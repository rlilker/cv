/**
 * Stubs the Firebase SDK and Google Identity Services in the browser.
 *
 * The dashboard dynamically imports the Firebase ESM bundles from gstatic and
 * loads the Google sign-in script from accounts.google.com. Both are
 * intercepted here so the suite runs with no project, no credentials and no
 * outbound network, while still executing the page's REAL logic: sign-in
 * handling, admin gating, Firestore reads, and the service worker handshake.
 *
 * The point is to test the page, not Firebase. What actually broke in
 * production was the page's own code.
 */
import { test as base, expect } from '@playwright/test';

/** Config shaped like the real one, written into the page by the fixture. */
export const TEST_USER = {
  email: 'ryan.lilker@gmail.com',
  uid: 'test-uid',
  emailVerified: true,
};

export const test = base.extend({
  /**
   * @param {object} opts
   * @param {boolean} opts.isAdmin  whether the signed-in user may edit settings
   * @param {boolean} opts.configExists  whether config/app_settings exists
   * @param {Array}  opts.decisions  documents returned from the decisions query
   * @param {Array}  opts.runs  documents returned from the runs query
   */
  dashboard: async ({ page, baseURL }, use, testInfo) => {
    await stubFirebase(page, testInfo.project.use.__dashboardOpts ?? {});
    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await use(page);
  },
});

    /**
 * Intercept the Firebase SDK and Google sign-in on a page.
 *
 * Exported so a test can drive a page with different settings - a non-admin
 * account, a config document that exists - without going through the fixture.
 */
export async function stubFirebase(page, opts = {}) {
  // Before any navigation: an uncaught error during boot() leaves the page
  // un-started, and signedIn() reports the real message instead of a timeout.
  page.on('pageerror', (e) => {
    page.__bootError = page.__bootError ?? e.message;
  });

  const state = {
    user: {
      email: opts.email ?? TEST_USER.email,
      uid: 'test-uid',
      emailVerified: true,
    },
    isAdmin: opts.isAdmin ?? true,
    configExists: opts.configExists ?? false,
    config: opts.config ?? {},
    decisions: opts.decisions ?? [],
    runs: opts.runs ?? [],
    /** Everything the page wrote, so a test can assert on it. */
    writes: [],
    // The page reads auth.currentUser in several places (the test-notification
    // button checks it before queuing). A bare {} made those paths see null and
    // report "Sign in first" on a page that was plainly signed in.
    auth: { currentUser: null },
    // Most tests want a signed-in page. The few that check the signed-out view
    // (the Google button, the hidden panels) set this, because a stub that
    // signed in immediately made those pages render their signed-in state.
    neverSignedIn: opts.neverSignedIn ?? false,
    // Lets a test dictate what the Pi's answer to a test-notification request
    // looks like, without installing a second route for the same URL.
    testMessageResult: opts.testMessageResult ?? null,
  };
  if (!state.neverSignedIn) state.auth.currentUser = state.user;

  // --- Google Identity Services -----------------------------------------
    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
          window.google = { accounts: { id: {
            initialize() {},
            renderButton(el) {
              el.innerHTML = '<div id="fake-google-btn" style="width:100%">Sign in</div>';
            },
          } } };
        `,
      }));

    // --- Firebase ESM bundles ---------------------------------------------
    // One handler serves all four bundles; each exports what the page imports
    // from it. Anything missing here becomes a TypeError inside boot() and the
    // page stops before sign-in - which reads as "sign-in is broken" rather
    // than "the stub is incomplete".
    await page.route('https://www.gstatic.com/firebasejs/**', (route) => {
      const body = `
        const state = window.__fbTestState;
        const noop = () => {};
        export const getApps = () => [];
        export const initializeApp = (config) => ({ config, name: 'test' });

        export function onAuthStateChanged(auth, cb) {
          state.onAuth = cb;
          // Firebase fires with null first, then the user. Reproducing that
          // order matters: the bug this catches was an ordering bug.
          cb(null);
          if (state.neverSignedIn) return;
          queueMicrotask(() => cb(state.user));
        }
        export const GoogleAuthProvider = function () {};
        GoogleAuthProvider.credential = () => ({ idToken: 'stub' });
        export function getAuth(app) { return state.auth; }
        export async function signInWithCredential(auth, cred) { return state.user; }
        export const connectAuthEmulator = noop;

        export function doc(db, path) {
          const parts = path.split('/');
          return { __path: parts, id: parts[parts.length - 1] };
        }
        export function collection(db, name) { return { __collection: name }; }
        // getFirestore is called during boot(), before onAuthStateChanged is
        // registered. Omitting it threw a TypeError inside boot() and the page
        // silently stopped before it ever got to auth - which looked exactly
        // like "the sign-in does nothing".
        export function getFirestore(app) { return { __db: app }; }
        export function getMessaging(app) { return { __messaging: app }; }
        export function getApp() { return {}; }
        export function connectFirestoreEmulator() {}
        export function query(c, ...clauses) { return { __c: c, __clauses: clauses }; }
        export function orderBy(field) { return { __orderBy: field }; }
        export function limit(n) { return { __limit: n }; }
        export function where() { return {}; }

        // getDoc is where the test-notification outcome comes back, so a test that
        // needs a specific answer sets state.testMessageResult rather than
        // installing a second route: two routes for the same URL resolve in
        // registration order, and whichever wins silently breaks boot().
        export async function getDoc(ref) {
          if (ref.__path?.[0] === 'test_messages'
              && state.testMessageResult) {
            return {
              exists: () => true,
              data: () => state.testMessageResult,
            };
          }
          if (ref.__path && ref.__path[0] === 'config') {
            return { exists: () => state.configExists, data: () => state.config };
          }
          return { exists: () => false, data: () => ({}) };
        }

        export async function getDocs(q) {
          const name = q.__c && q.__c.__collection;
          const rows = name === 'runs' ? state.runs : state.decisions;
          return {
            docs: rows.map((data, i) => ({ id: data.id ?? String(i), data: () => data })),
          };
        }

        export async function setDoc(ref, data) {
          state.writes.push({ path: ref.__path, data });
        }
        export async function getToken() { return 'stub-fcm-token'; }
        export function isSupported() { return true; }
        export function onMessage() {}
      `;
      route.fulfill({ contentType: 'text/javascript', body });
    });

    // Seed the state the stub reads. It is a single object shared by reference,
    // so `state.writes` is populated inside the page and visible from here.
    await page.addInitScript((s) => {
      window.__fbTestState = s;
    }, state);
  }

/** Wait until the page has finished booting (auth callback has fired). */
export async function signedIn(page, email = TEST_USER.email) {
  // A boot() that threw leaves the page permanently un-started, and the symptom
  // is this timeout naming the wrong problem. Surface the real error instead.
  const crashed = await page.evaluate(() => window.__bootError ?? null);
  if (crashed) {
    throw new Error(
      `the page failed to start: ${crashed}\n`
      + 'A stubbed module is probably missing an export that boot() calls.',
    );
  }
  await page.waitForFunction(
    (e) => document.getElementById('signed-in')?.hidden === false
      && document.getElementById('user-email')?.textContent === e,
    email,
  );
}

/**
 * Record any uncaught error so signedIn() can name it.
 *
 * Without this a broken stub shows up as an opaque 30s timeout, which sent me
 * looking at the wrong layer twice.
 */
export async function captureBootErrors(page) {
  page.on('pageerror', (e) => {
    page.__bootError = page.__bootError ?? e.message;
  });
}

/** Everything the page has written to Firestore, for assertions. */
export async function writes(page) {
  return page.evaluate(() => window.__fbTestState?.writes ?? []);
}

export { expect };