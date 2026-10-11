// Tests for frontend/js/lib/runtime.js
//
// This module is the single place that answers "am I the web app or the desktop
// app?". The tests pin the security-relevant rules:
//   * only a well-formed `seedmailDesktop` bridge counts as desktop;
//   * a bridge whose worker address is not loopback is refused rather than used;
//   * the bridge is absent unless a preload installed it;
//   * `openExternal` is inert without the bridge.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isDesktop, desktopWorker, openExternal } from '../../frontend/js/lib/runtime.js';

function withWindow(value, run) {
  const previous = globalThis.window;
  globalThis.window = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test('no window means web: not desktop and no worker', () => {
  withWindow(undefined, () => {
    assert.equal(isDesktop(), false);
    assert.equal(desktopWorker(), null);
    assert.equal(openExternal('https://example.com'), false);
  });
});

test('a plain web page that defines an object is not the desktop app', () => {
  withWindow({ seedmailDesktop: { workerUrl: 'http://127.0.0.1:1234' } }, () => {
    assert.equal(isDesktop(), false, 'isDesktop must be true only on the real bridge');
  });
  withWindow({ seedmailDesktop: 'yes' }, () => {
    assert.equal(isDesktop(), false);
  });
});

test('a well-formed bridge exposes the loopback worker and token', () => {
  withWindow(
    {
      seedmailDesktop: {
        isDesktop: true,
        workerUrl: 'http://127.0.0.1:43117/',
        workerToken: 'launch-token',
        appVersion: '3.0.0',
        platform: 'win32',
      },
    },
    () => {
      assert.equal(isDesktop(), true);
      const worker = desktopWorker();
      assert.deepEqual(worker, {
        workerUrl: 'http://127.0.0.1:43117',
        workerToken: 'launch-token',
        appVersion: '3.0.0',
        platform: 'win32',
      });
    },
  );
});

test('a bridge naming a non-loopback worker is refused', () => {
  withWindow(
    { seedmailDesktop: { isDesktop: true, workerUrl: 'https://seedmail-worker.onrender.com', workerToken: 'x' } },
    () => {
      assert.equal(isDesktop(), true, 'the shell is still the desktop app');
      const worker = desktopWorker();
      assert.equal(worker.workerUrl, '', 'a remote worker address must never be trusted');
    },
  );
});

test('a malformed worker URL degrades to an empty address, not a crash', () => {
  withWindow({ seedmailDesktop: { isDesktop: true, workerUrl: 'not a url' } }, () => {
    assert.equal(desktopWorker().workerUrl, '');
  });
  withWindow({ seedmailDesktop: { isDesktop: true, workerUrl: '' } }, () => {
    assert.equal(desktopWorker().workerUrl, '');
  });
});

test('openExternal forwards to the bridge when present', () => {
  const seen = [];
  withWindow(
    { seedmailDesktop: { isDesktop: true, openExternal: (url) => seen.push(url) } },
    () => {
      assert.equal(openExternal('https://accounts.google.com/o/oauth2'), true);
      assert.deepEqual(seen, ['https://accounts.google.com/o/oauth2']);
    },
  );
});
