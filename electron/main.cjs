// ReelForge Desktop: the web app in a native window, with project files on disk, FFmpeg for import and sound,
// and AI CLIs on this PC (Claude Code, Codex, Antigravity, Gemini) driving the same video tools over MCP.
const { app, BrowserWindow, protocol, ipcMain, shell, dialog, powerSaveBlocker, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const media = require('./media.cjs');
const engine = require('./engine.cjs');
const store = require('./store.cjs');
const engines = require('./engines.cjs');
const { startMcpServer } = require('./mcp-server.cjs');

const DEV_URL = process.env.RF_DEV_URL || '';
const DIST = path.join(__dirname, '..', 'dist');
const BRIDGE = path.join(__dirname, 'mcp-bridge.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const ORIGIN = 'app://reelforge';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: true } }]);

// Tests run with their own data and project folders, so they never touch the person's videos.
if (process.env.RF_USER_DATA) app.setPath('userData', process.env.RF_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let mcp = null;
let ROOT = '';
const DISCOVERY = () => path.join(app.getPath('userData'), 'mcp-endpoint.json');

// ---------- project files on disk ----------
const ID = /^[A-Za-z0-9_-]{1,64}$/;
function projectDir(id) {
  if (!ID.test(String(id))) throw new Error('Bad project id.');
  return path.join(ROOT, id);
}
function projectPath(id, rel) {
  const dir = projectDir(id);
  const clean = String(rel).replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
  const full = path.resolve(dir, clean);
  if (!clean || !full.startsWith(dir + path.sep)) throw new Error('That path is outside the project.');
  return full;
}

async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.part.mp4') || e.name.endsWith('.part.m4a')) continue; // app's own working files
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac',
};

/** Streams a file, with byte ranges so video seeks without loading the whole clip. */
async function serveFile(file, req) {
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    return new Response('Not found', { status: 404, headers: { 'access-control-allow-origin': '*' } });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (range && stat.size > 0) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(stat.size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${stat.size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(stream, { status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${stat.size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'content-length': String(stat.size) } });
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname);
    try {
      if (p.startsWith('/__files/')) {
        const [id, ...rest] = p.slice('/__files/'.length).split('/');
        return await serveFile(projectPath(id, rest.join('/')), req);
      }
      const file = path.resolve(DIST, `.${p === '/' ? '/index.html' : p}`);
      if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
      return await serveFile(file, req);
    } catch (err) {
      return new Response(String(err && err.message), { status: 400 });
    }
  });
}

// ---------- AI CLI jobs ----------
const jobs = new Map(); // jobId -> { projectId, dir, engine, proc }
const calls = new Map(); // callId -> resolve
let blocker = null;

function keepAwake() {
  const busy = jobs.size > 0;
  if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

function resolveJob(ctx) {
  if (ctx.job && jobs.has(ctx.job)) return { id: ctx.job, ...jobs.get(ctx.job) };
  const cwd = path.resolve(ctx.cwd || '.').toLowerCase();
  for (const [id, j] of jobs) if (cwd === j.dir.toLowerCase() || cwd.startsWith(j.dir.toLowerCase() + path.sep)) return { id, ...j };
  // Antigravity may start its servers from another folder; with one job running, it's that one.
  if (jobs.size === 1) {
    const [[id, j]] = jobs;
    return { id, ...j };
  }
  return null;
}

let mcpTools = [];

function callRenderer(job, name, args) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ isError: true, content: [{ type: 'text', text: 'ReelForge window is closed.' }] });
    const callId = crypto.randomUUID();
    calls.set(callId, resolve);
    win.webContents.send('mcp:call', { callId, jobId: job.id, projectId: job.projectId, name, args });
  });
}

function failPendingCalls(text) {
  for (const [, resolve] of calls) resolve({ isError: true, content: [{ type: 'text', text }] });
  calls.clear();
}

function stopAllJobs() {
  for (const [, j] of jobs) j.proc && j.proc.kill();
  jobs.clear();
  keepAwake();
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0c12',
    title: 'ReelForge',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // renders keep full speed when the window is in the background
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  // The page asks before closing while a video is working.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep working', 'Quit anyway'], defaultId: 0, cancelId: 0, title: 'ReelForge', message: 'A video is still being made.', detail: 'Quitting stops it. You can press Continue later.' });
    if (choice === 1) e.preventDefault();
  });
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      failPendingCalls('The ReelForge window reloaded.');
      stopAllJobs();
    }
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  win.loadURL(DEV_URL || `${ORIGIN}/index.html`);
}

