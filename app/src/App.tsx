import { useCallback, useEffect, useRef, useState } from 'react';
import { api, hasToken, ToolName } from './api';
import { usePoll } from './hooks';
import { OverlayProvider } from './components/overlay';
import Minibar from './components/Minibar';
import Ambient from './components/Ambient';
import TooltipLayer from './components/Tooltip';
import FindLayer from './components/FindBar';
import CalculatorLayer from './components/Calculator';
import PetLayer from './components/Pet';
import ErrorBoundary from './components/ErrorBoundary';
import Home from './views/Home';
import SubjectView from './views/SubjectView';
import SettingsView from './views/SettingsView';
import { logError } from './log';
import { ToastLayer } from './components/toast';
import CommandPalette from './components/CommandPalette';
import { installUndoKeys, isApplying, undoable } from './undo';
import { currentView, OpenRequest, registerRouter, ViewSnap } from './viewHistory';
import SetupWizard, { openSetup } from './components/SetupWizard';
import Tour from './components/Tour';
import Icon from './components/Icon';
import ErrorText, { ErrorCode, ErrorHelpLayer } from './components/ErrorText';
import { splitError } from './errors';

/** `launch` opens a create-content form in the chat (from a topic's Create menu). */
export type Launch = { tool: ToolName; topicId: number | null; nonce: number };

export type Route =
  | { name: 'home' }
  /** `view`: what to show on arrival (undo going back to a subject); `open`: something to open there (Ctrl+K). */
  | { name: 'subject'; id: number; launch?: Launch; view?: ViewSnap; open?: OpenRequest }
  | { name: 'settings'; tab?: SettingsTab; subjectId?: number };
export type SettingsTab = 'general' | 'maintenance' | 'share';

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const subjects = usePoll(api.subjects, 1000, [], ['subjects', 'documents']);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  /** Which parts run on OpenRouter (shown as a warning badge in the minibar; data leaves the computer). */
  const [online, setOnline] = useState<string[]>([]);
  const [setupDone, setSetupDone] = useState(false);
  const loadProvider = () => api.settings()
    .then((s) => {
      setOnline([s.llm_provider === 'openrouter' && 'chat', s.embed_provider === 'openrouter' && 'embeddings'].filter(Boolean) as string[]);
      setSetupDone(!!s.setup_done);
    })
    .catch((e) => logError('settings', e, 'warning'));

  useEffect(() => {
    let alive = true;
    const check = () => api.health().then((h) => { if (alive) { setBackendUp(true); setNeedsToken(h.auth && !hasToken); } })
      .catch(() => alive && setBackendUp(false));
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => { if (backendUp) { subjects.reload(); loadProvider(); } }, [backendUp]); // eslint-disable-line react-hooks/exhaustive-deps


  // Every change of page is one undo step: going back restores the subject with what it was showing.
  const routeRef = useRef(route);
  routeRef.current = route;
  const go = useCallback((r: Route) => {
    const prev = routeRef.current;
    const same = prev.name === r.name && (prev.name !== 'subject' || (r.name === 'subject' && prev.id === r.id))
      && (prev.name !== 'settings' || (r.name === 'settings' && prev.tab === r.tab));
    if (same && r.name === 'subject' && (r.open || r.launch)) { setRoute(r); return; }
    if (same) return;
    const back: Route = prev.name === 'subject' ? { name: 'subject', id: prev.id, view: currentView.get(prev.id) } : prev;
    setRoute(r);
    if (isApplying()) return;
    const where = (x: Route) => (x.name === 'home' ? 'all subjects' : x.name === 'settings' ? 'settings'
      : subjectsRef.current.find((s) => s.id === x.id)?.name ?? 'a subject');
    const forward: Route = r.name === 'subject' ? { name: 'subject', id: r.id } : r;
    undoable({ kind: 'nav', label: `go to ${where(r)}`, undo: () => setRoute(back),
      redo: () => setRoute(forward.name === 'subject' ? { ...forward, view: currentView.get(forward.id) } : forward) });
  }, []);
  const subjectsRef = useRef<{ id: number; name: string }[]>([]);
  subjectsRef.current = subjects.data ?? [];
  useEffect(() => {
    registerRouter((id, view) => setRoute({ name: 'subject', id, view }));
    return installUndoKeys();
  }, []);
  const refresh = () => { subjects.reload(); loadProvider(); };
  const list = subjects.data ?? [];

  let view;
  switch (route.name) {
    case 'home':
      view = <Home key="home" subjects={list} go={go} onChange={refresh} online={online} />;
      break;
    case 'subject':
      view = <SubjectView key={`${route.id}-${route.view ? 'v' : ''}`} route={route} subjects={list} go={go} onChange={refresh} />;
      break;
    case 'settings':
      view = <SettingsView key={`settings-${route.tab ?? ''}-${route.subjectId ?? ''}`} tab={route.tab} subjectId={route.subjectId}
        onSaved={refresh} />;
      break;
  }

  return (
    <OverlayProvider>
      <div className="app">
        <div className="app-backdrop" aria-hidden />
        {window.studyApp?.titlebar && <Titlebar route={route} subjects={list} />}
        <Minibar subjects={list} route={route} go={go} onChange={refresh} online={online} />
        <main className={`main${route.name === 'subject' ? ' main-subject' : ''}`}>
          {needsToken && (
            <div className="banner banner-bad">This backend needs its token: open the page with <code>?backend=PORT&amp;token=…</code> (the
              token is in the <code>backend-token</code> file in the data folder).</div>
          )}
          {backendUp === false && (
            <div className="banner banner-bad"><ErrorText text="Apollo’s background service isn’t answering. Restart the app if this lasts. [APO-APP-001]" /></div>
          )}
          {backendUp && setupDone && <ModelCheck />}
          <ErrorBoundary name="This page" resetKey={JSON.stringify(route)}>{view}</ErrorBoundary>
        </main>
        <Ambient />
        <TooltipLayer />
        <FindLayer />
        <CalculatorLayer />
        {backendUp && <PetLayer />}
        <ToastLayer />
        <CommandPalette go={go} route={route} />
        {backendUp && <SetupWizard subjectsCount={list.length} onFinished={(id) => { refresh(); if (id) go({ name: 'subject', id }); }} />}
        <Tour ready={route.name === 'subject'} />
        <ErrorHelpLayer />
      </div>
    </OverlayProvider>
  );
}

