/**
 * The boundary every caller is measured against.
 *
 * The renderer is trusted only while it shows this application's own page. A document may
 * contain links, and clicking one would otherwise load a foreign page into this window — a
 * page that inherits the host bridge the preload publishes. The guards here are the whole
 * answer to that: IPC asks who is calling, the page's own file protocol asks the same, and
 * no navigation is allowed to leave the page in the first place.
 *
 * Kept in one file because the three answers have to agree; a change to what counts as
 * "our page" is a change to all of them.
 */
const { app, shell } = require('electron');
const { pagePath } = require('./paths.cjs');
const { trace } = require('./trace.cjs');

/** Whether a URL names this application's own page; a fragment or query still counts. */
function isOwnPage(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  try {
    const url = new URL(candidate.split('#')[0]);
    if (url.protocol !== 'file:') return false;
    // Compare decoded paths, so a percent-encoded install directory (the Chinese product
    // name) still matches the path this process resolved.
    const asPath = decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\//g, '\\');
    return asPath.toLowerCase() === pagePath.toLowerCase();
  } catch {
    return false;
  }
}

/** Whether one IPC call came from that page, in the window's main frame. */
function fromOwnPage(event) {
  const frame = event?.senderFrame;
  if (frame === null || frame === undefined) return false;
  if (frame.parent !== null && frame.parent !== undefined) return false;
  return isOwnPage(frame.url);
}

/** The reader's failure envelope, for a call this process refuses to serve at all. */
function forbidden(operation) {
  trace(`refused ${operation}: the caller is not the app's own page`);
  return {
    ok: false,
    error: {
      name: 'RemoteError',
      isDSHRemoteError: true,
      code: 'gateway/forbidden',
      message: 'this operation is only available to the app window',
      details: { operation },
    },
  };
}

/**
 * Refuse every navigation this app did not intend.
 *
 * A document may contain links, and clicking one must not turn this window into a browser:
 * the page that arrived would inherit the host bridge. External targets go to the operating
 * system's browser instead, and nothing here — popups, webviews, or a navigation that leaves
 * the page — is allowed to carry this window away.
 */
function installNavigationGuard() {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (isOwnPage(url)) return;
      event.preventDefault();
      trace(`refused navigation to ${String(url).slice(0, 120)}`);
      if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => {});
    });
    contents.setWindowOpenHandler(({ url }) => {
      trace(`refused a new window for ${String(url).slice(0, 120)}`);
      if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      trace('refused a webview');
    });
  });
}

module.exports = { forbidden, fromOwnPage, installNavigationGuard, isOwnPage };
