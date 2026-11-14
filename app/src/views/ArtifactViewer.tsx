import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Artifact, Mark, Quote, Subject } from '../api';
import { usePoll } from '../hooks';
import { MenuItem, useOverlay } from '../components/overlay';
import { highlightRow, markHighlight } from '../components/highlights';
import { undoable } from '../undo';
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
import { Marking, criterionQuote } from './artifacts/Marking';
import Icon from '../components/Icon';
import { TourButton, TourId, useFirstTime } from '../components/Tour';
import ErrorText from '../components/ErrorText';
import { Empty } from '../components/ui';
import { onChange } from '../events';
import { ApiError } from '../errors';

/** A failed load in plain words: deleted content says so; anything else keeps its error code. */
function loadError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return 'This content was deleted.';
  return String(e).replace(/^Error: /, '');
}

/** The tour for each kind of content (Tour.tsx), in the full-screen viewer and in the centre pane. */
const FULLSCREEN_TOURS: Partial<Record<string, TourId>> = { flashcards: 'flashcards', quiz: 'quiz', exam: 'exam', marking: 'marking' };
const PAGE_TOURS: Partial<Record<string, TourId>> = { notes: 'studynotes', cheatsheet: 'cheatsheet', mindmap: 'mindmap', marking: 'marking' };

