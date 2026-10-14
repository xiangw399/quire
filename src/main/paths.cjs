/**
 * Where this application keeps its files.
 *
 * One module computes the layout, so the main process, the startup trace and the page
 * boundary cannot disagree about which directory is the application and which file is its
 * own page. In a packaged build this is `resources/app`; in a development launch it is the
 * checkout.
 */
const path = require('node:path');

/** The application root. */
const projectRoot = path.resolve(__dirname, '..', '..');

/** The built shell the window loads. */
const webRoot = path.join(projectRoot, 'dist', 'web');

/** The one page this application serves. */
const pagePath = path.join(webRoot, 'index.html');

module.exports = { pagePath, projectRoot, webRoot };
