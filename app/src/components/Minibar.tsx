import { useState } from 'react';
import { openErrorHelp } from './ErrorText';
import { api, Subject } from '../api';
import type { Route } from '../App';
import logo from '../../assets/icon.svg';
import { useLibraryActions } from './actions';
import JobsPanel from './JobsPanel';
import StudyTimer from './StudyTimer';
import { PetButton } from './Pet';
import { Modal, useOverlay } from './overlay';
import StaleBadge from './StaleBadge';
import SubjectIcon from './SubjectIcon';
import SubjectLook from './SubjectLook';
import { useReorder } from './reorder';
import { useChatStreams } from '../chatStreams';
import { redo, undo, useUndo } from '../undo';
import { openPalette } from './CommandPalette';
import ShortcutsList from './Shortcuts';
import { openSetup } from './SetupWizard';
import { startTour, TourId, TourList, TOURS } from './Tour';
import Icon from './Icon';
import { usePoll } from '../hooks';
import { useAdvanced } from '../theme';
import { useTerms } from '../terms';

/** Narrow icon bar: home, one tile per subject, add, background jobs, settings. */
export default function Minibar({ subjects, route, go, onChange, online }: {
  subjects: Subject[]; route: Route; go: (r: Route) => void; onChange: () => void; online: string[];
}) {
  const ov = useOverlay();
  const act = useLibraryActions(subjects, go, onChange);
  const [lookFor, setLookFor] = useState<Subject | null>(null);
  const active = route.name === 'subject' ? route.id : null;
  const reorder = useReorder('subjects', subjects.map((s) => s.id), async (ids) => { await api.orderSubjects(ids); onChange(); }, 'reorder subjects');
  const streams = useChatStreams();
  const history = useUndo();
  const advanced = useAdvanced();
  const tr = useTerms();
  const [help, setHelp] = useState(false);

  const showTour = (id: TourId) => {
    setHelp(false);
    // the subject page's tours point at a subject: open one first if none is showing
    if (TOURS[id].onSubject && route.name !== 'subject' && subjects.length) { go({ name: 'subject', id: subjects[0].id }); setTimeout(() => startTour(id), 900); } else startTour(id);
  };

  const menu = (e: React.MouseEvent, s: Subject) => ov.menu(e, [
    { label: 'Open', onClick: () => go({ name: 'subject', id: s.id }) },
    { label: 'New topic…', onClick: () => act.newTopic(s) },
    ...(advanced ? [
      { label: tr('checkVision'), onClick: () => act.checkVision({ subject_id: s.id }, s.name, s.id), separatorBefore: true },
      { label: 'Maintenance…', onClick: () => go({ name: 'settings', tab: 'maintenance', subjectId: s.id }) },
    ] : []),
    { label: 'Export / share…', separatorBefore: !advanced, onClick: () => go({ name: 'settings', tab: 'share', subjectId: s.id }) },
    { label: 'Rename…', onClick: () => act.renameSubject(s), separatorBefore: true },
    { label: 'Icon and colour…', onClick: () => setLookFor(s) },
    { label: 'Delete subject', danger: true, separatorBefore: true, onClick: () => act.deleteSubject(s) },
  ]);

  return (
    <nav className="minibar">
      <img className={`mini-home${route.name === 'home' ? ' active' : ''}`} src={logo} alt="All subjects" title="All subjects" width={35} height={35}
        role="button" tabIndex={0} onClick={() => go({ name: 'home' })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go({ name: 'home' }); } }} />
      <div className="mini-sep" />
      <div className="mini-subjects">
        {reorder.order.map((id) => subjects.find((x) => x.id === id)!).map((s) => (
          <button key={s.id} className={`mini-subject${active === s.id ? ' active' : ''}`} data-tip={s.name} {...reorder.item(s.id)}
            onClick={() => go({ name: 'subject', id: s.id })} onContextMenu={(e) => menu(e, s)}>
            <SubjectIcon s={s} />
            {(() => {
              const st = streams.subjectState(s.id);
              return st && <span className={`mini-dot dot-${st}`} aria-label={st === 'live' ? 'Apollo is replying' : st === 'error' ? 'A reply failed' : 'New reply'} />;
            })()}
            <StaleBadge count={s.stale_docs} where={s.name} className="on-tile"
              onReingest={async () => { await api.reingestStale(s.id); onChange(); }} />
          </button>
        ))}
        <button className="mini-add" data-tip="New subject" onClick={act.newSubject}><Icon name="add" size={18} /></button>
      </div>
      <div className="mini-bottom">
        <button className="mini-icon mini-search" data-tip="Search and go anywhere (Ctrl+K)" onClick={openPalette}>
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
        <div className="mini-history">
          <button className="mini-icon mini-half" disabled={!history.canUndo} onClick={undo}
            data-tip={history.canUndo ? `Undo ${history.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </button>
          <button className="mini-icon mini-half" disabled={!history.canRedo} onClick={redo}
            data-tip={history.canRedo ? `Redo ${history.redoLabel} (Ctrl+Y)` : 'Nothing to redo'}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </button>
        </div>
        {/* tools: the study timer (the app pet's on/off button goes beside it, in this group) */}
        <div className="mini-tools">
          <StudyTimer />
          <PetButton />
        </div>
        {online.length > 0 && (
          <button className="mini-online" onClick={() => go({ name: 'settings' })}
            data-tip={`Online: ${online.join(' and ')} via OpenRouter. Data is logged externally and may be used for training`}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
            </svg>
          </button>
        )}
        <ModelLight onOpen={() => go({ name: 'settings' })} />
        <JobsPanel />
        <button className="mini-icon mini-help" data-tip="Shortcuts and help" onClick={() => setHelp(true)}><Icon name="help" size={19} strokeWidth={1.9} /></button>
        <button className={`mini-icon mini-settings${route.name === 'settings' ? ' active' : ''}`} data-tip="Settings" onClick={() => go({ name: 'settings' })}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>

      {help && (
        <Modal title="Shortcuts and help" wide onClose={() => setHelp(false)}
          footer={<>
            <button className="btn" onClick={() => showTour('app')}>Show the tour</button>
            <button className="btn" onClick={() => { setHelp(false); openSetup(); }}>Set up models again</button>
            <button className="btn" onClick={() => { setHelp(false); openErrorHelp(null); }}>Error codes</button>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={() => setHelp(false)}>Got it</button>
          </>}>
          <p className="muted small help-intro">Make a <b>subject</b> (e.g. Physics) with <b>topics</b> inside it (e.g. Motion), add your
            slides, notes and textbooks, then ask Apollo questions, have it make flashcards, quizzes, practice exams, notes, cheat sheets
            and mind maps, or have it mark your own work. Everything Apollo makes is saved in the left sidebar; your files, and your own
            notes, mind maps and drawings, are on the right.</p>
          <h4 className="help-tours-title">Tours</h4>
          <p className="muted small">Tips about each part of Apollo, lighting up each thing as they explain it. Each one also starts the first time you use that part, and the ? next to it shows it again.</p>
          <TourList onPick={showTour} />
          <ShortcutsList />
        </Modal>
      )}
      {lookFor && <SubjectLook subject={lookFor} onClose={() => setLookFor(null)} onChange={onChange} />}
    </nav>
  );
}

/** A light for the AI models: green when both answer, amber while one is paused, red when one can't be reached.
 * Click opens Settings, where Test connections says more. */
function ModelLight({ onOpen }: { onOpen: () => void }) {
  const st = usePoll(api.modelStatus, 30000, [], ['pause']);
  const tr = useTerms();
  if (!st.data) return null;
  const parts = [['llm', 'Apollo (chat and generation)'], ['embed', 'Search']] as const;
  const down = parts.filter(([k]) => !st.data![k].ok && !st.data![k].paused);
  const paused = parts.filter(([k]) => st.data![k].paused);
  const tone = down.length ? 'bad' : paused.length ? 'warn' : 'ok';
  const tip = down.length
    ? `${down.map(([k, n]) => `${n}: not available. ${st.data![k].error ?? ''}`).join('\n')}\nMake sure the model servers are running, then click to test the connections.`
    : paused.length ? `Paused: ${paused.map(([k]) => tr(k === 'llm' ? 'llm' : 'embeddings')).join(' and ')} (resume from the jobs list)`
      : 'Apollo and search are ready';
  return (
    <button className={`mini-icon mini-light light-${tone}`} data-tip={tip} aria-label={tip} onClick={onOpen}>
      <span className="light-dot" aria-hidden />
    </button>
  );
}
