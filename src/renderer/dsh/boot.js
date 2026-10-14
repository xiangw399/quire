/**
 * Boot: load the reader's DSH-built bundles into a plain shell.
 *
 * The reader arrives as a vendor bundle written for DSH's client-module loader.
 * This module is the shape of that boot without DSH: install the bridge with the
 * platform module table, load the bundles, hand the resulting plugins to the shell
 * runtime, and return the runtime the React tree renders against.
 *
 * Two bundles are loaded, in this order, because the second depends on the first:
 *
 *  - the theme, which defines the `--dsw-*` design tokens every reader stylesheet
 *    is written against;
 *  - the reader itself, whose own lazy chunks stay lazy: PDF.js and the spreadsheet
 *    stack load only when such a file is opened.
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Store from '@deepseek-ai/dsh-client-store';
import * as Slots from '@deepseek-ai/dsh-client-ui-slots';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as Dockkit from '@deepseek-ai/dsh-client-ui-dockkit';
import * as Cordis from '@deepseek-ai/cordis';
import { configureBridge, importClientModule, bridgeState } from './bridge.js';
import { installPlatformHelpers, installWorkerPlatformHelpers } from './platform-helpers.js';
import { createShellRuntime } from './shell-runtime.js';
import { createLocaleService } from './locale.js';
import { createResourcesService } from './resources.js';
import { tabInfoHookFactory } from './runtime-context.js';
import { LOCAL_SESSION_ID } from './session.js';

// The ids, the seats and the shared package list are DSH internals and live in the
// contract. Re-exported because this module is the shell's boot surface, and callers
// already read them from here.
import { BUNDLES, FRAMEWORK_PACKAGES, LIMITS_GLOBAL, PLATFORM_PACKAGES } from './contract.js';
export { READER_BUNDLE, THEME_BUNDLE, BUNDLES } from './contract.js';

/** Boot counter: each boot loads the reader afresh, as a page load would. */
let bootCount = 0;

/** Absolute URL of a vendor file, carrying its boot's cache key. */
export function vendorUrl(file, boot = '') {
  return new URL(`vendor/${file}${boot}`, import.meta.url).href;
}

/** Absolute URL of one vendor chunk, resolved against its owner bundle. */
export function chunkUrl(ownerId, chunk, boot = '') {
  void ownerId;
  return new URL(`vendor/${chunk}${boot}`, import.meta.url).href;
}

/**
 * Boot the reader.
 * @param options - the host faces the reader reads through.
 * @returns the runtime, ready to render.
 */
