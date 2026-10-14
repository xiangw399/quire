/**
 * Start the desktop app with a debugging port, so a verifier can drive it.
 *
 * Two traps this exists to close, both of which cost real time to find:
 *  - `ELECTRON_RUN_AS_NODE` in the environment turns the Electron binary into a plain
 *    Node process, which exits immediately and writes nothing at all. DSH sets that
 *    variable for the commands it runs, so it is removed from the child's environment.
 *  - The app needs its own profile. Sharing one with a copy the user already has open
 *    trips the single-instance lock, and the second launch hands its document over and
 *    quits — which reads as "the app did not start".
 *
 * Usage:
 *   node tools/launch-app.mjs [--port 9333] [--document <file>] [--exe <path>]
 *                             [--profile <dir>] [--timeout 30000] [--stop]
 *
 * `--exe` names a packaged build to launch on its own. Without it the vendored Electron
 * runtime runs this checkout as a development app, which is what `npm run desktop` does.
 * `--stop` ends the instance this tool started last, found through the profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** Read `--name value`, falling back to the environment and then a default. */
function option(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const port = Number(option('port', process.env.DSH_VIEWER_CDP_PORT ?? 9333));
const profile = path.resolve(option('profile', process.env.DSH_VIEWER_PROFILE ?? path.join(os.tmpdir(), `quire-${port}`)));
const exe = option('exe', process.env.DSH_VIEWER_EXE ?? '');
const document = option('document', process.env.DSH_VIEWER_DOCUMENT ?? '');
const timeout = Number(option('timeout', 30000));
const pidFile = path.join(profile, 'launcher.pid');

/** The environment a child needs, with the Node-mode switch taken out. */
function childEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

function stop() {
  if (!fs.existsSync(pidFile)) {
    console.log('[launch] no instance recorded for this profile');
    return 0;
  }
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  killTree(pid);
  fs.rmSync(pidFile, { force: true });
  console.log(`[launch] stopped pid ${pid}`);
  return 0;
}

async function reachable() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

if (argv.includes('--stop')) process.exit(stop());

fs.mkdirSync(profile, { recursive: true });

if (await reachable()) {
  console.log(`[launch] an app is already answering on port ${port}`);
  process.exit(0);
}

const target = exe === ''
  ? path.join(projectRoot, 'runtime', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
  : path.resolve(exe);
if (!fs.existsSync(target)) {
  console.error(`[launch] no executable at ${target}`);
  process.exit(1);
}

const switches = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
if (document !== '') switches.push(path.resolve(document));
// A packaged build boots the app it carries; the vendored runtime needs the checkout.
if (exe === '') switches.push(projectRoot);

const child = spawn(target, switches, { detached: true, stdio: 'ignore', env: childEnv() });
child.unref();
fs.writeFileSync(pidFile, String(child.pid), 'utf8');
console.log(`[launch] pid ${child.pid}  exe ${target}`);
console.log(`[launch] profile ${profile}`);
console.log(`[launch] endpoint http://127.0.0.1:${port}/json/version`);

const deadline = Date.now() + timeout;
let up = false;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode !== null) break;
  if (await reachable()) {
    up = true;
    break;
  }
}

if (!up) {
  console.error('[launch] the app did not answer on its debugging port');
  console.error('[launch] a launched process that exits at once usually means the Electron');
  console.error('[launch] binary ran as Node (ELECTRON_RUN_AS_NODE) or that its directory');
  console.error('[launch] cannot host Chromium; the app writes its own trace to');
  console.error(`[launch]   ${path.join(profile, 'boot.log')}`);
  process.exit(1);
}

console.log(`[launch] ready in ${timeout - (deadline - Date.now())} ms; stop it with --stop`);
process.exit(0);
