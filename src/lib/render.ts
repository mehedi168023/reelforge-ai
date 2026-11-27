import { ALL_FORMATS, AudioBufferSource, BlobSource, BufferTarget, CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { fileGet, fileList } from './db';

const runtimeUrl = (path: string) => new URL(`runtime/${path}`, document.baseURI).href;

/** A project's file, or one of the assets every project shares (gsap, the kit, fonts, sound effects). */
export async function readFile(projectId: string, path: string): Promise<Blob | undefined> {
  const own = await fileGet(projectId, path);
  if (own) return own;
  if (!path.startsWith('assets/')) return undefined;
  const res = await fetch(runtimeUrl(path.slice('assets/'.length)));
  const isPage = res.headers.get('content-type')?.includes('text/html');
  return res.ok && !isPage ? res.blob() : undefined;
}

export const SHARED_ASSETS = ['gsap.min.js', 'kit.js', 'reels.js','fonts/anek-bangla.woff2', 'fonts/hind-siliguri-600.woff2', ...['whoosh', 'whoosh-low', 'pop', 'pop-high', 'click', 'typing', 'coin', 'coin-high', 'impact-bass-1', 'impact-light', 'sparkle', 'ping', 'chime', 'notification', 'error', 'sonar', 'cheer', 'glitch-1', 'riser'].map((n) => `sfx/${n}.mp3`)].map((p) => `assets/${p}`);

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export const blobToBase64 = (blob: Blob) => blobToDataUrl(blob).then((u) => u.slice(u.indexOf(',') + 1));

const canvasToJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make an image."))), 'image/jpeg', 0.88));

// ---------- project.json ----------
export interface AudioClip {
  file: string;
  start: number;
  volume: number;
  trimStart: number;
}

/** A colour grade for the footage only. The page's overlays draw on top, ungraded. */
export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
  tint: string | null;
  tintAmount: number;
  vignette: number;
}

/** A camera move on the footage. "cut" jumps at t; "smooth" eases over dur; "push" drifts evenly over dur. */
export interface CameraKey {
  t: number;
  zoom: number;
  x: number;
  y: number;
  ease: 'cut' | 'smooth' | 'push';
  dur: number;
}

export interface ProjectConfig {
  width: number;
  height: number;
  fps: number;
  duration: number;
  footage: string | null;
  audio: AudioClip[];
  grade: Grade | null;
  camera: CameraKey[];
  shakes: { t: number; px: number }[];
}

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function parseGrade(g: unknown): Grade | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  const tint = typeof o.tint === 'string' && /^#[0-9a-f]{3,8}$/i.test(o.tint) ? o.tint : null;
  return {
    brightness: num(o.brightness, 1, 0.3, 2),
    contrast: num(o.contrast, 1, 0.3, 2),
    saturation: num(o.saturation, 1, 0, 2.5),
    tint,
    tintAmount: num(o.tintAmount, 0.15, 0, 1),
    vignette: num(o.vignette, 0, 0, 1),
  };
}

function parseCamera(list: unknown): { camera: CameraKey[]; shakes: { t: number; px: number }[] } {
  const camera: CameraKey[] = [];
  const shakes: { t: number; px: number }[] = [];
  for (const k of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    const t = num(k.t, 0, 0, 1800);
    if (k.shake !== undefined) {
      shakes.push({ t, px: num(k.shake, 12, 0, 80) });
      if (k.zoom === undefined) continue;
    }
    const ease = k.ease === 'cut' || k.ease === 'push' ? k.ease : 'smooth';
    camera.push({ t, zoom: num(k.zoom, 1, 1, 3), x: num(k.x, 0.5, 0, 1), y: num(k.y, 0.5, 0, 1), ease, dur: num(k.dur, ease === 'push' ? 2 : 0.45, 0.05, 60) });
  }
  camera.sort((a, b) => a.t - b.t);
  shakes.sort((a, b) => a.t - b.t);
  return { camera, shakes };
}

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** Where the camera is at time t: zoom, and the point of the frame it centres on. */
function cameraAt(keys: CameraKey[], t: number) {
  let state = { zoom: 1, x: 0.5, y: 0.5 };
  for (const k of keys) {
    if (k.t > t) break;
    const p = k.ease === 'cut' ? 1 : Math.min(1, (t - k.t) / k.dur);
    const e = k.ease === 'push' ? p : easeInOut(p);
    state = { zoom: state.zoom + (k.zoom - state.zoom) * e, x: state.x + (k.x - state.x) * e, y: state.y + (k.y - state.y) * e };
  }
  return state;
}

