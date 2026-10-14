/**
 * Regression for the scripted HTML preview: opening an HTML document must run that
 * document's own scripts, in a frame this page cannot see into.
 *
 * Why this exists: the reader has two preview policies, and the shell used to keep the
 * safe one — a DOMPurify-sanitized document with no scripts. A report whose chart is drawn
 * by JavaScript (ECharts and the like) then shows an empty box while every static part of
 * the same report renders, which reads as "the app lost data" (it happens in
 * `fixtures/chart.html` too: an empty canvas). The scripted policy is what DSH's own
 * sidebar uses, and this check keeps it from being switched off again in silence.
 *
 * The preview frame is a sandboxed, origin-less iframe, so it is its own CDP target and
 * Playwright's `connectOverCDP` does not list it as a frame. The check therefore speaks
 * CDP directly: it asks the running app to open the fixture, then attaches to the frame
 * target and reads the canvas' pixels there.
 *
 * Usage: node tools/verify-html-preview.mjs [cdp-port]
 */
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.DSH_VIEWER_CDP_PORT ?? 9333);
const endpoint = `http://127.0.0.1:${port}`;
const fixture = path.resolve('fixtures', 'chart.html');

const list = await (await fetch(`${endpoint}/json/list`)).json();
const pageTarget = list.find((target) => target.type === 'page');
if (pageTarget === undefined) {
  console.log('[verify-html-preview] the app exposes no page');
  process.exit(1);
}

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const frames = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params;
    frames.push({ sessionId, type: targetInfo.type, url: targetInfo.url });
  }
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = (nextId += 1);
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });

const evaluate = async (expression, sessionId) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return reply.result?.result?.value;
};

await send('Runtime.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

// Ask the app to open the fixture through its own open path, exactly as a hand-off would.
const opened = await evaluate(
  `(() => {
    const face = globalThis.__DSH_VIEWER__;
    if (face === undefined || typeof face.openPath !== 'function') return 'no-open-path';
    face.openPath(${JSON.stringify(fixture)});
    return 'ok';
  })()`,
);
console.log(`[verify-html-preview] opened ${fixture} :: ${opened}`);

/** Colored pixels in the fixture's canvas, read inside the preview frame itself. */
const PAINTED = `(() => {
  const canvas = document.getElementById('chart');
  if (canvas === null) return JSON.stringify({ fixture: false });
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let colored = 0;
  for (let at = 0; at < image.length; at += 4) {
    if (image[at + 3] > 0 && (image[at] < 250 || image[at + 1] < 250 || image[at + 2] < 250)) colored += 1;
  }
  return JSON.stringify({
    fixture: true,
    drawn: document.documentElement.getAttribute('data-chart-drawn'),
    width: canvas.width,
    height: canvas.height,
    coloredPixels: colored,
    hasBridge: typeof globalThis.docviewer !== 'undefined',
  });
})()`;

let report = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  for (const frame of frames.filter((entry) => entry.type === 'iframe')) {
    const raw = await evaluate(PAINTED, frame.sessionId);
    if (typeof raw !== 'string') continue;
    const parsed = JSON.parse(raw);
    if (parsed.fixture === true) {
      report = { ...parsed, frame: frame.url.slice(0, 40) };
      break;
    }
  }
  if (report !== null && report.coloredPixels > 500) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

socket.close();

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  :: ${detail}`}`);
  if (!ok) problems.push(label);
};

check('the HTML document opened in a scripted preview frame', report?.fixture === true, report === null ? 'no preview frame carried the fixture' : report.frame);
check('the document\'s inline script ran', report?.drawn === 'yes', String(report?.drawn));
check('the script painted the chart', (report?.coloredPixels ?? 0) > 500, `colored pixels: ${report?.coloredPixels ?? 0} on a ${report?.width ?? 0}x${report?.height ?? 0} canvas`);
check('that frame still has no host bridge', report?.hasBridge === false, `hasBridge: ${report?.hasBridge}`);

console.log(`\n${problems.length === 0 ? 'scripted HTML preview verified' : `problems: ${problems.join('; ')}`}`);
process.exit(problems.length === 0 ? 0 : 2);
