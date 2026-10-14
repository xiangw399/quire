/**
 * Launch the verification browser and leave it listening.
 *
 * The harness drives the installed Edge through the Chrome DevTools Protocol.
 * Playwright's own launch mode uses a *pipe* for that protocol, which a confined
 * Windows process may not open; a debugging *port* is an ordinary socket and
 * works in the same confinement. So the browser is started here and the harness
 * attaches to it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.DSH_VIEWER_CDP_PORT ?? 9222);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** Candidate Chromium-family browsers, in preference order. */
const CANDIDATES = [
  process.env.DSH_VIEWER_BROWSER,
  EDGE,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

async function pickBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next
    }
  }
  throw new Error('no Chromium-family browser found');
}

const profile = path.join(os.tmpdir(), `dsh-viewer-profile-${PORT}`);
await fs.mkdir(profile, { recursive: true });

const browser = await pickBrowser();
const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ],
  // No pipes: the harness talks to the browser over the debugging port, and a
  // detached child must outlive this script.
  { stdio: 'ignore', detached: true },
);
child.unref();

/** Poll the debugging endpoint until the browser answers. */
async function waitForBrowser() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) {
        const version = await response.json();
        console.log(`[browser] ${version.Browser} listening on ${PORT}`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`browser did not open its debugging port within 30s (pid ${child.pid})`);
}

await waitForBrowser();
console.log(`[browser] pid ${child.pid}, profile ${profile}`);
