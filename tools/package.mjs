/**
 * Package the app: a portable desktop build, assembled here rather than by a
 * packager.
 *
 * Why hand-assembled: Electron's `resources/app` directory takes precedence over
 * `resources/app.asar`, so a build is a copy plus a manifest — no archive format,
 * no packaging service, and nothing about the build that cannot be read back.
 *
 * What goes in:
 *  - the Chromium/Node runtime from Electron's own distribution (unchanged, with
 *    its licenses and `default_app.asar` removed, since this is the app);
 *  - the built shell (`dist/web`), the vendored reader bundles, and the vendored
 *    Office engine (`vendor/office`);
 *  - the host and Electron sources (`src`), because the main process and the
 *    converter are plain files, not bundled artifacts.
 *
 * Usage: node tools/package.mjs [--zip]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve('.');
const runtimeDir = path.join(projectRoot, 'runtime', 'electron');
const releaseRoot = path.join(projectRoot, 'release');
const appName = 'Quire';
/** The executable's name; the product name the user sees lives in package.json. */
const executableName = 'Quire.exe';
const stage = path.join(releaseRoot, appName);

/** Directories copied into `resources/app`, with the reason each is needed. */
const APP_PARTS = [
  { from: 'dist', why: 'the built shell and the reader vendor bundles the page loads' },
  { from: 'src', why: 'the main process, the preload bridge, and the Office converter' },
  { from: 'vendor/office', why: 'the LibreOffice engine and the kit that drives it' },
  { from: 'package.json', why: 'the main entry and app identity' },
  { from: 'README.md', why: 'what the app is' },
  { from: 'LICENSE', why: "Quire's own license, for the user who unpacks the app" },
  { from: 'NOTICE', why: 'the attribution and the "not affiliated with DeepSeek" statement' },
  { from: 'assets/app.ico', why: 'the window and taskbar icon, and the installer shortcut icon' },
  { from: 'assets/icon.png', why: 'the same icon at 256px for platforms that want a bitmap' },
  { from: 'assets/file', why: 'the per-type file icons the association registration points at' },
];

/** Recursive size, for the report. */
async function sizeOf(target) {
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const at = path.join(target, entry.name);
    if (entry.isDirectory()) total += await sizeOf(at);
    else total += (await fs.stat(at)).size;
  }
  return total;
}

/** Copy a file or a tree, creating parents. */
async function copyInto(from, to) {
  const stats = await fs.stat(from);
  if (stats.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      await copyInto(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

/** Collect every license and notice file under a tree, as notices blocks. */
async function collectNotices(root, label) {
  const blocks = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A nested dependency keeps its own license beside its own sources.
        if (entry.name === 'node_modules') continue;
        await walk(at);
        continue;
      }
      // License texts are not always named "LICENSE": the prebuilt LibreOffice engine ships
      // `licenses/DeepSeek-Harness-MIT.txt`, `licenses/LibreOffice-MPL-2.0.txt` and
      // `licenses/LibreOffice-third-party.html`, and those have to be carried too.
      if (!/(?:^|[-_.])(licen[cs]e|notice|copying|mit|mpl-?2\.0|apache-?2\.0|bsd-?3|third-party)(?:[-_.]|$)/i.test(entry.name)) continue;
      const text = await fs.readFile(at, 'utf8').catch(() => '');
      if (text.trim() === '') continue;
      blocks.push(
        `\n${'='.repeat(78)}\n${label}: ${path.relative(root, at)}\n${'='.repeat(78)}\n\n${text.trim()}\n`,
      );
    }
  }
  await walk(root);
  return blocks;
}

