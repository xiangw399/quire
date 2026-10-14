/**
 * The platform helpers the reader's engines expect from their host.
 *
 * The reader is built for DSH's client platform, which supplies more than the DOM: helpers
 * its engines call without defining. Two are known to matter here, and both surface only for
 * certain documents, which is why they are easy to miss until one is opened.
 *
 *  - `Uint8Array.prototype.toHex` — the PDF engine computes a document fingerprint and calls
 *    this on the bytes. DSH's client platform carries the same `Binary.toHex` implementation
 *    in every plugin. A PDF whose trailer has no `/ID` is the one that reaches the call, so
 *    ordinary PDFs hide the gap while a PDF converted from an Office file does not.
 *  - `Map.prototype.getOrInsert` / `getOrInsertComputed` — the PDF engine's caches use these
 *    to build entries on demand. They are a recent addition to the platform, so an engine
 *    packaged for a newer one calls them unconditionally.
 *  - `Math.sumPrecise` — the engine sums glyph widths with it. When it is missing the call
 *    throws in the middle of laying out a page, which leaves the characters on the canvas
 *    drawn from the wrong glyphs: the text layer still reads correctly because it comes from
 *    the character map, while the picture does not. That is exactly the fault this helper
 *    exists to remove.
 *
 * This is the shell's job rather than the bundles': the vendor chunks stay byte-for-byte as
 * DSH builds them, and what they expect is installed around them. Every helper is added only
 * when the platform does not already provide it, and the formatting matches DSH's own.
 *
 * Two copies of the PDF engine run — one on the page, one in a worker created from an
 * embedded script — so the helpers are installed per realm: here for the page, and prepended
 * to the worker's script as it is built.
 */

/** The helper source, as text, so the same code can also be prepended inside a worker. */
export const PLATFORM_HELPER_SOURCE = [
  'globalThis.__dshPlatformHelpers = true;',
  '(() => {',
  '  const define = (target, name, value) => {',
  '    if (target === undefined || target === null) return;',
  '    if (typeof target[name] === "function") return;',
  '    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });',
  '  };',
  '',
  '  // Byte arrays render themselves as lowercase hex, as DSH\'s Binary.toHex does.',
  '  const toHex = function toHex() {',
  '    return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");',
  '  };',
  '  for (const type of [Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array]) {',
  '    define(type && type.prototype, "toHex", toHex);',
  '  }',
  '',
  '  // Map helpers: insert on demand, computing the value only when the key is absent.',
  '  define(Map.prototype, "getOrInsert", function getOrInsert(key, value) {',
  '    const present = this.get(key);',
  '    if (present !== undefined) return present;',
  '    this.set(key, value);',
  '    return value;',
  '  });',
  '  define(Map.prototype, "getOrInsertComputed", function getOrInsertComputed(key, compute) {',
  '    if (typeof compute !== "function") throw new TypeError("getOrInsertComputed requires a callback");',
  '    if (key === 0 && 1 / key === -Infinity) throw new TypeError("getOrInsertComputed does not accept -0 as a key");',
  '    const present = this.get(key);',
  '    if (present !== undefined) return present;',
  '    const computed = compute(key);',
  '    this.set(key, computed);',
  '    return computed;',
  '  });',
  '  if (typeof WeakMap === "function") {',
  '    define(WeakMap.prototype, "getOrInsert", Map.prototype.getOrInsert);',
  '    define(WeakMap.prototype, "getOrInsertComputed", Map.prototype.getOrInsertComputed);',
  '  }',
  '',
  '  // Promises: a resolver and its promise in one step.',
  '  define(Promise, "withResolvers", function withResolvers() {',
  '    let resolve;',
  '    let reject;',
  '    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });',
  '    return { promise, resolve, reject };',
  '  });',
  '',
  '  // Numeric summation over an iterable, with the error compensation the proposal specifies.',
  '  define(Math, "sumPrecise", function sumPrecise(items) {',
  '    if (items === null || items === undefined) throw new TypeError("Math.sumPrecise requires an iterable");',
  '    const values = [];',
  '    for (const value of items) {',
  '      const number = typeof value === "number" ? value : Number(value);',
  '      if (Number.isNaN(number)) return NaN;',
  '      // An infinite value dominates, so the sum is that infinity.',
  '      if (!Number.isFinite(number)) return number;',
  '      values.push(number);',
  '    }',
  '    // Neumaier summation: keep the rounding error of each addition and fold it back in.',
  '    let sum = 0;',
  '    let compensation = 0;',
  '    for (const value of values) {',
  '      const next = sum + value;',
  '      compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;',
  '      sum = next;',
  '    }',
  '    return sum + compensation;',
  '  });',
  '})();',
].join('\n');

/**
 * Install every helper this realm is missing.
 *
 * Safe to call more than once: each helper is defined only when absent.
 */
export function installPlatformHelpers() {
  const install = new Function(PLATFORM_HELPER_SOURCE);
  install.call(globalThis);
}

/**
 * Make the helpers reach the reader's PDF worker.
 *
 * The reader assembles the worker's script at run time and turns it into a blob, so the
 * worker's realm never sees helpers installed on the page. The blob is therefore where they
 * are added: the engine's script is recognised by its content as it is constructed, and the
 * helper source is placed in front of it — so the worker the reader starts is already
 * carrying them.
 *
 * Every other blob, and every other worker, is left exactly as it was.
 */
export function installWorkerPlatformHelpers() {
  const OriginalBlob = globalThis.Blob;
  if (typeof OriginalBlob !== 'function') return;

  globalThis.Blob = function PlatformHelperBlob(parts = [], options = {}) {
    try {
      const list = Array.isArray(parts) ? parts : [parts];
      const text = list.map((part) => (typeof part === 'string' ? part : '')).join('');
      // The reader's PDF worker is the blob carrying the engine; the marker keeps this off
      // every other blob the page may build.
      if (text.includes('calculateMD5') && text.includes('WorkerMessageHandler') && !text.includes('__dshPlatformHelpers')) {
        return new OriginalBlob([PLATFORM_HELPER_SOURCE, '\n', ...list], options);
      }
    } catch {
      // A blob that cannot be inspected is built exactly as it was asked for.
    }
    return new OriginalBlob(parts, options);
  };
  globalThis.Blob.prototype = OriginalBlob.prototype;
}
