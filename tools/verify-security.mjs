/**
 * Security regression for the running desktop app, in its own engine.
 *
 * The shell serves a reader that opens documents the user did not write, so the
 * boundary this checks is the one that matters: the window must not be able to
 * leave the app's own page, whatever a document links to, and a previewed
 * document must not be able to reach the host bridge. Since 2026-10-13 the
 * previewed document is the scripted one — it may run its own inline script and
 * load https resources, which is what draws a report's chart — so the checks
 * below assert that capability *and* that it stays inside an origin-less frame.
 * Each check is written as the failure it would catch, not as a restatement of
 * the code.
 *
 * Usage: node tools/verify-security.mjs [cdp-port]
 */
import { chromium } from 'playwright-chromium';
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
const fixture = path.resolve('fixtures', 'sample.md');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = context.pages()[0];
if (page === undefined) {
  console.log('[verify-security] the app exposes no page');
  process.exit(1);
}

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  :: ${detail}`}`);
  if (!ok) problems.push(label);
};

// 1. The policy is actually delivered with the document.
const csp = await page.evaluate(() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return meta === null ? null : meta.getAttribute('content');
});
check('the page carries a Content-Security-Policy', csp !== null && csp.includes("object-src 'none'"), csp === null ? 'no meta tag' : '');

// 2. The bridge is present for the app's own page — the control for check 3.
const bridge = await page.evaluate(() => ({
  present: typeof globalThis.docviewer === 'object' && globalThis.docviewer?.isElectron === true,
}));
check('the host bridge is available to the app page', bridge.present === true);

// 3. Legitimate reads still work: the guard must not have broken the product.
const read = await page.evaluate(async (target) => {
  try {
    const result = await globalThis.docviewer.remote.workspaceFiles.read(
      'probe',
      target,
      { offset: 1 },
    );
    return { ok: result?.ok === true, code: result?.error?.code ?? null, chars: result?.value?.text?.length ?? 0 };
  } catch (error) {
    return { ok: false, code: 'threw', message: String(error?.message ?? error) };
  }
}, fixture);
check('a normal read through the bridge still succeeds', read.ok === true, JSON.stringify(read));

// 4. A link in a document must not carry the window to another site.
const before = page.url();
await page.evaluate(() => {
  setTimeout(() => {
    globalThis.location.href = 'https://example.com/';
  }, 10);
});
await page.waitForTimeout(2500);
const after = page.url();
check('a navigation away from the app page is refused', after === before, `url is now ${after}`);

// 5. A document asking for a popup must not get one, and no second page may appear.
const opened = await page.evaluate(() => {
  const handle = globalThis.open('https://example.com/', '_blank');
  return handle === null || handle === undefined;
});
await page.waitForTimeout(800);
const pages = context.pages().length;
check('window.open is denied', opened === true);
check('no extra page target appeared', pages === 1, `${pages} pages`);

// 6. The scripted preview is a capability now, not a violation: a preview document may run
//    its own inline script (that is what draws a report's chart). What still has to hold is
//    containment — that frame sees no host bridge and cannot read the parent's.
const scripted = await page.evaluate(async () => {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute(
    'srcdoc',
    '<!doctype html><html><body><script>'
      + 'let sawBridge = typeof globalThis.docviewer;'
      + 'let parentBridge = "unreadable";'
      + 'try { parentBridge = typeof parent.docviewer; } catch (error) { parentBridge = "blocked:" + error.name; }'
      + 'parent.postMessage({ ran: true, sawBridge: sawBridge, parentBridge: parentBridge }, "*");'
      + '<\/script></body></html>',
  );
  const seen = await new Promise((resolve) => {
    const onMessage = (event) => {
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    window.addEventListener('message', onMessage);
    document.body.append(frame);
    setTimeout(() => resolve(null), 3000);
  });
  frame.remove();
  return seen;
});
check(
  'a scripted preview frame runs its inline script, yet has no host bridge and cannot read the parent one',
  scripted?.ran === true && scripted?.sawBridge === 'undefined' && String(scripted?.parentBridge).startsWith('blocked'),
  JSON.stringify(scripted),
);

// 7. The bridge is not handed to a subframe: a preview iframe runs without it.
const framed = await page.evaluate(async () => {
  const frame = document.createElement('iframe');
  frame.setAttribute('srcdoc', '<!doctype html><html><body>probe</body></html>');
  document.body.append(frame);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const has = typeof frame.contentWindow?.docviewer === 'object';
  frame.remove();
  return has;
});
check('a subframe does not receive the host bridge', framed === false);

await browser.close();

console.log(`\n${problems.length === 0 ? 'all security checks passed' : `problems: ${problems.join('; ')}`}`);
process.exit(problems.length === 0 ? 0 : 2);
