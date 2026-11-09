/* Forms the model (or a quick action) opens in the chat to create content, and the progress cards they turn into. */
import { useEffect, useState } from 'react';
import ErrorText from '../../components/ErrorText';
import { api, ArtifactSummary, inElectron, Message, Subject } from '../../api';
import { Progress } from '../../components/ui';
import { TYPE_ICON } from '../LibraryPanel';
import { onChange } from '../../events';

import { TERMINAL } from './types';

const FORM_TITLES: Record<string, string> = {
  flashcards: 'Create flashcards', quiz: 'Create a quiz', exam: 'Create an exam', notes: 'Compile full notes', cheatsheet: 'Create a cheat sheet',
  mindmap: 'Create a mind map',
};

export function ToolForm({ m, subject, chatTopic, onReplace }: { m: Message; subject: Subject; chatTopic: number | null; onReplace: (m: Message) => void }) {
  const type = m.meta.type!;
  const args = m.meta.args ?? {};
  const [topic, setTopic] = useState<number | null>(m.meta.topic_id ?? chatTopic);
  const [count, setCount] = useState<number>(Number(args.count) || (type === 'quiz' ? 10 : 20));
  const [focus, setFocus] = useState<string>(String(args.focus ?? ''));
  const [difficulty, setDifficulty] = useState<string>(String(args.difficulty ?? ''));
  const [exam, setExam] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = type !== 'exam' || (exam && difficulty);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a: Record<string, unknown> = type === 'exam' ? { difficulty, practice_exam_path: exam }
        : type === 'flashcards' || type === 'quiz' ? { count, focus } : { focus };
      onReplace(await api.submitTool(m.id, a, topic));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg tool-card">
      <div className="tool-title">{FORM_TITLES[type]}</div>
      <div className="tool-grid">
        <label className="field">
          <span className="field-label">Material from</span>
          <select value={topic ?? ''} onChange={(e) => setTopic(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All topics in {subject.name}</option>
            {subject.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {(type === 'flashcards' || type === 'quiz') && (
          <label className="field">
            <span className="field-label">{type === 'quiz' ? 'Questions' : 'Cards'}</span>
            <input className="input" type="number" min={1} max={type === 'quiz' ? 60 : 200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
        )}
        {type !== 'exam' && (
          <label className="field field-wide">
            <span className="field-label">Focus (optional)</span>
            <input className="input" value={focus} placeholder="e.g. refraction and Snell's law" onChange={(e) => setFocus(e.target.value)} />
          </label>
        )}
        {type === 'exam' && (
          <>
            <div className="field field-wide">
              <span className="field-label">Practice exam</span>
              <div className="file-pick">
                <button className="btn btn-sm" disabled={!inElectron} onClick={async () => {
                  const p = await window.studyApp!.openFiles({ multi: false });
                  if (p[0]) setExam(p[0]);
                }}>{exam ? 'Change…' : 'Choose file…'}</button>
                <span className={exam ? '' : 'muted'}>{exam ? exam.split(/[\\/]/).pop() : 'Upload an exam you were given for this subject (PDF, Word, image).'}</span>
              </div>
              <span className="field-help">Only its structure is used (parts, question types, marks). It is not added to your material. Use an exam from the same subject.</span>
            </div>
            <div className="field field-wide">
              <span className="field-label">Difficulty</span>
              <div className="seg">
                {[['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']].map(([k, l]) => (
                  <button key={k} className={difficulty === k ? 'active' : ''} onClick={() => setDifficulty(k)}>{l}</button>
                ))}
              </div>
              <span className="field-help">
                {difficulty === 'easy' ? 'Same structure, simpler questions than the practice exam.'
                  : difficulty === 'hard' ? 'Same structure, harder questions than the practice exam.'
                  : difficulty === 'normal' ? 'Same structure and difficulty as the practice exam.' : 'Choose how hard the new exam should be.'}
              </span>
            </div>
          </>
        )}
      </div>
      {err && <div className="small bad"><ErrorText text={err} /></div>}
      <div className="tool-actions">
        <button className="btn btn-sm" onClick={async () => onReplace(await api.dismissTool(m.id))}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Starting…' : 'Generate'}</button>
      </div>
    </div>
  );
}

export function ArtifactCard({ id, initial, onOpen }: { id: number; initial: ArtifactSummary | null; onOpen: (id: number) => void }) {
  const [a, setA] = useState<ArtifactSummary | null>(initial);
  const [gen, setGen] = useState(0); // bump to restart polling after a retry
  useEffect(() => {
    let alive = true;
    let done = false;
    const tick = async () => {
      if (done) return;
      try {
        const r = await api.artifact(id);
        if (!alive) return;
        setA(r);
        done = TERMINAL.includes(r.status);
      } catch { if (alive) setA(null); }
    };
    tick();
    const off = onChange(['library'], tick);  // progress arrives as library changes, not by polling
    return () => { alive = false; off(); };
  }, [id, gen]);
  if (!a) return <div className="msg msg-note muted small">This content was deleted.</div>;
  return (
    <div className={`msg artifact-card status-${a.status}`}>
      <div className={`artifact-icon t-${a.type}`}>{TYPE_ICON(a.type, 19)}</div>
      <div className="artifact-main">
        <div className="artifact-title">{a.title}</div>
        {a.status === 'ready' && <div className="muted small">Ready · saved to the library</div>}
        {(a.status === 'queued' || a.status === 'running') && (
          <>
            <div className="muted small">{a.status === 'queued' ? 'Waiting for the model…' : a.message}</div>
            <Progress value={a.progress} />
          </>
        )}
        {a.status === 'failed' && <div className="small bad"><ErrorText text={a.error} /></div>}
        {a.status === 'cancelled' && <div className="muted small">Cancelled</div>}
      </div>
      <div className="artifact-actions">
        {a.status === 'ready' && <button className="btn btn-sm btn-primary" onClick={() => onOpen(a.id)}>Open</button>}
        {(a.status === 'queued' || a.status === 'running') && <button className="link-btn" onClick={() => api.cancelArtifact(a.id)}>Cancel</button>}
        {(a.status === 'failed' || a.status === 'cancelled') && (
          <button className="btn btn-sm" onClick={async () => { await api.retryArtifact(a.id); setGen((g) => g + 1); }}>Retry</button>
        )}
      </div>
    </div>
  );
}
