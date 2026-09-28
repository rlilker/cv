/**
 * Regression proof for scripts/validate-infra.mjs.
 *
 * A validator that never fails is worse than no validator, because it creates
 * false confidence. This script injects each of the faults that were present in
 * the original CloudFormation template and asserts the validator catches it.
 *
 * The template is restored to its original contents in a `finally` block, so
 * this is safe to run at any time — including in CI.
 *
 * Run with:  node scripts/selftest-infra.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tplPath = resolve(root, 'infra/cloudformation.yml');
const wfPath = resolve(root, '.github/workflows/deploy.yml');
const validator = resolve(root, 'scripts/validate-infra.mjs');

const original = readFileSync(tplPath, 'utf8');
const originalWf = readFileSync(wfPath, 'utf8');

/** Run the validator; returns whether it failed and the combined output. */
const runValidator = () => {
  try {
    const out = execFileSync('node', [validator], { encoding: 'utf8', cwd: root });
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// The template is checked out with CRLF on Windows, so every mutation below
// matches line endings loosely rather than assuming "\n".

/**
 * Remove a YAML block and everything indented under it, line by line.
 *
 * A regex like /^\s+Key:\n(?:^ {4,}.*\n)*?^ {2}\S/m backtracks catastrophically
 * here - it spun a node process for over seven minutes before being killed.
 * Walking the lines once is linear and cannot hang.
 */
const removeBlock = (text, key, { after } = {}) => {
  const lines = text.split(/\r?\n/);
  // `after` scopes the search, because the same key can appear in more than one
  // resource - DeletionPolicy exists on both the bucket and the certificate, and
  // removing the wrong one would silently weaken the other resource's policy.
  const searchFrom = after
    ? lines.findIndex((l) => new RegExp(`^\\s*${after}:`).test(l)) + 1
    : 0;
  const start = lines.findIndex(
    (l, i) => i >= searchFrom && new RegExp(`^\\s*${key}:\\s*$`).test(l),
  );
  if (start === -1) return text;
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') {
      end++;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    end++;
  }
  // Drop trailing blank lines that belonged to the removed block.
  while (end > start && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
};

const faults = [
  {
    name: 'truncated BucketEncryption (key present, value empty)',
    expect: 'no empty property values',
    // Mirrors the real truncation: the key survives, its list does not.
    mutate: (s) =>
      s.replace(
        /( {8})ServerSideEncryptionConfiguration:\r?\n(?:[^\n]*\r?\n)*?[ ]{10}- ServerSideEncryptionByDefault:\r?\n(?:[^\n]*\r?\n)*/,
        '$1ServerSideEncryptionConfiguration:\r\n',
      ),
  },
  {
    name: 'ViewerCertificate missing SslSupportMethod',
    expect: 'viewer certificate has SslSupportMethod',
    mutate: (s) => s.replace(/^[ \t]*SslSupportMethod: sni-only\r?\n/m, ''),
  },
  {
    name: 'placeholder hosted zone id in cert validation',
    expect: 'no placeholder zone id in cert validation',
    mutate: (s) => s.replace(/!If \[CreateZone, !Ref HostedZone, !Ref ExistingHostedZoneId\]/g, "'_ignore'"),
  },
  {
    name: 'public S3 bucket (access block removed)',
    expect: 'S3 blocks all public access',
    mutate: (s) => s.replace(/^[ \t]*PublicAccessBlockConfiguration:\r?\n(?:[ \t]*\w+: (?:true|false)\r?\n)+/m, ''),
  },
  {
    name: 'no bucket policy, so the origin access control grants nothing and every route 403s',
    expect: 'bucket policy exists for the origin access control',
    // Removes the whole resource block. Line-based so it cannot backtrack.
    mutate: (s) => removeBlock(s, 'SiteBucketPolicy'),
  },
  {
    name: 'bucket policy grant not scoped to this distribution',
    expect: 'bucket policy scope is not a wildcard',
    mutate: (s) =>
      s.replace(
        /^ {16}'AWS:SourceArn': [^\n]*$/m,
        "                'AWS:SourceArn': !Sub 'arn:aws:cloudfront::x:distribution/*'",
      ),
  },
  {
    name: 'bucket policy granting write access to CloudFront',
    expect: 'bucket policy is read-only',
    mutate: (s) =>
      s.replace(
        /^ {12}Action: s3:GetObject$/m,
        '            Action:\n              - s3:GetObject\n              - s3:PutObject',
      ),
  },
  {
    name: 'deploy role cannot upload, so the publish fails part way through',
    expect: 'deploy role can perform s3:PutObject',
    mutate: (s) => s.replace(/^ {18}- s3:PutObject\r?\n/m, ''),
  },
  {
    name: 'deploy role cannot read objects',
    expect: 'deploy role can perform s3:GetObject',
    mutate: (s) => s.replace(/^ {18}- s3:GetObject\r?\n/m, ''),
  },
  {
    name: 'function ARN read from a non-existent FunctionMetadata.FunctionArn attribute',
    expect: 'is a valid Function reference',
    mutate: (s) => s.replace('!GetAtt AppendHtmlFunction.FunctionARN', '!GetAtt AppendHtmlFunction.FunctionMetadata.FunctionArn'),
  },
  {
    name: 'CloudFront path function removed, so extensionless routes 403',
    expect: 'a CloudFront function resolves extensionless paths',
    mutate: (s) => removeBlock(s, 'AppendHtmlFunction'),
  },
  {
    name: 'CloudFront path function not attached to the cache behaviour',
    expect: 'the path function is attached to the default cache behaviour',
    mutate: (s) => removeBlock(s, 'FunctionAssociations'),
  },
  {
    name: 'CloudFront function never auto-published',
    expect: 'the function is auto-published',
    mutate: (s) => s.replace(/^ {6}AutoPublish: true$/m, '      AutoPublish: false'),
  },
  {
    name: 'certificate not retained, so a replace deletes the live certificate',
    expect: 'certificate is retained on stack delete',
    // Scoped to the Certificate resource: the bucket also has a DeletionPolicy,
    // and dropping that one instead would leave this test proving the wrong thing.
    // Walked line by line rather than by index arithmetic, so it works with
    // CRLF and does not depend on where the resource happens to sit.
    mutate: (s) => {
      const lines = s.split(/\r?\n/);
      const at = lines.findIndex((l) => /^ {2}Certificate:\s*$/.test(l));
      if (at === -1) return s;
      for (let i = at + 1; i < lines.length; i++) {
        if (/^ {2}\S/.test(lines[i])) break; // next resource
        if (/^ {4}DeletionPolicy:/.test(lines[i])) {
          lines.splice(i, 1);
          return lines.join('\n');
        }
      }
      return s;
    },
  },
  {
    name: 'certificate not retained on replacement',
    expect: 'certificate is retained on replacement',
    // Scoped the same way, for the same reason.
    mutate: (s) => {
      const lines = s.split(/\r?\n/);
      const at = lines.findIndex((l) => /^ {2}Certificate:\s*$/.test(l));
      for (let i = at; i < lines.length; i++) {
        if (/UpdateReplacePolicy:\s*Retain/.test(lines[i])) {
          lines[i] = lines[i].replace('Retain', 'Delete');
          return lines.join('\n');
        }
      }
      return s;
    },
  },
  {
    name: 'cert validation options no longer gated on CanManageDns',
    expect: 'cert validation options are gated on CanManageDns',
    mutate: (s) => s.replace(/DomainValidationOptions: !If\r?\n\s*- CanManageDns/, 'DomainValidationOptions:'),
  },
  {
    name: 'CloudFront 404 rewritten to the homepage, so a wrong page returns 200',
    expect: 'does not rewrite errors to the homepage',
    // Inserts the rule rather than replacing one, since the real template has
    // no CustomErrorResponses block at all - the fault is its presence.
    mutate: (s) =>
      s.replace(
        /^ {8}ViewerCertificate:$/m,
        '        CustomErrorResponses:\n' +
          '          - ErrorCode: 404\n' +
          '            ResponseCode: 200\n' +
          '            ResponsePagePath: /index.html\n' +
          '            ErrorCachingMinTTL: 10\n' +
          '        ViewerCertificate:',
      ),
  },
  {
    name: 'CloudFront distribution with no custom domain alias, so the real domain fails TLS',
    expect: 'CloudFront distribution has the apex domain as an alias',
    mutate: (s) => s.replace(/^ {8}Aliases:\r?\n(?: {10}- .*\r?\n)+/m, ''),
  },
  {
    name: 'CloudFront distribution missing the www alias',
    expect: 'CloudFront distribution has the www alias',
    mutate: (s) => s.replace(/^ {10}- !Sub 'www\.\$\{DomainName\}'\r?\n/m, ''),
  },
  {
    name: 'deploy role cannot read invalidation status, so the workflow wait fails',
    expect: 'deploy role can read invalidation status',
    mutate: (s) => s.replace(/^ {18}- cloudfront:GetInvalidation\r?\n/m, ''),
  },
  {
    name: 'OIDC trust not scoped to a branch',
    expect: 'deploy role is branch-scoped',
    mutate: (s) => s.replace(/:ref:refs\/heads\/\$\{SubjectBranch\}/, ''),
  },
  {
    name: 'OIDC trust missing the environment subject, so no run can assume the role',
    expect: 'deploy role trust allows an environment subject',
    mutate: (s) =>
      s.replace(/^ {18}- !Sub 'repo:\$\{GitHubOrg\}\/\$\{GitHubRepo\}:environment:\$\{DeployEnvironment\}'\r?\n/m, ''),
  },
  {
    name: 'DeployEnvironment parameter default renamed away from the deploy workflow',
    expect: 'trust policy environment matches the deploy workflow',
    mutate: (s) => s.replace(/^ {4}Default: production$/m, '    Default: staging'),
  },
  {
    name: 'deploy workflow environment renamed away from the trust policy',
    expect: 'trust policy environment matches the deploy workflow',
    // Mutates the workflow, not the template, so the two can drift apart in
    // real life. Restored in the finally block below.
    mutateWorkflow: (s) => s.replace('environment: production', 'environment: prod-site'),
  },
  {
    name: 'bucket encryption algorithm removed',
    expect: 'bucket encryption uses SSE-S3 or KMS',
    mutate: (s) => s.replace(/^[ \t]*SSEAlgorithm: AES256\r?\n/m, ''),
  },
  {
    name: 'CloudFront served over HTTP only',
    expect: 'CloudFront redirects to HTTPS',
    mutate: (s) => s.replace(/ViewerProtocolPolicy: redirect-to-https/, 'ViewerProtocolPolicy: allow-all'),
  },
  {
    name: 'CloudFront origin switched to a public bucket',
    expect: 'CloudFront uses OAC',
    mutate: (s) => s.replace(/^[ \t]*OriginAccessControlId: [^\n]*\r?\n/m, ''),
  },
  {
    name: 'deploy role trusts a stranger instead of GitHub',
    expect: 'deploy role trusts GitHub OIDC',
    mutate: (s) => s.replace(/token\.actions\.githubusercontent\.com/g, 'example.com'),
  },
  {
    name: 'S3 bucket retained on delete, which blocks a retry after a failed create',
    expect: 'S3 bucket is not retained on stack delete',
    mutate: (s) => s.replace(/^ {4}DeletionPolicy: Delete$/m, '    DeletionPolicy: Retain'),
  },
  {
    name: 'S3 bucket not retained on replacement, so a replace would lose the site',
    expect: 'S3 bucket is still retained on replacement',
    mutate: (s) => s.replace(/^ {4}UpdateReplacePolicy: Retain$/m, '    UpdateReplacePolicy: Delete'),
  },
  // Both of these caused a real rollback of the cv-site stack, twice, because
  // the validator looked past them. Each is a distinct trap:
  //   - the ${...} placeholder was replaced with a safe token, hiding the fact
  //     that the real domain contains dots;
  //   - the two-argument !Sub form parses to an array, not a string, so the
  //     string-only check found nothing to inspect and silently passed.
  {
    name: 'CloudFront origin pointed at a misspelled GetAtt attribute',
    expect: 'is a real Bucket attribute',
    mutate: (s) => s.replace('!GetAtt SiteBucket.RegionalDomainName', '!GetAtt SiteBucket.RegionalDomain'),
  },
  {
    name: 'Route53 alias pointed at the Route 53 zone instead of CloudFront',
    expect: "alias uses CloudFront's hosted zone",
    mutate: (s) => s.replace('HostedZoneId: Z2FDTNDATAQYW2', 'HostedZoneId: Z1234567890ABC'),
  },
  {
    name: 'GetAtt against a resource that does not exist',
    expect: 'targets a declared resource',
    mutate: (s) => s.replace('!GetAtt SiteBucket.RegionalDomainName', '!GetAtt NoSuchBucket.RegionalDomainName'),
  },
  {
    name: 'CloudFrontHostedZoneId output built from a non-existent GetAtt',
    expect: 'is a real Distribution attribute',
    mutate: (s) => s.replace('Value: Z2FDTNDATAQYW2', 'Value: !GetAtt Distribution.HostedZoneId'),
  },
  {
    name: 'viewer certificate uses the non-existent Certificate.Arn attribute',
    expect: 'is a real Certificate attribute',
    mutate: (s) => s.replace('AcmCertificateArn: !Ref Certificate', 'AcmCertificateArn: !GetAtt Certificate.Arn'),
  },
  {
    name: 'CloudFront name built directly from ${DomainName} (400 from CloudFront)',
    expect: 'name expands to a legal value',
    mutate: (s) =>
      s.replace(
        /Name: !Sub\s*\r?\n\s*- '\$\{Safe\}-cv-headers'\s*\r?\n\s*- Safe: !FindInMap \[SanitizedDomain, !Ref DomainName, Name\]/,
        "Name: !Sub '${DomainName}-cv-headers'",
      ),
  },
  {
    name: 'OAC name built directly from ${DomainName} (400 from CloudFront)',
    expect: 'name expands to a legal value',
    mutate: (s) =>
      s.replace(
        /Name: !Sub\s*\r?\n\s*- '\$\{Safe\}-cv-oac'\s*\r?\n\s*- Safe: !FindInMap \[SanitizedDomain, !Ref DomainName, Name\]/,
        "Name: !Sub '${DomainName}-cv-oac'",
      ),
  },
  {
    name: 'SanitizedDomain mapping missing the domain row (FindInMap would fail)',
    expect: 'SanitizedDomain mapping exists for the domain',
    mutate: (s) => s.replace(/^ {4}ryanlilker\.com:$/m, '    example.invalid:'),
  },
  {
    name: 'SanitizedDomain written with only two levels (rejected by CloudFormation)',
    expect: 'SanitizedDomain mapping is three levels deep',
    mutate: (s) => s.replace(/^ {6}Name: (\S+)$/m, '      $1'),
  },
  {
    name: 'CloudFront name containing dots (400 from CloudFront)',
    expect: 'name expands to a legal value',
    mutate: (s) => s.replace('-cv-headers', '-cv.headers'),
  },
  {
    name: 'OIDC provider with an empty thumbprint list (400 from IAM)',
    expect: 'OIDC provider has at least one thumbprint',
    mutate: (s) => s.replace(/^[ \t]*-[ \t]*6938fd4d98bab03faadb97b34396831e3780aea1[ \t]*\r?\n/m, ''),
  },
  {
    name: 'OIDC thumbprint that is not a SHA-1 fingerprint (400 from IAM)',
    expect: 'OIDC thumbprints look like SHA-1 fingerprints',
    mutate: (s) => s.replace('6938fd4d98bab03faadb97b34396831e3780aea1', 'not-a-real-thumbprint'),
  },
  {
    name: 'cert validation setting both HostedZoneId and ValidationDomain (400 from ACM)',
    expect: 'only one of HostedZoneId / ValidationDomain',
    mutate: (s) =>
      s.replace(
        /(^ {12}HostedZoneId: !If \[CreateZone, !Ref HostedZone, !Ref ExistingHostedZoneId\]\r?\n)( {10}- DomainName: !Sub 'www\.\$\{DomainName\}')/m,
        '$1            ValidationDomain: !Ref DomainName\n$2',
      ),
  },
];

let failures = 0;
const line = (ok, text) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

console.log('\n=== validate-infra self-test ===');
console.log('Each fault is injected deliberately; the named check must fail.\n');

try {
  writeFileSync(tplPath, original, 'utf8');
  writeFileSync(wfPath, originalWf, 'utf8');
  line(!runValidator().failed, 'baseline: the real template passes validation');

  for (const fault of faults) {
    // A fault targets either the template or the workflow; the other is left
    // untouched so the validator sees exactly one change at a time.
    const touchesWorkflow = typeof fault.mutateWorkflow === 'function';
    const base = touchesWorkflow ? originalWf : original;
    const mutated = (touchesWorkflow ? fault.mutateWorkflow : fault.mutate)(base);
    if (mutated === base) {
      line(false, `${fault.name} — mutation matched nothing, so the test proves nothing`);
      continue;
    }
    if (touchesWorkflow) {
      writeFileSync(tplPath, original, 'utf8');
      writeFileSync(wfPath, mutated, 'utf8');
    } else {
      writeFileSync(wfPath, originalWf, 'utf8');
      writeFileSync(tplPath, mutated, 'utf8');
    }
    const { failed, out } = runValidator();
    // The check label is printed as "FAIL  <label>", so the expected text has to
    // appear somewhere in a failing line rather than immediately after FAIL.
    const flagged = out
      .split(/\r?\n/)
      .some((l) => l.includes('FAIL') && l.includes(fault.expect));
    line(failed && flagged, `caught: ${fault.name}`);
  }
} finally {
  writeFileSync(tplPath, original, 'utf8');
  writeFileSync(wfPath, originalWf, 'utf8');
  const restored = readFileSync(tplPath, 'utf8') === original;
  const restoredWf = readFileSync(wfPath, 'utf8') === originalWf;
  console.log(`\n  ${restored ? 'template restored' : 'WARNING: template was not restored'}`);
  console.log(`  ${restoredWf ? 'workflow restored' : 'WARNING: workflow was not restored'}`);
  if (!restored) failures++;
  if (!restoredWf) failures++;
}

console.log(`\n${failures === 0 ? 'SELF-TEST PASSED' : `SELF-TEST: ${failures} PROBLEM(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
