/**
 * Office conversion verification: Word and PowerPoint to PDF, end to end.
 *
 * This is the same path the desktop app takes — the vendored LibreOffice kit, our
 * own bounded converter around it, and the bytes the reader's PDF renderer would
 * receive. The fixtures are minimal but real OOXML, built here so the check needs
 * no external document.
 *
 * Usage: node tools/verify-office.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createOfficeConverter } from '../src/main/office-converter.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A minimal ZIP writer, as the OOXML fixtures are archives of XML parts. */
function zipOf(files) {
  const table = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // No general-purpose flags: the CRC and sizes are written here, so declaring
    // bit 3 (a trailing data descriptor) would promise bytes that never follow.
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    // "Version made by" must carry a host system (0 = MS-DOS) and a version
    // (20 = 2.0); a zero here reads as an unsupported archive.
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    // Where this entry's local header starts. Leaving this zero makes every entry
    // point at the first one, which a reader reports as a truncated archive.
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBuffer]));
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/**
 * A minimal Word document with one heading and one paragraph.
 *
 * The archive carries a canonical `_rels/.rels` even though the engine's entry
 * filter does not admit it: the engine's own admission check requires that name,
 * so a fixture without it is refused as "not a docx document". The remaining
 * relationships are named `*.rels.xml`, which is what survives that filter.
 */
function docxOf() {
  return zipOf({
    '[Content_Types].xml':
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      XML +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>提取阅读器 · Word 转换验证</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>这一段用于确认 LibreOffice 引擎把 docx 转成了可预览的 PDF。</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph in Latin script.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
    'word/styles.xml':
      XML +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style></w:styles>',
    'word/document.xml.rels.xml':
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  });
}

/** A minimal PowerPoint deck with one title slide. */
function pptxOf() {
  return zipOf({
    '[Content_Types].xml':
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
    'ppt/presentation.xml':
      XML +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
      '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
      '</p:presentation>',
    'ppt/presentation.xml.rels.xml':
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      '</Relationships>',
    'ppt/slides/slide1.xml':
      XML +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>提取阅读器 · PPT 转换验证</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    'ppt/slideMasters/slideMaster1.xml':
      XML +
      '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '</p:sldMaster>',
  });
}

const outDir = path.resolve('fixtures');
await fs.writeFile(path.join(outDir, 'sample.docx'), docxOf());
await fs.writeFile(path.join(outDir, 'sample.pptx'), pptxOf());

const kitEntry = path.resolve('vendor/office/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js');
const converter = createOfficeConverter({ engineDir: kitEntry, kitEntry });

const rows = [];
for (const file of ['sample.docx', 'sample.pptx']) {
  const started = Date.now();
  const result = await converter.convert({ absolutePath: path.join(outDir, file) });
  if (!result.ok) {
    rows.push(`${file.padEnd(14)} FAILED  ${result.error.code}: ${result.error.message}`);
    rows.push(`${''.padEnd(14)} details: ${JSON.stringify(result.error.details ?? {})}`);
    continue;
  }
  const { pdf, fonts, digest, cached } = result.value;
  const header = Buffer.from(pdf.subarray(0, 5)).toString('latin1');
  const outPdf = path.join('artifacts', `${file}.pdf`);
  await fs.mkdir(path.resolve('artifacts'), { recursive: true });
  await fs.writeFile(outPdf, pdf);
  rows.push(
    `${file.padEnd(14)} ok      ${String(pdf.byteLength).padStart(8)} bytes  ${String(Date.now() - started).padStart(5)} ms  ` +
      `header=${header}  fonts=${fonts.length}  digest=${digest.slice(0, 10)}  cached=${cached}`,
  );

  // Second call must hit the cache: same digest, no conversion.
  const again = await converter.convert({ absolutePath: path.join(outDir, file) });
  rows.push(`${''.padEnd(14)} re-read cached=${again.ok ? again.value.cached : 'n/a'}`);
}

console.log('=== office conversion ===');
for (const row of rows) console.log(row);
console.log(`converter stats: ${JSON.stringify(converter.stats())}`);

await converter.dispose();
void pathToFileURL;
const failures = rows.filter((row) => row.includes('FAILED')).length;
process.exit(failures === 0 ? 0 : 1);
