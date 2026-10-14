/**
 * P0 smoke test: load the DSH reader bundle outside DSH and run its `apply`.
 *
 * It answers the only question that matters before the shell exists: does the
 * extracted plugin accept a context we can build ourselves, and what exactly
 * does it ask that context for?
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const vendorDir = path.resolve('vendor');
const requests = [];

function record(kind, detail) {
  requests.push(`${kind}: ${detail}`);
}

// ---- minimal DOM stand-ins the bundle touches at module scope -------------
// react-dom does feature detection at import time, so element stubs must be
// permissive; the reader itself only ever creates <style> tags.
const styleTags = [];
function elementStub(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    firstChild: null,
    parentNode: null,
    ownerDocument: null,
    sheet: { insertRule: () => 0, cssRules: [] },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    removeAttribute() {},
    hasAttribute() {
      return false;
    },
    appendChild(child) {
      el.firstChild = child;
      return child;
    },
    removeChild() {},
    insertBefore(child) {
      return child;
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttributeNS() {},
    canHaveChildren: true,
  };
  return el;
}

globalThis.document = {
  createElement(tag) {
    const el = elementStub(tag);
    if (tag === 'style') styleTags.push(el);
    return el;
  },
  createElementNS(_ns, tag) {
    return elementStub(tag);
  },
  createTextNode(text) {
    return { nodeType: 3, textContent: text };
  },
  createDocumentFragment() {
    return elementStub('#fragment');
  },
  createComment(data) {
    return { nodeType: 8, textContent: data };
  },
  head: elementStub('head'),
  body: elementStub('body'),
  documentElement: elementStub('html'),
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById() {
    return null;
  },
  getElementsByTagName() {
    return [];
  },
  addEventListener() {},
  removeEventListener() {},
  implementation: { createHTMLDocument: () => globalThis.document },
};
globalThis.document.documentElement.dataset = {};
globalThis.document.documentElement.style = {};
globalThis.navigator ??= { userAgent: 'node', platform: 'win32' };
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size;
  },
};

// ---- capture the vendor factory ------------------------------------------
let registration;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  load(reg) {
    registration = reg;
  },
};

const bundlePath = path.join(vendorDir, 'client.js');
await import(pathToFileURL(bundlePath).href);
if (!registration) throw new Error('vendor bundle registered no factory');
console.log(`[ok] captured factory for ${registration.id}`);

// ---- platform table ------------------------------------------------------
async function platformTable() {
  const react = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const reactDom = await import('react-dom');
  return {
    react: react.default ?? react,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': reactDom.default ?? reactDom,
    'react-dom/client': await import('react-dom/client'),
    '@deepseek-ai/dsh-client-store': await import('@deepseek-ai/dsh-client-store'),
    '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
    '@deepseek-ai/dsh-client-ui-slots': await import('@deepseek-ai/dsh-client-ui-slots'),
    '@deepseek-ai/dsh-client-ui-dockkit': await import('@deepseek-ai/dsh-client-ui-dockkit'),
  };
}

const platform = await platformTable();
record('require', Object.keys(platform).join(', '));

// The bundle also requires the DSH client framework. Those packages are real
// npm releases; for this smoke test we only need to know which are asked for,
// so unresolved requests are recorded instead of thrown.
const unresolved = new Set();
function makeRequire() {
  return (request) => {
    if (platform[request]) return platform[request];
    unresolved.add(request);
    record('require.MISSING', request);
    // A hollow stand-in: enough for module-scope reads, loud on use.
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === '__esModule') return false;
          if (prop === Symbol.toStringTag) return 'Module';
          throw new Error(`stub read of ${String(prop)} from unresolved module "${request}"`);
        },
      },
    );
  };
}

// ---- context under test --------------------------------------------------
const services = new Set();
const effects = [];
const slotRegistrations = [];
const localeRegistrations = [];
const documentPreviews = [];
const sidebarTabs = [];
const providedServices = new Map();

function makeContext() {
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    on() {
      return () => {};
    },
    inject(names, cb) {
      for (const n of names) services.add(`inject:${n}`);
      cb(ctx);
    },
    slots: {
      inject(name, cb) {
        services.add(`slots.inject:${name}`);
        cb();
      },
      register(decl, component) {
        slotRegistrations.push({ name: decl.name, key: decl.key ?? null, component });
        return () => {};
      },
    },
    locale: {
      register(namespace, dict) {
        localeRegistrations.push({ namespace, keys: Object.keys(dict ?? {}).length });
      },
      bind(namespace) {
        services.add(`locale.bind:${namespace}`);
        const t = (key) => `${namespace}.${key}`;
        t.with = () => t;
        return t;
      },
    },
    sidebarRightTabs: {
      register(def) {
        sidebarTabs.push(def);
      },
    },
    documentPreviews: {
      register(def) {
        documentPreviews.push(def);
      },
    },
    reflect: {
      provide(name, value) {
        services.add(`reflect.provide:${name}`);
        providedServices.set(name, value);
        return () => providedServices.delete(name);
      },
      get(name) {
        return providedServices.get(name);
      },
      set(name, value) {
        providedServices.set(name, value);
        return () => providedServices.delete(name);
      },
    },
  };
  return ctx;
}

const ctx = makeContext();
const plugin = registration.factory(makeRequire());
console.log(`[ok] factory materialized; exports = ${Object.keys(plugin).join(', ')}`);

if (typeof plugin.apply !== 'function') throw new Error('plugin has no apply()');
plugin.apply(ctx);

// ---- report --------------------------------------------------------------
console.log('\n=== unresolved module requests ===');
console.log(unresolved.size ? [...unresolved].join('\n') : '(none)');

console.log('\n=== context services the plugin asked for ===');
console.log([...services].sort().join('\n'));

console.log('\n=== slot registrations ===');
for (const r of slotRegistrations) console.log(`${r.name}${r.key ? ` [${r.key}]` : ''}`);

console.log('\n=== document preview renderers registered ===');
for (const d of documentPreviews) {
  console.log(
    `${d.id}\n    extensions=[${(d.extensions ?? []).join(',')}] binary=[${(d.binaryExtensions ?? []).join(',')}] ` +
      `priority=${d.priority} loading=${d.loading} wrap=${d.wrap ?? false}`,
  );
}

console.log('\n=== sidebar tab types ===');
for (const t of sidebarTabs) console.log(`${t.id} kind=${t.kind} pattern=${t.pattern} tier=${t.tier}`);

console.log('\n=== locale dictionaries ===');
for (const l of localeRegistrations) console.log(`${l.namespace} (${l.keys} keys)`);

console.log('\n=== retained effects ===');
console.log(`${effects.length} effect(s)`);
for (const e of effects) if (e.label) console.log(`  - ${e.label}`);

console.log('\n=== injected <style> tags ===');
console.log(`${styleTags.length} style tag(s)`);