/** A three-frame jolt that dies away, in output pixels. */
function shakeAt(shakes: { t: number; px: number }[], t: number, fps: number) {
  for (const s of shakes) {
    const f = Math.floor((t - s.t) * fps + 1e-6);
    if (f >= 0 && f < 4) {
      const k = [1, -0.7, 0.35, 0][f];
      return { dx: s.px * k, dy: -s.px * 0.6 * k };
    }
  }
  return { dx: 0, dy: 0 };
}

/** The largest zoom the camera reaches, so the footage can be decoded sharp enough for it. */
export const maxZoom = (config: ProjectConfig) => Math.min(2, Math.max(1, ...config.camera.map((k) => k.zoom), config.shakes.length ? 1.04 : 1));

/**
 * Draws one footage frame into the output with the camera and grade applied. `frame` was decoded at
 * `scale` times the output size, so zooming in stays sharp.
 */
function drawFootage(ctx: CanvasRenderingContext2D, frame: HTMLCanvasElement | OffscreenCanvas, t: number, config: ProjectConfig, width: number, height: number) {
  const cam = cameraAt(config.camera, t);
  const shake = shakeAt(config.shakes, t, config.fps);
  // A shake needs a little headroom so the edges never show.
  const zoom = Math.max(cam.zoom, shake.dx || shake.dy ? 1.04 : 1);
  const fw = frame.width;
  const fh = frame.height;
  const sw = fw / zoom;
  const sh = fh / zoom;
  const kx = fw / width;
  const ky = fh / height;
  const sx = Math.min(fw - sw, Math.max(0, cam.x * fw - sw / 2 - shake.dx * kx / zoom));
  const sy = Math.min(fh - sh, Math.max(0, cam.y * fh - sh / 2 - shake.dy * ky / zoom));
  const g = config.grade;
  if (g) ctx.filter = `brightness(${g.brightness}) contrast(${g.contrast}) saturate(${g.saturation})`;
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, width, height);
  ctx.filter = 'none';
  if (!g) return;
  if (g.tint && g.tintAmount > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = g.tintAmount;
    ctx.fillStyle = g.tint;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
  if (g.vignette > 0) {
    const r = Math.hypot(width, height) / 2;
    const v = ctx.createRadialGradient(width / 2, height / 2, r * 0.45, width / 2, height / 2, r);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${g.vignette})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, width, height);
  }
}

export async function loadConfig(projectId: string): Promise<ProjectConfig> {
  const file = await fileGet(projectId, 'project.json');
  if (!file) throw new Error('project.json is missing.');
  const o = JSON.parse(await file.text());
  const width = Number(o.width);
  const height = Number(o.height);
  const fps = Number(o.fps ?? 30);
  const duration = Number(o.duration);
  if (!(duration > 0 && duration <= 1800)) throw new Error('duration must be between 0 and 1800 seconds.');
  if (!(fps >= 10 && fps <= 60) || !(width >= 240 && width <= 3840) || !(height >= 240 && height <= 3840)) throw new Error('width, height or fps is out of range.');
  const audio: AudioClip[] = (Array.isArray(o.audio) ? o.audio : []).map((a: Record<string, unknown>) => ({ file: String(a.file), start: Number(a.start ?? 0), volume: Number(a.volume ?? 1), trimStart: Number(a.trimStart ?? 0) }));
  const footage: string | null = o.footage ? String(o.footage) : null;
  for (const name of [...audio.map((a) => a.file), ...(footage ? [footage] : [])]) {
    if (!(await readFile(projectId, name))) throw new Error(`${name} doesn't exist.`);
  }
  return { width, height, fps, duration, footage, audio, grade: parseGrade(o.grade), ...parseCamera(o.camera) };
}

