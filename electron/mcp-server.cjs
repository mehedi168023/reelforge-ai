// The app's MCP endpoint on localhost. AI CLIs reach it through mcp-bridge.cjs; each tool call is
// answered by the renderer, which owns the render pipeline (page to frames, WebCodecs, the agent tools).
const http = require('node:http');
const crypto = require('node:crypto');

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

const INSTRUCTIONS =
  'ReelForge video tools. Use read_skill for know-how, snapshot to look at the composition, video_frames to watch footage, render to make the MP4, transcribe for word timings and generate_voice for voiceover. Project files are in the current folder.';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ version: string, tools: () => object[], resolveJob: (ctx: {job: string, cwd: string}) => any, call: (job: any, name: string, args: object) => Promise<{content: object[], isError?: boolean}> }} o
 */
function startMcpServer(o) {
  const token = crypto.randomBytes(24).toString('hex');

  async function handle(m, ctx) {
    if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const asked = m.params && m.params.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'reelforge', version: o.version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: o.tools() });
      case 'tools/call': {
        const job = o.resolveJob(ctx);
        if (!job) return ok({ isError: true, content: [{ type: 'text', text: 'No ReelForge job is running for this folder. Start it from the ReelForge app.' }] });
        const name = m.params && m.params.name;
        const args = (m.params && m.params.arguments) || {};
        try {
          const r = await o.call(job, name, args);
          return ok({ content: r.content, isError: Boolean(r.isError) });
        } catch (err) {
          return ok({ isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      if (obj === undefined) return res.writeHead(status).end();
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') return send(405);
    if (req.headers.authorization !== `Bearer ${token}`) return send(401);
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const ctx = { job: String(req.headers['x-rf-job'] || ''), cwd: decodeURIComponent(String(req.headers['x-rf-cwd'] || '')) };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => handle(m, ctx)))).filter(Boolean);
      return out.length ? send(200, out) : send(202);
    }
    const out = await handle(msg, ctx);
    return out ? send(200, out) : send(202);
  });
  // A render can take many minutes; never time the request out.
  server.requestTimeout = 0;
  server.timeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() });
    });
  });
}

module.exports = { startMcpServer };
