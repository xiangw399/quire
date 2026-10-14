/**
 * Unit tests for the host-side file service.
 *
 * These are the behaviours a document viewer gets wrong quietly: the page after the
 * last line, the file that ends without a newline, the byte window that asks for more
 * than exists, and — the one that used to be a crash — the huge file that must be
 * paged without being decoded in full.
 *
 * Run: node --test tools/unit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DECODE_BYTES,
  MAX_FILE_BYTES,
  MAX_LINES_PER_PAGE,
  readBytes,
  readDirectory,
  readPage,
  resolveRequestPath,
  statFile,
} from '../src/main/file-service.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-viewer-unit-'));
const at = (name) => path.join(root, name);
const write = async (name, content) => {
  await fs.writeFile(at(name), content);
  return at(name);
};

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('resolveRequestPath: absolute wins, relative resolves against base file then root', () => {
  const absolute = at('a.txt');
  assert.equal(resolveRequestPath(absolute, undefined, root), path.normalize(absolute));
  assert.equal(resolveRequestPath('b.txt', undefined, root), path.join(root, 'b.txt'));
  assert.equal(resolveRequestPath('c.png', at('doc.md'), root), path.join(root, 'c.png'));
  assert.equal(resolveRequestPath('./sub/d.png', at('nested/doc.md'), root), path.join(root, 'nested', 'sub', 'd.png'));
});

test('readPage: pages a small file, and reports eof only at the end', async () => {
  const file = await write('three.txt', 'one\ntwo\nthree\n');
  const first = await readPage(file, 1);
  assert.equal(first.ok, true);
  assert.equal(first.value.text, 'one\ntwo\nthree');
  assert.equal(first.value.lines, 3);
  assert.equal(first.value.eof, true);

  const second = await readPage(file, 2);
  assert.equal(second.value.text, 'two\nthree');
  assert.equal(second.value.lines, 2);
  assert.equal(second.value.eof, true);

  const past = await readPage(file, 9);
  assert.equal(past.value.lines, 0);
  assert.equal(past.value.eof, true, 'a page past the last line is the end of the file');
});

test('readPage: a file that does not end in a newline keeps its last line', async () => {
  const file = await write('no-newline.txt', 'alpha\nbeta');
  const page = await readPage(file, 1);
  assert.equal(page.value.text, 'alpha\nbeta');
  assert.equal(page.value.lines, 2);
  assert.equal(page.value.eof, true);
});

test('readPage: CRLF and a lone CR both end a line', async () => {
  const crlf = await write('crlf.txt', 'a\r\nb\r\n');
  assert.equal((await readPage(crlf, 1)).value.text, 'a\nb');

  const classicMac = await write('cr.txt', 'x\ry\rz');
  const page = await readPage(classicMac, 1);
  assert.equal(page.value.lines, 3, 'a lone CR must not make the whole file one line');
  assert.equal(page.value.text, 'x\ny\nz');
});

test('readPage: a UTF-16 file with a BOM decodes, cap permitting', async () => {
  const file = at('utf16.txt');
  await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好\nworld\n', 'utf16le')]));
  const page = await readPage(file, 1);
  assert.equal(page.value.text, '你好\nworld');
  assert.equal(page.value.lines, 2);
});

test('readPage: an empty file is a page with no lines and eof set', async () => {
  const file = await write('empty.txt', '');
  const page = await readPage(file, 1);
  assert.equal(page.ok, true);
  assert.equal(page.value.lines, 0);
  assert.equal(page.value.eof, true);
});

test('readPage: a file missing or not regular reports the reader\'s codes', async () => {
  const missing = await readPage(at('nope.txt'), 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'not-found');
  const directory = await readPage(root, 1);
  assert.equal(directory.error.code, 'not-regular-file');
});

test('readPage: a file larger than the decode threshold is streamed, not decoded', async () => {
  // ~9 MiB of numbered lines: above MAX_DECODE_BYTES, so this exercises the streamed
  // path. The page sizes are what the decoded path would produce, which is the point.
  const file = at('huge.txt');
  const lineCount = 200000;
  const handle = await fs.open(file, 'w');
  try {
    const chunk = [];
    for (let index = 1; index <= lineCount; index += 1) {
      chunk.push(`line ${index} ${'x'.repeat(40)}\n`);
      if (chunk.length === 2000) {
        await handle.write(chunk.join(''));
        chunk.length = 0;
      }
    }
    if (chunk.length > 0) await handle.write(chunk.join(''));
  } finally {
    await handle.close();
  }
  const size = (await fs.stat(file)).size;
  assert.ok(size > MAX_DECODE_BYTES, `fixture is ${size} bytes, expected more than ${MAX_DECODE_BYTES}`);

  const first = await readPage(file, 1);
  assert.equal(first.ok, true);
  assert.equal(first.value.lines, MAX_LINES_PER_PAGE);
  assert.equal(first.value.eof, false, 'a full page of a long file is not the end');
  assert.ok(first.value.text.startsWith('line 1 '));

  const second = await readPage(file, MAX_LINES_PER_PAGE + 1);
  assert.equal(second.value.offset, MAX_LINES_PER_PAGE + 1);
  assert.ok(second.value.text.startsWith(`line ${MAX_LINES_PER_PAGE + 1} `));
  assert.equal(second.value.eof, false);

  const last = await readPage(file, lineCount);
  assert.equal(last.value.lines, 1);
  assert.equal(last.value.eof, true, 'the last line of the file ends the page');
  assert.ok(last.value.text.startsWith(`line ${lineCount} `));
});

test('readBytes: whole file, byte window, and the cap', async () => {
  const file = await write('bytes.bin', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

  const whole = await readBytes(file, {});
  assert.equal(whole.ok, true);
  assert.deepEqual([...whole.value.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(whole.value.eof, true);

  // The window is open-ended by contract: from `offset` to the end of the file, or to
  // the read cap. The reader asks for a page of text with offset, not a byte count.
  const window = await readBytes(file, { offset: 3 });
  assert.deepEqual([...window.value.data], [4, 5, 6, 7, 8]);
  assert.equal(window.value.offset, 3);
  assert.equal(window.value.eof, true, 'a window that reaches the last byte is the end');

  const tail = await readBytes(file, { offset: 6 });
  assert.deepEqual([...tail.value.data], [7, 8]);
  assert.equal(tail.value.eof, true);

  const past = await readBytes(file, { offset: 99 });
  assert.equal(past.ok, true);
  assert.equal(past.value.data.byteLength, 0);
  assert.equal(past.value.eof, true);
});

test('readBytes: a file beyond the read cap is refused whole but readable in a window', async () => {
  const file = at('sparse.bin');
  await fs.writeFile(file, '');
  await fs.truncate(file, MAX_FILE_BYTES + 1024);

  const whole = await readBytes(file, {});
  assert.equal(whole.ok, false);
  assert.equal(whole.error.code, 'too-large');

  const window = await readBytes(file, { offset: MAX_FILE_BYTES });
  assert.equal(window.ok, true);
  assert.equal(window.value.data.byteLength, 1024);
  assert.equal(window.value.eof, true);
});

test('statFile: metadata for a file, codes for a directory and a missing path', async () => {
  const file = await write('stat.txt', 'hello');
  const stat = await statFile(file);
  assert.equal(stat.ok, true);
  assert.equal(stat.value.size, 5);
  assert.match(stat.value.version, /^\d+-\d+$/);
  assert.equal((await statFile(root)).error.code, 'not-regular-file');
  assert.equal((await statFile(at('gone.txt'))).error.code, 'not-found');
});

test('readDirectory: one level, directories first, symlinks flagged', async () => {
  await fs.mkdir(at('zdir'), { recursive: true });
  await fs.mkdir(at('adir'), { recursive: true });
  await write('b.txt', 'b');
  const listing = await readDirectory(root);
  assert.equal(listing.ok, true);
  const names = listing.value.entries.map((entry) => entry.name);
  assert.deepEqual(names.slice(0, 2), ['adir', 'zdir'], 'directories come first');
  assert.ok(names.includes('b.txt'));
  const file = listing.value.entries.find((entry) => entry.name === 'b.txt');
  assert.equal(file.directory, false);
  assert.equal(file.symlink, false);
  assert.equal(file.path, at('b.txt'));
});
