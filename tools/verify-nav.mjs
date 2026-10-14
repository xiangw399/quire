/**
 * Navigation verification: does the reader page up to a line target and mark it?
 *
 * A file reference (or a search result) opens a tab with `navigation.params.line`;
 * the reader is expected to load pages until that line arrives and then mark it,
 * which is what makes "jump to line" work. This harness checks the loaded page
 * offsets and the marker the reader leaves in the DOM.
 *
 * Usage: node --import ./tools/register-css-hook.mjs tools/verify-nav.mjs <file> <line>
 */
import { Window } from 'happy-dom';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requested = process.argv[2] ?? 'lines.txt';
const targetLine = Number(process.argv[3] ?? 300);

const window = new Window({ url: 'http://127.0.0.1:4321/' });
window.document.body.innerHTML = '<div id="root"></div>';

function setGlobal(key, value) {
  if (value === undefined) return;
  try {
    globalThis[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  HTMLIFrameElement: window.HTMLIFrameElement,
  HTMLCanvasElement: window.HTMLCanvasElement,
  HTMLImageElement: window.HTMLImageElement,
  Element: window.Element,
  Node: window.Node,
  Text: window.Text,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent,
  DOMParser: window.DOMParser,
  XMLSerializer: window.XMLSerializer,
  Blob: window.Blob,
  File: window.File,
  FileReader: window.FileReader,
  URL: window.URL,
  URLSearchParams: window.URLSearchParams,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  IntersectionObserver: window.IntersectionObserver,
  CSS: window.CSS,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
})) setGlobal(key, value);
setGlobal('self', globalThis);
if (typeof window.matchMedia === 'function') setGlobal('matchMedia', window.matchMedia.bind(window));

const { createHostApi } = await import('../src/main/host-api.js');
const { createShellHost } = await import('./dom-host.mjs');
const { createRemote } = await import('../src/renderer/host-client.js');

// The shell reads its host faces from these before the bundle loads, so the
// simulated document is served by the in-process API rather than HTTP.
const api = createHostApi({ workspaceRoot: path.resolve('fixtures') });
const host = createShellHost({ api });
setGlobal('__DSH_VIEWER_HOST__', host);
setGlobal('__DSH_VIEWER_REMOTE__', createRemote(host));
setGlobal('__DSH_VIEWER_OPEN__', path.resolve('fixtures', requested));

const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.error?.stack ?? event.message)));

// One bundle instance: the same file a browser loads.
const shell = await import(pathToFileURL(path.resolve('dist/web/shell.js')).href);
await shell.start({
  container: window.document.getElementById('root'),
  openWith: { line: targetLine },
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(600);

let marker;
let pages = 0;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await settle(100);
  pages = window.document.querySelectorAll('[data-textpreview-page]').length;
  marker = window.document.querySelector('[data-textpreview-target]');
  if (marker !== null) break;
}

const state = window.document.querySelector('[data-textpreview-state]')?.getAttribute('data-textpreview-state');
const bodyHtml = window.document.querySelector('.body')?.innerHTML ?? '';
const offsets = [...window.document.querySelectorAll('[data-textpreview-page]')].map((node) =>
  Number(node.getAttribute('data-textpreview-page')),
);
const numbers = [...window.document.querySelectorAll('[data-textpreview-line]')].map((node) =>
  Number(node.getAttribute('data-textpreview-line')),
);
const markedLine = /data-textpreview-target="(\d+)"/.exec(bodyHtml)?.[1];

console.log('=== navigation ===');
console.log(`file=${requested} targetLine=${targetLine}`);
console.log(`shell nav state=${JSON.stringify(globalThis.__DSH_VIEWER_NAV__)}`);
console.log(`state=${state} pages=${pages} offsets=${JSON.stringify(offsets)}`);
console.log(`target marker=${marker === null ? 'none' : marker.getAttribute('data-textpreview-target')}`);
console.log(`raw marker in HTML=${markedLine ?? 'none'}`);
console.log(`line range=${numbers.length === 0 ? 'n/a' : `${Math.min(...numbers)}..${Math.max(...numbers)}`}`);
console.log(`line 300 present=${numbers.includes(300)}`);
console.log(`errors=${errors.length === 0 ? '(none)' : errors.join('\n')}`);

const ok = marker !== null && Number(marker.getAttribute('data-textpreview-target')) === targetLine;
console.log(ok ? '\n[verify] navigation PASSED' : '\n[verify] navigation FAILED');
process.exit(ok && errors.length === 0 ? 0 : 2);
