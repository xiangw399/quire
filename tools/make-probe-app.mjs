/**
 * Build a minimal Electron probe app.
 *
 * The desktop build exits silently on a machine that refuses to start an unsigned
 * Chromium binary — which looks identical to a packaging mistake. This probe
 * separates the two: it is the same runtime with a ten-line main process that
 * writes a file before doing anything else and then opens an empty window.
 *
 *  - the log appears            → Electron starts here; the fault is in the app
 *  - the log never appears      → Electron itself cannot start here (signing,
 *                                 Smart App Control, an application-control policy,
 *                                 or the runtime's files being blocked)
 *
 * Usage: node tools/make-probe-app.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve('.');
const runtimeDir = path.join(projectRoot, 'runtime', 'electron');
const target = path.join(projectRoot, 'release', 'electron-probe');

const MAIN = `// Minimal Electron probe: prove the runtime starts, nothing else.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const log = path.join(app.getPath('userData'), 'probe.log');
function write(line) {
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, line + '\\n');
  } catch (error) {
    // A log that cannot be written is itself the finding.
    console.error('probe log failed:', error.message);
  }
}

write('main process started: electron ' + process.versions.electron + ', node ' + process.versions.node);
console.log('probe: main process started');

app.whenReady().then(() => {
  write('ready fired');
  const window = new BrowserWindow({ width: 480, height: 240, title: 'Electron probe' });
  window.loadURL('data:text/html,<h1 style="font-family:sans-serif">Electron works</h1>');
  write('window created');
  console.log('probe: window created');
  window.once('ready-to-show', () => window.show());
});

app.on('window-all-closed', () => app.quit());
`;

const MANIFEST = {
  name: 'electron-probe',
  productName: 'Electron Probe',
  version: '1.0.0',
  private: true,
  main: 'main.cjs',
};

/** Copy the runtime, minus the payload and the extra locale packs. */
async function copyRuntime() {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(runtimeDir, { withFileTypes: true })) {
    if (entry.name === 'resources') continue;
    if (entry.name === 'locales') {
      await fs.mkdir(path.join(target, 'locales'), { recursive: true });
      for (const pack of ['en-US.pak', 'zh-CN.pak']) {
        await fs.copyFile(path.join(runtimeDir, 'locales', pack), path.join(target, 'locales', pack));
      }
      continue;
    }
    await fs.copyFile(path.join(runtimeDir, entry.name), path.join(target, entry.name));
  }
  await fs.mkdir(path.join(target, 'resources', 'app'), { recursive: true });
  await fs.writeFile(path.join(target, 'resources', 'app', 'main.cjs'), MAIN, 'utf8');
  await fs.writeFile(path.join(target, 'resources', 'app', 'package.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
}

await copyRuntime();
const logPath = path.join(process.env.APPDATA ?? '', 'Electron Probe', 'probe.log');
console.log(`[probe] staged at ${target}`);
console.log('[probe] run it with:');
console.log(`        "${path.join(target, 'electron.exe')}"`);
console.log(`[probe] then read the log:`);
console.log(`        Get-Content "${logPath}"`);
