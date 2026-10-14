/**
 * Vendor the Office conversion engine into the project.
 *
 * The reader previews Word and PowerPoint by converting them to PDF, and DSH does
 * that with the independently published `@deepseek-ai/libreoffice-kit` — a prebuilt
 * LibreOffice. The engine ships as two npm packages (the entry plus a 182 MB
 * win32-x64 native payload), and this script copies both, plus the kit's own
 * runtime dependencies, into `vendor/office`.
 *
 * Nothing here is invented: the packages are taken verbatim from the same
 * installation DSH itself runs, so the conversion the app performs is the
 * conversion the reader was written against.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Where DSH's own npm installation keeps these packages. */
const SOURCES = [
  'C:/Users/SYW/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  'C:/Users/SYW/.dsh/profiles/node_modules/@deepseek-ai',
];

/** The engine packages, and the kit's runtime dependencies. */
const PACKAGES = [
  '@deepseek-ai/libreoffice-kit',
  '@deepseek-ai/libreoffice-kit-win32-x64',
];

/** The kit's declared dependencies, copied so its imports resolve. */
const KIT_DEPENDENCIES = ['fflate', 'fontkit', 'saxes'];
/** Those dependencies' own runtime needs. */
const TRANSITIVE = ['brotli', 'clone', 'dfa', 'fast-deep-equal', 'pako', 'restructure', 'tiny-inflate', 'tslib', 'unicode-properties', 'unicode-trie', 'xmlchars', 'base64-js', '@swc/helpers'];

const target = path.resolve('vendor/office');
const nodeTarget = path.join(target, 'node_modules');

/** First source directory that actually contains a package. */
async function findPackage(name) {
  for (const root of SOURCES) {
    const scope = name.startsWith('@') ? name : undefined;
    const candidate = path.join(root, name);
    try {
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      void scope;
    }
    // A third-party dependency sits beside the scope directory, not inside it.
    const sibling = path.join(path.dirname(root), name);
    try {
      await fs.access(path.join(sibling, 'package.json'));
      return sibling;
    } catch {
      // try the next root
    }
  }
  return undefined;
}

/** Copy one directory tree. */
async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination);
    else if (entry.isSymbolicLink()) {
      const real = await fs.realpath(source);
      await copyTree(real, destination);
    } else await fs.copyFile(source, destination);
  }
}

/** Recursive size, for the report. */
async function sizeOf(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(at);
    else total += (await fs.stat(at)).size;
  }
  return total;
}

async function main() {
  await fs.mkdir(nodeTarget, { recursive: true });
  const copied = [];
  const missing = [];

  const wanted = [...PACKAGES, ...KIT_DEPENDENCIES, ...TRANSITIVE];
  for (const name of wanted) {
    const source = await findPackage(name);
    if (source === undefined) {
      missing.push(name);
      continue;
    }
    const destination = path.join(nodeTarget, ...name.split('/'));
    await copyTree(source, destination);
    copied.push(`${name} (${((await sizeOf(destination)) / 1024 / 1024).toFixed(1)} MB)`);
  }

  // The entry point the converter imports, resolved through the vendored tree.
  const kitEntry = path.join(nodeTarget, '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js');
  const hasKit = await fs.access(kitEntry).then(() => true, () => false);

  const total = await sizeOf(target);
  console.log(`[office] vendored into ${target} (${(total / 1024 / 1024).toFixed(1)} MB)`);
  for (const item of copied) console.log(`[office]   ${item}`);
  if (missing.length > 0) console.log(`[office]   not found: ${missing.join(', ')}`);
  console.log(`[office] kit entry: ${hasKit ? kitEntry : '(missing — Office preview will report the engine as unavailable)'}`);
}

main().catch((error) => {
  console.error('[office] failed', error);
  process.exitCode = 1;
});
