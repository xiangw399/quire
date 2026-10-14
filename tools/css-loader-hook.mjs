/**
 * Node ESM loader hooks for the P0 smoke test.
 *
 * The published DSH client packages import CSS modules (`./X.module.css`).
 * Node cannot load those; Vite can. This hook exists only so the smoke test can
 * run headless: it answers every CSS-module import with a permissive stand-in
 * whose property reads return their own name, which is enough to observe which
 * class names the reader ever touches.
 */
import fs from 'node:fs';

const touched = new Set();

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    // The stand-in records the lookup instead of failing the import.
    const source = `
      const touched = new Set();
      const css = new Proxy({}, {
        get(_t, prop) {
          if (prop === '__esModule') return false;
          if (typeof prop !== 'string') return undefined;
          if (prop === 'then') return undefined;
          touched.add(prop);
          globalThis.__CSS_TOUCHED__ ??= new Set();
          globalThis.__CSS_TOUCHED__.add(prop);
          return prop;
        },
      });
      export default css;
    `;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('.css?module')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  void fs;
  void touched;
  return nextLoad(url, context);
}
