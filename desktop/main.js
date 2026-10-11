'use strict';

// Seed Code Mail — Electron main process.
//
// Responsibilities, and the reason each one lives here rather than in the page:
//
//   * **Credentials.** The Supabase service-role key is read from an OS-encrypted
//     store (lib/config-store.js) and handed to the worker as an environment
//     variable. It is never sent to the renderer.
//   * **The bundled worker.** Started, health-checked and stopped here
//     (lib/worker-manager.js), so a page cannot start or stop local processes and
//     a crash is handled by the shell, not by UI code.
//   * **The local origin.** The built UI is served from a loopback HTTP server
//     that also proxies `/api/…` to the deployed backend (lib/local-server.js),
//     so the frontend is byte-for-byte the web build and still reaches the cloud
//     API on its own origin.
//   * **The desktop bridge.** preload.js exposes exactly the worker address, the
//     per-launch pairing token and an "open in browser" call. Nothing else.
//
// What the app deliberately does NOT do: embed any cloud API key, load arbitrary
// remote content into a privileged window, or treat the presence of a bridge as
// proof of identity. Every authenticated call still carries the user's Supabase
// bearer token, verified server-side.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getFreePort } = require('./lib/ports.js');
const {
  loadConfig, saveConfig, isConfigured, normalise, publicDefaults, encryptionAvailable,
} = require('./lib/config-store.js');
const { startLocalServer } = require('./lib/local-server.js');
const { WorkerManager } = require('./lib/worker-manager.js');

const APP_VERSION = require('./package.json').version;
const ALLOWED_EXTERNAL_HOSTS = new Set(['accounts.google.com', 'mrseedmail.vercel.app', 'google.com']);

// --- runtime state ----------------------------------------------------------

let mainWindow = null;
let workerManager = null;
let localServer = null;
let config = null;
let context = { workerUrl: '', workerToken: '', appVersion: APP_VERSION, platform: process.platform };
let shuttingDown = false;
let quitArmed = false;

// --- paths ------------------------------------------------------------------

function appDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..', 'dist');
}

function workerSourceDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'worker')
    : path.join(__dirname, '..', 'build', 'worker-dist', 'SeedMailWorker');
}

function workerDataDir() {
  return path.join(app.getPath('userData'), 'worker');
}

function logFile() {
  return path.join(app.getPath('userData'), 'logs', 'desktop.log');
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  // eslint-disable-next-line no-console
  console.log(text);
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `${text}\n`, 'utf8');
  } catch (_) {
    // Logging must never take the app down.
  }
}

// --- security for outbound/browser navigation --------------------------------

function isAllowedExternal(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (ALLOWED_EXTERNAL_HOSTS.has(host)) return true;
    // The configured deployed origin (covers the beta/prod hosts).
    try {
      if (host === new URL(config?.vercelOrigin || '').hostname) return true;
    } catch (_) { /* unset */ }
    return host.endsWith('.google.com');
  } catch (_) {
    return false;
  }
}

