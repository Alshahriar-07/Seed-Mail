'use strict';

// Seed Code Mail — Electron main process.
//
// The desktop application is a **thin, hardened shell around the deployed
// application**, plus the optional bundled SMTP worker:
//
//   * The window loads the existing production site
//     (https://mrseedmail.vercel.app/ — override with SEEDMAIL_CLOUD_ORIGIN). The
//     frontend and the Vercel `api/` backend are the deployed ones, so the
//     desktop build can never drift from the web build and no frontend copy is
//     bundled. There is no first-run configuration form: nothing is asked of the
//     user and no credential is typed into a setup screen.
//
//   * The campaign sender is the same Python worker the repository ships
//     (`worker/`, frozen with PyInstaller). It is started here — bound to
//     127.0.0.1, behind a per-launch pairing token — so a campaign can be
//     delivered from this computer with the user's own Gmail App Password, with
//     no Python installed and no terminal. If it cannot start, the cloud features
//     are unaffected: they are served by Supabase and the Gmail API.
//
// Why the privileged parts live here and not in the page: the page is remote
// content. It must never be able to start processes, read the filesystem, or
// reach an unrestricted local service. It receives exactly three things — the
// loopback worker address, the pairing token for this launch, and an
// "open in the browser" call whose targets are allow-listed here. Every
// state-changing worker request still carries the user's own Supabase access
// token, which the worker verifies against Supabase Auth.
//
// Security posture, all deliberate:
//   * contextIsolation on, nodeIntegration off, sandbox on, webSecurity on;
//   * navigation is restricted to the application origin, the Supabase project
//     (the OAuth handshake) and Google's sign-in hosts — everything else opens
//     in the user's real browser;
//   * `window.open` and `<webview>` are refused;
//   * the pairing token is handed to the application origin **only** — never to
//     Google's pages, which the same window visits mid sign-in;
//   * no Supabase service-role key, Google client secret or Gmail App Password is
//     ever compiled into the application or the installer. A privileged worker
//     credential can only be provisioned out of band, by the organisation that
//     owns the deployment, and is never requested from the end user.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getFreePort } = require('./lib/ports.js');
const { loadConfig, publicDefaults, configFilePath } = require('./lib/config-store.js');
const { AuthCallbackListener, CALLBACK_URI } = require('./lib/auth-callback.js');
const {
  isAllowedExternal: policyAllowsExternal,
  isExternalOnlyUrl: policyExternalOnly,
  isTrustedNavigation: policyTrustsNavigation,
} = require('./lib/navigation-policy.js');
const { WorkerManager } = require('./lib/worker-manager.js');

const APP_VERSION = require('./package.json').version;

/** The deployed application this shell presents. Not a secret, not user-editable. */
const CLOUD_ORIGIN = String(process.env.SEEDMAIL_CLOUD_ORIGIN || 'https://mrseedmail.vercel.app')
  .trim()
  .replace(/\/+$/, '');
const CLOUD_HOME = `${CLOUD_ORIGIN}/`;

// --- OAuth ------------------------------------------------------------------
//
// Google sign-in is completed in the user's OWN browser, never in this window:
//
//   * an application window has its own cookie jar, so the person's existing
//     Chrome/Edge Google session is unavailable and they would have to sign in to
//     Google again from scratch;
//   * rendering a third-party identity page inside the privileged shell is more
//     surface, not more convenience. contextIsolation, sandbox and webSecurity
//     stay on; nothing is weakened to make a redirect work.
//
// The flow, all of it verified end to end below:
//
//   1. the page asks for `seedmail:auth:begin`; this process opens a one-shot
//      HTTP listener on exactly AUTH_CALLBACK_URI;
//   2. the page asks Supabase for the authorisation URL with
//      `skipBrowserRedirect`, using that exact URL as `redirectTo`, and hands the
//      URL back here;
//   3. `shell.openExternal` opens it in the system default browser, which has the
//      person's Google session and its account chooser;
//   4. Google returns to Supabase, which redirects to the loopback URL. The
//      listener delivers the single-use code to the page, which performs
//      Supabase's own PKCE exchange (its code verifier is in that window's
//      storage), and the session is established in the application.
//
// The exact URL is a FIXED one on purpose: Supabase validates `redirect_to`
// against the project's allowed Redirect URLs, so a random port could not be
// allow-listed. It must be added there verbatim.

