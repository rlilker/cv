/**
 * Validates the YAML files in the repo (CloudFormation template + Actions
 * workflows) and sanity-checks the template's internal references.
 *
 * CloudFormation is only fully validated by AWS itself, so this catches the
 * mistakes that are cheap to make by hand — malformed YAML, a Condition that
 * does not exist, an Output pointing at a resource that was never declared.
 *
 * Run with:  node scripts/validate-infra.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

/**
 * CloudFormation short-form intrinsics (!Ref, !Sub, !If, ...) are YAML tags that
 * a plain parser rejects. Give each one a scalar type so they survive parsing as
 * their own string, e.g. `!Sub '${DomainName}'` -> the string `!Sub ${DomainName}`.
 * AWS remains the only thing that can fully validate the tag semantics.
 */
const CLOUDFORMATION_TAGS = [
  'Ref', 'Sub', 'If', 'Not', 'Equals', 'And', 'Or', 'Select', 'Split', 'Join',
  'GetAtt', 'FindInMap', 'ImportValue', 'Base64', 'GetAZs', 'Condition',
];

const CF_CUSTOM_TAGS = CLOUDFORMATION_TAGS.map((t) => ({
  tag: `!${t}`,
  resolve: (s) => `!${t} ${s}`,
}));

const parseYaml = (text) => parse(text, { customTags: CF_CUSTOM_TAGS });

// ── 1. Every YAML file parses ───────────────────────────────────────────────

const yamlFiles = [
  'infra/cloudformation.yml',
  ...(existsSync(resolve(root, '.github/workflows'))
    ? readdirSync(resolve(root, '.github/workflows'))
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => join('.github/workflows', f))
    : []),
];

console.log('\n--- YAML parses ---');
const parsed = {};
for (const rel of yamlFiles) {
  try {
    parsed[rel] = parseYaml(readFileSync(resolve(root, rel), 'utf8'));
    check(rel, true);
  } catch (e) {
    check(rel, false, e.message.split('\n')[0]);
  }
}

// ── 2. CloudFormation structure ─────────────────────────────────────────────

const tplRel = 'infra/cloudformation.yml';
if (parsed[tplRel]) {
  const tpl = parsed[tplRel];
  console.log('\n--- CloudFormation template ---');

  check('AWSTemplateFormatVersion present', !!tpl.AWSTemplateFormatVersion);
  check('Resources declared', !!tpl.Resources && Object.keys(tpl.Resources).length > 0, `${Object.keys(tpl.Resources || {}).length} resources`);

  const resourceNames = new Set(Object.keys(tpl.Resources ?? {}));
  const conditions = new Set(Object.keys(tpl.Conditions ?? {}));
  const parameterNames = new Set(Object.keys(tpl.Parameters ?? {}));

  for (const [name, res] of Object.entries(tpl.Resources ?? {})) {
    check(`resource ${name} has a Type`, typeof res.Type === 'string' && res.Type.startsWith('AWS::'), res.Type);
  }

  const walk = (node, visit) => {
    if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
    else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => {
      visit(k, v);
      walk(v, visit);
    });
  };

  // Every Condition: reference must resolve to a declared condition.
  for (const [, value] of (() => {
    const acc = [];
    walk(tpl.Resources, (k, v) => {
      if (k === 'Condition' && typeof v === 'string') acc.push([k, v]);
    });
    return acc;
  })()) {
    check(`Condition "${value}" is declared`, conditions.has(value));
  }

  // Every !Ref should resolve to a Parameter, Resource, or pseudo-parameter.
  const resolvable = new Set([
    ...parameterNames,
    ...resourceNames,
    'AWS::Region',
    'AWS::AccountId',
    'AWS::Partition',
    'AWS::StackName',
    'AWS::NoValue',
  ]);
  for (const ref of new Set(
    (() => {
      const acc = [];
      walk(tpl, (_k, v) => {
        if (typeof v === 'string' && v.startsWith('!Ref ')) acc.push(v.slice(5).trim());
      });
      return acc;
    })(),
  )) {
    check(`!Ref ${ref} resolves`, resolvable.has(ref));
  }

  // Security-critical settings.
  const bucket = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::S3::Bucket');
  const pab = bucket?.Properties?.PublicAccessBlockConfiguration ?? {};
  check('S3 blocks all public access', Object.values(pab).length === 4 && Object.values(pab).every((v) => v === true), JSON.stringify(pab));
  check('S3 encrypted at rest', !!bucket?.Properties?.BucketEncryption);
  check('S3 bucket retained on stack delete', bucket?.DeletionPolicy === 'Retain', bucket?.DeletionPolicy);

  const dist = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::CloudFront::Distribution');
  const cacheBehaviour = dist?.Properties?.DistributionConfig?.DefaultCacheBehavior;
  check('CloudFront redirects to HTTPS', cacheBehaviour?.ViewerProtocolPolicy === 'redirect-to-https', cacheBehaviour?.ViewerProtocolPolicy);
  check('CloudFront uses OAC', !!dist?.Properties?.DistributionConfig?.Origins?.[0]?.OriginAccessControlId);
  check('CloudFront uses an ACM cert', !!dist?.Properties?.DistributionConfig?.ViewerCertificate?.AcmCertificateArn);
  check('CloudFront has error fallbacks', (dist?.Properties?.DistributionConfig?.CustomErrorResponses ?? []).length > 0);

  const role = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::IAM::Role');
  const trust = JSON.stringify(role?.Properties?.AssumeRolePolicyDocument ?? {});
  check('deploy role trusts GitHub OIDC', trust.includes('token.actions.githubusercontent.com'));
  check('deploy role is branch-scoped', trust.includes(':ref:refs/heads/'), 'sub pinned to a branch ref');
  check('deploy role session is <= 1h', (role?.Properties?.MaxSessionDuration ?? 0) <= 3600);

  const policy = JSON.stringify(role?.Properties?.Policies ?? []);
  check('deploy role can invalidate CloudFront', policy.includes('cloudfront:CreateInvalidation'));
  check('deploy role can delete stale objects', policy.includes('s3:DeleteObject'), 'needed for --delete');
}

// ── 3. GitHub Actions workflow ───────────────────────────────────────────────

for (const [rel, doc] of Object.entries(parsed)) {
  if (!rel.startsWith('.github/')) continue;
  console.log(`\n--- ${rel} ---`);
  // YAML 1.1 parses the bare key `on` as the boolean true; js-yaml follows
  // that rule, so accept either key.
  const triggers = doc.on ?? doc[true];
  const asText = JSON.stringify(doc);
  check('has a trigger', !!triggers);
  check('triggers on main', JSON.stringify(triggers ?? {}).includes('main'));
  check('requests an OIDC token', doc.permissions?.['id-token'] === 'write');
  check('uses OIDC, not static keys', asText.includes('configure-aws-credentials') && !asText.includes('AWS_ACCESS_KEY_ID'));
  check('has a concurrency guard', !!doc.concurrency);
  check('runs the build verifier', asText.includes('npm run verify'));
}

console.log(`\n${failures === 0 ? 'ALL INFRA CHECKS PASSED' : `${failures} INFRA CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);


  for (const [name, out] of Object.entries(tpl.Outputs ?? {})) {
    check(`output ${name} has a Value`, out.Value !== undefined);
  }
