/**
 * Host-side file service: the standalone replacement for DSH's
 * `workspaceFiles` Remote.
 *
 * The reader's renderers were written against a small set of read endpoints, and
 * this module reproduces exactly those, with the same value shapes:
 *
 *  - `readPage(path, offset)`   → one page of lines, with the file's version,
 *                                 the page's line count and an EOF marker.
 *  - `readBytes(path, window)`  → native bytes with version, size, offset, EOF.
 *  - `stat(path)`               → absolute path, version, size.
 *
 * Version semantics match the original contract: a version changes whenever the
 * file's identity changes, and the reader uses it to decide whether pages it
 * already holds belong to the file it is now reading. mtime + size is the cheap
 * stand-in for the Host's version; it is stable across reads and changes on any
 * ordinary write.
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Default page cap: the reader asks for pages without a limit of its own. */
export const MAX_LINES_PER_PAGE = 2000;

/** Complete-read cap, matching the provider default the reader was written against. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Failure codes the reader recognizes; anything else surfaces as an internal failure. */
function failure(code, message, details = {}) {
  return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code, message, details } };
}

/** Wrap a value in the Remote result envelope the reader expects. */
function ok(value) {
  return { ok: true, value };
}

/**
 * Resolve a request path to an absolute path.
 * @param requestPath - absolute path, or a path relative to the workspace root.
 * @param baseFile - absolute path of the file a relative path is resolved against.
 * @param workspaceRoot - root used for relative paths when no base file is given.
 */
export function resolveRequestPath(requestPath, baseFile, workspaceRoot) {
  if (path.isAbsolute(requestPath)) return path.normalize(requestPath);
  const base = baseFile !== undefined ? path.dirname(baseFile) : workspaceRoot;
  return path.resolve(base, requestPath);
}

