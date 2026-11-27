// The desktop editor: media and text on the left, a live player in the middle, AI and adjustments on the right,
// and a multi-track timeline below. Clip, camera, sound and look edits write project.json; text edits write the
// film page (index.html). The native engine flattens the clips at export.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { AgentController } from '../lib/agent';
import { fileGet, filePut } from '../lib/db';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { TEXT_COLORS, TEXT_STYLES, putUserText, removeUserText, replaceText, userTexts, type TextStyle, type UserText } from '../lib/pageEdit';
import { Preview, spansOf, type Layer } from '../lib/preview';
import { SHARED_ASSETS, TRANSITIONS, mediaInfo, readMedia, videoFrames, type TransitionType } from '../lib/render';
import { addInputFiles, deleteProject, settings, type ProjectMeta } from '../lib/store';
import { Logo, StatusPill } from '../ui';
import { Conversation, RenderBar, VideoPanel } from './Project';

type Raw = Record<string, any>;
type Selection = { kind: 'camera' | 'audio' | 'layer' | 'clip' | 'transition'; index: number } | { kind: 'text'; id: string } | null;
type EditRaw = (fn: (o: Raw) => void) => void;
type EditHtml = (fn: (html: string) => string | null) => Promise<boolean>;

const readText = async (id: string, path: string) => (await fileGet(id, path))?.text() ?? null;
const readRaw = async (id: string): Promise<Raw | null> => {
  const t = await readText(id, 'project.json');
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const writeRaw = (id: string, o: Raw) => filePut(id, 'project.json', new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));
const writeHtml = (id: string, html: string) => filePut(id, 'index.html', new Blob([html], { type: 'text/html' }));

const clock = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const isVideoFile = (f: string) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(f);
const isSoundFile = (f: string) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f);
const hasLetters = (s: string) => /\p{L}/u.test(s);

const SFX = SHARED_ASSETS.filter((a) => a.startsWith('assets/sfx/'));

const GRADE_PRESETS: Record<string, Raw | null> = {
  None: null,
  'Neon cool': { brightness: 0.94, contrast: 1.16, saturation: 0.88, tint: '#2a5cff', tintAmount: 0.12, vignette: 0.5 },
  Warm: { brightness: 1.0, contrast: 1.08, saturation: 1.05, tint: '#ff8a3d', tintAmount: 0.08, vignette: 0.3 },
  Punchy: { brightness: 1.02, contrast: 1.22, saturation: 1.1, tint: null, tintAmount: 0, vignette: 0.35 },
  Mono: { brightness: 1.0, contrast: 1.2, saturation: 0, tint: null, tintAmount: 0, vignette: 0.45 },
};

const askAi = (id: string, text: string) => dispatchEvent(new CustomEvent('rf-draft', { detail: { id, text } }));

/** Re-renders a component on every player tick (time, play state). */
const useTick = (p: Preview) => useSyncExternalStore(p.subscribe, p.getVersion);

// ---------- clips on tracks ----------
/** A clip's length on the timeline. An open end uses the source's length (or the project length until it's known). */
const clipLen = (c: Raw, p: Preview) => Math.max(0.04, ((c.out ?? p.fileLength(c.file) ?? p.duration) - (c.in ?? 0)) / (c.speed || 1));

/** Gives a project whose footage plays whole an explicit clip list, so it can be cut. */
function ensureClips(o: Raw, p: Preview) {
  if (Array.isArray(o.clips) && o.clips.length) return;
  o.clips = o.footage ? [{ file: o.footage, track: 0, start: 0, in: 0, out: r2(Math.min(p.fileLength(o.footage) ?? o.duration, o.duration)) }] : [];
  // The AI timed its captions to this footage playing whole: from now on they follow the footage's own time.
  if (o.footage && !o.captionSync) o.captionSync = { file: o.footage };
}

/** A short name for an edit, for the version history. */
function describe(before: Raw, after: Raw): string {
  const same = (k: string) => JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null);
  const bc: Raw[] = before.clips ?? [];
  const ac: Raw[] = after.clips ?? [];
  if (ac.length > bc.length) return bc.length && ac.length === bc.length + 1 && ac.some((c) => !bc.some((b) => b.file === c.file)) ? 'Add clip' : 'Split clip';
  if (ac.length < bc.length) return 'Delete clip';
  if (!same('clips')) {
    if (ac.some((c, i) => JSON.stringify(c.transition ?? null) !== JSON.stringify(bc[i]?.transition ?? null))) return 'Transition';
    if (ac.some((c, i) => (c.speed ?? 1) !== (bc[i]?.speed ?? 1))) return 'Speed';
    return 'Trim or move clip';
  }
  if (!same('grade')) return 'Look';
  if (!same('camera')) return 'Camera';
  if (!same('audio')) return 'Sound';
  return 'Edit';
}

const TRANSITION_LABEL: Record<TransitionType, string> = { dissolve: 'Dissolve', black: 'Dip to black', slide: 'Slide', wipe: 'Wipe', zoom: 'Zoom in' };

/** Where the footage the captions follow sits on the timeline: [timeline start, end, source start, speed]. */
function syncSegments(o: Raw, p: Preview): { a: number; b: number; src: number; k: number }[] {
  const file = o.captionSync?.file;
  if (!file || !Array.isArray(o.clips)) return [];
  const main = o.clips.filter((c: Raw) => (c.track ?? 0) === 0).sort((x: Raw, y: Raw) => (x.start ?? 0) - (y.start ?? 0));
  const out: { a: number; b: number; src: number; k: number }[] = [];
  main.forEach((c: Raw, i: number) => {
    if (c.file !== file) return;
    const next = main[i + 1];
    out.push({ a: c.start ?? 0, b: Math.min((c.start ?? 0) + clipLen(c, p), next ? next.start ?? 0 : Infinity), src: c.in ?? 0, k: c.speed || 1 });
  });
  return out;
}

/**
 * After the main footage is cut, trimmed, reordered or sped up, camera moves and sounds placed on it move with
 * it (or go, if their moment was cut out), just as the AI's captions do.
 */
function followFootage(before: Raw, after: Raw, p: Preview) {
  if (!after.captionSync) return;
  const oldSegs = syncSegments(before, p);
  const newSegs = syncSegments(after, p);
  if (!oldSegs.length || JSON.stringify(oldSegs) === JSON.stringify(newSegs)) return;
  const move = (t: number): number | null => {
    const g = oldSegs.find((x) => t >= x.a - 1e-3 && t < x.b - 1e-3);
    if (!g) return t; // not over that footage: stays where it is
    const src = g.src + (t - g.a) * g.k;
    const n = newSegs.find((x) => src >= x.src - 1e-3 && src < x.src + (x.b - x.a) * x.k - 1e-3);
    return n ? r2(n.a + (src - n.src) / n.k) : null;
  };
  if (Array.isArray(after.camera)) after.camera = after.camera.flatMap((k: Raw) => {
    const t = move(Number(k.t) || 0);
    return t === null ? [] : [{ ...k, t }];
  });
  if (Array.isArray(after.audio)) after.audio = after.audio.flatMap((a: Raw) => {
    const t = move(Number(a.start) || 0);
    return t === null ? [] : [{ ...a, start: t }];
  });
}

/** The main track is magnetic, like other editors: its clips butt together from 0. Then the project ends where the last clip does. */
function settle(o: Raw, p: Preview) {
  const clips: Raw[] = o.clips ?? [];
  const main = clips.filter((c) => (c.track ?? 0) === 0).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let t = 0;
  main.forEach((c, i) => {
    // A transition overlaps this clip with the one before it.
    if (i > 0 && c.transition) t -= Math.min(c.transition.dur ?? 0.5, clipLen(c, p) / 2, clipLen(main[i - 1], p) / 2);
    else if (i === 0) delete c.transition;
    c.start = r2(Math.max(0, t));
    c.track = 0;
    t = c.start + clipLen(c, p);
  });
  if (main.length) o.footage = main[0].file;
  const end = Math.max(0, ...clips.map((c) => (c.start ?? 0) + clipLen(c, p)));
  if (end > 0) o.duration = r2(end);
}

