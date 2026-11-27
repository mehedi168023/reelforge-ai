// AI CLIs installed on this PC: finds them, starts a headless run wired to ReelForge's MCP tools, and turns each
// CLI's own event stream into one simple shape for the app's feed.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const ENGINES = [
  { id: 'claude', name: 'Claude Code', bins: ['claude'], extra: [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(ROAMING, 'npm', 'claude.cmd')], install: 'npm i -g @anthropic-ai/claude-code, then run claude once to sign in' },
  { id: 'codex', name: 'Codex', bins: ['codex'], extra: [path.join(ROAMING, 'npm', 'codex.cmd')], install: 'npm i -g @openai/codex, then run codex once to sign in' },
  { id: 'agy', name: 'Antigravity', bins: ['agy', 'antigravity'], extra: [path.join(LOCAL, 'agy', 'bin', 'agy.exe')], install: 'Install the Antigravity CLI (agy), then run agy once to sign in' },
  { id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], extra: [path.join(ROAMING, 'npm', 'gemini.cmd')], install: 'npm i -g @google/gemini-cli, then run gemini once to sign in' },
];

const exists = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const out = [];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) if (exists(path.join(d, name + e))) out.push(path.join(d, name + e));
  }
  return out;
}

/** An npm .cmd shim can't be spawned without a shell, so run the script it points to with Node directly. */
function fromShim(cmdFile) {
  const text = fs.readFileSync(cmdFile, 'utf8');
  const m = /"%(?:~?dp0%?|dp0%)\\?([^"%]+\.(?:c?js|mjs))"/i.exec(text) || /%dp0%\\([^"\s]+\.(?:c?js|mjs))/i.exec(text);
  if (!m) return null;
  const script = path.join(path.dirname(cmdFile), m[1]);
  if (!exists(script)) return null;
  const node = onPath('node').find((p) => p.endsWith('.exe')) || null;
  // Without Node on the PC, Electron's own Node runs the script.
  return node ? { command: node, prefix: [script], env: {} } : { command: process.execPath, prefix: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function resolve(engine) {
  const candidates = [...engine.bins.flatMap(onPath), ...engine.extra.filter(exists)];
  for (const c of candidates) {
    if (/\.exe$/i.test(c) || (process.platform !== 'win32' && !/\.(cmd|bat)$/i.test(c))) return { command: c, prefix: [], env: {} };
  }
  for (const c of candidates) {
    if (/\.(cmd|bat)$/i.test(c)) {
      const r = fromShim(c);
      if (r) return r;
    }
  }
  return null;
}

const version = (r) =>
  new Promise((done) => {
    execFile(r.command, [...r.prefix, '--version'], { windowsHide: true, timeout: 20000, env: { ...process.env, ...r.env } }, (err, stdout) => done(err ? null : String(stdout).trim().split('\n')[0].slice(0, 60)));
  });

const resolved = new Map();

async function detect() {
  const list = await Promise.all(
    ENGINES.map(async (e) => {
      const r = resolve(e);
      if (r) resolved.set(e.id, r);
      return { id: e.id, name: e.name, installed: Boolean(r), path: r ? r.prefix[0] || r.command : null, version: r ? await version(r) : null, install: e.install };
    }),
  );
  return list;
}

function getRunner(id) {
  if (!resolved.has(id)) {
    const e = ENGINES.find((x) => x.id === id);
    const r = e && resolve(e);
    if (!r) throw new Error(`${e ? e.name : id} isn't installed on this PC.`);
    resolved.set(id, r);
  }
  return resolved.get(id);
}

const tomlStr = (s) => `'${String(s).replace(/'/g, '')}'`;
const EFFORT = { codex: { medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' } };

/** How Antigravity finds ReelForge: it keeps one global MCP list, so register the bridge there once per start. */
async function registerAgy(bridge, discoveryFile) {
  const r = getRunner('agy');
  const args = [...r.prefix, 'mcp', 'add', '-e', 'ELECTRON_RUN_AS_NODE=1', '-e', `RF_DISCOVERY_FILE=${discoveryFile}`, 'reelforge', process.execPath, bridge];
  await new Promise((done, fail) => execFile(r.command, args, { windowsHide: true, timeout: 30000, env: { ...process.env, ...r.env } }, (err, _o, stderr) => (err ? fail(new Error(String(stderr || err.message).trim())) : done())));
}

/**
 * Builds the command for one turn.
 * @param {{engine: string, cwd: string, prompt: string, systemFile: string|null, session: string|null, model: string, effort: string, mcp: {command: string, args: string[], env: Record<string,string>}}} job
 */
function command(job) {
  const r = getRunner(job.engine);
  const { mcp } = job;
  const env = { ...process.env, ...r.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  let args;
  let stdin = null;
  switch (job.engine) {
    case 'claude': {
      const config = { mcpServers: { reelforge: { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env } } };
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__reelforge,Read,Write,Edit,MultiEdit,Glob,Grep,WebSearch,WebFetch,TodoWrite', '--disallowedTools', 'Bash'];
      if (job.model) args.push('--model', job.model);
      if (job.effort) args.push('--effort', job.effort);
      if (job.session) args.push('--resume', job.session);
      else if (job.systemFile) args.push('--append-system-prompt-file', job.systemFile);
      stdin = job.prompt;
      env.MCP_TOOL_TIMEOUT = '3600000';
      env.MCP_TIMEOUT = '60000';
      break;
    }
    case 'codex': {
      const envToml = `{${Object.entries(mcp.env).map(([k, v]) => `${k}=${tomlStr(v)}`).join(',')}}`;
      args = [
        'exec', '--json', '--skip-git-repo-check',
        '-c', 'approval_policy="never"',
        '-c', 'sandbox_mode="workspace-write"',
        '-c', `mcp_servers.reelforge.command=${tomlStr(mcp.command)}`,
        '-c', `mcp_servers.reelforge.args=[${mcp.args.map(tomlStr).join(',')}]`,
        '-c', `mcp_servers.reelforge.env=${envToml}`,
        '-c', 'mcp_servers.reelforge.tool_timeout_sec=3600',
        '-c', 'mcp_servers.reelforge.startup_timeout_sec=60',
        '-c', 'mcp_servers.reelforge.default_tools_approval_mode="approve"',
      ];
      if (job.model) args.push('-m', job.model);
      if (EFFORT.codex[job.effort]) args.push('-c', `model_reasoning_effort="${EFFORT.codex[job.effort]}"`);
      if (job.session) args.push('resume', job.session, '-');
      else args.push('-');
      stdin = job.prompt;
      break;
    }
    case 'agy': {
      // Antigravity takes the prompt as an argument; a long one goes through a file to stay under Windows' limit.
      let prompt = job.prompt;
      if (prompt.length > 24000) {
        const f = path.join(job.cwd, '.reelforge', 'prompt.md');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, prompt);
        prompt = 'Read the file .reelforge/prompt.md in this folder now. It is your full brief and operating manual. Follow it.';
      }
      args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
      if (job.model) args.push('--model', job.model);
      if (job.effort) args.push('--effort', job.effort);
      if (job.session) args.push('--conversation', job.session);
      break;
    }
    case 'gemini': {
      // Gemini reads MCP servers from the workspace settings file.
      const dir = path.join(job.cwd, '.gemini');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers: { reelforge: { command: mcp.command, args: mcp.args, env: mcp.env, timeout: 3600000, trust: true } } }, null, 2));
      args = ['-p', job.prompt.length > 24000 ? 'Read the file .reelforge/prompt.md in this folder now. It is your full brief. Follow it.' : job.prompt, '--output-format', 'stream-json', '--yolo'];
      if (job.prompt.length > 24000) {
        fs.mkdirSync(path.join(job.cwd, '.reelforge'), { recursive: true });
        fs.writeFileSync(path.join(job.cwd, '.reelforge', 'prompt.md'), job.prompt);
      }
      if (job.model) args.push('-m', job.model);
      if (job.session) args.push('--resume', job.session);
      break;
    }
    default:
      throw new Error(`Unknown engine ${job.engine}`);
  }
  return { command: r.command, args: [...r.prefix, ...args], env, stdin };
}

