// The editor's live player. Each video clip plays in its own <video> on its track, the film page plays in its
// sealed frame on top, and the grade, camera and sound clips follow the renderer's rules, so what plays here is
// what exports.
import { buildPage, cameraAt, loadConfig, readFile, readMedia, shakeAt, type Clip, type ProjectConfig } from './render';

export interface Layer {
  label: string;
  start: number;
  end: number;
  /** The separate lines of text in this part, for editing. */
  texts: string[];
}

const FRAME_URL = () => new URL('frame.html', document.baseURI).href;

interface ClipView {
  clip: Clip;
  el: HTMLVideoElement;
  url: string;
  /** The source's own length, once known, to resolve an open-ended clip. */
  length: number;
}

/** Clips as the player uses them: the main file plays whole from 0 when there are none. */
export function clipsOf(c: ProjectConfig): Clip[] {
  if (c.clips.length) return c.clips;
  return c.footage ? [{ file: c.footage, track: 0, start: 0, in: 0, out: null, volume: 1, x: 0.5, y: 0.5, scale: 1 }] : [];
}

export class Preview {
  config: ProjectConfig | null = null;
  layers: Layer[] = [];
  time = 0;
  playing = false;
  error: string | null = null;
  /** Bumps on every change (time included); `shape` only when what's loaded changes. */
  version = 0;
  shape = 0;
  private subs = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getVersion = () => this.version;
  getShape = () => this.shape;