// ---------- the film page, in a sealed frame ----------
const BRIDGE = `<script>(function(){
  function send(m){parent.postMessage(m,'*')}
  var watcher=null,drawn=false;
  // Parts of the page that draw nothing and take no space are left out of the picture, so their images and shapes aren't decoded again every frame.
  var NS='http://www.w3.org/1999/xhtml';
  var SHARED='defs,linearGradient,radialGradient,clipPath,mask,filter,symbol,marker,pattern';
  function empty(e){
    var s=getComputedStyle(e);
    if(s.display!=='none'&&!(s.opacity==='0'&&(s.position==='absolute'||s.position==='fixed')))return false;
    return !e.matches(SHARED)&&!e.querySelector(SHARED);
  }
  function copy(from){
    var to=from.cloneNode(false);
    for(var n=from.firstChild;n;n=n.nextSibling){
      if(n.nodeType!==1){to.appendChild(n.cloneNode(false));continue}
      if(empty(n)){var gap=document.createElementNS(n.namespaceURI,n.localName);gap.setAttribute('style','display:none');to.appendChild(gap);continue}
      to.appendChild(n.namespaceURI===NS?copy(n):n.cloneNode(true));
    }
    return to;
  }
  function picture(){
    var root=document.documentElement.cloneNode(false);
    for(var n=document.documentElement.firstChild;n;n=n.nextSibling)root.appendChild(n===document.body?copy(n):n.cloneNode(true));
    return new XMLSerializer().serializeToString(root);
  }
  addEventListener('message',function(e){
    var d=e.data;if(e.source!==parent||!d||d.type!=='seek')return;
    try{
      window.__tl.seek(d.t,false);
      // Nothing moved since the last frame, so the last picture still holds.
      var same=drawn&&watcher.takeRecords().length===0;
      send({type:'frame',id:d.id,same:same,xml:same?'':picture(),err:window.__rfError||null});
      drawn=true;
      watcher.takeRecords();
    }catch(err){send({type:'frame',id:d.id,xml:'',err:String(err)})}
  });
  function ready(){
    var images=Array.prototype.map.call(document.images,function(i){return i.decode().catch(function(){})});
    Promise.all(images.concat(document.fonts.ready)).then(function(){
      document.querySelectorAll('script').forEach(function(s){s.remove()});
      watcher=new MutationObserver(function(){});
      watcher.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});
      send({type:'page-ready',hasTimeline:!!(window.__tl&&window.__tl.seek),err:window.__rfError||null});
    });
  }
  if(document.readyState==='complete')ready();else addEventListener('load',ready);
})();<\/script>`;

/** A copy no larger than the film and usually far smaller on disk. Every frame carries the image, so its size sets the render's speed. */
async function fitImage(blob: Blob, maxSide: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return blob;
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * k), height: Math.round(bitmap.height * k) });
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const smaller = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  return smaller && smaller.type === 'image/webp' && smaller.size < blob.size ? smaller : blob;
}

