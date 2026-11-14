import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, Annotation, AnnotationData, AnnotationKind, authUrl, BASE, DocDetail, DocLayout, OutlineItem, Quote, TextAnchor } from '../api';
import { MenuItem, useOverlay } from '../components/overlay';
import { Empty } from '../components/ui';
import { AnnoApi, AnnoContext, Area, HIGHLIGHT_COLORS, INK_COLORS, Tool, UnitOverlay } from './annotate';
import { anchorFromRange, notePlacement } from './annotate-geometry';
import { AnnotationRail } from './AnnotationRail';
import { matchUnit } from './DocumentView';
import { Minimap, OutlinePanel } from './navigate';
import { logError } from '../log';
import { sectionAt, quoteFromRange } from './source/selection';
import { PdfView, SlidesView, DocxView, TextView } from './source/layouts';
import { getPref, setPref } from '../prefs';
import Icon, { IconName } from '../components/Icon';
import { openFind } from '../components/FindBar';
import { toggleCalculator, useCalculatorOpen } from '../components/Calculator';
import { TourButton, useFirstTime } from '../components/Tour';
import { addToNotes, pointAt, snapshotDataUrl } from '../components/addToNotes';
import { AREA_DRAG, AreaDrag, imageHtml, quoteHtml, setQuoteDrag, sourceLine, useNoteTarget } from '../noteInsert';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

const TOOLS: { tool: Tool; name: string; label: string; icon: IconName }[] = [
  { tool: 'select', name: 'Select', label: 'Select text (V)', icon: 'select' },
  { tool: 'highlight', name: 'Highlight', label: 'Highlight (H)', icon: 'highlight' },
  { tool: 'pen', name: 'Pen', label: 'Pen: draw on the page (P)', icon: 'pen' },
  { tool: 'eraser', name: 'Eraser', label: 'Eraser: remove pen strokes (E)', icon: 'eraser' },
  { tool: 'textbox', name: 'Text', label: 'Text box: write on the page (T)', icon: 'textbox' },
  { tool: 'note', name: 'Note', label: 'Note box (N)', icon: 'note' },
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'highlight', p: 'pen', e: 'eraser', t: 'textbox', n: 'note', s: 'area' };

/**
 * The original document, rendered as itself: PDF pages (pdf.js), slides, Word pages, text, images. Every unit
 * (page / slide / section) is a `[data-unit]` element so citations can scroll to it, highlights know their source and
 * annotations are drawn over it. Selecting text offers Define / Ask Apollo / Highlight / Note; right-click also offers the
 * ingest details view. The right rail lists every annotation.
 */
