/**
 * DOM verification of the built shell.
 *
 * A confined Windows process cannot give Chromium the named pipe its
 * multi-process architecture needs, so a browser cannot be the verifier here.
 * This harness instead registers a DOM into Node's global scope and runs the
 * *built* bundle — the same file the browser loads — against the *same* host API
 * the dev server exposes. The reader's bundles, slot registrations, store,
 * resources, and read paths are all real; only the compositor is missing, so this
 * proves the integration and the content rather than the pixels.
 *
 * Usage: node --import ./tools/register-css-hook.mjs tools/verify-dom.mjs <file>
 */
import { Window } from 'happy-dom';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const requested = process.argv[2] ?? 'sample.md';

const window = new Window({ url: 'http://127.0.0.1:4321/' });
window.document.body.innerHTML = '<div id="root"></div>';

/** Assignment that survives Node's getter-only globals. */
function setGlobal(key, value) {
  if (value === undefined) return;
  try {
    globalThis[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

// The reader contains some failures by design: a preview it cannot build renders
// its own "cannot preview" line, which hides the cause. These probes make the
// cause observable, by reporting any DOM call that throws inside the reader.
const swallowed = [];
function traceThrows(target, name, label) {
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target[name] = function traced(...args) {
    try {
      return original.apply(this, args);
    } catch (error) {
      swallowed.push(`${label}: ${error?.stack ?? error}`);
      throw error;
    }
  };
}
traceThrows(window.DOMParser?.prototype, 'parseFromString', 'DOMParser.parseFromString');
traceThrows(window.Document?.prototype, 'createElement', 'Document.createElement');
traceThrows(window.Node?.prototype, 'appendChild', 'Node.appendChild');
traceThrows(window.Element?.prototype, 'prepend', 'Element.prepend');

// The reader decodes bytes with a fatal TextDecoder, so an undecodable payload is
// one of the ways a preview fails without an error reaching the page.
const OriginalTextDecoder = globalThis.TextDecoder;
class TracedTextDecoder extends OriginalTextDecoder {
  decode(input, options) {
    try {
      return super.decode(input, options);
    } catch (error) {
      swallowed.push(`TextDecoder.decode(${input?.byteLength ?? input?.length ?? 'n/a'} bytes): ${error?.message}`);
      throw error;
    }
  }
}
globalThis.TextDecoder = TracedTextDecoder;

const domGlobals = {
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
};
for (const [key, value] of Object.entries(domGlobals)) setGlobal(key, value);
setGlobal('self', globalThis);
if (typeof window.matchMedia === 'function') setGlobal('matchMedia', window.matchMedia.bind(window));

// React 18's client renderer reads this to decide whether to warn about act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__DSH_VIEWER_AUTOSTART__ = false;

// The host: the very API the dev server wraps.
const { createHostApi } = await import('../src/main/host-api.js');
const { createShellHost } = await import('./dom-host.mjs');
const { createRemote } = await import('../src/renderer/host-client.js');

const api = createHostApi({ workspaceRoot: path.resolve('fixtures') });
const host = createShellHost({ api });
const remote = createRemote(host);

const errors = [];
/** Non-fatal notices the reader emits; reported, but not a verification failure. */
const notices = [];
window.addEventListener('error', (event) => errors.push(String(event.error?.stack ?? event.message)));
const originalError = console.error;
console.error = (...args) => {
  errors.push(args.map((value) => (value instanceof Error ? value.stack : String(value))).join(' '));
  originalError(...args);
};
// The reader contains some failures by design (a preview that cannot be built
// renders its own message), which hides the cause. This probe reports the first
// swallowed error with its stack so the harness can tell the two apart.
const originalWarn = console.warn;
console.warn = (...args) => {
  notices.push(args.map((value) => (value instanceof Error ? value.stack : String(value))).join(' '));
  originalWarn(...args);
};
/** The cold-start path: a file handed to the shell before any tree interaction. */
const coldStart = process.env.DSH_VIEWER_COLD_START === '1';
window.addEventListener('unhandledrejection', (event) => errors.push(`unhandled: ${event.reason?.stack ?? event.reason}`));

// Error constructors are traced last, so a swallowed exception still leaves its
// stack behind: `new Error(...)` is the one call every JavaScript throw makes.
const OriginalError = globalThis.Error;
const constructed = [];
class TracedError extends OriginalError {
  constructor(...args) {
    super(...args);
    const stack = String(this.stack ?? '');
    // Only record the construction sites that are not the harness's own.
    if (!stack.includes('verify-dom.mjs') && constructed.length < 40) constructed.push(stack);
  }
}
globalThis.Error = TracedError;
for (const [name, Type] of Object.entries({
  TypeError: globalThis.TypeError,
  RangeError: globalThis.RangeError,
  SyntaxError: globalThis.SyntaxError,
})) {
  const Traced = class extends Type {
    constructor(...args) {
      super(...args);
      const stack = String(this.stack ?? '');
      if (!stack.includes('verify-dom.mjs') && constructed.length < 40) constructed.push(stack);
    }
  };
  setGlobal(name, Traced);
}

// The built bundle, exactly as a browser would load it.
//
// The cold-start case publishes the file before the shell starts, which is the
// A document arrives the way the desktop app delivers one: published before the
// shell starts, which is the path an "open with" or a hand-off takes. The shell has
// no file browser, so nothing is driven through a panel.
//
// `DSH_VIEWER_EMPTY=1` starts the shell with nothing open instead, which is how the
// empty state — the shell's own chrome — gets checked.
const emptyStart = process.env.DSH_VIEWER_EMPTY === '1';
if (!emptyStart) globalThis.__DSH_VIEWER_OPEN__ = path.resolve('fixtures', requested);
globalThis.__DSH_VIEWER_HOST__ = host;
globalThis.__DSH_VIEWER_REMOTE__ = remote;

const shell = await import(pathToFileURL(path.resolve('dist/web/shell.js')).href);
const runtime = await shell.start({ container: window.document.getElementById('root'), host, remote, openFile: undefined });

console.log('=== boot audit ===');
console.log(JSON.stringify(runtime.audit, null, 2));

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await settle(400);

// The empty state is the shell's own chrome, so it is checked as soon as the shell
// has drawn: the guide card is what a launch with nothing open shows.
const guide = window.document.querySelector('.guide__entry');
console.log('\n=== empty state ===');
console.log(`guide card present: ${guide !== null}`);
if (guide !== null) {
  console.log(`  title       ${guide.querySelector('.guide__title')?.textContent ?? '(none)'}`);
  console.log(`  description ${guide.querySelector('.guide__description')?.textContent ?? '(none)'}`);
  console.log(`  shortcut    ${guide.querySelector('.guide__shortcut')?.textContent ?? '(none)'}`);
  console.log(`  artwork     ${guide.querySelector('.guide__icon svg') !== null ? 'svg present' : 'MISSING'}`);
}

for (let attempt = 0; attempt < 90 && !emptyStart; attempt += 1) {
  await settle(100);
  const body = window.document.querySelector('.body');
  const text = (body?.textContent ?? '').trim();
  // "文档渲染中..." is the reader's own progress line; a real render replaces it.
  if (text.length > 0 && !text.includes('正在') && !text.includes('打开文档')) {
    const state = body?.querySelector('[data-textpreview-state]')?.getAttribute('data-textpreview-state');
    const busy = body?.querySelector('[data-image-preview-loading], [data-pdf-loading]') !== null;
    if (state !== 'loading' && !busy) break;
    if (attempt > 30 && state !== 'loading') break;
  }
}

const tabs = [...window.document.querySelectorAll('.tab')];
console.log('\n=== tab strip ===');
console.log(`tabs=${tabs.length} titles=${tabs.map((node) => node.querySelector('.tab__title')?.textContent).join(' | ')}`);

const body = window.document.querySelector('.body');
const text = (body?.textContent ?? '').replace(/\s+/g, ' ').trim();
console.log('\n=== rendered body ===');
console.log(`length=${text.length} bodyChildren=${body?.children.length ?? 0}`);
console.log(text.slice(0, 1500));

console.log('\n=== body structure ===');
console.log((body?.innerHTML ?? '').slice(0, 900));

// Which vendor chunks the reader pulled in while rendering this file: the lazy
// chunks (PDF.js, the spreadsheet stack) only materialize when such a file opens.
// The bridge lives inside the bundle, so the bundle's own accessor is asked.
console.log('\n=== bridge after render ===');
const live = globalThis.__DSH_VIEWER__?.bridge?.();
console.log(`factories=${JSON.stringify(live?.factories ?? [])}`);
console.log(`loaded=${JSON.stringify(live?.loaded ?? [])}`);

// The design tokens are the difference between "the reader's CSS applies" and
// "the browser's defaults apply": a `font:` shorthand whose token is undefined is
// discarded whole, so the check is whether the tokens are defined, not merely
// referenced.
const styleSheets = [...window.document.querySelectorAll('style')].map((node) => node.textContent ?? '');
const tokenDefinitions = new Set();
for (const sheet of styleSheets) {
  for (const token of sheet.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) tokenDefinitions.add(token[1]);
}
const shellCss = await fs.readFile(path.resolve('dist/web/shell.css'), 'utf8');
const referencedTokens = new Set([...shellCss.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]));
const unresolvedTokens = [...referencedTokens].filter((token) => !tokenDefinitions.has(token));
console.log('\n=== design tokens ===');
console.log(`injected stylesheets=${styleSheets.length} tokens defined=${tokenDefinitions.size}`);
console.log(
  `shell.css references=${referencedTokens.size} unresolved=${unresolvedTokens.length}${
    unresolvedTokens.length === 0 ? '' : ` -> ${unresolvedTokens.slice(0, 8).join(', ')}`
  }`,
);
for (const probe of ['--dsw-font-markdown-base', '--dsw-alias-label-primary', '--dsw-font-family']) {
  const pattern = new RegExp(`${probe}\\s*:\\s*([^;]+)`);
  const value = styleSheets.map((sheet) => pattern.exec(sheet)?.[1]).find((found) => found !== undefined);
  console.log(`${probe} -> ${value === undefined ? 'UNDEFINED' : value.trim().slice(0, 72)}`);
}

console.log('\n=== errors ===');
console.log(errors.length === 0 ? '(none)' : errors.slice(0, 12).join('\n---\n'));
if (notices.length > 0) {
  console.log('\n=== notices (non-fatal) ===');
  console.log(notices.slice(0, 4).join('\n'));
}

// One machine-readable line, so a caller that runs this per fixture can summarise
// without parsing prose.
const renderer = body?.querySelector('[data-document-preview]')?.getAttribute('data-document-preview');
const chunkState = globalThis.__DSH_VIEWER__?.bridge?.();
console.log(
  `\nRESULT ${JSON.stringify({
    fixture: requested,
    coldStart,
    renderer: renderer?.replace('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/', '') ?? null,
    state: body?.querySelector('[data-textpreview-state]')?.getAttribute('data-textpreview-state') ?? null,
    textLength: (body?.textContent ?? '').length,
    chunks: (chunkState?.factories ?? []).map((key) => key.split('#')[1]).filter(Boolean),
    errors: errors.length,
    notices: notices.length,
  })}`,
);
if (swallowed.length > 0) {
  console.log('\n=== DOM calls that threw (cause of a contained preview failure) ===');
  console.log(swallowed.slice(0, 6).join('\n---\n'));
}
if (constructed.length > 0 && process.env.DSH_VIEWER_TRACE_ERRORS === '1') {
  console.log('\n=== errors constructed during the run (stack origins) ===');
  const origins = new Set();
  for (const stack of constructed) {
    const line = stack.split('\n').find((entry) => entry.includes('vendor/') || entry.includes('shell.js'));
    if (line !== undefined) origins.add(line.trim());
  }
  console.log([...origins].slice(0, 20).join('\n'));
}

const outDir = path.resolve('artifacts');
await fs.mkdir(outDir, { recursive: true });
const slug = requested.replace(/[^\w.-]+/g, '_');
await fs.writeFile(path.join(outDir, `${slug}.rendered.html`), window.document.getElementById('root').innerHTML, 'utf8');
console.log(`\n[verify] wrote artifacts/${slug}.rendered.html`);

await runtime.dispose();
window.close();
// Held resources keep a polling timer alive; the verification is complete, so
// the process ends here rather than waiting for it.
process.exit(errors.length === 0 ? 0 : 2);
