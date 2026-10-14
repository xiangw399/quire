/**
 * Headless verification harness for the shell.
 *
 * It attaches to the browser started by `tools/start-browser.mjs` — over the
 * DevTools port rather than Playwright's own pipe launch — and reports what
 * actually happened: console errors, the boot audit the reader exposes, the
 * rendered text, and a screenshot for visual confirmation.
 */
import { chromium } from 'playwright-chromium';
import fs from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4321/';
const file = process.argv[3];
const shotName = process.argv[4] ?? 'p0-text';
const cdpPort = Number(process.env.DSH_VIEWER_CDP_PORT ?? 9222);

const outDir = path.resolve('artifacts');
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

const consoleMessages = [];
page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => consoleMessages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));

const target = file === undefined ? url : `${url}?file=${encodeURIComponent(file)}`;
await page.goto(target, { waitUntil: 'load' });

// Wait for the reader to boot and paint something.
await page.waitForFunction(() => globalThis.__DSH_VIEWER__ !== undefined, undefined, { timeout: 30000 });
const boot = await page.evaluate(() => ({
  ready: globalThis.__DSH_VIEWER__?.ready,
  error: globalThis.__DSH_VIEWER__?.error,
  audit: globalThis.__DSH_VIEWER__?.audit,
}));

if (file !== undefined) {
  // Give the reader time to read its first page and settle.
  await page.waitForTimeout(2500);
}

const rendered = await page.evaluate(() => {
  const body = document.querySelector('.body');
  return {
    text: body?.innerText?.slice(0, 4000) ?? '',
    html: body?.innerHTML?.slice(0, 2000) ?? '',
    tabCount: document.querySelectorAll('.tab').length,
    treeCount: document.querySelectorAll('.tree__entry').length,
    bodyClasses: body?.firstElementChild?.className ?? '',
  };
});

await page.screenshot({ path: path.join(outDir, `${shotName}.png`), fullPage: false });
await page.close();
await browser.close();

console.log('=== boot ===');
console.log(JSON.stringify(boot, null, 2));
console.log('\n=== rendered ===');
console.log(`tabs=${rendered.tabCount} tree=${rendered.treeCount} bodyChild="${rendered.bodyClasses}"`);
console.log(rendered.text);
console.log('\n=== console ===');
console.log(consoleMessages.length === 0 ? '(clean)' : consoleMessages.join('\n'));