/** The window's title strip (Electron draws no native one): drag to move, double-click to maximise. Windows draws
 * the min/max/close buttons over its right end. */
function Titlebar({ route, subjects }: { route: Route; subjects: { id: number; name: string }[] }) {
  const where = route.name === 'subject' ? subjects.find((s) => s.id === route.id)?.name
    : route.name === 'settings' ? ({ maintenance: 'Maintenance', share: 'Share', general: 'Settings' }[route.tab ?? 'general']) : 'All subjects';
  return (
    <header className="titlebar">
      <span className="tb-app">Apollo Study</span>
      {where && <span key={where} className="tb-where">{where}</span>}
    </header>
  );
}

/** When a model can't be reached: a plain banner (instead of an error mid-chat) with Check again and the setup steps.
 * Dismissed for the session; it comes back if the models go down again later. */
function ModelCheck() {
  const st = usePoll(api.modelStatus, 30000, [], ['pause']);
  const [hidden, setHidden] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!st.data || hidden) return null;
  const down = ([['llm', 'the language model'], ['embed', 'the search model']] as const).filter(([k]) => !st.data![k].ok && !st.data![k].paused);
  if (!down.length) return null;
  return (
    <div className="model-check" role="status">
      <span className="model-check-dot" aria-hidden />
      <div className="model-check-text">
        <b>Apollo can’t reach {down.map(([, n]) => n).join(' or ')}.</b>
        <span>{down.length === 2 ? 'Chat, search and making study material' : down[0][0] === 'llm' ? 'Chat and making study material' : 'Search and adding files'} will wait until it’s back. Make sure the model servers are running, or change where Apollo looks for them.</span>
        <span className="model-check-codes">{down.map(([k]) => {
          const { message, code } = splitError(st.data![k].error ?? '');
          return code ? <ErrorCode key={k} code={code} context={message} /> : null;
        })}</span>
      </div>
      <button className="btn btn-sm" disabled={checking} onClick={async () => { setChecking(true); try { await st.reload(); } finally { setChecking(false); } }}>
        {checking ? 'Checking…' : 'Check again'}</button>
      <button className="btn btn-sm btn-primary" onClick={openSetup}>Set up models</button>
      <button className="x-btn" title="Hide until next time" aria-label="Hide" onClick={() => setHidden(true)}><Icon name="close" size={14} /></button>
    </div>
  );
}