async function replaceAsync(text: string, pattern: RegExp, make: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: (string | Promise<string>)[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parts.push(text.slice(last, m.index), make(m as unknown as RegExpExecArray));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join('');
}

/** Puts scripts, fonts and images inside the page, because the sealed frame can't load anything. */
async function buildPage(projectId: string, config: ProjectConfig): Promise<string> {
  const file = await fileGet(projectId, 'index.html');
  if (!file) throw new Error('index.html is missing.');
  const clean = (p: string) => p.replace(/^\.\//, '');
  let html = await file.text();
  html = await replaceAsync(html, /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, async (m) => {
    const blob = await readFile(projectId, clean(m[1]));
    if (!blob) throw new Error(`index.html loads ${m[1]}, which doesn't exist.`);
    return `<script>${(await blob.text()).replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  const inlinedAssets = new Map<string, Promise<string>>();
  html = await replaceAsync(html, /(?:\.\/)?((?:assets|input)\/[^"'()<>\n]+?\.(?:woff2?|ttf|otf|png|jpe?g|webp|gif|svg))/giu, async (m) => {
    let inlined = inlinedAssets.get(m[1]);
    if (!inlined) {
      inlined = readFile(projectId, m[1]).then(async (blob) => {
        if (!blob) return m[0];
        const fitted = /\.(?:png|jpe?g|webp)$/i.test(m[1]) ? await fitImage(blob, Math.max(config.width, config.height)) : blob;
        return blobToDataUrl(fitted.type ? fitted : new Blob([fitted], { type: 'application/octet-stream' }));
      });
      inlinedAssets.set(m[1], inlined);
    }
    return inlined;
  });
  const base = `<style>html,body{margin:0;width:${config.width}px;height:${config.height}px;overflow:hidden}</style>`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + base) : base + html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${BRIDGE}</body>`) : html + BRIDGE;
}

/** Draws a film's page frame by frame by turning its live page into a picture. */
class FrameSource {
  private frame = document.createElement('iframe');
  private nextId = 0;
  private waiting = new Map<number, (m: { xml: string; same?: boolean; err: string | null }) => void>();
  private onPageReady?: (m: { hasTimeline: boolean; err: string | null }) => void;
  private onFrameReady?: () => void;
  private lastXml = '';
  private image = new Image();

  constructor(private config: ProjectConfig) {}

  private listener = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow || !e.data) return;
    if (e.data.type === 'frame-ready') this.onFrameReady?.();
    if (e.data.type === 'page-ready') this.onPageReady?.(e.data);
    if (e.data.type === 'frame') {
      this.waiting.get(e.data.id)?.(e.data);
      this.waiting.delete(e.data.id);
    }
  };

  async open(html: string): Promise<void> {
    const { width, height } = this.config;
    // allow-scripts without allow-same-origin: the page has no origin, so it can't touch stored keys.
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.tabIndex = -1;
    this.frame.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none`;
    window.addEventListener('message', this.listener);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The page stopped responding while loading.')), 30000);
      this.onFrameReady = () => this.frame.contentWindow?.postMessage({ type: 'load', html }, '*');
      this.onPageReady = (m) => {
        clearTimeout(timer);
        if (m.err) reject(new Error(`Page error: ${m.err}`));
        else if (!m.hasTimeline) reject(new Error('The page must set window.__tl to a paused GSAP timeline.'));
        else resolve();
      };
    });
    this.frame.src = new URL('frame.html', document.baseURI).href;
    document.body.append(this.frame);
    await opened;
  }

  /** The page at this moment, as an image. Identical moments reuse the last picture. */
  async at(seconds: number): Promise<HTMLImageElement> {
    const id = ++this.nextId;
    const reply = await new Promise<{ xml: string; same?: boolean; err: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The page stopped responding.')), 30000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.frame.contentWindow?.postMessage({ type: 'seek', id, t: seconds }, '*');
    });
    if (reply.err) throw new Error(`Page error: ${reply.err}`);
    if (!reply.same && reply.xml !== this.lastXml) {
      const { width, height } = this.config;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${reply.xml}</foreignObject></svg>`;
      const next = new Image();
      next.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      try {
        await next.decode();
      } catch {
        throw new Error("This page can't be drawn. Check that its HTML is well formed and doesn't load outside files.");
      }
      this.image = next;
      this.lastXml = reply.xml;
    }
    return this.image;
  }

  close(): void {
    window.removeEventListener('message', this.listener);
    this.frame.remove();
  }
}

