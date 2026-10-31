import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, Annotation, AnnotationData, AnnotationKind, BASE, DocDetail, DocLayout, DocxBlock, OutlineItem, Quote, SlideItem, TextAnchor } from '../api';
import Markdown from '../components/Markdown';
import { MenuItem, useOverlay } from '../components/overlay';
import { Empty, MathText } from '../components/ui';
import {
  anchorFromRange, AnnoApi, AnnoContext, AnnotationRail, Area, HIGHLIGHT_COLORS, INK_COLORS, notePlacement, Tool, UnitOverlay,
} from './annotate';
import { matchUnit } from './DocumentView';
import { Minimap, OutlinePanel } from './navigate';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
const BASE_WIDTH = 920; // px at 100%, or the pane width if narrower
const BUSY = ['queued', 'parsing', 'embedding'];

const TOOLS: { tool: Tool; label: string; icon: JSX.Element }[] = [
  { tool: 'select', label: 'Select text (V)', icon: <path d="M3 2l9 5-4 1.2L6.5 13z" fill="currentColor" /> },
  { tool: 'highlight', label: 'Highlight (H)', icon: <><path d="M4 10l5-7 3 2.2-5 7H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M2 14.5h12" stroke="currentColor" strokeWidth="2.4" className="hl-bar" /></> },
  { tool: 'pen', label: 'Pen: draw on the page (P)', icon: <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12zM9.5 4l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /> },
  { tool: 'eraser', label: 'Eraser: remove pen strokes (E)', icon: <path d="M6 13.5h7M2.8 9.8l6-6.3 4 3.8-6 6.2H5.3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /> },
  { tool: 'textbox', label: 'Text box: write on the page (T)', icon: <path d="M3 3.5h10M8 3.5v9.5M6 13h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> },
  { tool: 'note', label: 'Note box (N)', icon: <path d="M3 2.5h10v7.5l-3.5 3.5H3zM9.5 13.5V10H13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /> },
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'highlight', p: 'pen', e: 'eraser', t: 'textbox', n: 'note', s: 'area' };

/**
 * The original document, rendered as itself: PDF pages (pdf.js), slides, Word pages, text, images. Every unit
 * (page / slide / section) is a `[data-unit]` element so citations can scroll to it, highlights know their source and
 * annotations are drawn over it. Selecting text offers Define / Ask Apollo / Highlight / Note; right-click also offers the
 * ingest details view. The right rail lists every annotation.
 */
export default function SourceView({ id, focus, pulse, onClose, onDetails, onAsk, onAttach }: {
  id: number; focus?: string; onClose: () => void; onDetails: () => void; onAsk: (q: Quote) => void;
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
  const [flags, setFlags] = useState({ needs_reingest: false, doc_status: '' });
  const [tool, setTool] = useState<Tool>('select');
  const [hlColor, setHlColor] = useState(HIGHLIGHT_COLORS[0]);
  const [inkColor, setInkColor] = useState(INK_COLORS[0]);
  const [editing, setEditing] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [rail, setRail] = useState(() => { try { return localStorage.getItem('annoRail') !== 'off'; } catch { return true; } });
  const [units, setUnits] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const pendingPatch = useRef(new Map<number, { data?: AnnotationData; anchor?: TextAnchor; timer?: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    Promise.all([api.document(id), api.documentLayout(id), api.annotations(id)])
      .then(([d, l, a]) => { setDoc(d); setLayout(l); setItems(a.items); setFlags(a); })
      .catch((e) => setError(String(e)));
  }, [id]);

  const refreshFlags = useCallback(() => {
    api.annotations(id).then((a) => setFlags({ needs_reingest: a.needs_reingest, doc_status: a.doc_status })).catch(() => {});
  }, [id]);
  const busy = BUSY.includes(flags.doc_status);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refreshFlags, 2500);
    return () => clearInterval(t);
  }, [busy, refreshFlags]);

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
      { label: 'Add a note for this area', onClick: () => noteArea(a) },
      { label: 'Clear selection', separatorBefore: true, onClick: () => setAreaBoth(null) },
    ]);
  };
  const areaMenuRef = useRef(areaMenu);
  areaMenuRef.current = areaMenu;

  const anno: AnnoApi = useMemo(() => ({
    area, setArea: (a: Area | null) => setAreaBoth(a), areaMenu: (e, a) => areaMenuRef.current(e, a ?? undefined), pulse: pulsing,
    items, tool, setTool, hlColor, inkColor, editing, flashId,
    fixed: layout?.kind === 'pdf' || layout?.kind === 'slides',
    create: async (unit: number, kind: AnnotationKind, anchor: TextAnchor, data: AnnotationData) => {
      if (layout?.kind === 'pdf' && layout.source === 'docx') data = { ...data, space: 'pdf' }; // unit is a page here
      const a = await api.createAnnotation(id, { unit, kind, anchor, data });
      setItems((xs) => [...xs, a]);
      if (kind === 'textbox' || (kind === 'note' && !data.pending)) setEditing(a.id);
      refreshFlags();
      return a;
    },
    update: (aid: number, patch: { data?: AnnotationData; anchor?: TextAnchor }) => {
      setItems((xs) => xs.map((a) => (a.id === aid ? { ...a, data: { ...a.data, ...patch.data }, anchor: patch.anchor ?? a.anchor } : a)));
      const p = pendingPatch.current.get(aid) ?? {};
      clearTimeout(p.timer);
      const next: typeof p = { data: { ...p.data, ...patch.data }, anchor: patch.anchor ?? p.anchor };
      next.timer = setTimeout(() => {
        pendingPatch.current.delete(aid);
        api.updateAnnotation(aid, { data: next.data, anchor: next.anchor }).then(refreshFlags).catch(() => {});
      }, 400);
      pendingPatch.current.set(aid, next);
    },
    remove: (aid: number) => {
      clearTimeout(pendingPatch.current.get(aid)?.timer);
      pendingPatch.current.delete(aid);
      setItems((xs) => xs.filter((a) => a.id !== aid));
      api.deleteAnnotation(aid).then(refreshFlags).catch(() => {});
    },
  }), [id, items, tool, hlColor, inkColor, editing, flashId, layout, refreshFlags, area, pulsing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save anything still waiting when the document closes.
  useEffect(() => () => {
    for (const [aid, p] of pendingPatch.current) { clearTimeout(p.timer); api.updateAnnotation(aid, { data: p.data, anchor: p.anchor }).catch(() => {}); }
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
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
    if (flags.needs_reingest) menu.push({ label: 'Re-ingest with my notes', onClick: reingest });
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
  const [minimap, setMinimap] = useState(() => { try { return localStorage.getItem('minimap') !== 'off'; } catch { return true; } });
  useEffect(() => { api.outline(id).then(setOutline).catch(() => setOutline([])); }, [id, layout]);
  const toggleMinimap = () => setMinimap((v) => { try { localStorage.setItem('minimap', v ? 'off' : 'on'); } catch { /* */ } return !v; });

  const reingest = async () => {
    await api.reingestAnnotations(id);
    setFlags((f) => ({ ...f, doc_status: 'queued' }));
  };

  const zoomBy = (dir: number) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + dir))]);
  const toggleRail = () => setRail((v) => { try { localStorage.setItem('annoRail', v ? 'off' : 'on'); } catch { /* */ } return !v; });
  const unitName = layout?.kind === 'pdf' ? (layout.source === 'pptx' ? 'Slide' : 'Page') : layout?.kind === 'slides' ? 'Slide' : 'Section';
  const palette = tool === 'highlight' ? HIGHLIGHT_COLORS : tool === 'pen' || tool === 'textbox' ? INK_COLORS : null;

  return (
    <AnnoContext.Provider value={anno}>
      <div className={`source tool-${tool}`} ref={root}>
        <header className="source-head">
          {outline.length > 0 && (
            <button className={`outline-btn${outlineOpen ? ' on' : ''}`} title="Chapters" onClick={() => setOutlineOpen(!outlineOpen)}>
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M5.5 8h8M5.5 12.5h8M2.5 8h.5M2.5 12.5h.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              Chapters
            </button>
          )}
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
          {layout && layout.kind !== 'image' && layout.kind !== 'text' && (
            <div className="zoom">
              <button className="icon-btn" data-tip="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => zoomBy(-1)}>−</button>
              <button className="zoom-val" data-tip="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button className="icon-btn" data-tip="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => zoomBy(1)}>+</button>
            </div>
          )}
          <div className="tools">
            {TOOLS.map((t) => (
              <button key={t.tool} className={`tool-btn${tool === t.tool ? ' on' : ''}`} data-tip={t.label} onClick={() => setTool(t.tool)}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ '--hl': hlColor } as React.CSSProperties}>{t.icon}</svg>
              </button>
            ))}
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
          <button className={`tool-btn shot-btn${tool === 'area' ? ' on' : ''}`} data-tip="Screenshot / select an area (S): drag over the page"
            onClick={() => setTool(tool === 'area' ? 'select' : 'area')}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h1.5M10.5 2.5H12A1.5 1.5 0 0 1 13.5 4v1.5M13.5 10.5V12a1.5 1.5 0 0 1-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 0 1 2.5 12v-1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
          </button>
          <button className={`icon-btn rail-toggle${rail ? ' on' : ''}`} data-tip={rail ? 'Hide annotations' : 'Show annotations'} onClick={toggleRail}>
            ☰{items.length > 0 && <span className="rail-dot">{items.length}</span>}{flags.needs_reingest && <span className="reingest-dot" />}
          </button>
          <button className="close-x" title="Close document" onClick={onClose}>×</button>
        </header>

        <div className="source-body">
          <div className="source-main">
          <div className="source-scroll" ref={scroller} style={{ '--zoom': zoom } as React.CSSProperties}
            onMouseUp={onMouseUp} onKeyUp={placeAsk} onScroll={() => { if (askAt) placeAsk(); trackPage(); }} onContextMenu={contextMenu}
            onPointerDown={startSnap}>
            {error && <Empty title="Couldn't open this file">{error}</Empty>}
            {doc && layout && (
              layout.kind === 'pdf' ? <PdfView url={BASE + layout.url} zoom={zoom} onReady={ready} slides={layout.source === 'pptx'} />
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
            {!minimap && units.length > 0 && <button className="mm-open" title="Show the minimap" onClick={toggleMinimap}>‹</button>}
          </div>
          </div>
          {rail && (
            <AnnotationRail items={items} unitLabel={(u) => unitLabel(u)} onGo={goTo} onDelete={(a) => anno.remove(a.id)}
              needsReingest={flags.needs_reingest} busy={busy} onReingest={reingest}
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
            <button className="ask-main" onClick={() => ask()}><span className="ask-spark">✦</span> Ask Apollo about this</button>
            <div className="ask-row">
              {HIGHLIGHT_COLORS.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} title="Highlight" onClick={() => { setHlColor(c); highlight(undefined, c); }} />
              ))}
              <span className="ask-sep" />
              <button className="ask-mini" title="Add a note to this text" onClick={() => addNote()}>🗒 Note</button>
            </div>
          </div>
        )}
      </div>
    </AnnoContext.Provider>
  );
}

