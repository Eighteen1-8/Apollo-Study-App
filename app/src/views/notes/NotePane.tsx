/* One of the student's notes, in the editor for its kind: rich text (NoteEditor), a mind map (MapEditor) or a
   drawing (DrawingEditor). The kind is known from the notes list (rememberKind) or read from the note. */
import { useEffect, useState } from 'react';
import { api, NoteKind, Quote, Subject } from '../../api';
import { logError } from '../../log';
import NoteEditor from '../NoteEditor';
import MapEditor from './MapEditor';
import DrawingEditor from './DrawingEditor';

const kinds = new Map<number, NoteKind>();
/** The notes list (and creating a note) tell the pane each note's kind, so it opens without waiting. */
export const rememberKind = (id: number, kind: NoteKind) => { kinds.set(id, kind); };

export default function NotePane(props: {
  id: number; subject: Subject; onClose: () => void; onAsk: (q: Quote) => void; onAttach: (paths: string[]) => void;
}) {
  const { id } = props;
  const [kind, setKind] = useState<{ id: number; kind: NoteKind } | null>(() => (kinds.has(id) ? { id, kind: kinds.get(id)! } : null));
  useEffect(() => {
    if (kind?.id === id) return;
    if (kinds.has(id)) { setKind({ id, kind: kinds.get(id)! }); return; }
    let live = true;
    api.note(id).then((n) => { kinds.set(id, n.kind); if (live) setKind({ id, kind: n.kind }); }).catch((e) => logError('opening a note', e));
    return () => { live = false; };
  }, [id, kind]);
  if (kind?.id !== id) return <div className="source note-editor"><div className="muted note-opening">Opening…</div></div>;
  if (kind.kind === 'map') return <MapEditor {...props} />;
  if (kind.kind === 'drawing') return <DrawingEditor {...props} />;
  return <NoteEditor {...props} />;
}