export async function bootReader(options) {
  const { remote, host, config = {}, language = 'zh', themePreference = 'dark' } = options;

  // A fresh boot must not reuse a previous boot's module instance. In a page this
  // is moot (one boot per document); in a harness that boots repeatedly, an
  // unversioned URL would hand back the earlier, already-registered bundle.
  bootCount += 1;
  const boot = `?boot=${bootCount}`;

  // The reader reads its own deployment limits from this global, and these are its own
  // defaults. They are passed through rather than raised: DSH applies the same cap, so a
  // workbook it refuses is refused here too, and the two behave alike. The cap is on a
  // sheet's declared range — `highest row * highest column` — which is why a workbook that
  // formats whole columns can reach it while holding few cells; DSH reports the same thing
  // for such a file, so this is a limit of the reader rather than of this shell.
  //
  // A deployment that wants different limits can pass `config.excel` / `config.office`.
  globalThis[LIMITS_GLOBAL] = {
    office: {
      maxCachedEntries: config.office?.maxCachedEntries ?? 8,
      maxCachedBytes: config.office?.maxCachedBytes ?? 64 * 1024 * 1024,
      maxPending: config.office?.maxPending ?? 8,
      maxReaders: config.office?.maxReaders ?? 32,
    },
    excel: {
      maxBytes: config.excel?.maxBytes ?? 16 * 1024 * 1024,
      maxCells: config.excel?.maxCells ?? 250000,
      timeoutMs: config.excel?.timeoutMs ?? 15000,
    },
  };

  // The reader requires these by bare specifier, so the contract names which ones exist
  // and this table says what answers them — the two cannot drift apart in silence, and
  // `tools/contract.test.mjs` fails if the list stops matching what the bundle asks for.
  const frameworkModules = {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
  };
  const sharedModules = {
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': Store,
    '@deepseek-ai/dsh-client-ui-slots': Slots,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
    '@deepseek-ai/dsh-client-ui-dockkit': Dockkit,
  };
  configureBridge({
    platform: {
      ...Object.fromEntries(FRAMEWORK_PACKAGES.map((name) => [name, frameworkModules[name]])),
      ...Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, sharedModules[name]])),
    },
    resolveChunk: (ownerId, chunk) => chunkUrl(ownerId, chunk, boot),
    bootKey: boot,
  });

  // The reader's engines expect a few helpers from their host — DSH's client platform
  // provides them — and build their worker at run time, so both realms are covered before
  // any document can be opened.
  installPlatformHelpers();
  installWorkerPlatformHelpers();

  const plugins = [];

  for (const bundle of BUNDLES) {
    plugins.push(await importClientModule(vendorUrl(bundle.file, boot), bundle.id));
  }

  const locale = createLocaleService(language);
  const resources = createResourcesService({ host });

  const runtime = createShellRuntime({
    plugins,
    remote,
    resources,
    locale,
    interactiveHtmlPreview: options.interactiveHtmlPreview,
    themeSettings: { preference: themePreference, fontSize: 14, ...(options.themeSettings ?? {}) },
    platformModules: [...bridgeState().platform],
  });
  runtime.boot();

  // The theme plugin publishes snapshots; presenting one is the shell's job.
  installThemePresenter(runtime);

  // The shell's own seats: the resource hook every reader component expects, and
  // the slot-level tab reader its document seats declare.
  runtime.ctx.slots.provideRoot({ keyedHooks: { resource: (address) => resources.source(address) } });
  runtime.installSlotHookFactory('tabInfo', tabInfoHookFactory);

  runtime.locale = locale;
  runtime.resources = resources;
  runtime.host = host;
  runtime.sessionId = LOCAL_SESSION_ID;
  runtime.audit = { bridge: bridgeState(), runtime: runtime.diagnostics() };
  return runtime;
}

/**
 * Present the theme plugin's snapshots on the document.
 *
 * The plugin owns which theme is active; it does not own the DOM. In DSH the
 * presenter lives in the layout package, and without one the plugin's preference has
 * no effect at all: the app then renders in the light palette whatever the settings
 * say, because the theme's stylesheets switch on `body[data-ds-dark-theme]`.
 *
 * This applies a snapshot the way those stylesheets expect — the scheme as an
 * attribute, and any override tokens as inline variables (the channel the plugin
 * documents for registered themes).
 *
 * @param runtime - the booted shell runtime.
 */
function installThemePresenter(runtime) {
  const apply = (snapshot) => {
    if (snapshot?.active === undefined) return;
    const body = document.body;
    if (body === null) return;
    if (snapshot.active.colorScheme === 'dark') body.setAttribute('data-ds-dark-theme', '');
    else body.removeAttribute('data-ds-dark-theme');

    // A registered theme's overrides are applied over the base palette; the built-in
    // pair carries none, so this is usually a no-op.
    for (const [name, value] of Object.entries(snapshot.active.tokens ?? {})) {
      body.style.setProperty(name, value);
    }
    if (snapshot.fontSize !== undefined) body.style.setProperty('--dsh-content-font-size', `${snapshot.fontSize}px`);
    document.documentElement.style.colorScheme = snapshot.active.colorScheme;
  };

  runtime.ctx.on('theme/change', apply);
  // The service table is the context's, not the runtime object's.
  const theme = runtime.ctx.reflect.get('theme');
  if (theme !== undefined) apply(theme.getTheme());
}