/** Write the third-party notices the distribution must carry. */
async function writeNotices(target) {
  const electronVersion = await fs.readFile(path.join(runtimeDir, 'version'), 'utf8').then((v) => v.trim());
  const header = `THIRD-PARTY NOTICES
===================

Quire redistributes the components below unmodified. Each keeps its own license,
and the full texts follow this summary.

NOT AFFILIATED WITH DEEPSEEK
    Quire is an independent project. It is not affiliated with, endorsed by or
    sponsored by DeepSeek or the DeepSeek Harness project, and it is not an
    official DeepSeek product. "DeepSeek", "DeepSeek Harness" and "DSH" are
    trademarks of their respective owner; those names appear here only to
    describe where the reader's rendering packages come from.

COMPONENTS

  Electron ${electronVersion}
      Chromium and Node.js runtime (MIT). The Chromium license text ships beside
      the executable as LICENSES.chromium.html.

  DeepSeek Harness document-preview bundles — client.js, client.pdf.js, client.excel.js
      @deepseek-ai/dsh-client-ui-sidebar-documentpreview 0.1.7-rc.2 — MIT.
      Taken verbatim from the published npm package; the files in dist/web/vendor
      are byte-for-byte the package's own lib/client*.js.

  DeepSeek Harness theme bundle — client.theme.js
      @deepseek-ai/dsh-client-ui-theme 0.1.7-rc.2 — MIT.
      Taken verbatim from the published npm package.

  DeepSeek Harness client framework
      dsh-client-store, dsh-client-ui-dockkit, @deepseek-ai/cordis — MIT;
      dsh-client-ui-slots, dsh-client-ui-primitives — BSD-3-Clause.
      Source: https://github.com/deepseek-ai/deepseek-harness

  Reader runtime libraries bundled inside the lazy chunks
      PDF.js, FortuneSheet, ExcelJS, SheetJS CE, PapaParse, DOMPurify, Shiki,
      KaTeX, React, React DOM, zustand and friends, under the MIT / Apache-2.0 /
      BSD licenses each project declares.

  @deepseek-ai/libreoffice-kit 0.1.2 — MPL-2.0
      The Office conversion kit under vendor/office. Its NOTICE also carries an
      MIT-licensed portion derived from DeepSeek Harness.

  Prebuilt LibreOffice engine — @deepseek-ai/libreoffice-kit-win32-x64 0.1.2
      MPL-2.0 together with LibreOffice's own licenses; redistributed unmodified
      with its license texts, NOTICE files and the source-availability material
      the package ships (licenses/, program/license.txt, sources/).
      LibreOffice source: https://www.libreoffice.org/about-us/source-code/

  Other runtime libraries
      fflate, fontkit, saxes and their transitive dependencies, at the versions
      the kit declares.

  Quire itself
      Copyright (c) 2026 xiangw399 — MIT. See the LICENSE file beside this one.
`;
  const kitNotices = await collectNotices(path.join(projectRoot, 'vendor', 'office', 'node_modules'), 'vendor');
  const readerNotices = await collectNotices(path.join(projectRoot, 'vendor'), 'reader');
  const electronLicense = await fs.readFile(path.join(runtimeDir, 'LICENSE'), 'utf8').catch(() => '');
  const body = [
    header,
    `\n${'='.repeat(78)}\nElectron\n${'='.repeat(78)}\n\n${electronLicense.trim()}\n`,
    ...readerNotices.filter((block) => !block.includes('office')),
    ...kitNotices,
  ].join('');
  await fs.writeFile(target, body, 'utf8');
  return body.length;
}

/**
 * Chromium locale packs worth shipping.
 *
 * Electron ships one pack per locale (40 MB in total). The app's own copy is
 * Chinese, its fallback is English, and Electron falls back to `en-US` for
 * anything else — so the rest is dead weight in a distribution.
 */
const KEPT_LOCALES = new Set(['en-US.pak', 'zh-CN.pak']);

/** Copy the unchanged runtime, minus the app this runtime would boot on its own. */
async function stageRuntime() {
  const skip = new Set(['resources']);
  for (const entry of await fs.readdir(runtimeDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    if (entry.name === 'locales') {
      const localesTarget = path.join(stage, 'locales');
      await fs.mkdir(localesTarget, { recursive: true });
      for (const pack of await fs.readdir(path.join(runtimeDir, 'locales'))) {
        if (!KEPT_LOCALES.has(pack)) continue;
        await copyInto(path.join(runtimeDir, 'locales', pack), path.join(localesTarget, pack));
      }
      continue;
    }
    const target = entry.name === 'electron.exe' ? executableName : entry.name;
    await copyInto(path.join(runtimeDir, entry.name), path.join(stage, target));
  }
  // The runtime's own default app would shadow nothing, but shipping it would
  // suggest the app is not this one; the app directory is the real payload.
  await fs.mkdir(path.join(stage, 'resources'), { recursive: true });
}

/** Candidate rcedit builds, most specific first; electron-builder keeps one in its cache. */
const RCEDIT_CANDIDATES = [process.env.RCEDIT].filter(Boolean);

/** The rcedit that electron-builder itself uses to stamp an Electron binary, if present. */
async function findRcedit() {
  for (const candidate of RCEDIT_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'winCodeSign');
  for (const entry of await fs.readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cache, entry.name, 'rcedit-x64.exe');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next directory
    }
  }
  return undefined;
}