const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
const NATIVE_TOOL = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing', Glob: 'Looking through files', Grep: 'Searching files', WebSearch: 'Searching the web', WebFetch: 'Reading a web page', TodoWrite: 'Planning',
  view_file: 'Reading', write_to_file: 'Writing', replace_file_content: 'Editing', multi_replace_file_content: 'Editing', list_dir: 'Looking through files', find_by_name: 'Looking through files', grep_search: 'Searching files', search_web: 'Searching the web', read_url_content: 'Reading a web page', run_command: 'Running a command',
  read_file: 'Reading', write_file: 'Writing', replace: 'Editing', list_directory: 'Looking through files', glob: 'Looking through files', search_file_content: 'Searching files', google_web_search: 'Searching the web', web_fetch: 'Reading a web page', run_shell_command: 'Running a command',
};
const isOurs = (name) => /reelforge/.test(String(name || ''));
const toolEvent = (name, input) => {
  const i = input || {};
  return { type: 'tool', text: NATIVE_TOOL[name] || `Using ${name}`, detail: base(i.file_path || i.path || i.Path || i.AbsolutePath || i.TargetFile || i.absolute_path || i.pattern || i.query || i.Query || i.url || i.command || i.CommandLine || '') };
};

/** One parser per CLI; each turns a JSON line into zero or more feed events. */
function parser(engine) {
  const pendingText = new Map();
  switch (engine) {
    case 'claude':
      return (o) => {
        const out = [];
        if (o.type === 'system' && o.subtype === 'init' && o.session_id) out.push({ type: 'session', id: o.session_id });
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content) && !o.parent_tool_use_id) {
          for (const b of o.message.content) {
            if (b.type === 'text' && b.text && b.text.trim()) out.push({ type: 'text', text: b.text });
            if (b.type === 'tool_use' && !isOurs(b.name) && b.name !== 'ToolSearch') out.push(toolEvent(b.name, b.input));
          }
        }
        if (o.type === 'result') {
          if (o.session_id) out.push({ type: 'session', id: o.session_id });
          if (o.is_error) out.push({ type: 'error', text: String(o.result || (o.errors && o.errors.join(' ')) || o.subtype || 'Claude Code stopped with an error.') });
          out.push({ type: 'result', ok: !o.is_error });
        }
        return out;
      };
    case 'codex':
      return (o) => {
        const out = [];
        const it = o.item || {};
        if (o.type === 'thread.started' && o.thread_id) out.push({ type: 'session', id: o.thread_id });
        if (o.type === 'item.completed' && it.type === 'agent_message' && it.text && it.text.trim()) out.push({ type: 'text', text: it.text });
        if (o.type === 'item.started' && it.type === 'command_execution') out.push({ type: 'tool', text: 'Running a command', detail: String(it.command || '').slice(0, 80) });
        if (o.type === 'item.completed' && it.type === 'file_change') out.push({ type: 'tool', text: 'Editing', detail: (it.changes || []).map((c) => base(c.path)).join(', ') });
        if (o.type === 'item.started' && it.type === 'web_search') out.push({ type: 'tool', text: 'Searching the web', detail: it.query || '' });
        if (o.type === 'item.started' && it.type === 'mcp_tool_call' && !isOurs(it.server)) out.push({ type: 'tool', text: `Using ${it.tool}` });
        if (o.type === 'turn.failed') out.push({ type: 'error', text: String((o.error && o.error.message) || 'Codex stopped with an error.') });
        if (o.type === 'error' && o.message && !/reconnecting/i.test(o.message)) out.push({ type: 'error', text: String(o.message) });
        if (o.type === 'turn.completed') out.push({ type: 'result', ok: true });
        return out;
      };
    case 'agy':
      return (o) => {
        const out = [];
        if (o.event === 'init' && o.conversation_id) out.push({ type: 'session', id: o.conversation_id });
        const s = o.step_update;
        if (s) {
          if (s.step_type === 'agent_response') {
            const key = s.step_index;
            const text = (pendingText.get(key) || '') + (s.text_delta || '');
            pendingText.set(key, text);
            if (s.state === 'DONE') {
              pendingText.delete(key);
              if (text.trim()) out.push({ type: 'text', text });
            } else if (text) out.push({ type: 'delta', text });
          }
          if (s.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name && s.tool_name !== 'call_mcp_tool') {
            const p = (s.tool_info && s.tool_info.parameters) || {};
            if (!/\.gemini[\\/]antigravity-cli[\\/]mcp/i.test(String(p.Path || ''))) out.push(toolEvent(s.tool_name, p));
          }
        }
        if (o.event === 'result' && o.result) {
          if (o.result.conversation_id) out.push({ type: 'session', id: o.result.conversation_id });
          const ok = o.result.status === 'SUCCESS';
          if (!ok) out.push({ type: 'error', text: String(o.result.error || o.result.response || `Antigravity stopped (${o.result.status}).`) });
          out.push({ type: 'result', ok });
        }
        return out;
      };
    case 'gemini':
    default:
      return (o) => {
        const out = [];
        if (o.type === 'init' && o.session_id) out.push({ type: 'session', id: o.session_id });
        const flush = () => {
          const t = pendingText.get('a') || '';
          pendingText.delete('a');
          if (t.trim()) out.push({ type: 'text', text: t });
        };
        if (o.type === 'message' && o.role === 'assistant') {
          if (o.delta) {
            pendingText.set('a', (pendingText.get('a') || '') + (o.content || ''));
            out.push({ type: 'delta', text: pendingText.get('a') });
          } else if (o.content) out.push({ type: 'text', text: o.content });
        }
        if (o.type === 'tool_use') {
          flush();
          if (!isOurs(o.tool_name)) out.push(toolEvent(o.tool_name, o.parameters));
        }
        if (o.type === 'error') out.push({ type: 'error', text: String(o.message || 'Gemini error') });
        if (o.type === 'result') {
          flush();
          const ok = o.status !== 'error';
          if (!ok) out.push({ type: 'error', text: String((o.error && o.error.message) || 'Gemini stopped with an error.') });
          out.push({ type: 'result', ok });
        }
        return out;
      };
  }
}