/** The Word section a point on a page of its exact PDF copy falls in: the last section starting at or before it. */
function sectionAt(pos: Record<string, [number, number]>, page: number, y: number): number | null {
  let best: number | null = null;
  let bestAt: [number, number] = [0, -1];
  for (const [idx, [p, py]] of Object.entries(pos)) {
    const before = p < page || (p === page && py <= y + 0.002);
    const later = p > bestAt[0] || (p === bestAt[0] && py > bestAt[1]);
    if (before && later) { best = Number(idx); bestAt = [p, py]; }
  }
  return best;
}

// ---------------------------------------------------------------- highlighted text → quote

/** Text of a DOM range: <br> and block boundaries become spaces, KaTeX formulas become their $TeX$. */
function rangeText(r: Range): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue; return; }
    if (!(n instanceof Element) || n.classList.contains('anno-layer')) return;
    const tex = n.getAttribute('data-tex');
    if (tex) { out += ` $${tex}$ `; return; }
    if (n.tagName === 'BR') { out += ' '; return; }
    n.childNodes.forEach(walk);
    if (/^(DIV|P|LI|TR|TD|TH|H\d|SECTION)$/.test(n.tagName)) out += ' ';
  };
  r.cloneContents().childNodes.forEach(walk);
  return out.replace(/\s+/g, ' ');
}

