/**
 * Family Assistant service worker.
 *
 * Uses the *modular* Firebase Messaging SDK. The compat script
 * (firebase-messaging-compat.js) is incompatible with getToken(), which is what
 * the dashboard calls to subscribe - mixing the two fails silently at subscribe
 * time, which is the worst possible failure for this file: the button appears to
 * work and no notification ever arrives.
 *
 * `onMessage` does NOT exist in this module. firebase-messaging-sw.js exports
 * only getMessaging, isSupported, onBackgroundMessage and an experimental
 * helper. Importing onMessage here was a hard SyntaxError at module-evaluation
 * time, so the browser rejected registration with "ServiceWorker script
 * evaluation failed" and subscriptions could never be created. In a service
 * worker the correct API is onBackgroundMessage, or the plain `push` listener
 * at the bottom of this file.
 *
 * Scope: served from /family-assistant/ so its scope covers the dashboard page
 * without needing a Service-Worker-Allowed header.
 *
 * Config handshake: this file lives in public/ and is copied verbatim, so it
 * cannot have build-time values baked into it. The page registers the worker,
 * posts the Firebase config and VAPID key with an INIT message, and waits for an
 * INIT_OK reply before calling getToken(). That ordering matters - getToken()
 * fails if messaging was never initialised in the worker.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getMessaging, onBackgroundMessage } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-sw.js';

let messaging = null;

/** Idempotent: the page may re-send INIT after a worker update. */
function initMessaging(config) {
  if (messaging || !config || !config.apiKey) return messaging;
  try {
    messaging = getMessaging(initializeApp(config));
    attachBackgroundHandler();
  } catch (e) {
    // A worker that throws on load never registers, and the page's getToken()
    // then fails with a confusing error. Fail soft instead.
    console.error('[family-assistant] Firebase messaging init failed:', e);
  }
  return messaging;
}

function attachBackgroundHandler() {
  // onBackgroundMessage only fires for DATA messages while no client controls
  // the worker. It deliberately does NOT display anything: the push listener
  // below already displays every push, and displaying in both places is how a
  // notification ends up on screen twice.
  //
  // Keeping the registration is still useful - it is what makes the SDK install
  // its own push plumbing - so this only ever records that it happened.
  onBackgroundMessage(messaging, () => {});
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  // A notification with no network and no Pi behind it. FCM answering "sent"
  // only means Google accepted the message; it says nothing about whether the
  // browser displayed it. This proves the device half on its own, so a missing
  // push can be pinned on the device or on delivery rather than guessed at.
  //
  // The reply is the whole point. Without it a stale worker (which does not know
  // this message type) and a browser that refuses to display are indistinguishable
  // from the page: both look like silence. The ack distinguishes "the worker
  // never answered" from "showNotification rejected", which are different bugs
  // in different places.
  if (msg?.type === 'SHOW_LOCAL') {
    const port = event.ports && event.ports[0];
    const reply = (payload) => { if (port) port.postMessage(payload); };
    event.waitUntil(
      Promise.resolve(showNotification(
        msg.title || 'Family Assistant',
        {
          body: msg.body || 'Local test - this device can show notifications.',
          tag: 'family-assistant-local',
          data: { url: '/family-assistant/dashboard' },
        },
      )).then(
        () => reply({ ok: true }),
        (err) => reply({
          ok: false,
          error: (err && err.name ? err.name + ': ' : '') + String(err && err.message || err),
        }),
      ),
    );
    return;
  }
  if (msg?.type !== 'INIT') return;
  const ready = Boolean(initMessaging(msg.config));
  if (msg.config && msg.vapidKey) {
    self.__VAPID_KEY__ = msg.vapidKey;
  }
  // Reply on the MessageChannel port the page transferred, NOT on
  // event.source.
  //
  // The page sends worker.postMessage(msg, [port2]) and listens on port1.
  // event.source is only set when the message came from a Client (a page
  // calling controller.postMessage); for a message delivered through a
  // transferred port it is null. Replying there put the acknowledgement on
  // nobody, the page's 5s timer fired, and every subscription attempt ended in
  // "The notification service worker did not start".
  const port = event.ports && event.ports[0];
  if (port) port.postMessage({ type: 'INIT_OK', ok: ready });
  else if (event.source) event.source.postMessage({ type: 'INIT_OK', ok: ready });
});

/**
 * Show a notification. Everything is passed to the platform as plain strings
 * rather than into innerHTML, so an email subject cannot inject markup.
 */
function showNotification(title, options = {}) {
  return self.registration.showNotification(title || 'Family Assistant', {
    body: options.body || '',
    icon: '/family-assistant/icon-192.png',
    badge: '/family-assistant/icon-192.png',
    tag: options.tag || 'family-assistant',
    renotify: true,
    data: options.data || {},
    vibrate: [120, 60, 120],
  });
}

/**
 * Display one notification, replacing any earlier one with the same tag.
 *
 * Closing what is already there is what keeps this safe to run unconditionally:
 * a second push replaces the first instead of stacking, and if anything else
 * already displayed this payload under the same tag it is collapsed into one
 * rather than shown twice.
 */
async function showOnce(title, body, data) {
  const tag = 'family-assistant';
  try {
    const existing = await self.registration.getNotifications({ tag });
    for (const stale of existing) stale.close();
  } catch {
    // getNotifications is unavailable in some browsers; the tag alone still
    // replaces, it just cannot clear a stale entry first.
  }
  return showNotification(title, { body, data: data || {}, tag });
}

/**
 * Background pushes.
 *
 * This handler used to `return` early when the payload carried a `notification`
 * block, on the assumption that the browser displays those itself. It does not,
 * not while a service worker has a `push` listener registered: the payload is
 * handed to this function and nothing else puts it on screen. That assumption
 * is why Firebase could report "1 of 1 devices notified" and the phone showed
 * nothing, while a notification displayed from the same worker on demand worked
 * perfectly.
 *
 * So every push is displayed here, explicitly. Nothing is left to the browser's
 * implicit behaviour.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  // A push with no JSON body at all still deserves to say something.
  const notification = payload?.notification ?? {};
  const data = payload?.data ?? {};
  const title = notification.title || data.title || 'Family Assistant';
  const body = notification.body || data.body
    || 'The family calendar has been updated.';
  event.waitUntil(showOnce(title, body, data));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || '/family-assistant/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing tab rather than piling up new ones.
        for (const client of clients) {
          if ('focus' in client && client.url.includes('/family-assistant')) {
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});