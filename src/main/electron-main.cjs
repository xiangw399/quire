/**
 * Electron main process: the desktop shell around the same reader.
 *
 * CommonJS, because Electron's ESM entry path is still experimental and this
 * process is not the interesting part of the app. The host API stays an ES module
 * and is loaded dynamically; nothing else here needs module syntax.
 *
 * The window loads the built shell from `dist/web`, and the preload publishes the
 * host faces as globals the shell already reads. Files are served to the page
 * through a private `dsh-file://` protocol rather than `file://`, so the renderer
 * keeps a normal web origin — which iframes, blob URLs, and PDF.js all assume.
 */
const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
/**
 * The promise face of the same module.
 *
 * `fs.readFile(path)` on `node:fs` takes a callback and returns `undefined`, so an
 * `await` on it fails with "The \"cb\" argument must be of type function" — the shape
 * this file needs is the promises one.
 */
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// The layout, the diagnostics and the page boundary each live in their own module: the
// boundary is the part worth reading on its own, and the trace is the part that has to
// work before anything else can.
const { pagePath, projectRoot, webRoot } = require('./paths.cjs');
const { trace } = require('./trace.cjs');
const { forbidden, fromOwnPage, installNavigationGuard, isOwnPage } = require('./security.cjs');

// A window cannot always be created: a confined or headless session refuses the
// graphics initialization and Chromium aborts the process outright. Recording each
// stage *before* it runs means such an exit still leaves a report naming the step
// that failed, instead of an empty log.
trace('1. main process evaluated');

/**
 * Give the Office engine a scratch directory this app owns.
 *
 * The engine builds its working directory — including the LibreOffice user profile —
 * under `os.tmpdir()`, which resolves `TEMP`/`TMP` on every call. The system temporary
 * folder is not always removable by the engine's own helper, and when that cleanup is
 * refused the kit throws *after* the PDF has been produced, turning a good conversion
 * into "conversion failed" with no way for the caller to tell the two apart.
 *
 * Pointing those variables at a directory under the app's own data root removes the
 * whole class of failure, and the trace records the choice so a stuck conversion can
 * be found on disk. Nothing else about the engine's behaviour changes.
 */
function prepareEngineScratch() {
  let base;
  try {
    base = path.join(app.getPath('userData'), 'office-scratch');
    fs.mkdirSync(base, { recursive: true });
  } catch (error) {
    trace(`engine scratch directory unavailable, keeping the system temporary folder: ${error?.message}`);
    return;
  }
  process.env.TEMP = base;
  process.env.TMP = base;
  process.env.TMPDIR = base;
  trace(`engine scratch directory ${base}`);
  // Directories a previous run could not remove would otherwise accumulate.
  try {
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith('libreoffice-kit-')) continue;
      try {
        fs.rmSync(path.join(base, entry), { recursive: true, force: true });
      } catch {
        // A directory still held open stays until the next launch.
      }
    }
  } catch {
    // An unreadable scratch directory is not a reason to refuse to start.
  }
}

prepareEngineScratch();

process.on('exit', (code) => trace(`exit ${code}`));

/** The failure envelope the reader's Remote contract uses. */
function failure(code, message, details = {}) {
  return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code, message, details } };
}

process.on('uncaughtException', (error) => {
  trace(`uncaughtException: ${error?.stack ?? error}`);
});
process.on('unhandledRejection', (reason) => {
  trace(`unhandledRejection: ${reason?.stack ?? reason}`);
});

/** The window currently showing the reader. */
let window;
/** The host API for the directory on show; loaded once the app is ready. */
let host;
/** The workspace root, for the menu and the picker. */
let workspaceRoot;
/**
 * A document a launch named, waiting for the page to say it can receive it.
 *
 * The shell's listeners exist only after React mounts, which is later than the
 * window's load event, so the hand-off waits for `shell:ready` rather than for a
 * moment that only looks like readiness.
 */
let pendingOpen;

/**
 * The document one launch named, from a command line.
 *
 * Both entry points use this — the first launch, and a second launch handing its file to the
 * window already open — because the same command line needs the same reading, and they had
 * drifted: the first launch ignored the executable's own path while the second did not, so a
 * second launch offered the app *itself* as the document to open. The reader then reported an
 * unsupported format for a file it had never been asked to show.
 *
 * Chromium's own switches (`--remote-debugging-port`, `--enable-logging`, …) are not
 * documents either, and neither is the executable whose path sits at the front of the
 * arguments. What remains, resolves, exists and is a regular file is the document.
 *
 * @param argv - the command line to read, without the program name.
 * @returns the absolute path of the document, or `undefined`.
 */
function documentArgument(argv) {
  // The executable's own path is spelled differently by different launchers, so both the
  // running image and the raw argument are compared by resolved path.
  const self = new Set([path.resolve(process.execPath), path.resolve(process.argv[0] ?? '')].map((value) => value.toLowerCase()));

  const candidate = argv
    .filter((value) => typeof value === 'string' && value !== '' && !value.startsWith('-'))
    .map((value) => (path.isAbsolute(value) ? path.resolve(value) : undefined))
    .find((value) => {
      if (value === undefined) return false;
      if (self.has(value.toLowerCase())) return false;
      try {
        return fs.statSync(value).isFile();
      } catch {
        return false;
      }
    });
  return candidate;
}

