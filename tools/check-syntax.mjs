// Seed Code Mail — syntax check for every shipped JavaScript module
//
//     npm run check:syntax
//
// Why this exists: a Vercel deployment failed with
//
//     frontend/js/mail-common.js: Failed to parse source for import analysis
//     because the content contains invalid JS syntax.
//
// because that file had been truncated mid-statement (it ended inside an
// unterminated `catch` block). `npm run build` catches it too, but this check
// names the offending file and the exact parse error in one line, and it also
// covers server-side modules that the frontend build never looks at.
//
// It parses with the same engine the build uses (Node), and it treats the
// project as ESM exactly as `package.json` declares.

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOTS = ['frontend/js', 'api', 'backend/lib', 'tools', 'tests/js'];
const EXTENSIONS = ['.js', '.mjs'];

async function collect(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (_) {
    return files; // a root that does not exist yet is not an error
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...await collect(full));
    } else if (EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const targets = [];
for (const root of ROOTS) targets.push(...await collect(path.resolve(process.cwd(), root)));

if (!targets.length) {
  console.error('No JavaScript modules found to check — refusing to report success.');
  process.exit(1);
}

const failures = [];
for (const file of targets.sort()) {
  // `--check` only parses; it never executes the module, so no import side
  // effects or network calls happen here.
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim().split('\n');
    // The first line naming the file plus the SyntaxError line is the useful part.
    const reason = output.find((line) => /SyntaxError|Error:/.test(line)) || output[0] || 'parse error';
    failures.push({ file: path.relative(process.cwd(), file).split(path.sep).join('/'), reason });
  }
}

if (failures.length) {
  console.error(`\n${failures.length} module(s) failed to parse:\n`);
  for (const failure of failures) console.error(`  FAIL ${failure.file}\n       ${failure.reason.trim()}`);
  console.error('\nA truncated or malformed module breaks the Vercel build at the import-analysis step.\n');
  process.exit(1);
}

console.log(`All ${targets.length} JavaScript modules parse.`);
