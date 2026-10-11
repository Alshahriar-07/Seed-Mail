'use strict';

// Seed Code Mail — bundled SMTP worker lifecycle.
//
// The campaign sender is the existing Python worker (`worker/`), frozen with
// PyInstaller into a self-contained Windows executable and shipped inside the
// installer. This module owns the whole lifecycle so the user never has to open
// a terminal, install Python, or launch anything:
//
//   prepare()  copy the worker out of the (read-only) install directory into the
//              user's own application data, where it can persist the App Password
//              the Settings page writes;
//   start()    spawn it bound to loopback with the desktop runtime's credentials;
//   waitReady()poll its health probe until it answers, so dependent features are
//              only enabled once the worker is genuinely up;
//   stop()     terminate exactly the process tree this app created — never a
//              worker someone else started, and never an unrelated process.
//
// The worker is bound to 127.0.0.1 and requires a per-launch pairing token, so
// no other program (and no web page) can drive it even though it is local.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_HEALTH_TIMEOUT_MS = 30000;
const HEALTH_POLL_MS = 500;

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isSymbolicLink()) fs.copyFileSync(fs.realpathSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

function pingHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/worker/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

class WorkerManager {
  /**
   * @param {object} options
   * @param {string} options.sourceDir  directory holding the packaged worker (resources)
   * @param {string} options.dataDir    writable per-user directory to run it from
   * @param {string} options.exeName    executable file name inside sourceDir
   * @param {(line: string) => void} [options.onLog]
   */
  constructor({ sourceDir, dataDir, exeName = 'SeedMailWorker.exe', onLog = () => {} }) {
    this.sourceDir = sourceDir;
    this.dataDir = dataDir;
    this.exeName = exeName;
    this.onLog = onLog;
    this.child = null;
    this.port = 0;
    this.stopping = false;
  }

  get exePath() {
    return path.join(this.dataDir, this.exeName);
  }

  /**
   * Copies the packaged worker into the user's data directory on first run.
   *
   * Running from `%APPDATA%` rather than from `Program Files` is what lets the
   * worker keep its own configuration: the Settings page writes the Gmail App
   * Password next to the executable, and an install directory is read-only for a
   * non-elevated process. An existing copy is left untouched so a saved App
   * Password survives an application update.
   */
  prepare() {
    if (fs.existsSync(this.exePath)) return;
    if (!fs.existsSync(this.sourceDir)) {
      throw new Error(`Bundled worker not found at ${this.sourceDir}. The installation may be incomplete.`);
    }
    this.onLog(`[worker] installing bundled worker into ${this.dataDir}`);
    copyDir(this.sourceDir, this.dataDir);
  }

  /**
   * Starts the worker and resolves once it is healthy.
   *
   * @param {object} options
   * @param {number} options.port
   * @param {Record<string,string>} options.env  extra environment for the process
   */
  async start({ port, env }) {
    this.prepare();
    this.port = port;
    this.stopping = false;

    const child = spawn(this.exePath, [], {
      cwd: this.dataDir,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const forward = (stream, label) => {
      stream.setEncoding('utf8');
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) this.onLog(`[worker:${label}] ${line}`);
      });
    };
    forward(child.stdout, 'out');
    forward(child.stderr, 'err');

    child.on('exit', (code, signal) => {
      this.child = null;
      if (!this.stopping) this.onLog(`[worker] exited unexpectedly (code=${code}, signal=${signal})`);
    });

    const health = await this.waitReady();
    if (!health) {
      throw new Error('The bundled send worker did not become ready in time.');
    }
    return health;
  }

  /** Polls the health endpoint until it answers, or the timeout elapses. */
  async waitReady({ timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) return null; // the process died; no point waiting
      const health = await pingHealth(this.port);
      if (health && health.ok) return health;
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    return null;
  }

  /** True when the worker process is currently alive. */
  get running() {
    return Boolean(this.child);
  }

  /**
   * Stops exactly the worker this application started.
   *
   * On Windows the PyInstaller launcher owns a child interpreter, so the whole
   * tree must be terminated or the real worker is orphaned — `taskkill /T` does
   * that for our PID only. `this.child` is cleared first so the exit handler
   * reports a normal shutdown rather than a crash, and `stopping` guards against
   * the health poll racing the shutdown.
   */
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;

    const pid = child.pid;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      child.once('exit', done);
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
        }
      } catch (_) {
        done();
      }
      setTimeout(done, 5000);
    });
  }
}

module.exports = { WorkerManager, pingHealth };
