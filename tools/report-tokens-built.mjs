/**
 * Report the design tokens the built shell's stylesheet depends on.
 *
 * The bundled stylesheet covers the client primitives (Markdown, code blocks,
 * labels, buttons), while the reader's own sheets are injected from its bundle.
 * Both reference the same `--dsw-*` vocabulary, so both matter for appearance.
 *
 * Usage: node tools/report-tokens-built.mjs
 */
import fs from 'node:fs/promises';

const css = await fs.readFile('dist/web/shell.css', 'utf8');
const used = new Set();
const withoutFallback = new Set();
for (const token of css.matchAll(/var\((--dsw-[a-z0-9-]+)([^)]*)\)/g)) {
  used.add(token[1]);
  if (token[2].trim() === '') withoutFallback.add(token[1]);
}

console.log(`built stylesheet references ${used.size} distinct --dsw-* tokens`);
console.log(`${withoutFallback.size} of them have no fallback\n`);

const groups = new Map();
for (const name of [...used].sort()) {
  const group = name.split('-')[2] ?? 'other';
  groups.set(group, [...(groups.get(group) ?? []), name]);
}
for (const [group, names] of [...groups].sort()) {
  console.log(`${group} (${names.length}): ${names.join(', ')}`);
}

// The Markdown block's own typography tokens are the ones a missing theme breaks
// first, because they are used as a whole `font` shorthand.
const fontTokens = [...used].filter((name) => name.startsWith('--dsw-font'));
console.log(`\nfont tokens (a missing one voids the entire font shorthand):\n${fontTokens.sort().join('\n')}`);
