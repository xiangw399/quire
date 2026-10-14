/**
 * End-to-end check that paging a very large text file cannot take the app down.
 *
 * The host used to decode a whole file to answer one page, so a document of a few
 * hundred megabytes was an out-of-memory crash rather than a slow page. This opens
 * the same request through the page's own bridge — the path the reader uses — and
 * then proves the app is still answering afterwards.
 *
 * The fixture is generated once under the system temporary directory. Its size is
 * DSH_VIEWER_LARGE_MB (default 200).
 *
 * Usage: node tools/verify-large-file.mjs [cdp-port]
 */
import { chromium } from 'playwright-chromium';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
const target = process.env.DSH_VIEWER_LARGE_FILE ?? path.join(os.tmpdir(), 'doc-viewer-large.txt');
const megabytes = Number(process.env.DSH_VIEWER_LARGE_MB ?? 200);

/** Write numbered lines until the file reaches the requested size. */
async function ensureFixture() {
  if (fs.existsSync(target) && fs.statSync(target).size >= megabytes * 1024 * 1024) return fs.statSync(target).size;
  const handle = await fs.promises.open(target, 'w');
  const limit = megabytes * 1024 * 1024;
  let written = 0;
  let number = 0;
  try {
    while (written < limit) {
      const block = [];
      for (let index = 0; index < 5000; index += 1) {
        number += 1;
        block.push(`line ${number} ${'abcdefghij'.repeat(2)}\n`);
      }
      const text = block.join('');
      await handle.write(text);
      written += Buffer.byteLength(text);
    }
  } finally {
    await handle.close();
  }
  return fs.statSync(target).size;
}

const size = await ensureFixture();
// Each line is "line <n> " + 20 characters + a newline, which is enough to land the
// deep probe in the middle of the file instead of past its end.
const estimatedLines = Math.max(2, Math.floor(size / 33));
console.log(`fixture: ${target} (${(size / 1024 / 1024).toFixed(0)} MB, ~${estimatedLines} lines)`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];

const readAt = (offset) =>
  page.evaluate(
    async ({ file, line }) => {
      const started = Date.now();
      try {
        const result = await globalThis.docviewer.remote.workspaceFiles.read(null, file, { offset: line });
        return {
          ok: result?.ok === true,
          ms: Date.now() - started,
          lines: result?.value?.lines ?? 0,
          eof: result?.value?.eof ?? null,
          first: (result?.value?.text ?? '').split('\n')[0]?.slice(0, 40) ?? '',
          code: result?.error?.code ?? null,
        };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, code: 'threw', first: String(error?.message ?? error).slice(0, 120) };
      }
    },
    { file: target, line: offset },
  );

const problems = [];
const first = await readAt(1);
console.log('page 1 :', JSON.stringify(first));
if (!first.ok || first.lines === 0) problems.push('the first page of a huge file did not come back');

const deepLine = Math.floor(estimatedLines / 2);
const deep = await readAt(deepLine);
console.log(`page @${deepLine}:`, JSON.stringify(deep));
if (!deep.ok) problems.push(`the page at line ${deepLine} did not come back`);

// The app must still be answering: a decode-the-whole-file host would be gone by now.
const alive = await page.evaluate(() => ({
  shell: document.querySelector('.shell') !== null,
  tabs: document.querySelectorAll('.tab').length,
}));
console.log('app after the reads:', JSON.stringify(alive));
if (!alive.shell) problems.push('the page is no longer showing the shell after reading the large file');

await browser.close();
console.log(`\n${problems.length === 0 ? 'large-file paging passed' : `problems: ${problems.join('; ')}`}`);
process.exit(problems.length === 0 ? 0 : 2);
