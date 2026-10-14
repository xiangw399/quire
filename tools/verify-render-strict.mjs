/**
 * Strict check of the renderers that draw to a canvas.
 *
 * The format matrix accepts any non-empty canvas, which a placeholder of the default
 * 300x150 satisfies before the real page is drawn — that predicate passed a document
 * whose conversion had not finished. This one waits for a canvas the size of a page
 * (or a sheet) before it believes the renderer, so a slow conversion reads as slow
 * rather than as success.
 *
 * Usage: node tools/verify-render-strict.mjs [cdp-port]
 */
import { chromium } from 'playwright-chromium';
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
const CASES = (process.env.DSH_VIEWER_STRICT_CASES ?? 'real.docx,sample.pptx,sample.xlsx,sample.pdf').split(',');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];

/** Clear the strip so each case is judged on its own body. */
async function closeAll() {
  for (let i = 0; i < 20; i += 1) {
    const open = await page.evaluate(() => document.querySelectorAll('.tab__close').length);
    if (open === 0) return;
    await page.evaluate(() => document.querySelector('.tab__close')?.click());
    await page.waitForTimeout(250);
  }
}

const read = () =>
  page.evaluate(() => {
    const body = document.querySelector('.body');
    const text = (body?.textContent ?? '').replace(/\s+/g, ' ');
    const canvases = [...document.querySelectorAll('.body canvas')];
    return {
      sizes: canvases.map((canvas) => `${canvas.width}x${canvas.height}`),
      pageSized: canvases.some((canvas) => canvas.width > 500 && canvas.height > 300),
      busy: /渲染中|转换中/.test(text),
      error: body?.querySelector('.body__error')?.textContent?.slice(0, 140) ?? null,
      text: text.slice(0, 80),
    };
  });

let problems = 0;
for (const name of CASES) {
  await closeAll();
  const started = Date.now();
  await page.evaluate((file) => globalThis.__DSH_VIEWER_OPEN_PATH__?.(file), path.resolve('fixtures', name));
  let state = await read();
  for (let attempt = 0; attempt < 60 && !state.pageSized; attempt += 1) {
    await page.waitForTimeout(1500);
    state = await read();
  }
  const ok = state.pageSized && state.error === null;
  if (!ok) problems += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(Date.now() - started).padStart(7)}ms  ` +
      `canvases=${JSON.stringify(state.sizes)} busy=${state.busy}${state.error === null ? '' : `  ERR: ${state.error}`}`,
  );
  console.log(`      text: ${state.text}`);
}

await browser.close();
console.log(problems === 0 ? '\nall strict canvas checks passed' : `\n${problems} case(s) failed`);
process.exit(problems === 0 ? 0 : 2);
