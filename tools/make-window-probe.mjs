/**
 * Stage two apps that differ by exactly one statement.
 *
 * Everything in this investigation has been confounded by the launch path: a child
 * spawned from Node may be refused where a child spawned from PowerShell is allowed,
 * and the refusal looks exactly like the failure under test. So the two apps below
 * are launched by the same PowerShell command, at the same kind of short ASCII path,
 * and differ only in whether the main process creates a `BrowserWindow`.
 *
 * Usage: node tools/make-window-probe.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve('.');
const runtimeDir = path.join(projectRoot, 'runtime', 'electron');
const base = process.argv[2] ?? 'C:\\electron-probe-win';

/** The shared body; the only difference between the two apps is the window call. */
function mainSource({ createWindow }) {
  return `// One-statement difference probe.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const reportPath = path.join(__dirname, '..', '..', 'probe-report.txt');
function report(line) {
  try {
    fs.appendFileSync(reportPath, line + '\\n');
  } catch (error) {
    process.stdout.write('REPORT FAILED ' + error.message + '\\n');
  }
  process.stdout.write('PROBE ' + line + '\\n');
}

report('1. main script evaluated');
report('2. require(electron) -> ' + typeof require('electron'));
report('3. app object -> ' + (app === undefined ? 'undefined' : 'present'));

app.whenReady().then(() => {
  report('4. ready');
  ${createWindow
      ? `const { BrowserWindow } = require('electron');
  report('5. BrowserWindow class obtained');
  const window = new BrowserWindow({ width: 400, height: 200 });
  report('6. window constructed');
  setTimeout(() => { report('7. survived 1s'); app.exit(0); }, 1000);`
      : `report('5. creating no window on purpose');
  setTimeout(() => { report('6. survived 1s'); app.exit(0); }, 1000);`}
});
`;
}

const VARIANTS = [
  { id: 'no-window', createWindow: false },
  { id: 'with-window', createWindow: true },
];

/** Stage one variant and return the command that runs it. */
async function stage(variant) {
  const target = path.join(base, variant.id);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, 'resources', 'app'), { recursive: true });
  for (const entry of await fs.readdir(runtimeDir, { withFileTypes: true })) {
    if (entry.name === 'resources' || entry.name === 'locales') continue;
    await fs.copyFile(path.join(runtimeDir, entry.name), path.join(target, entry.name));
  }
  await fs.writeFile(path.join(target, 'resources', 'app', 'index.js'), mainSource(variant), 'utf8');
  await fs.writeFile(
    path.join(target, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: variant.id, main: 'index.js' }, null, 2),
    'utf8',
  );
  await fs.rm(path.join(target, 'probe-report.txt'), { force: true });
  return path.join(target, 'electron.exe');
}

await fs.mkdir(base, { recursive: true });
const commands = [];
for (const variant of VARIANTS) {
  const exe = await stage(variant);
  commands.push({ id: variant.id, exe });
}

const runScript = [
  '# One-statement difference: does creating a window abort the process?',
  'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
  ...commands.flatMap(({ id, exe }) => [
    `Write-Host '=== ${id} ==='`,
    `Remove-Item '${path.join(path.dirname(exe), 'probe-report.txt')}' -ErrorAction SilentlyContinue`,
    `& '${exe}'`,
    `Write-Host "exit=$LASTEXITCODE"`,
    `if (Test-Path '${path.join(path.dirname(exe), 'probe-report.txt')}') { Get-Content '${path.join(path.dirname(exe), 'probe-report.txt')}' } else { Write-Host '  (no report)' }`,
    '',
  ]),
].join('\r\n');

const scriptPath = path.join(base, 'run.ps1');
await fs.writeFile(scriptPath, runScript, 'utf8');

console.log(`[probe] staged under ${base}`);
for (const { id, exe } of commands) console.log(`        ${id}: ${exe}`);
console.log(`[probe] run: pwsh -NoProfile -File "${scriptPath}"`);
