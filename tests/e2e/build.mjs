/**
 * Builds the site with placeholder Firebase values for the browser tests.
 *
 * Without PUBLIC_FIREBASE_* set, the dashboard renders "Not configured yet"
 * and returns before it ever boots, so the e2e suite would exercise an
 * early-return page and pass while proving nothing.
 *
 * The values are deliberately fake and obviously so. The tests intercept the
 * Firebase SDK at the network layer, so nothing here is ever contacted: these
 * exist only so the page takes its normal code path.
 *
 * Real values come from the environment in CI (see .github/workflows/check.yml)
 * and never from this file.
 */
import { spawnSync } from 'node:child_process';

const PLACEHOLDERS = {
  PUBLIC_FIREBASE_API_KEY: 'AIzaE2E-placeholder-not-a-real-key',
  PUBLIC_FIREBASE_AUTH_DOMAIN: 'family-planner-509915.firebaseapp.com',
  PUBLIC_FIREBASE_PROJECT_ID: 'family-planner-509915',
  PUBLIC_FIREBASE_STORAGE_BUCKET: 'family-planner-509915.appspot.com',
  PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:e2e0000000000000',
  PUBLIC_FIREBASE_VAPID_KEY: 'BEl0e2E-placeholder-vapid-key-value000',
  PUBLIC_GOOGLE_CLIENT_ID: '000000000000-e2eplaceholder.apps.googleusercontent.com',
};

const env = { ...process.env };
for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  // A real value from the environment always wins over the placeholder.
  if (!env[key]) env[key] = value;
}

const result = spawnSync('npx', ['astro', 'build'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);