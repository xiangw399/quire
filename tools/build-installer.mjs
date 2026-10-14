/**
 * Build the Windows installer from the staged build.
 *
 * NSIS is taken from the cache this machine already has (the same 3.0.4.1 that
 * electron-builder downloads), so the installer needs no packaging service and no download.
 * The script itself lives in `tools/installer.nsi.template`; this file only substitutes the
 * paths and runs the compiler.
 *
 * The output name is ASCII on purpose. A self-extracting stub builds a temporary path from
 * `%TEMP%` and writes itself and its payload through it, and a non-ASCII installer name is a
 * known source of the stub's "Error writing temporary file" — the failure this build exists
 * to avoid. The product is named in ASCII too (`Quire`), so the installer name, the install
 * directory, the shortcuts and the window title all agree.
 *
 * NSIS installers are always self-extracting, so a machine that cannot run one is served by
 * the script instead: `assets/install.ps1` ships in the distribution and installs by copying,
 * with no temporary step at all.
 *
 * Usage: node tools/build-installer.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve('.');
const stage = path.join(projectRoot, 'release', 'Quire');
const releaseRoot = path.join(projectRoot, 'release');
/** An ASCII name, so the self-extracting stub never builds a temporary path with CJK in it. */
const output = path.join(releaseRoot, 'Quire-Setup.exe');
/** The installer's own icon, and the source for the shortcuts it writes. */
const icon = path.join(projectRoot, 'assets', 'app.ico');

/** Candidate NSIS installations, most specific first. */
const NSIS_CANDIDATES = [
  process.env.NSIS_DIR,
  path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis', 'nsis-3.0.4.1'),
  'C:/Program Files (x86)/NSIS',
  'C:/Program Files/NSIS',
].filter(Boolean);

/** The first candidate that has a compiler. */
async function findNsis() {
  for (const dir of NSIS_CANDIDATES) {
    const compiler = path.join(dir, 'makensis.exe');
    try {
      await fs.access(compiler);
      return { compiler, dir };
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** The app version, from the manifest that ships with it. */
async function version() {
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  return manifest.version ?? '0.1.0';
}

/** Compile the template into the installer. */
async function compile({ target, appVersion }) {
  const template = await fs.readFile(path.join(projectRoot, 'tools', 'installer.nsi.template'), 'utf8');
  const script = template
    // NSIS 3 reads a script as UTF-8 only when it begins with a byte-order mark, and this
    // script's text is Chinese.
    .replace(/^\uFEFF/, '')
    .replaceAll('@STAGE@', stage.replace(/\//g, '\\'))
    .replaceAll('@OUT@', target.replace(/\//g, '\\'))
    .replaceAll('@ICON@', icon.replace(/\//g, '\\'))
    .replaceAll('@VERSION@', appVersion);

  const scriptPath = path.join(releaseRoot, 'installer.nsi');
  await fs.writeFile(scriptPath, `\uFEFF${script}`, 'utf8');
  await fs.rm(target, { force: true });
  try {
    execFileSync(nsis.compiler, ['/V2', scriptPath], { stdio: 'inherit' });
  } finally {
    // The script is a build input, not an artifact.
    await fs.rm(scriptPath, { force: true });
  }
  return fs.stat(target);
}

const nsis = await findNsis();
if (nsis === undefined) {
  console.log('[installer] no NSIS compiler found; set NSIS_DIR to build an installer');
  console.log(`[installer] the portable build is ready at ${stage}`);
  process.exit(0);
}

// A staged build must exist: the installer packs exactly that tree.
await fs.access(path.join(stage, 'Quire.exe')).catch(() => {
  console.log(`[installer] no staged build at ${stage}; run tools/package.mjs first`);
  process.exit(1);
});

// The icon is a build input as well: NSIS refuses to compile without it.
await fs.access(icon).catch(() => {
  console.log(`[installer] no icon at ${icon}; run tools/make-icons.py first`);
  process.exit(1);
});

const appVersion = await version();
console.log(`[installer] compiler ${nsis.compiler}`);
console.log(`[installer] packing  ${stage}`);

let failed = false;
try {
  const stats = await compile({ target: output, appVersion });
  console.log(`[installer] wrote ${output} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
} catch (error) {
  console.error(`[installer] compilation failed: ${error?.message ?? error}`);
  failed = true;
}

process.exitCode = failed ? 1 : 0;
