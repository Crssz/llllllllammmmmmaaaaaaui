// Local bridge: HTTP <-> codegraph MCP (stdio JSON-RPC).
// Run:  node scripts/codegraph-ui-server.mjs
// Then open http://localhost:7421
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, normalize, sep, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const HTML_PATH = resolve(here, 'codegraph-ui.html');
const PORT = Number(process.env.PORT || 7421);

// ---------- MCP child process ----------
let child;
let stdoutBuf = '';
const pending = new Map();
let nextId = 1;
let initPromise = null;
let tools = null;

function startMcp() {
  child = spawn('codegraph', ['serve', '--mcp'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let i;
    while ((i = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? rj(msg.error) : rs(msg.result);
        }
      } catch (e) {
        console.error('[mcp parse]', e.message, line.slice(0, 200));
      }
    }
  });
  child.stderr.on('data', (c) => process.stderr.write('[mcp] ' + c));
  child.on('exit', (code) => {
    console.error(`[mcp] child exited code=${code} — restarting in 1s`);
    pending.forEach(({ reject }) => reject({ message: 'mcp child died' }));
    pending.clear();
    initPromise = null;
    tools = null;
    setTimeout(startMcp, 1000);
  });
}

function send(method, params) {
  const id = nextId++;
  return new Promise((rs, rj) => {
    pending.set(id, { resolve: rs, reject: rj });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codegraph-ui-bridge', version: '0.1' },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const r = await send('tools/list', {});
    tools = r.tools;
  })();
  return initPromise;
}

// ---------- HTTP server ----------
function send404(res, msg = 'not found') {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(msg);
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((rs, rj) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        rs(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        rj(e);
      }
    });
    req.on('error', rj);
  });
}

function safeJoin(rel) {
  const target = normalize(resolve(projectRoot, rel));
  if (!target.startsWith(projectRoot + sep) && target !== projectRoot) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(HTML_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      await ensureInit();
      return sendJson(res, 200, { tools, projectRoot });
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      await ensureInit();
      const body = await readBody(req);
      const t0 = Date.now();
      try {
        const result = await send('tools/call', {
          name: body.name,
          arguments: body.arguments || {},
        });
        return sendJson(res, 200, { ok: true, elapsedMs: Date.now() - t0, result });
      } catch (err) {
        return sendJson(res, 200, { ok: false, elapsedMs: Date.now() - t0, error: err });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/source') {
      const rel = url.searchParams.get('path') || '';
      const start = Math.max(1, parseInt(url.searchParams.get('start') || '1', 10));
      const end = parseInt(url.searchParams.get('end') || String(start + 40), 10);
      const target = safeJoin(rel);
      if (!target) return send404(res, 'bad path');
      try {
        const s = await stat(target);
        if (!s.isFile()) return send404(res, 'not a file');
        const src = await readFile(target, 'utf8');
        const lines = src.split(/\r?\n/);
        const slice = lines.slice(start - 1, end).join('\n');
        return sendJson(res, 200, {
          path: rel,
          start,
          end: Math.min(end, lines.length),
          total: lines.length,
          source: slice,
          ext: extname(target),
        });
      } catch (e) {
        return send404(res, e.message);
      }
    }
    send404(res);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message });
  }
});

startMcp();
server.listen(PORT, () => {
  console.log(`\n  codegraph-ui  →  http://localhost:${PORT}`);
  console.log(`  project root  →  ${projectRoot}`);
  console.log(`  ctrl-c to exit\n`);
});

process.on('SIGINT', () => {
  child && child.kill();
  process.exit(0);
});
