/**
 * The shell's host client: what the reader calls to read files.
 *
 * The reader's own `remote` face is two endpoints wide — a paged text read and a
 * whole-file byte read — with an Office conversion face beside them. This module
 * implements that face over the shell's transport, so the reader's calls need no
 * adaptation.
 */

/** Decode the transport's base64 payload back into native bytes. */
function decodeBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Create the shell's host face: the operations the reader and the shell call.
 *
 * Two implementations exist because a browser shell has two kinds of file: paths
 * the dev server can reach, and `File` objects a drop or picker produced, which
 * the page may read directly even though the server cannot reach them.
 *
 * @param options - `{ endpoint }` of the shell's host API.
 */
export function createHttpHost({ endpoint = '/api/host', root } = {}) {
  /** Files the page holds itself, by the path key they are addressed under. */
  const localFiles = new Map();

  /** Resolve a request path against the shell's root, the way the host does. */
  function resolveRequest(request) {
    const target = request.path ?? request.absolutePath;
    if (root === undefined || target === undefined || target.startsWith('picked:') || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/')) {
      return request;
    }
    return { ...request, path: `${root.replace(/[\\/]+$/, '')}/${target.replace(/^\.\//, '')}` };
  }

  async function call(op, request) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, request }),
    });
    return response.json();
  }

  /** A synthetic absolute path for a dropped file, unique within the page. */
  function pathForLocalFile(file) {
    return `picked:${file.name}`;
  }

  /** Read one page out of a `File` the page holds. */
  async function readLocalPage(file, offset) {
    const text = await file.text();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Math.trunc(offset ?? 1));
    const from = start - 1;
    const slice = from >= lines.length ? [] : lines.slice(from, from + MAX_LINES_PER_PAGE);
    return {
      ok: true,
      value: {
        absolutePath: pathForLocalFile(file),
        version: `${file.lastModified}-${file.size}`,
        size: file.size,
        offset: start,
        text: slice.join('\n'),
        lines: slice.length,
        eof: from + slice.length >= lines.length,
      },
    };
  }

  /** Read bytes out of a `File` the page holds. */
  async function readLocalBytes(file, window = {}) {
    const offset = Math.max(0, Math.trunc(window.offset ?? 0));
    const slice = file.slice(offset, offset + MAX_FILE_BYTES);
    return {
      ok: true,
      value: {
        absolutePath: pathForLocalFile(file),
        version: `${file.lastModified}-${file.size}`,
        size: file.size,
        offset,
        eof: offset + slice.size >= file.size,
        data: new Uint8Array(await slice.arrayBuffer()),
      },
    };
  }

  async function readPage(request) {
    const resolved = resolveRequest(request);
    const file = localFiles.get(resolved.path);
    if (file !== undefined) return readLocalPage(file, resolved.offset);
    return call('page', resolved);
  }

  async function readBytes(request) {
    const resolved = resolveRequest(request);
    const file = localFiles.get(resolved.path);
    if (file !== undefined) return readLocalBytes(file, resolved.window ?? resolved.range ?? {});
    const result = await call('bytes', resolved);
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, data: decodeBytes(result.value.dataBase64) } };
  }

  return {
    /** Register a `File` the page holds, and return the path it is addressed by. */
    adopt(file) {
      const key = pathForLocalFile(file);
      if (!localFiles.has(key)) localFiles.set(key, file);
      return key;
    },
    page: readPage,
    bytes: readBytes,
    stat: async (request) => {
      const resolved = resolveRequest(request);
      const file = localFiles.get(resolved.path);
      if (file !== undefined) {
        return {
          ok: true,
          value: {
            absolutePath: pathForLocalFile(file),
            version: `${file.lastModified}-${file.size}`,
            size: file.size,
            mtimeMs: file.lastModified,
          },
        };
      }
      return call('stat', resolved);
    },
    list: (request) => call('list', resolveRequest({ path: request?.path ?? '.' })),
    /** A URL the browser can load for one path (images, HTML assets). */
    urlFor: (request) => {
      const resolved = resolveRequest(request);
      const file = localFiles.get(resolved.path);
      if (file !== undefined) return URL.createObjectURL(file);
      const params = new URLSearchParams({ path: resolved.path });
      if (resolved.baseFile !== undefined) params.set('baseFile', resolved.baseFile);
      return `/api/file?${params.toString()}`;
    },
  };
}

/** Default page cap, matching the host's own. */
const MAX_LINES_PER_PAGE = 2000;
/** Complete-read cap, matching the host's own. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Create the reader's `remote` face over a host.
 * @param host - the host face from {@link createHttpHost}.
 */
export function createRemote(host) {
  return {
    workspaceFiles: {
      /** One page of lines: the reader's paged text reader. */
      async read(sessionId, path, range = {}, signal) {
        void sessionId;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return host.page({ path, offset: range.offset ?? 1 });
      },
      /** Complete bytes, or a window: the reader's byte readers. */
      async readBytes(sessionId, path, range = {}, signal) {
        void sessionId;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return host.bytes({ path, baseFile: range.baseFile, window: range.range ?? range });
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
        return host.stat({ path });
      },
    },
    officeToPdf: {
      /** Office conversion arrives with the converter; until then it reports absent. */
      async render() {
        return {
          ok: false,
          error: { name: 'RemoteError', code: 'gateway/internal', message: 'no Office converter is configured', details: {} },
        };
      },
      async generation() {
        return { ok: true, value: { generation: 'none' } };
      },
    },
  };
}