/** File version: mtime plus size, so any ordinary write changes it. */
async function versionOf(absPath, stats) {
  const stat = stats ?? (await fs.stat(absPath));
  return `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
}

/** Refuse anything that is not a regular file, with the code the reader knows. */
async function statRegular(absPath) {
  let stats;
  try {
    stats = await fs.stat(absPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { failure: failure('not-found', `no such file: ${absPath}`, { path: absPath }) };
    return { failure: failure('gateway/internal', String(error.message ?? error), { path: absPath }) };
  }
  if (!stats.isFile()) {
    return { failure: failure('not-regular-file', `not a regular file: ${absPath}`, { path: absPath }) };
  }
  return { stats };
}

/**
 * Above this size a page is produced by streaming; below it, the file is decoded.
 *
 * Decoding is the only way to honor a UTF-16 byte-order mark, so small files keep
 * that path. A larger file must not be decoded at all: reading a multi-gigabyte log
 * in full to show one page of it is how this process runs out of memory.
 */
export const MAX_DECODE_BYTES = 8 * 1024 * 1024;

/**
 * One page of a UTF-8 text file, by line.
 * @param absPath - absolute file path.
 * @param offset - 1-based first line of the page.
 */
export async function readPage(absPath, offset = 1) {
  const { stats, failure: failed } = await statRegular(absPath);
  if (failed) return { ok: false, value: undefined, failure: undefined, ...failed };

  const start = Number.isFinite(offset) && offset > 1 ? Math.trunc(offset) : 1;
  try {
    return stats.size <= MAX_DECODE_BYTES
      ? await readPageDecoded(absPath, stats, start)
      : await readPageStreamed(absPath, stats, start);
  } catch (error) {
    return { ok: false, value: undefined, failure: undefined, ...failure('gateway/internal', String(error.message ?? error), { path: absPath }) };
  }
}

/** Wrap one page in the reader's envelope. */
async function pageValue(absPath, stats, start, lines, eof) {
  return {
    ok: true,
    value: {
      absolutePath: absPath,
      version: await versionOf(absPath, stats),
      size: stats.size,
      offset: start,
      text: lines.join('\n'),
      lines: lines.length,
      eof,
    },
  };
}

/** The whole-file path: decode once, then slice the page out of the line array. */
async function readPageDecoded(absPath, stats, start) {
  const handle = await fs.open(absPath, 'r');
  try {
    const lines = splitLines(await readDecodedText(handle));
    const total = lines.length;
    const from = start - 1;
    const slice = from >= total ? [] : lines.slice(from, from + MAX_LINES_PER_PAGE);
    return pageValue(absPath, stats, start, slice, from + slice.length >= total);
  } finally {
    await handle.close();
  }
}

/**
 * The streamed path: read forward, keeping a page's worth of lines and no more.
 *
 * Memory stays bounded by the chunk. The work is bounded by the page for a page near
 * the start, but a page deep in the file still costs a scan up to it, because the
 * offset is counted in lines rather than bytes — that is the contract the reader was
 * written against. Only `\n` ends a line here (a preceding `\r` is stripped), so a
 * lone-CR file above the threshold keeps its CRs inside lines; `splitLines` handles
 * that case for every file small enough to be decoded.
 */
async function readPageStreamed(absPath, stats, start) {
  const handle = await fs.open(absPath, 'r');
  try {
    const decoder = new TextDecoder('utf-8');
    const chunk = Buffer.alloc(1024 * 1024);
    const from = start - 1;
    const collected = [];
    let position = 0;
    let lineNumber = 0;
    let pending = '';

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });

      for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (lineNumber >= from) collected.push(line.endsWith('\r') ? line.slice(0, -1) : line);
        lineNumber += 1;

        if (collected.length >= MAX_LINES_PER_PAGE) {
          // The page is full. It is the end of the file only when this terminator was
          // the last byte: one comparison replaces a second scan of the whole file.
          const eof = position >= stats.size && pending === '';
          return pageValue(absPath, stats, start, collected, eof);
        }
      }
    }

    // End of file: a last line without a terminator is still a line.
    if (pending !== '') {
      if (lineNumber >= from) collected.push(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
      lineNumber += 1;
    }
    return pageValue(absPath, stats, start, collected, true);
  } finally {
    await handle.close();
  }
}

/**
 * Decode a file as UTF-8, honoring a UTF-16 byte-order mark when present.
 * @param handle - open file handle.
 */
async function readDecodedText(handle) {
  const buffer = await handle.readFile();
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/**
 * Split text into lines the way the reader counts them: a trailing newline does
 * not open another line, and a lone page past the last line reports zero lines.
 * @param text - file text.
 */
function splitLines(text) {
  if (text === '') return [];
  // CRLF and a lone CR both end a line: a file written on classic Mac OS would
  // otherwise read as a single enormous line.
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Complete bytes, or a byte window, of one file.
 * @param absPath - absolute file path.
 * @param window - optional 0-based byte offset; `range` is accepted for parity
 *                 with the original endpoint, whose callers pass `{ range }`.
 */
export async function readBytes(absPath, window = {}) {
  const { stats, failure: failed } = await statRegular(absPath);
  if (failed) return { ok: false, ...failed };

  const offset = Math.max(0, Math.trunc(window.offset ?? window.range?.offset ?? 0));
  if (offset === 0 && stats.size > MAX_FILE_BYTES) {
    return failure('too-large', `file exceeds the ${MAX_FILE_BYTES}-byte read cap`, { path: absPath, size: stats.size });
  }
  try {
    const handle = await fs.open(absPath, 'r');
    try {
      const available = Math.max(0, stats.size - offset);
      const length = Math.min(available, MAX_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      let filled = 0;
      // A read may return short — a file being written, a network share, a filter
      // driver — and the tail must never be handed over as if it were zero bytes.
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const data = buffer.subarray(0, filled);
      return ok({
        absolutePath: absPath,
        version: await versionOf(absPath, stats),
        size: stats.size,
        offset,
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        eof: offset + filled >= stats.size,
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failure('gateway/internal', String(error.message ?? error), { path: absPath });
  }
}

/**
 * File metadata without content: what the reader's `file` resource streams.
 * @param absPath - absolute file path.
 */
export async function statFile(absPath) {
  const { stats, failure: failed } = await statRegular(absPath);
  if (failed) return { ok: false, ...failed };
  return ok({
    absolutePath: absPath,
    version: await versionOf(absPath, stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}

/**
 * Content digest, for callers that need identity independent of mtime.
 * @param absPath - absolute file path.
 */
export async function digestOf(absPath) {
  const data = await fs.readFile(absPath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * One directory level, for the shell's file tree.
 * @param dirPath - absolute directory path.
 */
export async function readDirectory(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return ok({
      absolutePath: path.resolve(dirPath),
      entries: entries
        .map((entry) => ({
          name: entry.name,
          path: path.join(path.resolve(dirPath), entry.name),
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        }))
        // Directories first, then case-insensitive name.
        .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1)),
    });
  } catch (error) {
    return { ok: false, ...failure('gateway/internal', String(error.message ?? error), { path: dirPath }) };
  }
}
