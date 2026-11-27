import { useCallback, useEffect, useState } from 'react';
import { AgentController } from './lib/agent';
import { browserProblem } from './lib/render';
import { kvGet, kvSet } from './lib/db';
import { engineReady, listProjects, loadSettings, saveProject, type ProjectMeta } from './lib/store';
import { desktop, ENGINE_LABEL } from './lib/desktop';
import { settings } from './lib/store';
import { Logo, StatusDot, money, statusLabel } from './ui';
import { CONTENT_TYPES } from './lib/agent';
import { SetupScreen, SettingsScreen } from './screens/Settings';
import { NewVideoScreen } from './screens/NewVideo';
import { ProjectScreen } from './screens/Project';
import { EditorScreen } from './screens/Editor';
import { HomeScreen } from './screens/Home';

const useRoute = () => {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
};

export const go = (route: string) => {
  location.hash = route;
};

/** A job can't still be running in a freshly opened page, so don't show it as working forever. */
async function recoverInterrupted(projects: ProjectMeta[]) {
  for (const p of projects) {
    if (p.status !== 'working' || AgentController.peek(p.id)) continue;
    p.status = 'stopped';
    const events = (await kvGet<unknown[]>(`events:${p.id}`)) ?? [];
    await kvSet(`events:${p.id}`, [...events, { kind: 'notice', text: desktop ? 'ReelForge closed while this was working. Press Continue to carry on.' : 'The page closed while this was working. Press Continue to carry on.' }]);
    await saveProject(p);
  }
}

export function App() {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [, repaint] = useState(0);

  const reload = useCallback(async () => setProjects(await listProjects()), []);

  useEffect(() => {
    (async () => {
      await loadSettings();
      const all = await listProjects();
      await recoverInterrupted(all);
      setProjects(all);
      setHasKey(engineReady());
      setProblem(await browserProblem());
      setReady(true);
    })();
  }, []);

  // Status dots and costs in the list follow whatever is running.
  useEffect(() => {
    let last = 0;
    AgentController.onAnyChange = () => {
      const now = performance.now();
      if (now - last > 500) {
        last = now;
        repaint((n) => n + 1);
      }
    };
    return () => {
      AgentController.onAnyChange = null;
    };
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (AgentController.anyWorking()) e.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, []);

  if (!ready) return <div className="boot" aria-label="Loading" />;
  if (!hasKey) return <SetupScreen onDone={() => setHasKey(true)} />;

  const projectId = route.startsWith('/p/') ? route.slice(3) : null;
  const project = projects.find((p) => p.id === projectId);
  const atList = route === '/';

  // The desktop app is laid out like a video editor: a home screen, then a full-window editor per project.
  if (desktop) {
    if (route === '/new' || route === '/settings')
      return (
        <div className="desk-page">
          {problem && <div className="banner">{problem}</div>}
          {route === '/new' ? (
            <NewVideoScreen
              onCreated={async (meta) => {
                await reload();
                go(`/p/${meta.id}`);
              }}
            />
          ) : (
            <SettingsScreen />
          )}
        </div>
      );
    if (project)
      return (
        <EditorScreen
          key={project.id}
          meta={project}
          onDeleted={async () => {
            await reload();
            go('/');
          }}
        />
      );
    return <HomeScreen projects={projects} />;
  }

  return (
    <div className={`shell ${atList ? 'at-list' : 'at-detail'}`}>
      <aside className="sidebar">
        <header className="side-head">
          <a className="brand" href="#/">
            <Logo size={30} />
            <span>ReelForge</span>
          </a>
          <a className="icon-btn" href="#/settings" aria-label="Settings" title="Settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="8" cy="17" r="2" />
            </svg>
          </a>
        </header>
        <a className="btn primary new-btn" href="#/new">
          <span aria-hidden="true">+</span> New video
        </a>
        <nav className="project-list" aria-label="Your videos">
          {projects.length === 0 && <p className="empty small">Your videos will appear here.</p>}
          {projects.map((stored) => {
            const live = AgentController.peek(stored.id);
            const p = live?.meta ?? stored;
            const status = live?.working ? 'working' : p.status;
            return (
              <a key={p.id} className={`project-row ${p.id === projectId ? 'on' : ''}`} href={`#/p/${p.id}`}>
                <StatusDot status={status} />
                <span className="project-text">
                  <span className="project-name">{p.name}</span>
                  <span className="project-sub">
                    {statusLabel(status)} · {CONTENT_TYPES[p.type]?.title}
                  </span>
                </span>
                {(p.costUsd > 0 || settings.engine === 'api') && <span className="project-cost">{money(p.costUsd)}</span>}
              </a>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        {problem && <div className="banner">{problem}</div>}
        {route === '/new' ? (
          <NewVideoScreen
            onCreated={async (meta) => {
              await reload();
              go(`/p/${meta.id}`);
            }}
          />
        ) : route === '/settings' ? (
          <SettingsScreen />
        ) : project ? (
          <ProjectScreen
            key={project.id}
            meta={project}
            onDeleted={async () => {
              await reload();
              go('/');
            }}
          />
        ) : (
          <div className="welcome">
            <Logo size={56} />
            <h1>{projectId ? "This video isn't here" : 'Describe a video. Get a finished MP4.'}</h1>
            <p>{desktop ? `Edit footage, or make a promo, SaaS explainer or tournament video. It all runs on this PC, made by ${ENGINE_LABEL[settings.engine] ?? 'your AI'}.` : 'Edit footage, or make a promo, SaaS explainer or tournament video. It all runs in this browser, using your own API key.'}</p>
            <a className="btn primary" href="#/new">
              New video
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
