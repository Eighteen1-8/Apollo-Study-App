/* The student's own notes (rich text, mind maps and drawings), pinned at the bottom of the right sidebar. */
import { useState } from 'react';
import { api, NoteKind, NoteSummary, Subject } from '../../api';
import { exportAs } from '../../components/exportDoc';
import { getPref, setPref } from '../../prefs';
import { usePoll } from '../../hooks';
import { useOverlay } from '../../components/overlay';
import { deleteUndoably } from '../chatActions';
import Icon, { IconName } from '../../components/Icon';
import { savePng } from '../../components/ink';
import { rememberKind } from '../notes/NotePane';
import { notePicture, pictureHtml } from '../notes/notePicture';
import { setPaneDrag } from '../subject/PaneDrop';

const KIND_ICON: Record<NoteKind, IconName> = { note: 'note', map: 'noteMap', drawing: 'drawing' };
const KIND_WORD: Record<NoteKind, string> = { note: 'note', map: 'mind map', drawing: 'drawing' };


export function MyNotes({ subject, openId, onOpen, onOpenSplit, style }: {
  subject: Subject; openId: number | null; onOpen: (id: number) => void; onOpenSplit: (id: number) => void; style?: React.CSSProperties;
}) {
  const ov = useOverlay();
  const notes = usePoll(() => api.notes(subject.id), 600, [subject.id], ['notes']);
  const [folded, setFolded] = useState(() => getPref('notesFolded', false, (v) => v === '1'));
  const list = notes.data ?? [];
  list.forEach((n) => rememberKind(n.id, n.kind ?? 'note'));
  const create = async (kind: NoteKind = 'note') => {
    const n = await api.createNote(subject.id, { kind });
    rememberKind(n.id, n.kind);
    notes.reload();
    onOpen(n.id);
  };
  const createMenu = (e: React.MouseEvent) => ov.menu(e, [
    { label: 'Note', onClick: () => create('note') },
    { label: 'Mind map / flowchart', onClick: () => create('map') },
    { label: 'Drawing', onClick: () => create('drawing') },
  ], { anchor: e.currentTarget, place: 'below' });
  const failed = (e: unknown) => ov.confirm({ title: 'Export failed', body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
  const exportNote = async (n: NoteSummary, f: 'docx' | 'pdf' | 'png') => {
    try {
      const full = await api.note(n.id);
      if (f === 'png') { await savePng(await notePicture(full, 4000), full.title); return; }
      // a mind map or drawing goes in as a picture
      const html = full.kind === 'note' ? full.html : await pictureHtml(full);
      await exportAs(f, full.title, () => html);
    } catch (e) {
      failed(e);
    }
  };
  /** Check with Apollo from the list: a drawing first sends its picture. */
  const check = async (n: NoteSummary) => {
    try {
      if (n.kind === 'drawing') await api.noteSnapshot(n.id, await notePicture(await api.note(n.id), 1600));
      await api.startReview({ target: 'note', target_id: n.id, mode: 'check' });
    } catch (e) {
      ov.confirm({ title: "Couldn't start the check", body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
    }
    onOpen(n.id);
  };
  const menu = (e: React.MouseEvent, n: NoteSummary) => ov.menu(e, [
    { label: 'Open', onClick: () => onOpen(n.id) },
    { label: 'Open side by side', onClick: () => onOpenSplit(n.id) },
    { label: 'Check with Apollo', onClick: () => check(n) },
    ...(n.kind === 'note' || !n.kind ? [{ label: 'Ask Apollo to change it…', onClick: async () => {
      const instruction = await ov.prompt({ title: `What should Apollo change in “${n.title}”?`, placeholder: 'e.g. add the missing definitions', confirmText: 'Ask Apollo' });
      if (instruction) { await api.startReview({ target: 'note', target_id: n.id, mode: 'revise', instruction }); onOpen(n.id); }
    } }] : []),
    { label: 'Export to Word…', separatorBefore: true, onClick: () => exportNote(n, 'docx') },
    { label: 'Export to PDF…', onClick: () => exportNote(n, 'pdf') },
    ...(n.kind && n.kind !== 'note' ? [{ label: 'Export as a picture (.png)…', onClick: () => exportNote(n, 'png') }] : []),
    { label: 'Rename…', separatorBefore: true, onClick: async () => {
      const t = await ov.prompt({ title: `Rename ${KIND_WORD[n.kind ?? 'note']}`, initial: n.title });
      if (t) { await api.saveNote(n.id, { title: t }); notes.reload(); }
    } },
    { label: 'Delete', danger: true, onClick: async () => {
      // deleted at once: Undo (toast or Ctrl+Z) brings it back for a week
      await deleteUndoably({ what: KIND_WORD[n.kind ?? 'note'], name: n.title, del: () => api.deleteNote(n.id), restore: () => api.restoreNote(n.id) });
      notes.reload();
    } },
  ]);
  return (
    <section className={`my-notes${folded ? ' folded' : ''}`} style={folded ? undefined : style}>
      <div className="side-section-head">
        <button className="my-notes-title" onClick={() => { setFolded(!folded); setPref('notesFolded', folded ? '0' : '1'); }}>
          <span className="lib-caret"><Icon name="chevronDown" size={13} /></span> My notes {list.length > 0 && <span className="count-badge">{list.length}</span>}
        </button>
        <button className="icon-btn my-notes-new" title="New note, mind map or drawing" aria-label="New note, mind map or drawing" onClick={createMenu}><Icon name="add" /></button>
      </div>
      {!folded && (
        <div className="my-notes-list">
          {notes.data && !list.length && (
            <button className="files-empty side-empty my-notes-empty" onClick={() => create()}>
              + Write your own notes. They're kept apart from your material, and Apollo can check them for you.
            </button>
          )}
          {list.map((n) => (
            <button key={n.id} className={`note-item${n.id === openId ? ' open' : ''}`} onClick={() => onOpen(n.id)} onContextMenu={(e) => menu(e, n)}
              title={n.title} draggable onDragStart={(e) => { setPaneDrag(e.dataTransfer, { kind: 'note', id: n.id, name: n.title }); e.dataTransfer.effectAllowed = 'move'; }}>
              <span className={`note-icon kind-${n.kind ?? 'note'}`} title={KIND_WORD[n.kind ?? 'note']}><Icon name={KIND_ICON[n.kind ?? 'note']} size={14} /></span>
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