/** The one loopback URL Google's redirect has to reach (lib/auth-callback.js). */
const AUTH_CALLBACK_URI = CALLBACK_URI;


// --- runtime state ----------------------------------------------------------

let mainWindow = null;
let workerManager = null;
let context = { workerUrl: '', workerToken: '', appVersion: APP_VERSION, platform: process.platform, cloudOrigin: CLOUD_ORIGIN };
let shuttingDown = false;
let quitArmed = false;
let offlineShown = false;
let authCallback = null;

// --- paths ------------------------------------------------------------------

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

// --- navigation policy ------------------------------------------------------

/** Hostname of the Supabase project, taken from the public build config. */
let supabaseHostCache = '';
function supabaseHostname() {
  if (supabaseHostCache) return supabaseHostCache;
  try {
    supabaseHostCache = new URL(String(publicDefaults().supabaseUrl || '')).hostname.toLowerCase();
  } catch (_) {
    supabaseHostCache = '';
  }
  return supabaseHostCache;
}

/** The policy's inputs: this deployment's own origin and Supabase project. */
function policyContext() {
  return { cloudOrigin: CLOUD_ORIGIN, supabaseHost: supabaseHostname() };
}

function isCloudOrigin(rawUrl) {
  try {
    return new URL(String(rawUrl)).origin === CLOUD_ORIGIN;
  } catch (_) {
    return false;
  }
}

// The rules themselves live in lib/navigation-policy.js (pure, tested). These
// bind them to this deployment's origin and Supabase project.
function isExternalOnlyUrl(rawUrl) {
  return policyExternalOnly(rawUrl, policyContext());
}

function isTrustedNavigation(rawUrl) {
  return policyTrustsNavigation(rawUrl, policyContext());
}

function isAllowedExternal(rawUrl) {
  return policyAllowsExternal(rawUrl, policyContext());
}

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    if (isTrustedNavigation(url)) {
      // Only the origin and path are logged — an OAuth URL carries a client id,
      // a redirect URI and sometimes a fragment, none of which belong in a log.
      try {
        const parsed = new URL(url);
        log(`[ui] navigating to ${parsed.origin}${parsed.pathname}`);
      } catch (_) { /* not logged */ }
      return;
    }
    event.preventDefault();
    if (isAllowedExternal(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  // OAuth goes through HTTP redirects (Supabase → Google → Supabase), so the
  // redirect chain needs the same policy as an explicit navigation.
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[renderer] process gone: ${details.reason}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal redirect produces; it is not a failure.
    if (!isMainFrame || errorCode === -3) return;
    log(`[ui] load failed for ${validatedURL}: ${errorDescription} (${errorCode})`);
    showOffline(win, errorDescription);
  });
  win.webContents.on('did-finish-load', () => {
    offlineShown = false;
    try {
      const url = new URL(win.webContents.getURL());
      log(`[ui] loaded ${url.origin}${url.pathname}`);
    } catch (_) {
      // A non-URL document (the offline page) needs no log line.
    }
  });
}

function showOffline(win, reason) {
  if (!win || win.isDestroyed() || offlineShown) return;
  offlineShown = true;
  win.loadFile(path.join(__dirname, 'offline.html'), {
    query: { origin: CLOUD_ORIGIN, reason: String(reason || '') },
  }).catch((error) => log(`[ui] could not show the offline page: ${error.message}`));
}

// --- window -----------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#101010',
    title: 'Seed Code Mail',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // The application's own origin does not need Node, but it does need to be
      // recognised as a first-class window for links and popups.
      safeDialogs: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  hardenWindow(win);
  return win;
}

// --- OAuth callback listener ------------------------------------------------
//
// The listener itself lives in lib/auth-callback.js (loopback-only bind, Host
// header check, single delivery, TTL) so it can be exercised as a unit. Here it is
// only wired to the application window.

/** Closes the listener if one is open. Safe to call at any time. */
function stopAuthCallbackServer() {
  if (authCallback) authCallback.stop();
}

/**
 * Opens the single-use loopback listener and returns the exact URL Supabase must
 * redirect to. The delivered code is forwarded to the application window, which
 * performs Supabase's PKCE exchange — the code verifier never leaves that window,
 * and the code itself is never logged.
 */
async function beginAuthCallback() {
  if (!authCallback) {
    authCallback = new AuthCallbackListener({
      onLog: log,
      onDeliver: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('seedmail:auth:callback', payload);
        }
      },
    });
  }
  return authCallback.begin();
}