/**
 * Runs one turn and streams events. Resolves when the process exits.
 * @returns {{ kill: () => void, done: Promise<void> }}
 */
function runTurn(job, emit) {
  const cmd = command(job);
  const child = spawn(cmd.command, cmd.args, { cwd: job.cwd, env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const parse = parser(job.engine);
  let buf = '';
  let errTail = '';
  let sawResult = false;
  let sawError = false;
  const handle = (line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      return;
    }
    for (const e of parse(o)) {
      if (e.type === 'result') sawResult = true;
      if (e.type === 'error') sawError = true;
      emit(e);
    }
  };
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d) => {
    errTail = (errTail + d.toString('utf8')).slice(-3000);
  });
  if (cmd.stdin !== null) child.stdin.end(cmd.stdin, 'utf8');
  else child.stdin.end();
  let killed = false;
  const done = new Promise((resolveDone) => {
    child.on('error', (err) => {
      emit({ type: 'error', text: `Couldn't start ${job.engine}: ${err.message}` });
      resolveDone();
    });
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      if (!killed && !sawResult && !sawError && code !== 0) {
        const tail = errTail.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d{4}-\d\d-\d\dT.*(WARN|INFO|DEBUG)/.test(l)).slice(-4).join(' ');
        emit({ type: 'error', text: tail || `${job.engine} exited with code ${code}.` });
      }
      resolveDone();
    });
  });
  return {
    done,
    kill() {
      killed = true;
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      else child.kill('SIGTERM');
    },
  };
}

module.exports = { detect, runTurn, registerAgy, ENGINES };
