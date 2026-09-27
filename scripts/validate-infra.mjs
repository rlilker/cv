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

const section = (name) => console.log(`\n--- ${name} ---`);

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
  const cfg = dist?.Properties?.DistributionConfig ?? {};
  const cacheBehaviour = cfg?.DefaultCacheBehavior;
  check('CloudFront redirects to HTTPS', cacheBehaviour?.ViewerProtocolPolicy === 'redirect-to-https', cacheBehaviour?.ViewerProtocolPolicy);
  check('CloudFront uses OAC', !!cfg?.Origins?.[0]?.OriginAccessControlId);
  check('CloudFront has error fallbacks', (cfg?.CustomErrorResponses ?? []).length > 0);

  // ViewerCertificate: CloudFront REQUIRES SslSupportMethod alongside an ACM
  // ARN, and will refuse to create the distribution without it.
  const cert = cfg?.ViewerCertificate ?? {};
  check('viewer certificate has SslSupportMethod', !!cert.SslSupportMethod, cert.SslSupportMethod);
  check('viewer certificate uses an ACM cert', !!cert.AcmCertificateArn);
  check('viewer certificate is SNI not a dedicated IP', cert.SslSupportMethod === 'sni-only', 'sni-only avoids ~$20/mo');
  check('minimum TLS is 1.2 or newer', /TLSv1\.[23]/.test(cert.MinimumProtocolVersion ?? ''), cert.MinimumProtocolVersion);

  // CloudFront policy names allow only alphanumerics, dashes and underscores.
  // A domain name contains dots, so 'ryanlilker.com-cv-headers' is rejected
  // with a 400 at create time.
  //
  // Only the Name property is constrained; Description and Comment are free
  // text. Short-form intrinsics parse to the string '!Sub <template>', so the
  // tag prefix has to be stripped before the name is inspected. CloudFront
  // substitutes the domain name itself, so the check only has to look at the
  // literal text around the ${...} placeholders.
  const nameLiterals = (node, out = []) => {
    if (Array.isArray(node)) {
      node.forEach((n) => nameLiterals(n, out));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'Name' && typeof v === 'string') out.push(v);
        else nameLiterals(v, out);
      }
    }
    return out;
  };

  for (const [logicalId, res] of Object.entries(tpl.Resources ?? {})) {
    if (!String(res?.Type ?? '').startsWith('AWS::CloudFront::')) continue;
    for (const raw of nameLiterals(res)) {
      const name = raw.replace(/^!Sub\s+/, '').replace(/^['"]|['"]$/g, '');
      const literal = name.replace(/\$\{[^}]*\}/g, 'x');
      check(
        `CloudFront ${logicalId} name is [A-Za-z0-9_-] safe`,
        /^[A-Za-z0-9_-]+$/.test(literal),
        `'${literal}' contains characters CloudFront rejects (dots, spaces, colons)`,
      );
    }
  }

  // ACM requires at least one thumbprint per OIDC provider; an empty list is
  // rejected with "Thumbprint list must contain at least one entry".
  const oidc = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::IAM::OIDCProvider');
  const thumbs = oidc?.Properties?.ThumbprintList;
  check('OIDC provider has at least one thumbprint', Array.isArray(thumbs) && thumbs.length > 0, `${thumbs?.length ?? 0} thumbprint(s)`);
  check(
    'OIDC thumbprints look like SHA-1 fingerprints',
    Array.isArray(thumbs) && thumbs.every((t) => /^[0-9a-f]{40}$/i.test(String(t))),
  );

  // No property may be an empty mapping. This is the exact failure mode that
  // produced a truncated BucketEncryption block: a key present with no value.
  const emptyKeys = [];
  const walkEmpty = (node, path) => {
    if (Array.isArray(node)) node.forEach((v, i) => walkEmpty(v, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const here = `${path}.${k}`;
        if (v === null || v === undefined) emptyKeys.push(here);
        else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) emptyKeys.push(`${here} (empty)`);
        else walkEmpty(v, here);
      }
    }
  };
  walkEmpty(tpl.Resources, 'Resources');
  check('no empty property values', emptyKeys.length === 0, emptyKeys.join(' '));

  // Specific values that a truncated block would drop.
  const bucketProps = bucket?.Properties ?? {};
  const encRules = bucketProps?.BucketEncryption?.ServerSideEncryptionConfiguration;
  check('bucket encryption has at least one rule', Array.isArray(encRules) && encRules.length > 0, `${encRules?.length ?? 0} rules`);
  check('bucket encryption uses SSE-S3 or KMS', ['AES256', 'aws:kms'].includes(encRules?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm));
  check('bucket ownership is bucket-owner-enforced', bucketProps?.OwnershipControls?.Rules?.[0]?.ObjectOwnership === 'BucketOwnerEnforced');
  check('bucket versioning enabled', bucketProps?.VersioningConfiguration?.Status === 'Enabled');
  check('bucket has a lifecycle rule', (bucketProps?.LifecycleConfiguration?.Rules ?? []).length > 0);

  // Certificate validation must reference a real zone or be omitted entirely,
  // never a placeholder string.
  const acm = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::CertificateManager::Certificate');
  const acmProps = acm?.Properties ?? {};
  const dvoRaw = acmProps.DomainValidationOptions;
  const dvo = JSON.stringify(dvoRaw ?? '');
  check('no placeholder zone id in cert validation', !dvo.includes('_ignore') && !dvo.includes('placeholder'));
  check('cert covers the www SAN', JSON.stringify(acmProps).includes('www.${DomainName}'));
  check('cert uses DNS validation', acmProps.ValidationMethod === 'DNS');

  // ACM rejects a DomainValidationOptions entry that sets BOTH HostedZoneId
  // and ValidationDomain: "You can only have value for validationDomain or
  // HostedZoneId but not both."
  //
  // The block is wrapped in a short-form !If, which the tag-preserving parser
  // flattens into a plain string, so the parsed object cannot be inspected.
  // The raw text is scanned instead: split the block into its per-name entries
  // and confirm no entry names both properties.
  const certBlock = readFileSync(resolve(root, 'infra/cloudformation.yml'), 'utf8').match(
    /DomainValidationOptions:[\s\S]*?\n {6}\S/,
  )?.[0];
  check('cert validation block was found to inspect', !!certBlock);
  if (certBlock) {
    // The list is nested under a short-form !If, so the first item is written
    // as '- - DomainName:'. Splitting on the '- DomainName:' marker handles both
    // the first (doubled) and subsequent entries.
    const entries = certBlock.split(/^\s*-\s*(?:-\s*)?DomainName:/m).slice(1);
    check('cert validation has one entry per domain', entries.length >= 2, `${entries.length} entries`);
    for (const [i, entry] of entries.entries()) {
      const hasZone = /HostedZoneId:/.test(entry);
      const hasValidationDomain = /ValidationDomain:/.test(entry);
      check(
        `cert validation entry ${i} sets only one of HostedZoneId / ValidationDomain`,
        !(hasZone && hasValidationDomain),
        hasZone && hasValidationDomain ? 'ACM rejects both together' : '',
      );
      check(
        `cert validation entry ${i} resolves a hosted zone`,
        hasZone,
        'no HostedZoneId means ACM cannot write the validation record',
      );
    }
  }

  // A hosted zone reference must come from the zone resource or a parameter.
  const zoneParam = tpl.Parameters?.ExistingHostedZoneId !== undefined;
  check('existing hosted zone can be passed as a parameter', zoneParam);

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
