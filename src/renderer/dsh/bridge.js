/**
 * The client-module bridge: how the reader's DSH-built bundles arrive in a shell
 * that is not DSH.
 *
 * DSH ships browser plugins as `window.__ModuleLoader__.load({ id, factory })`
 * bundles. The factory is CJS-flavoured: it receives a `require` and returns
 * `module.exports`. That contract is small, and reproducing it here is what lets
 * the reader's own code run unchanged:
 *
 *  - `require` resolves the platform module table (React and the DSH client
 *    framework packages, all installed from npm at the versions this reader was
 *    built against);
 *  - `require.async("./client.<name>.js")` loads a sibling vendor chunk through
 *    the bundler, so the reader keeps its lazy loading: PDF.js stays out of the
 *    start-up path until a PDF opens.
 */

import { LOADER_GLOBAL } from './contract.js';

/** Factories registered by vendor bundles: `id#chunk` -> registration. */
const factories = new Map();

/** Materialized exports: `id#chunk` -> exports. */
const loaded = new Map();

/** Platform table: module request -> exports. */
const platform = new Map();

/** Resolves a chunk request to a URL the bundler can import. */
let resolveChunk = (owner, request) => {
  throw new Error(`no chunk resolver installed (owner ${owner} asked for ${request})`);
};

/** The boot key appended to vendor URLs, so each boot loads its own instances. */
let bootKey = '';

/**
 * Install the platform table and chunk resolver.
 * @param options - explicit dependencies; the bridge never guesses.
 */
export function configureBridge(options) {
  for (const [id, value] of Object.entries(options.platform ?? {})) platform.set(id, value);
  if (options.resolveChunk) resolveChunk = options.resolveChunk;
  if (options.bootKey !== undefined) bootKey = options.bootKey;
  installGlobalLoader();
}

/**
 * Publish the loader facade the vendor bundles call.
 *
 * The facade delegates to this module's tables instead of owning its own, for one
 * reason: a vendor bundle is an ES module, and a module evaluates **once**. The
 * first import registers its factory, and any later import of the same URL is a
 * cache hit that evaluates nothing. A facade that only captured registrations
 * made during its own call would therefore miss a bundle that had already
 * registered — so the facade stays installed and the tables stay the truth.
 */
export function installGlobalLoader() {
  const target = globalThis.window ?? globalThis;
  target[LOADER_GLOBAL] = {
    load(registration) {
      const key = keyOf(registration.id, registration.chunk);
      factories.set(key, registration);
      if (registration.chunk === undefined) factories.set(registration.id, registration);
    },
  };
}

/** One registration's key: a chunk inherits its owner's id. */
function keyOf(id, chunk) {
  return chunk === undefined ? id : `${id}#${chunk}`;
}

/** Build the `require` handed to a factory. */
function makeRequire(ownerId) {
  const require = (request) => {
    if (platform.has(request)) return platform.get(request);
    if (loaded.has(request)) return loaded.get(request);
    if (factories.has(request)) return materialize(request, ownerId);
    throw new Error(`unresolved module request "${request}" from "${ownerId}"`);
  };

  require.async = async (request) => {
    const chunk = request.replace(/^\.\//, '');
    const url = resolveChunk(ownerId, chunk);
    await importClientModule(url, ownerId, chunk);
    return materialize(keyOf(ownerId, chunk), ownerId);
  };

  return require;
}

/** Materialize one registered factory, memoized. */
function materialize(key, ownerId) {
  const existing = loaded.get(key);
  if (existing !== undefined) return existing;
  const record = factories.get(key);
  if (record === undefined) throw new Error(`no factory registered for "${key}" (asked by ${ownerId})`);
  const result = record.factory(makeRequire(record.id));
  loaded.set(key, result);
  return result;
}

/**
 * Load one DSH vendor bundle and materialize its exports.
 *
 * @param url - URL of the bundle.
 * @param forcedId - id to assume when the bundle is a chunk that omits one.
 * @param chunk - chunk name, when loading a chunk.
 * @returns the bundle's exports.
 */
export async function importClientModule(url, forcedId, chunk) {
  const key = keyOf(forcedId, chunk);
  // A bundle that already registered (its module evaluated earlier in this
  // process) is materialized directly; importing it again would evaluate nothing.
  if (!factories.has(key)) {
    installGlobalLoader();
    await import(/* @vite-ignore */ url);
  }

  const registration = factories.get(key) ?? factories.get(forcedId);
  if (registration === undefined) throw new Error(`bundle at ${url} registered no factory`);
  const id = registration.id ?? forcedId;
  const chunkName = registration.chunk ?? chunk;
  factories.set(keyOf(id, chunkName), registration);
  if (chunkName === undefined) factories.set(id, registration);
  return materialize(keyOf(id, chunkName), id);
}

/** The current boot key, for callers that build vendor URLs. */
export function currentBootKey() {
  return bootKey;
}

/** What the bridge holds, for the boot audit. */
export function bridgeState() {
  return {
    factories: [...factories.keys()],
    loaded: [...loaded.keys()],
    platform: [...platform.keys()],
  };
}
