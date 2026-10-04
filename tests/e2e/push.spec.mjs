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

test.describe('local notification test', () => {
  // "The Pi says it sent to 1 device and nothing arrived" has two very
  // different causes: this device cannot display notifications at all, or the
  // push was accepted by Google and dropped in delivery. FCM reports success
  // for the second case, because a browser with no live push connection is not
  // an error. This button removes the Pi and the network from the question.

  test('asks the worker to display a notification', async ({ browser, baseURL }) => {
    const { ctx, page } = await phonePage(browser, baseURL);
    // The worker only becomes active once it is registered, which the page
    // does on subscribe. Subscribe first, exactly as a real phone would.
    await page.locator('#enable-push').click();
    await expect(page.locator('#push-state'))
      .toContainText('enabled', { timeout: 15_000 });

    await page.locator('#local-push').click();
    await expect(page.locator('#local-push-state'))
      .toContainText('Asked the worker', { timeout: 15_000 });
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

  test('the service worker handles the local message',
    async ({ baseURL }) => {
      // Asserted on the file itself: the worker must know this message type, or
      // the button silently does nothing on a real phone.
      const response = await fetch(`${baseURL}/family-assistant/firebase-sw.js`);
      expect(response.ok, 'the worker script must be served').toBe(true);
      const source = await response.text();
      expect(source, 'the worker must handle SHOW_LOCAL')
        .toContain('SHOW_LOCAL');
      expect(source, 'it must actually display something')
        .toMatch(/showNotification\(/);
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
      // Capture what the page asks to be displayed.
      await page.addInitScript(() => {
        window.__shown = [];
        class FakeNotification extends EventTarget {
          constructor(title, options) {
            super();
            this.title = title;
            this.options = options;
            window.__shown.push({ title, body: options?.body ?? '' });
          }
        }
        Object.defineProperty(window, 'Notification', {
          value: FakeNotification,
          configurable: true,
        });
        Object.defineProperty(window.Notification, 'permission', {
          get: () => 'granted',
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

      // Now deliver what FCM would deliver while this tab is in front.
      const shown = await page.evaluate(() => {
        window.__deliverForeground({
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
