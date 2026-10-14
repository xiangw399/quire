/**
 * Preflight: load the packaged main process with a stubbed Electron.
 *
 * The app cannot be launched in a confined environment — Chromium needs channels
 * this sandbox refuses — so "it crashes here" says nothing about the package. What
 * *can* be checked without a window is whether the packaged main process loads at
 * all: its requires resolve inside the staged tree, its manifest entry is right,
 * its paths exist, and it reaches the point where Electron would open a window.
 *
 * The stub answers only what the main process asks for before that point, and
 * records every call, so a failure names the missing piece instead of guessing.
 *
 * Usage: node tools/preflight-app.mjs [release-dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const stage = path.resolve(process.argv[2] ?? path.join('release', 'Quire'));
const appDir = path.join(stage, 'resources', 'app');
const manifestPath = path.join(appDir, 'package.json');

if (!fs.existsSync(manifestPath)) {
  console.log(`[preflight] no packaged app at ${appDir}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entry = path.join(appDir, manifest.main);
console.log(`[preflight] app dir   ${appDir}`);
console.log(`[preflight] main      ${manifest.main}`);
console.log(`[preflight] entry     ${fs.existsSync(entry) ? 'present' : 'MISSING'}`);

/** Everything the main process touches before a window is created. */
const calls = [];
const recorded = (name, value) => {
  calls.push(name);
  return value;
};

let windowCreated = false;
class FakeBrowserWindow {
  constructor(options) {
    windowCreated = true;
    this.options = options;
    this.webContents = { setWindowOpenHandler() {}, send() {}, on() {} };
  }
  once() {}
  on() {}
  loadFile(target) {
    calls.push(`loadFile:${target}`);
    if (!fs.existsSync(target)) throw new Error(`window would load a missing file: ${target}`);
  }
  show() {}
  isMinimized() {
    return false;
  }
  restore() {}
  focus() {}
}

const userData = path.join(appDir, 'preflight-userdata');
const appStub = {
  isPackaged: true,
  getPath: (name) => recorded(`getPath:${name}`, name === 'userData' ? userData : appDir),
  requestSingleInstanceLock: () => recorded('requestSingleInstanceLock', true),
  whenReady: () => recorded('whenReady', Promise.resolve()),
  on: (event) => recorded(`app.on:${event}`),
  quit: () => recorded('app.quit'),
};

const electronStub = {
  app: appStub,
  BrowserWindow: FakeBrowserWindow,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: {
    handle: (channel) => recorded(`ipcMain.handle:${channel}`),
    on: (channel) => recorded(`ipcMain.on:${channel}`),
  },
  protocol: { handle: (scheme) => recorded(`protocol.handle:${scheme}`) },
  Menu: { setApplicationMenu: () => recorded('Menu.setApplicationMenu'), buildFromTemplate: (t) => t },
};

// Intercept the single module the app cannot load outside Electron.
const require_ = createRequire(pathToFileURL(entry));
const originalLoad = require_.constructor.prototype.require ?? null;
void originalLoad;
const Module = require_('node:module');
const originalResolve = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalResolve.call(this, request, parent, isMain);
};

process.on('unhandledRejection', (reason) => {
  console.log(`[preflight] unhandled rejection: ${reason?.message ?? reason}`);
});

console.log('\n[preflight] loading the packaged main process…');
try {
  await import(pathToFileURL(entry).href);
  // `whenReady()` is a promise the app continues on; give it a turn to run.
  await new Promise((resolve) => setTimeout(resolve, 300));
} catch (error) {
  console.log(`\n[preflight] FAILED: ${error?.stack ?? error}`);
  Module._load = originalResolve;
  process.exit(1);
}
Module._load = originalResolve;

console.log('\n[preflight] calls the main process made:');
for (const call of calls) console.log(`  ${call}`);

// What the loaded process resolved, so a wrong relative path shows up here rather
// than as a silent failure at run time.
const checks = [
  ['window created', windowCreated],
  ['single-instance lock requested', calls.includes('requestSingleInstanceLock')],
  ['whenReady awaited', calls.includes('whenReady')],
  ['file protocol registered', calls.some((call) => call.startsWith('protocol.handle:dsh-file'))],
  ['ipc channels registered', calls.filter((call) => call.startsWith('ipcMain.')).length >= 5],
  ['page path exists', calls.some((call) => call.startsWith('loadFile:') && fs.existsSync(call.slice('loadFile:'.length)))],
];

// The dynamic imports the main process performs are the one place where the
// package's module mode decides whether the app boots at all: these files are ESM,
// the main process is CommonJS, and only the manifest's `"type"` makes Node read
// each of them the way it was written. Loading them here turns a missing or wrong
// `"type"` into a failing check instead of an app that exits before its first log.
console.log('\n[preflight] modules the main process imports at run time:');
for (const relative of ['src/main/host-api.js', 'src/main/office-converter.js', 'src/main/file-service.js']) {
  const file = path.join(appDir, relative);
  try {
    await import(pathToFileURL(file).href);
    console.log(`  ok    ${relative}`);
  } catch (error) {
    console.log(`  FAIL  ${relative}: ${error?.message}`);
    checks.push([`${relative} imports as the main process expects`, false]);
    continue;
  }
}
// Only successful imports are added as passing checks, so the report stays honest.
for (const relative of ['src/main/host-api.js', 'src/main/office-converter.js', 'src/main/file-service.js']) {
  if (!checks.some(([label]) => label.startsWith(relative))) {
    checks.push([`${relative} imports as the main process expects`, true]);
  }
}

console.log('\n[preflight] findings:');
let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\n[preflight] ${failures === 0 ? 'the packaged main process loads and wires up correctly' : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
