/**
 * The startup trace.
 *
 * A packaged app has no console to read, and a development launch may exit before anyone
 * sees one. Every boot phase is appended to a file so a silent exit still says how far it
 * got — the alternative is guessing from an empty stderr.
 *
 * The destination follows the two ways the app runs: a development launch may write into
 * the checkout, while an installed app must use its own writable data directory, because
 * the application directory may be read-only. A location is only accepted once a write to
 * it has succeeded, because every write below is best-effort — a destination that cannot
 * be written at all is indistinguishable from a crash that reported nothing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { projectRoot } = require('./paths.cjs');

/** The first location that can actually be written, or nothing. */
function traceTarget() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(app.getPath('userData'), 'boot.log'));
  else candidates.push(path.join(projectRoot, 'artifacts', 'electron-boot.log'));
  // Last resort: a directory every process can write, so a machine whose own data
  // directory could not be created still leaves a record of how far it got.
  candidates.push(path.join(os.tmpdir(), 'quire-boot.log'));

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.appendFileSync(candidate, '');
      return candidate;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

const traceFile = traceTarget();

if (traceFile !== undefined) {
  try {
    fs.appendFileSync(
      traceFile,
      `[boot] ${new Date().toISOString()} electron ${process.versions.electron} node ${process.versions.node} packaged=${app.isPackaged}\n`,
    );
  } catch {
    // A location that stops being writable must not stop the app from starting.
  }
}

/** Append one phase to the trace, if there is anywhere to put it. */
function trace(message) {
  if (traceFile === undefined) return;
  try {
    fs.appendFileSync(traceFile, `[boot] ${message}\n`);
  } catch {
    // tracing is best-effort
  }
}

module.exports = { trace, traceFile, traceTarget };
