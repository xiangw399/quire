/**
 * Open every supported document through the running app and record what it did.
 *
 * The app is driven through the same entry point the desktop shell uses for a hand-off,
 * and each document is judged by what the reader drew: which renderer claimed it, how
 * many canvas pages or code pages appeared, and whether the body reported a failure.
 *
 * The documents come from this repository's own `fixtures/` directory by default, so the
 * check needs nothing but a checkout and a running app. `DSH_VIEWER_DOCS` points it at
 * another directory whose files carry the same names.
 *
 * Usage: node tools/verify-formats.mjs [cdp-port]
 */
import { chromium } from 'playwright-chromium';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
const docsDir = process.env.DSH_VIEWER_DOCS ?? path.resolve('fixtures');

/**
 * The documents to open, in the order they are checked, and how long each may take.
 *
 * A conversion through the Office engine is the slow case; everything else is a read
 * and a draw. The budget is per document, so one slow renderer cannot spend the whole
 * run's time and hide the documents behind it.
 */
const CASES = [
  ['real.docx', 'Word', 120000],
  ['sample.pptx', 'PowerPoint', 120000],
  ['sample.xlsx', 'Excel (xlsx)', 120000],
  ['sample.csv', 'Excel (csv)', 30000],
  ['sample.md', 'Markdown', 15000],
  ['sample.txt', 'Text', 15000],
  ['sample.pdf', 'PDF', 30000],
  ['sample.html', 'HTML', 15000],
  ['sample.png', 'PNG image', 15000],
  ['sample.js', 'Code', 15000],
  ['sample.json', 'JSON', 15000],
];

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages()[0];

/** Clear the strip, so each document is judged on its own body and nothing else. */
async function closeAll() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const open = await page.evaluate(() => document.querySelectorAll('.tab__close').length);
    if (open === 0) return;
    await page.evaluate(() => document.querySelector('.tab__close')?.click());
    await page.waitForTimeout(250);
  }
}

/**
 * What the reader drew for the document currently open.
 *
 * A placeholder canvas of the default 300x150 satisfies "a canvas exists", which would
 * report a conversion that has not finished as a success — so a canvas only counts when
 * it is the size of a page, and the other renderers are judged by their own evidence.
 */
const readState = () =>
  page.evaluate(() => {
    const body = document.querySelector('.body');
    const text = (body?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const canvases = [...document.querySelectorAll('.body canvas')];
    const images = [...document.querySelectorAll('.body img')];
    return {
      renderer: document.querySelector('[data-document-preview]')?.getAttribute('data-document-preview') ?? null,
      canvases: canvases.filter((canvas) => canvas.width > 500 && canvas.height > 300).length,
      canvasSizes: canvases.map((canvas) => `${canvas.width}x${canvas.height}`),
      pageSized: canvases.some((canvas) => canvas.width > 500 && canvas.height > 300),
      drawnImage: images.some((image) => image.naturalWidth > 0),
      iframes: body?.querySelectorAll('iframe').length ?? 0,
      rows: body?.querySelectorAll('table tr').length ?? 0,
      textLength: text.length,
      failed: /无法显示|读取失败|失败：|超过预览大小/.test(text),
      message: text.slice(0, 110),
    };
  });

/** Whether this document produced the evidence its renderer is supposed to produce. */
const drew = (state) => state.pageSized || state.drawnImage || state.iframes > 0 || state.rows > 0 || state.textLength > 30;

const results = [];
for (const [name, label, budget] of CASES) {
  const target = path.join(docsDir, name);
  try {
    await fs.access(target);
  } catch {
    results.push({ name, label, status: 'fixture missing' });
    console.log(`${'skip'.padEnd(5)} ${label.padEnd(18)} ${name.padEnd(16)} (no fixture at ${target})`);
    continue;
  }

  await closeAll();
  const started = Date.now();
  await page.evaluate((file) => globalThis.__DSH_VIEWER_OPEN_PATH__?.(file), target);

  let state = await readState();
  while (Date.now() - started < budget) {
    await page.waitForTimeout(500);
    state = await readState();
    const busy = /渲染中|转换中|正在/.test(state.message);
    if (!busy && state.renderer !== null && (drew(state) || state.failed)) break;
  }

  const ok = !state.failed && state.renderer !== null && drew(state);
  results.push({ name, label, status: ok ? 'ok' : 'FAILED', ms: Date.now() - started, ...state });
  console.log(
    `${(ok ? 'ok  ' : 'FAIL').padEnd(5)} ${label.padEnd(18)} ${name.padEnd(16)} ` +
      `${String(Date.now() - started).padStart(6)}ms ` +
      `renderer=${(state.renderer ?? '(none)').split('/').pop().padEnd(9)} ` +
      `canvas=${state.canvases} rows=${state.rows} iframes=${state.iframes} chars=${state.textLength}` +
      (ok ? '' : `  :: ${state.message}`),
  );
}

await browser.close();

const checked = results.filter((result) => result.status !== 'fixture missing');
const failed = results.filter((result) => result.status === 'FAILED');
console.log(`\n${checked.length - failed.length}/${checked.length} documents rendered`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((result) => result.name).join(', ')}`);
  process.exitCode = 2;
}
