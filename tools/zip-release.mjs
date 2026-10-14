/**
 * Zip the portable build.
 *
 * The portable form and the installer are two ways to the same app: the installer
 * places shortcuts and registers an uninstaller, the archive is a directory the
 * user can unpack and run. Windows' own archiver is used, so no build dependency
 * is added for this.
 *
 * Usage: node tools/zip-release.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const releaseRoot = path.resolve('release');
const stage = path.join(releaseRoot, 'Quire');
const archive = path.join(releaseRoot, 'Quire-portable.zip');

await fs.access(path.join(stage, 'Quire.exe')).catch(() => {
  console.log(`[zip] no staged build at ${stage}; run tools/package.mjs first`);
  process.exit(1);
});

await fs.rm(archive, { force: true });
console.log(`[zip] archiving ${stage}`);

try {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${archive}' -CompressionLevel Optimal`,
    ],
    { stdio: 'inherit' },
  );
} catch (error) {
  console.error(`[zip] Compress-Archive failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}

const stats = await fs.stat(archive).catch(() => undefined);
if (stats === undefined) {
  console.error('[zip] no archive was produced');
  process.exitCode = 1;
} else {
  console.log(`[zip] wrote ${archive} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
}