/**
 * What the launch arguments name: a file to open.
 *
 * An "open with" association hands the app a file path, and a plain launch hands it
 * nothing (or a directory, if a shortcut was set up that way). The host's root — used
 * only to resolve paths a document refers to — is the file's directory, or the
 * working directory when no file was named.
 *
 * @returns the workspace root and the file to open, if any.
 */
function startupTargets() {
  const candidate = documentArgument(process.argv.slice(1));
  if (candidate === undefined) return { root: process.cwd(), file: undefined };

  const resolved = path.resolve(candidate);
  try {
    if (fs.statSync(resolved).isDirectory()) return { root: resolved, file: undefined };
    return { root: path.dirname(resolved), file: resolved };
  } catch {
    // A path that no longer exists: fall back to the working directory rather than
    // opening a root that cannot be read.
    return { root: process.cwd(), file: undefined };
  }
}

/** Create the reader window. */
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#16181d',
    title: 'Quire',
    // The window, taskbar and Alt-Tab icon. The packaged exe carries the same icon in its own
    // resources (tools/package.mjs writes it with rcedit), so this is the one to change if the
    // two ever disagree.
    icon: path.join(projectRoot, 'assets', 'app.ico'),
    show: false,
    webPreferences: {
      preload: path.join(projectRoot, 'src', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.loadFile(pagePath);
  // Navigation and popups are owned by the global guard installed below, which is
  // also the one place that gets to hand an external link to the system browser.
  window.on('closed', () => {
    window = undefined;
  });
}

/** Register the private file protocol once, before any window loads. */
function registerFileProtocol() {
  protocol.handle('dsh-file', async (request) => {
    // Only the app's own page may read local files, and only while it is still the
    // page on show: after a navigation the protocol must not keep serving it.
    if (window === undefined || !isOwnPage(window.webContents.getURL())) {
      trace(`refused a file request from ${String(request.url).slice(0, 80)}`);
      return new Response('forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const target = url.searchParams.get('path');
    const baseFile = url.searchParams.get('baseFile') ?? undefined;
    if (target === null) return new Response('missing path', { status: 400 });
    const raw = await host.raw({ path: target, baseFile });
    if (raw === undefined) return new Response('not found', { status: 404 });
    return new Response(raw.data, { headers: { 'content-type': raw.type } });
  });
}

/** Point the app at a directory. */
async function useWorkspace(root) {
  const { createHostApi } = await import('../main/host-api.js');
  host = createHostApi({ workspaceRoot: root });
  workspaceRoot = host.root;
  return host.root;
}

/**
 * Office conversion, using the vendored LibreOffice engine.
 *
 * The reader asks for converted PDF bytes through `officeToPdf.render`; this is
 * that face. The converter itself is loaded lazily, so a session that never opens
 * a Word or PowerPoint file never pays for the engine.
 */
const officeKitEntry = path.join(projectRoot, 'vendor', 'office', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js');
let officePromise;
let officeGeneration = 'libreoffice-kit-0.1.2';

/** The converter, created on first use. */
function officeConverter() {
  if (officePromise === undefined) {
    officePromise = import(pathToFileURL(path.join(projectRoot, 'src', 'main', 'office-converter.js')).href).then(
      ({ createOfficeConverter }) => createOfficeConverter({ engineDir: officeKitEntry, kitEntry: officeKitEntry }),
    );
  }
  return officePromise;
}

/** One host operation, as the preload asks for it. */
function registerIpc() {
  ipcMain.handle('host:call', async (event, { op, request }) => {
    if (!fromOwnPage(event)) return forbidden('host:call');
    switch (op) {
      case 'page':
        return host.page(request);
      case 'bytes': {
        const result = await host.bytes(request);
        if (!result.ok) return result;
        // Structured clone carries typed arrays, so the bytes need no encoding.
        return { ok: true, value: { ...result.value, data: result.value.data } };
      }
      case 'stat':
        return host.stat(request);
      default:
        return { ok: false, error: { code: 'gateway/internal', message: `unknown op ${op}` } };
    }
  });

  // The one way a document arrives: a file the user picks. There is no directory
  // browser to back, so no listing and no workspace switch exists here.
  ipcMain.handle('workspace:chooseFiles', async (event) => {
    if (!fromOwnPage(event)) {
      forbidden('workspace:chooseFiles');
      return [];
    }
    const picked = await dialog.showOpenDialog(window, {
      title: '打开文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '文档',
          extensions: [
            'md', 'markdown', 'txt', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
            'doc', 'docx', 'ppt', 'pptx', 'xlsx', 'xls', 'csv', 'tsv',
          ],
        },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled) return [];
    return picked.filePaths;
  });

  // Office conversion.
  //
  // The reader asks for a *path* — its own call is `render(sessionId, path, priority,
  // signal)` — because in DSH the conversion happens wherever the workspace lives. So
  // this side owns the read: the bytes are fetched here and handed to the converter,
  // and the page receives PDF bytes, the missing-font list, and a version it can key
  // its own cache on.
  ipcMain.handle('office:render', async (event, request = {}) => {
    if (!fromOwnPage(event)) return forbidden('office:render');
    try {
      // Path resolution is the host's own, so a relative reference means here exactly
      // what it means everywhere else in the app.
      const { resolveRequestPath } = await import(pathToFileURL(path.join(projectRoot, 'src', 'main', 'file-service.js')).href);
      const absolutePath = resolveRequestPath(request.path ?? request.absolutePath, request.baseFile, workspaceRoot);
      if (absolutePath === undefined) {
        return failure('not-found', `no Office source was named: ${String(request.path)}`);
      }
      const data = request.bytes ?? request.data ?? (await fsp.readFile(absolutePath));
      trace(`converting ${absolutePath} (${data.byteLength} bytes)`);

      const converter = await officeConverter();
      const result = await converter.convert({ absolutePath, data, bytes: data, signal: request.signal });
      if (!result.ok) {
        // The engine's summary can name only the cleanup that followed the real
        // failure, so every member of the chain is written to the trace.
        const detail = result.error?.details ?? {};
        const chain = [detail.reason, ...(detail.causes ?? [])].filter(Boolean).join(' <- ');
        trace(`conversion of ${absolutePath} failed: ${result.error?.code} :: ${chain || result.error?.message}`);
        return result;
      }
      const { pdf, fonts, digest, cached } = result.value;
      trace(`converted ${absolutePath} -> ${pdf.byteLength} bytes (cached=${cached === true})`);
      return {
        ok: true,
        value: {
          pdf: new Uint8Array(pdf),
          data: new Uint8Array(pdf),
          absolutePath,
          missingFonts: fonts,
          fonts,
          version: digest,
          generation: officeGeneration,
          cached,
        },
      };
    } catch (error) {
      trace(`office conversion failed: ${error?.stack ?? error}`);
      return failure('document-render/failed', String(error?.message ?? error));
    }
  });
  ipcMain.handle('office:generation', (event) => (fromOwnPage(event) ? { ok: true, value: { generation: officeGeneration } } : forbidden('office:generation')));

  // A launch may be asked for a throwaway profile, so a verification run sees the
  // configured defaults instead of a remembered choice from an earlier session.
  ipcMain.on('shell:fresh-settings', (event) => {
    event.returnValue = fromOwnPage(event) && process.argv.includes('--fresh-settings');
  });

  // The document a launch named is handed over when the page says it is listening,
  // not when its load event fires: the shell's listeners are mounted by React, which
  // is later. A hand-off before then would simply be dropped.
  ipcMain.on('shell:ready', (event) => {
    if (!fromOwnPage(event)) {
      trace('ignored shell:ready from a page this app does not serve');
      return;
    }
    trace('page reports it can receive documents');
    if (pendingOpen === undefined) return;
    const target = pendingOpen;
    pendingOpen = undefined;
    trace(`handing over ${target}`);
    window?.webContents.send('workspace:open', target);
  });
}

// The menu owns the theme preference as well: its checkbox is the only place that state
// becomes visible, so it is built with the same window accessor the rest of this file uses.
const { createMenu } = require('./menu.cjs');
const menu = createMenu({ getWindow: () => window });

// Navigation and popups are refused by the boundary module, which also owns the answer
// to "is this our page?" for the protocol handler and the IPC handlers.
installNavigationGuard();

// One instance: a second launch hands its file to the running window.
trace('requesting the single-instance lock');
if (!app.requestSingleInstanceLock()) {
  trace('another instance holds the lock; quitting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // The same reading the first launch uses: the second command line starts with the
    // executable's own path, which is not a document to open.
    const target = documentArgument(argv);
    if (target !== undefined) {
      trace(`second instance handed over ${target}`);
      window?.webContents.send('workspace:open', target);
    }
    if (window !== undefined) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    const targets = startupTargets();
    pendingOpen = targets.file;
    trace(`ready; workspace=${targets.root}${targets.file === undefined ? '' : ` open=${targets.file}`}`);
    await useWorkspace(targets.root);
    trace(`host api ready for ${workspaceRoot}`);
    registerFileProtocol();
    registerIpc();
    menu.installMenu();
    trace('menu and ipc installed; creating the window');
    createWindow();
    trace('window created');
    window?.webContents.on('did-finish-load', () => {
      trace('page finished loading');
      // The palette the page settled on may differ from the launch preference, so the
      // menu's checkbox is corrected once there is a document to ask.
      void menu.refreshAppliedTheme();
    });    window?.webContents.on('did-fail-load', (_event, code, description) => trace(`page failed to load: ${code} ${description}`));
    window?.webContents.on('render-process-gone', (_event, details) => trace(`renderer gone: ${JSON.stringify(details)}`));
    window?.webContents.on('console-message', (_event, level, message) => trace(`page console[${level}]: ${String(message).slice(0, 200)}`));
  });

  app.on('window-all-closed', () => {
    trace('all windows closed; quitting');
    app.quit();
  });

  app.on('before-quit', () => trace('before-quit'));
}