// --- worker -----------------------------------------------------------------

/**
 * Starts the bundled SMTP worker and resolves with its health payload, or null.
 *
 * The worker is started with the **public** Supabase values compiled into the
 * desktop build (project URL + publishable/anon key — the same values the web
 * bundle ships). A privileged credential is deliberately absent: it cannot be
 * shipped, and the application never asks the user for one. When an
 * organisation has provisioned one out of band (the encrypted desktop config
 * written by an administrator, or `SUPABASE_SERVICE_ROLE_KEY` in the process
 * environment) the worker additionally claims queued campaigns; without it the
 * worker still runs, verifies signed-in users, stores SMTP settings and can
 * deliver nothing until the deployment provides a sender.
 *
 * The worker is bound to loopback and gated by a per-launch pairing token, so no
 * other program and no other web page can drive it.
 */
/**
 * Asks Supabase whether a privileged key is still accepted.
 *
 * A worker given a key that Supabase rejects does not fail loudly: it retries the
 * queue in a tight loop and logs a 401 every second or so, which looks like a
 * broken application rather than a stale credential. Probing once — a single
 * cheap REST request — turns that into one clear line at startup and lets the
 * worker run without the privileged capability instead.
 *
 * Returns `true` (accepted), `false` (rejected) or `null` when the answer could
 * not be determined (offline, timeout). `null` deliberately keeps the key: a
 * credential that cannot be disproved must never be discarded, because the
 * machine may simply be offline.
 */