  readonly stage = document.createElement('div');
  private clipBox = document.createElement('div');
  private videos = document.createElement('div');
  private tint = document.createElement('div');
  private vignette = document.createElement('div');
  private frame = document.createElement('iframe');
  private views: ClipView[] = [];
  private urls = new Map<string, string>();
  private audio: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private sounds: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private startPerf = 0;
  private startT = 0;
  private raf = 0;
  private nextId = 0;
  private waits = new Map<number, (d: any) => void>();
  private listener = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow || !e.data) return;
    const d = e.data;
    if (d.type === 'frame-ready') this.onFrameReady?.();
    if (d.type === 'page-ready') this.onPageReady?.(d);
    if (d.type === 'layers') {
      this.waits.get(d.id)?.(d);
      this.waits.delete(d.id);
    }
  };
  private onFrameReady?: () => void;
  private onPageReady?: (d: { err: string | null; hasTimeline: boolean }) => void;

  constructor(private projectId: string) {
    this.stage.className = 'pv-stage';
    this.clipBox.className = 'pv-clip';
    this.videos.className = 'pv-videos';
    this.tint.className = 'pv-tint';
    this.vignette.className = 'pv-vignette';
    this.frame.className = 'pv-page';
    this.clipBox.append(this.videos, this.tint, this.vignette, this.frame);
    this.stage.append(this.clipBox);
    window.addEventListener('message', this.listener);
  }

  get duration() {
    return this.config?.duration ?? 0;
  }

  private changed(shape = false) {
    this.version++;
    if (shape) this.shape++;
    this.subs.forEach((f) => f());
  }

  /** Loads project.json, the clips and the page. Without project.json there is nothing to play yet. */
  async load(): Promise<void> {
    // Adding the same listener twice is a no-op; this revives a player React's StrictMode tore down once.
    window.addEventListener('message', this.listener);
    this.pause();
    this.error = null;
    try {
      this.config = await loadConfig(this.projectId);
    } catch (err) {
      this.config = null;
      this.error = err instanceof Error ? err.message : String(err);
      this.changed(true);
      return;
    }
    const { width, height } = this.config;
    this.stage.style.width = `${width}px`;
    this.stage.style.height = `${height}px`;
    this.videos.style.width = `${width}px`;
    this.videos.style.height = `${height}px`;
    // Let the player show its box now, so the page is laid out when it's asked what's on screen.
    this.changed(true);
    await this.loadClips();
    this.applyLook();
    try {
      await this.loadPage();
      this.layers = await this.askLayers();
    } catch (err) {
      this.layers = [];
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.time = Math.min(this.time, this.duration);
    this.seek(this.time);
    this.changed(true);
  }

  /** project.json changed (clips, grade, camera, sound): the page stays loaded. */
  async reloadConfig(): Promise<void> {
    try {
      this.config = await loadConfig(this.projectId);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.changed(true);
      return;
    }
    this.error = null;
    await this.loadClips();
    this.applyLook();
    if (this.playing) this.play();
    else this.seek(Math.min(this.time, this.duration));
    this.changed(true);
  }

  private async urlFor(file: string): Promise<string | null> {
    const known = this.urls.get(file);
    if (known) return known;
    const media = await readMedia(this.projectId, file);
    if (!media) return null;
    const url = media instanceof Blob ? URL.createObjectURL(media) : media.url;
    this.urls.set(file, url);
    return url;
  }

  /** One <video> per clip, reused when the same clip is still there. */
  private async loadClips() {
    const c = this.config!;
    const wanted = clipsOf(c);
    const old = this.views;
    const next: ClipView[] = [];
    for (const clip of wanted) {
      const url = await this.urlFor(clip.file);
      if (!url) continue;
      const reuse = old.findIndex((v) => v.url === url && !next.includes(v));
      let view: ClipView;
      if (reuse >= 0) {
        view = old[reuse];
        old.splice(reuse, 1);
        view.clip = clip;
      } else {
        const el = document.createElement('video');
        el.className = 'pv-video';
        el.playsInline = true;
        el.preload = 'auto';
        el.src = url;
        view = { clip, el, url, length: 0 };
        el.addEventListener('loadedmetadata', () => {
          view.length = el.duration || 0;
          this.changed(true);
        });
      }
      this.place(view);
      next.push(view);
    }
    for (const v of old) {
      v.el.pause();
      v.el.remove();
    }
    this.views = next;
    // Higher tracks on top; later clips on a track above earlier ones.
    this.views.forEach((v) => this.videos.append(v.el));
    await Promise.all(next.map((v) => (v.el.readyState >= 2 ? null : new Promise<void>((r) => {
      const done = () => r();
      v.el.addEventListener('loadeddata', done, { once: true });
      v.el.addEventListener('error', done, { once: true });
      setTimeout(done, 8000);
    }))));
  }

  private place(v: ClipView) {
    const { width: W, height: H } = this.config!;
    const k = v.clip;
    const w = W * k.scale;
    const h = H * k.scale;
    Object.assign(v.el.style, { width: `${w}px`, height: `${h}px`, left: `${k.scale < 1 ? k.x * W - w / 2 : 0}px`, top: `${k.scale < 1 ? k.y * H - h / 2 : 0}px`, zIndex: String(k.track + 1), borderRadius: k.scale < 1 ? '18px' : '0' });
    v.el.volume = Math.min(1, k.volume);
  }

  /** The length of a clip on the timeline, in seconds. */
  clipLength(clip: Clip): number {
    const v = this.views.find((x) => x.clip === clip);
    const total = v?.length || this.config?.duration || 0;
    return Math.max(0.04, (clip.out ?? total) - clip.in);
  }

  /** The source length of a file, if one of the clips has loaded it. */
  fileLength(file: string): number | null {
    return this.views.find((v) => v.clip.file === file && v.length)?.length ?? null;
  }

  private loadPage(): Promise<void> {
    const config = this.config!;
    this.frame.remove();
    this.frame = document.createElement('iframe');
    this.frame.className = 'pv-page';
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.tabIndex = -1;
    this.frame.style.width = `${config.width}px`;
    this.frame.style.height = `${config.height}px`;
    this.clipBox.append(this.frame);
    return (async () => {
      const html = await buildPage(this.projectId, config);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The page stopped responding while loading.')), 30000);
        this.onFrameReady = () => this.frame.contentWindow?.postMessage({ type: 'load', html }, '*');
        this.onPageReady = (m) => {
          clearTimeout(timer);
          if (m.err) reject(new Error(`Page error: ${m.err}`));
          else if (!m.hasTimeline) reject(new Error('The page must set window.__tl to a paused GSAP timeline.'));
          else resolve();
        };
        this.frame.src = FRAME_URL();
      });
    })();
  }

  private async askLayers(): Promise<Layer[]> {
    // The page can only say what's visible once the player is on screen and laid out.
    for (let i = 0; i < 50 && !this.stage.isConnected; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 8000);
      this.waits.set(id, (d) => {
        clearTimeout(timer);
        resolve((d.layers as Layer[]).filter((l) => l.end > l.start).map((l) => ({ ...l, texts: l.texts ?? [] })));
      });
      this.frame.contentWindow?.postMessage({ type: 'layers', id }, '*');
    });
  }

  private live(play: boolean, t: number) {
    this.frame.contentWindow?.postMessage({ type: 'live', play, t }, '*');
  }

  /** Grade as CSS on the video tracks: the same brightness/contrast/saturation, soft-light tint and vignette as the export. */
  private applyLook() {
    const g = this.config?.grade;
    this.videos.style.filter = g ? `brightness(${g.brightness}) contrast(${g.contrast}) saturate(${g.saturation})` : '';
    this.tint.style.background = g?.tint ?? 'transparent';
    this.tint.style.opacity = g?.tint ? String(g.tintAmount) : '0';
    this.tint.style.display = this.views.length ? '' : 'none';
    this.vignette.style.background = g && g.vignette > 0 ? `radial-gradient(circle farthest-corner at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${g.vignette}) 100%)` : 'none';
  }

  /** Camera: the same crop the renderer draws, as a transform on the composed tracks. */
  private applyCamera(t: number) {
    const c = this.config;
    if (!c) return;
    const cam = cameraAt(c.camera, t);
    const shake = shakeAt(c.shakes, t, c.fps);
    const z = Math.max(cam.zoom, shake.dx || shake.dy ? 1.04 : 1);
    const W = c.width;
    const H = c.height;
    const sx = Math.min(W - W / z, Math.max(0, cam.x * W - W / z / 2 - shake.dx / z));
    const sy = Math.min(H - H / z, Math.max(0, cam.y * H - H / z / 2 - shake.dy / z));
    this.videos.style.transform = `translate(${-sx * z}px, ${-sy * z}px) scale(${z})`;
  }

  /** Shows the clips under the playhead at their own source time; plays or pauses them with the player. */
  private syncClips(t: number, hard: boolean) {
    for (const v of this.views) {
      const len = this.clipLength(v.clip);
      const on = t >= v.clip.start - 1e-3 && t < v.clip.start + len;
      v.el.style.visibility = on ? 'visible' : 'hidden';
      const src = v.clip.in + (t - v.clip.start);
      if (!on) {
        if (!v.el.paused) v.el.pause();
        continue;
      }
      if (hard || Math.abs(v.el.currentTime - src) > (this.playing ? 0.2 : 0.01)) v.el.currentTime = Math.max(0, src);
      if (this.playing && v.el.paused) void v.el.play().catch(() => undefined);
      if (!this.playing && !v.el.paused) v.el.pause();
    }
  }

  private async buffer(file: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(file);
    if (!b) {
      b = (async () => {
        const blob = await readFile(this.projectId, file);
        if (!blob) return null;
        this.audio ??= new AudioContext();
        return this.audio.decodeAudioData(await blob.arrayBuffer()).catch(() => null);
      })();
      this.buffers.set(file, b);
    }
    return b;
  }

  /** Length of a sound clip, for the timeline. */
  async soundLength(file: string): Promise<number | null> {
    if (/\.(mp4|m4v|mov|webm|mkv)$/i.test(file)) return null;
    return (await this.buffer(file))?.duration ?? null;
  }

  private stopSounds() {
    for (const s of this.sounds) {
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.sounds = [];
  }

  private async startSounds() {
    const c = this.config;
    if (!c) return;
    this.audio ??= new AudioContext();
    await this.audio.resume();
    if (!this.gain) {
      this.gain = this.audio.createGain();
      this.gain.connect(this.audio.destination);
    }
    const startedAt = this.startPerf;
    for (const clip of c.audio) {
      if (clip.file === c.footage) continue;
      const buf = await this.buffer(clip.file);
      // Paused or restarted while the clip was decoding.
      if (!buf || !this.playing || this.startPerf !== startedAt) continue;
      const now = (performance.now() - this.startPerf) / 1000 + this.startT;
      const at = clip.start - now;
      const offset = clip.trimStart + Math.max(0, -at);
      if (offset >= buf.duration) continue;
      const src = this.audio.createBufferSource();
      src.buffer = buf;
      const g = this.audio.createGain();
      g.gain.value = clip.volume;
      src.connect(g).connect(this.gain);
      src.start(this.audio.currentTime + Math.max(0, at), offset);
      this.sounds.push(src);
    }
  }

  play() {
    if (!this.config) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.stopSounds();
    this.playing = true;
    this.startT = this.time;
    this.startPerf = performance.now();
    this.syncClips(this.time, true);
    this.live(true, this.time);
    void this.startSounds();
    cancelAnimationFrame(this.raf);
    let lastSync = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const t = this.startT + (performance.now() - this.startPerf) / 1000;
      if (t >= this.duration) {
        this.pause();
        this.seek(this.duration);
        return;
      }
      this.time = t;
      this.applyCamera(t);
      this.syncClips(t, false);
      const now = performance.now();
      if (now - lastSync > 1000) {
        lastSync = now;
        this.live(true, t);
      }
      this.changed();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.changed();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopSounds();
    this.views.forEach((v) => v.el.pause());
    this.live(false, this.time);
    this.changed();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.config?.duration ?? 0));
    if (this.playing) {
      this.play();
      return;
    }
    this.syncClips(this.time, false);
    this.applyCamera(this.time);
    this.live(false, this.time);
    this.changed();
  }

  /** Reloads only the film page, after its text changed. */
  async reloadPage(): Promise<void> {
    if (!this.config) return this.load();
    try {
      this.error = null;
      await this.loadPage();
      this.layers = await this.askLayers();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.seek(this.time);
    this.changed(true);
  }

  destroy() {
    this.pause();
    window.removeEventListener('message', this.listener);
    for (const u of this.urls.values()) if (u.startsWith('blob:')) URL.revokeObjectURL(u);
    this.urls.clear();
    this.views.forEach((v) => v.el.remove());
    this.views = [];
    this.stage.remove();
    void this.audio?.close();
    this.audio = null;
    this.gain = null;
    this.buffers.clear();
  }
}