// ---------- IPC ----------
function ipc() {
  ipcMain.handle('app:info', async () => ({ root: ROOT, version: app.getVersion(), media: await media.info(), engine: await engine.version().catch((err) => ({ error: err.message })) }));

  ipcMain.handle('fs:put', async (_e, id, rel, data) => {
    const file = projectPath(id, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, Buffer.from(data));
    await fsp.rename(tmp, file);
  });
  ipcMain.handle('fs:list', async (_e, id) => (await listFiles(projectDir(id))).sort());
  ipcMain.handle('fs:exists', async (_e, id, rel) => {
    try {
      return (await fsp.stat(projectPath(id, rel))).isFile();
    } catch {
      return false;
    }
  });
  ipcMain.handle('fs:deleteAll', async (_e, id) => {
    await fsp.rm(projectDir(id), { recursive: true, force: true });
  });
  ipcMain.handle('fs:reveal', async (_e, id, rel) => {
    if (rel) shell.showItemInFolder(projectPath(id, rel));
    else {
      await fsp.mkdir(projectDir(id), { recursive: true });
      await shell.openPath(projectDir(id));
    }
  });
  ipcMain.handle('fs:open', async (_e, id, rel) => shell.openPath(projectPath(id, rel)));
  ipcMain.handle('fs:saveAs', async (_e, id, rel, suggested) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('videos'), suggested), filters: [{ name: 'Video', extensions: ['mp4'] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.copyFile(projectPath(id, rel), r.filePath);
    return r.filePath;
  });

  ipcMain.handle('fs:import', async (e, id, src, name) => {
    const dir = path.join(projectDir(id), 'input');
    return media.importFile(src, dir, name, (p) => e.sender.send('import:progress', { id, name, ...p }));
  });
  ipcMain.handle('media:audio', async (_e, id, rel) => {
    const src = projectPath(id, rel);
    const out = await media.extractAudio(src, path.join(projectDir(id), '.cache', `${rel.replace(/[\\/]/g, '_')}.m4a`));
    return out ? path.relative(projectDir(id), out).split(path.sep).join('/') : null;
  });

  // The native C++ engine: multi-track composition, sound analysis, probing.
  ipcMain.handle('engine:compose', (e, id, job) => engine.compose(projectDir(id), (rel) => projectPath(id, rel), job, (fraction) => !e.sender.isDestroyed() && e.sender.send('engine:progress', { id, fraction })));
  ipcMain.handle('engine:waveform', (_e, id, rel, points) => engine.waveform(projectPath(id, rel), points));
  ipcMain.handle('engine:probe', (_e, id, rel) => engine.probe(projectPath(id, rel)));

  // Project database (SQLite).
  ipcMain.handle('kv:get', (_e, key) => store.kv.get(key));
  ipcMain.handle('kv:set', (_e, key, value) => store.kv.set(key, value));
  ipcMain.handle('kv:del', (_e, key) => store.kv.del(key));
  ipcMain.handle('kv:values', (_e, prefix) => store.kv.values(prefix));
  ipcMain.handle('kv:count', () => store.kv.count());
  ipcMain.handle('kv:import', (_e, entries) => store.kv.importAll(entries));
  ipcMain.handle('history:add', (_e, id, label, projectJson, indexHtml) => store.history.add(id, label, projectJson, indexHtml));
  ipcMain.handle('history:list', (_e, id) => store.history.list(id));
  ipcMain.handle('history:get', (_e, hid) => store.history.get(hid));
  ipcMain.handle('history:drop', (_e, id) => store.history.drop(id));

  ipcMain.handle('engines:detect', () => engines.detect());

  ipcMain.handle('mcp:setTools', (_e, tools) => {
    mcpTools = tools;
  });
  ipcMain.on('mcp:result', (_e, callId, result) => {
    const resolve = calls.get(callId);
    if (resolve) {
      calls.delete(callId);
      resolve(result);
    }
  });

  ipcMain.handle('agent:start', async (e, job) => {
    const dir = projectDir(job.projectId);
    await fsp.mkdir(path.join(dir, '.reelforge'), { recursive: true });
    let systemFile = null;
    if (job.system) {
      systemFile = path.join(dir, '.reelforge', 'system.md');
      await fsp.writeFile(systemFile, job.system);
    }
    if (job.engine === 'agy') await engines.registerAgy(BRIDGE, DISCOVERY());
    // Engines without a system prompt flag get the manual at the top of the first message.
    const prompt = job.system && job.engine !== 'claude' ? `${job.system}\n\n---\n\n${job.prompt}` : job.prompt;
    const entry = { projectId: job.projectId, dir, engine: job.engine, proc: null };
    jobs.set(job.jobId, entry);
    keepAwake();
    const send = (ev) => !e.sender.isDestroyed() && e.sender.send('agent:event', { jobId: job.jobId, ...ev });
    try {
      entry.proc = engines.runTurn(
        {
          engine: job.engine,
          cwd: dir,
          prompt,
          systemFile,
          session: job.session || null,
          model: job.model || '',
          effort: job.effort || '',
          mcp: { command: process.execPath, args: [BRIDGE], env: { ELECTRON_RUN_AS_NODE: '1', RF_ENDPOINT: mcp.url, RF_TOKEN: mcp.token, RF_JOB: job.jobId } },
        },
        send,
      );
      await entry.proc.done;
    } catch (err) {
      send({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      jobs.delete(job.jobId);
      keepAwake();
      send({ type: 'exit' });
    }
  });
  ipcMain.handle('agent:stop', (_e, jobId) => {
    const j = jobs.get(jobId);
    if (j && j.proc) j.proc.kill();
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ROOT = process.env.RF_PROJECTS || path.join(app.getPath('videos'), 'ReelForge');
  store.open(app.getPath('userData'));
  await fsp.mkdir(ROOT, { recursive: true });
  // Electron's own Node runs the MCP bridge; make sure that path exists when packaged.
  registerProtocol();
  // Microphone, camera and the like are never needed.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  mcp = await startMcpServer({
    version: app.getVersion(),
    tools: () => mcpTools,
    resolveJob,
    call: (job, name, args) => callRenderer(job, name, args),
  });
  await fsp.writeFile(DISCOVERY(), JSON.stringify({ url: mcp.url, token: mcp.token }));
  ipc();
  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  failPendingCalls('ReelForge is closing.');
  stopAllJobs();
  if (mcp) mcp.close();
});
