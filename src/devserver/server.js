/**
 * Development server: serves the shell and the host API over HTTP.
 *
 * This exists so the reader can be built and verified in a browser — including
 * headless verification — before any Electron packaging concerns appear. The
 * Electron main process reuses the same host API over IPC, so nothing here is
 * throwaway except the transport.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHostApi } from '../main/host-api.js';

const PORT = Number(process.env.DSH_VIEWER_PORT ?? 4321);
const workspaceRoot = path.resolve(process.argv[2] ?? process.env.DSH_VIEWER_ROOT ?? process.cwd());
const webRoot = path.resolve(process.argv[3] ?? 'dist/web');

const host = createHostApi({ workspaceRoot });

/** JSON response helper. */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Read a request body as JSON. */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Serve one built shell asset. */
async function serveAsset(res, relative) {
  const target = path.join(webRoot, relative);
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(target);
    if (target.endsWith('index.html')) {
      // The shell resolves relative paths against this root, so the page must
      // know it before its modules run.
      const html = data
        .toString('utf8')
        .replace('<div id="root">', `<script>globalThis.__DSH_VIEWER_ROOT__ = ${JSON.stringify(workspaceRoot)};</script>\n    <div id="root">`);
      const payload = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'content-type': host.mimeOf(target), 'content-length': payload.length, 'cache-control': 'no-store' });
      res.end(payload);
      return;
    }
    res.writeHead(200, {
      'content-type': host.mimeOf(target),
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${relative}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  try {
    if (url.pathname === '/api/host' && req.method === 'POST') {
      const body = await readJson(req);
      switch (body.op) {
        case 'page':
          return json(res, 200, await host.page(body.request));
        case 'bytes': {
          const result = await host.bytes(body.request);
          if (!result.ok) return json(res, 200, result);
          // Bytes travel as base64 so the envelope stays JSON, exactly like the
          // reader's promise shape after decoding.
          return json(res, 200, {
            ok: true,
            value: {
              absolutePath: result.value.absolutePath,
              version: result.value.version,
              size: result.value.size,
              offset: result.value.offset,
              eof: result.value.eof,
              dataBase64: Buffer.from(result.value.data).toString('base64'),
            },
          });
        }
        case 'stat':
          return json(res, 200, await host.stat(body.request));
        case 'list':
          return json(res, 200, await host.list(body.request));
        default:
          return json(res, 400, { ok: false, error: { code: 'gateway/internal', message: `unknown op ${body.op}` } });
      }
    }

    // Raw file bytes for the browser's own consumers (images, HTML assets).
    if (url.pathname === '/api/file') {
      const requestPath = url.searchParams.get('path');
      const baseFile = url.searchParams.get('baseFile') ?? undefined;
      const raw = await host.raw({ path: requestPath, baseFile });
      if (raw === undefined) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': raw.type, 'content-length': raw.data.length, 'cache-control': 'no-store' });
      res.end(raw.data);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') return serveAsset(res, 'index.html');
    return serveAsset(res, url.pathname.replace(/^\//, ''));
  } catch (error) {
    json(res, 500, { ok: false, error: { code: 'gateway/internal', message: String(error?.message ?? error) } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-server] shell:    http://127.0.0.1:${PORT}/`);
  console.log(`[dev-server] workspace: ${workspaceRoot}`);
  console.log(`[dev-server] web root:  ${webRoot}`);
});
