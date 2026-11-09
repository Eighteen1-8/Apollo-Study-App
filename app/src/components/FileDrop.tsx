import { useState } from 'react';
import { api, Subject, VisionMode } from '../api';
import { Modal } from './overlay';
import { addedNotice, droppedPaths, VisionSelect } from './UploadDialog';
import { useTerms } from '../terms';
import { toast } from './toast';
import Icon from './Icon';

/**
 * Shown while files are dragged in from Explorer: left = reference library, right = a topic, bottom = send to the
 * chat for one message (read, not ingested).
 */
export function FileDropOverlay({ topicCount, singleTopic, onReference, onTopic, onChat }: {
  topicCount: number; singleTopic?: string;
  onReference: (paths: string[]) => void; onTopic: (paths: string[]) => void; onChat: (paths: string[]) => void;
}) {
  const tr = useTerms();
  return (
    <div className="filedrop">
      <div className="filedrop-top">
        <Zone kind="ref" title={tr('references')} sub={tr('ingestedRef')} onDrop={onReference} />
        <Zone kind="topic" title={singleTopic ? `Topic: ${singleTopic}` : 'Topic material'}
          sub={topicCount > 1 ? tr('ingestedTopics') : topicCount === 1 ? tr('ingestedTopic') : "You'll be asked to name a topic first."}
          onDrop={onTopic} />
      </div>
      <Zone kind="chat" title="Send to chat" sub={tr('notIngested')} onDrop={onChat} />
    </div>
  );
}

function Zone({ kind, title, sub, onDrop }: { kind: string; title: string; sub: string; onDrop: (paths: string[]) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div className={`fd-zone fd-${kind}${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragEnter={() => setOver(true)}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(droppedPaths(e)); }}>
      <div className="fd-icon"><Icon name={kind === 'ref' ? 'textbook' : kind === 'topic' ? 'topic' : 'chat'} size={kind === 'chat' ? 26 : 32} /></div>
      <div className="fd-title">{title}</div>
      <div className="fd-sub">{sub}</div>
    </div>
  );
}

/** Pick a topic for each dropped file (when the subject has more than one topic), then upload per topic. */
export function TopicAssignDialog({ subject, paths, defaultTopic, onClose, onDone }: {
  subject: Subject; paths: string[]; defaultTopic: number; onClose: () => void; onDone: () => void;
}) {
  const [assign, setAssign] = useState<Record<string, number>>(() => Object.fromEntries(paths.map((p) => [p, defaultTopic])));
  const [mode, setMode] = useState<VisionMode>('auto');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<{ filename: string; status: string; message?: string }[]>([]);

  const upload = async () => {
    setBusy(true);
    try {
      const out = [];
      for (const t of subject.topics) {
        const group = paths.filter((p) => assign[p] === t.id);
        if (group.length) out.push(...await api.upload({ paths: group, topic_id: t.id, vision_mode: mode }));
      }
      onDone();
      const bad = out.filter((r) => r.status !== 'queued');
      const added = out.length - bad.length;
      if (added) toast(addedNotice(added));
      if (bad.length) setProblems(bad); else onClose();
    } catch (e) {
      setProblems([{ filename: '', status: 'error', message: String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add ${paths.length} file${paths.length === 1 ? '' : 's'} to topics`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>{problems.length ? 'Close' : 'Cancel'}</button>
        {!problems.length && <button className="btn btn-primary" disabled={busy} onClick={upload}>{busy ? 'Adding…' : 'Add files'}</button>}
      </>}>
      {paths.length > 1 && (
        <div className="assign-all">
          <span className="muted small">All to:</span>
          {subject.topics.map((t) => (
            <button key={t.id} className="chip" onClick={() => setAssign(Object.fromEntries(paths.map((p) => [p, t.id])))}>{t.name}</button>
          ))}
        </div>
      )}
      <div className="assign-list">
        {paths.map((p) => (
          <div key={p} className="assign-row">
            <div className="assign-file" title={p}>{p.split(/[\\/]/).pop()}</div>
            <div className="assign-topics">
              {subject.topics.map((t) => (
                <button key={t.id} className={`assign-topic${assign[p] === t.id ? ' on' : ''}`} onClick={() => setAssign({ ...assign, [p]: t.id })}>{t.name}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <VisionSelect mode={mode} setMode={setMode} />
      {problems.map((m, i) => (
        <div key={i} className={`small ${m.status === 'error' ? 'bad' : 'muted'}`}>
          {m.filename && <b>{m.filename}: </b>}{m.status === 'duplicate' ? `skipped (already added). ${m.message}` : m.message}
        </div>
      ))}
    </Modal>
  );
}
