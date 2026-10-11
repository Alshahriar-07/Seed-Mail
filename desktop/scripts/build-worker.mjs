// Freezes the existing Python send worker into a self-contained Windows
// executable tree, so the installer can ship it and the user needs no Python.
//
// It reuses the exact choices documented for the standalone agent
// (build-agent.bat), with one change: the output is named SeedMailWorker and
// written under build/worker-dist/, which is what desktop/package.json copies
// into the installer via electron-builder's extraResources.
//
//   --onedir, not --onefile  : no per-start unpack (fast, and far less likely to
//                              trip antivirus heuristics)
//   --collect-all <package>  : FastAPI, uvicorn, pydantic, dotenv, httpx and anyio
//                              import parts of themselves lazily, which static
//                              analysis cannot see
//   --hidden-import worker.*  : worker/ and services/ are on sys.path at runtime,
//                              which PyInstaller cannot follow

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const distRoot = join(projectRoot, 'build', 'worker-dist');
const workRoot = join(projectRoot, 'build', 'worker-build');

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function run(args) {
  const result = spawnSync(python, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) {
    console.error(`[worker] could not run ${python}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[worker] command failed: ${python} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }
}

// 1. PyInstaller
const havePyInstaller = spawnSync(python, ['-c', 'import PyInstaller'], { cwd: projectRoot });
if (havePyInstaller.status !== 0) {
  console.log('[worker] PyInstaller not found — installing it');
  run(['-m', 'pip', 'install', 'pyinstaller']);
}

// 2. Runtime dependencies
console.log('[worker] installing requirements.txt');
run(['-m', 'pip', 'install', '-r', 'requirements.txt']);

mkdirSync(distRoot, { recursive: true });
mkdirSync(workRoot, { recursive: true });

// 3. Freeze
const args = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean', '--onedir',
  '--name', 'SeedMailWorker',
  '--distpath', distRoot,
  '--workpath', workRoot,
  '--specpath', workRoot,
  '--paths', '.',
  '--hidden-import', 'worker',
  '--hidden-import', 'worker.main',
  '--hidden-import', 'worker.queue_worker',
  '--hidden-import', 'worker.sender',
  '--hidden-import', 'worker.campaign_queue',
  '--hidden-import', 'worker.supabase_client',
  '--hidden-import', 'worker.settings_overrides',
  '--hidden-import', 'worker.auth',
  '--hidden-import', 'worker.security',
  '--hidden-import', 'worker.config',
  '--hidden-import', 'services',
  '--collect-all', 'fastapi',
  '--collect-all', 'starlette',
  '--collect-all', 'uvicorn',
  '--collect-all', 'pydantic',
  '--collect-all', 'dotenv',
  '--collect-all', 'httpx',
  '--collect-all', 'anyio',
  '--collect-all', 'ssl',
  join('worker', 'main.py'),
];

console.log('[worker] freezing with PyInstaller…');
run(args);

const exe = join(distRoot, 'SeedMailWorker', process.platform === 'win32' ? 'SeedMailWorker.exe' : 'SeedMailWorker');
if (!existsSync(exe)) {
  console.error(`[worker] expected ${exe} to exist but it does not.`);
  process.exit(1);
}
console.log(`[worker] built ${exe}`);
