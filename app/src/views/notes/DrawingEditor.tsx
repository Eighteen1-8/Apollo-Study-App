/* The student's own drawing: pen (pressure where the pen reports it), highlighter, eraser (whole strokes), line,
   arrow, rectangle, ellipse, text, and select (move, resize, delete), on plain, grid or lined paper that pans and
   zooms. Saved as vector items as it changes (user_notes.data, see components/ink.tsx). Never ingested; "Check with
   Apollo" sends a picture of it, with the student's one-line "what this shows", to the vision model, judged against
   the material, and the issues are listed in the Comments panel. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Quote, Subject } from '../../api';
import { useOverlay } from '../../components/overlay';
import { exportAs } from '../../components/exportDoc';
import {
  Box, DrawingData, DrawItem, drawingSvg, hitItem, INK_PALETTE, InkPoint, itemInBox, itemSvg, normalizeDrawing,
  Paper, paperSvg, savePng, scaleItem, ShapeDrawItem, ShapeKind, smooth, svgToPng, thin, translateItem, unionBounds, WIDTHS,
} from '../../components/ink';
import Icon, { IconName } from '../../components/Icon';
import { toggleCalculator, useCalculatorOpen } from '../../components/Calculator';
import { TourButton, useFirstTime } from '../../components/Tour';
import { getPref, setPref } from '../../prefs';
import { History } from './history';
import { newId } from './mapModel';
import { NoteComments, NoteHead, useNoteDoc, useNoteReviews } from './useNoteDoc';

type Tool = 'pen' | 'highlighter' | 'eraser' | ShapeKind | 'text' | 'select' | 'pan';
type View = { tx: number; ty: number; k: number };
const TOOLS: [Tool, IconName, string][] = [
  ['select', 'select', 'Select, move and resize (V)'], ['pan', 'pan', 'Move the page (H, or hold Space)'],
  ['pen', 'pen', 'Pen (P)'], ['highlighter', 'highlight', 'Highlighter (I)'], ['eraser', 'eraser', 'Eraser: rubs out whole strokes (E)'],
  ['line', 'line', 'Line (L)'], ['arrow', 'arrow', 'Arrow (A)'], ['rect', 'shapeBox', 'Rectangle (R)'], ['ellipse', 'shapeCircle', 'Ellipse (O)'],
  ['text', 'textbox', 'Text (T)'],
];
const KEYS: Record<string, Tool> = { v: 'select', h: 'pan', p: 'pen', i: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };
const PAPERS: [Paper, string][] = [['plain', 'Plain paper'], ['grid', 'Grid paper'], ['lined', 'Lined paper']];
const HIGHLIGHTS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6'];

/** One item, drawn from the same markup the PNG uses; re-rendered only when that item changes. */
const Item = memo(function Item({ it, offset }: { it: DrawItem; offset?: { dx: number; dy: number } }) {
  return <g data-item={it.id} transform={offset ? `translate(${offset.dx},${offset.dy})` : undefined} dangerouslySetInnerHTML={{ __html: itemSvg(it) }} />;
});

