/**
 * Report the stylesheets the reader injects at run time.
 *
 * The renderer bundle carries its own CSS as string literals and creates a
 * `<style>` tag per module, so a layout difference between this app and DSH can
 * be traced to specific rules instead of guessed at. Each injected sheet is
 * printed with the selector block that matters for the case at hand.
 *
 * Usage: node tools/dump-styles.mjs [substring] [blocks]
 */
import fs from 'node:fs/promises';

const needle = process.argv[2] ?? 'document';
const maxBlocks = Number(process.argv[3] ?? 3);

const source = await fs.readFile('vendor/client.js', 'utf8');

// The bundle writes each sheet as `const css = "<rules>"` before creating a
// <style> element; the literal is the only place the rules exist.
const literal = /const (css(?:\$\d+)?) = "((?:[^"\\]|\\.)*)";/g;
const sheets = [];
let match;
while ((match = literal.exec(source)) !== null) {
  const text = match[2]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
  if (!text.includes('{')) continue;
  sheets.push({ name: match[1], text, at: match.index });
}

console.log(`reader bundle declares ${sheets.length} stylesheet literal(s)`);

const interesting = sheets.filter((sheet) => sheet.text.includes(needle));
console.log(`matching "${needle}": ${interesting.length}\n`);

for (const sheet of interesting.slice(0, maxBlocks)) {
  const rules = sheet.text.split('}').map((part) => `${part}}`).filter((part) => part.includes('{'));
  const wanted = rules.filter((rule) =>
    /line-height|font-size|padding|margin|display|white-space|font-family/.test(rule),
  );
  console.log(`${'='.repeat(70)}\n${sheet.name} (${sheet.text.length} chars, ${rules.length} rules)\n${'='.repeat(70)}`);
  for (const rule of wanted.slice(0, 24)) console.log(rule.trim().replace(/\n/g, ' '));
  console.log();
}
