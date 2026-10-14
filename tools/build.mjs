/**
 * Build the shell and stage the reader's vendor bundles.
 *
 * Two build products, one output directory:
 *  - the shell (`index.html`, JS, CSS) built from `src/renderer`;
 *  - the reader's vendor bundles copied verbatim, because they are DSH-built
 *    artifacts whose own lazy chunks must stay loadable by filename at run time.
 *
 * Why this drives esbuild through its CLI rather than its JS API: the JS API
 * spawns esbuild with piped stdio, which a confined Windows process is not
 * allowed to do. The CLI form is the same compiler without that pipe.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const outdir = path.resolve('dist/web');
const vendorSource = path.resolve('vendor');
const vendorFiles = ['client.js', 'client.pdf.js', 'client.excel.js', 'client.theme.js'];

/** The shell's HTML entry: no framework, one module script. */
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!--
      The page reads local files and draws them; a document it previews may also run its
      own scripts and fetch what those scripts name over https, because that is what a
      report with a JavaScript-drawn chart needs. That is the scripted preview — the mode
      DSH's own sidebar uses — and the interactiveHtmlPreview option in
      src/renderer/main.jsx is what selects it.

      This policy therefore differs from the earlier, script-free one in three places:
      'unsafe-inline' (a previewed document inherits this page's policy, and both its own
      inline script and the reader's fixed bootstrap are inline), https: (a report may
      name a chart library on a CDN), and the https: entries added to default-src, img-src,
      font-src, frame-src and connect-src for the remote resources a report may reference.

      What has not changed: a previewed document still runs in a sandboxed, origin-less
      iframe, so it cannot reach this page, its bridge, or the host; 'unsafe-eval' stays
      because the vendored reader bundles build a function from a source string; file: is
      listed beside 'self' because a file:// document's own origin does not reliably match
      itself; object-src 'none' stays, as no report needs a plugin.
    -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self' file: dsh-file: blob: data: https:; script-src 'self' file: blob: https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' file: https: 'unsafe-inline'; img-src 'self' file: dsh-file: blob: data: https:; font-src 'self' file: dsh-file: data: https:; frame-src 'self' file: blob: data: https:; connect-src 'self' file: dsh-file: blob: data: https:; object-src 'none'"
    />
    <title>Quire</title>
    <link rel="stylesheet" href="./shell.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./shell.js"></script>
  </body>
</html>
`;

/** Locate the esbuild executable for this platform. */
async function esbuildBinary() {
  const target = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
  const candidates = [
    path.resolve('node_modules/@esbuild', target, 'esbuild.exe'),
    path.resolve('node_modules/@esbuild', target, 'bin/esbuild'),
    path.resolve('node_modules/esbuild/bin/esbuild'),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`no esbuild executable found for ${target}`);
}

/** Copy the reader's vendor bundles, unchanged. */
async function stageVendor() {
  const target = path.join(outdir, 'vendor');
  await fs.mkdir(target, { recursive: true });
  for (const file of vendorFiles) {
    await fs.copyFile(path.join(vendorSource, file), path.join(target, file));
  }
  return vendorFiles;
}

/** Recursive output size, for the build report. */
async function directorySize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(at);
    else total += (await fs.stat(at)).size;
  }
  return total;
}

async function main() {
  await fs.rm(outdir, { recursive: true, force: true });
  await fs.mkdir(outdir, { recursive: true });

  const esbuild = await esbuildBinary();
  const args = [
    path.resolve('src/renderer/main.jsx'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=chrome120',
    '--jsx=automatic',
    // Source maps are a development aid: a release should not carry 14 MB of them, and
    // they hand the reader's full source to anyone who unpacks it. `npm run build:dev`
    // turns them back on.
    ...(process.argv.includes('--sourcemap') || process.env.DSH_VIEWER_SOURCEMAP === '1' ? ['--sourcemap=linked'] : []),
    '--metafile=dist/web/meta.json',
    `--outfile=${path.join(outdir, 'shell.js')}`,
    '--loader:.css=css',
    '--loader:.module.css=local-css',
    '--loader:.svg=dataurl',
    '--loader:.png=dataurl',
    '--loader:.woff2=file',
    '--loader:.woff=file',
    '--loader:.ttf=file',
    '--define:process.env.NODE_ENV="production"',
  ];

  const run = spawnSync(esbuild, args, { stdio: 'inherit', cwd: process.cwd() });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`esbuild exited with ${run.status}`);

  const staged = await stageVendor();

  // esbuild names CSS after the entry; the HTML expects `shell.css`.
  const meta = JSON.parse(await fs.readFile(path.join(outdir, 'meta.json'), 'utf8'));
  const cssOutputs = Object.keys(meta.outputs).filter((file) => file.endsWith('.css'));
  for (const source of cssOutputs) {
    const from = path.resolve(source);
    const to = path.join(outdir, 'shell.css');
    if (from !== to) await fs.rename(from, to);
  }
  await fs.writeFile(path.join(outdir, 'index.html'), INDEX_HTML, 'utf8');
  await fs.rm(path.join(outdir, 'meta.json'), { force: true });

  const jsOutputs = Object.keys(meta.outputs).filter((file) => file.endsWith('.js'));
  const total = await directorySize(outdir);
  console.log(`[build] shell  ${jsOutputs.join(', ')}`);
  console.log(`[build] vendor ${staged.join(', ')}`);
  console.log(`[build] css    ${cssOutputs.length} file(s) -> shell.css`);
  console.log(`[build] output ${outdir} (${(total / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error('[build] failed', error);
  process.exitCode = 1;
});
