// Regression guard for the application shell's visibility contract.
//
// Real bug this pins: the public legal pages are rendered by hiding the entire
// private shell (`#app-shell`) and revealing `#legal-root`. `renderAppRoute()`
// never revealed the shell again, so a *signed-in* user going
// Settings → Privacy Policy → "Open app" (or pressing Back) had the route
// rendered into a hidden container: the document stayed on screen and the link
// appeared to do nothing.
//
// app.js is a browser module (it touches the DOM at import time and is loaded as
// an ES module by index.html), so it cannot be imported by the Node test runner
// without a DOM implementation. The project already pins source-level invariants
// this way (see tests/test_queue.py::test_consumer_never_retries_sent_jobs), and
// the assertion below is deliberately about *ordering* — the missing statement
// was the bug, not a missing constant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = readFileSync(path.join(ROOT, 'frontend', 'js', 'app.js'), 'utf8');

/** The body of a top-level `function name(...) { … }` in app.js. */
function functionBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in frontend/js/app.js`);
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('the legal page hides the private shell and the signed-out screen', () => {
  const body = functionBody('showLegalPage');
  assert.match(body, /appShell\.hidden = true/, 'showLegalPage must hide #app-shell');
  assert.match(body, /authRoot\.hidden = true/, 'showLegalPage must hide the signed-out layout');
  assert.match(body, /legalRoot\.hidden = false/, 'showLegalPage must reveal #legal-root');
});

test('rendering a private route always restores the shell', () => {
  const body = functionBody('renderAppRoute');
  const legalGuard = body.indexOf('renderLegalIfRequested()');
  const reveal = body.indexOf('showApplication();');
  const render = body.indexOf('view.innerHTML = ');

  assert.notEqual(legalGuard, -1, 'renderAppRoute must still defer to a requested legal document');
  assert.notEqual(reveal, -1, 'renderAppRoute must reveal the application shell (this was the frozen-page bug)');
  assert.notEqual(render, -1, 'renderAppRoute must render into #view');
  assert.ok(legalGuard < reveal, 'the legal guard must run first, so a public page is never replaced');
  assert.ok(reveal < render, 'the shell must be visible before the route is rendered into it');
  // A route reached without a session must not reveal the private shell.
  assert.match(body, /if \(!currentUser\(\)\)/, 'renderAppRoute must fall back to sign-in without a session');
});

test('each layout switch hides the other layouts', () => {
  const authScreen = functionBody('showAuthScreen');
  assert.match(authScreen, /legalRoot\.hidden = true/, 'the sign-in screen must hide #legal-root');
  assert.match(authScreen, /appShell\.hidden = true/, 'the sign-in screen must hide #app-shell');

  const application = functionBody('showApplication');
  assert.match(application, /appShell\.hidden = false/, 'the app shell must be revealed');
  assert.match(application, /authRoot\.hidden = true/, 'the app shell must hide the signed-out layout');
  assert.match(application, /legalRoot\.hidden = true/, 'the app shell must hide #legal-root');
});

test('the documented legal routes are wired to the router', () => {
  // The two entry points a reviewer uses, and the document container each needs.
  for (const id of ['legal-root', 'legal-topbar', 'legal-body', 'legal-footer', 'auth-footer']) {
    assert.ok(
      readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8').includes(`id="${id}"`),
      `frontend/index.html must contain #${id}`,
    );
  }
  assert.match(SOURCE, /legal\.legalSlugFromLocation\(\)/, 'the router must consult legalSlugFromLocation()');
  assert.match(SOURCE, /legal\.legalFooter\(\)/, 'the legal footer must be rendered from legal.js');
});
