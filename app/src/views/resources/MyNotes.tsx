/* The student's own notes, pinned at the bottom of the right sidebar. */
import { useState } from 'react';
import { api, NoteSummary, Subject } from '../../api';
import { exportAs } from '../../components/exportDoc';
import { getPref, setPref } from '../../prefs';
import { usePoll } from '../../hooks';
import { useOverlay } from '../../components/overlay';
import { deleteUndoably } from '../chatActions';


export function MyNotes({ subject, openId, onOpen, onOpenSplit, style }: {
  subject: Subject; openId: number | null; onOpen: (id: number) => void; onOpenSplit: (id: number) => void; style?: React.CSSProperties;
}) {
  const ov = useOverlay();
  const notes = usePoll(() => api.notes(subject.id), 600, [subject.id], ['notes']);
  const [folded, setFolded] = useState(() => getPref('notesFolded', false, (v) => v === '1'));
  const list = notes.data ?? [];
  const create = async () => {
    const n = await api.createNote(subject.id, { title: 'Untitled note' });
    notes.reload();
    onOpen(n.id);
  };
  const exportNote = async (n: NoteSummary, f: 'docx' | 'pdf') => {
    try {
      const full = await api.note(n.id);
      await exportAs(f, full.title, () => full.html);
    } catch (e) {
      ov.confirm({ title: 'Export failed', body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };
  const menu = (e: React.MouseEvent, n: NoteSummary) => ov.menu(e, [
    { label: 'Open', onClick: () => onOpen(n.id) },
    { label: 'Open side by side', onClick: () => onOpenSplit(n.id) },
    { label: 'Check with Apollo', onClick: async () => { await api.startReview({ target: 'note', target_id: n.id, mode: 'check' }); onOpen(n.id); } },
    { label: 'Ask Apollo to change it…', onClick: async () => {
      const instruction = await ov.prompt({ title: `What should Apollo change in “${n.title}”?`, placeholder: 'e.g. add the missing definitions', confirmText: 'Ask Apollo' });
      if (instruction) { await api.startReview({ target: 'note', target_id: n.id, mode: 'revise', instruction }); onOpen(n.id); }
    } },
    { label: 'Export to Word…', separatorBefore: true, onClick: () => exportNote(n, 'docx') },
    { label: 'Export to PDF…', onClick: () => exportNote(n, 'pdf') },
    { label: 'Rename…', separatorBefore: true, onClick: async () => {
      const t = await ov.prompt({ title: 'Rename note', initial: n.title });
      if (t) { await api.saveNote(n.id, { title: t }); notes.reload(); }
    } },
    { label: 'Delete', danger: true, onClick: async () => {
      if (await ov.confirm({ title: `Delete “${n.title}”?`, danger: true, confirmText: 'Delete',
        body: 'You can undo this (Ctrl+Z) for a week; after that the note and Apollo\'s comments on it are gone.' })) {
        await deleteUndoably({ what: 'note', name: n.title, del: () => api.deleteNote(n.id), restore: () => api.restoreNote(n.id) });
        notes.reload();
      }
    } },
  ]);
  return (
    <section className={`my-notes${folded ? ' folded' : ''}`} style={folded ? undefined : style}>
      <div className="side-section-head">
        <button className="my-notes-title" onClick={() => { setFolded(!folded); setPref('notesFolded', folded ? '0' : '1'); }}>
          <span className="lib-caret">▾</span> My notes {list.length > 0 && <span className="count-badge">{list.length}</span>}
        </button>
        <button className="icon-btn" title="New note" onClick={create}>+</button>
      </div>
      {!folded && (
        <div className="my-notes-list">
          {notes.data && !list.length && (
            <button className="files-empty side-empty my-notes-empty" onClick={create}>
              + Write your own notes. They're kept apart from your material, and Apollo can check them for you.
            </button>
          )}
          {list.map((n) => (
            <button key={n.id} className={`note-item${n.id === openId ? ' open' : ''}`} onClick={() => onOpen(n.id)} onContextMenu={(e) => menu(e, n)}
              title={n.title}>
              <span className="note-icon">✎</span>
              <span className="lib-main">
                <span className="lib-title">{n.title}</span>
                <span className="lib-sub">{new Date(n.updated_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  {n.topic_name && ` · ${n.topic_name}`}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** The revision to-do list: drag to reorder (open ones among open ones), tick off, × to delete (asks first). Every
 * change can be undone. */
