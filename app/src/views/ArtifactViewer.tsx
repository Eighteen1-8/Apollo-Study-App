import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Artifact, Quote, Subject } from '../api';
import { usePoll } from '../hooks';
import { MenuItem, useOverlay } from '../components/overlay';
import Reviews, { useReviews } from '../components/Reviews';
import { useAreaShot } from '../components/areaShot';
import { artifactHtml, exportAs } from '../components/exportDoc';
import { findAll, offsetsOf, paint, quoteParts, rangeAt, selectionIn } from '../components/textRange';
import { logError } from '../log';
import MindMap from './artifacts/MindMap';
import { Flashcards } from './artifacts/Flashcards';
import { Quiz } from './artifacts/Quiz';
import { Exam } from './artifacts/Exam';
import { Sections } from './artifacts/Sections';

/** Fullscreen viewer for generated content, closed with the × at the top right (or Escape). */
export default function ArtifactViewer({ id, subject, onClose }: { id: number; subject: Subject; onClose: () => void }) {
  const ov = useOverlay();
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
        {a?.type === 'exam' && a.content && (
          <button className="btn btn-sm" onClick={(e) => ov.menu(e, [false, true].flatMap((answers) => (['docx', 'pdf'] as const).map((f, i) => ({
            label: `${f === 'docx' ? 'Word document (.docx)' : 'PDF'}${answers ? ' with answers and marking scheme' : ''}`,
            separatorBefore: answers && i === 0,
            onClick: () => {
              exportAs(f, answers ? `${a.title} (with answers)` : a.title, (word) => artifactHtml(a, word, answers))
                .catch((err) => ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }));
            },
          }))), { anchor: e.currentTarget, place: 'below' })}>Export ▾</button>
        )}
        <button className="close-x close-x-lg" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      <div className="fs-body" data-find={a?.title ?? 'this page'}>
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

const MARK_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;

/** Notes, cheat sheets and mind maps read like a document, so they open in the centre pane (the chat floats beside
 * them). Highlighted text can be asked about, checked or revised by Apollo, or highlighted (saved as text offsets
 * and painted with CSS highlights, so the generated HTML is never touched); right-drag boxes an area for a
 * screenshot. Apollo's checks and revisions sit in a comments panel beside the page. */