export default function DrawingEditor({ id, subject, onClose }: {
  id: number; subject: Subject; onClose: () => void; onAsk?: (q: Quote) => void;
}) {
  const ov = useOverlay();
  const doc = useNoteDoc<DrawingData>(id, normalizeDrawing);
  const comments = useNoteReviews(id);
  const calcOpen = useCalculatorOpen();
  useFirstTime('drawing', !!doc.data);
  const d = doc.data ??{ items: [], paper: 'plain' as Paper, description: '' };
  const hist = useRef(new History<DrawingData>());
  const [, bump] = useState(0);
  const [tool, setToolState] = useState<Tool>(() => getPref('drawTool', 'pen') as Tool);
  const [color, setColor] = useState(() => getPref('drawColor', INK_PALETTE[0]));
  const [width, setWidth] = useState(() => Number(getPref('drawWidth', '4')) || 4);
  const [view, setView] = useState<View>({ tx: 40, ty: 40, k: 1 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<DrawItem | null>(null);
  const [erased, setErased] = useState<Set<string>>(new Set());
  const [moveBy, setMoveBy] = useState<{ dx: number; dy: number } | null>(null);
  const [resize, setResize] = useState<{ from: Box; to: Box } | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [text, setText] = useState<{ x: number; y: number; id: string | null; initial: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [space, setSpace] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const livePath = useRef<SVGPolylineElement>(null);
  const live = useRef<InkPoint[] | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const setTool = (t: Tool) => { setToolState(t); setPref('drawTool', t); if (t !== 'select') setSel(new Set()); };
  const pickColor = (c: string) => { setColor(c); setPref('drawColor', c); if (sel.size) restyle({ color: c }); };
  const pickWidth = (w: number) => { setWidth(w); setPref('drawWidth', String(w)); if (sel.size) restyle({ width: w }); };

  const commit = useCallback((next: DrawingData) => {
    const cur = doc.dataRef.current;
    if (!cur || next === cur) return;
    hist.current.push(cur);
    doc.setData(next);
    bump((n) => n + 1);
  }, [doc]);
  const setItems = (items: DrawItem[]) => commit({ ...doc.dataRef.current!, items });
  const undo = () => { const p = hist.current.undo(doc.dataRef.current!); if (p) { doc.setData(p); setSel(new Set()); bump((n) => n + 1); } };
  const redo = () => { const p = hist.current.redo(doc.dataRef.current!); if (p) { doc.setData(p); setSel(new Set()); bump((n) => n + 1); } };
  const restyle = (patch: { color?: string; width?: number }) => setItems(doc.dataRef.current!.items.map((it) => {
    if (!sel.has(it.id)) return it;
    if (it.type === 'text') return patch.color ? { ...it, color: patch.color } : patch.width ? { ...it, size: 10 + patch.width * 2 } : it;
    return { ...it, ...patch };
  }));

  // ---- the canvas's size (for the paper) and zoom
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const toWorld = useCallback((cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
  }, [view]);
  const zoomBy = (f: number, cx?: number, cy?: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    setView((v) => {
      const k = Math.max(0.2, Math.min(5, v.k * f));
      const wx = (px - r.left - v.tx) / v.k, wy = (py - r.top - v.ty) / v.k;
      return { k, tx: px - r.left - wx * k, ty: py - r.top - wy * k };
    });
  };
  const fit = () => {
    const b = unionBounds(doc.dataRef.current?.items ?? []);
    const el = canvas.current;
    if (!el) return;
    if (!b) { setView({ tx: 40, ty: 40, k: 1 }); return; }
    const k = Math.max(0.2, Math.min(2, (el.clientWidth - 80) / Math.max(b.w, 1), (el.clientHeight - 80) / Math.max(b.h, 1)));
    setView({ k, tx: (el.clientWidth - b.w * k) / 2 - b.x * k, ty: (el.clientHeight - b.h * k) / 2 - b.y * k });
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaX) < 1 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 50) zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      else setView((v) => ({ ...v, tx: v.tx - (e.shiftKey ? e.deltaY : e.deltaX), ty: v.ty - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  // ---- drawing
  const pressure = (e: PointerEvent | React.PointerEvent) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5);
  const addLive = (x: number, y: number) => {
    const el = livePath.current;
    const svg = el?.ownerSVGElement;
    if (!el || !svg) return;
    const pt = svg.createSVGPoint();
    pt.x = x; pt.y = y;
    el.points.appendItem(pt);
  };
  const hitAt = (p: { x: number; y: number }) => {
    const items = doc.dataRef.current!.items;
    for (let i = items.length - 1; i >= 0; i--) if (hitItem(items[i], p.x, p.y, 6 / view.k)) return items[i];
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (text) return; // the text box closes on blur first
    canvas.current?.focus();
    const t: Tool = e.button === 1 || space ? 'pan' : tool;
    if (e.button !== 0 && t !== 'pan') return;
    const p = toWorld(e.clientX, e.clientY);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    if (t === 'pan') {
      const start = { x: e.clientX, y: e.clientY, v: view };
      const move = (ev: PointerEvent) => setView({ ...start.v, tx: start.v.tx + ev.clientX - start.x, ty: start.v.ty + ev.clientY - start.y });
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (t === 'pen' || t === 'highlighter') {
      live.current = [[p.x, p.y, pressure(e)]];
      livePath.current?.points.clear();
      addLive(p.x, p.y);
      setPenDown(true);
      return;
    }
    if (t === 'eraser') {
      const gone = new Set<string>();
      const rub = (q: { x: number; y: number }) => {
        for (const it of doc.dataRef.current!.items) if (!gone.has(it.id) && hitItem(it, q.x, q.y, 8 / view.k)) gone.add(it.id);
        setErased(new Set(gone));
      };
      rub(p);
      const move = (ev: PointerEvent) => {
        const evs = ev.getCoalescedEvents?.() ?? [];
        for (const c of evs.length ? evs : [ev]) rub(toWorld(c.clientX, c.clientY));
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        setErased(new Set());
        if (gone.size) setItems(doc.dataRef.current!.items.filter((it) => !gone.has(it.id)));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (t === 'line' || t === 'arrow' || t === 'rect' || t === 'ellipse') {
      const base = { id: newId('s'), type: t, color, width, x1: p.x, y1: p.y, x2: p.x, y2: p.y } as ShapeDrawItem;
      let cur = base;
      setDraft(base);
      const move = (ev: PointerEvent) => {
        const q = toWorld(ev.clientX, ev.clientY);
        let { x, y } = q;
        if (ev.shiftKey) { // straight lines at 45° steps; squares and circles
          const dx = x - p.x, dy = y - p.y;
          if (t === 'line' || t === 'arrow') {
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
            x = p.x + Math.cos(a) * len; y = p.y + Math.sin(a) * len;
          } else { const s = Math.max(Math.abs(dx), Math.abs(dy)); x = p.x + Math.sign(dx || 1) * s; y = p.y + Math.sign(dy || 1) * s; }
        }
        cur = { ...base, x2: Math.round(x * 10) / 10, y2: Math.round(y * 10) / 10 };
        setDraft(cur);
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        move(ev);
        setDraft(null);
        if (Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) > 3 / view.k) setItems([...doc.dataRef.current!.items, cur]);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (t === 'text') {
      const hit = hitAt(p);
      if (hit?.type === 'text') setText({ x: hit.x, y: hit.y, id: hit.id, initial: hit.text });
      else setText({ x: p.x, y: p.y - (10 + width * 2) * 0.6, id: null, initial: '' });
      return;
    }
    // select: the resize handle, an item (move it), or empty paper (a selection box)
    const selBox = selectionBox();
    if (selBox && (e.target as Element).closest('.dr-resize')) {
      const from = selBox;
      let to: Box | null = null;
      const move = (ev: PointerEvent) => {
        const q = toWorld(ev.clientX, ev.clientY);
        const w = Math.max(8, q.x - from.x), h = Math.max(8, q.y - from.y);
        const keep = ev.shiftKey ? Math.max(w / from.w, h / from.h) : 0;
        to = { x: from.x, y: from.y, w: keep ? from.w * keep : w, h: keep ? from.h * keep : h };
        setResize({ from, to });
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        setResize(null);
        const target = to;
        if (target) setItems(doc.dataRef.current!.items.map((it) => (sel.has(it.id) ? scaleItem(it, from, target) : it)));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    const hit = hitAt(p) ?? (selBox && p.x >= selBox.x && p.x <= selBox.x + selBox.w && p.y >= selBox.y && p.y <= selBox.y + selBox.h ? { id: '' } : null);
    if (hit) {
      let ids = sel;
      if (hit.id && e.shiftKey) {
        const s = new Set(sel);
        if (s.has(hit.id)) s.delete(hit.id); else s.add(hit.id);
        setSel(s);
        return;
      }
      if (hit.id && !sel.has(hit.id)) { ids = new Set([hit.id]); setSel(ids); }
      const start = { x: e.clientX, y: e.clientY };
      let last = { dx: 0, dy: 0 };
      const move = (ev: PointerEvent) => { last = { dx: (ev.clientX - start.x) / view.k, dy: (ev.clientY - start.y) / view.k }; setMoveBy(last); };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        setMoveBy(null);
        if (Math.hypot(last.dx, last.dy) * view.k > 2) setItems(doc.dataRef.current!.items.map((it) => (ids.has(it.id) ? translateItem(it, last.dx, last.dy) : it)));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (!e.shiftKey) setSel(new Set());
    const keep = e.shiftKey ? new Set(sel) : new Set<string>();
    const move = (ev: PointerEvent) => {
      const q = toWorld(ev.clientX, ev.clientY);
      setMarquee({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      const q = toWorld(ev.clientX, ev.clientY);
      const box = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
      setMarquee(null);
      if (box.w * view.k < 3 && box.h * view.k < 3) return;
      for (const it of doc.dataRef.current!.items) if (itemInBox(it, box)) keep.add(it.id);
      setSel(keep);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!live.current) return;
    // every point the pointer passed through since the last event (pens report many per frame)
    const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of evs.length ? evs : [e.nativeEvent]) {
      const q = toWorld(ev.clientX, ev.clientY);
      live.current.push([Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, pressure(ev)]);
      addLive(q.x, q.y);
    }
  };
  const onUp = () => {
    const pts = live.current;
    if (!pts) return;
    live.current = null;
    setPenDown(false);
    const t = tool === 'highlighter' ? 'highlighter' : 'pen';
    const clean = smooth(thin(pts, 0.8 / view.k), t === 'pen' ? 2 : 1);
    const w = t === 'highlighter' ? Math.max(width * 3, 12) : width;
    const c = t === 'highlighter' && !HIGHLIGHTS.includes(color) ? HIGHLIGHTS[0] : color;
    setItems([...doc.dataRef.current!.items, { id: newId('p'), type: t, color: c, width: w, points: clean }]);
  };

  // ---- selection
  const selectionBox = (): Box | null => {
    if (!sel.size) return null;
    return unionBounds(doc.dataRef.current!.items.filter((it) => sel.has(it.id)));
  };
  const deleteSelected = () => { if (sel.size) { setItems(doc.dataRef.current!.items.filter((it) => !sel.has(it.id))); setSel(new Set()); } };
  const duplicateSelected = () => {
    if (!sel.size) return;
    const copies = doc.dataRef.current!.items.filter((it) => sel.has(it.id)).map((it) => ({ ...translateItem(it, 20, 20), id: newId('c') }));
    setItems([...doc.dataRef.current!.items, ...copies]);
    setSel(new Set(copies.map((c) => c.id)));
  };
  const clearAll = async () => {
    if (!doc.dataRef.current?.items.length) return;
    if (!(await ov.confirm({ title: 'Clear the drawing?', body: 'Everything on this page is removed. You can still undo it (Ctrl+Z) while it is open.', confirmText: 'Clear', danger: true }))) return;
    setItems([]);
    setSel(new Set());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (text) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let done = true;
    if (ctrl && k === 'z' && !e.shiftKey) undo();
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
    else if (ctrl && k === 'd') duplicateSelected();
    else if (ctrl && k === 'a') { setToolState('select'); setSel(new Set(d.items.map((it) => it.id))); }
    else if (ctrl && k === 's') doc.save();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) deleteSelected();
    else if (e.key === 'Escape') setSel(new Set());
    else if (e.key === ' ' && !e.repeat) setSpace(true);
    else if (!ctrl && !e.altKey && KEYS[k]) setTool(KEYS[k]);
    else if (e.key.startsWith('Arrow') && sel.size) {
      const s = e.shiftKey ? 20 : 2;
      const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
      setItems(doc.dataRef.current!.items.map((it) => (sel.has(it.id) ? translateItem(it, dx, dy) : it)));
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); } // the app's own Ctrl+Z (src/undo.ts) is for everything else
  };

  // ---- text
  const finishText = (value: string) => {
    if (!text) return;
    const cur = doc.dataRef.current!;
    const t = value.replace(/\s+$/, '');
    setText(null);
    canvas.current?.focus();
    if (text.id) {
      if (t === text.initial) return;
      setItems(t ? cur.items.map((it) => (it.id === text.id && it.type === 'text' ? { ...it, text: t } : it)) : cur.items.filter((it) => it.id !== text.id));
    } else if (t) setItems([...cur.items, { id: newId('t'), type: 'text', color, size: 10 + width * 2, x: Math.round(text.x), y: Math.round(text.y), text: t }]);
  };

  // ---- pictures, Apollo, export
  const picture = async (maxSide: number) => {
    const s = drawingSvg(doc.dataRef.current!);
    return svgToPng(s.svg, s.w, s.h, maxSide);
  };
  const check = async () => {
    await doc.save();
    if (!doc.dataRef.current?.items.length) {
      await ov.confirm({ title: 'Nothing to check yet', body: 'Draw something first.', confirmText: 'OK' });
      return;
    }
    setChecking(true);
    try {
      await api.noteSnapshot(id, await picture(1600));
      await api.startReview({ target: 'note', target_id: id, mode: 'check' });
      comments.setShow(true);
      comments.reviews.reload();
    } catch (err) {
      ov.confirm({ title: "Couldn't start the check", body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
    } finally { setChecking(false); }
  };
  const failed = (err: unknown) => ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
  const exportMenu = (e: React.MouseEvent) => ov.menu(e, [
    { label: 'Picture (.png)', onClick: async () => { try { await savePng(await picture(4000), doc.title || 'Drawing'); } catch (err) { failed(err); } } },
    ...(['docx', 'pdf'] as const).map((f) => ({
      label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
      onClick: async () => {
        await doc.save();
        try {
          const img = await picture(2400);
          await exportAs(f, doc.title || 'Drawing', () => `<p><img src="${img}" alt="" style="max-width:100%"></p>`
            + (doc.dataRef.current?.description ? `<p><i>${doc.dataRef.current.description.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</i></p>` : ''));
        } catch (err) { failed(err); }
      },
    })),
  ], { anchor: e.currentTarget, place: 'below' });
  const paperMenu = (e: React.MouseEvent) => ov.menu(e, PAPERS.map(([p, label]) => ({
    label, checked: d.paper === p, onClick: () => commit({ ...doc.dataRef.current!, paper: p }),
  })), { anchor: e.currentTarget, place: 'below' });

  // ---- what's drawn
  const visible: Box = { x: -view.tx / view.k, y: -view.ty / view.k, w: size.w / view.k, h: size.h / view.k };
  const paper = useMemo(() => paperSvg(d.paper, { x: visible.x - 40, y: visible.y - 40, w: visible.w + 80, h: visible.h + 80 }),
    [d.paper, Math.round(visible.x / 40), Math.round(visible.y / 40), Math.round(visible.w / 40), Math.round(visible.h / 40)]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownItems = d.items.filter((it) => !erased.has(it.id));
  const resized = resize ? new Map(shownItems.filter((it) => sel.has(it.id)).map((it) => [it.id, scaleItem(it, resize.from, resize.to)])) : null;
  const sb = resize ? resize.to : selectionBox();
  const cursor = space ? 'pan' : tool;

  const tb = (icon: IconName, tip: string, onClick: (e: React.MouseEvent) => void, on?: boolean, disabled?: boolean, cls = '') => (
    <button className={`ne-btn${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`} data-tip={tip} aria-label={tip} aria-pressed={on} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}><Icon name={icon} size={15} /></button>
  );
  const textSize = 10 + width * 2;

  return (
    <div className={`source note-editor drawing-editor${comments.show ? ' with-reviews' : ''}`}>
      <NoteHead doc={doc} subject={subject} placeholder="Untitled drawing" fallbackTitle="Untitled drawing"
        comments={{ show: comments.show, count: comments.count, toggle: () => comments.setShow(!comments.show) }} onClose={onClose}
        extra={<>
          <button className="btn btn-sm dr-check" disabled={checking} data-tip="Have Apollo look at your drawing and check it against your material"
            onClick={check}>{checking ? 'Sending…' : 'Check with Apollo'}</button>
          <button className="btn btn-sm dr-export" onClick={exportMenu}>Export <Icon name="chevronDown" size={14} /></button>
          <TourButton id="drawing" />
        </>} />
      <div className="ne-toolbar dr-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="ne-group ne-seg" role="group" aria-label="Tool">
          {TOOLS.map(([t, icon, tip]) => <span key={t}>{tb(icon, tip, () => setTool(t), tool === t)}</span>)}
        </div>
        <div className="ne-group dr-colours" role="group" aria-label="Colour">
          {(tool === 'highlighter' ? HIGHLIGHTS : INK_PALETTE).map((c) => (
            <button key={c} className={`dr-swatch${color === c ? ' on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} data-tip="Colour"
              onMouseDown={(e) => e.preventDefault()} onClick={() => pickColor(c)} />
          ))}
          <button className="ne-btn dr-custom" data-tip="Custom colour" aria-label="Custom colour" onMouseDown={(e) => e.preventDefault()}
            onClick={async () => { const c = await ov.color({ title: 'Ink colour', initial: color }); if (c) pickColor(c); }}><Icon name="more" size={15} /></button>
        </div>
        <div className="ne-group dr-widths" role="group" aria-label="Thickness">
          {WIDTHS.map((w) => (
            <button key={w} className={`ne-btn dr-width${width === w ? ' on' : ''}`} data-tip={`Thickness ${w}`} aria-label={`Thickness ${w}`} aria-pressed={width === w}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pickWidth(w)}>
              <span className="dr-dot" style={{ width: Math.min(w + 2, 14), height: Math.min(w + 2, 14) }} />
            </button>
          ))}
        </div>
        <div className="ne-group">
          {tb('copy', 'Duplicate (Ctrl+D)', duplicateSelected, false, !sel.size)}
          {tb('trash', 'Delete what is selected (Delete)', deleteSelected, false, !sel.size)}
          {tb('paper', 'Paper: plain, grid or lined', paperMenu, false, false, 'dr-paper')}
        </div>
        <div className="ne-group">
          {tb('zoomOut', 'Zoom out', () => zoomBy(1 / 1.25))}
          <span className="map-zoom muted small">{Math.round(view.k * 100)}%</span>
          {tb('zoomIn', 'Zoom in', () => zoomBy(1.25))}
          {tb('fit', 'Show the whole drawing', fit)}
        </div>
        <div className="ne-group">
          <button className={`ne-btn tool-calc${calcOpen ? ' on' : ''}`} data-tip={calcOpen ? 'Close the calculator' : 'Calculator and graphs'}
            aria-label="Calculator" aria-pressed={calcOpen} onMouseDown={(e) => e.preventDefault()} onClick={toggleCalculator}>
            <Icon name="calculator" size={16} />
          </button>
        </div>
        <span className="ne-fill" />
        <div className="ne-group">
          {tb('undo', 'Undo (Ctrl+Z)', undo, false, !hist.current.canUndo)}
          {tb('redo', 'Redo (Ctrl+Y)', redo, false, !hist.current.canRedo)}
          <button className="btn btn-sm dr-clear" onMouseDown={(e) => e.preventDefault()} onClick={clearAll} disabled={!d.items.length}>Clear</button>
        </div>
      </div>
      <div className="dr-describe">
        <input className="dr-desc" value={d.description} maxLength={300} placeholder="What this shows (one line for Apollo, e.g. “forces on a block on a slope”)"
          onChange={(e) => doc.setData({ ...doc.dataRef.current!, description: e.target.value })} aria-label="What this drawing shows" />
      </div>
      <div className="ne-body">
        <div ref={canvas} className={`dr-canvas tool-${cursor}`} tabIndex={0} aria-label="Drawing canvas"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { live.current = null; setPenDown(false); }}
          onKeyDown={onKeyDown} onKeyUp={(e) => { if (e.key === ' ') setSpace(false); }} onBlur={() => setSpace(false)}
          onDoubleClick={(e) => {
            if (tool !== 'select') return;
            const hit = hitAt(toWorld(e.clientX, e.clientY));
            if (hit?.type === 'text') setText({ x: hit.x, y: hit.y, id: hit.id, initial: hit.text });
          }}>
          <svg className="dr-svg" width="100%" height="100%">
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
              <g className="dr-paper-lines" dangerouslySetInnerHTML={{ __html: paper }} />
              {shownItems.map((it) => (
                text?.id === it.id ? null
                  : <Item key={it.id} it={resized?.get(it.id) ?? it} offset={moveBy && sel.has(it.id) ? moveBy : undefined} />
              ))}
              {draft && <Item it={draft} />}
              <polyline ref={livePath} visibility={penDown ? 'visible' : 'hidden'} fill="none"
                stroke={tool === 'highlighter' ? (HIGHLIGHTS.includes(color) ? color : HIGHLIGHTS[0]) : color}
                strokeOpacity={tool === 'highlighter' ? 0.38 : 1} strokeWidth={tool === 'highlighter' ? Math.max(width * 3, 12) : width}
                strokeLinecap="round" strokeLinejoin="round" />
              {sb && tool === 'select' && (
                <g className="dr-selection" transform={moveBy ? `translate(${moveBy.dx},${moveBy.dy})` : undefined}>
                  <rect x={sb.x - 4 / view.k} y={sb.y - 4 / view.k} width={sb.w + 8 / view.k} height={sb.h + 8 / view.k} strokeWidth={1 / view.k} />
                  <rect className="dr-resize" x={sb.x + sb.w} y={sb.y + sb.h} width={10 / view.k} height={10 / view.k} strokeWidth={1 / view.k}>
                    <title>Drag to resize (Shift keeps the shape)</title>
                  </rect>
                </g>
              )}
              {marquee && <rect className="dr-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} strokeWidth={1 / view.k} />}
            </g>
          </svg>
          {text && (
            <TextEditor initial={text.initial} color={color} onDone={finishText}
              style={{ left: view.tx + text.x * view.k, top: view.ty + text.y * view.k, fontSize: (text.id
                ? (d.items.find((it) => it.id === text.id) as { size?: number } | undefined)?.size ?? textSize : textSize) * view.k }} />
          )}
          {doc.data && !d.items.length && !penDown && <div className="map-empty muted">Draw here with the pen, or pick a shape or text from the toolbar.</div>}
        </div>
        <NoteComments id={id} r={comments} empty="Press Check with Apollo to have your drawing checked against your material (this needs a model that can see pictures)." />
      </div>
    </div>
  );
}

/** Writing text on the drawing: Enter for a new line, Ctrl+Enter or clicking away to finish, Escape to cancel. */
function TextEditor({ initial, color, style, onDone }: { initial: string; color: string; style: React.CSSProperties; onDone: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(initial);
  useEffect(() => { ref.current?.focus(); }, []);
  const finish = (t: string) => { if (!done.current) { done.current = true; onDone(t); } };
  const lines = value.split('\n');
  return (
    <textarea ref={ref} className="dr-text-edit" value={value} spellCheck rows={lines.length}
      cols={Math.max(8, ...lines.map((l) => l.length + 1))} style={{ ...style, color }}
      onChange={(e) => setValue(e.target.value)} onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(initial); }
      }} />
  );
}
