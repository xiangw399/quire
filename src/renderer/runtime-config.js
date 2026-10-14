/**
 * Environment selection: what the shell is running inside.
 *
 * The reader is the same in both; only where it reads files from differs. A page
 * reads through the dev server's HTTP endpoints, the desktop app reads through
 * the preload bridge. Deciding it here keeps every other module free of the
 * question.
 */

/** The preload bridge, when the shell runs inside the desktop app. */
export function electronBridge() {
  return globalThis.docviewer ?? undefined;
}

/** Whether the shell is running inside the desktop app. */
export function isDesktop() {
  return electronBridge()?.isElectron === true;
}

/**
 * Publish the host faces the shell reads.
 *
 * The desktop bridge carries both faces, so they are republished where `start`
 * looks and the shell's own code path stays identical to a page's. There is no
 * workspace to fetch: the app has no file browser, and the host resolves a
 * document's relative references against the directory it was opened from.
 */
export async function prepareEnvironment() {
  const bridge = electronBridge();
  if (bridge === undefined) return { desktop: false };
  globalThis.__DSH_VIEWER_HOST__ = bridge.host;
  globalThis.__DSH_VIEWER_REMOTE__ = bridge.remote;
  // A throwaway profile is announced by the host that made it.
  globalThis.__DSH_VIEWER_FRESH_SETTINGS__ = bridge.freshSettings?.() === true;
  return { desktop: true };
}