// ---------- footage ----------
async function openFootage(blob: Blob, width: number, height: number) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('The footage has no video track.');
  if (!(await track.canDecode())) throw new Error("This browser can't decode this video's format.");
  // Cover, not fill: footage of another shape is cropped rather than stretched.
  return { input, sink: new CanvasSink(track, { width, height, fit: 'cover', poolSize: 2 }) };
}

export interface MediaInfo {
  durationSec: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function mediaInfo(blob: Blob): Promise<MediaInfo> {
  let info: MediaInfo;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const [video, audio, durationSec] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.computeDuration()]);
    info = { durationSec, width: video?.displayWidth ?? null, height: video?.displayHeight ?? null, hasVideo: Boolean(video), hasAudio: Boolean(audio) };
  } catch {
    throw new Error("This file can't be read as video or audio.");
  } finally {
    input.dispose();
  }
  return info;
}

/** JPEG frames from a video file at the given times. */
export async function videoFrames(blob: Blob, times: number[]): Promise<Blob[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video.');
    if (!(await track.canDecode())) throw new Error("This browser can't decode this video's format.");
    const k = Math.min(1, 960 / Math.max(track.displayWidth, track.displayHeight));
    const width = Math.max(2, Math.round(track.displayWidth * k));
    const height = Math.max(2, Math.round(track.displayHeight * k));
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 1 });
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d')!;
    const out: Blob[] = [];
    for (const t of times) {
      const frame = await sink.getCanvas(t);
      if (!frame) throw new Error(`No frame at ${t}s.`);
      ctx.drawImage(frame.canvas, 0, 0);
      out.push(await canvasToJpeg(canvas));
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** A smaller copy of an image, for the agent to look at. */
export async function imageView(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error("That image can't be read.");
  });
  const k = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * k), height: Math.round(bitmap.height * k) });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToJpeg(canvas);
}

// ---------- review frames ----------
export async function snapshots(projectId: string, times: number[]): Promise<Blob[]> {
  const config = await loadConfig(projectId);
  const source = new FrameSource(config);
  let footageInput: Input | undefined;
  try {
    await source.open(await buildPage(projectId, config));
    const k = 960 / Math.max(config.width, config.height);
    const width = Math.round(config.width * k);
    const height = Math.round(config.height * k);
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d')!;
    const z = maxZoom(config);
    const opened = config.footage ? await openFootage((await readFile(projectId, config.footage))!, Math.round(width * z), Math.round(height * z)) : null;
    footageInput = opened?.input;
    const footage = opened?.sink;
    const out: Blob[] = [];
    for (const t of times) {
      ctx.fillStyle = footage ? '#000' : '#fff';
      ctx.fillRect(0, 0, width, height);
      const under = await footage?.getCanvas(t);
      if (under) drawFootage(ctx, under.canvas, t, config, width, height);
      ctx.drawImage(await source.at(t), 0, 0, width, height);
      out.push(await canvasToJpeg(canvas));
    }
    return out;
  } finally {
    footageInput?.dispose();
    source.close();
  }
}

// ---------- sound ----------
const RATE = 48000;

async function mixAudio(projectId: string, config: ProjectConfig): Promise<AudioBuffer | null> {
  const clips = [...config.audio];
  if (config.footage) clips.unshift({ file: config.footage, start: 0, volume: 1, trimStart: 0 });
  if (!clips.length) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(config.duration * RATE), RATE);
  let any = false;
  for (const clip of clips) {
    const blob = (await readFile(projectId, clip.file))!;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      // Footage with no sound is normal; an audio file that can't be decoded is a real problem.
      if (clip.file === config.footage) continue;
      throw new Error(`${clip.file} can't be decoded as audio.`);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clip.volume;
    source.connect(gain).connect(ctx.destination);
    source.start(clip.start, clip.trimStart);
    any = true;
  }
  if (!any) return null;
  const mixed = await ctx.startRendering();
  let peak = 0;
  for (let c = 0; c < mixed.numberOfChannels; c++) {
    for (const v of mixed.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  }
  if (peak > 0.97) {
    const k = 0.97 / peak; // never clip
    for (let c = 0; c < mixed.numberOfChannels; c++) {
      const data = mixed.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= k;
    }
  }
  return mixed;
}

