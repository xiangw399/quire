/**
 * End-to-end check of the running desktop app, in its own engine.
 *
 * The simulated-DOM harness proves the reader renders; only a real engine can prove
 * the things this shell is responsible for — that the design tokens resolve to
 * values, that the tab strip stays one row as documents open, that the guide card
 * measures as the reader's does, and that a document's typography matches the
 * reader's own rules.
 *
 * The app is driven through the entry point the desktop shell itself uses for a
 * hand-off, so nothing private is poked.
 *
 * A document has to be on screen for the renderer checks to mean anything. Launch the
 * app with one (`node tools/launch-app.mjs --document fixtures/sample.md`), or let this
 * open a fixture itself when it finds an empty window.
 *
 * Usage: node tools/verify-app.mjs [cdp-port]
 */
import { chromium } from 'playwright-chromium';
import fs from 'node:fs/promises';
import path from 'node:path';

const cdpPort = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
/** The second document, used to see the strip hold one row with two tabs. */
const secondFixture = path.resolve('fixtures', process.argv[3] ?? 'sample.txt');
const outDir = path.resolve('artifacts');
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const context = browser.contexts()[0];
if (context === undefined) {
  console.log('[verify-app] the app exposes no browser context');
  process.exit(1);
}
const pages = context.pages();
const page = pages[0];
if (page === undefined) {
  console.log('[verify-app] the app exposes no page');
  process.exit(1);
}

