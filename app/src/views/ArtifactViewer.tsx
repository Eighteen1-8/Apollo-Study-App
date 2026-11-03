import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Artifact, Subject } from '../api';
import { Flashcards } from './artifacts/Flashcards';
import { Quiz } from './artifacts/Quiz';
import { Exam } from './artifacts/Exam';
import { Sections } from './artifacts/Sections';

/** Fullscreen viewer for generated content, closed with the × at the top right (or Escape). */
export default function ArtifactViewer({ id, subject, onClose }: { id: number; subject: Subject; onClose: () => void }) {
  const [a, setA] = useState<Artifact | null>(null);
  useEffect(() => { api.artifact(id).then(setA); }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-backdrop') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // portalled so it always covers the window, whatever transformed/clipped panel it was opened from
  return createPortal(
    <div className="fullscreen">
      <div className="fs-top">
        <div className="fs-title">{a?.title ?? 'Loading…'}</div>
        <button className="close-x close-x-lg" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      <div className="fs-body">
        {a?.content && (
          a.type === 'flashcards' ? <Flashcards artifact={a} />
            : a.type === 'quiz' ? <Quiz artifact={a} subject={subject} />
            : <div className="fs-doc">{a.type === 'exam' ? <Exam artifact={a} /> : <Sections content={a.content} />}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Notes and cheat sheets read like a document, so they open in the centre pane (the chat floats beside them). */
export function ArtifactPage({ id, onClose, onCite }: { id: number; onClose: () => void; onCite: (file: string, label: string) => void }) {
  const [a, setA] = useState<Artifact | null>(null);
  const [gen, setGen] = useState(0); // bumped by Regenerate to restart polling
  useEffect(() => {
    let alive = true;
    const load = () => api.artifact(id).then((x) => {
      if (!alive) return;
      setA(x);
      if (x.status === 'queued' || x.status === 'running') setTimeout(load, 2500); // regenerating
    });
    load();
    return () => { alive = false; };
  }, [id, gen]);
  const busy = a?.status === 'queued' || a?.status === 'running';
  return (
    <div className="source artifact-page">
      <header className="source-head">
        <div className="source-title" title={a?.title}>{a?.title ?? ''}</div>
        {a && <span className="muted small">{a.type === 'notes' ? 'Full notes' : 'Cheat sheet'} · {(a.content?.sections ?? []).length} sections</span>}
        {a && (busy
          ? <span className="muted small">{a.message || 'Regenerating…'} {Math.round(a.progress * 100)}%</span>
          : <button className="btn btn-sm" title="Write this again from your material" onClick={async () => {
            await api.retryArtifact(id);
            setA({ ...a, status: 'queued', progress: 0, message: 'Waiting for Apollo…' });
            setGen((g) => g + 1);
          }}>Regenerate</button>)}
        <button className="close-x" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="artifact-scroll">
        {a?.content && <div className="fs-doc"><Sections content={a.content} onCite={onCite} /></div>}
      </div>
    </div>
  );
}