export function ArtifactPage({ id, onClose, onCite, onAsk, onAttach }: {
  id: number; onClose: () => void; onCite: (file: string, label: string) => void;
  onAsk: (q: Quote) => void; onAttach: (paths: string[]) => void;
}) {
  const ov = useOverlay();
  const [a, setA] = useState<Artifact | null>(null);
  const [gen, setGen] = useState(0); // bumped by Regenerate to restart polling
  const [showReviews, setShowReviews] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const marks = usePoll(() => api.marks(id), 0, [id]);
  const reviews = useReviews('artifact', id);
  const opened = useRef(false);
  useEffect(() => {  // comments open by themselves when Apollo is working on one (e.g. asked from the chat)
    if (opened.current || !reviews.data) return;
    opened.current = true;
    if (reviews.data.some((r) => r.status === 'queued' || r.status === 'running')) setShowReviews(true);
  }, [reviews.data]);
  const shot = useAreaShot(a?.title ?? 'notes', onAttach, (msg) => ov.confirm({ title: "Couldn't take a screenshot", body: msg, confirmText: 'OK' }));
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
  const isMap = a?.type === 'mindmap';
  const reviewable = a?.type === 'notes' || a?.type === 'cheatsheet';
  const secs = a?.content?.sections ?? [];

  /** The rendered text of section i (what mark offsets count in). */
  const secRoot = (i: number) => scroll.current?.querySelector<HTMLElement>(`[data-sec="${i}"] .md`) ?? null;

  // paint the student's highlights; a highlight whose text moved (the section was revised) is found again
  useEffect(() => {
    const list = marks.data ?? [];
    const byColor: Record<string, Range[]> = {};
    for (const m of list) {
      const root = secRoot(m.section);
      if (!root) continue;
      let r = rangeAt(root, m.start, m.end);
      if (!r || r.toString().replace(/\s+/g, ' ') !== m.text.replace(/\s+/g, ' ')) {
        r = findAll(root, m.text, 1)[0] ?? null;
        if (r) {
          const [start, end] = offsetsOf(root, r);
          api.moveMark(m.id, { start, end }).catch((e) => logError('moving a highlight', e, 'warning'));
        }
      }
      if (r) (byColor[m.color] ??= []).push(r);
    }
    for (const c of MARK_COLORS) paint(`mark-${c}`, byColor[c] ?? []);
    return () => { for (const c of MARK_COLORS) paint(`mark-${c}`, []); };
  }, [marks.data, a]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Which section a range is in, and its text root. */
  const sectionOf = (r: Range) => {
    const n = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
    const sec = n?.closest<HTMLElement>('[data-sec]');
    const root = sec?.querySelector<HTMLElement>('.md');
    return sec && root && root.contains(r.endContainer) ? { index: Number(sec.dataset.sec), root } : null;
  };
  const markAt = (x: number, y: number) => (marks.data ?? []).find((m) => {
    const root = secRoot(m.section);
    const r = root && rangeAt(root, m.start, m.end);
    return r && [...r.getClientRects()].some((b) => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2);
  });

  const check = async (quote = '', section: number | null = null) => {
    await api.startReview({ target: 'artifact', target_id: id, mode: 'check', quote, section });
    setShowReviews(true);
    reviews.reload();
  };
  const revise = async (quote = '', section: number | null = null) => {
    const instruction = await ov.prompt({
      title: quote ? 'What should Apollo change here?' : `What should Apollo change in ${a?.type === 'cheatsheet' ? 'this cheat sheet' : 'these notes'}?`,
      placeholder: 'e.g. add a worked example, make this shorter, fix the units', confirmText: 'Ask Apollo',
    });
    if (!instruction) return;
    await api.startReview({ target: 'artifact', target_id: id, mode: 'revise', quote, section, instruction });
    setShowReviews(true);
    reviews.reload();
  };

  const contextMenu = (e: React.MouseEvent) => {
    const area = shot.takeMenu();
    if (area) { ov.menu(e, area); return; }
    if (!a) return;
    if (isMap) {  // a node: ask about it or copy it
      const node = (e.target as Element).closest<SVGGElement>('[data-mm]');
      if (!node) return;
      const label = node.dataset.mmLabel ?? '';
      ov.menu(e, [
        { label: 'Ask Apollo about this', onClick: () => onAsk({ document_id: null, filename: a.title, label: 'Mind map', text: label, before: node.dataset.mmContext ?? '', after: '' }) },
        { label: 'Copy', onClick: () => navigator.clipboard.writeText(label) },
        { label: 'Tip: right-drag to screenshot an area', disabled: true, separatorBefore: true, onClick: () => {} },
      ]);
      return;
    }
    const r = selectionIn(scroll.current);
    const where = r && sectionOf(r);
    const items: MenuItem[] = [];
    if (r && where) {
      const q = quoteParts(where.root, r);
      const [start, end] = offsetsOf(where.root, r);
      items.push(
        { label: 'Ask Apollo about this', onClick: () => onAsk({ document_id: null, filename: a.title, label: secs[where.index]?.title ?? '', ...q }) },
        ...(reviewable ? [
          { label: 'Check this with Apollo', onClick: () => { check(q.text, where.index); } },
          { label: 'Ask Apollo to change this…', onClick: () => { revise(q.text, where.index); } },
        ] : []),
        ...MARK_COLORS.map((c, i) => ({ label: `Highlight ${c}`, separatorBefore: i === 0, onClick: async () => {
          await api.addMark(id, { section: where.index, start, end, text: r.toString(), color: c });
          window.getSelection()?.removeAllRanges();
          marks.reload();
        } })),
        { label: 'Copy', separatorBefore: true, onClick: () => navigator.clipboard.writeText(r.toString()) },
      );
    }
    const hit = !r ? markAt(e.clientX, e.clientY) : undefined;
    if (hit) items.push({ label: `Remove highlight “${hit.text.slice(0, 24)}${hit.text.length > 24 ? '…' : ''}”`, danger: true,
      onClick: async () => { await api.deleteMark(hit.id); marks.reload(); } });
    if (!r && reviewable) {
      items.push(
        { label: `Check ${a.type === 'cheatsheet' ? 'the cheat sheet' : 'these notes'} with Apollo`, separatorBefore: !!hit, onClick: () => { check(); } },
        { label: 'Ask Apollo to change…', onClick: () => { revise(); } },
      );
    }
    items.push({ label: 'Tip: right-drag to screenshot an area', disabled: true, separatorBefore: items.length > 0, onClick: () => {} });
    ov.menu(e, items);
  };

  const exportMenu = (e: React.MouseEvent) => ov.menu(e, (['docx', 'pdf'] as const).map((f) => ({
    label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
    onClick: async () => {
      try { if (a) await exportAs(f, a.title, (word) => artifactHtml(a, word)); }
      catch (err) { ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }); }
    },
  })), { anchor: e.currentTarget, place: 'below' });

  const kind = a?.type === 'notes' ? 'Full notes' : a?.type === 'cheatsheet' ? 'Cheat sheet' : 'Mind map';
  const active = (reviews.data ?? []).length;
  return (
    <div className={`source artifact-page${showReviews ? ' with-reviews' : ''}`}>
      <header className="source-head">
        <div className="source-title" title={a?.title}>{a?.title ?? ''}</div>
        {a && <span className="muted small">{kind}{isMap ? '' : ` · ${secs.length} sections`}</span>}
        {a && (busy
          ? <span className="muted small">{a.message || 'Regenerating…'} {Math.round(a.progress * 100)}%</span>
          : <button className="btn btn-sm" title="Write this again from your material" onClick={async () => {
            await api.retryArtifact(id);
            setA({ ...a, status: 'queued', progress: 0, message: 'Waiting for Apollo…' });
            setGen((g) => g + 1);
          }}>Regenerate</button>)}
        {reviewable && !busy && (
          <>
            <button className="btn btn-sm" data-tip="Have Apollo check this against your material" onClick={() => { check(); }}>Check with Apollo</button>
            <button className={`btn btn-sm${showReviews ? ' on' : ''}`} onClick={() => setShowReviews(!showReviews)}>Comments{active ? ` (${active})` : ''}</button>
            <button className="btn btn-sm" onClick={exportMenu}>Export ▾</button>
          </>
        )}
        <button className="close-x" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="ne-body">
        <div ref={scroll} className={`artifact-scroll${isMap ? ' is-map' : ''}`} data-find={isMap ? undefined : (a?.title ?? 'these notes')}
          onPointerDown={shot.onPointerDown} onContextMenu={contextMenu}>
          {a?.content && (isMap
            ? a.content.mindmap && <MindMap root={a.content.mindmap} title={a.title} onCite={onCite}
              onAsk={(text, before) => onAsk({ document_id: null, filename: a.title, label: 'Mind map', text, before, after: '' })} />
            : <div className="fs-doc"><Sections content={a.content} onCite={onCite} /></div>)}
        </div>
        {showReviews && (
          <Reviews target="artifact" id={id} list={reviews.data ?? []} onClose={() => setShowReviews(false)}
            onApplied={() => { reviews.reload(); setGen((g) => g + 1); }} />
        )}
      </div>
      {shot.overlay}
    </div>
  );
}