const consoleMessages = [];
page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`));

// The layout is sampled before any document is opened, so a window that came up empty
// has to be given one here. Without this the run ends in "no renderer claimed the
// document" — a failure of the harness rather than of the app.
const firstFixture = path.resolve('fixtures', process.env.DSH_VIEWER_FIRST ?? 'sample.md');
if ((await page.evaluate(() => document.querySelectorAll('.tab').length)) === 0) {
  await page.evaluate((target) => globalThis.__DSH_VIEWER_OPEN_PATH__?.(target), firstFixture);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(500);
    if (await page.evaluate(() => document.querySelector('[data-document-preview]') !== null)) break;
  }
  console.log(`[verify-app] opened ${path.basename(firstFixture)} because the window was empty`);
}

/** What the shell's chrome and the reader's body measure right now. */
const readLayout = () =>
  page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const tokenNames = [
      '--dsw-font-markdown-base',
      '--dsw-alias-bg-document-preview',
      '--dsw-font-family',
      '--dsw-radius-xl',
    ];
    const tokens = {};
    for (const name of tokenNames) tokens[name] = rootStyle.getPropertyValue(name).trim() || '(undefined)';

    // A token's raw value is not always readable on the root element: the theme
    // scopes its vocabulary, and the *substituted* value shows up where it is used.
    // So a token counts as resolved when a declaration that consumes it resolves.
    const markdownTextEl = document.querySelector('.MarkdownText_markdown');
    const primaryInk = document.querySelector('[data-textpreview-path]') ?? markdownTextEl;
    tokens['--dsw-font-markdown-base (as used)'] =
      markdownTextEl === null || markdownTextEl === undefined
        ? '(no markdown body)'
        : `${getComputedStyle(markdownTextEl).fontSize} / ${getComputedStyle(markdownTextEl).lineHeight}`;
    tokens['--dsw-alias-label-primary (as used)'] =
      primaryInk === null || primaryInk === undefined ? '(no text)' : getComputedStyle(primaryInk).color;

    const sheets = [...document.querySelectorAll('style')];
    const defined = new Set();
    for (const sheet of sheets) {
      for (const hit of (sheet.textContent ?? '').matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) defined.add(hit[1]);
    }

    const tabsEl = document.querySelector('.tabs');
    const tabNodes = [...document.querySelectorAll('.tab')];
    const rows = new Set(tabNodes.map((node) => Math.round(node.getBoundingClientRect().top)));
    const body = document.querySelector('.body');
    const markdown = document.querySelector('.MarkdownText_markdown');
    const heading = markdown?.querySelector('h1');
    const guide = document.querySelector('.guide__entry');

    return {
      tokens,
      definedTokens: defined.size,
      styleSheets: sheets.length,
      hasSidebar: document.querySelector('.tree') !== null,
      tabCount: tabNodes.length,
      tabTitles: tabNodes.map((node) => node.querySelector('.tab__title')?.textContent ?? ''),
      tabRows: rows.size,
      tabStripScrollsHorizontally: tabsEl === null ? false : tabsEl.scrollWidth > tabsEl.clientWidth,
      renderer: document.querySelector('[data-document-preview]')?.getAttribute('data-document-preview') ?? null,
      bodyWidth: body === null ? 0 : Math.round(body.getBoundingClientRect().width),
      markdownFont: markdown === null || markdown === undefined ? null : getComputedStyle(markdown).font,
      markdownFontSize: markdown === null || markdown === undefined ? null : getComputedStyle(markdown).fontSize,
      markdownLineHeight: markdown === null || markdown === undefined ? null : getComputedStyle(markdown).lineHeight,
      headingFont: heading === undefined || heading === null ? null : getComputedStyle(heading).font,
      headingMargin: heading === undefined || heading === null ? null : getComputedStyle(heading).margin,
      guideWidth: guide === null ? null : Math.round(guide.getBoundingClientRect().width),
      guideRadius: guide === null ? null : getComputedStyle(guide).borderRadius,
      guideTitle: document.querySelector('.guide__title')?.textContent ?? null,
      guideShortcutKeycaps: document.querySelectorAll('.guide__shortcut span').length,
      /** The palette actually in force: the theme's scheme is an attribute on `body`. */
      themeScheme: document.body.getAttribute('data-ds-dark-theme') === null ? 'light' : 'dark',
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      text: (body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    };
  });

const first = await readLayout();
await page.screenshot({ path: path.join(outDir, 'app-one-document.png') });

// The theme switch, driven through the same entry point the View menu uses: a
// checkbox that changes nothing on screen is worse than no checkbox at all.
const themeSwitch = await page.evaluate(async () => {
  const set = globalThis.__DSH_VIEWER_SET_THEME__;
  if (typeof set !== 'function') return { available: false };
  const sample = () => ({
    theme: globalThis.__DSH_VIEWER__?.theme?.(),
    background: getComputedStyle(document.body).backgroundColor,
  });
  const before = sample();
  const toLight = set('light');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const light = sample();
  const toDark = set('dark');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const dark = sample();
  return { available: true, before, light, dark, acceptedLight: toLight, acceptedDark: toDark };
});

// A second document, delivered the way the main process delivers one: through the
// page-level open entry point the shell publishes. The check is what happens to the
// strip, not how the document was chosen.
const second = await page.evaluate((target) => {
  const open = globalThis.__DSH_VIEWER_OPEN_PATH__;
  if (typeof open !== 'function') return { opened: false };
  open(target);
  return { opened: true };
}, secondFixture);
void second;
await page.waitForTimeout(1200);

const afterHandoff = await readLayout();

await page.screenshot({ path: path.join(outDir, 'app-after-handoff.png') });
await browser.close();

console.log('=== running desktop app ===');
console.log(`styleSheets=${first.styleSheets} definedTokens=${first.definedTokens}`);
for (const [name, value] of Object.entries(first.tokens)) console.log(`  ${name.padEnd(34)} ${value.slice(0, 62)}`);
console.log(`\nfile browser rendered: ${first.hasSidebar}   (expected false)`);
console.log(`theme: ${first.themeScheme}  body background ${first.bodyBackground}`);
if (themeSwitch.available) {
  console.log(
    `theme switch: ${themeSwitch.before.theme}/${themeSwitch.before.background} -> ` +
      `${themeSwitch.light.theme}/${themeSwitch.light.background} -> ${themeSwitch.dark.theme}/${themeSwitch.dark.background}`,
  );
} else {
  console.log('theme switch: not exposed by the page');
}
console.log(`body width: ${first.bodyWidth}px`);
console.log(`tabs: ${first.tabCount} [${first.tabTitles.join(' | ')}] rows=${first.tabRows} scrollable=${first.tabStripScrollsHorizontally}`);
console.log(`renderer: ${first.renderer}`);
console.log(`markdown: font-size=${first.markdownFontSize} line-height=${first.markdownLineHeight}`);
console.log(`markdown font: ${first.markdownFont}`);
console.log(`h1: font=${first.headingFont}`);
console.log(`h1 margin: ${first.headingMargin}`);
console.log(`guide card: title=${JSON.stringify(first.guideTitle)} width=${first.guideWidth} radius=${first.guideRadius} keycaps=${first.guideShortcutKeycaps}`);
console.log(`text: ${first.text}`);
console.log(`\nafter a hand-off: tabs=${afterHandoff.tabCount} rows=${afterHandoff.tabRows} [${afterHandoff.tabTitles.join(' | ')}]`);
console.log(`\nconsole: ${consoleMessages.length === 0 ? '(clean)' : consoleMessages.slice(0, 8).join('\n')}`);

const problems = [];
if (first.hasSidebar) problems.push('the file browser is still rendered');
if (first.definedTokens < 100) problems.push(`design tokens did not resolve (${first.definedTokens})`);
if (first.tabCount > 0 && first.tabRows !== 1) problems.push(`the tab strip wrapped into ${first.tabRows} rows`);
if (afterHandoff.tabCount > 1 && afterHandoff.tabRows !== 1) problems.push('the tab strip wrapped with two documents');
if (first.renderer === null) problems.push('no renderer claimed the document');
// The reader's own chrome is the dark reading surface DSH shows; a light background
// means the theme plugin's snapshot never reached the document.
if (first.themeScheme !== 'dark') problems.push(`the palette in force is ${first.themeScheme}, not dark`);
// The switch must actually switch: both directions, and back to where it started.
if (!themeSwitch.available) problems.push('the page exposes no theme switch');
else {
  if (themeSwitch.light.theme !== 'light') problems.push('switching to light did not change the palette');
  if (themeSwitch.dark.theme !== 'dark') problems.push('switching back to dark did not change the palette');
  if (themeSwitch.light.background === themeSwitch.dark.background) problems.push('the theme switch changed nothing on screen');
}
// The token set is present and the typography it drives resolved to its values:
// anything but a 14px/24px body means the theme did not reach the document.
if (first.markdownFontSize !== null && first.markdownFontSize !== '14px') {
  problems.push(`markdown body is ${first.markdownFontSize}, not the token's 14px`);
}
if (first.markdownLineHeight !== null && first.markdownLineHeight !== '24px') {
  problems.push(`markdown line-height is ${first.markdownLineHeight}, not the token's 24px`);
}
if (consoleMessages.some((line) => line.startsWith('pageerror'))) problems.push('the page threw');
console.log(`\n${problems.length === 0 ? 'all checks passed' : `problems: ${problems.join('; ')}`}`);
process.exit(problems.length === 0 ? 0 : 2);
