/**
 * The three defects that reached production, in a real browser.
 *
 * Each of these passed the unit suite. That is the whole reason this file
 * exists: a regex over the source cannot tell you whether a field is editable,
 * only that some code mentions `readOnly`.
 */
import { test, expect, signedIn, writes, stubFirebase } from './fixtures/firebase-stub.mjs';

const CONFIG_FIELDS = ['#llm-prompt', '#whitelist', '#blacklist-domains',
  '#blacklist', '#push-template'];

test.describe('settings form', () => {
  test('an admin can actually type into every field', async ({ dashboard: page }) => {
    await signedIn(page);

    // Typing is the assertion. A readOnly attribute check passed before,
    // because readOnly was set once at boot and never cleared: the user saw a
    // focusable, focus-styled field that swallowed every keystroke.
    for (const sel of CONFIG_FIELDS) {
      const field = page.locator(sel);
      await expect(field, `${sel} should not be readonly for an admin`)
        .not.toHaveAttribute('readonly', /.*/);
      await expect(field, `${sel} should not be disabled`).toBeEnabled();
    }

    await page.locator('#llm-prompt').fill('a prompt typed by a test');
    await expect(page.locator('#llm-prompt'))
      .toHaveValue('a prompt typed by a test');

    await page.locator('#blacklist-domains').fill('amazon.co.uk, audible.com');
    await expect(page.locator('#blacklist-domains'))
      .toHaveValue('amazon.co.uk, audible.com');
  });

  test('readOnly is cleared when an admin signs in', async ({ dashboard: page }) => {
    await signedIn(page);
    // The regression in one assertion: onSignedOut() runs first with a null
    // user and sets readOnly; nothing ever set it back to false.
    for (const sel of CONFIG_FIELDS) {
      const ro = await page.locator(sel).evaluate((el) => el.readOnly);
      expect(ro, `${sel} is still readonly after sign-in`).toBe(false);
    }
  });

  test('a non-admin gets read-only fields and an explanation', async ({ browser, baseURL }) => {
    // Driven through its own page rather than the fixture so isAdmin can be
    // false. The security rules are authoritative; this only checks the page
    // does not pretend a non-parent can edit.
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubFirebase(page, { isAdmin: false, email: 'abigail.lilker@gmail.com' });
    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await signedIn(page, 'abigail.lilker@gmail.com');

    await expect(page.locator('#config-readonly')).toBeVisible();
    for (const sel of CONFIG_FIELDS) {
      const ro = await page.locator(sel).evaluate((el) => el.readOnly);
      expect(ro, `${sel} should be read-only for a non-admin`).toBe(true);
    }
    await context.close();
  });
});

test.describe('service worker', () => {
  test('registers without an evaluation error', async ({ dashboard: page }) => {
    // The reported failure: "ServiceWorker script evaluation failed". Caused by
    // registering an ESM worker (top-level `import`) as a classic one.
    const result = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { skipped: true };
      try {
        const reg = await navigator.serviceWorker.register(
          '/family-assistant/firebase-sw.js',
          { type: 'module' },
        );
        await navigator.serviceWorker.ready;
        return { ok: true, scope: reg.scope };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    });

    if (!result.skipped) {
      expect(result.ok, `registration failed: ${result.message}`).toBe(true);
    }
  });

  test('the served worker really is a module', async ({ page, request }) => {
    // Guards the test above from passing vacuously: if the worker were rewritten
    // with importScripts(), requiring type:'module' would become wrong.
    const res = await request.get('/family-assistant/firebase-sw.js');
    expect(res.ok()).toBe(true);
    expect(await res.text()).toMatch(/^\s*import\s/m);
  });
});

test.describe('sign-in', () => {
  test('the Google button renders', async ({ dashboard: page }) => {
    await expect(page.locator('#signin-slot iframe, #signin-slot div'))
      .toHaveCount(1, { timeout: 10_000 });
  });

  test('the panel is hidden until signed in', async ({ browser, baseURL }) => {
    // Uses a page with auth that never resolves, so the "signed out" state can
    // be observed deterministically. With the normal stub the auth callback
    // fires within a microtask, so asserting on the pre-sign-in state would be
    // a race that passes or fails on timing.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({
      contentType: 'text/javascript',
      body: `
        export const initializeApp = () => ({});
        export function getAuth() { return {}; }
        export function getFirestore() { return {}; }
        export function getMessaging() { return {}; }
        export function isSupported() { return false; }
        export function onAuthStateChanged() {}   // never fires
      `,
    }));
    await page.route('https://accounts.google.com/**', (r) => r.fulfill({
      contentType: 'text/javascript', body: 'window.google = { accounts: { id: {} } };',
    }));

    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await expect(page.locator('#signin-slot')).toBeVisible();
    await expect(page.locator('#config')).toBeHidden();
    await expect(page.locator('#history')).toBeHidden();
    await expect(page.locator('#decisions')).toBeHidden();
    await expect(page.locator('#push')).toBeHidden();
    await context.close();
  });
});

test.describe('settings round trip', () => {
  test('an absent config document shows the service defaults', async ({ dashboard: page }) => {
    await signedIn(page);
    // config/app_settings does not exist until somebody saves, so this is the
    // state the dashboard has always been in. Blank boxes read as broken.
    await expect(page.locator('#llm-prompt')).not.toHaveValue('');
    await expect(page.locator('#push-template'))
      .toHaveValue('{summary} on {date} at {time}');
  });

  test('saving writes the disallowed domains too', async ({ dashboard: page }) => {
    await signedIn(page);
    await page.locator('#blacklist-domains').fill('amazon.co.uk');
    await page.locator('#save-config').click();

    const written = await writes(page);
    const configWrite = written.find((w) => w.path?.[0] === 'config');
    expect(configWrite, 'nothing was written to config').toBeTruthy();
    expect(configWrite.data.blacklist_domains).toEqual(['amazon.co.uk']);
  });
});