'use strict';

// Seed Code Mail — desktop preload bridge.
//
// This is the ONLY channel between the app page and the desktop shell. It runs
// with context isolation on and Node integration off, so the page cannot reach
// the filesystem, `require`, or any Electron module — it sees exactly the four
// read-only values and one function below.
//
// The values come from the main process synchronously (`sendSync`) so the page's
// modules can read them during their own import, before the first render. The
// pairing token is scoped to this launch: it authorises this window against the
// loopback worker and is meaningless anywhere else. It is never written to
// storage, never logged, and never rendered.
//
// `openExternal` only ever opens https URLs on a small allow-list, enforced again
// in the main process — a page cannot use it to launch an arbitrary target.

const { contextBridge, ipcRenderer } = require('electron');

let ctx = {};
try {
  ctx = ipcRenderer.sendSync('seedmail:context') || {};
} catch (_) {
  ctx = {};
}

contextBridge.exposeInMainWorld('seedmailDesktop', {
  isDesktop: true,
  workerUrl: String(ctx.workerUrl || ''),
  workerToken: String(ctx.workerToken || ''),
  appVersion: String(ctx.appVersion || ''),
  platform: String(ctx.platform || ''),
  openExternal: (url) => ipcRenderer.invoke('seedmail:open-external', String(url == null ? '' : url)),
});
