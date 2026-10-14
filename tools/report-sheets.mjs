/**
 * Report the stylesheets the reader injects at run time, as a compact index.
 *
 * This is the counter-check to "the reader's CSS is missing": it lists every sheet
 * the bundle carries, with its size and the selectors a layout difference could
 * come from. The reader injects these itself, so they are present in any shell
 * that loads the bundle.
 *
 * Usage: node tools/report-sheets.mjs
 */
import fs from 'node:fs/promises';

const source = await fs.readFile('vendor/client.js', 'utf8');
const literal = /const css(?:\$\d+)? = "((?:[^"\\]|\\.)*)";/g;
const sheets = [];
let match;
while ((match = literal.exec(source)) !== null) {
  const text = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (!text.includes('{')) continue;
  const selectors = [...text.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim().split(/[\s,>]/)[0]);
  sheets.push({ text, selectors: [...new Set(selectors)] });
}

console.log(`reader bundle carries ${sheets.length} injected stylesheet(s)\n`);
for (const [index, sheet] of sheets.entries()) {
  console.log(`${String(index + 1).padStart(2)}. ${String(sheet.text.length).padStart(5)} chars, ${String(sheet.selectors.length).padStart(3)} selectors  e.g. ${sheet.selectors.slice(0, 4).join(', ')}`);
}

const all = sheets.map((sheet) => sheet.text).join('\n');
console.log(`\ncombined: ${all.length} chars`);
console.log(`mentions --dsw-* tokens: ${(all.match(/--dsw-/g) ?? []).length}`);
console.log(`defines any --dsw-* token itself: ${/--dsw-[a-z0-9-]+\s*:/.test(all)}`);
