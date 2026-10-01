/**
 * Family Assistant service worker.
 *
 * Uses the *modular* Firebase Messaging SDK. The compat script
 * (firebase-messaging-compat.js) is incompatible with getToken(), which is what
 * the dashboard calls to subscribe - mixing the two fails silently at subscribe
 * time, which is the worst possible failure for this file: the button appears to
 * work and no notification ever arrives.
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
import { getMessaging, onMessage } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-sw.js';

let messaging = null;

/** Idempotent: the page may re-send INIT after a worker update. */
function initMessaging(config) {
  if (messaging || !config || !config.apiKey) return messaging;
  try {
    messaging = getMessaging(initializeApp(config));
    attachForegroundHandler();
  } catch (e) {
    // A worker that throws on load never registers, and the page's getToken()
    // then fails with a confusing error. Fail soft instead.
    console.error('[family-assistant] Firebase messaging init failed:', e);
  }
  return messaging;
}

function attachForegroundHandler() {
  onMessage(messaging, (payload) => {
    const n = payload?.notification ?? {};
    showNotification(n.title ?? 'Family Assistant', {
      body: n.body ?? '',
      data: payload?.data ?? {},
    });
  });
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type !== 'INIT') return;
  const ready = Boolean(initMessaging(msg.config));
  // Reply on the source port so the page can await the handshake.
  event.source?.postMessage({ type: 'INIT_OK', ok: ready });
  if (msg.config && msg.vapidKey) {
    self.__VAPID_KEY__ = msg.vapidKey;
  }
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

// Background pushes. When the payload carries a `notification` block the browser
// displays it itself; handling it here as well would show it twice.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (payload?.notification) return;
  showNotification(payload.title, { body: payload.body, data: payload.data });
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