// Extracts the shell from a workflow `run:` block and syntax-checks it with
// `bash -n`. A YAML file can be perfectly valid while its embedded shell has a
// quoting bug that only appears at run time on the runner.
//
// Usage: node scripts/check-workflow-shell.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = resolve(root, '.github/workflows');

const walk = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.run === 'string') out.push(node.run);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
};

let scripts = 0;
let failures = 0;

for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
  const doc = parse(readFileSync(join(workflowsDir, file), 'utf8'));
  for (const [i, script] of walk(doc).entries()) {
    scripts++;
    const label = `${file} run-block ${i + 1}`;
    try {
      execFileSync('bash', ['-n'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`  PASS  bash -n ${label}`);
    } catch (e) {
      console.log(`  FAIL  bash -n ${label}\n        ${(e.stderr ?? '').trim()}`);
      failures++;
    }
  }
}

console.log(`\n${failures === 0 ? `SHELL SYNTAX OK (${scripts} block(s))` : `SHELL SYNTAX: ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
