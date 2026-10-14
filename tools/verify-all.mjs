/**
 * Run every check against a running desktop app, in one command.
 *
 * The checks are ordinary npm scripts; this owns only the order and the reporting, so
 * each of them still runs on its own. The app is launched first unless one already
 * answers on the port, and `--sync` mirrors the current source and build into a
 * packaged host before launching it — which is how this checkout is verified without
 * repackaging a release for every change.
 *
 * Usage:
 *   node tools/verify-all.mjs [--port 9333] [--exe <path>] [--sync <packaged-dir>]
 *                             [--large] [--no-launch]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const flag = (name) => argv.includes(`--${name}`);

const port = Number(option('port', process.env.DSH_VIEWER_CDP_PORT ?? 9333));
const exe = option('exe', process.env.DSH_VIEWER_EXE ?? '');
// `--sync <packaged-dir>` mirrors this checkout into that host before launching it.
const sync = option('sync', process.env.DSH_VIEWER_SYNC ?? '');

/** Mirror one directory, so a host runs exactly this checkout's build. */
function mirror(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`[verify] synced ${path.relative(projectRoot, from) || from} -> ${to}`);
}

if (sync !== '') {
  const appDir = path.join(path.resolve(sync), 'resources', 'app');
  if (!fs.existsSync(appDir)) {
    console.error(`[verify] ${appDir} is not a packaged app directory`);
    process.exit(2);
  }  mirror(path.join(projectRoot, 'src'), path.join(appDir, 'src'));
  mirror(path.join(projectRoot, 'dist', 'web'), path.join(appDir, 'dist', 'web'));
  // A running copy holds the previous code, so it is stopped rather than reused: the
  // sync is exactly the change these checks are meant to see.
  run('stop the previous app', process.execPath, ['tools/launch-app.mjs', '--port', String(port), '--stop']);
  // A copy this tool did not start has no pid to stop, and testing *it* would mean
  // testing the code that was there before the sync. Refusing is the only honest move.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (await running()) {
    console.error(`[verify] an app this tool did not start is still answering on port ${port}`);
    console.error('[verify] close it, or pass another --port: the checks would otherwise run against that copy');
    process.exit(2);
  }
}

/** Run one command with inherited stdio: no pipes, so a confined host can run it too. */
function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', env: { ...process.env } });
  const code = result.status ?? 1;
  console.log(`=== ${label}: exit ${code} ===`);
  return { label, code };
}

async function running() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch {
    return false;
  }
}

const results = [];
results.push(run('unit and contract tests', process.execPath, ['--test', 'tools/unit.test.mjs', 'tools/contract.test.mjs']));

if (!flag('no-launch') && !(await running())) {
  const launchArgs = ['tools/launch-app.mjs', '--port', String(port), '--document', path.join('fixtures', 'sample.md')];
  if (exe !== '') launchArgs.push('--exe', path.resolve(exe));
  results.push(run('start the app', process.execPath, launchArgs));
}

if (await running()) {
  results.push(run('app behaviour', process.execPath, ['tools/verify-app.mjs', String(port)]));
  results.push(run('security boundary', process.execPath, ['tools/verify-security.mjs', String(port)]));
  results.push(run('scripted html preview', process.execPath, ['tools/verify-html-preview.mjs', String(port)]));
  results.push(run('strict canvas renders', process.execPath, ['tools/verify-render-strict.mjs', String(port)]));
  results.push(run('document formats', process.execPath, ['tools/verify-formats.mjs', String(port)]));
  if (flag('large')) results.push(run('large file', process.execPath, ['tools/verify-large-file.mjs', String(port)]));
} else {
  results.push({ label: 'app checks', code: 1 });
  console.error('[verify] no app is answering on the port, so the app checks were skipped');
}

console.log('\n=== summary ===');
for (const result of results) console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.label}`);
const failed = results.filter((result) => result.code !== 0);
console.log(failed.length === 0 ? '\nall checks passed' : `\n${failed.length} check(s) failed`);
process.exit(failed.length === 0 ? 0 : 2);
