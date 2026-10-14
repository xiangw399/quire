/**
 * Office → PDF conversion, using the same engine DSH uses.
 *
 * The reader previews `.doc/.docx/.ppt/.pptx` by converting them to PDF and handing
 * the bytes to its PDF renderer. DSH does that with the independently published
 * `@deepseek-ai/libreoffice-kit` (a prebuilt LibreOffice); this module reproduces
 * the provider's behaviour on top of that kit's real API, without DSH's service
 * layer:
 *
 *  - one lazily created converter, reused (engine start-up is the expensive part);
 *  - a bounded queue, a deadline per conversion, and cancellation that releases
 *    the slot;
 *  - a small LRU of finished PDFs keyed by content digest, so reopening the same
 *    document does not convert twice;
 *  - missing-font families, taken from the kit's own render result.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Turn a filesystem path into something `import()` accepts.
 *
 * A Windows absolute path (`D:\…`) reads as a URL with an unknown scheme, which is
 * the mistake this helper exists to prevent: the kit is loaded by path.
 * @param target - a filesystem path or an already-formed URL.
 */
export function importSpecifier(target) {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return target;
  return pathToFileURL(target).href;
}

/**
 * Bounded conversion settings.
 *
 * These are DSH's own provider defaults, taken from `@deepseek-ai/dsh-office-to-pdf`:
 * two concurrent converters, a one-minute deadline, a 50 MiB source, a 100 MiB PDF,
 * 192 dpi raster images, and eight cached PDFs within 128 MiB. Keeping them identical
 * is the point — the app is meant to convert what DSH converts, with the same limits
 * and the same failures.
 */
const DEFAULTS = {
  maxConcurrentConversions: 2,
  timeoutMs: 60000,
  maxInputBytes: 52428800,
  maxOutputBytes: 104857600,
  maxImageResolution: 192,
  maxCachedEntries: 8,
  maxCachedBytes: 128 * 1024 * 1024,
};

/** Suffixes the engine converts. Kept here so the shell can refuse early. */
export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);

/**
 * Read a file that may not be there.
 * @param target - the path to read.
 * @returns its bytes, or `undefined` when it does not exist or cannot be read.
 */
async function readIfPresent(target) {
  try {
    return new Uint8Array(await fs.readFile(target));
  } catch {
    return undefined;
  }
}

/**
 * Whether bytes are a PDF.
 *
 * Checked before trusting a rescued output: a truncated or empty file must not be
 * passed off as a conversion result, and the reader would fail on it anyway.
 *
 * @param bytes - the candidate bytes.
 */