// ---------- the finished video ----------
export interface RenderProgress {
  stage: 'audio' | 'frames' | 'finishing';
  done: number;
  total: number;
  startedAt: number;
}

export class RenderStopped extends Error {}

export async function renderVideo(projectId: string, shortSide: number, signal: AbortSignal, onProgress: (p: RenderProgress) => void): Promise<Blob> {
  const startedAt = Date.now();
  onProgress({ stage: 'audio', done: 0, total: 1, startedAt });
  const config = await loadConfig(projectId);
  const k = Math.min(1, shortSide / Math.min(config.width, config.height));
  const width = Math.round((config.width * k) / 2) * 2;
  const height = Math.round((config.height * k) / 2) * 2;
  const codec = (await canEncodeVideo('avc', { width, height })) ? 'avc' : (await canEncodeVideo('vp9', { width, height })) ? 'vp9' : null;
  if (!codec) throw new Error("This browser can't encode video. Use a current version of Chrome or Edge.");

  const audio = await mixAudio(projectId, config);
  const source = new FrameSource(config);
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  let footage: AsyncIterator<Awaited<ReturnType<CanvasSink['getCanvas']>>> | undefined;
  let footageInput: Input | undefined;
  try {
    await source.open(await buildPage(projectId, config));
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const video = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: config.fps });
    let audioSource: AudioBufferSource | null = null;
    if (audio) {
      const audioCodec = (await canEncodeAudio('aac')) ? 'aac' : 'opus';
      audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
      output.addAudioTrack(audioSource);
    }
    await output.start();
    // Not awaited here: the file writer interleaves tracks, so audio can wait on video's progress.
    const audioDone = audio && audioSource ? audioSource.add(audio).then(() => audioSource!.close()) : Promise.resolve();

    const total = Math.round(config.duration * config.fps);
    const timestamps = Array.from({ length: total }, (_, i) => i / config.fps);
    const z = maxZoom(config);
    // Decoded larger when the camera zooms in, so a punch-in stays sharp. Kept even for the decoder.
    const opened = config.footage ? await openFootage((await readFile(projectId, config.footage))!, Math.round((width * z) / 2) * 2, Math.round((height * z) / 2) * 2) : null;
    footageInput = opened?.input;
    footage = opened?.sink.canvasesAtTimestamps(timestamps)[Symbol.asyncIterator]();
    let lastPaint = 0;
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new RenderStopped();
      ctx.fillStyle = footage ? '#000' : '#fff';
      ctx.fillRect(0, 0, width, height);
      const under = await footage?.next();
      if (under && !under.done && under.value) drawFootage(ctx, under.value.canvas, timestamps[i], config, width, height);
      ctx.drawImage(await source.at(timestamps[i]), 0, 0, width, height);
      await video.add(timestamps[i], 1 / config.fps);
      if (Date.now() - lastPaint > 200) {
        lastPaint = Date.now();
        onProgress({ stage: 'frames', done: i + 1, total, startedAt });
      }
    }
    onProgress({ stage: 'finishing', done: total, total, startedAt });
    video.close();
    await audioDone;
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (err) {
    if (output.state === 'started') await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    await footage?.return?.(undefined).catch(() => undefined);
    footageInput?.dispose();
    source.close();
  }
}

/** Whether this browser can do the page-to-picture step and encode video at all. */
export async function browserProblem(): Promise<string | null> {
  if (!('VideoEncoder' in window)) return "This browser can't make videos. Use a current version of Chrome or Edge.";
  try {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><foreignObject width="4" height="4"><div xmlns="http://www.w3.org/1999/xhtml">a</div></foreignObject></svg>')}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 4 });
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    canvas.toDataURL();
    return null;
  } catch {
    return "This browser can't draw video frames. Use a current version of Chrome or Edge.";
  }
}

export { fileList };
