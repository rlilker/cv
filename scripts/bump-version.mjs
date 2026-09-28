/** Record the next verified production publish after the live checks pass. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'src/data/version.json');
const current = JSON.parse(readFileSync(path, 'utf8'));

if (!Number.isSafeInteger(current.major) || current.major < 0 ||
    !Number.isSafeInteger(current.minor) || current.minor < 0 ||
    current.version !== `${current.major}.${current.minor}`) {
  throw new Error('src/data/version.json has inconsistent version fields');
}

const next = {
  major: current.major,
  minor: current.minor + 1,
  version: `${current.major}.${current.minor + 1}`,
  updatedAt: new Date().toISOString().slice(0, 10),
};

if (process.argv.includes('--current')) {
  console.log(current.version);
} else if (process.argv.includes('--check')) {
  console.log(next.version);
} else {
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(next.version);
}
