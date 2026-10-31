import { useEffect, useState } from 'react';
import { api, ToolName } from './api';
import { usePoll } from './hooks';
import { OverlayProvider } from './components/overlay';
import Minibar from './components/Minibar';
import Home from './views/Home';
import SubjectView from './views/SubjectView';
import SettingsView from './views/SettingsView';

/** `launch` opens a create-content form in the chat (from a topic's Create menu). */
export type Launch = { tool: ToolName; topicId: number | null; nonce: number };

export type Route =
  | { name: 'home' }
  | { name: 'subject'; id: number; launch?: Launch }
  | { name: 'settings' };

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const subjects = usePoll(api.subjects, 0);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  /** Which parts run on OpenRouter (shown as a warning badge in the minibar; data leaves the computer). */
  const [online, setOnline] = useState<string[]>([]);
  const loadProvider = () => api.settings()
    .then((s) => setOnline([s.llm_provider === 'openrouter' && 'chat', s.embed_provider === 'openrouter' && 'embeddings'].filter(Boolean) as string[]))
    .catch(() => {});

  useEffect(() => {
    let alive = true;
    const check = () => api.health().then(() => alive && setBackendUp(true)).catch(() => alive && setBackendUp(false));
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => { if (backendUp) { subjects.reload(); loadProvider(); } }, [backendUp]); // eslint-disable-line react-hooks/exhaustive-deps

  // While files are being re-ingested for a new embedding model, keep the warning marks current.
  const staleCount = (subjects.data ?? []).reduce((n, s) => n + (s.stale_docs ?? 0), 0);
  useEffect(() => {
    if (!staleCount) return;
    const t = setInterval(() => subjects.reload(), 5000);
    return () => clearInterval(t);
  }, [staleCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (r: Route) => setRoute(r);
  const refresh = () => { subjects.reload(); loadProvider(); };
  const list = subjects.data ?? [];

  let view;
  switch (route.name) {
    case 'home':
      view = <Home key="home" subjects={list} go={go} onChange={refresh} online={online} />;
      break;
    case 'subject':
      view = <SubjectView key={route.id} route={route} subjects={list} go={go} onChange={refresh} />;
      break;
    case 'settings':
      view = <SettingsView key="settings" onSaved={refresh} />;
      break;
  }

  return (
    <OverlayProvider>
      <div className="app">
        <div className="app-backdrop" aria-hidden />
        <Minibar subjects={list} route={route} go={go} onChange={refresh} online={online} />
        <main className={`main${route.name === 'subject' ? ' main-subject' : ''}`}>
          {backendUp === false && (
            <div className="banner banner-bad">Local backend is not responding. Restart the app if this persists.</div>
          )}
          {view}
        </main>
      </div>
    </OverlayProvider>
  );
}
