/**
 * Every DSH internal this shell depends on, in one file.
 *
 * The reader is a DSH client plugin, so this shell has to speak DSH's vocabulary: the
 * package ids a plugin may require from its host, the seats it registers into, the global
 * its bundle publishes through, and the deployment limit global it reads. None of that is
 * a published API — it is the shape of another project's client runtime — so the names
 * live here and nowhere else, and `tools/contract.test.mjs` fails when a vendored bundle
 * stops agreeing with them. An upstream rename should mean editing this file, not hunting
 * through the shell for the strings it used to use.
 */

/**
 * The theme bundle: the `--dsw-*` design tokens every reader stylesheet is written
 * against, and the reason its typography resolves instead of falling back to the
 * browser's defaults.
 */
export const THEME_BUNDLE = {
  id: '@deepseek-ai/dsh-client-ui-theme',
  file: 'client.theme.js',
};

/** The reader bundle: the document preview itself. */
export const READER_BUNDLE = {
  id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  file: 'client.js',
};

/** The bundles to load, in dependency order. The theme boots first, as it does in DSH. */
export const BUNDLES = [THEME_BUNDLE, READER_BUNDLE];

/**
 * The bare specifiers a plugin may require, and the host must supply.
 *
 * A bundle is a factory that receives a `require`; every bare import inside it has to be
 * answered by whoever booted it, so this list is the agreement about what is handed over.
 */
export const PLATFORM_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/**
 * The framework specifiers a bundle may require, and the shell must answer.
 *
 * These are the shell's own dependencies rather than DSH packages, but a bundle that
 * requires them fails the same way when the host stops answering, so they belong to the
 * same agreement.
 */
export const FRAMEWORK_PACKAGES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

/** The seats this shell has to have open before the reader boots. */
export const SLOTS = {
  /** The seat a document's tab body registers into. */
  documentTab: 'sidebar.right.pane.tab',
  /** The seat its chip registers into. */
  documentTitle: 'sidebar.right.pane.tab.title',
};

/**
 * The seats, in the shape the slot service seeds them.
 *
 * The document seats *beneath* these are declared by the reader's own body registration
 * and must stay undeclared here, or that registration would throw.
 */
export const READER_SEATS = [
  { name: SLOTS.documentTab, kind: 'keyed', scope: 'session' },
  { name: SLOTS.documentTitle, kind: 'keyed', scope: 'session' },
];

/** The tab identity the shell dispatches to: the reader's own plugin id. */
export const READER_TAB_ID = READER_BUNDLE.id;

/** The global a DSH client bundle publishes its factory through. */
export const LOADER_GLOBAL = '__ModuleLoader__';

/** The global a DSH deployment writes the reader's deployment limits into. */
export const LIMITS_GLOBAL = '__DSH_DOCUMENT_PREVIEW_CONFIG__';

/** The settings namespace the theme plugin reads its preference from. */
export const THEME_SETTINGS_KEY = 'ui-theme';
