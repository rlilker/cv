# ryanlilker.com

Ryan Lilker's CV, as a static site, plus a page for the
[Family Planner](https://github.com/rlilker/family-planner) app. Built with
[Astro](https://astro.build), deployed to S3 + CloudFront by GitHub Actions.

Visual language adapted from the one-page CV at
[kshitijcodes.in](https://kshitijcodes.in) (spotlighted on
[One Page Love](https://onepagelove.com/kshitij-srivastava)) — glass "pill"
navigation, large muted section headings, thick white separators.

### Pages

| Route                       | Source                                   |
| --------------------------- | ---------------------------------------- |
| `/`                         | CV — `src/data/cv.json`                  |
| `/family-planner/`          | App overview — `src/data/family-planner.json` |
| `/family-planner/privacy/`  | Rendered from `src/data/privacypolicy.md` |
| `/family-planner/terms/`    | Rendered from `src/data/tandcs.md`       |

The two legal documents are imported as Astro Markdown components, so the
markdown files stay the single source of truth and are never duplicated into a
template.

---

## Contents

- [Why this stack](#why-this-stack)
- [Running it locally](#running-it-locally)
- [Editing the CV](#editing-the-cv)
- [One-time AWS setup](#one-time-aws-setup)
- [GitHub configuration](#github-configuration)
- [How deploying works](#how-deploying-works)
- [Going dynamic](#going-dynamic)
- [Project layout](#project-layout)
- [Cost](#cost)

---

## Why this stack

The brief was "as cheap as possible, but able to grow into a JAM stack later".
This is the answer:

| Layer        | Choice          | Why                                                                 |
| ------------ | --------------- | ------------------------------------------------------------------- |
| Framework    | **Astro**       | Builds to plain HTML/CSS/JS. No server, no runtime, no bill.          |
| Hosting      | **S3**          | ~$0.02/month for this site.                                          |
| CDN + HTTPS  | **CloudFront**  | Free tier is 1 TB egress/month. Free ACM certificate.                 |
| DNS          | **Route 53**    | $0.50/month hosted zone. The only unavoidable fixed cost.             |
| CI auth      | **OIDC**        | No AWS access keys stored in GitHub at all.                          |

Total fixed cost: **~$0.50/month**.

**Why not S3 website hosting on its own?** It is genuinely free, but it is
HTTP-only, has no CDN, and no custom-domain TLS. A CV is a document that gets
shared by email and LinkedIn, so HTTPS and edge caching are worth the extra
50p. The alternative — CloudFront without S3 — is not possible; S3 is the origin.

**Why Astro and not plain HTML?** The site is static either way, so hosting cost
is identical. Astro earns its place by giving the content a typed data contract
(see [Editing the CV](#editing-the-cv)) and by making the "go dynamic" step a
one-file change rather than a rewrite.

**Why is the S3 bucket private?** CloudFront reads it through an Origin Access
Control. There is no public bucket policy anywhere in the template, so the only
way to reach the content is through the distribution — which means TLS, the
security headers, and the cache rules are not bypassable.

---

## Running it locally

Requires Node 20+ (see `.nvmrc`).

```bash
npm install
npm run dev          # http://localhost:4321
```

Other commands:

```bash
npm run build        # build to dist/
npm run preview      # serve the built dist/ locally
npm run verify       # assert dist/ actually contains the CV data
npm run validate:infra   # lint the CloudFormation + workflow YAML
npm test             # build + verify + validate, what CI runs
```

### The two validation scripts

Astro will cheerfully report a successful build for a page that is missing half
its content — a malformed data file fails silently as "no roles found". Both
scripts exist to catch that class of mistake:

- `scripts/verify-build.mjs` reads the built HTML for all four pages and asserts
  every employer, date, bullet point, skill group, interest, app section and
  legal paragraph is actually present, plus per-page SEO tags, cross-page
  links, a single `<h1>` per page, and UTF-8 integrity. Around 90 checks.
- `scripts/validate-infra.mjs` parses `infra/cloudformation.yml` and the
  workflows, then checks every `!Ref` and `Condition:` resolves, and that the
  security-critical settings (public access block, HTTPS redirect, OAC, branch-
  scoped OIDC trust) are set.

Both run in CI and fail the deploy if they do not pass. `npm run outline`
prints a text outline of every built page, which is handy for reviewing
structure without opening a browser.

---

## Editing the CV

**All content lives in [`src/data/cv.json`](src/data/cv.json).** Nothing else
needs to change to update the site.

```jsonc
{
  "profile": { "name": "…", "email": "…", "intro": ["…", "…"] },
  "roles": [
    {
      "id": "cmap-software",      // anchor: /#cmap-software
      "title": "…",
      "company": "…",
      "type": "Contract",         // optional badge
      "start": "March 2010",
      "end": "July 2022",
      "summary": "one line, shown under the title",
      "highlights": ["…"],        // bullet points
      "stack": ["C#", "…"]         // pill tags
    }
  ],
  "skillGroups": [{ "id": "…", "title": "…", "items": ["…"] }],
  "highlights": [{ "value": "25", "suffix": "yrs", "label": "…" }],
  "interests": ["…"],
  "navSections": [{ "id": "experience", "label": "Experience" }]
}
```

Roles render in array order — put the current role first. The section heading
meta line (`12 roles · 1997 to present`) and the role count are derived
automatically.

`src/data/cv.ts` holds only the TypeScript types plus two small derivations
(`lastName`, `totalHighlights`).

### Changing the look

Every colour, radius, shadow and duration is a CSS custom property in
[`src/styles/global.css`](src/styles/global.css):

```css
:root {
  --bg: #f7f7f7;
  --accent: #5856d6;   /* the indigo from the reference */
  --ink-muted: rgba(0, 0, 0, 0.3);
  /* … */
}
```

Change `--accent` and the whole site re-tints. Per-component styles are scoped
inside each `.astro` file.

---


## One-time AWS setup

The whole environment is one CloudFormation stack:
[`infra/cloudformation.yml`](infra/cloudformation.yml). It creates the S3
bucket, CloudFront distribution, ACM certificate, the GitHub OIDC provider, and
a deploy role.

### 1. Deploy the stack

**Option A — console.** CloudFormation → Create stack → Upload template →
select the file → Next. Accept the defaults (`DomainName=ryanlilker.com`,
`GitHubOrg=rlilker`, `GitHubRepo=cv`, `CreateHostedZone=false`).

**Option B — CLI.**

```bash
aws cloudformation deploy \
  --template-file infra/cloudformation.yml \
  --stack-name cv-site \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides DomainName=ryanlilker.com GitHubOrg=rlilker GitHubRepo=cv
```

> **Region note.** CloudFront requires its ACM certificate in `us-east-1`. The
> `Certificate` resource must be created in `us-east-1`; if you deploy the rest
> of the stack elsewhere, either run the whole stack in `us-east-1` (the S3
> bucket and IAM role have no regional dependency) or create the certificate
> separately and pass the ARN in.

### 2. Choose your hosted-zone situation

`CreateHostedZone` defaults to `false` because in most cases the zone for
`ryanlilker.com` already exists.

- **Zone already exists (most likely).** Leave it `false`, then add two
  CloudFront alias records by hand in Route 53:

  | Name | Type | Target |
  | ---- | ---- | ------ |
  | `ryanlilker.com` | A | Alias → CloudFront distribution, *Evaluate target health* off |
  | `www.ryanlilker.com` | A | Alias → same distribution |

  Use the `CloudFrontDomain` / `DistributionId` stack outputs.

- **Zone does not exist.** Set `CreateHostedZone=true`. The stack creates the
  zone, but you still need to point your registrar's nameservers at the
  `NameServers` listed in the stack's hosted zone, and validate the ACM
  certificate via the DNS records it generates.

### 3. Validate the certificate

The certificate stays `PENDING_VALIDATION` until DNS resolves. After the records
exist, the stack moves it to `ISSUED` (usually within a few minutes). Until
then the site is still reachable on the `*.cloudfront.net` hostname, over HTTP.

---

## GitHub configuration

Two **secrets** and two **variables** on the repository
(Settings → Secrets and variables → Actions).

**Secrets**

| Name | Value |
| ---- | ----- |
| `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` stack output |
| `DISTRIBUTION_ID` | the `DistributionId` stack output |

**Variables**

| Name | Value |
| ---- | ----- |
| `AWS_REGION` | the region the bucket lives in, e.g. `eu-west-2` |
| `SITE_BUCKET` | the `BucketName` stack output, e.g. `ryanlilker.com-cv-site` |

Set them with `gh` if you prefer:

```bash
gh secret set AWS_DEPLOY_ROLE_ARN --body 'arn:aws:iam::123456789012:role/ryanlilker.com-cv-github-deploy'
gh secret set DISTRIBUTION_ID     --body 'E1ABCDEFGHIJK'
gh variable set AWS_REGION  --body 'eu-west-2'
gh variable set SITE_BUCKET --body 'ryanlilker.com-cv-site'
```


## How deploying works

```
git push main
      │
      ▼
┌─────────────────────────────────────────────┐
│ GitHub Actions  (.github/workflows/deploy)  │
│                                             │
│  1. checkout + npm ci                       │
│  2. npm run build      → dist/              │
│  3. npm run verify     → fail if content    │
│                          is missing         │
│  4. OIDC → assume the deploy role           │
│  5. aws s3 sync dist/ → bucket  (--delete)  │
│  6. cloudfront invalidation /*               │
└─────────────────────────────────────────────┘
      │
      ▼
https://ryanlilker.com/
```

Triggers on every push to `main`, and on manual `workflow_dispatch`.

**Cache headers** are set in two passes, and this is the part that is easy to
get wrong:

- `/_astro/*` → `max-age=31536000, immutable`. Astro fingerprints these
  filenames, so a changed file gets a changed URL. Safe to cache forever.
- everything else (HTML, manifest, robots.txt) → `max-age=0, must-revalidate`.
  Without this, an updated CV would keep serving the old copy for a year, which
  is the classic "I changed my site and nothing happened" bug.

**Invalidation** is `/*` rather than a list of files. Content-hashed assets do
not need purging — the URLs change when the bytes change — so this stays a
single cheap request.

**Concurrency:** a `cancel-in-progress` group means a rapid second push cancels
the first, so deployments cannot land out of order.

> **Heads-up on HTML freshness.** CloudFront's managed `CachingOptimized`
> policy applies a 24-hour default TTL, so the HTML can take that long to appear
> even after the invalidation completes. If you want edits visible immediately,
> lower `DefaultTTL` in the cache policy, or move the HTML onto a custom policy
> with a short TTL.


## Going dynamic

The content contract is deliberately the same shape an API would return.
`src/data/cv.json` is imported once, in `src/data/cv.ts`:

```ts
import data from './cv.json';
```

To move the content behind an endpoint, replace that one line:

```ts
const API = import.meta.env.PUBLIC_CV_API;
const data = await fetch(`${API}/cv`).then((r) => r.json());
```

Every component keeps working, because none of them know where the data came
from — they only import the typed exports. That covers both realistic scenarios:

**A. Content that changes without a deploy** (roles kept in a CMS, say). Call
the API at build time, as above — the site stays static and free.

**B. A real API** (contact form, availability status). Add a Lambda behind API
Gateway or a Function URL, then attach it to the *same* CloudFront
distribution as an extra origin with a path pattern, ordered above the S3 one:

```
/api/*  →  Lambda origin     (the API)
/*      →  S3 origin         (everything else: the static site)
```

No DNS change, no second distribution, no migration. S3 keeps serving the static
files, so the bill stays effectively the same — a Lambda invoked a few hundred
times a month rounds to zero. A load balancer is not needed and would cost more
than the entire rest of the stack.

On SSR: if you ever need per-request rendering, flip `output: 'static'` to
`'hybrid'` in `astro.config.mjs` and add an adapter. That is a bigger change
than it looks, because it introduces a server to run and pay for — for a CV,
build-time fetching gets you the same result for free.

---

## Project layout

```
.
├── src/
│   ├── data/
│   │   ├── cv.json          ← all CV content; edit this
│   │   └── cv.ts            ← types + derived values
│   ├── components/
│   │   ├── Intro.astro      hero, stats, contact buttons
│   │   ├── Experience.astro timeline of roles
│   │   ├── Skills.astro     grouped skill cards
│   │   ├── Interests.astro  interests + closing CTA
│   │   ├── Nav.astro        sticky glass pill nav
│   │   ├── Footer.astro     local clock + back to top
│   │   ├── SectionTitle.astro
│   │   └── Separator.astro
│   ├── layouts/BaseLayout.astro   <head>, meta, JSON-LD
│   ├── pages/index.astro
│   ├── scripts/nav.ts       scroll-spy (client only)
│   └── styles/global.css    design tokens
├── public/                   favicon, robots.txt, manifest
├── infra/cloudformation.yml S3 + CloudFront + ACM + OIDC
├── .github/workflows/deploy.yml
└── scripts/
    ├── verify-build.mjs
    └── validate-infra.mjs
```

### Performance notes

- No framework JavaScript ships. The only client JS is the scroll-spy and the
  footer clock, both small enough for Astro to inline.
- The font is self-hosted via `@fontsource-variable/roboto-flex` — no Google
  Fonts request, so no third-party request and no visitor data leaving the UK.
- The three unused font subsets (Cyrillic, Greek, Vietnamese, ~50 KB) upload to
  S3 but are never downloaded: each `@font-face` is gated by `unicode-range`.
- HTML and CSS are minified at build time.
- `prefers-reduced-motion` is respected throughout.
- A skip link, a single `<h1>`, and `aria-hidden` on every decorative icon.

---

## Cost

| Item           | Monthly   | Notes                          |
| -------------- | --------- | ------------------------------ |
| Route 53 zone  | ~$0.50    | the only unavoidable fixed cost |
| S3             | <$0.01    | a few hundred KB, mostly static |
| CloudFront     | $0.00     | 1 TB egress free tier           |
| ACM            | $0.00     | free, auto-renews               |
| GitHub Actions | $0.00     | free for public repos           |
| **Total**      | **~$0.50**|                                 |

At a realistic 50–200 page views a month this will not register on a billing
alert.

---

## Licence

See [LICENSE](LICENSE).

### Rollback

```bash
# List recent versions
aws s3api list-object-versions --bucket "$SITE_BUCKET" --prefix index.html

# Re-publish an older index.html, then purge
aws s3 cp index.html "s3://$SITE_BUCKET/index.html" \
  --cache-control "public,max-age=0,must-revalidate"
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" --paths "/*"
```

The bucket has versioning enabled and retains non-current versions for 30 days,
so there is always something to roll back to.

---

**No AWS access keys are needed.** The workflow calls
`sts:AssumeRoleWithWebIdentity` with a short-lived GitHub OIDC token, and the
role's trust policy pins `sub` to `repo:rlilker/cv:ref:refs/heads/main` — so a
job on any other branch, or a pull request from a fork, cannot deploy.

There is also a `production` GitHub Environment referenced by the workflow. It
is optional, but it is the place to put any future approval gate.

---
