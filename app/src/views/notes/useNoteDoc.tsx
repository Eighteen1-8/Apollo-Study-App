/* What the mind map and drawing editors share: loading the note, saving its data as it changes (the same
   Saved / Saving… / Editing… / Not saved state the rich-text editor shows), the title and topic, the header, and
   Apollo's comments. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, Note, ReviewIssue, saveNoteDataOnExit, Subject } from '../../api';
import Reviews, { useReviews } from '../../components/Reviews';
import Icon from '../../components/Icon';
import { logError } from '../../log';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

export function useNoteDoc<T extends object>(id: number, normalize: (raw: unknown) => T) {
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [data, setDataState] = useState<T | null>(null);
  const [state, setState] = useState<SaveState>('saved');
  const dataRef = useRef<T | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const norm = useRef(normalize);
  norm.current = normalize;

  const load = useCallback(async () => {
    const n = await api.note(id);
    setNote(n);
    setTitle(n.title);
    const d = norm.current(n.data);
    dataRef.current = d;
    setDataState(d);
    dirty.current = false;
    setState('saved');
  }, [id]);
  useEffect(() => { load().catch((e) => logError('opening a note', e)); }, [load]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current || !dataRef.current) return;
    dirty.current = false;
    setState('saving');
    try {
      await api.saveNote(id, { data: dataRef.current });
      setState((s) => (dirty.current ? s : 'saved'));
    } catch (e) {
      dirty.current = true;
      setState('error');
      logError('saving a note', e);
    }
  }, [id]);

  /** The new data, shown at once and saved shortly after the last change. */
  const setData = useCallback((next: T) => {
    dataRef.current = next;
    setDataState(next);
    dirty.current = true;
    setState('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 700);
  }, [save]);

  // save what's left when the editor closes, and when the window goes away
  useLayoutEffect(() => () => {
    clearTimeout(timer.current);
    if (dirty.current && dataRef.current) {
      dirty.current = false;
      api.saveNote(id, { data: dataRef.current }).catch((e) => logError('saving a note', e));
    }
  }, [id]);
  useEffect(() => {
    const flush = () => { if (dirty.current && dataRef.current) { dirty.current = false; saveNoteDataOnExit(id, dataRef.current); } };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [id]);

  const saveTitle = async (t: string, fallback: string) => {
    const v = t.trim() || fallback;
    setTitle(v);
    if (note && v !== note.title) setNote(await api.saveNote(id, { title: v }));
  };
  const setTopic = async (topic: number | null) => { setNote(await api.saveNote(id, { topic_id: topic, set_topic: true })); };

  return { note, title, setTitle, saveTitle, setTopic, data, dataRef, setData, save, state, reload: load };
}

/** Apollo's comments on a map or drawing: open by default while one is running or has something to say. */
export function useNoteReviews(id: number) {
  const reviews = useReviews('note', id);
  const [show, setShow] = useState(false);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !reviews.data) return;
    opened.current = true;
    if (reviews.data.some((r) => r.status === 'queued' || r.status === 'running' || r.status === 'ready')) setShow(true);
  }, [reviews.data]);
  return { reviews, show, setShow, count: (reviews.data ?? []).length };
}

/**
 * The header of a map or drawing: the same markup and classes as the rich-text editor's (NoteEditor), so they look
 * and behave alike. `extra` goes before Comments (Check with Apollo and Export).
 */
/** The parts of useNoteDoc the header uses. */
export interface HeadDoc {
  note: Note | null; title: string; state: SaveState; setTitle: (t: string) => void;
  saveTitle: (t: string, fallback: string) => Promise<void>; setTopic: (topic: number | null) => Promise<void>;
}

export function NoteHead({ doc, subject, placeholder, fallbackTitle, extra, comments, onClose }: {
  doc: HeadDoc; subject: Subject; placeholder: string; fallbackTitle: string;
  extra: React.ReactNode; comments: { show: boolean; count: number; toggle: () => void }; onClose: () => void;
}) {
  return (
    <header className="source-head">
      <input className="ne-title" value={doc.title} placeholder={placeholder} onChange={(e) => doc.setTitle(e.target.value)}
        onBlur={(e) => doc.saveTitle(e.target.value, fallbackTitle)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <select className="ne-topic" value={doc.note?.topic_id ?? ''} title="Which topic this is about (Apollo checks it against that material)"
        onChange={(e) => doc.setTopic(e.target.value ? Number(e.target.value) : null)}>
        <option value="">All of {subject.name}</option>
        {subject.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <span className={`ne-state ${doc.state}`}>{{ saved: 'Saved', saving: 'Saving…', unsaved: 'Editing…', error: 'Not saved' }[doc.state]}</span>
      {extra}
      <button className={`btn btn-sm${comments.show ? ' on' : ''}`} onClick={comments.toggle}>
        Comments{comments.count ? ` (${comments.count})` : ''}
      </button>
      <button className="close-x" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
    </header>
  );
}

/** The Comments panel for a map or drawing: checks only (Apollo doesn't rewrite them); clicking an issue shows it. */
export function NoteComments({ id, r, onIssue, empty }: {
  id: number; r: ReturnType<typeof useNoteReviews>; onIssue?: (issue: ReviewIssue) => void; empty: string;
}) {
  if (!r.show) return null;
  return <Reviews target="note" id={id} list={r.reviews.data ?? []} onApplied={() => r.reviews.reload()} checkOnly
    onIssue={onIssue} emptyText={empty} onClose={() => r.setShow(false)} />;
}
