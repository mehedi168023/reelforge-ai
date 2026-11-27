// The editor's live player. The footage plays in a <video>, the film page plays in its sealed frame on top, and
// the grade, camera and sound clips follow the same rules as the renderer, so what plays here is what exports.
import { desktop } from './desktop';
import { buildPage, cameraAt, loadConfig, readFile, readMedia, shakeAt, type ProjectConfig } from './render';

export interface Layer {
  label: string;
  start: number;
  end: number;
}

const FRAME_URL = () => new URL('frame.html', document.baseURI).href;

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
  private clip = document.createElement('div');
  private video = document.createElement('video');
  private tint = document.createElement('div');
  private vignette = document.createElement('div');
  private frame = document.createElement('iframe');
  private audio: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing_: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private startPerf = 0;
  private startT = 0;
  private raf = 0;
  private videoUrl: string | null = null;
  private pageReady: Promise<void> | null = null;
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
    this.clip.className = 'pv-clip';
    this.video.className = 'pv-video';
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.tint.className = 'pv-tint';
    this.vignette.className = 'pv-vignette';
    this.frame.className = 'pv-page';
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.tabIndex = -1;
    this.clip.append(this.video, this.tint, this.vignette, this.frame);
    this.stage.append(this.clip);
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

  /** Loads project.json and the page. Without project.json there is nothing to play yet. */
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
    for (const el of [this.video, this.frame]) {
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    }
    // Let the player show its box now, so the page is laid out when it's asked what's on screen.
    this.changed(true);
    await this.loadFootage();
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

  /** project.json changed (grade, camera, sound): no need to reload the page or the footage. */
  async reloadConfig(): Promise<void> {
    const footage = this.config?.footage;
    try {
      this.config = await loadConfig(this.projectId);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.changed(true);
      return;
    }
    this.error = null;
    if (this.config.footage !== footage) await this.loadFootage();
    this.applyLook();
    if (this.playing) this.play();
    else this.seek(Math.min(this.time, this.duration));
    this.changed(true);
  }

  private async loadFootage() {
    if (this.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = null;
    const footage = this.config?.footage;
    if (!footage) {
      this.video.removeAttribute('src');
      this.video.style.display = 'none';
      return;
    }
    const media = await readMedia(this.projectId, footage);
    if (!media) return;
    this.videoUrl = media instanceof Blob ? URL.createObjectURL(media) : media.url;
    this.video.style.display = '';
    this.video.src = this.videoUrl;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.video.addEventListener('loadeddata', done, { once: true });
      this.video.addEventListener('error', done, { once: true });
      setTimeout(done, 8000);
    });
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
    this.clip.append(this.frame);
    this.pageReady = (async () => {
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
    return this.pageReady;
  }

  private async askLayers(): Promise<Layer[]> {
    // The page can only say what's visible once the player is on screen and laid out.
    for (let i = 0; i < 50 && !this.stage.isConnected; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), 5000);
      this.waits.set(id, (d) => {
        clearTimeout(timer);
        resolve((d.layers as Layer[]).filter((l) => l.end > l.start));
      });
      this.frame.contentWindow?.postMessage({ type: 'layers', id }, '*');
    });
  }

  private live(play: boolean, t: number) {
    this.frame.contentWindow?.postMessage({ type: 'live', play, t }, '*');
  }

  /** Grade as CSS on the footage: the same brightness/contrast/saturation, soft-light tint and vignette as the export. */
  private applyLook() {
    const g = this.config?.grade;
    this.video.style.filter = g ? `brightness(${g.brightness}) contrast(${g.contrast}) saturate(${g.saturation})` : '';
    this.tint.style.background = g?.tint ?? 'transparent';
    this.tint.style.opacity = g?.tint ? String(g.tintAmount) : '0';
    this.tint.style.display = this.config?.footage ? '' : 'none';
    this.vignette.style.background = g && g.vignette > 0 ? `radial-gradient(circle farthest-corner at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${g.vignette}) 100%)` : 'none';
  }

  /** Camera: the same crop the renderer draws, as a transform on the video. */
  private applyCamera(t: number) {
    const c = this.config;
    if (!c || !c.footage) return;
    const cam = cameraAt(c.camera, t);
    const shake = shakeAt(c.shakes, t, c.fps);
    const z = Math.max(cam.zoom, shake.dx || shake.dy ? 1.04 : 1);
    const W = c.width;
    const H = c.height;
    const sx = Math.min(W - W / z, Math.max(0, cam.x * W - W / z / 2 - shake.dx / z));
    const sy = Math.min(H - H / z, Math.max(0, cam.y * H - H / z / 2 - shake.dy / z));
    this.video.style.transform = `translate(${-sx * z}px, ${-sy * z}px) scale(${z})`;
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
  async clipLength(file: string): Promise<number | null> {
    if (/\.(mp4|m4v|mov|webm|mkv)$/i.test(file) && desktop) return null;
    return (await this.buffer(file))?.duration ?? null;
  }

  private stopSounds() {
    for (const s of this.playing_) {
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.playing_ = [];
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
      this.playing_.push(src);
    }
  }

  play() {
    if (!this.config) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.stopSounds();
    this.playing = true;
    this.startT = this.time;
    this.startPerf = performance.now();
    if (this.config.footage) {
      this.video.currentTime = this.time;
      void this.video.play().catch(() => undefined);
    }
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
      const now = performance.now();
      if (now - lastSync > 1000) {
        lastSync = now;
        if (this.config?.footage && !this.video.ended && Math.abs(this.video.currentTime - t) > 0.15) this.video.currentTime = t;
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
    this.video.pause();
    this.live(false, this.time);
    this.changed();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const c = this.config;
    this.time = Math.max(0, Math.min(t, c?.duration ?? 0));
    if (this.playing) {
      this.play();
      return;
    }
    if (c?.footage && Number.isFinite(this.time)) this.video.currentTime = Math.min(this.time, Math.max(0, (this.video.duration || Infinity) - 0.01));
    this.applyCamera(this.time);
    this.live(false, this.time);
    this.changed();
  }

  destroy() {
    this.pause();
    window.removeEventListener('message', this.listener);
    if (this.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(this.videoUrl);
    this.stage.remove();
    void this.audio?.close();
  }
}
