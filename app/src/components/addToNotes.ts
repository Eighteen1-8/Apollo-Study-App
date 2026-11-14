/* "Add to notes" (a file's selection or screenshot, part of Apollo's answer): into the note open beside it, or, with
   none open, a short menu of the subject's recent notes plus "New note", which opens that note beside what's showing
   and puts the content in once it has loaded (noteInsert.ts). */
import { api } from '../api';
import { currentNoteTarget, openNoteBeside, queueForNote, recentNotes, takeQueued } from '../noteInsert';
import type { useOverlay } from './overlay';
import { toast } from './toast';

type Ov = ReturnType<typeof useOverlay>;
type At = { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void };

/** A point to open the chooser at (a button's corner, when there's no pointer event to hand). */
export const pointAt = (el: Element | null | undefined, x = 0, y = 0): At => {
  const r = el?.getBoundingClientRect();
  return { clientX: r ? r.left : x, clientY: r ? r.bottom : y, preventDefault() {}, stopPropagation() {} };
};

/** A screenshot of part of a file's page, as a data: URL a note can keep. */
export async function snapshotDataUrl(a: { document_id: number; unit: number; rect: [number, number, number, number] }): Promise<string> {
  const shot = await api.snapshot(a.document_id, a.unit, a.rect);
  const blob = await fetch(api.assetUrl(shot.asset)).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** `make` builds the HTML (a screenshot is taken first, before any menu can get in the picture). */
export async function addToNotes(make: () => string | Promise<string>, o: { subjectId: number; ov: Ov; at: At }) {
  const fail = (e: unknown) => o.ov.confirm({ title: "Couldn't add it to your notes", body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
  let html: string;
  try { html = await make(); } catch (e) { fail(e); return; }
  const open = currentNoteTarget();
  if (open) {
    open.insert(html);
    toast(`Added to “${open.title?.() ?? 'your note'}”`);
    return;
  }
  const put = async (noteId: number, title: string) => {
    queueForNote(noteId, html);
    if (!openNoteBeside(noteId)) { // not in a subject's workspace: add it to the end of the saved note
      takeQueued(noteId);
      const n = await api.note(noteId);
      await api.saveNote(noteId, { html: n.html + html });
    }
    toast(`Added to “${title}”`);
  };
  let list: Awaited<ReturnType<typeof api.notes>> = [];
  try { list = recentNotes(await api.notes(o.subjectId)); } catch { /* offer a new note only */ }
  o.ov.menu(o.at, [
    { label: 'Add to which note?', header: true },
    ...list.map((n) => ({ label: n.title || 'Untitled note', onClick: () => { put(n.id, n.title || 'Untitled note').catch(fail); } })),
    { label: 'New note', separatorBefore: list.length > 0, onClick: () => {
      api.createNote(o.subjectId, { kind: 'note' }).then((n) => put(n.id, n.title || 'a new note')).catch(fail);
    } },
  ]);
}
