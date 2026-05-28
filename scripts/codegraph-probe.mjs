// One-shot: spawn codegraph MCP, list tools, then exit.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const child = spawn('codegraph', ['serve', '--mcp'], {
  cwd: resolve('.'),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: true,
});

let buf = '';
const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(msg.error) : resolve(msg.result);
      } else {
        console.error('NOTE: notification or unrouted:', msg.method || msg);
      }
    } catch (e) {
      console.error('parse err:', line.slice(0, 200), e.message);
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[mcp stderr] ' + c));
child.on('exit', (code) => console.error('mcp exited:', code));

function send(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codegraph-probe', version: '0.1' },
  });
  console.log('INIT:', JSON.stringify(init).slice(0, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await send('tools/list', {});
  console.log(`\n=== ${tools.tools.length} tools ===`);
  for (const t of tools.tools) {
    const params = Object.keys(t.inputSchema?.properties || {}).join(', ') || '(none)';
    console.log(`- ${t.name}(${params})`);
  }
  console.log('\n--- sample schema (codegraph_search) ---');
  const s = tools.tools.find((t) => t.name === 'codegraph_search');
  console.log(JSON.stringify(s, null, 2));

  console.log('\n--- sample call: codegraph_status ---');
  const r = await send('tools/call', { name: 'codegraph_status', arguments: {} });
  console.log(JSON.stringify(r).slice(0, 500));

  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e);
  child.kill();
  process.exit(1);
});