async function probePrivilegedKey(supabaseUrl, key, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    return response.status !== 401 && response.status !== 403;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startWorker(win) {
  const workerToken = crypto.randomBytes(24).toString('base64url');
  const workerPort = await getFreePort();
  const publicConfig = publicDefaults();
  const provisions = loadConfig();
  const supabaseUrl = String(provisions.supabaseUrl || publicConfig.supabaseUrl || '').trim();
  const publishableKey = String(provisions.supabasePublishableKey || publicConfig.supabasePublishableKey || '').trim();
  let serviceRoleKey = String(provisions.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  // Never hand the worker a key Supabase has already refused. The value itself is
  // never logged — only the outcome.
  if (serviceRoleKey) {
    const usable = await probePrivilegedKey(supabaseUrl, serviceRoleKey);
    if (usable === false) {
      log('[worker] the stored privileged credential was rejected by Supabase and will not be used; ' +
        'campaign claiming is disabled (remove desktop-config.json or provision a current key to enable it).');
      serviceRoleKey = '';
    } else if (usable === null) {
      log('[worker] could not verify the stored privileged credential (offline); using it as provisioned.');
    }
  }

  if (!supabaseUrl || !publishableKey) {
    log('[worker] skipped: the desktop build has no public Supabase URL/publishable key (run scripts/public-config.mjs).');
    context = { ...context, workerUrl: '', workerToken: '' };
    return null;
  }

  workerManager = new WorkerManager({
    sourceDir: workerSourceDir(),
    dataDir: workerDataDir(),
    onLog: log,
  });

  const env = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    WORKER_HOST: '127.0.0.1',
    WORKER_PORT: String(workerPort),
    // The page that may call the worker is the deployed application (any browser
    // it is open in) and the loopback shell itself. The worker checks the Origin
    // header and refuses anything else with 403.
    WORKER_ALLOWED_ORIGINS: `${CLOUD_ORIGIN},http://127.0.0.1,http://localhost`,
    WORKER_AGENT_TOKEN: workerToken,
    WORKER_QUEUE_CONSUMER: '1',
    WORKER_ID: `seedmail-desktop-${os.hostname()}-${process.pid}`,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (serviceRoleKey) env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;

  try {
    const health = await workerManager.start({ port: workerPort, env });
    log(
      `[worker] ready on 127.0.0.1:${workerPort} ` +
        `(auth=${health.auth_configured}, smtp=${health.smtp_configured}, ` +
        `campaigns=${Boolean(serviceRoleKey)}, queue=${health.queue_consumer_configured})`,
    );
    // Only hand the renderer a worker address once it is genuinely ready.
    context = { ...context, workerUrl: `http://127.0.0.1:${workerPort}`, workerToken };
    return health;
  } catch (error) {
    log(`[worker] failed to start: ${error.message}`);
    if (workerManager) await workerManager.stop();
    workerManager = null;
    context = { ...context, workerUrl: '', workerToken: '' };
    return null;
  }
}

// --- IPC --------------------------------------------------------------------

/**
 * True when the requesting frame is the deployed application itself.
 *
 * The bridge is installed by the preload in every frame the window loads, which
 * includes Google's sign-in pages during the OAuth handshake. Those must not
 * receive the local worker's pairing token, so both the main process (here) and
 * the preload check the requesting frame's origin against the application origin.
 */
function isTrustedFrame(event) {
  try {
    const url = event.senderFrame?.url || event.sender.getURL();
    return new URL(url).origin === CLOUD_ORIGIN;
  } catch (_) {
    return false;
  }
}

function registerIpc() {
  // Synchronous: the preload must install the bridge before the page's modules
  // run, and runtime.js reads it synchronously. Only non-secret values cross; the
  // pairing token is added only for the application's own origin.
  ipcMain.on('seedmail:context', (event) => {
    const trusted = isTrustedFrame(event);
    event.returnValue = trusted
      ? { ...context, isDesktop: true }
      : { isDesktop: true, cloudOrigin: CLOUD_ORIGIN, appVersion: APP_VERSION, platform: process.platform, workerUrl: '', workerToken: '' };
  });

  ipcMain.handle('seedmail:open-external', async (_event, url) => {
    if (!isAllowedExternal(url)) return false;
    await shell.openExternal(String(url));
    return true;
  });

  // OAuth. Both are refused for any frame that is not the application itself, so
  // a page loaded mid-handshake cannot open listeners in this shell.
  ipcMain.handle('seedmail:auth:begin', async (event) => {
    if (!isTrustedFrame(event)) return { ok: false, error: 'untrusted-frame' };
    try {
      return await beginAuthCallback();
    } catch (error) {
      // The message is safe to log; it never contains a code or a token.
      log(`[auth] could not open the sign-in return listener: ${error.message}`);
      stopAuthCallbackServer();
      return { ok: false, error: 'callback_unavailable' };
    }
  });

  ipcMain.handle('seedmail:auth:cancel', (event) => {
    if (!isTrustedFrame(event)) return { ok: false, error: 'untrusted-frame' };
    stopAuthCallbackServer();
    return { ok: true };
  });
}

// --- menu -------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Seed Code Mail',
      submenu: [
        { label: `Version ${APP_VERSION}`, enabled: false },
        { type: 'separator' },
        { label: 'Open application log', click: () => shell.openPath(path.dirname(logFile())) },
        { label: 'Open worker folder', click: () => shell.openPath(workerDataDir()) },
        { label: 'Open desktop config location', click: () => shell.showItemInFolder(configFilePath()) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Seed Code Mail on the web',
          click: () => shell.openExternal(CLOUD_HOME),
        },
        {
          label: 'Gmail App Password help',
          click: () => shell.openExternal('https://myaccount.google.com/apppasswords'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle --------------------------------------------------------------

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[app] shutting down');
  // A pending sign-in must not leave a listener bound, and a window is not kept
  // alive by one.
  stopAuthCallbackServer();
  // Stops only the worker this application started (its own process tree), so a
  // worker the user started elsewhere is never touched and none is orphaned.
  if (workerManager) await workerManager.stop();
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
    registerIpc();
    buildMenu();
    log(`[app] Seed Code Mail desktop ${APP_VERSION} starting (cloud=${CLOUD_ORIGIN})`);

    mainWindow = createWindow();

    // The worker starts in parallel with the page: the cloud application is fully
    // usable without it, so a worker failure must not delay or block the UI.
    const workerPromise = startWorker(mainWindow).catch((error) => {
      log(`[worker] unexpected failure: ${error.message}`);
      return null;
    });

    try {
      await mainWindow.loadURL(CLOUD_HOME);
    } catch (error) {
      log(`[ui] could not load ${CLOUD_HOME}: ${error.message}`);
      showOffline(mainWindow, error.message);
    }

    await workerPromise.catch(() => {});
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitArmed) return;
    event.preventDefault();
    quitArmed = true;
    shutdown().finally(() => app.quit());
  });
}

module.exports = { isTrustedNavigation, isAllowedExternal, isExternalOnlyUrl, CLOUD_ORIGIN, AUTH_CALLBACK_URI };

