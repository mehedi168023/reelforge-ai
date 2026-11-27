// The desktop home: a big Create button, then every project as a card with a frame from its video.
import { useEffect, useState } from 'react';
import { AgentController, CONTENT_TYPES } from '../lib/agent';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { settings, type ProjectMeta } from '../lib/store';
import { Logo, StatusDot, statusLabel } from '../ui';

function Cover({ p }: { p: ProjectMeta }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void desktop.list(p.id).then((files) => {
      const n = (f: string) => Number(/video-(\d+)/.exec(f)?.[1] ?? 0);
      const render = files.filter((f) => /^renders\/video-\d+\.mp4$/.test(f)).sort((a, b) => n(b) - n(a))[0];
      const input = files.find((f) => /^input\/.+\.(mp4|m4v|mov|webm|mkv)$/i.test(f));
      const pick = render ?? input;
      if (pick) setSrc(desktop!.fileUrl(p.id, pick));
    });
  }, [p.id, p.updatedAt]);
  return src ? <video className="home-cover" src={`${src}#t=1`} muted preload="metadata" /> : <div className="home-cover ph"><Logo size={40} /></div>;
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
};

export function HomeScreen({ projects }: { projects: ProjectMeta[] }) {
  return (
    <div className="home">
      <header className="home-top">
        <div className="home-brand">
          <Logo size={34} />
          <span>
            ReelForge <em>AI</em>
          </span>
        </div>
        <span className="grow" />
        <a className="ed-chip" href="#/settings" title="Change the AI in Settings">
          AI: {ENGINE_LABEL[settings.engine] ?? settings.engine}
        </a>
        <a className="ed-icon-btn" href="#/settings" title="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
        </a>
      </header>
      <div className="home-body">
        <a className="home-create" href="#/new">
          <span className="home-plus">+</span>
          <span>
            <strong>Create project</strong>
            <span className="hint">Drop in footage or a script. The AI edits it with captions, effects, sound and colour, then you fine-tune on the timeline.</span>
          </span>
        </a>
        <h2 className="home-h">Projects</h2>
        {projects.length === 0 && <p className="hint">Your projects appear here.</p>}
        <div className="home-grid">
          {projects.map((stored) => {
            const live = AgentController.peek(stored.id);
            const p = live?.meta ?? stored;
            const status = live?.working ? 'working' : p.status;
            return (
              <a key={p.id} className="home-card project-row" href={`#/p/${p.id}`}>
                <Cover p={p} />
                <span className="home-card-text">
                  <span className="home-card-name">{p.name}</span>
                  <span className="hint">
                    <StatusDot status={status} /> {statusLabel(status)} · {CONTENT_TYPES[p.type]?.title} · {ago(p.updatedAt)}
                  </span>
                </span>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