function hardenWindow(win, pageOrigin) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (pageOrigin && url.startsWith(pageOrigin)) return;
    event.preventDefault();
    if (isAllowedExternal(url)) shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[renderer] process gone: ${details.reason}`);
  });
}

// --- startup ----------------------------------------------------------------

/**
 * Starts the local UI server and the bundled worker, then loads the app.
 *
 * If the worker fails to become ready the application still opens: cloud-only
 * features (Inbox, Compose, recipients, templates, history) do not need it, and
 * the UI reports the worker as unavailable rather than pretending otherwise.
 */
async function startRuntime(win) {
  if (!win || win.isDestroyed()) {
    win = createWindow({ setup: false });
    mainWindow = win;
  }
  const workerToken = crypto.randomBytes(24).toString('base64url');
  const workerPort = await getFreePort();
  const pagePort = await getFreePort();
  const pageOrigin = `http://127.0.0.1:${pagePort}`;

  try {
    const started = await startLocalServer({
      port: pagePort,
      root: appDir(),
      proxyOrigin: config.vercelOrigin,
    });
    localServer = started.server;
    log(`[ui] serving ${appDir()} at ${started.url} (cloud API -> ${config.vercelOrigin})`);
  } catch (error) {
    dialog.showErrorBox('Seed Code Mail', `Could not start the local application server.\n\n${error.message}`);
    return;
  }

  let workerReady = false;
  workerManager = new WorkerManager({
    sourceDir: workerSourceDir(),
    dataDir: workerDataDir(),
    onLog: log,
  });
  try {
    const health = await workerManager.start({
      port: workerPort,
      env: {
        SUPABASE_URL: config.supabaseUrl,
        SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
        SUPABASE_SERVICE_ROLE_KEY: config.supabaseServiceRoleKey,
        WORKER_HOST: '127.0.0.1',
        WORKER_PORT: String(workerPort),
        WORKER_ALLOWED_ORIGINS: pageOrigin,
        WORKER_AGENT_TOKEN: workerToken,
        WORKER_QUEUE_CONSUMER: '1',
        WORKER_ID: `seedmail-desktop-${os.hostname()}-${process.pid}`,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    workerReady = true;
    log(
      `[worker] ready on 127.0.0.1:${workerPort} ` +
        `(auth=${health.auth_configured}, smtp=${health.smtp_configured}, queue=${health.queue_consumer_configured})`,
    );
  } catch (error) {
    log(`[worker] failed to start: ${error.message}`);
  }

  // Only hand the renderer a worker address once it is genuinely ready.
  context = {
    workerUrl: workerReady ? `http://127.0.0.1:${workerPort}` : '',
    workerToken: workerReady ? workerToken : '',
    appVersion: APP_VERSION,
    platform: process.platform,
  };

  hardenWindow(win, pageOrigin);
  await win.loadURL(pageOrigin);
  return { pageOrigin, workerReady };
}

function createWindow({ setup = false } = {}) {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1720',
    title: 'Seed Code Mail',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, setup ? 'preload-setup.js' : 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (setup) {
    hardenWindow(win, 'file://');
    win.loadFile(path.join(__dirname, 'setup.html'));
  }
  return win;
}

async function openSetupAndRestart(win) {
  if (win) {
    hardenWindow(win, 'file://');
    await win.loadFile(path.join(__dirname, 'setup.html'));
  }
}

// --- IPC --------------------------------------------------------------------

function registerIpc() {
  // Synchronous: the preload must install the bridge before the page's modules
  // run, and runtime.js reads it synchronously. Only non-secret values cross.
  ipcMain.on('seedmail:context', (event) => {
    event.returnValue = context;
  });

  ipcMain.handle('seedmail:open-external', async (_event, url) => {
    if (!isAllowedExternal(url)) return false;
    await shell.openExternal(String(url));
    return true;
  });

  ipcMain.handle('seedmail:setup:load', () => {
    const defaults = publicDefaults();
    return {
      supabaseUrl: config?.supabaseUrl || defaults.supabaseUrl,
      supabasePublishableKey: config?.supabasePublishableKey || defaults.supabasePublishableKey,
      supabaseServiceRoleKeySet: Boolean(config?.supabaseServiceRoleKey),
      vercelOrigin: config?.vercelOrigin || defaults.vercelOrigin,
      encryptionAvailable: encryptionAvailable(),
      configPath: path.join(app.getPath('userData'), 'desktop-config.json'),
    };
  });

  ipcMain.handle('seedmail:setup:save', async (_event, input) => {
    const saved = saveConfig({
      supabaseUrl: input?.supabaseUrl,
      supabasePublishableKey: input?.supabasePublishableKey,
      // An empty service-role field means "keep the stored one" so re-opening
      // the form to fix the URL cannot silently wipe the secret.
      supabaseServiceRoleKey: String(input?.supabaseServiceRoleKey || '').trim() || config?.supabaseServiceRoleKey || '',
      vercelOrigin: input?.vercelOrigin,
    });
    config = saved;
    if (!isConfigured(config)) {
      return { ok: false, error: 'All three Supabase values are required (URL, publishable key, service-role key).' };
    }

    const win = mainWindow;
    if (workerManager) await workerManager.stop();
    if (localServer) { try { localServer.close(); } catch (_) {} localServer = null; }
    await startRuntime(win);
    return { ok: true };
  });

  ipcMain.handle('seedmail:setup:cancel', () => {
    if (isConfigured(config)) {
      if (mainWindow) startRuntime(mainWindow);
      return { ok: true };
    }
    app.quit();
    return { ok: false };
  });
}

// --- application lifecycle ---------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Seed Code Mail',
      submenu: [
        { label: 'Configure worker…', click: () => openSetupAndRestart(mainWindow) },
        { label: 'Open application log', click: () => shell.openPath(path.dirname(logFile())) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'editMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[app] shutting down');
  if (workerManager) await workerManager.stop();
  if (localServer) {
    try { localServer.close(); } catch (_) {}
    localServer = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    registerIpc();
    buildMenu();

    log(`[app] Seed Code Mail desktop ${APP_VERSION} starting (configured=${isConfigured(config)})`);

    mainWindow = createWindow({ setup: !isConfigured(config) });
    if (isConfigured(config)) {
      await startRuntime(mainWindow);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitArmed) return;
    event.preventDefault();
    quitArmed = true;
    shutdown().finally(() => app.quit());
  });
}

module.exports = { isAllowedExternal };
