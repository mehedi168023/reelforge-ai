// FFmpeg layer: makes any footage the render pipeline can decode (HEVC, 10-bit, HDR, odd containers become
// H.264 8-bit with the GPU encoder when there is one), and pulls the soundtrack out so big clips never have to
// be decoded whole in memory.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const unpacked = (p) => p && p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const f = path.join(d, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      if (d && fs.statSync(f).isFile()) return f;
    } catch {
      // not here
    }
  }
  return null;
}

let bins = null;
/** A full FFmpeg on PATH has the most encoders; the bundled one is the fallback. */
function tools() {
  if (bins) return bins;
  let bundledFfmpeg = null;
  let bundledProbe = null;
  try {
    bundledFfmpeg = unpacked(require('ffmpeg-static'));
  } catch {
    // not bundled
  }
  try {
    bundledProbe = unpacked(require('ffprobe-static').path);
  } catch {
    // not bundled
  }
  const ok = (p) => p && fs.existsSync(p);
  const pathFfmpeg = which('ffmpeg');
  const pathProbe = which('ffprobe');
  bins = {
    ffmpeg: ok(pathFfmpeg) ? pathFfmpeg : ok(bundledFfmpeg) ? bundledFfmpeg : null,
    ffprobe: ok(pathProbe) ? pathProbe : ok(bundledProbe) ? bundledProbe : null,
  };
  return bins;
}

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });

async function probe(file) {
  const { ffprobe } = tools();
  if (!ffprobe) throw new Error('FFprobe is missing.');
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (r.code) throw new Error(`Can't read this file: ${r.stderr.trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}

const ENCODERS = {
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '20'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20'],
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
};

let encoderPick = null;
/** The fastest H.264 encoder that actually works on this PC (a listed GPU encoder can still fail without the card). */
function pickEncoder() {
  return (encoderPick ??= (async () => {
    const { ffmpeg } = tools();
    for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      const r = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2', '-pix_fmt', 'yuv420p', ...ENCODERS[name], '-f', 'null', '-'], { timeout: 20000 });
      if (r.code === 0) return name;
    }
    return 'libx264';
  })());
}

const SAFE_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_CONTAINERS = /mp4|mov|webm|matroska/;
const HDR = new Set(['smpte2084', 'arib-std-b67']);

/** What it takes to make this file work in the render pipeline, or null when it works as it is. */
function plan(info) {
  const v = (info.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) return null;
  const reasons = [];
  if (!SAFE_CODECS.has(v.codec_name)) reasons.push(String(v.codec_name).toUpperCase());
  if (/10|12/.test(v.pix_fmt || '') || /422|444/.test(v.pix_fmt || '')) reasons.push(v.pix_fmt);
  if (HDR.has(v.color_transfer)) reasons.push('HDR');
  if (!SAFE_CONTAINERS.test((info.format && info.format.format_name) || '')) reasons.push((info.format && info.format.format_name) || 'container');
  const long = Math.max(v.width || 0, v.height || 0);
  if (long > 3840) reasons.push(`${v.width}x${v.height}`);
  if (!reasons.length) return null;
  return { reasons, hdr: HDR.has(v.color_transfer), scale: long > 3840, duration: Number((info.format && info.format.duration) || v.duration || 0) };
}

function ffmpegWithProgress(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const { ffmpeg } = tools();
    const p = spawn(ffmpeg, ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / duration));
      }
    });
    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `FFmpeg failed (${code})`))));
  });
}

async function transcode(src, out, how, onProgress) {
  const tonemap = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
  const scale = "scale='if(gt(iw,ih),min(3840,iw),-2)':'if(gt(iw,ih),-2,min(3840,ih))':flags=lanczos";
  const attempt = async (encoder, withTonemap) => {
    const filters = [how.hdr && withTonemap ? tonemap : null, how.scale ? scale : null, 'format=yuv420p'].filter(Boolean).join(',');
    await ffmpegWithProgress(
      ['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', filters, ...ENCODERS[encoder], '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out],
      how.duration,
      onProgress,
    );
  };
  const encoder = await pickEncoder();
  const tries = [
    [encoder, true],
    [encoder, false],
    ['libx264', false],
  ];
  let last;
  for (const [enc, tm] of tries) {
    if (!how.hdr && tm === false && enc === encoder) continue; // same as the first try
    try {
      await attempt(enc, tm);
      return enc;
    } catch (err) {
      last = err;
      await fsp.rm(out, { force: true });
    }
  }
  throw last;
}

/**
 * Brings a file into the project. Footage the pipeline can't decode becomes H.264; everything else is copied.
 * @returns {Promise<{name: string, converted: string | null}>}
 */
async function importFile(src, destDir, name, onProgress) {
  await fsp.mkdir(destDir, { recursive: true });
  const isMedia = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mts|m2ts|ts|3gp|hevc|h265|mxf)$/i.test(name);
  let how = null;
  if (isMedia && tools().ffprobe) {
    try {
      how = plan(await probe(src));
    } catch {
      how = null; // can't probe: copy it and let the app report what it can't read
    }
  }
  if (!how || !tools().ffmpeg) {
    onProgress({ stage: 'copy', fraction: null });
    await fsp.copyFile(src, path.join(destDir, name));
    return { name, converted: null };
  }
  const outName = name.replace(/\.[^.]+$/, '') + '.mp4';
  const out = path.join(destDir, outName);
  const tmp = `${out}.part.mp4`;
  onProgress({ stage: 'convert', fraction: 0, reasons: how.reasons });
  const encoder = await transcode(src, tmp, how, (fraction) => onProgress({ stage: 'convert', fraction, reasons: how.reasons }));
  await fsp.rename(tmp, out);
  return { name: outName, converted: `${how.reasons.join(', ')} → H.264 (${encoder})` };
}

/** The soundtrack of a video as AAC, cached next to the project, or null when it has none. */
async function extractAudio(src, cacheFile) {
  try {
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(cacheFile)]);
    if (b.mtimeMs >= a.mtimeMs && b.size > 0) return cacheFile;
  } catch {
    // not cached yet
  }
  const info = await probe(src);
  if (!(info.streams || []).some((s) => s.codec_type === 'audio')) return null;
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.part.m4a`;
  const r = await run(tools().ffmpeg, ['-hide_banner', '-y', '-v', 'error', '-i', src, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', tmp]);
  if (r.code) throw new Error(`Can't read the sound: ${r.stderr.trim().split('\n').pop()}`);
  await fsp.rename(tmp, cacheFile);
  return cacheFile;
}

async function info() {
  const t = tools();
  return { ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, encoder: t.ffmpeg ? await pickEncoder() : null };
}

module.exports = { importFile, extractAudio, probe, info, tools };
