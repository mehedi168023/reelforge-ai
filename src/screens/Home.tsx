// The desktop home and project list: start something new, or pick up where you left off.
import { useEffect, useMemo, useState } from 'react';
import { AgentController, CONTENT_TYPES } from '../lib/agent';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { settings, type ProjectMeta } from '../lib/store';
import { Logo, StatusDot, statusLabel } from '../ui';
import { NavIcon } from './Shell';

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
  return src ? <video className="pc-cover" src={`${src}#t=1`} muted preload="metadata" /> : <div className="pc-cover ph"><Logo size={40} /></div>;
}

export const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d} d ago` : new Date(ms).toLocaleDateString();
};

function ProjectCard({ stored }: { stored: ProjectMeta }) {
  const live = AgentController.peek(stored.id);
  const p = live?.meta ?? stored;
  const status = live?.working ? 'working' : p.status;
  return (
    <a className="pc" href={`#/p/${p.id}`}>
      <div className="pc-media">
        <Cover p={p} />
        <span className={`pc-status ${status}`}>
          <StatusDot status={status} /> {statusLabel(status)}
        </span>
      </div>
      <span className="pc-text">
        <span className="pc-name">{p.name}</span>
        <span className="pc-sub">
          {CONTENT_TYPES[p.type]?.title} · {ago(p.updatedAt)}
        </span>
      </span>
    </a>
  );
}

const QUICK: [string, string, string, string][] = [
  ['edit', 'Edit footage', 'Captions, effects, colour and sound on your clip.', 'M4 6h12v12H4zM16 10l4-2v8l-4-2'],
  ['promo', 'Promo from a script', 'Your script becomes an animated film.', 'M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h5'],
  ['saas', 'App explainer', 'Show what a product does, scene by scene.', 'M3 5h18v12H3zM8 21h8M12 17v4'],
  ['tournament', 'Event or tournament', 'Hype announcements, prizes and results.', 'M8 4h8v5a4 4 0 0 1-8 0zM5 5H3a3 3 0 0 0 5 3M19 5h2a3 3 0 0 1-5 3M10 16h4M9 20h6M12 13v3'],
];

export function HomeScreen({ projects }: { projects: ProjectMeta[] }) {
  const working = projects.filter((p) => AgentController.peek(p.id)?.working || p.status === 'working').length;
  const done = projects.filter((p) => p.status === 'done').length;
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="pg">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">{hello}</p>
          <h2>What are we making today?</h2>
          <p className="muted">Drop in footage or a script. {ENGINE_LABEL[settings.engine] ?? 'Your AI'} edits it, then you fine-tune on the timeline.</p>
          <div className="hero-actions">
            <a className="btn primary lg" href="#/new">
              <NavIcon d="M12 5v14M5 12h14" /> Create project
            </a>
            <a className="btn lg" href="#/projects">
              Open a project
            </a>
          </div>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <strong>{projects.length}</strong>
            <span>Projects</span>
          </div>
          <div className="stat">
            <strong>{done}</strong>
            <span>Finished</span>
          </div>
          <div className="stat">
            <strong>{working}</strong>
            <span>Working now</span>
          </div>
        </div>
      </section>

      <section className="blk">
        <div className="blk-head">
          <h3>Start from</h3>
        </div>
        <div className="quickstart">
          {QUICK.map(([type, title, sub, icon]) => (
            <a key={type} className="qc" href={`#/new?type=${type}`}>
              <span className="qc-icon">
                <NavIcon d={icon} size={22} />
              </span>
              <strong>{title}</strong>
              <span className="muted">{sub}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="blk">
        <div className="blk-head">
          <h3>Recent projects</h3>
          {projects.length > 0 && (
            <a className="link" href="#/projects">
              See all ›
            </a>
          )}
        </div>
        {projects.length === 0 ? (
          <div className="empty-box">
            <Logo size={44} />
            <p>No projects yet. Create one to see it here.</p>
          </div>
        ) : (
          <div className="pgrid">
            {projects.slice(0, 8).map((p) => (
              <ProjectCard key={p.id} stored={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectsScreen({ projects }: { projects: ProjectMeta[] }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name' | 'created'>('recent');
  const [filter, setFilter] = useState<'all' | 'done' | 'working' | 'waiting'>('all');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (filter === 'all' || p.status === filter || (filter === 'working' && AgentController.peek(p.id)?.working)));
    return [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
  }, [projects, query, sort, filter]);
  return (
    <div className="pg">
      <div className="toolbar">
        <label className="search">
          <NavIcon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" size={18} />
          <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="chips" role="radiogroup" aria-label="Status">
          {(
            [
              ['all', 'All'],
              ['done', 'Finished'],
              ['waiting', 'Needs you'],
              ['working', 'Working'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="radio" aria-checked={filter === id} className={`chip ${filter === id ? 'on' : ''}`} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="recent">Last edited</option>
          <option value="created">Newest</option>
          <option value="name">Name</option>
        </select>
      </div>
      {shown.length === 0 ? (
        <div className="empty-box">
          <Logo size={44} />
          <p>{projects.length ? 'No projects match.' : 'No projects yet.'}</p>
          <a className="btn primary" href="#/new">
            Create project
          </a>
        </div>
      ) : (
        <div className="pgrid">
          {shown.map((p) => (
            <ProjectCard key={p.id} stored={p} />
          ))}
        </div>
      )}
    </div>
  );
}
