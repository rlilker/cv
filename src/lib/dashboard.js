/**
 * Pure logic for the Family Assistant dashboard.
 *
 * Deliberately free of Firebase imports so it can be unit-tested in Node. The
 * Astro page wires this to Firestore; this file decides what gets sent, how a
 * run is rendered, and what is a valid config.
 *
 * Kept in step with src/firestore_config.py in the family-planner repo — the Pi
 * and the dashboard must agree on rendering and on the shape of the config
 * document.
 */

/** Firestore reads are bounded. Unbounded would be a billing and privacy issue. */
export const RUNS_QUERY_LIMIT = 15;

export const DEFAULT_PUSH_TEMPLATE = '{summary} on {date} at {time}';

/**
 * Mirrors DEFAULT_LLM_PROMPT in src/firestore_config.py.
 *
 * Shown in the dashboard when config/app_settings does not exist yet, so the
 * form shows what the Pi is actually running instead of four empty boxes.
 * Keep the two in step: the Pi reads this at 05:00 with nobody watching.
 */
export const DEFAULT_LLM_PROMPT =
  'You extract calendar events from emails. Today is {date}. '
  + 'Return strict JSON only.';

/**
 * Firestore document id for a device token: a SHA-256 hex digest.
 *
 * Hashing is a privacy control. Reading the devices collection must not hand
 * over working push credentials for the family's phones, so the token itself
 * never appears in a document id, even though the token is stored in the
 * document body for the Pi to use.
 *
 * Async because it uses the Web Crypto API, which is the one crypto primitive
 * available both in the browser and in Node 20+ with no import shim.
 *
 * An empty token yields an empty id rather than the digest of "", which would
 * collide across every malformed subscribe.
 */
export async function deviceDocumentId(token) {
  if (!token || typeof token !== 'string') return '';
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Substitute {placeholders} in a push template.
 *
 * An unknown or missing placeholder is left intact rather than blanked: "Dentist
 * at ." reads as a bug in the notification, "{time}" reads as a template.
 */
export function renderPushTemplate(template, values = {}, fallback = '{summary}') {
  let out = (typeof template === 'string' && template.trim()) ? template : fallback;
  for (const [key, value] of Object.entries(values || {})) {
    const placeholder = `{${key}}`;
    const rendered = value === null || value === undefined || value === ''
      ? placeholder
      : escapeHtml(String(value));
    out = out.split(placeholder).join(rendered);
  }
  return out;
}

/** Escape text destined for innerHTML. Email subjects are attacker-influenced. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse a comma-separated tag list into normalised entries.
 *
 * Blank entries are dropped rather than kept, matching the Pi's behaviour in
 * firestore_config._as_list — a stray trailing comma must not become a filter
 * that matches nothing.
 */
export function parseTagList(input) {
  if (typeof input !== 'string') return [];
  return input
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/** Inverse of parseTagList, for populating the form. */
export function formatTagList(list) {
  if (!Array.isArray(list)) return '';
  return list.filter(Boolean).join(', ');
}

/**
 * Aggregate a run history for the status strip.
 *
 * Tolerant by design: documents are written by a background service and a
 * malformed metric must render as 0, never as NaN across the whole summary.
 */
export function summariseRuns(runs) {
  const summary = {
    total: 0, success: 0, warn: 0, error: 0,
    emailsScanned: 0, eventsCreated: 0, unknown: 0,
  };
  if (!Array.isArray(runs)) return summary;

  for (const run of runs) {
    summary.total += 1;
    const status = String(run?.status ?? '').toUpperCase();
    if (status === 'SUCCESS') summary.success += 1;
    else if (status === 'WARN') summary.warn += 1;
    else if (status === 'ERROR') summary.error += 1;
    else summary.unknown += 1;

    summary.emailsScanned += toCount(run?.emails_scanned);
    summary.eventsCreated += toCount(run?.events_created);
  }
  return summary;
}

/** Coerce a Firestore number to a finite non-negative integer. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "20260930_210507" -> "30 Sep 2026, 21:05". Unparseable ids pass through. */
export function formatRunId(runId) {
  if (typeof runId !== 'string' || !/^\d{8}_\d{6}$/.test(runId)) {
    return typeof runId === 'string' ? runId : '';
  }
  const [date, time] = runId.split('_');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = Number(date.slice(6, 8));
  const month = months[Number(date.slice(4, 6)) - 1] ?? '';
  return `${day} ${month} ${date.slice(0, 4)}, `
       + `${time.slice(0, 2)}:${time.slice(2, 4)}`;
}

/**
 * Newest run first.
 *
 * Run ids are YYYYMMDD_HHMMSS, which sorts correctly as a string. Non-mutation
 * matters: this feeds a reactive list, and sorting in place would re-order the
 * Firestore snapshot cache underneath it.
 */
export function sortRunsNewestFirst(runs) {
  if (!Array.isArray(runs)) return [];
  return [...runs].sort((a, b) => {
    const x = String(a?.run_id ?? '');
    const y = String(b?.run_id ?? '');
    return y.localeCompare(x);
  });
}

/**
 * Validate a config document before writing it.
 *
 * The Pi reads this document at 05:00, unattended. A blank prompt saved by
 * accident would leave it with nothing to work from, and the failure would not
 * surface until the next morning, so the save is gated here instead.
 *
 * Returns an array of human-readable problems; empty means valid.
 */
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return ['No configuration loaded.'];
  }

  const prompt = config.llm_prompt_template;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    errors.push('The extraction prompt cannot be empty.');
  }

  for (const [field, list] of [
    ['whitelist_domains', config.whitelist_domains],
    ['blacklist_domains', config.blacklist_domains],
    ['blacklist_keywords', config.blacklist_keywords],
  ]) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      errors.push(`${field} must be a list.`);
      continue;
    }
    // Keywords are free text; only the two domain lists are domain-shaped.
    if (field === 'blacklist_keywords') continue;
    for (const entry of list) {
      if (!isDomainLike(entry)) {
        errors.push(`"${entry}" is not a valid domain.`);
      }
    }
  }

  return errors;
}

/** Accepts plain and subdomains; rejects anything with spaces or a scheme. */
function isDomainLike(entry) {
  if (typeof entry !== 'string') return false;
  const value = entry.trim();
  if (!value) return false;
  const pattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  return pattern.test(value);
}