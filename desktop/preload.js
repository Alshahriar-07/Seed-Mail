'use strict';

// Seed Code Mail — desktop preload bridge.
//
// This is the ONLY channel between the deployed application and the desktop
// shell. It runs with context isolation on, Node integration off and the sandbox
// enabled, so the page cannot reach the filesystem, `require`, or any Electron
// module — it sees exactly the handful of read-only values and one function
// below.
//
// The values come from the main process synchronously (`sendSync`) so the page's
// modules can read them during their own import, before the first render.
//
// **Origin gating.** The window is also used for Google's OAuth pages during
// sign-in. A preload runs in those frames too, so the worker address and the
// per-launch pairing token are withheld unless the frame is the deployed
// application itself. The main process enforces the same rule independently
// (`seedmail:context`), so a spoofed value in the page cannot lift it.
//
// `openExternal` only ever opens https/mailto targets on an allow-list, enforced
// again in the main process — a page cannot use it to launch an arbitrary
// target.

const { contextBridge, ipcRenderer } = require('electron');

let ctx = {};
try {
  ctx = ipcRenderer.sendSync('seedmail:context') || {};
} catch (_) {
  ctx = {};
}

const CLOUD_ORIGIN = String(ctx.cloudOrigin || '');
let trusted = false;
try {
  trusted = Boolean(CLOUD_ORIGIN) && window.location.origin === CLOUD_ORIGIN;
} catch (_) {
  trusted = false;
}

// A no-op stand-in for the auth bridge when this frame is not the application, so
// the page's modules always find the same shape and never fall back to an
// in-window Google redirect.
const unavailable = () => Promise.resolve({ ok: false, error: 'untrusted-frame' });

contextBridge.exposeInMainWorld('seedmailDesktop', {
  isDesktop: true,
  cloudOrigin: CLOUD_ORIGIN,
  workerUrl: trusted ? String(ctx.workerUrl || '') : '',
  workerToken: trusted ? String(ctx.workerToken || '') : '',
  appVersion: String(ctx.appVersion || ''),
  platform: String(ctx.platform || ''),
  openExternal: (url) => ipcRenderer.invoke('seedmail:open-external', String(url == null ? '' : url)),

  // OAuth support. The authorisation URL is opened by the operating system (never
  // in this window), and the code that comes back on the loopback listener is
  // handed to the page so *it* can perform Supabase's PKCE exchange, where its
  // code verifier lives. Only the single-use code crosses this boundary.
  beginAuthCallback: trusted ? () => ipcRenderer.invoke('seedmail:auth:begin') : unavailable,
  cancelAuthCallback: trusted ? () => ipcRenderer.invoke('seedmail:auth:cancel') : unavailable,
  onAuthCallback: trusted
    ? (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => {
        try {
          handler(payload && typeof payload === 'object' ? payload : {});
        } catch (_) {
          // A throwing page handler must not take the shell's listener down.
        }
      };
      ipcRenderer.on('seedmail:auth:callback', listener);
      return () => ipcRenderer.removeListener('seedmail:auth:callback', listener);
    }
    : () => () => {},
});