/** Fullscreen viewer for generated content, closed with the × at the top right (or Escape). */
export default function ArtifactViewer({ id, subject, onClose }: { id: number; subject: Subject; onClose: () => void }) {
  const ov = useOverlay();
  const [a, setA] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api.artifact(id).then((x) => alive && setA(x)).catch((e) => alive && setError(loadError(e)));
    return () => { alive = false; };
  }, [id]);
  useEffect(() => {
    // Escape closes a dialog or menu open over the viewer first
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented
      && !document.querySelector('.modal-backdrop, .ctx-menu') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const tour = a ? FULLSCREEN_TOURS[a.type] : undefined;
  useFirstTime(tour, !!a?.content);
  // portalled so it always covers the window, whatever transformed/clipped panel it was opened from
  return createPortal(
    <div className="fullscreen">
      <div className="fs-top">
        <div className="fs-title">{a?.title ?? (error ? "Couldn't open this" : 'Loading…')}</div>
        {a?.type === 'exam' && a.content && (
          <button className="btn btn-sm" onClick={(e) => ov.menu(e, [false, true].flatMap((answers) => (['docx', 'pdf'] as const).map((f, i) => ({
            label: `${f === 'docx' ? 'Word document (.docx)' : 'PDF'}${answers ? ' with answers and marking scheme' : ''}`,
            separatorBefore: answers && i === 0,
            onClick: () => {
              exportAs(f, answers ? `${a.title} (with answers)` : a.title, (word) => artifactHtml(a, word, answers))
                .catch((err) => ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }));
            },
          }))), { anchor: e.currentTarget, place: 'below' })}>Export <Icon name="chevronDown" size={14} /></button>
        )}
        {tour && a?.content && <TourButton id={tour} />}
        <button className="close-x close-x-lg" title="Close (Esc)" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      <div className="fs-body" data-find={a?.title ?? 'this page'}>
        {error && <Empty title="Couldn't open this content"><ErrorText text={error} /></Empty>}
        {a?.content && (
          a.type === 'flashcards' ? <Flashcards artifact={a} />
            : a.type === 'quiz' ? <Quiz artifact={a} subject={subject} />
            : a.type === 'marking' ? <Marking artifact={a} />
            : <div className="fs-doc">{a.type === 'exam' ? <Exam artifact={a} /> : <Sections content={a.content} />}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}


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
  const shot = useAreaShot(a?.title ?? 'notes', onAttach, (msg) => ov.confirm({ title: "Couldn't take a screenshot", body: msg, confirmText: 'OK' }),
    a ? { subjectId: a.subject_id, source: a.title } : undefined);
  const [error, setError] = useState<string | null>(null);
  const busy = a?.status === 'queued' || a?.status === 'running';
  useEffect(() => {
    let alive = true;
    setError(null);
    api.artifact(id).then((x) => { if (alive) setA(x); }).catch((e) => { if (alive) setError(loadError(e)); });
    return () => { alive = false; };
  }, [id, gen]);
  // while it is being regenerated, its progress arrives as library changes (no polling)
  useEffect(() => (busy ? onChange(['library'], () => setGen((g) => g + 1)) : undefined), [busy]);
  const isMap = a?.type === 'mindmap';
  const isMarking = a?.type === 'marking';
  const reviewable = a?.type === 'notes' || a?.type === 'cheatsheet';
  const secs = a?.content?.sections ?? [];

  /** The rendered text of section i (what mark offsets count in). */
  const [owner] = useState(() => `artifact-${id}-${Math.random().toString(36).slice(2, 8)}`);
  const secRoot = (i: number) => scroll.current?.querySelector<HTMLElement>(`[data-sec="${i}"] .md`) ?? null;

  const paintedMarks = useRef(new Set<string>());
  useEffect(() => () => { for (const n of paintedMarks.current) paint(n, [], owner); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
    // every colour in use gets its own CSS highlight (custom colours too); colours no longer used are cleared
    const names = new Map(Object.entries(byColor).map(([c, rs]) => [markHighlight(c), rs]));
    for (const n of paintedMarks.current) if (!names.has(n)) paint(n, [], owner);
    for (const [n, rs] of names) paint(n, rs, owner);
    paintedMarks.current = new Set(names.keys());
  }, [marks.data, a]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Highlight actions, each undoable (a removed highlight comes back as a new mark: `box` follows it). */
  const addHighlight = async (section: number, start: number, end: number, text: string, color: string) => {
    const m = await api.addMark(id, { section, start, end, text, color });
    window.getSelection()?.removeAllRanges();
    marks.reload();
    const box = { id: m.id };
    undoable({ label: 'highlight', undo: async () => { await api.deleteMark(box.id); marks.reload(); },
      redo: async () => { box.id = (await api.addMark(id, { section, start, end, text, color })).id; marks.reload(); } });
  };
  const recolour = async (m: Mark, color: string) => {
    if (m.color === color) return;
    await api.moveMark(m.id, { color });
    marks.reload();
    undoable({ label: 'change highlight colour', undo: async () => { await api.moveMark(m.id, { color: m.color }); marks.reload(); },
      redo: async () => { await api.moveMark(m.id, { color }); marks.reload(); } });
  };
  const removeHighlight = async (m: Mark) => {
    await api.deleteMark(m.id);
    marks.reload();
    const box = { id: m.id };
    undoable({ label: 'remove highlight',
      undo: async () => { box.id = (await api.addMark(id, { section: m.section, start: m.start, end: m.end, text: m.text, color: m.color })).id; marks.reload(); },
      redo: async () => { await api.deleteMark(box.id); marks.reload(); } });
  };

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
    if (isMarking) {  // selected feedback: ask about it or copy it
      const r = selectionIn(scroll.current);
      const root = scroll.current?.querySelector('.marking');
      const crit = (r?.startContainer.parentElement ?? (e.target as Element)).closest<HTMLElement>('[data-crit]');
      const c = crit ? a.content?.marking?.criteria[Number(crit.dataset.crit)] : undefined;
      const items: MenuItem[] = [];
      if (r && root) {
        const q = quoteParts(root, r);
        items.push({ label: 'Ask Apollo about this', onClick: () => onAsk({ document_id: null, filename: a.title, label: c?.label ?? 'Marking', ...q }) },
          { label: 'Copy', hint: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(r.toString()) });
      } else if (c) {
        items.push({ label: `Ask Apollo about ${c.label}`, onClick: () => onAsk(criterionQuote(a.title, c)) },
          { label: 'Copy feedback', onClick: () => navigator.clipboard.writeText(c.feedback) });
      }
      items.push({ label: 'Export to Word…', separatorBefore: items.length > 0, onClick: () => exportAs('docx', a.title, (word) => artifactHtml(a, word)).catch((err) => logError('export', err)) },
        { label: 'Export to PDF…', onClick: () => exportAs('pdf', a.title, (word) => artifactHtml(a, word)).catch((err) => logError('export', err)) });
      ov.menu(e, items);
      return;
    }
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
    const target = e.target as Element;
    const whole = a.type === 'cheatsheet' ? 'the cheat sheet' : 'these notes';
    const copy = (text: string) => navigator.clipboard.writeText(text).catch((err) => logError('copy', err, 'warning'));
    const cite = (sec: number) => `${a.title}${secs[sec]?.title && secs.length > 1 ? ` · ${secs[sec].title}` : ''}`;
    /** Ask / check / change / highlight / copy actions for one range of text in a section. */
    const rangeActions = (r: Range, w: { index: number; root: HTMLElement }, what: string): MenuItem[] => {
      const q = quoteParts(w.root, r);
      const [start, end] = offsetsOf(w.root, r);
      const text = r.toString();
      return [
        { label: `Ask Apollo about ${what}`, onClick: () => onAsk({ document_id: null, filename: a.title, label: secs[w.index]?.title ?? '', ...q }) },
        ...(reviewable ? [
          { label: `Check ${what} with Apollo`, onClick: () => { check(q.text, w.index); } },
          { label: `Ask Apollo to change ${what}…`, onClick: () => { revise(q.text, w.index); } },
        ] : []),
        { ...highlightRow({
          onPick: (c) => addHighlight(w.index, start, end, text, c),
          onCustom: async () => {
            const c = await ov.color({ title: 'Highlight colour' });
            if (c) addHighlight(w.index, start, end, text, c);
          },
        }), separatorBefore: true },
        { label: 'Copy', hint: 'Ctrl+C', onClick: () => copy(text) },
        { label: 'Copy with source', onClick: () => copy(`“${text.trim()}” (${cite(w.index)})`) },
      ];
    };

    const items: MenuItem[] = [];
    const r = selectionIn(scroll.current);
    const where = r && sectionOf(r);
    if (r && where) {
      const t = r.toString().trim().replace(/\s+/g, ' ');
      items.push({ label: `“${t.slice(0, 40)}${t.length > 40 ? '…' : ''}”`, header: true }, ...rangeActions(r, where, 'this'));
    }

    // what was right-clicked: a formula, figure, highlight or block (definition, card, table…)
    const tex = !r ? target.closest<HTMLElement>('[data-tex]')?.dataset.tex : undefined;
    const img = !r ? target.closest('figure')?.querySelector('img') : null;
    const hit = !r ? markAt(e.clientX, e.clientY) : undefined;
    const secEl = target.closest<HTMLElement>('[data-sec]');
    const secIdx = secEl ? Number(secEl.dataset.sec) : null;
    const secRootEl = secIdx !== null ? secRoot(secIdx) : null;
    if (hit) {
      items.push(
        { label: `Highlight “${hit.text.slice(0, 28)}${hit.text.length > 28 ? '…' : ''}”`, header: true, separatorBefore: items.length > 0 },
        highlightRow({
          label: 'Colour', current: hit.color,
          onPick: (c) => recolour(hit, c),
          onCustom: async () => { const c = await ov.color({ title: 'Highlight colour', initial: hit.color }); if (c) recolour(hit, c); },
        }),
        { label: 'Copy', onClick: () => copy(hit.text) },
        { label: 'Remove highlight', danger: true, onClick: () => removeHighlight(hit) },
      );
    }
    // (a formula block gets its block actions below; maths inline in text gets its own "ask")
    const inBlock = !!target.closest('.formula');
    if (tex) {
      items.push(
        { label: 'Formula', header: true, separatorBefore: items.length > 0 },
        { label: 'Copy as LaTeX', onClick: () => copy(tex) },
        ...(inBlock ? [] : [{ label: 'Ask Apollo about this formula', onClick: () => onAsk({ document_id: null, filename: a.title, label: secIdx !== null ? secs[secIdx]?.title ?? '' : '', text: `$${tex}$`, before: '', after: '' }) }]),
      );
    }
    if (img) {
      items.push(
        { label: 'Figure', header: true, separatorBefore: items.length > 0 },
        { label: 'Copy image', onClick: async () => {
          try {
            const blob = await (await fetch(img.src)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
          } catch (err) { logError('copy image', err, 'warning'); }
        } },
      );
    }
    const BLOCKS: [string, string][] = [['.def', 'this definition'], ['.formula', 'this formula'], ['.callout', 'this callout'],
      ['details.example', 'this worked example'], ['table', 'this table'], ['.card', 'this card'], ['li', 'this point'], ['p', 'this paragraph']];
    const block = !r && !hit && secRootEl ? BLOCKS.map(([sel, name]) => [target.closest(sel), name] as const).find(([el]) => el && secRootEl.contains(el)) : undefined;
    if (block && secIdx !== null && secRootEl) {
      const range = document.createRange();
      range.selectNodeContents(block[0]!);
      const acts = rangeActions(range, { index: secIdx, root: secRootEl }, block[1]);
      if (!(tex && inBlock)) items.push({ label: block[1].replace(/^this /, ''), header: true, separatorBefore: items.length > 0 });
      items.push(...acts.slice(0, reviewable ? 3 : 1),
        { label: 'More', children: acts.slice(reviewable ? 3 : 1).map((x) => ({ ...x, separatorBefore: false })) });
    }

    // the section and the whole page
    if (secIdx !== null && secs.length > 1 && secRootEl) {
      const title = secs[secIdx]?.title ?? `Section ${secIdx + 1}`;
      items.push({ label: `Section: ${title}`, separatorBefore: items.length > 0, children: [
        ...(reviewable ? [
          { label: 'Check this section with Apollo', onClick: () => { check('', secIdx); } },
          { label: 'Ask Apollo to change this section…', onClick: () => { revise('', secIdx); } },
        ] : []),
        { label: 'Copy section text', separatorBefore: reviewable, onClick: () => copy(secRootEl.innerText) },
      ] });
    }
    if (reviewable) {
      items.push({ label: a.type === 'cheatsheet' ? 'Whole cheat sheet' : 'All notes', separatorBefore: items.length > 0 && !(secIdx !== null && secs.length > 1), children: [
        { label: `Check ${whole} with Apollo`, onClick: () => { check(); } },
        { label: `Ask Apollo to change ${whole}…`, onClick: () => { revise(); } },
        { label: 'Copy all text', separatorBefore: true, onClick: () => copy(scroll.current?.querySelector<HTMLElement>('.notes')?.innerText ?? '') },
        { label: 'Export to Word…', separatorBefore: true, onClick: () => exportAs('docx', a.title, (word) => artifactHtml(a, word)).catch((err) => logError('export', err)) },
        { label: 'Export to PDF…', onClick: () => exportAs('pdf', a.title, (word) => artifactHtml(a, word)).catch((err) => logError('export', err)) },
      ] });
      items.push({ label: showReviews ? 'Hide comments' : 'Show comments', onClick: () => setShowReviews(!showReviews) });
    }
    items.push(
      { label: 'Find in page', hint: 'Ctrl+F', onClick: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })) },
      { label: 'Screenshot an area', hint: 'right-drag', disabled: true },
    );
    ov.menu(e, items);
  };

  const exportMenu = (e: React.MouseEvent) => ov.menu(e, (['docx', 'pdf'] as const).map((f) => ({
    label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
    onClick: async () => {
      try { if (a) await exportAs(f, a.title, (word) => artifactHtml(a, word)); }
      catch (err) { ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }); }
    },
  })), { anchor: e.currentTarget, place: 'below' });

  const kind = a?.type === 'notes' ? 'Full notes' : a?.type === 'cheatsheet' ? 'Cheat sheet' : isMarking ? 'Marking' : 'Mind map';
  const pageTour = a ? PAGE_TOURS[a.type] : undefined;
  useFirstTime(pageTour, !!a?.content);
  const active = (reviews.data ?? []).length;
  return (
    <div className={`source artifact-page${showReviews ? ' with-reviews' : ''}`}>
      <header className="source-head">
        <div className="source-title" title={a?.title}>{a?.title ?? ''}</div>
        {a && <span className="muted small">{kind}{isMap || isMarking ? '' : ` · ${secs.length} sections`}</span>}
        {a && (busy
          ? <span className="muted small">{a.message || 'Regenerating…'} {Math.round(a.progress * 100)}%</span>
          : a.status !== 'ready' && a.resumable ? <button className="btn btn-sm" title="Carry on from the parts already finished" onClick={async () => {
            await api.retryArtifact(id);
            setA({ ...a, status: 'queued', progress: 0, message: 'Waiting for Apollo…' });
            setGen((g) => g + 1);
          }}>Continue</button>
          : <button className="btn btn-sm" title={isMarking ? 'Mark the work again' : 'Write this again from your material'} onClick={async () => {
            await api.retryArtifact(id);
            setA({ ...a, status: 'queued', progress: 0, message: 'Waiting for Apollo…' });
            setGen((g) => g + 1);
          }}>Regenerate</button>)}
        {reviewable && !busy && (
          <>
            <button className="btn btn-sm" data-tip="Have Apollo check this against your material" onClick={() => { check(); }}>Check with Apollo</button>
            <button className={`btn btn-sm${showReviews ? ' on' : ''}`} onClick={() => setShowReviews(!showReviews)}>Comments{active ? ` (${active})` : ''}</button>
            <button className="btn btn-sm" onClick={exportMenu}>Export <Icon name="chevronDown" size={14} /></button>
          </>
        )}
        {isMarking && !busy && a?.content && <button className="btn btn-sm" onClick={exportMenu}>Export <Icon name="chevronDown" size={14} /></button>}
        {pageTour && a?.content && <TourButton id={pageTour} />}
        <button className="close-x" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </header>
      <div className="ne-body">
        <div ref={scroll} className={`artifact-scroll${isMap ? ' is-map' : ''}`} data-find={isMap ? undefined : (a?.title ?? 'these notes')}
          onPointerDown={shot.onPointerDown} onContextMenu={contextMenu}>
          {error && !a && <Empty title="Couldn't open this content"><ErrorText text={error} /></Empty>}
          {a?.content && (isMap
            ? a.content.mindmap && <MindMap root={a.content.mindmap} title={a.title} onCite={onCite}
              onAsk={(text, before) => onAsk({ document_id: null, filename: a.title, label: 'Mind map', text, before, after: '' })} />
            : isMarking ? <Marking artifact={a} onAsk={onAsk} onCite={onCite} />
            : <div className="fs-doc"><Sections content={a.content} onCite={onCite} /></div>)}
        </div>
        {showReviews && (
          <Reviews target="artifact" id={id} list={reviews.data ?? []} onClose={() => setShowReviews(false)} onCite={onCite}
            onApplied={() => { reviews.reload(); setGen((g) => g + 1); }} />
        )}
      </div>
      {shot.overlay}
    </div>
  );
}
