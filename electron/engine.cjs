// Runs rfengine.exe, ReelForge's native C++ media engine (native/engine), and reads its JSON-line replies.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

function enginePath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'engine', 'rfengine.exe') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, '..', 'native', 'engine', 'build', 'rfengine.exe');
  if (fs.existsSync(dev)) return dev;
  throw new Error('The native engine (rfengine.exe) is missing. Build it with: node native/build.mjs');
}

/** Runs one engine command. Progress lines go to onProgress; the final line is the result. */
function run(args, onProgress) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(enginePath(), args, { windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let buf = '';
    let result = null;
    let errTail = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof o.progress === 'number') onProgress && onProgress(o.progress);
        else result = o;
      }
    });
    child.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', () => {
      if (result && result.ok) resolve(result);
      else reject(new Error((result && result.error) || errTail.trim() || 'The native engine stopped unexpectedly.'));
    });
  });
}

/**
 * Flattens clips into one MP4 in the project's .cache, reusing an earlier one when nothing changed.
 * @param {string} dir project folder
 * @param {(rel: string) => string} resolve project path to absolute path
 */
async function compose(dir, resolve, job, onProgress) {
  const clips = await Promise.all(
    job.clips.map(async (c) => {
      const abs = resolve(c.file);
      const st = await fsp.stat(abs);
      return { ...c, path: abs, mtime: st.mtimeMs, size: st.size };
    }),
  );
  const key = crypto.createHash('sha1').update(JSON.stringify({ clips, w: job.width, h: job.height, fps: job.fps, d: job.duration, v: 1 })).digest('hex').slice(0, 16);
  const rel = `.cache/compose-${key}.mp4`;
  const out = path.join(dir, '.cache', `compose-${key}.mp4`);
  if (fs.existsSync(out)) return rel;
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const part = `${out}.part.mp4`;
  const jobFile = path.join(dir, '.cache', `compose-${key}.json`);
  await fsp.writeFile(jobFile, JSON.stringify({ width: job.width, height: job.height, fps: job.fps, duration: job.duration, out: part, clips }));
  try {
    await run(['compose', jobFile], onProgress);
    await fsp.rename(part, out);
  } finally {
    await fsp.rm(jobFile, { force: true });
    await fsp.rm(part, { force: true });
  }
  // Older flattened versions of this project are no longer needed.
  for (const f of await fsp.readdir(path.dirname(out))) {
    if (/^compose-[0-9a-f]{16}\.mp4$/.test(f) && f !== path.basename(out)) await fsp.rm(path.join(path.dirname(out), f), { force: true });
  }
  return rel;
}

const probe = (file) => run(['probe', file]);
const waveform = async (file, points) => (await run(['waveform', file, String(points)])).peaks;
const version = () => run(['version']);

module.exports = { compose, probe, waveform, version, enginePath };