export default function SourceView({ id, focus, pulse, onClose, onDetails, onAsk, onAttach, onMake }: {
  id: number; focus?: string; onClose: () => void; onDetails: () => void; onAsk: (q: Quote) => void;
  /** Make content from just this file (the Make content steps). */
  onMake?: () => void;
  /** Send files (a screenshot of part of a page) to the chat for the next message. */
  onAttach: (paths: string[]) => void;
  /** Scroll to this area and outline it briefly (a screenshot's source). */
  pulse?: Area;
}) {
  const ov = useOverlay();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [layout, setLayout] = useState<DocLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [askAt, setAskAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const [items, setItems] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [hlColor, setHlColor] = useState(HIGHLIGHT_COLORS[0]);
  const [inkColor, setInkColor] = useState(INK_COLORS[0]);
  const [editing, setEditing] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [rail, setRail] = useState(() => getPref<string>('annoRail', 'on') !== 'off');
  const [units, setUnits] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  // the student's note open beside this file, if any: where "Add to notes" goes (noteInsert.ts)
  const noteTarget = useNoteTarget();
  const pendingPatch = useRef(new Map<number, { data?: AnnotationData; anchor?: TextAnchor; timer?: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    Promise.all([api.document(id), api.documentLayout(id), api.annotations(id)])
      .then(([d, l, a]) => { setDoc(d); setLayout(l); setItems(a.items); })
      .catch((e) => setError(String(e)));
  }, [id]);

  // ---- annotation store (optimistic; text edits are saved after a short pause)
  const [area, setArea] = useState<Area | null>(null);
  const [pulsing, setPulsing] = useState<Area | null>(null);
  const pulsed = useRef(false);
  const areaRef = useRef<Area | null>(null);
  const setAreaBoth = (a: Area | null) => { areaRef.current = a; setArea(a); };
  const areaMenu = (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, a = areaRef.current) => {
    if (!a) return;
    ov.menu(e, [
      { label: 'Send to chat as a screenshot', onClick: () => sendArea(a) },
      { label: noteTarget ? `Add to “${noteTarget.title?.() ?? 'my note'}”` : 'Add to my notes…', onClick: () => areaToNotes(a, e) },
      { label: 'Add a note for this area', onClick: () => noteArea(a) },
      { label: 'Clear selection', separatorBefore: true, onClick: () => setAreaBoth(null) },
    ]);
  };
  const areaMenuRef = useRef(areaMenu);
  areaMenuRef.current = areaMenu;
  // the area box can be dragged into a note (it takes the screenshot when dropped: NoteEditor)
  const areaDrag = (e: React.DragEvent, a: Area) => {
    if (!doc) return;
    const payload: AreaDrag = { document_id: doc.id, unit: a.unit, rect: a.rect, source: sourceLine(doc.filename, unitLabel(a.unit)) };
    e.dataTransfer.setData(AREA_DRAG, JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', payload.source);
    e.dataTransfer.effectAllowed = 'copy';
  };
  const areaDragRef = useRef(areaDrag);
  areaDragRef.current = areaDrag;

  const anno: AnnoApi = useMemo(() => ({
    area, setArea: (a: Area | null) => setAreaBoth(a), areaMenu: (e, a) => areaMenuRef.current(e, a ?? undefined), pulse: pulsing,
    areaDrag: (e: React.DragEvent, a: Area) => areaDragRef.current(e, a),
    items, tool, setTool, hlColor, inkColor, editing, flashId,
    fixed: layout?.kind === 'pdf' || layout?.kind === 'slides',
    create: async (unit: number, kind: AnnotationKind, anchor: TextAnchor, data: AnnotationData) => {
      if (layout?.kind === 'pdf' && layout.source === 'docx') data = { ...data, space: 'pdf' }; // unit is a page here
      const a = await api.createAnnotation(id, { unit, kind, anchor, data });
      setItems((xs) => [...xs, a]);
      if (kind === 'textbox' || (kind === 'note' && !data.pending)) setEditing(a.id);
      return a;
    },
    update: (aid: number, patch: { data?: AnnotationData; anchor?: TextAnchor }) => {
      setItems((xs) => xs.map((a) => (a.id === aid ? { ...a, data: { ...a.data, ...patch.data }, anchor: patch.anchor ?? a.anchor } : a)));
      const p = pendingPatch.current.get(aid) ?? {};
      clearTimeout(p.timer);
      const next: typeof p = { data: { ...p.data, ...patch.data }, anchor: patch.anchor ?? p.anchor };
      next.timer = setTimeout(() => {
        pendingPatch.current.delete(aid);
        api.updateAnnotation(aid, { data: next.data, anchor: next.anchor }).catch((e) => logError('saving an annotation', e));
      }, 400);
      pendingPatch.current.set(aid, next);
    },
    remove: (aid: number) => {
      clearTimeout(pendingPatch.current.get(aid)?.timer);
      pendingPatch.current.delete(aid);
      setItems((xs) => xs.filter((a) => a.id !== aid));
      api.deleteAnnotation(aid).catch((e) => logError('deleting an annotation', e));
    },
  }), [id, items, tool, hlColor, inkColor, editing, flashId, layout, area, pulsing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save anything still waiting when the document closes.
  useEffect(() => () => {
    for (const [aid, p] of pendingPatch.current) { clearTimeout(p.timer); api.updateAnnotation(aid, { data: p.data, anchor: p.anchor }).catch((e) => logError('saving an annotation', e)); }
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // the target can be the window or document (a key with nothing focused), which have no closest()
      const t = e.target;
      if ((t instanceof Element && t.closest('input, textarea, [contenteditable]')) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { setTool('select'); setAreaBoth(null); }
      else if (KEYS[e.key.toLowerCase()] && root.current?.contains(document.activeElement ?? null) !== false) setTool(KEYS[e.key.toLowerCase()]);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Word files shown from their exact PDF copy: sections ↔ pages go through unit_pos.
  const wordPdf = layout?.kind === 'pdf' && layout.source === 'docx';
  const unitPos = layout?.kind === 'pdf' ? layout.unit_pos : undefined;
  const target = doc && focus ? matchUnit(doc.units, focus) : undefined;
  const targetAt: [number, number] | null = target ? (wordPdf ? unitPos?.[target.idx] ?? [1, 0] : [target.idx, 0]) : null;
  const targetIdx = targetAt?.[0];
  const targetY = targetAt?.[1] ?? 0;

  const scrollToUnit = useCallback((unit: number, yFrac = 0, flash = true) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-unit="${unit}"]`);
    if (!sc || !el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + yFrac * el.offsetHeight - (yFrac ? 90 : 28);
    sc.scrollTo({ top: Math.max(0, top) });
    if (flash) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    }
  }, []);

  /** Renderers call this once their units are laid out at their final size. */
  const ready = useCallback(() => {
    requestAnimationFrame(() => {
      const list = [...new Set([...(scroller.current?.querySelectorAll<HTMLElement>('[data-unit]') ?? [])].map((el) => Number(el.dataset.unit)))];
      setUnits(list);
      if (pulse && !pulsed.current) {
        pulsed.current = true;
        scrollToUnit(pulse.unit, Math.max(pulse.rect[1], 0.0001), false);
        setPulsing(pulse);
        setTimeout(() => setPulsing(null), 3600);
      }
      if (scrolled.current || targetIdx == null) return;
      scrolled.current = true;
      scrollToUnit(targetIdx, targetY);
    });
  }, [targetIdx, targetY, scrollToUnit, pulse]);

  /** Which unit is at the top of the view (and how far down it), for the page box and the chapter list. */
  const [pos, setPos] = useState({ unit: 1, y: 0 });
  const trackPage = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const top = sc.getBoundingClientRect().top + 100; // just below where jumps land (90px down)
    let cur = units[0] ?? 1;
    let y = 0;
    for (const el of sc.querySelectorAll<HTMLElement>('[data-unit]')) {
      const r = el.getBoundingClientRect();
      if (r.top <= top) { cur = Number(el.dataset.unit); y = (top - r.top) / (r.height || 1); } else break;
    }
    setPage(cur);
    setPos({ unit: cur, y });
  }, [units]);
  useEffect(() => { setPageInput(String(Math.max(1, units.indexOf(page) + 1))); }, [page, units]);
  const goToPage = (n: number) => {
    const unit = units[Math.max(0, Math.min(units.length - 1, n - 1))];
    if (unit != null) { scrollToUnit(unit); setPage(unit); }
  };

  // ---- selection
  const selectionRange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!scroller.current?.contains(r.commonAncestorContainer) || !sel.toString().trim()) return null;
    const start = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
    if (start?.closest('.anno-layer')) return null; // typing in a note, not selecting the document
    return r;
  };
  const unitOf = (r: Range) => {
    const start = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
    return start?.closest<HTMLElement>('[data-unit]') ?? null;
  };

  const placeAsk = useCallback(() => {
    const r = selectionRange();
    const host = root.current?.getBoundingClientRect();
    if (!r || !host) return setAskAt(null);
    const rect = r.getBoundingClientRect();
    const below = rect.top - host.top < 150;
    setAskAt({ x: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 110), host.width - 110),
      y: (below ? rect.bottom : rect.top) - host.top, below });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onChange = () => { const s = window.getSelection(); if (!s || s.isCollapsed) setAskAt(null); };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  // Escape dismisses the popup over a selection (and only that)
  const asking = !!askAt;
  useEffect(() => {
    if (!asking) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.ctx-menu, .modal-backdrop')) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      setAskAt(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [asking]);

  const currentQuote = (r: Range | null = selectionRange()): Quote | null => {
    if (!r || !doc || !scroller.current) return null;
    const q = quoteFromRange(r, scroller.current);
    const el = unitOf(r);
    const y = el ? (r.getBoundingClientRect().top - el.getBoundingClientRect().top) / (el.offsetHeight || 1) : 0;
    return { document_id: doc.id, filename: doc.filename, label: unitLabel(q.unit ?? 0, true, y), text: q.text, before: q.before, after: q.after };
  };

  /** A unit's name: for display ("Page 4", "Slide 4") or for citations (the label Qwen uses: for a Word file shown as
   * pages, the section at that point of the page). */
  const unitLabel = (unit: number, forCitation = false, y = 0) => {
    if (wordPdf) {
      if (!forCitation) return `Page ${unit}`;
      const sec = sectionAt(unitPos ?? {}, unit, y);
      return doc?.units.find((x) => x.idx === sec)?.label ?? '';
    }
    if (layout?.kind === 'pdf' && !forCitation) return layout.source === 'pptx' ? `Slide ${unit}` : `Page ${unit}`;
    const u = doc?.units.find((x) => x.idx === unit);
    if (u && (forCitation || layout?.kind !== 'docx')) return u.label;
    if (layout?.kind === 'pdf') return `Page ${unit}`;
    if (layout?.kind === 'slides') return `Slide ${unit}`;
    return u?.label ?? (forCitation ? '' : `Section ${unit}`);
  };

  const clearSelection = () => { window.getSelection()?.removeAllRanges(); setAskAt(null); };

  const highlight = (r: Range | null = selectionRange(), color = hlColor) => {
    const el = r && unitOf(r);
    if (!r || !el) return;
    anno.create(Number(el.dataset.unit), 'highlight', anchorFromRange(r, el), { color });
    clearSelection();
  };

  const addNote = async (r: Range | null = selectionRange()) => {
    const el = r && unitOf(r);
    if (!r || !el) return;
    const anchor = anchorFromRange(r, el);
    clearSelection();
    await anno.create(Number(el.dataset.unit), 'note', anchor, { ...notePlacement(anchor, el), text: '', color: hlColor });
  };

  /** "Define this": a note box attached to the selected text, filled in by Qwen. */
  const define = async (r: Range | null = selectionRange()) => {
    const el = r && unitOf(r);
    const q = currentQuote(r);
    if (!r || !el || !q) return;
    const anchor = anchorFromRange(r, el);
    clearSelection();
    const note = await anno.create(Number(el.dataset.unit), 'note', anchor,
      { ...notePlacement(anchor, el), title: q.text.slice(0, 80), text: '', definition: true, pending: true, color: hlColor });
    try {
      const res = await api.define(id, { text: q.text, before: q.before, after: q.after, label: q.label });
      anno.update(note.id, { data: { text: res.definition, pending: false } });
    } catch (e) {
      anno.update(note.id, { data: { text: `Couldn't get a definition: ${String(e).replace(/^Error: /, '')}`, pending: false } });
    }
  };

  const ask = (r: Range | null = selectionRange()) => {
    const q = currentQuote(r);
    if (!q) return;
    clearSelection();
    onAsk(q);
  };

  // ---- "Add to notes": the selection as a quote block with its source line ("Lecture 3.pdf · Page 4"), into the note
  // open beside this file (or a recent one / a new one, opened beside it); also by dragging the selection into the note
  const noteQuote = (r: Range | null = selectionRange()) => {
    if (!r || !doc || !scroller.current) return null;
    const q = quoteFromRange(r, scroller.current);
    return q.text.trim() ? { text: q.text, source: sourceLine(doc.filename, q.unit ? unitLabel(q.unit) : null) } : null;
  };
  // the popup's own buttons can take the focus (and the selection) away: keep what it was about
  const lastNoteQuote = useRef<{ text: string; source: string } | null>(null);
  useEffect(() => { if (askAt) lastNoteQuote.current = noteQuote(); }, [askAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const selToNotes = (at: Parameters<typeof ov.menu>[0], r: Range | null = selectionRange()) => {
    const nq = noteQuote(r) ?? lastNoteQuote.current;
    if (!nq || !doc) return;
    clearSelection();
    addToNotes(() => quoteHtml(nq.text, nq.source), { subjectId: doc.subject_id, ov, at });
  };
  const areaToNotes = (a: Area, at: Parameters<typeof ov.menu>[0]) => {
    if (!doc) return;
    setAreaBoth(null);
    const source = sourceLine(doc.filename, unitLabel(a.unit));
    addToNotes(async () => imageHtml(await snapshotDataUrl({ document_id: doc.id, unit: a.unit, rect: a.rect }), source),
      { subjectId: doc.subject_id, ov, at });
  };
  /** Dragging the selected text (natively, or by the popup's grip: pdf.js text can be awkward to grab) carries the
   * quote with its source line; a note puts it where it's dropped. */
  const dragQuote = (e: React.DragEvent) => {
    if ((e.target as Element).closest?.('.anno-temp-area')) return; // the area box sets its own
    const nq = noteQuote() ?? (askAt ? lastNoteQuote.current : null);
    if (nq) setQuoteDrag(e.dataTransfer, nq.text, nq.source);
  };

  const onMouseUp = () => setTimeout(() => {
    if (tool === 'highlight' && selectionRange()) highlight();
    else placeAsk();
  }, 0);

  // ---- annotations under the pointer (highlights and strokes don't take clicks, so right-click hit-tests them)
  const hitsAt = (x: number, y: number) => {
    const ids = new Set<number>();
    for (const el of scroller.current?.querySelectorAll<HTMLElement | SVGElement>('[data-anno]') ?? []) {
      const b = el.getBoundingClientRect();
      if (x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 3 && y <= b.bottom + 3) ids.add(Number((el as HTMLElement).dataset.anno));
    }
    return items.filter((a) => ids.has(a.id));
  };

  const goTo = (a: Annotation) => {
    const y = a.kind === 'highlight' || (a.kind === 'note' && a.anchor.rects?.length) ? a.anchor.rects?.[0]?.[1] ?? 0
      : a.kind === 'ink' ? Math.min(...(a.data.strokes ?? []).flatMap((s) => s.points.filter((_, i) => i % 2 === 1)))
      : a.data.y ?? 0;
    scrollToUnit(a.unit, Math.max(y, 0.0001), false);
    if (a.kind === 'note' && a.data.hidden) anno.update(a.id, { data: { hidden: false } });
    setFlashId(a.id);
    setTimeout(() => setFlashId(null), 1600);
  };

  // ---- area selection: right-drag (or the screenshot tool) leaves a temporary box; its menu sends a screenshot to
  // the chat or adds a note about the area (which keeps the box).
  const [snap, setSnap] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const snapped = useRef(false); // the context menu that follows a right-drag shows the area's menu
  const startSnap = (e: React.PointerEvent) => {
    if (e.button === 0 && !(e.target as HTMLElement).closest('.anno-temp-area, .anno-layer button, .anno-note, .anno-textbox')) setAreaBoth(null);
    if (e.button !== 2) return;
    const unitEl = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]');
    if (!unitEl || !scroller.current?.contains(unitEl)) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = { x0, y0, x1: x0, y1: y0 };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      moved = true;
      last = { x0, y0, x1: ev.clientX, y1: ev.clientY };
      setSnap(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSnap(null);
      if (!moved) return;
      const b = unitEl.getBoundingClientRect();
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      const x = clamp((Math.min(last.x0, last.x1) - b.left) / b.width);
      const y = clamp((Math.min(last.y0, last.y1) - b.top) / b.height);
      const w = clamp((Math.max(last.x0, last.x1) - b.left) / b.width) - x;
      const h = clamp((Math.max(last.y0, last.y1) - b.top) / b.height) - y;
      if (w * b.width < 10 || h * b.height < 10) return;
      snapped.current = true;
      setTimeout(() => { snapped.current = false; }, 400);
      setAreaBoth({ unit: Number(unitEl.dataset.unit), rect: [x, y, w, h] });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const sendArea = async (a: Area) => {
    try {
      const shot = await api.snapshot(id, a.unit, a.rect);
      onAttach([shot.path]);
      setAreaBoth(null);
    } catch (err) {
      await ov.confirm({ title: "Couldn't take a screenshot", body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };
  const noteArea = async (a: Area) => {
    const el = scroller.current?.querySelector(`[data-unit="${a.unit}"]`);
    if (!el) return;
    const anchor: TextAnchor = { rects: [a.rect] };
    setAreaBoth(null);
    await anno.create(a.unit, 'note', anchor, { ...notePlacement(anchor, el), area: true, text: '', color: HIGHLIGHT_COLORS[0] });
  };

  const KIND_NAME: Record<AnnotationKind, string> = { highlight: 'highlight', note: 'note', ink: 'drawing', textbox: 'text box', region: 'screenshot area' };
  const contextMenu = (e: React.MouseEvent) => {
    if (snapped.current) { snapped.current = false; areaMenu(e); return; }
    const r = selectionRange();
    const q = r ? currentQuote(r) : null;
    const hits = hitsAt(e.clientX, e.clientY);
    const menu: MenuItem[] = [];
    if (r && q) {
      menu.push(
        { label: 'Define this', onClick: () => define(r) },
        { label: 'Ask Apollo about this', onClick: () => ask(r) },
        { label: 'Highlight', onClick: () => highlight(r) },
        { label: 'Add note', onClick: () => addNote(r) },
        { label: noteTarget ? `Add to “${noteTarget.title?.() ?? 'my note'}”` : 'Add to my notes…', onClick: () => selToNotes(e, r) },
        { label: 'Copy', onClick: () => navigator.clipboard.writeText(q.text) },
      );
    }
    hits.forEach((a, i) => {
      if (a.kind === 'note' && a.data.hidden) menu.push({ label: 'Show note', separatorBefore: i === 0 && menu.length > 0, onClick: () => anno.update(a.id, { data: { hidden: false } }) });
      if (a.kind === 'highlight') {
        menu.push({ label: 'Add note to highlight', separatorBefore: i === 0 && menu.length > 0, onClick: () => {
          const el = scroller.current?.querySelector(`[data-unit="${a.unit}"]`);
          if (el) anno.create(a.unit, 'note', a.anchor, { ...notePlacement(a.anchor, el), text: '', color: a.data.color });
        } });
      }
      menu.push({ label: `Delete ${KIND_NAME[a.kind]}${a.kind === 'highlight' || a.kind === 'textbox' ? ` “${(a.anchor.text ?? a.data.text ?? '').slice(0, 24)}”` : ''}`,
        danger: true, separatorBefore: i === 0 && menu.length > 0 && !(a.kind === 'note' && a.data.hidden) && a.kind !== 'highlight',
        onClick: () => anno.remove(a.id) });
    });
    menu.push({ label: 'View ingested details', onClick: onDetails, separatorBefore: menu.length > 0 });
    if (canExport && items.length) {
      menu.push({ label: 'Export annotated PDF…', onClick: exportPdf });
    }
    menu.push({ label: 'Tip: right-drag to select an area (screenshot or note)', disabled: true, onClick: () => {}, separatorBefore: true });
    ov.menu(e, menu);
  };
  const canExport = layout?.kind === 'pdf';

  /** Save the annotated PDF where the student chooses (desktop app), or download it (browser). */
  const exportPdf = async () => {
    const name = `${(doc?.filename ?? 'document').replace(/\.[^.]+$/, '')} (annotated).pdf`;
    try {
      if (window.studyApp?.saveFile) {
        const path = await window.studyApp.saveFile({ defaultName: name });
        if (!path) return;
        const res = await api.exportTo(id, path);
        if (await ov.confirm({ title: 'Annotated PDF saved', body: res.path, confirmText: 'Show in folder' })) window.studyApp.showItem(res.path);
      } else {
        const r = await fetch(api.exportUrl(id));
        if (!r.ok) throw new Error((await r.json()).detail ?? `HTTP ${r.status}`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await r.blob());
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
    } catch (err) {
      await ov.confirm({ title: "Couldn't export", body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };

  // ---- chapters (top left) and minimap (top right)
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [minimap, setMinimap] = useState(() => getPref<string>('minimap', 'on') !== 'off');
  useEffect(() => { api.outline(id).then(setOutline).catch(() => setOutline([])); }, [id, layout]);
  const toggleMinimap = () => setMinimap((v) => { setPref('minimap', v ? 'off' : 'on'); return !v; });

  const zoomBy = (dir: number) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + dir))]);
  const toggleRail = () => setRail((v) => { setPref('annoRail', v ? 'off' : 'on'); return !v; });
  const unitName = layout?.kind === 'pdf' ? (layout.source === 'pptx' ? 'Slide' : 'Page') : layout?.kind === 'slides' ? 'Slide' : 'Section';
  const palette = tool === 'highlight' ? HIGHLIGHT_COLORS : tool === 'pen' || tool === 'textbox' ? INK_COLORS : null;
  const calcOpen = useCalculatorOpen();
  useFirstTime('viewer', !!layout);

  return (
    <AnnoContext.Provider value={anno}>
      <div className={`source tool-${tool}`} ref={root}>
        <header className="source-head">
          <span className={`source-badge ext-${(doc?.filename.split('.').pop() ?? '').toLowerCase()}`} aria-hidden>
            {(doc?.filename.split('.').pop() ?? '').slice(0, 4).toUpperCase()}
          </span>
          <div className="source-title" title={doc?.filename}>{doc?.filename ?? ''}</div>
          {units.length > 1 && (
            <label className="page-box" title={`Go to ${unitName.toLowerCase()}`}>
              <span className="page-label">{unitName}</span>
              <input value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onFocus={(e) => e.target.select()} onBlur={() => setPageInput(String(units.indexOf(page) + 1))}
                onKeyDown={(e) => { if (e.key === 'Enter') { goToPage(Number(pageInput) || 1); (e.target as HTMLInputElement).blur(); } }} />
              <span className="page-total">/ {units.length}</span>
            </label>
          )}
          {onMake && (
            <button className="btn btn-sm source-make" data-tip="Make flashcards, a quiz, notes… from just this file" onClick={onMake}>
              <Icon name="create" size={14} /> Make content from this file
            </button>
          )}
          <TourButton id="viewer" />
          <button className="close-x" title="Close the file" onClick={onClose}><Icon name="close" size={18} /></button>
        </header>
        <div className="source-tools" role="toolbar" aria-label="File tools">
          {outline.length > 0 && (
            <button className={`tool-btn labelled${outlineOpen ? ' on' : ''}`} data-tip="Jump to a section of this file" onClick={() => setOutlineOpen(!outlineOpen)}>
              <Icon name="chapters" size={16} /><span>Chapters</span>
            </button>
          )}
          {outline.length > 0 && <span className="tools-sep" />}
          <div className="tools">
            {TOOLS.map((t) => (
              <button key={t.tool} className={`tool-btn labelled${tool === t.tool ? ' on' : ''}${t.tool === 'highlight' ? ' hl-tool' : ''}`} data-tip={t.label}
                aria-pressed={tool === t.tool} onClick={() => setTool(t.tool)} style={{ '--hl': hlColor } as React.CSSProperties}>
                <Icon name={t.icon} size={16} /><span>{t.name}</span>
              </button>
            ))}
            <button className={`tool-btn labelled${tool === 'area' ? ' on' : ''}`} data-tip="Snip: drag a box over the page to send it to the chat or pin a note to it (S)"
              aria-pressed={tool === 'area'} onClick={() => setTool(tool === 'area' ? 'select' : 'area')}>
              <Icon name="snip" size={16} /><span>Snip</span>
            </button>
            {palette && (
              <span className="swatches">
                {palette.map((c) => {
                  const on = (tool === 'highlight' ? hlColor : inkColor) === c;
                  return <button key={c} className={`swatch${on ? ' on' : ''}`} style={{ background: c }} title="Colour"
                    onClick={() => (tool === 'highlight' ? setHlColor(c) : setInkColor(c))} />;
                })}
              </span>
            )}
          </div>
          <span className="tools-sep" />
          <button className="tool-btn labelled" data-tip="Find words in this file (Ctrl+F)" onClick={() => openFind('')}>
            <Icon name="search" size={16} /><span>Find</span>
          </button>
          <button className={`tool-btn labelled rail-toggle${rail ? ' on' : ''}`} data-tip={rail ? 'Hide the list of your highlights and notes' : 'Show the list of your highlights and notes'}
            aria-pressed={rail} onClick={toggleRail}>
            <Icon name="show" size={16} /><span>My notes</span>
            {items.length > 0 && <span className="rail-dot">{items.length}</span>}
          </button>
          <button className={`tool-btn labelled tool-calc${calcOpen ? ' on' : ''}`} data-tip={calcOpen ? 'Close the calculator' : 'Calculator and graphs'}
            aria-pressed={calcOpen} onClick={toggleCalculator}>
            <Icon name="calculator" size={16} /><span>Calculator</span>
          </button>
          <span className="spacer" />
          {layout && layout.kind !== 'image' && layout.kind !== 'text' && (
            <div className="zoom">
              <button className="icon-btn" data-tip="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => zoomBy(-1)}><Icon name="minus" /></button>
              <button className="zoom-val" data-tip="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button className="icon-btn" data-tip="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => zoomBy(1)}><Icon name="add" /></button>
            </div>
          )}
        </div>

        <div className="source-body">
          <div className="source-main">
          <div className="source-scroll" ref={scroller} data-find={doc?.filename ?? 'this document'} style={{ '--zoom': zoom } as React.CSSProperties}
            onMouseUp={onMouseUp} onKeyUp={placeAsk} onScroll={() => { if (askAt) placeAsk(); trackPage(); }} onContextMenu={contextMenu}
            onPointerDown={startSnap} onDragStart={dragQuote}>
            {error && <Empty title="Couldn't open this file">{error}</Empty>}
            {doc && layout && (
              layout.kind === 'pdf' ? <PdfView url={authUrl(BASE + layout.url)} zoom={zoom} onReady={ready} slides={layout.source === 'pptx'} />
                : layout.kind === 'slides' ? <SlidesView layout={layout} onReady={ready} />
                : layout.kind === 'docx' ? <DocxView blocks={layout.blocks} onReady={ready} />
                : layout.kind === 'image' ? <div className="src-image"><div className="src-page" data-unit={1}><img src={api.fileUrl(id)} alt={doc.filename} /><UnitOverlay unit={1} /></div></div>
                : <TextView doc={doc} onReady={ready} />
            )}
          </div>
          <div className="source-overlays">
            {outlineOpen && outline.length > 0 && (
              <OutlinePanel items={outline} current={pos} onClose={() => setOutlineOpen(false)}
                onGo={(o) => { scrollToUnit(o.unit, o.y, !o.y); setPage(o.unit); }} />
            )}
            {minimap && units.length > 0 && (
              <Minimap scroller={scroller} docId={id} thumbs={layout?.kind === 'pdf'} items={items} deps={[units, zoom, rail]} onClose={toggleMinimap} />
            )}
            {!minimap && units.length > 0 && <button className="mm-open" title="Show the minimap" onClick={toggleMinimap}><Icon name="chevronLeft" /></button>}
          </div>
          </div>
          {rail && (
            <AnnotationRail items={items} unitLabel={(u) => unitLabel(u)} onGo={goTo} onDelete={(a) => anno.remove(a.id)}
              onExport={canExport ? exportPdf : null} onClose={toggleRail} />
          )}
        </div>
        {snap && (
          <div className="snap-rect" style={{ left: Math.min(snap.x0, snap.x1), top: Math.min(snap.y0, snap.y1),
            width: Math.abs(snap.x1 - snap.x0), height: Math.abs(snap.y1 - snap.y0) }} />
        )}

        {askAt && tool === 'select' && (
          <div className={`ask-pop${askAt.below ? ' below' : ''}`} style={{ left: askAt.x, top: askAt.y }} onMouseDown={(e) => e.preventDefault()}>
            <button className="ask-main" onClick={() => define()}><span className="ask-spark">Aa</span> Define this</button>
            <button className="ask-main" onClick={() => ask()}><span className="ask-spark"><Icon name="ask" size={15} /></span> Ask Apollo about this</button>
            <div className="ask-note-row">
              <button className="ask-main ask-to-note" onClick={(e) => selToNotes(pointAt(e.currentTarget))}
                data-tip={noteTarget ? `Into “${noteTarget.title?.() ?? 'your note'}”, where its cursor is` : 'Pick one of your notes, or start a new one beside this file'}>
                <span className="ask-spark"><Icon name="insert" size={15} /></span> Add to notes
              </button>
              <span className="ask-drag" draggable title="Drag into a note" aria-label="Drag the selection into a note" role="button"
                onDragStart={dragQuote}><Icon name="grip" size={14} /></span>
            </div>
            <div className="ask-row">
              {HIGHLIGHT_COLORS.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} title="Highlight" onClick={() => { setHlColor(c); highlight(undefined, c); }} />
              ))}
              <span className="ask-sep" />
              <button className="ask-mini" title="Add a note to this text" onClick={() => addNote()}><Icon name="note" size={14} /> Note</button>
            </div>
          </div>
        )}
      </div>
    </AnnoContext.Provider>
  );
}
