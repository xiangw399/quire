/**
 * Electron preload: the shell's host faces, bridged over IPC.
 *
 * The renderer reads the host API from here before its own bundle loads, so the
 * same shell code serves a page (over HTTP) and the desktop app (over IPC) with
 * no branch inside it. Nothing else crosses this boundary: the reader's file
 * reads, its directory listing, and the workspace picker are the whole surface.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Call one host operation in the main process. */
function call(op, request) {
  return ipcRenderer.invoke('host:call', { op, request });
}

/** The host face the renderer publishes as `globalThis.__DSH_VIEWER_HOST__`. */
const host = {
  page: (request) => call('page', request),
  bytes: (request) => call('bytes', request),
  stat: (request) => call('stat', request),
  /** A URL the renderer can load directly; the protocol handler serves it. */
  urlFor(request) {
    const params = new URLSearchParams({ path: request.path });
    if (request.baseFile !== undefined) params.set('baseFile', request.baseFile);
    return `dsh-file://local/?${params.toString()}`;
  },
};

/**
 * How a document arrives.
 *
 * The shell has no file browser, so this is the whole surface: ask the user for
 * documents, learn the real path of a dropped file, and receive paths the operating
 * system hands the app through an association.
 */
const workspace = {
  /** Ask the user for documents. */
  chooseFiles: () => ipcRenderer.invoke('workspace:chooseFiles'),
  /** Absolute path of a dropped or picked file, when the OS supplies one. */
  pathForFile: (file) => {
    try {
      return require('electron').webUtils.getPathForFile(file);
    } catch {
      return undefined;
    }
  },
  onShellOpen: (listener) => {
    const handler = (_event, target) => listener(target);
    ipcRenderer.on('workspace:open', handler);
    return () => ipcRenderer.removeListener('workspace:open', handler);
  },
};

/** The reader's own remote face, built here so the shell needs no HTTP. */
const remote = {
  workspaceFiles: {
    async read(sessionId, path, range = {}, signal) {
      void sessionId;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return call('page', { path, offset: range.offset ?? 1 });
    },
    async readBytes(sessionId, path, range = {}, signal) {
      void sessionId;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const result = await call('bytes', { path, baseFile: range.baseFile, window: range.range ?? range });
      if (!result.ok) return result;
      return { ok: true, value: { ...result.value, data: new Uint8Array(result.value.data) } };
    },
    /**
     * Metadata without content: what the Office preview authorizes its source with.
     *
     * It reads one byte, then re-reads the file's identity and refuses to convert when
     * the two disagree — so this is part of that freshness check, not a convenience.
     */
    async stat(sessionId, path, signal) {
      void sessionId;
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return call('stat', { path });
    },
  },
  officeToPdf: {
    /**
     * Convert one Office document, as the reader asks for it.
     *
     * The reader's own call is positional — `render(sessionId, path, priority, signal)`
     * — and it supplies a path rather than bytes, because the conversion runs on the
     * other side of this boundary. An `AbortSignal` cannot cross it, so an aborted
     * request is refused here instead of being forwarded.
     */
    render: (sessionId, path, priority, signal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return ipcRenderer.invoke('office:render', { sessionId, path, priority });
    },
    generation: (signal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return ipcRenderer.invoke('office:generation');
    },
  },
};

contextBridge.exposeInMainWorld('docviewer', {
  isElectron: true,
  host,
  remote,
  workspace,
  /** Whether this launch started from an empty profile (a verification run). */
  freshSettings: () => ipcRenderer.sendSync('shell:fresh-settings'),
  /**
   * Tell the main process the page can receive documents.
   *
   * The shell's listeners exist only after React has mounted, which happens after
   * the window reports its load as finished — so a document handed over at that
   * moment would arrive before anyone is listening and be dropped.
   */
  ready: () => ipcRenderer.send('shell:ready'),
});
