/**
 * Build a minimum-distance probe: the fewest bytes that can still be called an
 * Electron app.
 *
 * The full app and a ten-line probe both exit before printing anything, so the
 * remaining question is how early the runtime gives up. This probe removes every
 * feature that could be at fault — no manifest, no `.cjs` extension, no icon, no
 * window, no preload, no protocol — and writes progress to a file *and* the
 * console at each of the three earliest moments a main process can observe:
 *
 *   1. before anything is required;
 *   2. after Electron's own module is loaded;
 *   3. at each of its startup events.
 *
 * It is staged at `C:\electron-probe-test` by default: a short, ASCII-only path,
 * so a long or non-ASCII path cannot be the cause either.
 *
 * Usage: node tools/make-min-probe.mjs [target-dir]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve('.');
const runtimeDir = path.join(projectRoot, 'runtime', 'electron');
const target = path.resolve(process.argv[2] ?? 'C:\\electron-probe-test');

/** The smallest main process that can report how far the runtime got. */
const MAIN = `// Minimum-distance Electron probe.
const fs = require('fs');

const logPath = require('path').join(__dirname, '..', '..', 'probe-report.txt');
function report(line) {
  try {
    fs.appendFileSync(logPath, new Date().toISOString() + '  ' + line + '\\n');
  } catch (error) {
    // nothing left to report with
  }
  // A GUI process launched from a console inherits it, so this also shows up.
  process.stdout.write('PROBE ' + line + '\\n');
}

report('1. main script evaluated');

const electron = require('electron');
report('2. require(electron) -> ' + typeof electron);

const { app } = electron;
report('3. app object -> ' + (app === undefined ? 'undefined' : 'present'));

if (app === undefined) {
  report('app is undefined: the runtime is not in application mode');
  process.exit(9);
}

report('4. versions: electron ' + process.versions.electron + ' node ' + process.versions.node);

app.on('ready', () => report('5. ready event'));
app.whenReady().then(() => {
  report('6. whenReady resolved');
  // Deliberately no window: this probe answers "can the runtime start", not
  // "can it draw".
  report('7. exiting on purpose');
  app.exit(0);
});

report('8. handlers registered; waiting for the event loop');
`;

/** Copy the runtime's own files, keeping the layout Electron expects. */
async function stage() {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, 'resources', 'app'), { recursive: true });
  for (const entry of await fs.readdir(runtimeDir, { withFileTypes: true })) {
    if (entry.name === 'resources' || entry.name === 'locales') continue;
    await fs.copyFile(path.join(runtimeDir, entry.name), path.join(target, entry.name));
  }
  // No package.json on purpose: Electron falls back to index.js, which is the
  // fewest moving parts a launch can have.
  await fs.writeFile(path.join(target, 'resources', 'app', 'index.js'), MAIN, 'utf8');
  await fs.writeFile(path.join(target, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'min-probe', main: 'index.js' }, null, 2), 'utf8');
  return path.join(target, 'probe-report.txt');
}

const reportPath = await stage();
console.log(`[min-probe] staged at ${target}`);
console.log('[min-probe] run:');
console.log(`           & "${path.join(target, 'electron.exe')}"`);
console.log('[min-probe] then read:');
console.log(`           Get-Content "${reportPath}"`);
void os;