// ---------- small pieces ----------
function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const I = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  back: 'M15 18l-6-6 6-6',
  start: 'M6 5v14M18 6l-9 6 9 6z',
  end: 'M18 5v14M6 6l9 6-9 6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  export: 'M12 15V3M7 8l5-5 5 5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  cam: 'M15 10l5-3v10l-5-3M3 7h12v10H3z',
  split: 'M12 3v18M6 8l-3 4 3 4M18 8l3 4-3 4',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
};

function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: [T, string][] }) {
  return (
    <div className="ed-tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={`ed-tab ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, disabled, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean; format?: (v: number) => string }) {
  return (
    <label className="ed-slider">
      <span className="ed-slider-head">
        <span>{label}</span>
        <span className="ed-num">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// ---------- media thumbnails ----------
function MediaThumb({ projectId, path }: { projectId: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const isVideo = isVideoFile(path);
  const isImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(path);
  useEffect(() => {
    let made: string | null = null;
    if (desktop) setUrl(desktop.fileUrl(projectId, path));
    else if (isImage || isVideo)
      void fileGet(projectId, path).then((b) => {
        if (b) setUrl((made = URL.createObjectURL(b)));
      });
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [projectId, path, isImage, isVideo]);
  if (url && isVideo) return <video className="ed-thumb" src={`${url}#t=0.5`} muted preload="metadata" />;
  if (url && isImage) return <img className="ed-thumb" src={url} alt="" />;
  return <span className="ed-thumb ph">{isSoundFile(path) ? '♪' : '◆'}</span>;
}

/** A few frames across a clip, drawn once per file and range. */
const stripCache = new Map<string, Promise<string[]>>();
function ClipStrip({ projectId, file, from, to }: { projectId: string; file: string; from: number; to: number }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const key = `${projectId}|${file}|${from.toFixed(2)}|${to.toFixed(2)}`;
    let job = stripCache.get(key);
    if (!job) {
      job = (async () => {
        const media = await readMedia(projectId, file);
        if (!media) return [];
        const n = 6;
        const times = Array.from({ length: n }, (_, i) => from + ((to - from) / n) * (i + 0.5));
        const frames = await videoFrames(media, times).catch(() => []);
        return frames.map((f) => URL.createObjectURL(f));
      })();
      stripCache.set(key, job);
    }
    void job.then((u) => live && setUrls(u));
    return () => {
      live = false;
    };
  }, [projectId, file, from, to]);
  return (
    <div className="tl-strip">
      {urls.map((u, i) => (
        <img key={i} src={u} alt="" draggable={false} />
      ))}
    </div>
  );
}

/** A sound's waveform from the native engine, as an SVG drawn to fill its clip. */
const waveCache = new Map<string, Promise<number[]>>();
function Wave({ projectId, file }: { projectId: string; file: string }) {
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    const key = `${projectId}|${file}`;
    let job = waveCache.get(key);
    if (!job) {
      job = file.startsWith('assets/') ? Promise.resolve([]) : desktop.waveform(projectId, file, 160).catch(() => []);
      waveCache.set(key, job);
    }
    void job.then((pk) => live && setPeaks(pk));
    return () => {
      live = false;
    };
  }, [projectId, file]);
  if (!peaks.length) return null;
  const d = peaks.map((v, i) => `M${i} ${10 - v * 9}V${10 + v * 9}`).join('');
  return (
    <svg className="tl-wave" viewBox={`0 0 ${peaks.length} 20`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// ---------- the timeline ----------
function lanes(layers: { start: number; end: number }[], max = 3) {
  const ends: number[] = [];
  return layers.map((l) => {
    let lane = ends.findIndex((e) => e <= l.start + 0.01);
    if (lane < 0) lane = ends.length < max ? ends.length : ends.indexOf(Math.min(...ends));
    ends[lane] = l.end;
    return lane;
  });
}

function Playhead({ p, pps }: { p: Preview; pps: number }) {
  useTick(p);
  return <div className="tl-playhead" style={{ transform: `translateX(${p.time * pps}px)` }} />;
}

type Drag =
  | { kind: 'camera' | 'audio'; index: number; t: number }
  | { kind: 'clip'; index: number; mode: 'move' | 'in' | 'out'; start: number; in: number; out: number; track: number };

const ROW_VIDEO = 54;

function Timeline(props: { p: Preview; raw: Raw | null; locked: boolean; selection: Selection; select: (s: Selection) => void; edit: EditRaw; projectId: string; texts: UserText[]; onSplit: () => void; onDelete: () => void; onAddText: () => void }) {
  const { p, raw, locked, selection, select, edit, projectId, texts } = props;
  useSyncExternalStore(p.subscribe, p.getShape);
  const duration = p.duration;
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [lengths, setLengths] = useState<Record<string, number | null>>({});

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 120));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pps = Math.max(8, ((width - 40) / Math.max(1, duration)) * zoom);
  const camera: Raw[] = Array.isArray(raw?.camera) ? raw!.camera : [];
  const audio: Raw[] = Array.isArray(raw?.audio) ? raw!.audio : [];
  const explicit = Array.isArray(raw?.clips) && raw!.clips.length > 0;
  const clips: Raw[] = explicit ? raw!.clips : raw?.footage ? [{ file: raw.footage, track: 0, start: 0, in: 0, out: null }] : [];
  const topTrack = Math.max(0, ...clips.map((c) => c.track ?? 0));
  const videoTracks = Array.from({ length: topTrack + 2 }, (_, i) => topTrack + 1 - i); // an empty one on top to drop onto

  // Lengths of the sound clips, from the player's decoded audio.
  useEffect(() => {
    let live = true;
    for (const a of audio) {
      if (a.file in lengths) continue;
      void p.soundLength(a.file).then((len) => live && setLengths((m) => ({ ...m, [a.file]: len })));
    }
    return () => {
      live = false;
    };
  }, [audio, lengths, p]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - 120;
    return Math.max(0, x / pps);
  };

  const scrub = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('.tl-item')) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    p.seek(Math.min(duration, timeAt(e.clientX)));
    const move = (ev: PointerEvent) => p.seek(Math.min(duration, timeAt(ev.clientX)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const follow = (e: RPointerEvent, onMove: (ev: PointerEvent) => void, onUp: () => void) => {
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // not a live pointer (e.g. a synthetic event); dragging still follows moves over the element
    }
    const up = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      onUp();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
  };

  const dragKey = (e: RPointerEvent, kind: 'camera' | 'audio', index: number, t0: number) => {
    e.stopPropagation();
    select({ kind, index });
    if (locked) return;
    const grab = timeAt(e.clientX) - t0;
    let t = t0;
    let moved = false;
    follow(
      e,
      (ev) => {
        t = Math.max(0, r2(timeAt(ev.clientX) - grab));
        moved = true;
        setDrag({ kind, index, t });
      },
      () => {
        setDrag(null);
        if (moved)
          edit((o) => {
            if (kind === 'camera') o.camera[index].t = t;
            else o.audio[index].start = t;
          });
      },
    );
  };

  const dragClip = (e: RPointerEvent, index: number) => {
    e.stopPropagation();
    select({ kind: 'clip', index });
    if (locked) return;
    const c = clips[index];
    const len = clipLen(c, p);
    const sp = c.speed || 1;
    const source = p.fileLength(c.file) ?? (c.in ?? 0) + len * sp;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    const mode: 'move' | 'in' | 'out' = x < 8 ? 'in' : x > box.width - 8 ? 'out' : 'move';
    const s0 = c.start ?? 0;
    const in0 = c.in ?? 0;
    const out0 = in0 + len * sp;
    const t0 = timeAt(e.clientX);
    const y0 = e.clientY;
    const track0 = c.track ?? 0;
    let state: Extract<Drag, { kind: 'clip' }> = { kind: 'clip', index, mode, start: s0, in: in0, out: out0, track: track0 };
    let moved = false;
    follow(
      e,
      (ev) => {
        const dt = timeAt(ev.clientX) - t0;
        moved = true;
        if (mode === 'move') {
          const track = Math.max(0, Math.min(topTrack + 1, track0 + Math.round((y0 - ev.clientY) / ROW_VIDEO)));
          state = { ...state, start: Math.max(0, r2(s0 + dt)), track };
        } else if (mode === 'in') {
          const d = Math.max(-in0 / sp, Math.min(dt, len - 0.1));
          state = { ...state, in: r2(in0 + d * sp), start: r2(Math.max(0, s0 + d)) };
        } else {
          state = { ...state, out: r2(Math.max(in0 + 0.1, Math.min(source, out0 + dt * sp))) };
        }
        setDrag(state);
      },
      () => {
        setDrag(null);
        if (!moved) return;
        const s = state;
        edit((o) => {
          ensureClips(o, p);
          const k = o.clips[index];
          if (s.mode === 'move' && k.track === 0 && s.track === 0) {
            // Reorder on the magnetic main track: drop where its middle lands.
            const mid = s.start + len / 2;
            const others = o.clips.filter((x: Raw) => x !== k && (x.track ?? 0) === 0);
            const before = others.filter((x: Raw) => (x.start ?? 0) + clipLen(x, p) / 2 < mid).length;
            o.clips = [...o.clips.filter((x: Raw) => (x.track ?? 0) !== 0)];
            others.splice(before, 0, k);
            let t = 0;
            for (const x of others) {
              x.start = t;
              t += clipLen(x, p);
            }
            o.clips.push(...others);
          } else {
            k.start = s.start;
            k.in = s.in;
            k.out = s.out;
            k.track = s.track;
          }
          settle(o, p);
          select({ kind: 'clip', index: o.clips.indexOf(k) });
        });
      },
    );
  };

  const step = pps > 160 ? 0.5 : pps > 60 ? 1 : pps > 25 ? 2 : 5;
  const ticks = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);
  // The AI's parts follow the footage (one bar per stretch that survives the cuts); the person's captions stay put.
  type Bar = { label: string; start: number; end: number; layer?: number; user?: UserText };
  const bars: Bar[] = [];
  p.layers.forEach((l, i) => spansOf(p.config?.map ?? null, l.start, l.end).forEach(([a, b]) => bars.push({ label: l.label, start: a, end: b, layer: i })));
  texts.forEach((u) => bars.push({ label: u.text, start: u.t, end: u.end, user: u }));
  bars.sort((a, b) => a.start - b.start);
  const layerLanes = lanes(bars);
  const laneCount = Math.max(1, Math.min(3, Math.max(0, ...layerLanes) + 1));
  const inner = duration * pps + 200;
  const mainSorted = clips.filter((c) => (c.track ?? 0) === 0).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  return (
    <div className="tl">
      <div className="tl-tools">
        <button className="ed-icon-btn" title="Split the clip at the playhead (Ctrl+B)" disabled={locked || !clips.length} onClick={props.onSplit}>
          <Icon d={I.split} /> Split
        </button>
        <button className="ed-icon-btn" title="Delete the selected item (Del)" disabled={locked || !selection || selection.kind === 'layer'} onClick={props.onDelete}>
          <Icon d={I.trash} /> Delete
        </button>
        <span className="tl-sep" />
        <button className="ed-icon-btn" title="Add text at the playhead" disabled={locked || !raw} onClick={props.onAddText}>
          <Icon d={I.text} /> Text
        </button>
        <button className="ed-icon-btn" title="Add a camera zoom at the playhead" disabled={locked || !raw} onClick={() => edit((o) => ((o.camera ??= []).push({ t: r2(p.time), zoom: 1.2, y: 0.4, ease: 'cut' }), select({ kind: 'camera', index: o.camera.length - 1 })))}>
          <Icon d={I.cam} /> Zoom
        </button>
        <button className="ed-icon-btn" title="Add a shake at the playhead" disabled={locked || !raw} onClick={() => edit((o) => (o.camera ??= []).push({ t: r2(p.time), shake: 14 }))}>
          <Icon d={I.zap} /> Shake
        </button>
        {locked && <span className="tl-lock">AI is editing. The timeline unlocks when it finishes.</span>}
        <span className="grow" />
        <label className="tl-zoom" title="Timeline zoom">
          <span>−</span>
          <input type="range" min={1} max={14} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          <span>+</span>
        </label>
      </div>
      <div className="tl-scroll" ref={scroller} onPointerDown={scrub}>
        <div className="tl-inner" style={{ width: inner }}>
          <div className="tl-row tl-ruler">
            <div className="tl-head" />
            <div className="tl-lane">
              {ticks.map((t) => (
                <span key={t} className="tl-tick" style={{ left: t * pps }}>
                  {step < 1 ? clock(t).replace(/\d$/, '') : clock(t).replace(/\.\d+$/, '')}
                </span>
              ))}
            </div>
          </div>
          <div className="tl-row" style={{ height: 14 + laneCount * 26 }}>
            <div className="tl-head">Text & FX</div>
            <div className="tl-lane">
              {bars.map((l, i) => {
                const user = l.user;
                const sel = user ? selection?.kind === 'text' && selection.id === user.id : selection?.kind === 'layer' && selection.index === l.layer;
                return (
                  <button
                    key={i}
                    className={`tl-item tl-layer ${hasLetters(l.label) ? '' : 'fx'} ${user ? 'mine' : ''} ${sel ? 'sel' : ''}`}
                    style={{ left: l.start * pps, width: Math.max(6, (l.end - l.start) * pps), top: 7 + layerLanes[i] * 26 }}
                    title={`${l.label} (${l.start.toFixed(2)}s to ${l.end.toFixed(2)}s)${user ? '' : p.config?.map ? ' · follows the footage' : ''}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      select(user ? { kind: 'text', id: user.id } : { kind: 'layer', index: l.layer! });
                      p.seek(l.start + 0.05);
                    }}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </div>
          {videoTracks.map((track) => (
            <div key={track} className={`tl-row tl-video-row ${track === 0 ? 'is-main' : ''} ${track > topTrack ? 'spare' : ''}`} style={{ height: track > topTrack && drag?.kind !== 'clip' ? 24 : ROW_VIDEO }}>
              <div className="tl-head">{track === 0 ? 'Main video' : track > topTrack ? 'Overlay +' : `Overlay ${track}`}</div>
              <div className="tl-lane">
                {clips.map((c, i) => {
                  const d = drag?.kind === 'clip' && drag.index === i ? drag : null;
                  const tr = d ? d.track : c.track ?? 0;
                  if (tr !== track) return null;
                  const start = d ? d.start : c.start ?? 0;
                  const inn = d ? d.in : c.in ?? 0;
                  const len = d ? (d.out - d.in) / (c.speed || 1) : clipLen(c, p);
                  return (
                    <div
                      key={i}
                      className={`tl-item tl-clip ${selection?.kind === 'clip' && selection.index === i ? 'sel' : ''}`}
                      style={{ left: start * pps, width: Math.max(12, len * pps) }}
                      title={`${c.file} · ${inn.toFixed(2)}s to ${(inn + len * (c.speed || 1)).toFixed(2)}s of the source${(c.speed || 1) !== 1 ? ` · ${c.speed}×` : ''}`}
                      onPointerDown={(e) => dragClip(e, i)}
                    >
                      <ClipStrip projectId={projectId} file={c.file} from={inn} to={inn + len * (c.speed || 1)} />
                      <span className="tl-clip-name">
                        {String(c.file).split('/').pop()}
                        {(c.speed || 1) !== 1 && <b className="tl-speed"> {c.speed}×</b>}
                      </span>
                      <span className="tl-handle l" />
                      <span className="tl-handle r" />
                    </div>
                  );
                })}
                {track === 0 &&
                  mainSorted.slice(1).map((c) => {
                    const i = clips.indexOf(c);
                    const has = Boolean(c.transition);
                    return (
                      <button
                        key={`t${i}`}
                        className={`tl-item tl-trans ${has ? 'on' : ''} ${selection?.kind === 'transition' && selection.index === i ? 'sel' : ''}`}
                        style={{ left: ((c.start ?? 0) + (has ? (c.transition.dur ?? 0.5) / 2 : 0)) * pps }}
                        title={has ? `${TRANSITION_LABEL[c.transition.type as TransitionType] ?? c.transition.type}, ${c.transition.dur}s` : 'Add a transition'}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (!explicit) return;
                          select({ kind: 'transition', index: i });
                        }}
                      >
                        {has ? '⧓' : '+'}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          <div className="tl-row" style={{ height: 34 }}>
            <div className="tl-head">Camera</div>
            <div className="tl-lane">
              {camera.map((k, i) => {
                const t = drag?.kind === 'camera' && drag.index === i ? drag.t : Number(k.t) || 0;
                const shake = k.shake !== undefined && k.zoom === undefined;
                return (
                  <button
                    key={i}
                    className={`tl-item tl-key ${shake ? 'shake' : ''} ${selection?.kind === 'camera' && selection.index === i ? 'sel' : ''}`}
                    style={{ left: t * pps }}
                    title={shake ? `Shake at ${t}s` : `Zoom ${k.zoom ?? 1}× at ${t}s (${k.ease ?? 'smooth'})`}
                    onPointerDown={(e) => dragKey(e, 'camera', i, Number(k.t) || 0)}
                  />
                );
              })}
            </div>
          </div>
          <div className="tl-row" style={{ height: 14 + Math.max(1, audio.length) * 26 }}>
            <div className="tl-head">Sound</div>
            <div className="tl-lane">
              {audio.map((a, i) => {
                const start = drag?.kind === 'audio' && drag.index === i ? drag.t : Number(a.start) || 0;
                const len = Math.max(0.15, (lengths[a.file] ?? 0.6) - (Number(a.trimStart) || 0));
                return (
                  <button
                    key={i}
                    className={`tl-item tl-audio ${selection?.kind === 'audio' && selection.index === i ? 'sel' : ''}`}
                    style={{ left: start * pps, width: Math.max(10, len * pps), top: 6 + i * 26 }}
                    title={`${a.file} at ${start}s, volume ${a.volume ?? 1}`}
                    onPointerDown={(e) => dragKey(e, 'audio', i, Number(a.start) || 0)}
                  >
                    <Wave projectId={projectId} file={a.file} />
                    <span>{String(a.file).split('/').pop()?.replace(/\.\w+$/, '')}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <Playhead p={p} pps={pps} />
        </div>
      </div>
    </div>
  );
}

// ---------- player ----------
function Player({ p, raw, status, onRefresh }: { p: Preview; raw: Raw | null; status: string; onRefresh: () => void }) {
  useTick(p);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  const c = p.config;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.querySelector('.pv-mount')?.append(p.stage);
    const fit = () => {
      if (!p.config) return;
      const k = Math.min((el.clientWidth - 24) / p.config.width, (el.clientHeight - 24) / p.config.height);
      setScale(Math.max(0.05, k));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p, p.shape]);

  return (
    <div className="ed-player">
      <div className="ed-screen" ref={box}>
        <div className="pv-mount" style={{ width: (c?.width ?? 0) * scale, height: (c?.height ?? 0) * scale, visibility: c ? 'visible' : 'hidden', position: c ? 'relative' : 'absolute' }}>
          <style>{`.pv-stage{transform:scale(${scale})}`}</style>
        </div>
        {!c && (
          <div className="ed-empty">
            <Logo size={56} />
            {status === 'working' ? <p>The AI is building your video. It appears here as soon as there's something to play.</p> : raw === null ? <p>Nothing to play yet. Tell the AI what to make in the AI panel.</p> : <p className="bad">{p.error}</p>}
          </div>
        )}
        {c && p.error && <div className="ed-error">{p.error}</div>}
      </div>
      <div className="ed-transport">
        <span className="ed-time">
          <strong>{clock(p.time)}</strong> / {clock(p.duration)}
        </span>
        <div className="ed-transport-mid">
          <button className="ed-round" title="To start (Home)" onClick={() => p.seek(0)} disabled={!c}>
            <Icon d={I.start} />
          </button>
          <button className="ed-round big" title="Play or pause (Space)" onClick={() => p.toggle()} disabled={!c}>
            <Icon d={p.playing ? I.pause : I.play} size={20} />
          </button>
          <button className="ed-round" title="To end (End)" onClick={() => p.seek(p.duration)} disabled={!c}>
            <Icon d={I.end} />
          </button>
        </div>
        <span className="ed-meta">
          {c ? `${c.width}×${c.height} · ${c.fps} fps` : ''}
          <button className="ed-round" title="Reload the preview" onClick={onRefresh}>
            <Icon d={I.refresh} size={16} />
          </button>
        </span>
      </div>
    </div>
  );
}

// ---------- left panel ----------
function TextAdder({ onAdd, locked, hasPage }: { onAdd: (style: TextStyle, text: string, color: string) => void; locked: boolean; hasPage: boolean }) {
  const [text, setText] = useState('');
  const [style, setStyle] = useState<TextStyle>('neon');
  const [color, setColor] = useState(TEXT_STYLES.neon.color);
  if (!hasPage) return <p className="hint">Text can be added once the AI has made the video page.</p>;
  return (
    <div className="ed-text-add">
      <textarea rows={2} placeholder="Type a caption (Bangla or English)" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="ed-style-grid">
        {(Object.keys(TEXT_STYLES) as TextStyle[]).map((s) => (
          <button key={s} className={`ed-style ${style === s ? 'on' : ''} s-${s}`} onClick={() => (setStyle(s), setColor(TEXT_STYLES[s].color))}>
            {TEXT_STYLES[s].title}
          </button>
        ))}
      </div>
      <div className="ed-colors">
        {TEXT_COLORS.map((c) => (
          <button key={c} title={c} className={`ed-color c-${c} ${color === c ? 'on' : ''}`} onClick={() => setColor(c)} />
        ))}
      </div>
      <button className="btn primary" disabled={locked || !text.trim()} onClick={() => (onAdd(style, text.trim(), color), setText(''))}>
        <Icon d={I.plus} /> Add at playhead
      </button>
      <p className="hint">Added text lasts 2.5 seconds. Change its timing, style and height in Properties.</p>
    </div>
  );
}

function MediaPanel({ c, raw, p, locked, edit, tab, setTab, onAddText }: { c: AgentController; raw: Raw | null; p: Preview; locked: boolean; edit: EditRaw; tab: 'media' | 'text' | 'audio' | 'exports'; setTab: (t: 'media' | 'text' | 'audio' | 'exports') => void; onAddText: (style: TextStyle, text: string, color: string) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addAudio = (file: string) => edit((o) => (o.audio ??= []).push({ file, start: r2(p.time), volume: 0.35 }));

  const importFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const names = await addInputFiles(c.meta, [...list], setNote);
      setNote(`Added ${names.join(', ')}.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  /** Puts a video on the timeline: at the end of the main track, or above everything at the playhead. */
  const addVideo = async (path: string, overlay: boolean) => {
    let len: number | null = p.fileLength(path);
    if (len === null) {
      const media = await readMedia(c.meta.id, path);
      len = media ? (await mediaInfo(media).catch(() => null))?.durationSec ?? null : null;
    }
    edit((o) => {
      ensureClips(o, p);
      const top = Math.max(0, ...o.clips.map((k: Raw) => k.track ?? 0));
      // An overlay fits inside the video it sits on, instead of making the project longer.
      const room = o.duration - p.time;
      const length = overlay && room > 0.5 ? Math.min(len ?? 5, room) : len ?? 5;
      const clip: Raw = { file: path, track: overlay ? top + 1 : 0, start: overlay ? r2(p.time) : 1e6, in: 0, out: r2(length) };
      if (overlay) Object.assign(clip, { scale: 0.42, x: 0.72, y: 0.28, volume: 0 });
      o.clips.push(clip);
      settle(o, p);
    });
  };

  return (
    <aside className="ed-left">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['media', 'Media'],
          ['text', 'Text'],
          ['audio', 'Sounds'],
          ['exports', `Exports${c.outputs.length ? ` (${c.outputs.length})` : ''}`],
        ]}
      />
      <div className="ed-panel-body">
        {tab === 'media' && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => { void importFiles(e.target.files); e.target.value = ''; }} />
            <button className="ed-import" disabled={c.working} onClick={() => input.current?.click()}>
              <Icon d={I.plus} /> Import
            </button>
            {note && <p className="hint ed-note">{note}</p>}
            <div className="ed-media-grid">
              {c.meta.inputs.map((name) => {
                const path = `input/${name}`;
                const used = (raw?.clips ?? []).some((k: Raw) => k.file === path) || raw?.footage === path;
                return (
                  <div key={name} className={`ed-media ${used ? 'main' : ''}`}>
                    <MediaThumb projectId={c.meta.id} path={path} />
                    <span className="ed-media-name" title={name}>{name}</span>
                    <div className="ed-media-actions">
                      {isVideoFile(name) && raw && (
                        <>
                          <button disabled={locked} title="Add to the end of the main track" onClick={() => void addVideo(path, false)}>+ Main</button>
                          <button disabled={locked} title="Add on a track above, at the playhead" onClick={() => void addVideo(path, true)}>+ Overlay</button>
                        </>
                      )}
                      {isSoundFile(name) && raw && <button disabled={locked} onClick={() => addAudio(path)}>+ Sound</button>}
                      <button onClick={() => askAi(c.meta.id, `Use ${path} in the video: `)}>Ask AI</button>
                    </div>
                  </div>
                );
              })}
              {c.meta.inputs.length === 0 && <p className="hint">Import footage, voice, logos or screenshots.</p>}
            </div>
          </>
        )}
        {tab === 'text' && <TextAdder onAdd={onAddText} locked={locked} hasPage={Boolean(raw)} />}
        {tab === 'audio' && (
          <div className="ed-sfx">
            {SFX.map((f) => (
              <div key={f} className="ed-sfx-row">
                <button className="ed-round" title="Listen" onClick={() => void new Audio(new URL(`runtime/${f.slice(7)}`, document.baseURI).href).play()}>
                  <Icon d={I.play} size={14} />
                </button>
                <span>{f.split('/').pop()!.replace('.mp3', '')}</span>
                <button className="ed-round" title="Add at the playhead" disabled={locked || !raw} onClick={() => addAudio(f)}>
                  <Icon d={I.plus} size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {tab === 'exports' && (c.outputs.length ? <VideoPanel projectId={c.meta.id} name={c.meta.name} outputs={c.outputs} /> : <p className="hint">Exported videos appear here. Press Export at the top right.</p>)}
      </div>
    </aside>
  );
}

// ---------- right panel ----------
function AdjustPanel({ raw, locked, edit }: { raw: Raw | null; locked: boolean; edit: EditRaw }) {
  if (!raw) return <p className="hint">Adjustments become available once the AI has made project.json.</p>;
  const g: Raw = raw.grade ?? { brightness: 1, contrast: 1, saturation: 1, tint: null, tintAmount: 0, vignette: 0 };
  const set = (k: string, v: unknown) => edit((o) => (o.grade = { ...g, ...(o.grade ?? {}), [k]: v }));
  return (
    <div className="ed-adjust">
      <h3>Look</h3>
      <div className="ed-presets">
        {Object.entries(GRADE_PRESETS).map(([name, preset]) => (
          <button key={name} disabled={locked} onClick={() => edit((o) => (preset ? (o.grade = { ...preset }) : delete o.grade))}>
            {name}
          </button>
        ))}
      </div>
      <Slider label="Brightness" value={Number(g.brightness ?? 1)} min={0.5} max={1.5} step={0.01} disabled={locked} onChange={(v) => set('brightness', v)} />
      <Slider label="Contrast" value={Number(g.contrast ?? 1)} min={0.5} max={1.6} step={0.01} disabled={locked} onChange={(v) => set('contrast', v)} />
      <Slider label="Saturation" value={Number(g.saturation ?? 1)} min={0} max={1.6} step={0.01} disabled={locked} onChange={(v) => set('saturation', v)} />
      <Slider label="Vignette" value={Number(g.vignette ?? 0)} min={0} max={1} step={0.01} disabled={locked} onChange={(v) => set('vignette', v)} />
      <div className="ed-tint">
        <label>
          Tint
          <input type="color" value={g.tint ?? '#2a5cff'} disabled={locked} onChange={(e) => set('tint', e.target.value)} />
        </label>
        <Slider label="Tint amount" value={Number(g.tintAmount ?? 0)} min={0} max={0.6} step={0.01} disabled={locked} onChange={(v) => set('tintAmount', v)} />
      </div>
      <p className="hint">The look applies to the video tracks only. Captions and effects stay as designed.</p>
    </div>
  );
}

/** Edit the lines of a caption the AI made: each line is swapped in the page's source. */
function AiTextEditor({ layer, locked, editHtml, projectId }: { layer: Layer; locked: boolean; editHtml: EditHtml; projectId: string }) {
  const [values, setValues] = useState(layer.texts);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setValues(layer.texts);
    setMsg(null);
  }, [layer]);
  const apply = async () => {
    let missing = 0;
    const ok = await editHtml((html) => {
      let next = html;
      layer.texts.forEach((from, i) => {
        const to = values[i] ?? from;
        if (to === from) return;
        const r = replaceText(next, from, to);
        if (r === null) missing++;
        else next = r;
      });
      return next === html ? null : next;
    });
    setMsg(missing ? "Some lines aren't written as plain text in the page. Ask the AI to change them." : ok ? 'Updated.' : 'Nothing changed.');
  };
  return (
    <div className="ed-props">
      <h3>Text</h3>
      {layer.texts.length === 0 && <p className="hint">This part has no editable text.</p>}
      {layer.texts.map((t, i) => (
        <textarea key={i} rows={2} value={values[i] ?? t} disabled={locked} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
      ))}
      {layer.texts.length > 0 && (
        <button className="btn primary" disabled={locked} onClick={apply}>
          Apply text
        </button>
      )}
      {msg && <p className="hint">{msg}</p>}
      <p className="hint">
        On screen {layer.start.toFixed(2)}s to {layer.end.toFixed(2)}s. For timing, colour or animation, ask the AI.
      </p>
      <button className="btn" onClick={() => askAi(projectId, `Change the "${layer.label}" part (${layer.start.toFixed(2)}s to ${layer.end.toFixed(2)}s): `)}>
        Ask AI to change it
      </button>
    </div>
  );
}

function UserTextEditor({ u, locked, onChange, onDelete, duration }: { u: UserText; locked: boolean; onChange: (u: UserText) => void; onDelete: () => void; duration: number }) {
  const [text, setText] = useState(u.text);
  useEffect(() => setText(u.text), [u]);
  return (
    <div className="ed-props">
      <h3>Your text</h3>
      <textarea rows={2} value={text} disabled={locked} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== u.text && onChange({ ...u, text: text.trim() })} />
      <label className="ed-select">
        Style
        <select value={u.style} disabled={locked} onChange={(e) => onChange({ ...u, style: e.target.value as TextStyle })}>
          {(Object.keys(TEXT_STYLES) as TextStyle[]).map((s) => (
            <option key={s} value={s}>{TEXT_STYLES[s].title}</option>
          ))}
        </select>
      </label>
      <div className="ed-colors">
        {TEXT_COLORS.map((c) => (
          <button key={c} title={c} disabled={locked} className={`ed-color c-${c} ${u.color === c ? 'on' : ''}`} onClick={() => onChange({ ...u, color: c })} />
        ))}
      </div>
      <Slider label="Starts (s)" value={u.t} min={0} max={Math.max(1, duration)} step={0.05} disabled={locked} onChange={(v) => onChange({ ...u, t: r2(v), end: r2(Math.max(v + 0.3, u.end)) })} />
      <Slider label="Ends (s)" value={u.end} min={0.3} max={Math.max(1, duration)} step={0.05} disabled={locked} onChange={(v) => onChange({ ...u, end: r2(Math.max(u.t + 0.3, v)) })} />
      <Slider label="Height on screen" value={u.y} min={0.05} max={0.95} step={0.01} disabled={locked} onChange={(v) => onChange({ ...u, y: r2(v) })} format={(v) => `${Math.round(v * 100)}%`} />
      <button className="btn text bad" disabled={locked} onClick={onDelete}>
        Delete text
      </button>
    </div>
  );
}

function PropsPanel(props: { raw: Raw | null; p: Preview; selection: Selection; locked: boolean; edit: EditRaw; editHtml: EditHtml; projectId: string; texts: UserText[]; putText: (u: UserText) => void; dropText: (id: string) => void }) {
  const { raw, p, selection, locked, edit, projectId } = props;
  if (!raw || !selection) return <p className="hint">Select a clip, text, camera key or sound on the timeline.</p>;
  if (selection.kind === 'text') {
    const u = props.texts.find((x) => x.id === selection.id);
    return u ? <UserTextEditor u={u} locked={locked} onChange={props.putText} onDelete={() => props.dropText(u.id)} duration={p.duration} /> : null;
  }
  if (selection.kind === 'layer') {
    const l = p.layers[selection.index];
    return l ? <AiTextEditor layer={l} locked={locked} editHtml={props.editHtml} projectId={projectId} /> : null;
  }
  if (selection.kind === 'transition') {
    const k: Raw | undefined = raw.clips?.[selection.index];
    if (!k) return null;
    const tr: Raw | null = k.transition ?? null;
    const setTr = (next: Raw | null) =>
      edit((o) => {
        const c = o.clips[selection.index];
        if (next) c.transition = next;
        else delete c.transition;
        settle(o, p);
      });
    return (
      <div className="ed-props">
        <h3>Transition</h3>
        <p className="hint">Into {String(k.file).split('/').pop()} from the clip before it.</p>
        <div className="ed-trans-grid">
          <button className={`ed-style ${!tr ? 'on' : ''}`} disabled={locked} onClick={() => setTr(null)}>
            None
          </button>
          {TRANSITIONS.map((t) => (
            <button key={t} className={`ed-style ${tr?.type === t ? 'on' : ''}`} disabled={locked} onClick={() => setTr({ type: t, dur: tr?.dur ?? 0.5 })}>
              {TRANSITION_LABEL[t]}
            </button>
          ))}
        </div>
        {tr && <Slider label="Duration (s)" value={Number(tr.dur ?? 0.5)} min={0.1} max={2} step={0.05} disabled={locked} onChange={(v) => setTr({ ...tr, dur: r2(v) })} />}
        {tr && (
          <button
            className="btn"
            disabled={locked}
            onClick={() =>
              edit((o) => {
                const main = o.clips.filter((c: Raw) => (c.track ?? 0) === 0).sort((a: Raw, b: Raw) => (a.start ?? 0) - (b.start ?? 0));
                main.slice(1).forEach((c: Raw) => (c.transition = { ...tr }));
                settle(o, p);
              })
            }
          >
            Use on every cut
          </button>
        )}
        <p className="hint">The two clips overlap for the transition, so the video gets a little shorter.</p>
      </div>
    );
  }
  if (selection.kind === 'clip') {
    const list: Raw[] = Array.isArray(raw.clips) && raw.clips.length ? raw.clips : raw.footage ? [{ file: raw.footage, track: 0, start: 0, in: 0, out: null }] : [];
    const k = list[selection.index];
    if (!k) return null;
    const set = (key: string, v: unknown) =>
      edit((o) => {
        ensureClips(o, p);
        o.clips[selection.index][key] = v;
        settle(o, p);
      });
    const len = clipLen(k, p);
    const overlay = (k.track ?? 0) > 0;
    return (
      <div className="ed-props">
        <h3>{overlay ? `Overlay clip (track ${k.track})` : 'Main clip'}</h3>
        <p className="ed-quote">{String(k.file).split('/').pop()}</p>
        <p className="hint">
          Uses {Number(k.in ?? 0).toFixed(2)}s to {(Number(k.in ?? 0) + len * (k.speed || 1)).toFixed(2)}s of the source, at {Number(k.start ?? 0).toFixed(2)}s. Drag its edges on the timeline to trim.
        </p>
        <Slider label="Speed" value={Number(k.speed ?? 1)} min={0.25} max={4} step={0.05} disabled={locked} onChange={(v) => set('speed', r2(v))} format={(v) => `${v.toFixed(2)}×`} />
        <div className="ed-presets">
          {[0.5, 1, 1.5, 2, 3].map((v) => (
            <button key={v} disabled={locked} className={Number(k.speed ?? 1) === v ? 'on' : ''} onClick={() => set('speed', v)}>
              {v}×
            </button>
          ))}
        </div>
        <Slider label="Volume" value={Number(k.volume ?? 1)} min={0} max={1.5} step={0.01} disabled={locked} onChange={(v) => set('volume', r2(v))} />
        {overlay && (
          <>
            <Slider label="Size" value={Number(k.scale ?? 1)} min={0.15} max={1} step={0.01} disabled={locked} onChange={(v) => set('scale', r2(v))} format={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Position X" value={Number(k.x ?? 0.5)} min={0} max={1} step={0.01} disabled={locked} onChange={(v) => set('x', r2(v))} />
            <Slider label="Position Y" value={Number(k.y ?? 0.5)} min={0} max={1} step={0.01} disabled={locked} onChange={(v) => set('y', r2(v))} />
          </>
        )}
      </div>
    );
  }
  const list: Raw[] = raw[selection.kind] ?? [];
  const item = list[selection.index];
  if (!item) return null;
  const set = (k: string, v: unknown) => edit((o) => (o[selection.kind][selection.index][k] = v));
  if (selection.kind === 'audio')
    return (
      <div className="ed-props">
        <h3>Sound</h3>
        <p className="ed-quote">{String(item.file).split('/').pop()}</p>
        <Slider label="Start (s)" value={Number(item.start ?? 0)} min={0} max={Math.max(1, p.duration)} step={0.01} disabled={locked} onChange={(v) => set('start', v)} />
        <Slider label="Volume" value={Number(item.volume ?? 1)} min={0} max={1.5} step={0.01} disabled={locked} onChange={(v) => set('volume', v)} />
        <Slider label="Trim start (s)" value={Number(item.trimStart ?? 0)} min={0} max={10} step={0.01} disabled={locked} onChange={(v) => set('trimStart', v)} />
      </div>
    );
  const shake = item.shake !== undefined && item.zoom === undefined;
  return (
    <div className="ed-props">
      <h3>{shake ? 'Shake' : 'Camera zoom'}</h3>
      <Slider label="Time (s)" value={Number(item.t ?? 0)} min={0} max={Math.max(1, p.duration)} step={0.01} disabled={locked} onChange={(v) => set('t', v)} />
      {shake ? (
        <Slider label="Strength (px)" value={Number(item.shake ?? 12)} min={2} max={40} step={1} disabled={locked} onChange={(v) => set('shake', v)} format={(v) => String(v)} />
      ) : (
        <>
          <Slider label="Zoom" value={Number(item.zoom ?? 1)} min={1} max={1.6} step={0.01} disabled={locked} onChange={(v) => set('zoom', v)} format={(v) => `${v.toFixed(2)}×`} />
          <Slider label="Focus X" value={Number(item.x ?? 0.5)} min={0} max={1} step={0.01} disabled={locked} onChange={(v) => set('x', v)} />
          <Slider label="Focus Y" value={Number(item.y ?? 0.5)} min={0} max={1} step={0.01} disabled={locked} onChange={(v) => set('y', v)} />
          <label className="ed-select">
            Move
            <select value={item.ease ?? 'smooth'} disabled={locked} onChange={(e) => set('ease', e.target.value)}>
              <option value="cut">Cut (jump)</option>
              <option value="smooth">Smooth</option>
              <option value="push">Slow push</option>
            </select>
          </label>
          {item.ease !== 'cut' && <Slider label="Duration (s)" value={Number(item.dur ?? 0.45)} min={0.1} max={6} step={0.05} disabled={locked} onChange={(v) => set('dur', v)} />}
        </>
      )}
    </div>
  );
}

const ago = (ms: number) => {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return new Date(ms).toLocaleString();
};

/** Saved versions of the project (SQLite), newest first. */
function HistoryPanel({ projectId, version, locked, onRestore }: { projectId: string; version: number; locked: boolean; onRestore: (id: number) => void }) {
  const [rows, setRows] = useState<{ id: number; at: number; label: string }[]>([]);
  useEffect(() => {
    void desktop?.historyList(projectId).then(setRows);
  }, [projectId, version]);
  return (
    <div className="ed-history">
      <h3>Versions</h3>
      <p className="hint">Every edit and every AI turn is saved in the project database. Restoring keeps the current state as a version too.</p>
      {rows.map((r, i) => (
        <div key={r.id} className={`ed-hrow ${i === 0 ? 'now' : ''}`}>
          <span className="ed-hdot" />
          <span className="ed-htext">
            <strong>{r.label}</strong>
            <span className="hint">{ago(r.at)}</span>
          </span>
          {i === 0 ? <span className="ed-badge">Current</span> : <button className="btn small-btn" disabled={locked} onClick={() => onRestore(r.id)}>Restore</button>}
        </div>
      ))}
      {rows.length === 0 && <p className="hint">No versions yet.</p>}
    </div>
  );
}

function ExportDialog({ c, onClose }: { c: AgentController; onClose: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [side, setSide] = useState(settings.exportShortSide);
  const [done, setDone] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [engine, setEngine] = useState<number | null>(null);
  useEffect(() => desktop?.onEngineProgress((e) => e.id === c.meta.id && setEngine(e.fraction)), [c]);
  const run = async () => {
    setRunning(true);
    setEngine(null);
    setDone(await c.exportVideo(side));
    setRunning(false);
  };
  const fileName = `${c.meta.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'video'}.mp4`;
  return (
    <div className="ed-modal" role="dialog" aria-label="Export" onClick={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="ed-modal-card">
        <h2>Export</h2>
        {!running && !done && (
          <>
            <label className="ed-select">
              Resolution
              <select value={side} onChange={(e) => setSide(Number(e.target.value))}>
                <option value={720}>720p: fastest</option>
                <option value={1080}>1080p: recommended</option>
                <option value={1440}>1440p: sharpest</option>
              </select>
            </label>
            <p className="hint">H.264 MP4 with AAC sound. Edited clips are joined by the native engine on the GPU first.</p>
            <div className="row">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary grow" onClick={run} disabled={c.working}>
                {c.working ? 'Wait for the AI to finish' : 'Export'}
              </button>
            </div>
          </>
        )}
        {running && (
          <>
            {c.renderInfo?.stage === 'frames' || c.renderInfo?.stage === 'finishing' ? (
              <RenderBar info={c.renderInfo} />
            ) : engine !== null ? (
              <div className="render-bar">
                <span>Joining the clips (native engine) {Math.round(engine * 100)}%</span>
                <progress max={1} value={engine} />
              </div>
            ) : (
              <p className="hint">Preparing...</p>
            )}
            <button className="btn text bad" onClick={() => c.stop()}>Stop</button>
          </>
        )}
        {!running && done && (
          <>
            <p>Saved {done}.</p>
            <div className="row">
              {desktop && <button className="btn" onClick={() => desktop!.reveal(c.meta.id, done)}>Show in folder</button>}
              {desktop && <button className="btn primary grow" onClick={() => desktop!.saveAs(c.meta.id, done, fileName)}>Save as...</button>}
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}
        {!running && !done && c.events.at(-1)?.kind === 'error' && <p className="msg bad">{c.events.at(-1)!.text}</p>}
      </div>
    </div>
  );
}

// ---------- the screen ----------
export function EditorScreen({ meta, onDeleted }: { meta: ProjectMeta; onDeleted: () => void }) {
  const [c, setC] = useState<AgentController | null>(null);
  useEffect(() => {
    AgentController.of(meta).then(setC);
  }, [meta]);
  if (!c) return <div className="ed" />;
  return <Editor key={c.meta.id} c={c} onDeleted={onDeleted} />;
}

type Snapshot = { raw?: string; html?: string };

function Editor({ c, onDeleted }: { c: AgentController; onDeleted: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const p = useMemo(() => new Preview(c.meta.id), [c]);
  useSyncExternalStore(p.subscribe, p.getShape);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [rightTab, setRightTab] = useState<'ai' | 'adjust' | 'props' | 'history'>('ai');
  const [leftTab, setLeftTab] = useState<'media' | 'text' | 'audio' | 'exports'>('media');
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const undo = useRef<Snapshot[]>([]);
  const status = c.working ? 'working' : c.meta.status;
  const locked = c.working;
  const id = c.meta.id;
  const texts = useMemo(() => (html ? userTexts(html) : []), [html]);

  // Version history in the project database: a version after each edit (a burst of slider moves is one) and
  // after each AI turn.
  const [historyVersion, setHistoryVersion] = useState(0);
  const pending = useRef<{ label: string; timer: number } | null>(null);
  const record = useCallback(
    async (label: string) => {
      if (!desktop) return;
      const added = await desktop.historyAdd(id, label, await readText(id, 'project.json'), await readText(id, 'index.html'));
      if (added) setHistoryVersion((n) => n + 1);
    },
    [id],
  );
  const recordSoon = useCallback(
    (label: string) => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = {
        label,
        timer: window.setTimeout(() => {
          pending.current = null;
          void record(label);
        }, 1200),
      };
    },
    [record],
  );

  const reload = useCallback(async () => {
    setRaw(await readRaw(id));
    setHtml(await readText(id, 'index.html'));
    await p.load();
  }, [id, p]);

  // The state the project opens in is a version too, so there's always something to go back to.
  useEffect(() => {
    void record('Opened');
  }, [record]);

  useEffect(() => {
    void reload();
    return () => p.destroy();
  }, [p, reload]);

  // When the AI finishes a turn, show what it made.
  const wasWorking = useRef(c.working);
  useEffect(() => {
    if (wasWorking.current && !c.working) void reload().then(() => record(`AI: ${ENGINE_LABEL[settings.engine] ?? 'AI'} turn`));
    wasWorking.current = c.working;
  }, [c.working, reload, record]);

  const edit: EditRaw = useCallback(
    (fn) => {
      if (!raw || c.working) return;
      undo.current.push({ raw: JSON.stringify(raw) });
      if (undo.current.length > 100) undo.current.shift();
      const next = JSON.parse(JSON.stringify(raw));
      fn(next);
      followFootage(raw, next, p);
      setRaw(next);
      const label = describe(raw, next);
      void writeRaw(id, next).then(() => {
        recordSoon(label);
        return p.reloadConfig();
      });
    },
    [raw, c, p, id, recordSoon],
  );

  const editHtml: EditHtml = useCallback(
    async (fn) => {
      if (html === null || c.working) return false;
      const next = fn(html);
      if (next === null || next === html) return false;
      undo.current.push({ html });
      setHtml(next);
      await writeHtml(id, next);
      recordSoon('Text');
      await p.reloadPage();
      return true;
    },
    [html, c, p, id, recordSoon],
  );

  const undoLast = useCallback(async () => {
    const prev = undo.current.pop();
    if (!prev || c.working) return;
    setSelection(null);
    if (prev.raw !== undefined) {
      const o = JSON.parse(prev.raw);
      setRaw(o);
      await writeRaw(id, o);
      await p.reloadConfig();
    }
    if (prev.html !== undefined) {
      setHtml(prev.html);
      await writeHtml(id, prev.html);
      await p.reloadPage();
    }
  }, [c, p, id]);

  /** Brings back a saved version; the state before it is saved first, so a restore can be undone too. */
  const restore = useCallback(
    async (hid: number) => {
      if (!desktop || c.working) return;
      const v = await desktop.historyGet(hid);
      if (!v || v.project !== id) return;
      await record('Before restore');
      undo.current.push({ raw: raw ? JSON.stringify(raw) : undefined, html: html ?? undefined });
      if (v.projectJson !== null) await filePut(id, 'project.json', new Blob([v.projectJson], { type: 'application/json' }));
      if (v.indexHtml !== null) await writeHtml(id, v.indexHtml);
      setSelection(null);
      await reload();
      await record('Restored a version');
    },
    [c, id, raw, html, record, reload],
  );

  const select = (s: Selection) => {
    setSelection(s);
    if (s) setRightTab('props');
  };

  const putText = (u: UserText) => void editHtml((h) => putUserText(h, u));
  const dropText = (tid: string) => {
    void editHtml((h) => removeUserText(h, tid));
    setSelection(null);
  };
  const addText = (style: TextStyle, text: string, color: string) => {
    const u: UserText = { id: Math.random().toString(36).slice(2, 10), style, text, color, t: r2(p.time), end: r2(Math.min(p.duration || p.time + 2.5, p.time + 2.5)), y: TEXT_STYLES[style].y };
    if (u.end - u.t < 0.3) u.end = r2(u.t + 2.5);
    void editHtml((h) => putUserText(h, u)).then(() => select({ kind: 'text', id: u.id }));
  };

  /** Splits the selected clip (or the main clip under the playhead) at the playhead. */
  const split = useCallback(() => {
    if (!raw || c.working) return;
    const t = p.time;
    edit((o) => {
      ensureClips(o, p);
      const pick = (k: Raw) => t > (k.start ?? 0) + 0.05 && t < (k.start ?? 0) + clipLen(k, p) - 0.05;
      const sel = selection?.kind === 'clip' ? o.clips[selection.index] : null;
      const k: Raw | undefined = sel && pick(sel) ? sel : o.clips.find((x: Raw) => (x.track ?? 0) === 0 && pick(x));
      if (!k) return;
      const sp = k.speed || 1;
      const cut = r2((k.in ?? 0) + (t - (k.start ?? 0)) * sp);
      const end = r2((k.in ?? 0) + clipLen(k, p) * sp);
      const b: Raw = { ...k, start: r2(t), in: cut, out: end };
      delete b.transition;
      k.out = cut;
      o.clips.splice(o.clips.indexOf(k) + 1, 0, b);
      settle(o, p);
      setSelection({ kind: 'clip', index: o.clips.indexOf(b) });
    });
  }, [raw, c, p, edit, selection]);

  const remove = useCallback(() => {
    if (!selection || c.working) return;
    if (selection.kind === 'text') return dropText(selection.id);
    if (selection.kind === 'layer') return;
    if (selection.kind === 'transition') {
      edit((o) => {
        if (o.clips?.[selection.index]) delete o.clips[selection.index].transition;
        settle(o, p);
      });
      setSelection(null);
      return;
    }
    if (selection.kind === 'clip') {
      edit((o) => {
        ensureClips(o, p);
        o.clips.splice(selection.index, 1);
        settle(o, p);
        if (!o.clips.length) delete o.clips;
      });
    } else edit((o) => o[selection.kind].splice(selection.index, 1));
    setSelection(null);
  }, [selection, c, edit, p]);

  // Keyboard: Space plays, Ctrl+B splits, Delete removes, Ctrl+Z undoes, arrows step a frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const fps = p.config?.fps ?? 30;
      if (e.code === 'Space') {
        e.preventDefault();
        p.toggle();
      } else if (e.key === 'ArrowLeft') p.seek(p.time - (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === 'ArrowRight') p.seek(p.time + (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === 'Home') p.seek(0);
      else if (e.key === 'End') p.seek(p.duration);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undoLast();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        split();
      } else if (e.key === 'Delete' || e.key === 'Backspace') remove();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [p, undoLast, split, remove]);

  const right: ReactNode =
    rightTab === 'ai' ? (
      <Conversation c={c} />
    ) : rightTab === 'history' ? (
      <div className="ed-panel-body">
        <HistoryPanel projectId={id} version={historyVersion} locked={locked} onRestore={(hid) => void restore(hid)} />
      </div>
    ) : (
      <div className="ed-panel-body">{rightTab === 'adjust' ? <AdjustPanel raw={raw} locked={locked} edit={edit} /> : <PropsPanel raw={raw} p={p} selection={selection} locked={locked} edit={edit} editHtml={editHtml} projectId={id} texts={texts} putText={putText} dropText={dropText} />}</div>
    );

  return (
    <div className="ed">
      <header className="ed-top">
        <a className="ed-home" href="#/" title="Home">
          <Icon d={I.back} />
          <Logo size={26} />
        </a>
        <h1 className="ed-title" title={c.meta.name}>{c.meta.name}</h1>
        <StatusPill status={status} />
        {c.working && (
          <button className="btn text bad" onClick={() => c.stop()}>
            Stop
          </button>
        )}
        <span className="grow" />
        <span className="ed-chip" title="The AI making this video. Change it in Settings.">
          {ENGINE_LABEL[settings.engine] ?? settings.engine}
        </span>
        <button className="ed-icon-btn" title="Undo (Ctrl+Z)" disabled={locked || undo.current.length === 0} onClick={() => void undoLast()}>
          <Icon d={I.undo} />
        </button>
        {desktop && (
          <button className="ed-icon-btn" title="Open the project folder" onClick={() => desktop!.reveal(id)}>
            <Icon d={I.folder} />
          </button>
        )}
        {confirmDelete ? (
          <>
            <button
              className="btn text bad"
              onClick={async () => {
                p.destroy();
                AgentController.forget(id);
                await deleteProject(id);
                onDeleted();
              }}
            >
              Delete project
            </button>
            <button className="btn text" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="ed-icon-btn" title="Delete this project" disabled={c.working} onClick={() => setConfirmDelete(true)}>
            <Icon d={I.trash} />
          </button>
        )}
        <button className="btn primary ed-export" disabled={!p.config || c.working} onClick={() => setExporting(true)}>
          <Icon d={I.export} /> Export
        </button>
      </header>
      <MediaPanel c={c} raw={raw} p={p} locked={locked} edit={edit} tab={leftTab} setTab={setLeftTab} onAddText={addText} />
      <main className="ed-center">
        {c.renderInfo && !exporting && <RenderBar info={c.renderInfo} />}
        <Player p={p} raw={raw} status={status} onRefresh={() => void reload()} />
      </main>
      <aside className="ed-right">
        <Tabs
          value={rightTab}
          onChange={setRightTab}
          tabs={[
            ['ai', 'AI'],
            ['adjust', 'Adjust'],
            ['props', 'Properties'],
            ...(desktop ? [['history', 'History'] as ['history', string]] : []),
          ]}
        />
        {right}
      </aside>
      <section className="ed-timeline">
        <Timeline p={p} raw={raw} locked={locked} selection={selection} select={select} edit={edit} projectId={id} texts={texts} onSplit={split} onDelete={remove} onAddText={() => setLeftTab('text')} />
      </section>
      {exporting && <ExportDialog c={c} onClose={() => setExporting(false)} />}
    </div>
  );
}
