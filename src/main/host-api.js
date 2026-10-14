/**
 * Host API: the one place the shell answers file questions.
 *
 * Both transports call into this — the development HTTP server now, and the
 * Electron IPC bridge later — so the reader behaves identically under either.
 * Every method returns the reader's own result envelopes; nothing here decides
 * what the reader shows.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPage, readBytes, statFile, readDirectory, resolveRequestPath } from './file-service.js';

/** Mime types the shell serves for local assets and inline documents. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Create the host API for one workspace root.
 * @param options - workspace root and the watcher factory to use.
 */
export function createHostApi({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  /**
   * Resolve a request to an absolute path.
   * @param request - `{ path, baseFile }` as the reader sends it.
   */
  function resolve(request) {
    return resolveRequestPath(request.path ?? request.absolutePath, request.baseFile, root);
  }

  return {
    root,

    /** Resolve a request path without reading anything (used by the shell's tree). */
    resolve,

    /** One page of lines; the reader's `workspaceFiles.read`. */
    async page(request) {
      return readPage(resolve(request), request.offset ?? 1);
    },

    /** Complete bytes, or a window; the reader's `workspaceFiles.readBytes`. */
    async bytes(request) {
      return readBytes(resolve(request), request.range ?? request.window ?? {});
    },

    /** File metadata; the `file` resource's frames. */
    async stat(request) {
      return statFile(resolve(request));
    },

    /** One directory level, for the sidebar tree. */
    async list(request) {
      return readDirectory(resolve(request));
    },

    /**
     * Raw file access for the browser's own loading (images, HTML assets,
     * fonts): the shell returns bytes, not an envelope, because the caller is a
     * URL consumer rather than the reader.
     * @param request - `{ path, baseFile }`.
     * @returns the bytes and a content type, or `undefined` when unreadable.
     */
    async raw(request) {
      const absPath = resolve(request);
      try {
        const data = await fs.readFile(absPath);
        const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
        return { data, type, absolutePath: absPath };
      } catch {
        return undefined;
      }
    },

    /** Mime type for a path, for transports that need it up front. */
    mimeOf(absPath) {
      return MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    },
  };
}
