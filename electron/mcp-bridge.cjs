// Stdio MCP server that an AI CLI (Claude Code, Codex, Antigravity, Gemini) starts. It forwards every
// JSON-RPC line to the running ReelForge app over localhost, where the real video tools live.
// Runs under Electron's own Node (ELECTRON_RUN_AS_NODE=1), so the PC needs nothing else installed.
const http = require('node:http');
const fs = require('node:fs');
const readline = require('node:readline');

function endpoint() {
  if (process.env.RF_ENDPOINT) return { url: process.env.RF_ENDPOINT, token: process.env.RF_TOKEN || '' };
  // A CLI registered once (Antigravity keeps a global MCP list) finds the app's current port here.
  const file = process.env.RF_DISCOVERY_FILE;
  if (!file) throw new Error('RF_DISCOVERY_FILE is not set.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function post(body) {
  return new Promise((resolve, reject) => {
    const { url, token } = endpoint();
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'x-rf-job': process.env.RF_JOB || '',
        'x-rf-cwd': encodeURIComponent(process.cwd()),
      },
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

let pending = 0;
let closed = false;
const write = (obj) => process.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
const maybeExit = () => closed && pending === 0 && process.exit(0);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  pending++;
  try {
    const { status, text } = await post(line);
    if (status === 401) throw new Error('ReelForge restarted. Start the job again from the app.');
    if (text.trim()) write(text.trim());
  } catch (err) {
    if (msg && msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `ReelForge is not reachable: ${err.message}. Keep the ReelForge app open.` } });
  } finally {
    pending--;
    maybeExit();
  }
}).on('close', () => {
  closed = true;
  maybeExit();
});
