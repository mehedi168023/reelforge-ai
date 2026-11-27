// The desktop editor: media on the left, a live player in the middle, AI and adjustments on the right, and a
// timeline below. Edits write project.json; the film page itself is the AI's work and is changed through the AI.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { AgentController } from '../lib/agent';
import { fileGet, filePut } from '../lib/db';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { Preview, type Layer } from '../lib/preview';
import { SHARED_ASSETS, readMedia, videoFrames } from '../lib/render';
import { addInputFiles, deleteProject, settings, type ProjectMeta } from '../lib/store';
import { Logo, StatusPill } from '../ui';
import { Conversation, RenderBar, VideoPanel } from './Project';

type Raw = Record<string, any>;
type Selection = { kind: 'camera' | 'audio' | 'layer'; index: number } | null;

const readRaw = async (id: string): Promise<Raw | null> => {
  const f = await fileGet(id, 'project.json');
  if (!f) return null;
  try {
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
};
const writeRaw = (id: string, o: Raw) => filePut(id, 'project.json', new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));

const clock = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

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
  const isVideo = /\.(mp4|m4v|mov|webm|mkv)$/i.test(path);
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
  return <span className="ed-thumb ph">{/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(path) ? '♪' : '◆'}</span>;
}

// ---------- the timeline ----------
function lanes(layers: Layer[], max = 3) {
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

function Timeline({ p, raw, locked, selection, select, edit, projectId }: { p: Preview; raw: Raw | null; locked: boolean; selection: Selection; select: (s: Selection) => void; edit: (fn: (o: Raw) => void) => void; projectId: string }) {
  useSyncExternalStore(p.subscribe, p.getShape);
  const duration = p.duration;
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ kind: 'camera' | 'audio'; index: number; t: number } | null>(null);
  const [lengths, setLengths] = useState<Record<string, number | null>>({});
  const [thumbs, setThumbs] = useState<string[]>([]);

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
  const footage: string | null = raw?.footage ?? null;

  // Lengths of the sound clips, from the player's decoded audio.
  useEffect(() => {
    let live = true;
    for (const a of audio) {
      if (a.file in lengths) continue;
      void p.clipLength(a.file).then((len) => live && setLengths((m) => ({ ...m, [a.file]: len })));
    }
    return () => {
      live = false;
    };
  }, [audio, lengths, p]);

  // A strip of footage frames under the video track.
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    setThumbs([]);
    if (!footage || !duration) return;
    void (async () => {
      const media = await readMedia(projectId, footage);
      if (!media) return;
      const n = 10;
      const times = Array.from({ length: n }, (_, i) => Math.min(duration - 0.05, (duration / n) * (i + 0.5)));
      try {
        const frames = await videoFrames(media, times);
        if (!live) return;
        for (const f of frames) urls.push(URL.createObjectURL(f));
        setThumbs(urls);
      } catch {
        // No strip; the bar still shows.
      }
    })();
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [projectId, footage, duration]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - 120;
    return Math.max(0, Math.min(duration, x / pps));
  };

  const scrub = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('.tl-item')) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    p.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => p.seek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const startDrag = (e: RPointerEvent, kind: 'camera' | 'audio', index: number, t0: number) => {
    e.stopPropagation();
    select({ kind, index });
    if (locked) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const grab = timeAt(e.clientX) - t0;
    let t = t0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      t = Math.max(0, Math.round((timeAt(ev.clientX) - grab) * 100) / 100);
      moved = true;
      setDrag({ kind, index, t });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDrag(null);
      if (moved)
        edit((o) => {
          if (kind === 'camera') o.camera[index].t = t;
          else o.audio[index].start = t;
        });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const step = pps > 160 ? 0.5 : pps > 60 ? 1 : pps > 25 ? 2 : 5;
  const ticks = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);
  const layerLanes = lanes(p.layers);
  const laneCount = Math.max(1, Math.min(3, Math.max(0, ...layerLanes) + 1));
  const inner = duration * pps + 160;

  return (
    <div className="tl">
      <div className="tl-tools">
        <button className="ed-icon-btn" title="Add a camera zoom at the playhead" disabled={locked || !raw} onClick={() => edit((o) => ((o.camera ??= []).push({ t: Math.round(p.time * 100) / 100, zoom: 1.2, y: 0.4, ease: 'cut' }), select({ kind: 'camera', index: o.camera.length - 1 })))}>
          <Icon d={I.cam} /> Zoom
        </button>
        <button className="ed-icon-btn" title="Add a shake at the playhead" disabled={locked || !raw} onClick={() => edit((o) => (o.camera ??= []).push({ t: Math.round(p.time * 100) / 100, shake: 14 }))}>
          <Icon d={I.zap} /> Shake
        </button>
        <button
          className="ed-icon-btn"
          title="Delete the selected item (Del)"
          disabled={locked || !selection || selection.kind === 'layer'}
          onClick={() => {
            if (!selection || selection.kind === 'layer') return;
            edit((o) => o[selection.kind].splice(selection.index, 1));
            select(null);
          }}
        >
          <Icon d={I.trash} /> Delete
        </button>
        {locked && <span className="tl-lock">AI is editing. The timeline unlocks when it finishes.</span>}
        <span className="grow" />
        <label className="tl-zoom" title="Timeline zoom">
          <span>−</span>
          <input type="range" min={1} max={12} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
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
              {p.layers.map((l, i) => (
                <button
                  key={i}
                  className={`tl-item tl-layer ${/\p{L}/u.test(l.label) ? '' : 'fx'} ${selection?.kind === 'layer' && selection.index === i ? 'sel' : ''}`}
                  style={{ left: l.start * pps, width: Math.max(6, (l.end - l.start) * pps), top: 7 + layerLanes[i] * 26 }}
                  title={`${l.label} (${l.start.toFixed(2)}s to ${l.end.toFixed(2)}s)`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    select({ kind: 'layer', index: i });
                    p.seek(l.start);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
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
                    onPointerDown={(e) => startDrag(e, 'camera', i, Number(k.t) || 0)}
                  />
                );
              })}
            </div>
          </div>
          <div className="tl-row" style={{ height: 54 }}>
            <div className="tl-head">Video</div>
            <div className="tl-lane">
              {footage && (
                <div className="tl-video" style={{ width: duration * pps }} title={footage}>
                  {thumbs.map((u, i) => (
                    <img key={i} src={u} alt="" draggable={false} />
                  ))}
                  <span className="tl-video-name">{footage.split('/').pop()}</span>
                </div>
              )}
            </div>
          </div>
          <div className="tl-row" style={{ height: 14 + Math.max(1, audio.length) * 24 }}>
            <div className="tl-head">Audio</div>
            <div className="tl-lane">
              {audio.map((a, i) => {
                const start = drag?.kind === 'audio' && drag.index === i ? drag.t : Number(a.start) || 0;
                const len = Math.max(0.15, (lengths[a.file] ?? 0.6) - (Number(a.trimStart) || 0));
                return (
                  <button
                    key={i}
                    className={`tl-item tl-audio ${selection?.kind === 'audio' && selection.index === i ? 'sel' : ''}`}
                    style={{ left: start * pps, width: Math.max(10, len * pps), top: 7 + i * 24 }}
                    title={`${a.file} at ${start}s, volume ${a.volume ?? 1}`}
                    onPointerDown={(e) => startDrag(e, 'audio', i, Number(a.start) || 0)}
                  >
                    {String(a.file).split('/').pop()?.replace(/\.\w+$/, '')}
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

// ---------- side panels ----------
function MediaPanel({ c, raw, p, locked, edit }: { c: AgentController; raw: Raw | null; p: Preview; locked: boolean; edit: (fn: (o: Raw) => void) => void }) {
  const [tab, setTab] = useState<'media' | 'audio' | 'exports'>('media');
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addAudio = (file: string) => edit((o) => (o.audio ??= []).push({ file, start: Math.round(p.time * 100) / 100, volume: 0.35 }));

  const importFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const names = await addInputFiles(c.meta, [...list], setNote);
      setNote(`Added ${names.join(', ')}. Ask the AI to use ${names.length > 1 ? 'them' : 'it'}, or set a video as the main clip.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside className="ed-left">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['media', 'Media'],
          ['audio', 'Sound FX'],
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
                const video = /\.(mp4|m4v|mov|webm|mkv)$/i.test(name);
                const sound = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(name);
                return (
                  <div key={name} className={`ed-media ${raw?.footage === path ? 'main' : ''}`}>
                    <MediaThumb projectId={c.meta.id} path={path} />
                    <span className="ed-media-name" title={name}>{name}</span>
                    <div className="ed-media-actions">
                      {video && raw && raw.footage !== path && (
                        <button disabled={locked} onClick={() => edit((o) => (o.footage = path))}>Use as main</button>
                      )}
                      {video && raw?.footage === path && <span className="ed-badge">Main clip</span>}
                      {sound && raw && <button disabled={locked} onClick={() => addAudio(path)}>Add at playhead</button>}
                      <button onClick={() => askAi(c.meta.id, `Use ${path} in the video: `)}>Ask AI</button>
                    </div>
                  </div>
                );
              })}
              {c.meta.inputs.length === 0 && <p className="hint">Import footage, voice, logos or screenshots.</p>}
            </div>
          </>
        )}
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

function AdjustPanel({ raw, locked, edit }: { raw: Raw | null; locked: boolean; edit: (fn: (o: Raw) => void) => void }) {
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
      <p className="hint">The look applies to the footage only. Captions and effects stay as designed.</p>
    </div>
  );
}

function PropsPanel({ raw, p, selection, locked, edit, projectId }: { raw: Raw | null; p: Preview; selection: Selection; locked: boolean; edit: (fn: (o: Raw) => void) => void; projectId: string }) {
  if (!raw || !selection) return <p className="hint">Select a camera key, sound clip or text block on the timeline.</p>;
  if (selection.kind === 'layer') {
    const l = p.layers[selection.index];
    if (!l) return null;
    return (
      <div className="ed-props">
        <h3>Text & effect</h3>
        <p className="ed-quote">“{l.label}”</p>
        <p className="hint">
          {l.start.toFixed(2)}s to {l.end.toFixed(2)}s
        </p>
        <button className="btn" onClick={() => askAi(projectId, `Change the "${l.label}" part (${l.start.toFixed(2)}s to ${l.end.toFixed(2)}s): `)}>Ask AI to change it</button>
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

function ExportDialog({ c, onClose }: { c: AgentController; onClose: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [side, setSide] = useState(settings.exportShortSide);
  const [done, setDone] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
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
            <p className="hint">H.264 MP4 with AAC sound, made on this PC.</p>
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
            {c.renderInfo ? <RenderBar info={c.renderInfo} /> : <p className="hint">Preparing...</p>}
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

function Editor({ c, onDeleted }: { c: AgentController; onDeleted: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const p = useMemo(() => new Preview(c.meta.id), [c]);
  useSyncExternalStore(p.subscribe, p.getShape);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [rightTab, setRightTab] = useState<'ai' | 'adjust' | 'props'>('ai');
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const undo = useRef<string[]>([]);
  const status = c.working ? 'working' : c.meta.status;
  const locked = c.working;

  const reload = useCallback(async () => {
    setRaw(await readRaw(c.meta.id));
    await p.load();
  }, [c, p]);

  useEffect(() => {
    void reload();
    return () => p.destroy();
  }, [p, reload]);

  // When the AI finishes a turn, show what it made.
  const wasWorking = useRef(c.working);
  useEffect(() => {
    if (wasWorking.current && !c.working) void reload();
    wasWorking.current = c.working;
  }, [c.working, reload]);

  const edit = useCallback(
    (fn: (o: Raw) => void) => {
      if (!raw || c.working) return;
      undo.current.push(JSON.stringify(raw));
      if (undo.current.length > 100) undo.current.shift();
      const next = JSON.parse(JSON.stringify(raw));
      fn(next);
      setRaw(next);
      void writeRaw(c.meta.id, next).then(() => p.reloadConfig());
    },
    [raw, c, p],
  );

  const undoLast = useCallback(() => {
    const prev = undo.current.pop();
    if (!prev || c.working) return;
    const o = JSON.parse(prev);
    setRaw(o);
    setSelection(null);
    void writeRaw(c.meta.id, o).then(() => p.reloadConfig());
  }, [c, p]);

  const select = (s: Selection) => {
    setSelection(s);
    if (s) setRightTab('props');
  };

  // Keyboard: Space plays, Delete removes, Ctrl+Z undoes, arrows step a frame.
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
        undoLast();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection && selection.kind !== 'layer' && !c.working) {
        edit((o) => o[selection.kind].splice(selection.index, 1));
        setSelection(null);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [p, selection, edit, undoLast, c]);

  const right: ReactNode =
    rightTab === 'ai' ? (
      <Conversation c={c} />
    ) : (
      <div className="ed-panel-body">{rightTab === 'adjust' ? <AdjustPanel raw={raw} locked={locked} edit={edit} /> : <PropsPanel raw={raw} p={p} selection={selection} locked={locked} edit={edit} projectId={c.meta.id} />}</div>
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
        <button className="ed-icon-btn" title="Undo (Ctrl+Z)" disabled={locked || undo.current.length === 0} onClick={undoLast}>
          <Icon d={I.undo} />
        </button>
        {desktop && (
          <button className="ed-icon-btn" title="Open the project folder" onClick={() => desktop!.reveal(c.meta.id)}>
            <Icon d={I.folder} />
          </button>
        )}
        {confirmDelete ? (
          <>
            <button
              className="btn text bad"
              onClick={async () => {
                p.destroy();
                AgentController.forget(c.meta.id);
                await deleteProject(c.meta.id);
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
      <MediaPanel c={c} raw={raw} p={p} locked={locked} edit={edit} />
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
          ]}
        />
        {right}
      </aside>
      <section className="ed-timeline">
        <Timeline p={p} raw={raw} locked={locked} selection={selection} select={select} edit={edit} projectId={c.meta.id} />
      </section>
      {exporting && <ExportDialog c={c} onClose={() => setExporting(false)} />}
    </div>
  );
}
