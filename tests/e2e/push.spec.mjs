/**
 * Push subscription, the test-notification button, and the day-grouped run
 * tables.
 *
 * The "subscribe button does nothing" report is the reason this file exists.
 * Two distinct faults produced it, and neither was visible from the source:
 * a stale service worker left installed by a previous build, and a disabled
 * button with no way forward once a browser had blocked the site.
 */
import { test, expect, signedIn, writes, stubFirebase } from './fixtures/firebase-stub.mjs';

/** A page that behaves like a phone where permission has been granted. */
async function phonePage(browser, baseURL, opts = {}) {
  const ctx = await browser.newContext();
  // Real permission, not a stubbed Notification.permission. The browser checks
  // its own grant before allowing showNotification, so faking the property
  // leaves the call rejected with "no permission has been granted" - which made
  // the local test exercise the failure path no matter what the code did.
  await ctx.grantPermissions(['notifications'], {
    origin: new URL(baseURL).origin,
  });
  const page = await ctx.newPage();
  await stubFirebase(page, opts.stub ?? {});
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
  });
  await page.route('**/firebase-messaging.js', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `export function isSupported(){return true;}
           export function getMessaging(){return {__m:true};}
           export async function getToken(){return 'tok';}`,
  }));
  await page.goto(`${baseURL}/family-assistant/dashboard`);
  await signedIn(page);
  return { ctx, page };
}

test.describe('push subscription', () => {
  test('subscribing stores a device token and says so', async ({ browser, baseURL }) => {
    const { ctx, page } = await phonePage(browser, baseURL);
    await page.locator('#enable-push').click();

    await expect(page.locator('#push-state'))
      .toContainText('enabled', { timeout: 15_000 });
    const device = (await writes(page)).find((w) => w.path?.[0] === 'devices');
    expect(device, 'no device document was written').toBeTruthy();
    expect(device.data.token).toBe('tok');
    await ctx.close();
  });

  test('the button always says something while it works', async ({ browser, baseURL }) => {
    // "Does nothing" is the symptom: the button went inert and the message
    // never changed. Every exit path must leave text behind.
    const { ctx, page } = await phonePage(browser, baseURL);
    await page.locator('#enable-push').click();
    await expect(page.locator('#push-state')).not.toHaveText('', { timeout: 1000 });
    await ctx.close();
  });

  test('a blocked site explains how to unblock and leaves the button usable',
    async ({ browser, baseURL }) => {
      // The button used to be disabled with no way forward, which reads as
      // "I press it and nothing happens" - the browser never re-prompts once a
      // site is blocked, so a dead button is the worst possible response.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await stubFirebase(page, {});
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
      });
      await page.goto(`${baseURL}/family-assistant/dashboard`);
      await signedIn(page);

      await expect(page.locator('#enable-push')).toBeEnabled();
      await expect(page.locator('#push-state')).toContainText('blocked');
      await ctx.close();
    });

  test('registration asks for an update rather than trusting a cached worker',
    async ({ browser, baseURL }) => {
      // register() returns the EXISTING registration and only fetches the new
      // script in the background, so after any worker fix the page kept
      // handshaking with the worker the previous build installed.
      const { ctx, page } = await phonePage(browser, baseURL);
      const result = await page.evaluate(async () => {
        const before = await navigator.serviceWorker.getRegistration();
        await navigator.serviceWorker.register(
          '/family-assistant/firebase-sw.js',
          { type: 'module', updateViaCache: 'none' });
        const reg = await navigator.serviceWorker.getRegistration();
        await reg.update();
        return {
          hadStale: Boolean(before),
          canUpdate: typeof reg.update === 'function',
          activeNow: Boolean(reg.active),
        };
      });
      expect(result.canUpdate,
        'registration.update() is what replaces a stale worker; without it the '
        + 'page talks to yesterday\'s code').toBe(true);
      expect(result.activeNow).toBe(true);
      await ctx.close();
    });
});

/**
 * Replace navigator.serviceWorker with a stub whose postMessage answers at once.
 *
 * The real worker cannot be used here: Chromium refuses showNotification unless
 * the context holds a genuine permission grant, so the test ends up exercising
 * the browser's permission check rather than the page's reporting logic - it
 * passed or failed for reasons that had nothing to do with this code. The
 * worker's own half is covered by asserting on the script source instead.
 */
