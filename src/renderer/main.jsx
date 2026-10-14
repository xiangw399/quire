/**
 * Renderer entry: boot the reader, then mount the shell.
 *
 * The reader needs a document to be useful, so the shell opens the file named in
 * the URL (`?file=…`) when one is present — that is how the dev server and the
 * verification harness drive it.
 *
 * `start()` is exported so the verification harness can mount the *built* bundle
 * itself, in a simulated document, instead of relying on a browser being
 * available.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
// The shell's own chrome. Imported rather than linked from the page, so the bundler
// owns it: a stylesheet named only in `index.html` is never part of the build, and
// the layout then silently falls back to the browser's defaults.
import './shell.css';
import { App } from './App.jsx';
import { bootReader } from './dsh/boot.js';
import { bridgeState } from './dsh/bridge.js';
import { createHttpHost, createRemote } from './host-client.js';
import { prepareEnvironment } from './runtime-config.js';

/** Read the file the shell was asked to open, if any. */
function requestedFile() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  return globalThis.__DSH_VIEWER_OPEN__ ?? params.get('file') ?? undefined;
}

/**
 * The navigation parameters an opening reference supplied.
 *
 * A file reference carries a 1-based source line; the shell hands it to the tab
 * verbatim, which is what the reader's "jump to line" reads.
 */
function requestedParams() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const line = params.get('line');
  if (line === null) return undefined;
  const parsed = Number(line);
  return Number.isFinite(parsed) ? { line: parsed } : undefined;
}

/**
 * Boot and mount the shell.
 * @param options - the DOM container, the host face to read through, and the
 *                  navigation parameters to open with.
 */
export async function start({ container, host, remote, openFile, openWith, themePreference } = {}) {
  const target = container ?? document.getElementById('root');
  // The desktop app publishes its bridge faces here; a harness publishes its own.
  // A real page publishes nothing and reads through the dev server's HTTP API.
  const environment = await prepareEnvironment();
  const shellHost = host ?? globalThis.__DSH_VIEWER_HOST__ ?? createHttpHost({ root: globalThis.__DSH_VIEWER_ROOT__ });
  const shellRemote = remote ?? globalThis.__DSH_VIEWER_REMOTE__ ?? createRemote(shellHost);
  const shellContainer = container ?? globalThis.__DSH_VIEWER_CONTAINER__ ?? target;

  const runtime = await bootReader({
    remote: shellRemote,
    host: shellHost,
    // The scripted HTML preview, which is what DSH's own sidebar uses.
    //
    // Off, the reader renders a DOMPurify-sanitized document in an iframe with no sandbox
    // permissions: no scripts, no remote resources, no connections. A report whose chart is
    // drawn by JavaScript (ECharts and friends) then shows an empty box, while every static
    // part of the same report still renders — which reads as "the app lost data".
    //
    // On, the reader packs the document's relative scripts and stylesheets and runs the
    // document in a sandboxed `allow-scripts` iframe instead, so a document's own scripts
    // — and the https resources they name — work as they do in a browser. The iframe keeps
    // an opaque origin, so the document still cannot reach this page or the host bridge.
    interactiveHtmlPreview: true,
    themePreference: themePreference ?? globalThis.__DSH_VIEWER_THEME__ ?? 'dark',
    // A throwaway profile is announced by the host that made it, so a remembered
    // choice from an earlier session cannot decide what the run sees.
    restoreSettings: globalThis.__DSH_VIEWER_FRESH_SETTINGS__ !== true,
  });
  const params = openWith ?? requestedParams();

  globalThis.__DSH_VIEWER__ = {
    ready: true,
    desktop: environment.desktop,
    audit: runtime.audit,
    runtime,
    host: shellHost,
    /** Live vendor-module state: which lazy chunks have materialized so far. */
    bridge: () => bridgeState(),
    /** The shell's own open path, for a hand-off from the host process. */
    openPath: (target, openParams) => globalThis.__DSH_VIEWER_OPEN_PATH__?.(target, openParams),
    /** The theme the document is actually showing, read from what was applied. */
    theme: () => (document.body.getAttribute('data-ds-dark-theme') === null ? 'light' : 'dark'),
  };

  /**
   * The host process can change the theme without a relaunch.
   *
   * The theme service lives in the context's own service table — not on the runtime
   * object — and reports whether the change landed, so the menu can reflect what the
   * document is actually showing rather than what was requested.
   */
  globalThis.__DSH_VIEWER_SET_THEME__ = (next) => {
    const theme = runtime.ctx?.reflect?.get?.('theme');
    if (theme === undefined) return false;
    try {
      theme.setTheme(next);
      return true;
    } catch (error) {
      console.error('[shell] the theme service refused the change:', error);
      return false;
    }
  };

  createRoot(shellContainer).render(<App runtime={runtime} host={shellHost} openWith={params} />);

  const file = openFile ?? requestedFile();
  if (file !== undefined) globalThis.__DSH_VIEWER__.openPath(file);
  return runtime;
}

// The bundle is also imported by the verification harness, which calls `start`
// with its own document and host; only a real page auto-starts.
if (typeof document !== 'undefined' && globalThis.__DSH_VIEWER_AUTOSTART__ !== false) {
  start().catch((error) => {
    console.error('[shell] boot failed', error);
    globalThis.__DSH_VIEWER__ = { ready: false, error: String(error?.stack ?? error?.message ?? error) };
    const container = document.getElementById('root');
    if (container !== null) {
      container.innerHTML = `<pre class="boot-failure">启动失败：\n${String(error?.stack ?? error)}</pre>`;
    }
  });
}
