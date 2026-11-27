import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AgentController, type FeedEvent } from '../lib/agent';
import { fileGet } from '../lib/db';
import type { RenderProgress } from '../lib/render';
import { addInputFiles, deleteProject, type ProjectMeta } from '../lib/store';
import { BackLink, FileThumb, Markdown, StatusPill, money, sizeLabel } from '../ui';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { settings } from '../lib/store';

type Item = { kind: 'event'; event: FeedEvent } | { kind: 'tools'; tools: FeedEvent[] };

/** Runs of tool lines collapse into one quiet block. */
function group(events: FeedEvent[]): Item[] {
  const out: Item[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (event.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(event);
      else out.push({ kind: 'tools', tools: [event] });
    } else out.push({ kind: 'event', event });
  }
  return out;
}

const ToolBlock = ({ tools }: { tools: FeedEvent[] }) => {
  const shown = tools.slice(-4);
  return (
    <div className="tools">
      {tools.length > 4 && <div className="tool-more">{tools.length - 4} earlier steps</div>}
      {shown.map((t, i) => (
        <div className="tool-line" key={i}>
          <span>{t.text}</span>
          {t.detail && <span className="tool-detail">{t.detail}</span>}
        </div>
      ))}
    </div>
  );
};

const EventView = memo(function EventView({ event }: { event: FeedEvent }) {
  if (event.kind === 'user') return <div className="bubble">{event.text}</div>;
  if (event.kind === 'agent') return <Markdown text={event.text} />;
  return <p className={`note ${event.kind === 'error' ? 'bad' : ''}`}>{event.text}</p>;
});

export function RenderBar({ info }: { info: RenderProgress }) {
  const fraction = info.stage === 'frames' && info.total ? info.done / info.total : info.stage === 'finishing' ? 1 : null;
  let label = 'Mixing the sound';
  if (info.stage === 'finishing') label = 'Finishing the file';
  if (info.stage === 'frames') {
    const elapsed = (Date.now() - info.startedAt) / 1000;
    const left = info.done > 5 ? Math.round((elapsed / info.done) * (info.total - info.done)) : null;
    label = `Rendering ${info.done} of ${info.total} frames${left !== null ? `, about ${Math.floor(left / 60)}m ${left % 60}s left` : ''}`;
  }
  return (
    <div className="render-bar">
      <span>{label}</span>
      <progress max={1} value={fraction ?? undefined} aria-label="Render progress" />
      <span className="hint">{desktop ? 'Keep ReelForge open. Closing it stops the render.' : 'Keep this tab open. Closing it stops the render.'}</span>
    </div>
  );
}

