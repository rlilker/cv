# AGENTS.md — ryanlilker.com (CV site)

This document summarises how the site is built so an agent can work on it without reverse-engineering from scratch.

## 1. Project identity

- **What it is:** Ryan Lilker's personal CV / one-page portfolio.
- **Stack:** [Astro](https://astro.build/) v5 (`.astro` components), static output only.
- **Deploy target:** S3 bucket + CloudFront (static files only; no serverless functions).
- **Canonical URL:** `https://ryanlilker.com` (set in `astro.config.mjs`).
- **Node:** `>=20.11.0` (see `package.json` engines).
- **Package manager:** npm (lockfile committed).

## 2. Directory layout

```
ryanlilker.com/
├── AGENTS.md                 # this file
├── astro.config.mjs          # Astro config (static, build.format 'file', trailingSlash 'never')
├── package.json              # scripts + deps
├── package-lock.json
├── .nvmrc
├── tsconfig.json
├── dist/                     # built output
├── public/                   # static assets copied verbatim to dist/
├── src/
│   ├── data/
│   │   ├── cv.json           # SINGLE SOURCE OF TRUTH for the CV content
│   │   ├── cv.ts             # TS types + re-exports of cv.json (nothing else touches cv.json)
│   │   ├── version.json
│   │   ├── family-assistant.json
│   │   ├── privacypolicy.md
│   │   └── tandcs.md
│   ├── components/
│   │   ├── Experience.astro   # experience timeline (recent roles + collapsible prior roles)
│   │   ├── Skills.astro       # skill-group cards
│   │   ├── SkillsSummary.astro# skills-summary section (bullets)
│   │   ├── Intro.astro        # hero + intro copy + social buttons
│   │   ├── Interests.astro    # interests pills
│   │   ├── Nav.astro          # sticky top nav + mobile menu + scroll spy
│   │   ├── SectionTitle.astro # section heading (+ optional meta)
│   │   ├── Separator.astro    # section divider
│   │   └── Footer.astro
│   ├── layouts/
│   │   ├── BaseLayout.astro   # <html> shell: fonts, meta, OG, JSON-LD, skip link
│   │   └── LegalLayout.astro  # shell for privacy/terms pages
│   ├── pages/
│   │   ├── index.astro        # CV homepage (composes Intro, Experience, Projects, SkillsSummary, Skills, Interests)
│   │   └── family-assistant/  # Family Assistant project sub-site (index, privacy, terms, dashboard)
│   ├── scripts/
│   │   └── nav.ts             # nav scroll-spy / mobile menu behaviour
│   └── styles/
│       └── global.css         # design tokens + reset + prose
├── scripts/                   # build-time / CI verification scripts (Node, ESM)
│   ├── verify-build.mjs       # post-build HTML assertions (run via `npm run verify`)
│   ├── validate-infra.mjs
│   ├── selftest-infra.mjs
│   ├── test-dashboard.mjs
│   ├── check-workflow-shell.mjs
│   ├── bump-version.mjs
│   └── outline-page.mjs
├── tests/
│   └── e2e/                   # Playwright tests
├── infra/
│   └── cloudformation.yml     # AWS infrastructure (S3 + CloudFront)
└── .github/                   # CI workflows
```

## 3. Key scripts (`package.json`)

| Script | Command | Purpose |
|---|---|---|
| `dev` / `start` | `astro dev` | local dev server |
| `build` | `astro build` | static build to `dist/` |
| `verify` | `node scripts/verify-build.mjs` | post-build HTML content assertions (run **after** `build`) |
| `validate:infra` | `node scripts/validate-infra.mjs` | infra validation |
| `selftest:infra` | `node scripts/selftest-infra.mjs` | infra self-test |
| `check:shell` | `node scripts/check-workflow-shell.mjs` | shell-script hygiene |
| `check` | `astro check` | type-check (prompts to install `@astrojs/check` if missing) |
| `test:dashboard` | `node scripts/test-dashboard.mjs` | dashboard checks |
| `build:e2e` | `node tests/e2e/build.mjs` | e2e build prep |
| `test:e2e` | `playwright test` | e2e Playwright tests |
| `test` | `build && verify && validate:infra && selftest:infra && check:shell && test:dashboard` | full validation chain |
| `preview` | `astro preview` | preview built output locally |

The CI/`test` chain is: `build → verify → validate:infra → selftest:infra → check:shell → test:dashboard`. `verify-build.mjs` is the most important one for content changes — it asserts the rendered HTML actually contains the CV data (not just that the build succeeded).

## 4. Content model — how to edit the CV

`src/data/cv.json` is the **single source of truth**. `src/data/cv.ts` imports it, adds TypeScript types, and re-exports typed constants. Components import from `cv.ts`, never from `cv.json` directly.

Shape of `cv.json`:

```json
{
  "profile": { name, firstName, role, location, timezone, linkedin, github, yearsExperience, intro: [string] },
  "roles": [ { id, title, company, type?, start, end, summary, highlights: [string], stack: [string] } ],
  "skillGroups": [ { id, title, items: [string] } ],
  "skillsSummary": [string],          // bullets for the Skills Summary section
  "interests": [string],
  "navSections": [ { id, label } ]    // drives Nav links (auto-rendered)
}
```

### Editing rules

1. **Change copy in `cv.json` only.** Do not hard-code CV text in components.
2. **Adding a new section?** Add its id/label to `navSections` so Nav renders a link, create a component (see pattern below), and import/render it in `src/pages/index.astro`.
3. **Role highlights** render as bullets; `stack` as pill tags. Prior roles (`slice(3)`) live inside a collapsible `<details>`; recent roles (`slice(0,3)`) are expanded.
4. **No email or telephone on the CV.** Contact is via LinkedIn and GitHub only (enforced by `verify-build.mjs`).
5. **UK English** (`lang="en-GB"`). Use en-dashes (`–`) and curly quotes where appropriate.

## 5. Component conventions

- **SectionTitle:** `<SectionTitle title="..." meta="..." />` — renders a muted 40px heading with an optional meta line on the right. Wraps on mobile.
- **Scoped styles:** Each `.astro` component carries its own `<style>` block; no global CSS classes are shared except design tokens from `global.css` and utility-ish classes (`.section`, `.skill-card`, `.tag`, etc.).
- **Design tokens:** Always use CSS variables from `src/styles/global.css` (`--bg`, `--surface`, `--ink`, `--ink-soft`, `--accent`, `--hairline`, `--radius-pill`, `--radius-card`, `--measure`, `--dur`, `--ease`, etc.) rather than hard-coded colours/spacing.
- **HTML-in-style guard:** `verify-build.mjs` fails if any HTML-like tag appears inside a `<style>` block. Keep style blocks CSS-only.
- **Components are islands-free:** No client-side JS in components unless needed (nav behaviour lives in `src/scripts/nav.ts`).

## 6. Build config gotchas (do not change lightly)

`astro.config.mjs`:
- `output: 'static'`
- `build.format: 'file'` — emits `family-assistant.html`, not `family-assistant/index.html`. Required so `/family-assistant` maps to a real S3 object key.
- `trailingSlash: 'never'` — canonical URLs have no trailing slash.
- `compressHTML: true`

`BaseLayout.astro` strips `.html` from `Astro.url.pathname` when building canonical/og URLs for the same reason.

## 7. Verification for content changes

After editing `cv.json` or any component:

```sh
npm run build        # static build
npm run verify       # assert rendered HTML contains the CV data
```

`verify-build.mjs` checks, among other things:
- Profile name/role/location/links render
- Every role (company + title + start date) renders
- Every skill group card renders
- Every interest pill renders
- No direct contact details (mailto/tel/phone/email) on the CV
- No broken internal links; every `href="/x"` maps to a built `dist/x.html`
- UTF-8 (`£`, `–`) intact; no mojibake
- Nav present on every page; scroll-spy targets work

If you add a new section id, also confirm `href="/#<id>"` appears in the nav on every page (verify checks this for existing section ids).

## 8. Adding a new section — quick recipe

1. Add the data to `cv.json` (new top-level array or extend an existing one).
2. Export it in `cv.ts` (`export const <name> = data.<name>;`).
3. Create `src/components/<Name>.astro` following the `SkillsSummary.astro` / `Interests.astro` pattern:
   ```astro
   ---
   import { <data> } from '../data/cv';
   import SectionTitle from './SectionTitle.astro';
   ---
   <section class="section <id>" id="<id>">
     <SectionTitle title="..." meta="..." />
     <!-- markup -->
   </section>
   <style>…use CSS variables…</style>
   ```
4. Add `{ id: '<id>', label: '...' }` to `navSections` in `cv.json`.
5. Import and render `<Name />` in `src/pages/index.astro` with separators around it.
6. Run `npm run build && npm run verify`.

## 9. Other notes

- **Fonts:** Self-hosted `Roboto Flex Variable` via `@fontsource-variable/roboto-flex` (imported in `BaseLayout.astro`). No Google Fonts CDN (enforced by verify).
- **JSON-LD:** `Person` schema in `BaseLayout.astro` — keep `sameAs` (LinkedIn/GitHub) in sync with `cv.json`.
- **Print styles:** `global.css` has a `@media print` block that hides nav/skip-link/arrows and avoids page-breaks inside roles/cards.
- **Reduced motion:** Respected via `prefers-reduced-motion`.
- **E2E:** Playwright tests live under `tests/e2e/`; `playwright.config.mjs` at repo root. They are not part of the `npm test` chain (separate `test:e2e` script).
