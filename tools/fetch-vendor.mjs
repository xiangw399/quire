/**
 * Fetch the third-party pieces this repository deliberately does not carry.
 *
 * Why they are not in git: the reader's bundles are prebuilt artifacts of published
 * DeepSeek Harness packages, the Office engine is a 192 MB prebuilt LibreOffice, and
 * the runtime is a 180 MB Electron — all of them are other people's binaries. Keeping
 * them out of the repository keeps the source tree readable, and makes the exact
 * provenance of every binary something this script can state and verify.
 *
 * What it produces (all of it .gitignored):
 *   vendor/client.js, client.pdf.js, client.excel.js   from
 *     @deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.7-rc.2 (MIT)
 *   vendor/client.theme.js                             from
 *     @deepseek-ai/dsh-client-ui-theme@0.1.7-rc.2 (MIT)
 *   vendor/office/node_modules/                        @deepseek-ai/libreoffice-kit@0.1.2
 *     plus its platform engine package (MPL-2.0)
 *   runtime/electron/                                  Electron 33.4.11 (MIT), copied
 *     from the devDependency this repository already installs
 *
 * Usage: node tools/fetch-vendor.mjs [--force]
 *   1. npm install            (once; brings Electron into node_modules/)
 *   2. node tools/fetch-vendor.mjs
 *   3. npm run build && npm run package
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const projectRoot = path.resolve('.');
const force = process.argv.includes('--force');

/** The bundles to take from published packages, with the hash the file must have. */
const BUNDLES = [
  {
    package: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.7-rc.2',
    license: 'MIT',
    from: 'lib/client.js',
    to: 'client.js',
    sha256: 'd8d2b78c89febaef7f1188c7435d01e70693d73494b8f288f09c5c6dedbd7cc5',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.7-rc.2',
    license: 'MIT',
    from: 'lib/client.pdf.js',
    to: 'client.pdf.js',
    sha256: '83532938ad6a59e1ed0140556cb342b88a5cc903227e4b133f3f0f1178252eb2',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.7-rc.2',
    license: 'MIT',
    from: 'lib/client.excel.js',
    to: 'client.excel.js',
    sha256: 'be3cf5a47b70442000e385001c5cdb82b51b30478e0f9ce75c59fb5cd0e68259',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-theme@0.1.7-rc.2',
    license: 'MIT',
    from: 'lib/client.js',
    to: 'client.theme.js',
    sha256: 'de57d7864e2f3cbd91a33a1a993b2a092f80ff0be11a50c2f02113d420304d17',
  },
];

const KIT = '@deepseek-ai/libreoffice-kit@0.1.2';
const ELECTRON_VERSION = '33.4.11';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sha256 = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Unpack a published package into a scratch directory and return that directory. */
async function unpack(spec, scratch) {
  const before = new Set(await fs.readdir(scratch));
  // --pack-destination keeps the tarball out of the repository root.
  execFileSync(npm, ['pack', spec, '--pack-destination', scratch], { stdio: ['ignore', 'ignore', 'inherit'] });
  const added = (await fs.readdir(scratch)).filter((name) => name.endsWith('.tgz') && !before.has(name));
  if (added.length !== 1) throw new Error(`npm pack ${spec} produced ${added.length} tarballs`);
  const tarball = path.join(scratch, added[0]);
  const into = path.join(scratch, added[0].replace(/\.tgz$/, ''));
  await fs.mkdir(into, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'inherit' });
  return path.join(into, 'package');
}

async function fetchBundles(scratch) {
  const vendor = path.join(projectRoot, 'vendor');
  await fs.mkdir(vendor, { recursive: true });
  const unpacked = new Map();
  for (const bundle of BUNDLES) {
    const target = path.join(vendor, bundle.to);
    if (!force && (await exists(target)) && (await sha256(target)) === bundle.sha256) {
      console.log(`[fetch] ${bundle.to.padEnd(18)} already present, hash matches`);
      continue;
    }
    if (!unpacked.has(bundle.package)) unpacked.set(bundle.package, await unpack(bundle.package, scratch));
    const source = path.join(unpacked.get(bundle.package), bundle.from);
    const actual = await sha256(source);
    if (actual !== bundle.sha256) {
      throw new Error(
        `${bundle.package} now ships a different ${bundle.from}\n  expected ${bundle.sha256}\n  actual   ${actual}\n` +
          'Upstream changed the artifact: review the diff, then update BUNDLES in this script.',
      );
    }
    await fs.copyFile(source, target);
    console.log(`[fetch] ${bundle.to.padEnd(18)} <- ${bundle.package} (${bundle.license}) verified`);
  }
}

async function fetchOfficeKit() {
  const prefix = path.join(projectRoot, 'vendor', 'office');
  const kit = path.join(prefix, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'package.json');
  if (!force && (await exists(kit))) {
    const manifest = JSON.parse(await fs.readFile(kit, 'utf8'));
    if (manifest.version === KIT.split('@').pop()) {
      console.log(`[fetch] ${KIT} already present (${manifest.license})`);
      return;
    }
  }
  await fs.mkdir(prefix, { recursive: true });
  console.log(`[fetch] installing ${KIT} into vendor/office (192 MB, includes the prebuilt engine)`);
  execFileSync(
    npm,
    ['install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', KIT],
    { stdio: 'inherit' },
  );
}

async function fetchElectronRuntime() {
  const from = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  const to = path.join(projectRoot, 'runtime', 'electron');
  const versionFile = path.join(to, 'version');
  if (!force && (await exists(versionFile))) {
    const version = (await fs.readFile(versionFile, 'utf8')).trim();
    if (version === ELECTRON_VERSION) {
      console.log(`[fetch] Electron ${version} already staged in runtime/electron`);
      return;
    }
  }
  if (!(await exists(from))) {
    throw new Error('node_modules/electron/dist is missing — run `npm install` first');
  }
  console.log(`[fetch] copying the Electron runtime from node_modules/electron/dist`);
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

const scratch = path.join(projectRoot, '.npm-cache', 'fetch-vendor');
await fs.mkdir(scratch, { recursive: true });
await fetchBundles(scratch);
await fetchOfficeKit();
await fetchElectronRuntime();
console.log('[fetch] done. Next: npm run build && npm run package');
