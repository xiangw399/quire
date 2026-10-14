/**
 * Contract test: the shell's idea of DSH must keep matching the bundles it boots.
 *
 * The reader is built by another project, from names this shell has no control over:
 * barrel ids, module specifiers, seat names, and two globals. Those names live in
 * `src/renderer/dsh/contract.js` so an upstream rename is one edit — and this test is
 * what makes that true, by reading the vendored bundles and failing when they stop
 * agreeing with the contract. It runs without a browser: the bundles are read as text.
 *
 * Run: node --test tools/contract.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLES,
  FRAMEWORK_PACKAGES,
  LIMITS_GLOBAL,
  LOADER_GLOBAL,
  PLATFORM_PACKAGES,
  READER_BUNDLE,
  READER_SEATS,
  READER_TAB_ID,
  SLOTS,
  THEME_BUNDLE,
  THEME_SETTINGS_KEY,
} from '../src/renderer/dsh/contract.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(projectRoot, 'vendor');
const rendererDir = path.join(projectRoot, 'src', 'renderer');
const read = (file) => fs.readFileSync(file, 'utf8');

/** Every `require("...")` specifier in a bundle, exactly as the loader would see them. */
function requiredSpecifiers(source) {
  return [...new Set([...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]))];
}

/** Every script file under a directory, for the "no scattered literals" scan. */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

test('the contract names bundles that exist and carry their own ids', () => {
  for (const bundle of BUNDLES) {
    const file = path.join(vendorDir, bundle.file);
    assert.ok(fs.existsSync(file), `vendor/${bundle.file} is missing`);
    assert.ok(read(file).includes(bundle.id), `vendor/${bundle.file} does not mention ${bundle.id}`);
  }
});

test('the theme boots before the reader, and the tab identity is the reader id', () => {
  assert.deepEqual(BUNDLES, [THEME_BUNDLE, READER_BUNDLE]);
  assert.equal(READER_TAB_ID, READER_BUNDLE.id);
  assert.notEqual(SLOTS.documentTab, SLOTS.documentTitle);
  assert.equal(new Set(PLATFORM_PACKAGES).size, PLATFORM_PACKAGES.length, 'a package is listed twice');
});

test('the reader still publishes the seats this shell opens', () => {
  const reader = read(path.join(vendorDir, READER_BUNDLE.file));
  for (const seat of READER_SEATS) {
    assert.ok(reader.includes(seat.name), `the reader no longer mentions the seat ${seat.name}`);
  }
});

test('every DSH package a bundle requires is declared and bound', () => {
  const declared = new Set(PLATFORM_PACKAGES);
  const missing = [];
  for (const bundle of BUNDLES) {
    for (const specifier of requiredSpecifiers(read(path.join(vendorDir, bundle.file)))) {
      if (specifier.startsWith('@deepseek-ai/') && !declared.has(specifier)) missing.push(`${bundle.file} requires ${specifier}`);
    }
  }
  assert.deepEqual(missing, [], `name these in PLATFORM_PACKAGES:\n${missing.join('\n')}`);

  // A declared package nobody binds would be handed to the reader as `undefined`, which
  // is the quiet version of the same failure.
  const boot = read(path.join(rendererDir, 'dsh', 'boot.js'));
  const unbound = PLATFORM_PACKAGES.filter((name) => !boot.includes(`'${name}':`));
  assert.deepEqual(unbound, [], `boot.js binds no module for: ${unbound.join(', ')}`);
});

test('every framework package a bundle requires is declared', () => {
  const declared = new Set(FRAMEWORK_PACKAGES);
  for (const bundle of BUNDLES) {
    for (const specifier of requiredSpecifiers(read(path.join(vendorDir, bundle.file)))) {
      if (/^react(-dom)?(\/|$)/.test(specifier)) {
        assert.ok(declared.has(specifier), `${bundle.file} requires ${specifier}, which FRAMEWORK_PACKAGES does not name`);
      }
    }
  }
});

test('the contract is the only place these DSH names are spelled', () => {
  const literals = [
    SLOTS.documentTab,
    SLOTS.documentTitle,
    READER_BUNDLE.id,
    THEME_BUNDLE.id,
    LOADER_GLOBAL,
    LIMITS_GLOBAL,
    THEME_SETTINGS_KEY,
  ];
  const offenders = [];
  for (const file of filesUnder(rendererDir)) {
    if (path.basename(file) === 'contract.js') continue;
    const source = read(file);
    for (const literal of literals) {
      if (source.includes(`'${literal}'`) || source.includes(`"${literal}"`)) {
        offenders.push(`${path.relative(projectRoot, file)} spells '${literal}'`);
      }
    }
  }
  assert.deepEqual(offenders, [], `import the name from the contract instead:\n${offenders.join('\n')}`);
});
