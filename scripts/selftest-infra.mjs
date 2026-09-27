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
const validator = resolve(root, 'scripts/validate-infra.mjs');

const original = readFileSync(tplPath, 'utf8');

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
    name: 'OIDC trust not scoped to a branch',
    expect: 'deploy role is branch-scoped',
    mutate: (s) => s.replace(/:ref:refs\/heads\/\$\{SubjectBranch\}/, ''),
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
    name: 'bucket would be destroyed with the stack',
    expect: 'S3 bucket retained on stack delete',
    mutate: (s) => s.replace(/^ {4}DeletionPolicy: Retain\r?\n/m, ''),
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
  line(!runValidator().failed, 'baseline: the real template passes validation');

  for (const fault of faults) {
    const mutated = fault.mutate(original);
    if (mutated === original) {
      line(false, `${fault.name} — mutation matched nothing, so the test proves nothing`);
      continue;
    }
    writeFileSync(tplPath, mutated, 'utf8');
    const { failed, out } = runValidator();
    const escaped = fault.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    line(failed && new RegExp(`FAIL\\s+${escaped}`).test(out), `caught: ${fault.name}`);
  }
} finally {
  writeFileSync(tplPath, original, 'utf8');
  const restored = readFileSync(tplPath, 'utf8') === original;
  console.log(`\n  ${restored ? 'template restored' : 'WARNING: template was not restored'}`);
  if (!restored) failures++;
}

console.log(`\n${failures === 0 ? 'SELF-TEST PASSED' : `SELF-TEST: ${failures} PROBLEM(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