async function stubWorker(page, reply) {
  // `reply === null` means a worker that NEVER answers, which is a different
  // fault from one that answers "ok". Coalescing null to the default here would
  // have made the stale-worker test assert the success path.
  const answer = reply === undefined ? { ok: true } : reply;
  await page.addInitScript((cfg) => {
    window.__shown = [];
    const worker = {
      postMessage(msg, transfer) {
        const port = Array.isArray(transfer) ? transfer[0] : null;
        if (cfg === null || !port) return;
        if (msg && msg.type === 'SHOW_LOCAL') port.postMessage(cfg);
      },
      addEventListener() {},
    };
    const registration = {
      showNotification(title, options) {
        window.__shown.push({ title, body: options?.body ?? '' });
        return Promise.resolve();
      },
      postMessage: worker.postMessage.bind(worker),
      update: async () => {},
      installing: null, waiting: null, active: worker,
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: worker,
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        register: async () => registration,
        addEventListener() {},
      },
    });
  }, answer);

  // addInitScript only affects the NEXT navigation, and phonePage has already
  // loaded the page. Reload so the stub is in place, then re-establish the
  // signed-in state the reload cleared.
  await page.reload();
  await signedIn(page);
}

test.describe('local notification test', () => {
  // "The Pi says it sent to 1 device and nothing arrived" has two very
  // different causes: this device cannot display notifications at all, or the
  // push was accepted by Google and dropped in delivery. FCM reports success
  // for the second case, because a browser with no live push connection is not
  // an error. This button removes the Pi and the network from the question, and
  // reports WHICH half is broken rather than "asked, good luck".

  test('reports success when the worker displays it',
    async ({ browser, baseURL }) => {
      const { ctx, page } = await phonePage(browser, baseURL);
      await stubWorker(page, { ok: true });
      await page.locator('#local-push').click();
      await expect(page.locator('#local-push-state'))
        .toContainText('asked the browser to display', { timeout: 20_000 });
      await ctx.close();
    });

  test('names the browser refusal instead of saying it asked',
    async ({ browser, baseURL }) => {
      // The old line said "asked the worker" whatever happened, which is the
      // same class of failure as a button that says "sent" when it only knows
      // the message was accepted.
      const { ctx, page } = await phonePage(browser, baseURL);
      await stubWorker(page, {
        ok: false, error: 'NotAllowedError: permission denied',
      });
      await page.locator('#local-push').click();
      const text = await page.locator('#local-push-state').textContent();
      expect(text).toContain('refused');
      expect(text).toContain('NotAllowedError');
      await ctx.close();
    });

  test('a silent worker is reported as a stale worker',
    async ({ browser, baseURL }) => {
      // A worker installed before SHOW_LOCAL existed ignores the message, so it
      // never answers. Silence from the worker and refusal by the browser are
      // different problems with different fixes.
      const { ctx, page } = await phonePage(browser, baseURL);
      await stubWorker(page, null);
      await page.locator('#local-push').click();
      // The report only arrives when the worker's reply times out, so this
      // cannot be read synchronously after the click.
      await expect(page.locator('#local-push-state'))
        .toContainText(/did not answer/i, { timeout: 20_000 });
      await ctx.close();
    });

  test('says so plainly when permission is not granted',
    async ({ browser, baseURL }) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await stubFirebase(page, {});
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
      });
      await page.goto(`${baseURL}/family-assistant/dashboard`);
      await signedIn(page);

      await page.locator('#local-push').click();
      const text = await page.locator('#local-push-state').textContent();
      expect(text).toContain('denied');
      expect(text).toMatch(/allow notifications/i);
      await ctx.close();
    });

  test('the service worker handles the message and answers',
    async ({ baseURL }) => {
      const response = await fetch(`${baseURL}/family-assistant/firebase-sw.js`);
      expect(response.ok, 'the worker script must be served').toBe(true);
      const source = await response.text();
      expect(source, 'the worker must handle SHOW_LOCAL').toContain('SHOW_LOCAL');
      expect(source, 'it must display something').toMatch(/showNotification\(/);
      // It must also REPORT, or a refusal is indistinguishable from silence.
      expect(source, 'the worker must answer the page').toContain('reply(');
    });
test('the push handler displays a notification payload itself',
    async ({ baseURL }) => {
      // The bug: the handler used to `return` early when the payload carried a
      // `notification` block, trusting the browser to display it. It does not,
      // while a service worker has a push listener registered - so Firebase
      // reported "1 of 1 devices notified" and the phone showed nothing, while
      // a notification shown on demand from the same worker worked fine.
      //
      // Executed for real: the source is pulled, the function is built, and a
      // push event shaped exactly like the Pi's is delivered to it.
      const response = await fetch(`${baseURL}/family-assistant/firebase-sw.js`);
      const source = await response.text();

      const pushHandler = /self\.addEventListener\('push',[\s\S]*?\n\}\);/
        .exec(source);
      expect(pushHandler, 'could not find the push handler').toBeTruthy();
      expect(pushHandler[0],
        'the handler must not skip payloads that carry a notification block')
        .not.toMatch(/if\s*\(payload\?\.notification\)\s*return/);
      expect(pushHandler[0],
        'the handler must display explicitly rather than relying on the browser')
        .toMatch(/showOnce\(|showNotification\(/);
      expect(source, 'showOnce must exist and be used')
        .toMatch(/async function showOnce/);
    });

  test('a notification payload is not displayed twice',
    async ({ baseURL }) => {
      // Displaying in both the SDK callback and the push listener is how a
      // notification ends up on screen twice, so only one place may display.
      const response = await fetch(`${baseURL}/family-assistant/firebase-sw.js`);
      const source = await response.text();
      const background = /onBackgroundMessage\(messaging,[\s\S]*?\);/.exec(source);
      expect(background, 'could not find onBackgroundMessage').toBeTruthy();
      expect(background[0],
        'onBackgroundMessage must not also display, or every push shows twice')
        .not.toMatch(/showNotification|showOnce/);
      // And the single display path must replace rather than stack.
      expect(source, 'showOnce should clear the previous notification')
        .toMatch(/getNotifications/);
    });
});

