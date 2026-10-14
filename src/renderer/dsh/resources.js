/**
 * The shell's resource model for the `file` protocol.
 *
 * The reader's tab body reads `useResource(address)` for one thing: a file's
 * metadata — its absolute path, the version it uses to decide whether loaded
 * pages still belong to the file on disk, and the size byte readers need. DSH
 * streams that as resource frames; this service does the same, and streams a new
 * frame whenever the file changes, which is what drives the reader's automatic
 * refresh.
 *
 * The reader's own `dsh-client-resources` bundle would supply this registry, but
 * that bundle's provider API is asynchronously consumed (`for await`) while the
 * reader's dependency tracker reads sources synchronously. The shell therefore
 * provides the registry, matching the reader's observable contract exactly.
 */
import { LOCAL_SESSION_ID } from './session.js';

/** The resource address of one absolute path. */
export function fileAddressOf(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
  return `dsh-resource://file/session/${encodeURIComponent(LOCAL_SESSION_ID)}/${encoded}`;
}

/** The absolute path inside one file address, or `undefined` when it is not one. */
export function pathOfFileAddress(address) {
  const prefix = `dsh-resource://file/session/${encodeURIComponent(LOCAL_SESSION_ID)}/`;
  if (!address.startsWith(prefix)) return undefined;
  return decodeURIComponent(address.slice(prefix.length));
}

/** How often a held file is re-checked for changes. */
const POLL_MS = 500;

/** One address's live record. */
function createRecord(address, host) {
  const listeners = new Set();
  const absolutePath = pathOfFileAddress(address);
  let snapshot = {
    status: absolutePath === undefined ? 'none' : 'loading',
    value: undefined,
    failure: undefined,
  };
  let timer;
  let lastVersion;

  function emit(next) {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  async function poll() {
    if (absolutePath === undefined) return;
    const result = await host.stat({ path: absolutePath });
    if (!result.ok) {
      // A failed frame keeps the last value, as the reader's contract says.
      emit({ status: 'failed', value: snapshot.value, failure: result.error });
      return;
    }
    // The first successful stat is a value even when its version is the same as
    // nothing: the reader's metadata gate is what lets it start reading at all,
    // so a "live" frame must follow the very first stat, not only a change.
    if (snapshot.status !== 'live' || result.value.version !== lastVersion) {
      lastVersion = result.value.version;
      emit({ status: 'live', value: result.value, failure: undefined });
    }
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1 && absolutePath !== undefined) {
          void poll();
          timer = setInterval(() => void poll(), POLL_MS);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            clearInterval(timer);
            timer = undefined;
          }
        };
      },
    },
    /** Read the current value without holding the resource, for shell chrome. */
    peek: () => snapshot,
    stop() {
      clearInterval(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}

/**
 * Create the resource service.
 * @param options - the host face used to stat files.
 */
export function createResourcesService({ host }) {
  const records = new Map();

  function recordOf(address) {
    let record = records.get(address);
    if (record === undefined) {
      record = createRecord(address, host);
      records.set(address, record);
    }
    return record;
  }

  return {
    /** One address's live source; stable for the address's lifetime. */
    source: (address) => recordOf(address).source,
    /** Hold an address open without subscribing. */
    pin(address, signal) {
      const record = recordOf(address);
      const release = record.source.subscribe(() => {});
      signal?.addEventListener('abort', release, { once: true });
    },
    /** Register a provider. The shell owns the `file` protocol and accepts no other. */
    register() {
      throw new Error('the shell resource model serves the "file" protocol only');
    },
    /** Every held address, for diagnostics. */
    get held() {
      return [...records.keys()];
    },
    /** Drop one address's record. */
    forget(address) {
      records.get(address)?.stop();
      records.delete(address);
    },
  };
}
