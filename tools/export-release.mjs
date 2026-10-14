/**
 * Copy the distributables to a directory outside the session workspace.
 *
 * Both the installer and the portable build work when they are run from an ordinary folder.
 * Running them from inside this project's directory does not: that path is the agent
 * session's workspace, and a program started from it inherits the session's confinement — so
 * an NSIS stub, which must write itself to a temporary directory before it can show a single
 * page, fails at once with "Error writing temporary file…". The same bytes copied elsewhere
 * start normally.
 *
 * This exists so that fact stops being rediscovered: the build writes its artifacts here, and
 * this step places them where a double-click behaves.
 *
 * Usage: node tools/export-release.mjs [target-directory]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = path.resolve('.');
const releaseRoot = path.join(projectRoot, 'release');
const target = path.resolve(process.argv[2] ?? 'D:/Quire-release');

/** The artifacts worth handing over, and what each is for. */
const ARTIFACTS = [
  { name: 'Quire-Setup.exe', why: '安装向导（必须放在工作区外运行）' },
  { name: 'Quire-portable.zip', why: '绿色版（解压即用，含 install.ps1）' },
];

await fs.mkdir(target, { recursive: true });

const placed = [];
for (const artifact of ARTIFACTS) {
  const from = path.join(releaseRoot, artifact.name);
  try {
    await fs.access(from);
  } catch {
    console.log(`[export] skipped ${artifact.name} (not built yet)`);
    continue;
  }
  const to = path.join(target, artifact.name);
  await fs.copyFile(from, to);
  const size = (await fs.stat(to)).size;
  placed.push({ ...artifact, to, size });
}

if (placed.length === 0) {
  console.log('[export] nothing to export; run the packaging steps first');
  process.exit(1);
}

console.log(`[export] ${target}`);
for (const artifact of placed) {
  console.log(`  ${artifact.name}  ${(artifact.size / 1024 / 1024).toFixed(1)} MB  — ${artifact.why}`);
}
console.log('');
console.log('[export] 重要：这些文件之所以放在这里，是因为从本项目目录内运行会被会话限制。');
console.log('[export] 请从上面这个目录双击安装包。');