function looksLikePdf(bytes) {
  return bytes.byteLength > 1024 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Every distinct message in an error's chain, outermost first.
 *
 * A conversion failure can arrive as an `AggregateError` whose first line names only
 * the cleanup that also went wrong; the reason the document was refused is a later
 * member. Flattening keeps the useful half from being thrown away.
 *
 * @param error - the thrown value.
 * @returns the messages, deduplicated, outermost first.
 */
function flatten(error) {
  const seen = new Set();
  const messages = [];
  const visit = (value, depth) => {
    if (value === undefined || value === null || depth > 4) return;
    const message = String(value?.message ?? value);
    if (!seen.has(message)) {
      seen.add(message);
      messages.push(message);
    }
    // `AggregateError` keeps its members in `errors`; an ordinary cause chain uses
    // `cause`. Both are walked, because the engine uses both.
    for (const member of value?.errors ?? []) visit(member, depth + 1);
    visit(value?.cause, depth + 1);
  };
  visit(error, 0);
  return messages;
}

/**
 * Create the converter.
 * @param options - the kit to load, and the bounded limits to apply.
 */
export function createOfficeConverter(options = {}) {
  const config = { ...DEFAULTS, ...(options.limits ?? {}) };
  const queue = [];
  const cache = new Map();
  let running = 0;
  let cachedBytes = 0;
  let converterPromise;

  /** Load the kit and create its converter on first use. */
  async function converter() {
    if (converterPromise === undefined) {
      converterPromise = (async () => {
        const entry = options.kitEntry ?? options.engineDir;
        if (entry === undefined) throw new Error('no LibreOffice kit path was configured');
        const kit = await import(importSpecifier(entry));
        return kit.createConverter({
          timeoutMs: config.timeoutMs,
          maxInputBytes: config.maxInputBytes,
          maxOutputBytes: config.maxOutputBytes,
          maxImageResolution: options.maxImageResolution ?? 192,
        });
      })();
    }
    return converterPromise;
  }

  /** Admit one conversion, waiting while the concurrency limit is reached. */
  function admit() {
    if (running < config.maxConcurrentConversions) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  /** Release a slot and start the next waiting conversion. */
  function release() {
    const next = queue.shift();
    if (next === undefined) running -= 1;
    else next();
  }

  /** Retire least-recently-used entries until both limits hold. */
  function trimCache() {
    while (cache.size > config.maxCachedEntries || cachedBytes > config.maxCachedBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) return;
      cachedBytes -= cache.get(oldest).pdf.byteLength;
      cache.delete(oldest);
    }
  }

  return {
    /** Whether the engine loads at all, for the shell's diagnostics. */
    async available() {
      try {
        await converter();
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Convert one Office document to PDF bytes.
     * @param request - `{ absolutePath, bytes, signal }`. The bytes are what the
     *                  caller read; a path is only used when they are absent, which
     *                  is the direct-call convenience rather than the page's route.
     * @returns `{ ok: true, value: { pdf, fonts, digest, cached } }` or a failure envelope.
     */
    async convert(request) {
      let scratch;
      try {
        const data = request.bytes ?? request.data ?? (await fs.readFile(request.absolutePath));
        if (data.byteLength > config.maxInputBytes) {
          return failure('too-large', `Office source exceeds the ${config.maxInputBytes}-byte cap`);
        }
        const digest = createHash('sha256').update(data).digest('hex');
        const cached = cache.get(digest);
        if (cached !== undefined) {
          // A hit moves the entry to the back of the LRU order.
          cache.delete(digest);
          cache.set(digest, cached);
          return { ok: true, value: { pdf: cached.pdf, fonts: cached.fonts, digest, cached: true } };
        }

        await admit();
        try {
          if (request.signal?.aborted) return failure('cancelled', 'conversion cancelled');

          // The engine requires private directories and a fresh output path; it
          // removes a newly created output when the conversion fails.
          scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-viewer-office-'));
          const inputPath = path.join(scratch, path.basename(request.absolutePath ?? 'source.docx'));
          const outputPath = path.join(scratch, 'converted.pdf');
          await fs.writeFile(inputPath, data);

          const engine = await converter();
          let result;
          try {
            result = await engine.render({ inputPath, outputPath }, request.signal);
          } catch (error) {
            // A refused cleanup must not hide a PDF that was written: the engine
            // removes its output only on a failed conversion, so bytes here mean the
            // document converted and only the temporary profile outlived it.
            const rescued = await readIfPresent(outputPath);
            if (rescued === undefined || !looksLikePdf(rescued)) throw error;
            result = { missingFonts: [], rescuedFrom: String(error?.message ?? error) };
          }
          const pdf = new Uint8Array(await fs.readFile(outputPath));
          if (pdf.byteLength === 0) return failure('document-render/failed', 'conversion produced an empty PDF');
          if (pdf.byteLength > config.maxOutputBytes) {
            return failure('too-large', `converted PDF exceeds the ${config.maxOutputBytes}-byte cap`);
          }

          const fonts = normalizeFonts(result?.missingFonts ?? result?.fonts);
          cache.set(digest, { pdf, fonts });
          cachedBytes += pdf.byteLength;
          trimCache();
          return { ok: true, value: { pdf, fonts, digest, cached: false } };
        } finally {
          release();
        }
      } catch (error) {
        if (request.signal?.aborted) return failure('cancelled', 'conversion cancelled');
        // The engine classifies its own failures, and it also bundles cleanup errors
        // into an `AggregateError` whose message names only the cleanup. The real
        // reason is an earlier member, so the whole chain is flattened here rather
        // than reported as "cleanup failed".
        const reasons = [];
        for (const part of flatten(error)) reasons.push(part);
        return failure('document-render/failed', String(error?.message ?? error), {
          reason: reasons[0],
          causes: reasons.slice(1, 6),
          code: error?.code,
        });
      } finally {
        if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    },

    /** Stop the engine, if it ever started. */
    async dispose() {
      if (converterPromise === undefined) return;
      try {
        const engine = await converterPromise;
        await engine.dispose();
      } catch {
        // a converter that never loaded holds nothing to release
      }
    },

    /** What the converter holds, for diagnostics. */
    stats() {
      return { entries: cache.size, cachedBytes, running, queued: queue.length };
    },
  };
}

/** The kit reports font families; anything else is coerced to a string name. */
function normalizeFonts(fonts) {
  if (!Array.isArray(fonts)) return [];
  return fonts.map((font) => (typeof font === 'string' ? font : String(font?.name ?? font)));
}

/** The failure envelope the reader's Remote contract uses. */
function failure(code, message, details = {}) {
  return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code, message, details } };
}
