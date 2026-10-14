/**
 * Packaging verification: is the staged build complete and coherent?
 *
 * The app cannot be launched in a confined environment (Chromium needs its
 * multi-process channels), so this checks what can be checked from the files
 * themselves: every file the app loads at run time is present, the manifests
 * parse, the reader's own lazy chunks sit beside their owner, and the Office
 * engine's dependency graph resolves inside the staged tree.
 *
 * Usage: node tools/verify-package.mjs [release-dir]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const stage = path.resolve(process.argv[2] ?? path.join('release', 'Quire'));
const appDir = path.join(stage, 'resources', 'app');

/** Every path the app resolves at run time, with what would break without it. */
const REQUIRED = [
  ['Quire.exe', 'the runtime the user launches'],
  ['install.ps1', 'the in-place installer and its uninstaller'],
  ['LICENSE', "Electron's own license"],
  ['LICENSES.chromium.html', "Chromium's license text"],
  ['THIRD-PARTY-NOTICES.txt', 'the notices the distribution must carry'],
  ['resources/app/assets/app.ico', 'the window and taskbar icon'],
  ['resources/app/assets/icon.png', 'the same icon as a bitmap'],
  ['resources/app/package.json', 'the main entry and the product name'],
  ['resources/app/src/main/electron-main.cjs', 'the main process'],
  ['resources/app/src/main/paths.cjs', 'the application layout'],
  ['resources/app/src/main/trace.cjs', 'the startup trace'],
  ['resources/app/src/main/security.cjs', 'the page boundary and the navigation guard'],
  ['resources/app/src/main/menu.cjs', 'the application menu'],
  ['resources/app/src/main/host-api.js', 'the host file service'],
  ['resources/app/src/main/file-service.js', 'the paging and byte reads'],
  ['resources/app/src/main/office-converter.js', 'the Office converter'],
  ['resources/app/src/preload/preload.cjs', 'the renderer bridge'],
  ['resources/app/src/renderer/dsh/contract.js', 'the DSH names the shell boots against'],
  ['resources/app/dist/web/index.html', 'the page the window loads'],
  ['resources/app/dist/web/shell.js', 'the built shell'],
  ['resources/app/dist/web/shell.css', 'the shell styles'],
  ['resources/app/dist/web/vendor/client.js', "the reader's bundle"],
  ['resources/app/dist/web/vendor/client.theme.js', 'the design tokens every reader stylesheet is written against'],
  ['resources/app/dist/web/vendor/client.pdf.js', 'PDF.js, loaded lazily for PDFs'],
  ['resources/app/dist/web/vendor/client.excel.js', 'the spreadsheet stack, loaded lazily'],
  [
    'resources/app/vendor/office/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
    'the Office engine entry the converter imports',
  ],
  [
    'resources/app/vendor/office/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe',
    'the native LibreOffice engine',
  ],
  ['resources/app/vendor/office/node_modules/@swc/helpers/package.json', 'a fontkit runtime dependency'],
  ['resources/app/vendor/office/node_modules/fontkit/package.json', 'font metrics for conversion'],
];

/** Report whether a path exists, with its size. */
async function check(relative) {
  const at = path.join(stage, relative);
  try {
    const stats = await fs.stat(at);
    if (stats.isDirectory()) return { ok: true, detail: 'directory' };
    return { ok: true, detail: `${(stats.size / 1024).toFixed(1)} KB` };
  } catch {
    return { ok: false, detail: 'MISSING' };
  }
}

/** Recursive size. */
async function sizeOf(target) {
  let total = 0;
  for (const entry of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    const at = path.join(target, entry.name);
    if (entry.isDirectory()) total += await sizeOf(at);
    else total += (await fs.stat(at)).size;
  }
  return total;
}

const rows = [];
let failures = 0;
for (const [relative, why] of REQUIRED) {
  const result = await check(relative);
  if (!result.ok) failures += 1;
  rows.push(`${result.ok ? 'ok  ' : 'FAIL'}  ${relative.padEnd(78)} ${result.detail.padEnd(10)} ${why}`);
}

