// The desktop app's frame: a header with Back and the page's name on every screen, and a bottom navigation bar.
import { useEffect, useState, type ReactNode } from 'react';
import { desktop, ENGINE_LABEL } from '../lib/desktop';
import { settings } from '../lib/store';
import { Logo } from '../ui';

const go = (route: string) => {
  location.hash = route;
};

export function NavIcon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const NAV_ICONS = {
  back: 'M15 18l-6-6 6-6',
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  projects: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  create: 'M12 5v14M5 12h14',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4',
};

/** What the app runs on, shown quietly in the bottom bar. */
function useStatus() {
  const [gpu, setGpu] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.info().then((i) => {
      const enc = i.media.encoder ?? '';
      setGpu(enc.includes('qsv') ? 'Intel Quick Sync' : enc.includes('nvenc') ? 'NVIDIA NVENC' : enc.includes('amf') ? 'AMD AMF' : enc ? 'CPU encoder' : null);
    });
  }, []);
  return gpu;
}

export function BottomNav({ route, compact = false }: { route: string; compact?: boolean }) {
  const gpu = useStatus();
  // A project open in the editor belongs to Projects.
  const at = (r: string) => (r === '/' ? route === '/' : route.startsWith(r) || (r === '/projects' && route.startsWith('/p/')));
  const item = (r: string, label: string, icon: string) => (
    <a className={`bn-item ${at(r) ? 'on' : ''}`} href={`#${r}`} aria-current={at(r) ? 'page' : undefined}>
      <NavIcon d={icon} size={compact ? 18 : 20} />
      <span>{label}</span>
    </a>
  );
  return (
    <nav className={`bn ${compact ? 'compact' : ''}`} aria-label="Main">
      <div className="bn-side">
        <span className="bn-dot" />
        <span>{ENGINE_LABEL[settings.engine] ?? settings.engine}</span>
      </div>
      <div className="bn-items">
        {item('/', 'Home', NAV_ICONS.home)}
        {item('/projects', 'Projects', NAV_ICONS.projects)}
        <a className={`bn-create ${at('/new') ? 'on' : ''}`} href="#/new" title="Create project">
          <NavIcon d={NAV_ICONS.create} size={compact ? 18 : 22} />
          {!compact && <span>Create</span>}
        </a>
        {item('/settings', 'Settings', NAV_ICONS.settings)}
      </div>
      <div className="bn-side right">{gpu && <span title="Video encoding on this PC">GPU: {gpu}</span>}</div>
    </nav>
  );
}

export function TopBar({ title, back, right }: { title: ReactNode; back: string | null; right?: ReactNode }) {
  return (
    <header className="tb">
      <button className="tb-back" disabled={!back} onClick={() => back && go(back)} title="Back" aria-label="Back">
        <NavIcon d={NAV_ICONS.back} />
      </button>
      <a className="tb-brand" href="#/" title="Home">
        <Logo size={28} />
        <span>
          ReelForge <em>AI</em>
        </span>
      </a>
      <span className="tb-sep" />
      <h1 className="tb-title">{title}</h1>
      <span className="grow" />
      {right}
    </header>
  );
}

/** A full desktop page: header, scrolling body, bottom navigation. */
export function Shell({ route, title, back, right, children, wide = false }: { route: string; title: ReactNode; back: string | null; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="dk">
      <TopBar title={title} back={back} right={right} />
      <main className={`dk-body ${wide ? 'wide' : ''}`}>{children}</main>
      <BottomNav route={route} />
    </div>
  );
}