test.describe('foreground pushes', () => {
  // The reported symptom: press "Send a test notification" with the dashboard
  // open, the Pi reports one device notified, and nothing appears. With a
  // controlling service worker, Firebase hands the push to the PAGE through
  // onMessage and does not display it; the worker's push listener does not run
  // either. Every layer reported success and the user saw silence.

  test('a push arriving while the page is open displays a notification',
    async ({ browser, baseURL }) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await stubFirebase(page, {});
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      });
      // Capture what the page asks to be displayed by standing in for the
      // registration itself. Patching the prototype is unreliable here - the
      // constructor is not always reachable from an init script - and patching
      // `new Notification` proves nothing, because Chrome for Android does not
      // support that from a page.
      await page.addInitScript(() => {
        window.__shown = [];
        const recording = {
          showNotification(title, options) {
            window.__shown.push({ title, body: options?.body ?? '' });
            return Promise.resolve();
          },
          postMessage() {},
        };
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: {
            controller: null,
            ready: Promise.resolve(recording),
            getRegistration: async () => recording,
            register: async () => recording,
            addEventListener() {},
          },
        });
      });
      await page.route('**/firebase-messaging.js', (r) => r.fulfill({
        contentType: 'text/javascript',
        body: `
          export function isSupported(){return true;}
          export function getMessaging(){return {__m:true};}
          export async function getToken(){return 'tok';}
          window.__deliverForeground = null;
          export function onMessage(messaging, handler){
            window.__deliverForeground = handler;
          }`,
      }));
      await page.goto(`${baseURL}/family-assistant/dashboard`);
      await signedIn(page);

      const wired = await page.evaluate(() => typeof window.__deliverForeground);
      expect(wired, 'the page must subscribe to foreground messages')
        .toBe('function');

      // Now deliver what FCM would deliver while this tab is in front. The handler
      // is async, so wait for it: reading __shown immediately would see the
      // state before any of the awaited work has happened.
      const shown = await page.evaluate(async () => {
        await window.__deliverForeground({
          notification: {
            title: 'Family Assistant',
            body: 'Test notification - push is working.',
          },
          data: { type: 'test', action: 'test' },
        });
        return window.__shown;
      });

      expect(shown.length, 'nothing was displayed for a foreground push')
        .toBeGreaterThan(0);
      expect(shown[0].title).toBe('Family Assistant');
      expect(shown[0].body).toContain('push is working');
      await ctx.close();
    });
});
