/** Register the CSS-module loader hook before the smoke test imports anything. */
import { register } from 'node:module';

register('./css-loader-hook.mjs', import.meta.url);
