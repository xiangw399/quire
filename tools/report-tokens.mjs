/**
 * Report the design tokens the reader's own CSS depends on.
 *
 * The reader's stylesheets arrive inside its bundle and reference a large
 * `--dsw-*` token vocabulary. A token that is undefined and has no fallback makes
 * the whole declaration invalid, which is how a missing token set turns into
 * visibly wrong typography. This reports the size of that dependency.
 *
 * Usage: node tools/report-tokens.mjs
 */
import fs from 'node:fs/promises';

const source = await fs.readFile('vendor/client.js', 'utf8');

// The bundle carries each stylesheet as a string literal before injecting it.
const literal = /const css(?:\$\d+)? = "((?:[^"\\]|\\.)*)";/g;
const sheets = [];
let match;
while ((match = literal.exec(source)) !== null) {
  const text = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (text.includes('{')) sheets.push(text);
}

const used = new Set();
const withoutFallback = new Set();
for (const sheet of sheets) {
  for (const token of sheet.matchAll(/var\((--dsw-[a-z0-9-]+)([^)]*)\)/g)) {
    used.add(token[1]);
    const rest = token[2].trim();
    // `var(--x)` with nothing after the name has no fallback.
    if (rest === '') withoutFallback.add(token[1]);
  }
}

console.log(`reader stylesheets: ${sheets.length}`);
console.log(`distinct --dsw-* tokens referenced: ${used.size}`);
console.log(`tokens used with no fallback: ${withoutFallback.size}`);
console.log('a sample of those:', [...withoutFallback].slice(0, 14).join(', '));

// Which of them matter for the Markdown and text bodies specifically.
const markdownSheets = sheets.filter((sheet) => /MarkdownText_markdown|_document\{|dhJKeW_body/.test(sheet));
const markdownTokens = new Set();
for (const sheet of markdownSheets) {
  for (const token of sheet.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) markdownTokens.add(token[1]);
}
console.log(`\ntokens the Markdown/text bodies depend on: ${markdownTokens.size}`);
console.log([...markdownTokens].sort().join('\n'));
