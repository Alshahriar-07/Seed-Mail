// Seed Code Mail — design token checker
//
//     npm run check:tokens
//
// A stylesheet that references a custom property nobody declares does not fail
// the build, does not fail the syntax check, and does not throw at runtime: the
// declaration is simply dropped and the property falls back to its initial
// value. That is how a redesign can silently render square corners on every
// button. This script catches that class of mistake statically.
//
// It asserts two things:
//   1. Every `var(--token)` used in CSS or JS is declared somewhere (or set from
//      JavaScript via setProperty, e.g. a dynamically sized avatar).
//   2. Every stylesheet in frontend/css/ is actually linked from index.html, so
//      a token or component file cannot be orphaned by accident.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CSS_DIR = path.resolve(process.cwd(), 'frontend/css');
const JS_DIR = path.resolve(process.cwd(), 'frontend/js');
const INDEX = path.resolve(process.cwd(), 'frontend/index.html');

let failures = 0;
function report(ok, label, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`         ${detail}`);
  }
}

const VAR_USE = /var\(\s*(--[a-z0-9-]+)/gi;
const VAR_DECL = /^\s*(--[a-z0-9-]+)\s*:/gm;
const SET_PROP = /setProperty\(\s*['"](--[a-z0-9-]+)/gi;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const cssFiles = (await readdir(CSS_DIR)).filter((f) => f.endsWith('.css')).sort();
const jsFiles = await walk(JS_DIR);

/** @type {Map<string, string[]>} */
const declared = new Map();
/** @type {Map<string, Set<string>>} */
const used = new Map();

function noteDecl(token, where) {
  if (!declared.has(token)) declared.set(token, []);
  declared.get(token).push(where);
}
function noteUse(token, where) {
  if (!used.has(token)) used.set(token, new Set());
  used.get(token).add(where);
}

for (const file of cssFiles) {
  const text = await readFile(path.join(CSS_DIR, file), 'utf8');
  for (const m of text.matchAll(VAR_DECL)) noteDecl(m[1], file);
  for (const m of text.matchAll(VAR_USE)) noteUse(m[1], file);
}

for (const file of jsFiles) {
  const text = await readFile(file, 'utf8');
  const where = path.relative(process.cwd(), file).replace(/\\/g, '/');
  for (const m of text.matchAll(VAR_USE)) noteUse(m[1], where);
  for (const m of text.matchAll(SET_PROP)) noteDecl(m[1], where);
}

console.log(`Design tokens — ${cssFiles.length} stylesheets, ${jsFiles.length} modules\n`);

const undefinedRefs = [...used.keys()].filter((token) => !declared.has(token)).sort();
report(
  undefinedRefs.length === 0,
  `every referenced custom property is declared (${used.size} referenced, ${declared.size} declared)`,
  undefinedRefs.map((t) => `${t} — used in ${[...used.get(t)].join(', ')}`).join('\n         '),
);

// A stylesheet that is never linked from index.html is dead weight: its tokens
// would still satisfy check 1 above while never reaching the browser.
const indexHtml = await readFile(INDEX, 'utf8');
const linked = new Set([...indexHtml.matchAll(/href="\/css\/([^"]+)"/g)].map((m) => m[1]));
const unlinked = cssFiles.filter((f) => !linked.has(f));
report(
  unlinked.length === 0,
  `every stylesheet is linked from index.html (${linked.size} linked)`,
  unlinked.length ? `not linked: ${unlinked.join(', ')}` : '',
);

const missing = [...linked].filter((f) => !cssFiles.includes(f));
report(
  missing.length === 0,
  'every linked stylesheet exists on disk',
  missing.length ? `missing file: ${missing.join(', ')}` : '',
);

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('Design tokens check out.');