/**
 * Give the copied Electron binary this application's identity.
 *
 * The runtime is copied verbatim, so without this step the exe keeps Electron's own
 * resources: Explorer draws the Electron icon, the taskbar follows it, and the properties
 * dialog says "ProductName: Electron / CompanyName: GitHub, Inc.". rcedit rewrites exactly
 * those resources — the icon and the version block — and touches nothing else.
 */
async function stampExecutable() {
  const target = path.join(stage, executableName);
  const rcedit = await findRcedit();
  if (rcedit === undefined) {
    console.log('[package] rcedit not found; the exe keeps the Electron icon and version block');
    return false;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const product = manifest.productName ?? appName;
  const version = manifest.version ?? '0.1.0';
  execFileSync(
    rcedit,
    [
      target,
      '--set-icon', path.join(projectRoot, 'assets', 'app.ico'),
      '--set-version-string', 'ProductName', product,
      '--set-version-string', 'FileDescription', product,
      '--set-version-string', 'CompanyName', appName,
      '--set-version-string', 'OriginalFilename', executableName,
      '--set-version-string', 'LegalCopyright', 'MIT / MPL-2.0 / Apache-2.0 components; see THIRD-PARTY-NOTICES.txt',
      '--set-file-version', version,
      '--set-product-version', version,
    ],
    { stdio: 'inherit' },
  );
  return true;
}

/** Assemble the release directory. */
async function assemble() {
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  await stageRuntime();

  const appDir = path.join(stage, 'resources', 'app');
  const copied = [];
  for (const part of APP_PARTS) {
    const from = path.join(projectRoot, part.from);
    await copyInto(from, path.join(appDir, part.from));
    copied.push(part.from);
  }

  // The renderer resolves `vendor/...` next to its own bundle, and the reader's
  // lazy chunks live there; `dist/web/vendor` is already inside `dist`.

  // An installer that does not extract itself: copying files is a step an environment with a
  // restricted temporary folder still permits, which an NSIS stub's self-extraction may not.
  // It ships beside the executable so a user who cannot run the packaged installer has a way
  // in that does not depend on it.
  await copyInto(path.join(projectRoot, 'assets', 'install.ps1'), path.join(stage, 'install.ps1'));
  // The file-type registration lives in one script that both installers call, so the registry
  // surface is described once rather than once per installer.
  await copyInto(path.join(projectRoot, 'assets', 'register-file-types.ps1'), path.join(stage, 'register-file-types.ps1'));

  const noticesBytes = await writeNotices(path.join(stage, 'THIRD-PARTY-NOTICES.txt'));
  const stamped = await stampExecutable();
  const runtimeBytes = await sizeOf(stage);
  const appBytes = await sizeOf(appDir);
  return { copied, noticesBytes, runtimeBytes, appBytes, stamped };
}

/** Zip the staged directory beside it, with Windows' own archiver. */
async function zip() {
  const archive = path.join(releaseRoot, `${appName}.zip`);
  await fs.rm(archive, { force: true });
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${archive}' -CompressionLevel Optimal`],
      { stdio: 'inherit' },
    );
  } catch (error) {
    // A pipeline-free fallback: the archive is a convenience, not the product.
    console.log(`[package] zip skipped (${error?.message ?? error})`);
    return undefined;
  }
  return { archive, bytes: (await fs.stat(archive)).size };
}

const result = await assemble();
console.log(`[package] staged ${stage}`);
console.log(`[package] app payload ${(result.appBytes / 1024 / 1024).toFixed(1)} MB from ${result.copied.join(', ')}`);
console.log(`[package] notices    ${(result.noticesBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`[package] identity   ${result.stamped ? 'icon and version block written into the exe' : 'EXE left as Electron (rcedit missing)'}`);
console.log(`[package] total      ${(result.runtimeBytes / 1024 / 1024).toFixed(1)} MB`);
if (process.argv.includes('--zip')) {
  const zipped = await zip();
  if (zipped !== undefined) console.log(`[package] archive    ${zipped.archive} (${(zipped.bytes / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`[package] run it with: "${path.join(stage, executableName)}"`);