// The manifests must parse: a trailing comma here is a launch failure with no
// console to explain it.
let manifestNote = 'ok';
try {
  const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8'));
  manifestNote = `main=${manifest.main} product=${manifest.productName ?? '(none)'}`;
  if (manifest.main !== 'src/main/electron-main.cjs') {
    manifestNote += '  <-- main does not match the staged entry';
    failures += 1;
  }
} catch (error) {
  manifestNote = `unparsable: ${error.message}`;
  failures += 1;
}

// The reader loads its chunks by name from its own directory; a missing sibling
// would only surface when a PDF or a workbook is opened.
const vendorDir = path.join(appDir, 'dist', 'web', 'vendor');
const chunksReferenced = ['client.pdf.js', 'client.excel.js'];
const vendorListing = await fs.readdir(vendorDir).catch(() => []);
const missingChunks = chunksReferenced.filter((chunk) => !vendorListing.includes(chunk));
if (missingChunks.length > 0) failures += 1;

// The Office kit imports its dependencies by bare name; without node_modules
// beside it, the engine would fail at first conversion.
const kitDeps = ['fflate', 'fontkit', 'saxes', '@swc/helpers'];
const kitNodeModules = path.join(appDir, 'vendor', 'office', 'node_modules');
const kitListing = await fs.readdir(kitNodeModules).catch(() => []);
const missingKit = kitDeps.filter((dep) => !kitListing.includes(dep.replace('@swc/helpers', '@swc')));
if (missingKit.length > 0) failures += 1;

// Release hygiene: what is only wrong in what actually ships. The vendored Office engine
// brings its own source maps and they are left alone; the shell's own are a decision.
const hygiene = [];
const shellMaps = [];
for (const map of ['shell.js.map', 'shell.css.map']) {
  const present = await fs.stat(path.join(appDir, 'dist', 'web', map)).then(() => true).catch(() => false);
  if (present) shellMaps.push(map);
}
if (shellMaps.length > 0) hygiene.push(`the built shell ships ${shellMaps.join(', ')}; build a release without --sourcemap`);

const page = await fs.readFile(path.join(appDir, 'dist', 'web', 'index.html'), 'utf8').catch(() => '');
if (!page.includes('Content-Security-Policy')) hygiene.push('the page carries no Content-Security-Policy');

const stagedVersion = (await fs.readFile(path.join(stage, 'version'), 'utf8').catch(() => '')).trim();
const runtimeVersion = (await fs.readFile(path.join('runtime', 'electron', 'version'), 'utf8').catch(() => '')).trim();
if (stagedVersion === '' || stagedVersion !== runtimeVersion) {
  hygiene.push(`the release reports Electron ${stagedVersion || '(none)'}, the vendored runtime is ${runtimeVersion || '(none)'}`);
}
failures += hygiene.length;

const total = await sizeOf(stage);
const appSize = await sizeOf(appDir);

console.log('=== packaged build ===');
console.log(`staged at ${stage}`);
console.log(`total ${(total / 1024 / 1024).toFixed(1)} MB   app payload ${(appSize / 1024 / 1024).toFixed(1)} MB\n`);
for (const row of rows) console.log(row);
console.log(`\nmanifest: ${manifestNote}`);
console.log(`vendor chunks present: ${vendorListing.join(', ')}`);
if (missingChunks.length > 0) console.log(`MISSING chunks: ${missingChunks.join(', ')}`);
console.log(`office node_modules: ${kitListing.join(', ')}`);
if (missingKit.length > 0) console.log(`MISSING kit dependencies: ${missingKit.join(', ')}`);

console.log(`\nrelease hygiene: ${hygiene.length === 0 ? 'ok' : hygiene.join('; ')}`);
console.log(`required files: ${REQUIRED.length} checked, ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
