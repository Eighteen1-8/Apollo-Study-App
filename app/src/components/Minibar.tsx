import { useState } from 'react';
import { api, inElectron, Subject } from '../api';
import type { Route } from '../App';
import logo from '../../assets/icon.svg';
import { useLibraryActions } from './actions';
import JobsPanel from './JobsPanel';
import { Modal, useOverlay } from './overlay';
import StaleBadge from './StaleBadge';
import SubjectIcon, { PALETTE } from './SubjectIcon';
import { useReorder } from './reorder';
import { useChatStreams } from '../chatStreams';
import { redo, undo, useUndo } from '../undo';
import { openPalette } from './CommandPalette';

/** Narrow icon bar: home, one tile per subject, add, background jobs, settings. */
export default function Minibar({ subjects, route, go, onChange, online }: {
  subjects: Subject[]; route: Route; go: (r: Route) => void; onChange: () => void; online: string[];
}) {
  const ov = useOverlay();
  const act = useLibraryActions(subjects, go, onChange);
  const [colorFor, setColorFor] = useState<Subject | null>(null);
  const active = route.name === 'subject' ? route.id : null;
  const reorder = useReorder('subjects', subjects.map((s) => s.id), async (ids) => { await api.orderSubjects(ids); onChange(); }, 'reorder subjects');
  const streams = useChatStreams();
  const history = useUndo();

  const menu = (e: React.MouseEvent, s: Subject) => ov.menu(e, [
    { label: 'Open', onClick: () => go({ name: 'subject', id: s.id }) },
    { label: 'New topic…', onClick: () => act.newTopic(s) },
    { label: 'Check vision notes', onClick: () => act.checkVision({ subject_id: s.id }, s.name, s.id), separatorBefore: true },
    { label: 'Maintenance…', onClick: () => go({ name: 'settings', tab: 'maintenance', subjectId: s.id }) },
    { label: 'Export / share…', onClick: () => go({ name: 'settings', tab: 'share', subjectId: s.id }) },
    { label: 'Rename…', onClick: () => act.renameSubject(s), separatorBefore: true },
    { label: 'Change colour…', onClick: () => setColorFor(s) },
    { label: 'Change letters…', onClick: async () => {
      const t = await ov.prompt({ title: 'Icon letters', label: 'Up to 3 characters', initial: s.icon_text ?? '', placeholder: 'PH' });
      if (t) { await api.setIcon(s.id, { icon_text: t }); onChange(); }
    } },
    { label: 'Use an emoji…', onClick: async () => {
      const t = await ov.prompt({ title: 'Icon emoji', label: 'Type or paste an emoji (Win + . opens the emoji picker)', initial: s.icon_emoji ?? '' });
      if (t) { await api.setIcon(s.id, { icon_emoji: t }); onChange(); }
    } },
    { label: 'Upload an image…', disabled: !inElectron, onClick: async () => {
      const p = await window.studyApp!.openFiles({ multi: false });
      if (p[0]) { await api.setIcon(s.id, { image_path: p[0] }); onChange(); }
    } },
    { label: 'Reset icon', onClick: async () => { await api.setIcon(s.id, { icon_text: '', icon_emoji: '', clear_image: true }); onChange(); } },
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
        <button className="mini-add" data-tip="New subject" onClick={act.newSubject}>+</button>
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
        {online.length > 0 && (
          <button className="mini-online" onClick={() => go({ name: 'settings' })}
            data-tip={`Online: ${online.join(' and ')} via OpenRouter. Data is logged externally and may be used for training`}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
            </svg>
          </button>
        )}
        <JobsPanel />
        <button className={`mini-icon${route.name === 'settings' ? ' active' : ''}`} data-tip="Settings" onClick={() => go({ name: 'settings' })}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>

      {colorFor && <ColorDialog subject={colorFor} onClose={() => setColorFor(null)}
        onPick={async (c) => { await api.setIcon(colorFor.id, { color: c }); onChange(); }} />}
    </nav>
  );
}

function ColorDialog({ subject, onPick, onClose }: { subject: Subject; onPick: (c: string) => Promise<void>; onClose: () => void }) {
  const [c, setC] = useState(subject.color);
  return (
    <Modal title={`Colour for ${subject.name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => { await onPick(c); onClose(); }}>Save</button>
      </>}>
      <div className="color-preview"><SubjectIcon s={{ ...subject, color: c }} size={64} /></div>
      <div className="swatches">
        {PALETTE.map((p) => (
          <button key={p} className={`swatch${p === c ? ' active' : ''}`} style={{ background: p }} onClick={() => setC(p)} />
        ))}
        <label className="swatch swatch-custom" title="Custom colour">
          <input type="color" value={c} onChange={(e) => setC(e.target.value)} />+
        </label>
      </div>
    </Modal>
  );
}