// Sentence ends; a bullet point also starts a new "sentence" (slides and syllabus lists rarely use full stops).
const TERMINATOR = /[.!?](?=["')\]]?(\s|$))|\s(?=[•▪◦‣–]\s)/g;

/** The highlighted text plus the previous full sentence and the following full sentence, within its unit. */
function quoteFromRange(r: Range, root: HTMLElement) {
  const startEl = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
  const unitEl = startEl?.closest<HTMLElement>('[data-unit]') ?? null;
  const scope = unitEl && root.contains(unitEl) ? unitEl : root;
  const text = rangeText(r).trim();

  const pre = document.createRange();
  pre.setStart(scope, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const b = rangeText(pre);
  const ends = [...b.matchAll(TERMINATOR)].map((m) => m.index! + 1);
  // Two terminators back: covers "previous sentence + start of this one", and also "previous sentence" when the
  // highlight starts a sentence (then the last terminator ends that previous sentence).
  const before = b.slice(ends.length >= 2 ? ends[ends.length - 2] : 0).trim().slice(-600);

  let after = '';
  if (scope.contains(r.endContainer)) {
    const post = document.createRange();
    post.setStart(r.endContainer, r.endOffset);
    post.setEnd(scope, scope.childNodes.length);
    const a = rangeText(post);
    const aEnds = [...a.matchAll(TERMINATOR)].map((m) => m.index! + 1);
    const finishesSentence = /[.!?]["')\]]?$/.test(text);
    const cut = finishesSentence ? aEnds[0] : aEnds[1];
    after = a.slice(0, cut ?? a.length).trim().slice(0, 600);
  }
  return { unit: unitEl ? Number(unitEl.dataset.unit) : null, text: text.slice(0, 2000), before, after };
}

// ---------------------------------------------------------------- PDF (pdf.js: canvas + selectable text layer)

function useWidth(ref: React.RefObject<HTMLElement>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setW(el.clientWidth), w ? 150 : 0);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps
  return w;
}

function PdfView({ url, zoom, onReady, slides }: { url: string; zoom: number; onReady: () => void; slides?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const avail = useWidth(wrap);

  useEffect(() => {
    let alive = true;
    const task = pdfjs.getDocument({ url, isEvalSupported: false });
    task.promise.then(async (d) => {
      // Every page's size up front, so placeholders are exact and scrolling to a cited page lands precisely.
      const out = [];
      for (let i = 1; i <= d.numPages; i++) {
        const v = (await d.getPage(i)).getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
      }
      if (alive) { setPdf(d); setSizes(out); }
    }).catch((e) => alive && setErr(String(e)));
    return () => { alive = false; task.destroy(); };
  }, [url]);

  const width = Math.min(Math.max(avail - 48, 200), BASE_WIDTH) * zoom;
  useEffect(() => { if (sizes.length && avail) onReady(); }, [sizes.length, avail, onReady]);

  return (
    <div ref={wrap} className="src-pages">
      {err && <Empty title="Couldn't render this PDF">{err}</Empty>}
      {avail > 0 && sizes.map((s, i) => (slides ? (
        <div key={i} className="src-slide-wrap" style={{ width }}>
          <div className="src-slide-num">Slide {i + 1}</div>
          <PdfPage pdf={pdf} n={i + 1} size={s} width={width} />
        </div>
      ) : <PdfPage key={i} pdf={pdf} n={i + 1} size={s} width={width} />))}
    </div>
  );
}

function PdfPage({ pdf, n, size, width }: { pdf: pdfjs.PDFDocumentProxy | null; n: number; size: { w: number; h: number }; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const render = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / size.w;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = render.current;
    if (!visible || !pdf || !el) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | undefined;
    let text: pdfjs.TextLayer | undefined;
    (async () => {
      const page = await pdf.getPage(n);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: vp });
      await text.render();
      if (!cancelled) el.replaceChildren(canvas, layer);
    })().catch(() => { /* cancelled by a zoom change or unmount */ });
    return () => { cancelled = true; task?.cancel(); text?.cancel(); };
  }, [visible, pdf, n, scale]);

  return (
    <div ref={ref} className="src-page pdf-page" data-unit={n}
      style={{ width, height: size.h * scale, '--scale-factor': scale } as React.CSSProperties}>
      <div ref={render} className="pdf-render" />
      <UnitOverlay unit={n} />
    </div>
  );
}

// ---------------------------------------------------------------- slides (positioned HTML, real text)

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function SlidesView({ layout, onReady }: { layout: Extract<DocLayout, { kind: 'slides' }>; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  const { width: W, height: H } = layout;
  return (
    <div className="src-pages">
      {layout.slides.map((s) => (
        <div key={s.idx} className="src-slide-wrap">
          <div className="src-slide-num">Slide {s.idx}</div>
          <div className="src-page src-slide" data-unit={s.idx} style={{ aspectRatio: `${W} / ${H}` }}>
            {s.items.map((it, i) => <SlideShape key={i} it={it} W={W} H={H} />)}
            <UnitOverlay unit={s.idx} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SlideShape({ it, W, H }: { it: SlideItem; W: number; H: number }) {
  const cq = (pt: number) => `${(pt / W) * 100}cqw`; // slide points → share of the slide's width
  const box: React.CSSProperties = {
    left: pct(it.x, W), top: pct(it.y, H), width: pct(it.w, W), height: pct(it.h, H),
    transform: it.rot ? `rotate(${it.rot}deg)` : undefined,
  };
  if (it.type === 'image') {
    if (!it.src) return <div className="shape shape-missing" style={box}>image not shown</div>;
    const [l, t, r, b] = it.crop ?? [0, 0, 0, 0];
    const fw = 1 - l - r || 1;
    const fh = 1 - t - b || 1;
    return (
      <div className="shape shape-img" style={box}>
        <img src={api.assetUrl(it.src)} alt="" draggable={false}
          style={{ width: pct(1, fw), height: pct(1, fh), left: pct(-l, fw), top: pct(-t, fh) }} />
      </div>
    );
  }
  if (it.type === 'table') {
    return (
      <div className="shape shape-table" style={{ ...box, fontSize: cq(12) }}>
        <table><tbody>{it.rows!.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><MathText text={c} /></td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  return (
    <div className={`shape shape-text anchor-${it.anchor}`} style={{ ...box, padding: `${cq(3.6)} ${cq(7.2)}` }}>
      {it.paras!.map((p, i) => (
        <div key={i} className={`sp${p.bullet ? ' sp-bullet' : ''}`}
          style={{ fontSize: cq(p.size), fontWeight: p.bold ? 700 : 400, textAlign: p.align as React.CSSProperties['textAlign'],
            marginLeft: cq(p.level * 24 + (p.bullet ? 16 : 0)) }}>
          {p.text ? <MathText text={p.text} /> : ' '}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Word (flowing page, real text)

function DocxView({ blocks, onReady }: { blocks: DocxBlock[]; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  // Consecutive blocks of one section share a [data-unit] wrapper: the citation target and the highlight's context.
  const sections: { unit: number | null; blocks: DocxBlock[] }[] = [];
  for (const b of blocks) {
    const last = sections[sections.length - 1];
    if (last && last.unit === b.unit) last.blocks.push(b);
    else sections.push({ unit: b.unit, blocks: [b] });
  }
  return (
    <div className="src-pages">
      <div className="src-page src-paper">
        {sections.map((s, i) => (
          <section key={i} data-unit={s.unit ?? undefined}>
            {s.blocks.map((b, j) => <DocxBlockView key={j} b={b} />)}
            {s.unit != null && <UnitOverlay unit={s.unit} />}
          </section>
        ))}
      </div>
    </div>
  );
}

function DocxBlockView({ b }: { b: DocxBlock }) {
  if (b.type === 'table') {
    return (
      <div className="dx-table">
        <table><tbody>{b.rows!.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><MathText text={c} /></td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  const content = (
    <>
      {b.text && <MathText text={b.text} />}
      {b.images?.map((src, i) => <img key={i} className="dx-img" src={api.assetUrl(src)} alt="" draggable={false} />)}
    </>
  );
  if (b.type === 'heading') return <div className={`dx-h dx-h${b.level ?? 3}`}>{content}</div>;
  return (
    <div className={`dx-p${b.list != null ? ' dx-li' : ''}`}
      style={{ textAlign: b.align as React.CSSProperties['textAlign'], marginLeft: b.list != null ? b.list * 22 + 20 : undefined }}>
      {content}
    </div>
  );
}

// ---------------------------------------------------------------- text / markdown

function TextView({ doc, onReady }: { doc: DocDetail; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  const md = doc.ext === '.md';
  return (
    <div className="src-pages">
      <div className="src-page src-paper">
        {doc.units.map((u) => (
          <section key={u.id} data-unit={u.idx}>
            {md ? <Markdown text={u.text} /> : <div className="src-plain">{u.text}</div>}
            <UnitOverlay unit={u.idx} />
          </section>
        ))}
        {doc.units.length === 0 && <div className="muted">This file hasn't been read yet.</div>}
      </div>
    </div>
  );
}