export function VideoPanel({ projectId, name, outputs }: { projectId: string; name: string; outputs: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const current = selected && outputs.includes(selected) ? selected : outputs[0];

  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    setError(false);
    if (desktop) {
      setUrl(`${desktop.fileUrl(projectId, current)}?v=${Date.now()}`);
      return;
    }
    fileGet(projectId, current).then((blob) => {
      if (revoked || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [projectId, current]);

  const fileName = `${name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'video'}-${/video-(\d+)/.exec(current)?.[1] ?? 1}.mp4`;

  return (
    <div className="video-panel">
      {error ? <p className="note">This browser can't play this video. You can still download it.</p> : url && <video key={url} src={url} controls playsInline onError={() => setError(true)} />}
      <div className="video-actions">
        {outputs.length > 1 && (
          <select aria-label="Version" value={current} onChange={(e) => setSelected(e.target.value)}>
            {outputs.map((o) => (
              <option key={o} value={o}>Version {/video-(\d+)/.exec(o)?.[1]}</option>
            ))}
          </select>
        )}
        {desktop ? (
          <>
            <button className="btn primary grow" onClick={() => desktop!.saveAs(projectId, current, fileName)}>Save MP4 as...</button>
            <button className="btn" title="Show the file in its folder" onClick={() => desktop!.reveal(projectId, current)}>Show in folder</button>
          </>
        ) : (
          url && <a className="btn primary grow" href={url} download={fileName}>Download MP4</a>
        )}
      </div>
    </div>
  );
}

export function ProjectScreen({ meta, onDeleted }: { meta: ProjectMeta; onDeleted: () => void }) {
  const [c, setC] = useState<AgentController | null>(null);
  useEffect(() => {
    AgentController.of(meta).then(setC);
  }, [meta]);
  if (!c) return <div className="page" />;
  return <ProjectBody c={c} onDeleted={onDeleted} />;
}

export function Conversation({ c }: { c: AgentController }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [box, setBox] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const items = useMemo(() => group(c.events), [c.events]);
  const status = c.working ? 'working' : c.meta.status;

  // Other parts of the app (the editor's "Ask AI" buttons) can put text in the box.
  useEffect(() => {
    const onDraft = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail;
      if (d.id === c.meta.id) setBox(d.text);
    };
    addEventListener('rf-draft', onDraft);
    return () => removeEventListener('rf-draft', onDraft);
  }, [c]);

  // Follows new messages, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  });

  // The feed also changes size when the video loads above it or the window changes.
  useEffect(() => {
    const el = feed.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const addFiles = (list: FileList | null) => {
    if (list?.length) setFiles((f) => [...f, ...list]);
  };

  const send = async (text: string) => {
    const value = text.trim();
    if ((!value && files.length === 0) || c.working) return;
    stuck.current = true;
    setBox('');
    const attached = files;
    setFiles([]);
    let display = value;
    let prompt = value;
    if (attached.length) {
      let names: string[];
      try {
        names = await addInputFiles(c.meta, attached, setImportNote);
      } catch (err) {
        setImportNote(err instanceof Error ? err.message : String(err));
        return;
      }
      setImportNote(null);
      const noun = names.length > 1 ? 'files' : 'file';
      display = [value, `📎 ${names.join(', ')}`].filter(Boolean).join('\n');
      prompt = [value, `I added ${names.length} ${noun} to the project: ${names.map((n) => `input/${n}`).join(', ')}. Look at ${names.length > 1 ? 'them' : 'it'} before continuing.`].filter(Boolean).join('\n\n');
    }
    void c.send(display, prompt);
  };

  const quick = status === 'waiting' ? ['Approve and continue', 'Looks good. Go ahead.'] : status === 'done' ? ['What can be improved?', 'Go through the finished video again and tell me what can be improved.'] : status === 'error' || status === 'stopped' ? ['Continue', 'Continue from where you stopped.'] : null;

  return (
  <div className="conversation">
    <div
      className="feed"
      ref={feed}
      onScroll={(e) => {
        const el = e.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {items.map((item, i) => (
        <div className="feed-item" key={i}>
          {item.kind === 'tools' ? <ToolBlock tools={item.tools} /> : <EventView event={item.event} />}
        </div>
      ))}
      {c.liveText && <Markdown text={c.liveText} />}
      {c.working && !c.liveText && !c.renderInfo && <div className="thinking" aria-label="Working"><i /><i /><i /></div>}
    </div>
    {importNote && <p className="note import-note" role="status">{importNote}</p>}
    {quick && !c.working && (
      <div className="quick">
        <button className="btn small-btn" onClick={() => send(quick[1])}>{quick[0]}</button>
      </div>
    )}
    <form
      className={`composer ${dragging ? 'drag' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        send(box);
      }}
      onDragOver={(e) => {
        if (c.working) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!c.working) addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f, i) => (
            <span className="attach-chip" key={`${f.name}${i}`}>
              <FileThumb file={f} />
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">{sizeLabel(f.size)}</span>
              <button type="button" className="attach-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="icon-btn attach-btn" aria-label="Attach files" title="Attach footage, voice, logo or screenshots" disabled={c.working} onClick={() => fileInput.current?.click()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8" />
          </svg>
        </button>
        <textarea
          rows={1}
          aria-label="Reply"
          placeholder="Reply, ask for a change, or attach a file"
          value={box}
          onChange={(e) => setBox(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(box);
            }
          }}
        />
        <button className="send" aria-label="Send" disabled={c.working || (!box.trim() && files.length === 0)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </div>
    </form>
  </div>
  );
}

function ProjectBody({ c, onDeleted }: { c: AgentController; onDeleted: () => void }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [confirming, setConfirming] = useState(false);
  const status = c.working ? 'working' : c.meta.status;

  return (
    <div className={`project ${c.outputs.length ? 'has-video' : ''}`}>
      <header className="project-head">
        <BackLink label="Videos" />
        <h1 title={c.meta.name}>{c.meta.name}</h1>
        <div className="head-status" role="status">
          <StatusPill status={status} />
          {desktop && settings.engine !== 'api' ? <span className="cost">{ENGINE_LABEL[settings.engine]}</span> : <span className="cost">{money(c.meta.costUsd)}</span>}
          {desktop && <button className="btn text muted" title="Open this project's folder" onClick={() => desktop!.reveal(c.meta.id)}>Folder</button>}
          {c.working ? (
            <button className="btn text bad" onClick={() => c.stop()}>Stop</button>
          ) : confirming ? (
            <>
              <button
                className="btn text bad"
                onClick={async () => {
                  AgentController.forget(c.meta.id);
                  await deleteProject(c.meta.id);
                  onDeleted();
                }}
              >
                Confirm delete
              </button>
              <button className="btn text" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <button className="btn text muted" onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      </header>
      {c.renderInfo && <RenderBar info={c.renderInfo} />}
      <div className="project-grid">
        {c.outputs.length > 0 && <VideoPanel projectId={c.meta.id} name={c.meta.name} outputs={c.outputs} />}
        <Conversation c={c} />
      </div>
    </div>
  );
}

