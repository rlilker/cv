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

  // A CloudFront alias record must point at CloudFront's own hosted zone,
  // Z2FDTNDATAQYW2. That is a fixed constant, not a GetAtt attribute of the
  // distribution, and using the Route 53 zone id here silently breaks the alias.
  const aliasZone = 'Z2FDTNDATAQYW2';
  for (const res of Object.values(tpl.Resources ?? {})) {
    if (res?.Type !== 'AWS::Route53::RecordSet') continue;
    const target = res.Properties?.AliasTarget;
    if (!target) continue;
    check(
      `Route53 ${res.Properties.Name} alias uses CloudFront's hosted zone`,
      target.HostedZoneId === aliasZone,
      `expected ${aliasZone}, found ${JSON.stringify(target.HostedZoneId)}`,
    );
  }

  // Every !GetAtt must name an attribute the resource type actually publishes.
  // CloudFormation only reports a bad one at create time:
  //   "Requested attribute Arn does not exist in schema for
  //    AWS::CertificateManager::Certificate"
  // which is how a !GetAtt Certificate.Arn rolled back this stack. The ARN is
  // what Ref returns, not a GetAtt attribute, and the real attribute names are
  // CertificateArn / CertificateStatus.
  //
  // Only the types this template actually uses are listed; an unlisted type is
  // reported rather than skipped, so the list cannot silently go stale.
  const GETATT_ATTRS = {
    'AWS::CertificateManager::Certificate': ['CertificateArn', 'CertificateStatus'],
    'AWS::CloudFront::Distribution': ['DistributionDomainName', 'DomainName', 'Id'],
    'AWS::CloudFront::OriginAccessControl': ['Id'],
    'AWS::CloudFront::ResponseHeadersPolicy': ['Id'],
    'AWS::CloudFront::Function': ['FunctionARN', 'FunctionMetadata'],
    'AWS::S3::Bucket': [
      'Arn', 'DomainName', 'DualStackDomainName', 'RegionalDomainName',
      'WebsiteURL', 'ObjectLockEnabled', 'AccelerateEndpoint',
    ],
    'AWS::Route53::HostedZone': ['Id', 'Name'],
    'AWS::IAM::Role': ['Arn', 'RoleId', 'UniqueId'],
  };

  // Note: the tag-preserving parser turns a short-form intrinsic into a string
  // VALUE, e.g. `!GetAtt SiteBucket.Arn` becomes the string "!GetAtt ...". So
  // these are found by inspecting values, not keys. The long form
  // (Fn::GetAtt) keeps the key.
  const getatt = [];
  walk(tpl, (k, v) => {
    if (typeof v !== 'string') return;
    if (k === 'Fn::GetAtt') getatt.push(v);
    else if (v.startsWith('!GetAtt ')) getatt.push(v.slice('!GetAtt '.length).trim());
  });

  for (const raw of new Set(getatt)) {
    // The normal form is "LogicalId.Attribute" - exactly two segments. A longer
    // path such as "Function.FunctionMetadata.FunctionArn" is a mistake, and
    // checking only the head would accept it because the head is real. Two
    // segments are validated against the documented attribute list; anything
    // deeper is rejected outright.
    const parts = raw.split('.').map((s) => s.trim());
    const logicalId = parts[0];
    const res = tpl.Resources?.[logicalId];
    if (!res) {
      check(`!GetAtt ${raw} targets a declared resource`, false, `no resource '${logicalId}'`);
      continue;
    }
    const allowed = GETATT_ATTRS[res.Type];
    if (!allowed) {
      check(`!GetAtt attribute list known for ${res.Type}`, false, 'add it to GETATT_ATTRS in validate-infra.mjs');
      continue;
    }
    const type = res.Type.split('::').pop();
    if (parts.length > 2) {
      check(
        `!GetAtt ${raw} is a valid ${type} reference`,
        false,
        `expected "LogicalId.Attribute"; ${type} publishes ${allowed.join(', ')}`,
      );
      continue;
    }
    check(
      `!GetAtt ${raw} is a real ${type} attribute`,
      allowed.includes(parts[1]),
      `allowed: ${allowed.join(', ')}`,
    );
  }

  // Security-critical settings.
  const bucket = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::S3::Bucket');
  const pab = bucket?.Properties?.PublicAccessBlockConfiguration ?? {};
  check('S3 blocks all public access', Object.values(pab).length === 4 && Object.values(pab).every((v) => v === true), JSON.stringify(pab));
  check('S3 encrypted at rest', !!bucket?.Properties?.BucketEncryption);
  // A failed create must leave nothing behind. A retained bucket survives a
  // rollback, and the next deploy then dies on an early ResourceExistenceCheck
  // that reports only "hook validation failed" with no resource named. The
  // contents are build output and are reproducible from git, so retaining the
  // bucket protects nothing and costs a confusing manual cleanup.
  check(
    'S3 bucket is not retained on stack delete',
    bucket?.DeletionPolicy !== 'Retain',
    bucket?.DeletionPolicy,
  );
  check(
    'S3 bucket is still retained on replacement',
    bucket?.UpdateReplacePolicy === 'Retain',
    bucket?.UpdateReplacePolicy,
  );

  const dist = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::CloudFront::Distribution');

  // An Origin Access Control grants nothing by itself. Without a bucket policy
  // that trusts this specific distribution, S3 answers every origin fetch with
  // AccessDenied and CloudFront returns 403 for every route.
  const bucketPolicy = Object.values(tpl.Resources ?? {}).find((r) => r.Type === 'AWS::S3::BucketPolicy');
  check('bucket policy exists for the origin access control', !!bucketPolicy);
  const policyDoc = JSON.stringify(bucketPolicy?.Properties?.PolicyDocument ?? {});
  check('bucket policy allows CloudFront to read objects', policyDoc.includes('cloudfront.amazonaws.com'));
  check('bucket policy is read-only', policyDoc.includes('s3:GetObject') && !policyDoc.includes('s3:PutObject') && !policyDoc.includes('s3:DeleteObject'));
  check('bucket policy is scoped to the distribution', policyDoc.includes('AWS:SourceArn'), 'unscoped grants every distribution in every account');
  // The scope must name this distribution specifically, not a wildcard.
  check(
    'bucket policy scope is not a wildcard',
    policyDoc.includes('distribution/*') === false,
    'a wildcard would let any distribution in the account read the bucket',
  );
  check(
    'bucket policy targets this stack\'s bucket',
    (bucketPolicy?.Properties?.Bucket ?? '').includes('!Ref SiteBucket'),
    bucketPolicy?.Properties?.Bucket,
  );
  const cfg = dist?.Properties?.DistributionConfig ?? {};
  const cacheBehaviour = cfg?.DefaultCacheBehavior;
  check('CloudFront redirects to HTTPS', cacheBehaviour?.ViewerProtocolPolicy === 'redirect-to-https', cacheBehaviour?.ViewerProtocolPolicy);
  check('CloudFront uses OAC', !!cfg?.Origins?.[0]?.OriginAccessControlId);
  // CloudFront does not resolve directory indexes against an S3 origin: "/" and
  // "/family-planner" reach S3 as keys that do not exist and come back 403. The
  // viewer-request function maps extensionless URLs onto the emitted .html
  // file. Without it every page except the explicit .html URL 403s.
  const cfFunction = Object.values(tpl.Resources ?? {}).find(
    (r) => r.Type === 'AWS::CloudFront::Function',
  );
  check('a CloudFront function resolves extensionless paths', !!cfFunction);
  const fnCode = cfFunction?.Properties?.FunctionCode ?? '';
  check(
    'the path function appends .html',
    fnCode.includes(".html"),
    'an extensionless URL would 403 against the S3 origin',
  );
  check(
    'the path function leaves real assets alone',
    /\\\.\\\[a-zA-Z0-9\]/.test(fnCode) || fnCode.includes('[a-zA-Z0-9]+$'),
    'without an extension test, /favicon.svg would be rewritten to favicon.svg.html',
  );
  check(
    'the path function is attached to the default cache behaviour',
    JSON.stringify(cacheBehaviour?.FunctionAssociations ?? []).includes('viewer-request'),
  );
  check(
    'the function is auto-published',
    cfFunction?.Properties?.AutoPublish === true,
    'an unpublished function never goes live',
  );

  // A CustomErrorResponses rule that rewrites 403/404 to /index.html makes every
  // unknown path return 200 with the CV. That is what hid the original bug:
  // /family-planner served the homepage with a 200, so a status-only live
  // check passed. It also means a mistyped URL silently lands on the CV, and a
  // cached 403 keeps re-serving that rewrite after a deploy. Refuse it.
  const errorRules = cfg?.CustomErrorResponses ?? [];
  const homepageRewrites = errorRules.filter(
    (r) => String(r?.ResponsePagePath ?? '').includes('index.html'),
  );
  check(
    'CloudFront does not rewrite errors to the homepage',
    homepageRewrites.length === 0,
    homepageRewrites.length
      ? `rewrites ${homepageRewrites.map((r) => r.ErrorCode).join(', ')} to ${homepageRewrites[0].ResponsePagePath}, so a wrong page returns 200`
      : '',
  );

  // The custom domain must be attached to the distribution, not just pointed at
  // it in DNS. Without Aliases the edge serves only *.cloudfront.net and every
  // request to the real domain fails the TLS handshake.
  const aliases = (cfg?.Aliases ?? []).map((a) => String(a).replace(/^!Sub\s+/, '').replace(/^['"]|['"]$/g, ''));
  const apex = tpl.Parameters?.DomainName?.Default ?? 'ryanlilker.com';
  check(
    'CloudFront distribution has the apex domain as an alias',
    aliases.some((a) => a === apex || a === '!Ref DomainName'),
    `aliases: ${JSON.stringify(aliases)}`,
  );
  check(
    'CloudFront distribution has the www alias',
    aliases.some((a) => a.includes('www.')),
    `aliases: ${JSON.stringify(aliases)}`,
  );
  // The certificate covering the aliases is checked further down, where the
  // Certificate resource is parsed, so it is not repeated here.

  // ViewerCertificate: CloudFront REQUIRES SslSupportMethod alongside an ACM
  // ARN, and will refuse to create the distribution without it.
  const cert = cfg?.ViewerCertificate ?? {};
  check('viewer certificate has SslSupportMethod', !!cert.SslSupportMethod, cert.SslSupportMethod);
  check('viewer certificate uses an ACM cert', !!cert.AcmCertificateArn);
  check('viewer certificate is SNI not a dedicated IP', cert.SslSupportMethod === 'sni-only', 'sni-only avoids ~$20/mo');
  check('minimum TLS is 1.2 or newer', /TLSv1\.[23]/.test(cert.MinimumProtocolVersion ?? ''), cert.MinimumProtocolVersion);

  // CloudFront names accept only [A-Za-z0-9_-]. A domain contains dots, so
  // '${DomainName}-cv-headers' expands to 'ryanlilker.com-cv-headers' and is
  // rejected with a 400 at create time.
  //
  // Only Name is constrained; Description and Comment are free text. Short-form
  // intrinsics parse to the string '!Sub <template>', so the tag prefix has to
  // be stripped. The placeholders are then replaced with their REAL values, not
  // with a harmless token - substituting a safe placeholder is precisely what
  // let a broken name pass this check once already.
  const domain = tpl.Parameters?.DomainName?.Default ?? 'ryanlilker.com';
  const subs = { DomainName: domain, Safe: 'safe-name' };

  // A !Sub can be written two ways, which parse very differently:
  //   Name: !Sub '${DomainName}-cv-headers'          -> the string "!Sub ..."
  //   Name: !Sub ['${Safe}-cv-headers', {Safe: ...}]  -> a two-element array
  // Only the first form was handled originally, which is why a broken name in
  // the second form went uninspected. Handle both.
  const subTemplate = (v) => {
    if (typeof v === 'string') return v.replace(/^!Sub\s+/, '');
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
  };

  const nameLiterals = (node, out = []) => {
    if (Array.isArray(node)) {
      node.forEach((n) => nameLiterals(n, out));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'Name') {
          const tpl = subTemplate(v);
          if (tpl !== null) out.push(tpl);
          else out.push('<<non-literal Name, cannot verify>>');
        } else nameLiterals(v, out);
      }
    }
    return out;
  };

  let sawName = 0;
  for (const [logicalId, res] of Object.entries(tpl.Resources ?? {})) {
    if (!String(res?.Type ?? '').startsWith('AWS::CloudFront::')) continue;
    for (const raw of nameLiterals(res)) {
      sawName++;
      const name = raw.replace(/^['"]|['"]$/g, '');
      const expanded = name.replace(/\$\{([^}]*)\}/g, (_, key) => subs[key.trim()] ?? `UNRESOLVED_${key}`);
      check(
        `CloudFront ${logicalId} name expands to a legal value`,
        /^[A-Za-z0-9_-]+$/.test(expanded),
        `expands to '${expanded}', which contains characters CloudFront rejects`,
      );
    }
  }
  check('CloudFront resources with a Name were inspected', sawName > 0, `${sawName} found`);

  // A CloudFront name must not interpolate a domain directly. FindInMap is the
  // only supported way to get a dotted domain into a legal name, and it keeps
  // the sanitised form in one place instead of duplicating a literal.
  const cfn = readFileSync(resolve(root, 'infra/cloudformation.yml'), 'utf8');
  // Collect the SanitizedDomain block line by line. A regex over the block was
  // too fragile: it stopped at the first line whose indentation it did not
  // expect, which silently produced an empty match and a false failure.
  const cfnLines = cfn.split(/\r?\n/);
  const mapStart = cfnLines.findIndex((l) => /^ {2}SanitizedDomain:\s*$/.test(l));
  const mapLines = [];
  if (mapStart !== -1) {
    for (let i = mapStart + 1; i < cfnLines.length; i++) {
      const line = cfnLines[i];
      // The block ends at the first non-blank line indented less than 4 spaces.
      if (line.trim() !== '' && !/^ {4}/.test(line)) break;
      mapLines.push(line);
    }
  }
  check('SanitizedDomain mapping block was found', mapStart !== -1 && mapLines.length > 0);
  const mapBlock = mapLines.join('\n');
  const escaped = domain.replace(/\./g, '\\.');
  check(
    'SanitizedDomain mapping exists for the domain',
    new RegExp(`^ {4}${escaped}:`, 'm').test(mapBlock),
    `no mapping row for '${domain}'; a CloudFront !FindInMap would fail at deploy`,
  );
  check(
    'SanitizedDomain mapping is three levels deep',
    new RegExp(`^ {6}Name: \\S+$`, 'm').test(mapBlock),
    'a two-level Mappings entry is rejected with "Every Mappings member must be a map"',
  );
  for (const m of mapBlock.matchAll(/^ {6}Name: (.+)$/gm)) {
    check(
      'SanitizedDomain value is [A-Za-z0-9_-] safe',
      /^[A-Za-z0-9_-]+$/.test(m[1].trim()),
      `'${m[1].trim()}' contains characters CloudFront rejects`,
    );
  }
  for (const m of cfn.matchAll(/Name: !Sub\s*\n\s*- '([^']*\$\{DomainName\}[^']*)'/g)) {
    check(
      'no CloudFront name interpolates ${DomainName} directly',
      false,
      `'${m[1]}' expands to '${m[1].replace('${DomainName}', domain)}'`,
    );
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

  // The workflow declares `environment: production`, so GitHub issues an
  // environment subject for every run and the branch subject is never presented.
  // If only the branch form is allowed, every deploy fails at
  // sts:AssumeRoleWithWebIdentity. The two must stay in step: the environment
  // name here has to equal the one in .github/workflows/deploy.yml.
  const subClaim = role?.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Condition?.StringEquals
    ?.['token.actions.githubusercontent.com:sub'];
  const allowedSubs = Array.isArray(subClaim) ? subClaim : [subClaim].filter(Boolean);
  check(
    'deploy role trust allows an environment subject',
    allowedSubs.some((s) => String(s).includes(':environment:')),
    `allowed subjects: ${JSON.stringify(allowedSubs)}`,
  );

  const deployWf = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8');
  const wfEnv = deployWf.match(/^\s*environment:\s*(\S+)\s*$/m)?.[1];
  // The trust policy carries the value through a !Sub parameter, so the
  // parameter's default is what actually ends up in the subject claim.
  const envParam = tpl.Parameters?.DeployEnvironment?.Default;
  const expectedSub = `:environment:${wfEnv}`;
  check('deploy workflow declares an environment', !!wfEnv, 'no `environment:` key found in deploy.yml');
  check('DeployEnvironment parameter exists', !!envParam, 'no DeployEnvironment parameter in the template');
  check(
    'trust policy environment matches the deploy workflow',
    !!wfEnv && !!envParam && wfEnv === envParam,
    `workflow uses '${wfEnv}', trust policy resolves to '${envParam}'`,
  );
  check(
    'trust policy references the DeployEnvironment parameter',
    allowedSubs.some((s) => String(s).includes('${DeployEnvironment}')),
    `allowed subjects: ${JSON.stringify(allowedSubs)}`,
  );

  const policy = JSON.stringify(role?.Properties?.Policies ?? []);
  check('deploy role can invalidate CloudFront', policy.includes('cloudfront:CreateInvalidation'));
  // The workflow also runs `aws cloudfront wait invalidation-completed`, which
  // polls GetInvalidation. Missing it publishes the site and then fails the job.
  check(
    'deploy role can read invalidation status',
    policy.includes('cloudfront:GetInvalidation'),
    'needed by `aws cloudfront wait invalidation-completed`',
  );
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
