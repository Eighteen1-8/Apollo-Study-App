import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Annotation, AnnotationData, AnnotationKind, Stroke, TextAnchor } from '../api';
import { useOverlay } from '../components/overlay';
import { MathText } from '../components/ui';

/**
 * The student's annotations on the original document. Every unit (page / slide / section) renders a <UnitOverlay>
 * inside its `[data-unit]` element; positions are stored as fractions of that element's box so they follow zoom.
 * Text anchors also keep character offsets into the unit's rendered text, which flowing layouts (Word, text) use to
 * find the words again after reflow.
 */

/** 'area': drag a box over part of a page (screenshot for the chat, or a note about that area). */
export type Tool = 'select' | 'highlight' | 'pen' | 'eraser' | 'textbox' | 'note' | 'area';
export type Area = { unit: number; rect: [number, number, number, number] };
export const HIGHLIGHT_COLORS = ['#ffd84d', '#7ee081', '#7cc4ff', '#ff9ecb'];
export const INK_COLORS = ['#e5484d', '#2463eb', '#1b1d22', '#16a34a'];
const NOTE_W = 240; // px; note boxes stay readable at any zoom

export interface AnnoApi {
  items: Annotation[];
  tool: Tool;
  setTool: (t: Tool) => void;
  hlColor: string;
  inkColor: string;
  /** Fixed layouts (PDF pages, slides) keep their stored boxes; flowing ones re-find text by offset. */
  fixed: boolean;
  /** Annotation to focus once rendered (a new text box or note). */
  editing: number | null;
  flashId: number | null;
  create: (unit: number, kind: AnnotationKind, anchor: TextAnchor, data: AnnotationData) => Promise<Annotation>;
  update: (id: number, patch: { data?: AnnotationData; anchor?: TextAnchor }) => void;
  remove: (id: number) => void;
  /** The temporary area selection (right-drag or the screenshot tool); right-click it for its menu. */
  area: Area | null;
  setArea: (a: Area | null) => void;
  areaMenu: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, a?: Area) => void;
  /** An area to point out briefly (where a screenshot in the chat came from). */
  pulse: Area | null;
}

export const AnnoContext = createContext<AnnoApi | null>(null);
const useAnno = () => useContext(AnnoContext)!;

// ---------------------------------------------------------------- text anchoring

/** Text nodes of a unit in order, leaving out the annotation layer itself. */
function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.anno-layer') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (w.nextNode()) out.push(w.currentNode as Text);
  return out;
}

function offsetOf(root: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  let acc = 0;
  for (const t of textNodes(root)) {
    if (!r.intersectsNode(t)) continue;
    if (t === r.endContainer) return acc + r.endOffset;
    acc += t.length;
  }
  return acc;
}

function rangeAt(root: Element, start: number, end: number): Range | null {
  const r = document.createRange();
  let acc = 0;
  let started = false;
  for (const t of textNodes(root)) {
    if (!started && start <= acc + t.length) { r.setStart(t, Math.max(0, start - acc)); started = true; }
    if (started && end <= acc + t.length) { r.setEnd(t, Math.max(0, end - acc)); return r; }
    acc += t.length;
  }
  return null;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Line boxes of a range (from its text only, so wholly-selected blocks don't add a box each), merged per line. */
function rangeBoxes(range: Range, root: Element): DOMRect[] {
  const boxes: DOMRect[] = [];
  for (const t of textNodes(root)) {
    if (!range.intersectsNode(t)) continue;
    const r = document.createRange();
    r.setStart(t, t === range.startContainer ? range.startOffset : 0);
    r.setEnd(t, t === range.endContainer ? range.endOffset : t.length);
    for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) boxes.push(b);
  }
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: DOMRect[] = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.top - b.top) < Math.min(last.height, b.height) * 0.5 && b.left <= last.right + 6) {
      const top = Math.min(last.top, b.top);
      merged[merged.length - 1] = new DOMRect(Math.min(last.left, b.left), top, Math.max(last.right, b.right) - Math.min(last.left, b.left),
        Math.max(last.bottom, b.bottom) - top);
    } else merged.push(b);
  }
  return merged;
}

/** Anchor for a selection inside one unit element (a selection running past the unit is cut at its end). */
export function anchorFromRange(range: Range, unitEl: Element): TextAnchor {
  const r = range.cloneRange();
  if (!unitEl.contains(r.endContainer)) r.setEnd(unitEl, unitEl.childNodes.length);
  const box = unitEl.getBoundingClientRect();
  const start = offsetOf(unitEl, r.startContainer, r.startOffset);
  const end = offsetOf(unitEl, r.endContainer, r.endOffset);
  const full = textNodes(unitEl).map((t) => t.data).join('');
  return {
    start, end, text: full.slice(start, end),
    rects: rangeBoxes(r, unitEl).map((b) => [(b.left - box.left) / box.width, (b.top - box.top) / box.height, b.width / box.width, b.height / box.height]),
  };
}

type Px = { x: number; y: number; w: number; h: number };

function anchorPx(anchor: TextAnchor, el: Element, fixed: boolean, size: { w: number; h: number }): Px[] {
  const fromRects = () => (anchor.rects ?? []).map(([x, y, w, h]) => ({ x: x * size.w, y: y * size.h, w: w * size.w, h: h * size.h }));
  if (fixed && anchor.rects?.length) return fromRects();
  if (anchor.start != null && anchor.end != null && anchor.text) {
    let r = rangeAt(el, anchor.start, anchor.end);
    if (!r || squash(r.toString()) !== squash(anchor.text)) {
      // The text moved (e.g. the file was re-saved): look for the same words, nearest to where they were.
      const full = textNodes(el).map((t) => t.data).join('');
      let best = -1;
      for (let i = full.indexOf(anchor.text); i >= 0; i = full.indexOf(anchor.text, i + 1)) {
        if (best < 0 || Math.abs(i - anchor.start) < Math.abs(best - anchor.start)) best = i;
      }
      r = best >= 0 ? rangeAt(el, best, best + anchor.text.length) : null;
    }
    if (r) {
      const box = el.getBoundingClientRect();
      const sx = size.w / (box.width || 1);
      const sy = size.h / (box.height || 1);
      return rangeBoxes(r, el).map((b) => ({ x: (b.left - box.left) * sx, y: (b.top - box.top) * sy, w: b.width * sx, h: b.height * sy }));
    }
  }
  return fromRects();
}

/** Where a note about some text goes: just below the end of the text, kept on the page. */
export function notePlacement(anchor: TextAnchor, unitEl: Element) {
  const box = unitEl.getBoundingClientRect();
  const w = Math.min(NOTE_W / box.width, 0.9);
  const last = anchor.rects?.[anchor.rects.length - 1] ?? [0.05, 0.05, 0, 0];
  return {
    x: Math.max(0.01, Math.min(last[0], 0.99 - w)), y: Math.min(last[1] + last[3] + 0.006, 0.95),
    w, h: Math.min(150 / box.height, 0.5),
  };
}

// ---------------------------------------------------------------- per-unit overlay

const strokePath = (s: Stroke, w: number, h: number) => {
  const p = s.points;
  let d = `M${p[0] * w},${p[1] * h}`;
  for (let i = 2; i < p.length; i += 2) d += ` L${p[i] * w},${p[i + 1] * h}`;
  return d;
};

function nearStroke(s: Stroke, x: number, y: number, w: number, h: number, tol: number) {
  const p = s.points;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] * w, ay = p[i + 1] * h, bx = p[i + 2] * w, by = p[i + 3] * h;
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= tol) return true;
  }
  return p.length === 2 && Math.hypot(p[0] * w - x, p[1] * h - y) <= tol;
}

export function UnitOverlay({ unit }: { unit: number }) {
  const ctx = useAnno();
  const ov = useOverlay();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [boxes, setBoxes] = useState<Record<number, Px[]>>({});
  const [live, setLive] = useState<number[] | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const mine = ctx.items.filter((a) => a.unit === unit);

  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || !size.w) return;
    const out: Record<number, Px[]> = {};
    for (const a of mine) {
      if ((a.kind === 'highlight' || a.kind === 'note') && (a.anchor.text || a.anchor.rects?.length)) out[a.id] = anchorPx(a.anchor, el, ctx.fixed, size);
    }
    setBoxes(out);
  }, [size.w, size.h, ctx.items, ctx.fixed]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const erase = (e: React.PointerEvent) => {
    const p = at(e);
    for (const a of mine) {
      if (a.kind === 'ink' && (a.data.strokes ?? []).some((s) => nearStroke(s, p.px, p.py, size.w, size.h, 8))) ctx.remove(a.id);
    }
  };
  const down = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = at(e);
    if (ctx.tool === 'pen') {
      (e.target as Element).setPointerCapture(e.pointerId);
      setLive([p.x, p.y]);
    } else if (ctx.tool === 'eraser') {
      (e.target as Element).setPointerCapture(e.pointerId);
      erase(e);
    } else if (ctx.tool === 'textbox') {
      ctx.setTool('select');
      await ctx.create(unit, 'textbox', {}, { x: p.x, y: p.y - 10 / size.h, w: Math.min(260 / size.w, 1 - p.x), h: 24 / size.h,
        size: 15 / size.w, color: ctx.inkColor, text: '' });
    } else if (ctx.tool === 'area') {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else if (ctx.tool === 'note') {
      ctx.setTool('select');
      const w = Math.min(NOTE_W / size.w, 0.9);
      await ctx.create(unit, 'note', {}, { x: Math.min(p.x, 0.99 - w), y: p.y, w, h: Math.min(150 / size.h, 0.5), text: '', color: HIGHLIGHT_COLORS[0] });
    }
  };
  const move = (e: React.PointerEvent) => {
    if (ctx.tool === 'pen' && live) {
      const p = at(e);
      setLive((l) => l && [...l, p.x, p.y]);
    } else if (ctx.tool === 'eraser' && e.buttons === 1) erase(e);
    else if (ctx.tool === 'area' && drawing) {
      const p = at(e);
      setDrawing({ ...drawing, x1: Math.max(0, Math.min(1, p.x)), y1: Math.max(0, Math.min(1, p.y)) });
    }
  };
  const up = (e: React.PointerEvent) => {
    if (ctx.tool === 'area' && drawing) {
      const r: [number, number, number, number] = [Math.min(drawing.x0, drawing.x1), Math.min(drawing.y0, drawing.y1),
        Math.abs(drawing.x1 - drawing.x0), Math.abs(drawing.y1 - drawing.y0)];
      setDrawing(null);
      ctx.setTool('select');
      if (r[2] * size.w >= 10 && r[3] * size.h >= 10) {
        const area = { unit, rect: r };
        ctx.setArea(area);
        ctx.areaMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {}, stopPropagation: () => {} }, area);
      }
      return;
    }
    if (ctx.tool === 'pen' && live) {
      if (live.length >= 4) ctx.create(unit, 'ink', {}, { strokes: [{ color: ctx.inkColor, width: 2.4 / size.w, points: live.map((v) => Math.round(v * 10000) / 10000) }] });
      setLive(null);
    }
  };

  const capture = ['pen', 'eraser', 'textbox', 'note', 'area'].includes(ctx.tool);

  // Hidden notes: the highlights they sit on glow, and an orb marks where the note is.
  const overlaps = (p: Px[], q: Px[]) => p.some((a) => q.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  const glowOf = new Map<number, Annotation>(); // highlight id → the hidden note on it
  for (const n of mine) {
    if (n.kind !== 'note' || !n.data.hidden || n.data.area || !boxes[n.id]?.length) continue;
    for (const h of mine) if (h.kind === 'highlight' && boxes[h.id] && overlaps(boxes[h.id], boxes[n.id])) glowOf.set(h.id, n);
  }
  const coveredNotes = new Set([...glowOf.values()].map((n) => n.id));
  const orbAt = (a: Annotation) => {
    return { x: (a.data.x ?? 0) * size.w, y: (a.data.y ?? 0) * size.h };
  };
  const noteMenu = (e: React.MouseEvent, a: Annotation) => ov.menu(e, [
    { label: a.data.hidden ? 'Show note' : 'Hide note', onClick: () => ctx.update(a.id, { data: { hidden: !a.data.hidden } }) },
    { label: 'Delete note', danger: true, separatorBefore: true, onClick: () => ctx.remove(a.id) },
  ]);

  return (
    <div ref={ref} className="anno-layer">
      {mine.map((a) => {
        // A highlight under a hidden note glows (it isn't a plain highlight); the note's own glow then isn't needed.
        const note = a.kind === 'note' && a.data.hidden ? (coveredNotes.has(a.id) ? null : a) : glowOf.get(a.id);
        if (a.kind === 'note' && a.data.hidden && !note) return null;
        return (boxes[a.id] ?? []).map((b, i) => (
          <div key={`${a.id}-${i}`} data-anno={a.id}
            className={`${a.data.area ? 'anno-area' : `anno-hl${a.kind === 'note' ? ' anno-noted' : ''}`}${note ? ' anno-glow' : ''}${ctx.flashId === a.id ? ' flash' : ''}`}
            style={{ left: b.x - 1, top: b.y, width: b.w + 2, height: b.h, '--hl': a.data.color ?? HIGHLIGHT_COLORS[0] } as React.CSSProperties}
            title={note ? 'Has a hidden note: click to show it' : undefined}
            onClick={note ? () => ctx.update(note.id, { data: { hidden: false } }) : undefined}
            onContextMenu={note ? (e) => noteMenu(e, note) : undefined} />
        ));
      })}

      {mine.filter((a) => a.kind === 'region').map((a) => (
        <div key={a.id} data-anno={a.id} className={`anno-region${ctx.flashId === a.id ? ' flash' : ''}`}
          style={{ left: (a.data.x ?? 0) * size.w, top: (a.data.y ?? 0) * size.h, width: (a.data.w ?? 0) * size.w, height: (a.data.h ?? 0) * size.h }}>
          <span className="anno-region-tag">Sent to chat</span>
        </div>
      ))}

      {size.w > 0 && (
        <svg className="anno-ink" width={size.w} height={size.h}>
          {mine.filter((a) => a.kind === 'ink').flatMap((a) => (a.data.strokes ?? []).map((s, i) => (
            <path key={`${a.id}-${i}`} data-anno={a.id} className={ctx.flashId === a.id ? 'flash' : ''} d={strokePath(s, size.w, size.h)}
              stroke={s.color} strokeWidth={Math.max(s.width * size.w, 1)} />
          )))}
          {live && live.length >= 2 && (
            <path d={strokePath({ color: ctx.inkColor, width: 0, points: live }, size.w, size.h)} stroke={ctx.inkColor} strokeWidth={2.4} />
          )}
        </svg>
      )}

      {mine.filter((a) => a.kind === 'textbox').map((a) => <TextBox key={a.id} a={a} size={size} />)}
      {mine.filter((a) => a.kind === 'note').map((a) => (
        a.data.hidden
          ? (!a.anchor.text && !a.data.area && !a.anchor.rects?.length
            ? <Orb key={a.id} note={a} at={orbAt(a)} size={size} onShow={() => ctx.update(a.id, { data: { hidden: false } })} onMenu={(e) => noteMenu(e, a)} />
            : null)
          : <NoteBox key={a.id} a={a} size={size} onMenu={(e) => noteMenu(e, a)} />
      ))}

      {ctx.pulse?.unit === unit && size.w > 0 && (
        <div className="anno-pulse" style={{ left: ctx.pulse.rect[0] * size.w, top: ctx.pulse.rect[1] * size.h,
          width: ctx.pulse.rect[2] * size.w, height: ctx.pulse.rect[3] * size.h }} />
      )}
      {ctx.area?.unit === unit && size.w > 0 && (
        <div className="anno-temp-area" title="Right-click for options"
          style={{ left: ctx.area.rect[0] * size.w, top: ctx.area.rect[1] * size.h, width: ctx.area.rect[2] * size.w, height: ctx.area.rect[3] * size.h }}
          onContextMenu={(e) => { e.stopPropagation(); ctx.areaMenu(e); }} onMouseDown={(e) => e.stopPropagation()} />
      )}
      {drawing && (
        <div className="anno-temp-area drawing" style={{ left: Math.min(drawing.x0, drawing.x1) * size.w, top: Math.min(drawing.y0, drawing.y1) * size.h,
          width: Math.abs(drawing.x1 - drawing.x0) * size.w, height: Math.abs(drawing.y1 - drawing.y0) * size.h }} />
      )}

      {capture && (
        <div className={`anno-capture tool-${ctx.tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setDrawing(null); setLive(null); }} />
      )}
    </div>
  );
}

/**
 * A hidden note: a small glowing orb. It samples the page under itself (PDF canvas) and switches colour when yellow
 * wouldn't stand out: deeper amber with a dark ring on light pages, violet on yellow areas, bright yellow on dark.
 */
function Orb({ note, at, size, onShow, onMenu }: {
  note: Annotation; at: { x: number; y: number }; size: { w: number; h: number }; onShow: () => void; onMenu: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [tone, setTone] = useState<'light' | 'yellow' | 'dark'>('light');
  useEffect(() => {
    const sample = () => {
      const unitEl = ref.current?.closest('[data-unit]');
      const canvas = unitEl?.querySelector<HTMLCanvasElement>('.pdf-render canvas');
      if (!unitEl || !canvas || !canvas.width) return false;
      const k = canvas.width / unitEl.clientWidth;
      const n = Math.max(2, Math.round(18 * k)); // average the patch under the orb
      const px = canvas.getContext('2d')!.getImageData(Math.round(at.x * k), Math.round(at.y * k), n, n).data;
      let [r, g, b] = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3] / 255; // unpainted (transparent) canvas is the white page
        r += (px[i] * a + 255 * (1 - a)) / 255;
        g += (px[i + 1] * a + 255 * (1 - a)) / 255;
        b += (px[i + 2] * a + 255 * (1 - a)) / 255;
      }
      const count = px.length / 4;
      [r, g, b] = [r / count, g / count, b / count];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const yellowish = max - min > 0.25 && r > 0.55 && g > 0.45 && b < Math.min(r, g) - 0.2;
      setTone(yellowish ? 'yellow' : lum > 0.5 ? 'light' : 'dark');
      return true;
    };
    if (sample()) return;
    const t = setInterval(() => { if (sample()) clearInterval(t); }, 500); // the page may still be drawing
    return () => clearInterval(t);
  }, [at.x, at.y, size.w]);
  const label = note.data.definition ? `Definition: ${note.data.title}` : note.data.text?.slice(0, 80) || 'Note';
  return (
    <button ref={ref} className={`anno-orb orb-${tone}`} data-anno={note.id} style={{ left: at.x, top: at.y }}
      title={`${label} (click to show)`} onClick={onShow} onContextMenu={(e) => { e.stopPropagation(); onMenu(e); }} />
  );
}

/** Drag something by a grip; reports the new top-left as unit fractions on release. */
function useMove(a: Annotation, size: { w: number; h: number }) {
  const ctx = useAnno();
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => { last = { dx: ev.clientX - x0, dy: ev.clientY - y0 }; setOffset(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setOffset(null);
      if (Math.hypot(last.dx, last.dy) > 2) {
        ctx.update(a.id, { data: {
          x: Math.max(0, Math.min((a.data.x ?? 0) + last.dx / size.w, 0.98)), y: Math.max(0, Math.min((a.data.y ?? 0) + last.dy / size.h, 0.98)),
        } });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pos = { left: (a.data.x ?? 0) * size.w + (offset?.dx ?? 0), top: (a.data.y ?? 0) * size.h + (offset?.dy ?? 0) };
  return { start, pos, moving: !!offset };
}

/** Grows a textarea to fit its text. */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement>, value: string, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }, [value, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

function TextBox({ a, size }: { a: Annotation; size: { w: number; h: number } }) {
  const ctx = useAnno();
  const ov = useOverlay();
  const { start, pos, moving } = useMove(a, size);
  const [text, setText] = useState(a.data.text ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const fontSize = Math.max((a.data.size ?? 0.016) * size.w, 8);
  useAutoHeight(ta, text, [fontSize]);
  useEffect(() => { if (ctx.editing === a.id) ta.current?.focus(); }, [ctx.editing, a.id]);
  return (
    <div className={`anno-textbox${moving ? ' moving' : ''}${ctx.flashId === a.id ? ' flash' : ''}`} data-anno={a.id}
      style={{ ...pos, width: (a.data.w ?? 0.3) * size.w }}
      onContextMenu={(e) => ov.menu(e, [{ label: 'Delete text box', danger: true, onClick: () => ctx.remove(a.id) }])}>
      <span className="tb-grip" title="Drag to move" onPointerDown={start}>⠿</span>
      <textarea ref={ta} rows={1} value={text} placeholder="Type here" spellCheck
        style={{ fontSize, color: a.data.color ?? INK_COLORS[0] }}
        onChange={(e) => { setText(e.target.value); ctx.update(a.id, { data: { text: e.target.value } }); }}
        onBlur={() => { if (!text.trim()) ctx.remove(a.id); }} />
    </div>
  );
}

function NoteBox({ a, size, onMenu }: { a: Annotation; size: { w: number; h: number }; onMenu: (e: React.MouseEvent) => void }) {
  const ctx = useAnno();
  const { start, pos, moving } = useMove(a, size);
  const [text, setText] = useState(a.data.text ?? '');
  const [drawing, setDrawing] = useState(false);
  const [editingText, setEditingText] = useState(!a.data.definition || !a.data.text);
  const ta = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(ta, text, [editingText]);
  useEffect(() => { if (ctx.editing === a.id) ta.current?.focus(); }, [ctx.editing, a.id]);
  useEffect(() => { if (!a.data.pending) { setText(a.data.text ?? ''); if (a.data.definition) setEditingText(false); } }, [a.data.pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = a.data.pending && Date.now() / 1000 - a.created_at < 300;
  const strokes = a.data.strokes ?? [];
  return (
    <div className={`anno-note${moving ? ' moving' : ''}${ctx.flashId === a.id ? ' flash' : ''}`} data-anno={a.id}
      style={{ ...pos, width: NOTE_W }} onContextMenu={(e) => { e.stopPropagation(); onMenu(e); }}>
      <div className="note-head" onPointerDown={start} title="Drag to move">
        <span className="note-title">{a.data.definition ? <>Definition · <b>{a.data.title}</b></> : a.anchor.text ? 'Note' : 'Note'}</span>
        <button className={`note-btn${drawing ? ' on' : ''}`} title={drawing ? 'Stop drawing' : 'Draw in this note'}
          onPointerDown={(e) => e.stopPropagation()} onClick={() => setDrawing(!drawing)}>✎</button>
        <button className="note-btn" title="Hide note" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => ctx.update(a.id, { data: { hidden: true } })}>×</button>
      </div>
      {pending ? <div className="note-pending">Defining<span className="dots" /></div>
        : editingText ? (
          <textarea ref={ta} className="note-text" rows={2} value={text} placeholder="Write a note…"
            onChange={(e) => { setText(e.target.value); ctx.update(a.id, { data: { text: e.target.value } }); }}
            onBlur={() => a.data.definition && text.trim() && setEditingText(false)} />
        ) : (
          <div className="note-read" title="Click to edit" onClick={() => { setEditingText(true); setTimeout(() => ta.current?.focus(), 0); }}>
            <MathText text={text} />
          </div>
        )}
      {(drawing || strokes.length > 0) && (
        <NotePad strokes={strokes} active={drawing} color={ctx.inkColor}
          onChange={(s) => ctx.update(a.id, { data: { strokes: s } })} />
      )}
    </div>
  );
}

/** A small drawing area inside a note; strokes are fractions of the pad. */
function NotePad({ strokes, active, color, onChange }: { strokes: Stroke[]; active: boolean; color: string; onChange: (s: Stroke[]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const W = NOTE_W - 2;
  const H = 120;
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000];
  };
  return (
    <svg ref={ref} className={`note-pad${active ? ' active' : ''}`} width={W} height={H}
      onPointerDown={(e) => { if (!active) return; e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); setLive(at(e)); }}
      onPointerMove={(e) => live && setLive([...live, ...at(e)])}
      onPointerUp={() => { if (live && live.length >= 4) onChange([...strokes, { color, width: 2 / W, points: live }]); setLive(null); }}>
      {[...strokes, ...(live ? [{ color, width: 2 / W, points: live }] : [])].map((s, i) => (
        <path key={i} d={strokePath(s, W, H)} stroke={s.color} strokeWidth={Math.max(s.width * W, 1)} />
      ))}
      {active && strokes.length > 0 && (
        <text x={W - 6} y={H - 6} textAnchor="end" className="note-pad-clear" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onChange([])}>clear</text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- right-hand rail

const KIND_ICON: Record<AnnotationKind, string> = { highlight: '▮', note: '🗒', ink: '✎', textbox: 'T', region: '▣' };
type Filter = 'all' | AnnotationKind;

export function AnnotationRail({ items, unitLabel, onGo, onDelete, needsReingest, busy, onReingest, onExport, onClose }: {
  items: Annotation[]; unitLabel: (unit: number) => string; onGo: (a: Annotation) => void; onDelete: (a: Annotation) => void;
  needsReingest: boolean; busy: boolean; onReingest: () => void; onExport: (() => void) | null; onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = items.filter((a) => filter === 'all' || a.kind === filter);
  const units = [...new Set(shown.map((a) => a.unit))].sort((a, b) => a - b);
  const snippet = (a: Annotation) => {
    if (a.kind === 'ink') return `Drawing (${a.data.strokes?.length ?? 0} stroke${a.data.strokes?.length === 1 ? '' : 's'})`;
    if (a.kind === 'textbox') return a.data.text || 'Empty text box';
    if (a.kind === 'region') return 'Screenshot sent to the chat';
    if (a.kind === 'note') {
      const body = a.data.pending ? 'Defining…' : a.data.text || (a.data.strokes?.length ? 'Drawing' : 'Empty note');
      return a.data.definition ? `${a.data.title}: ${body}` : a.anchor.text ? `“${a.anchor.text}” · ${body}` : a.data.area ? `Area note · ${body}` : body;
    }
    return `“${a.anchor.text ?? ''}”`;
  };
  return (
    <aside className="anno-rail">
      <div className="rail-head">
        <span>Annotations <span className="count-badge">{items.length}</span></span>
        <button className="icon-btn" title="Hide annotations" onClick={onClose}>›</button>
      </div>
      {(needsReingest || busy) && (
        <div className={`rail-card${busy ? '' : ' warn'}`}>
          {busy ? <>Re-ingesting with your notes<span className="dots" /></> : (
            <>
              <div>Your notes changed since Apollo last read this file.</div>
              <button className="btn btn-sm btn-primary" onClick={onReingest}>Re-ingest with notes</button>
            </>
          )}
        </div>
      )}
      {onExport && items.length > 0 && <button className="btn btn-sm rail-export" onClick={onExport}>Export annotated PDF…</button>}
      <div className="rail-filters">
        {(['all', 'highlight', 'note', 'textbox', 'ink'] as Filter[]).map((f) => (
          <button key={f} className={`rail-filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'highlight' ? 'Highlights' : f === 'note' ? 'Notes' : f === 'textbox' ? 'Text' : 'Drawings'}
          </button>
        ))}
      </div>
      <div className="rail-list">
        {shown.length === 0 && (
          <div className="rail-empty">
            {items.length ? 'Nothing of this kind yet.' : 'Select text to highlight it, define it or add a note. Use the pen, text box and note tools above to write on the page.'}
          </div>
        )}
        {units.map((u) => (
          <div key={u} className="rail-group">
            <div className="rail-unit">{unitLabel(u)}</div>
            {shown.filter((a) => a.unit === u).map((a) => (
              <div key={a.id} className="rail-item" onClick={() => onGo(a)} title="Go to this annotation">
                <span className={`rail-icon k-${a.kind}`}
                  style={{ color: a.kind === 'highlight' || a.kind === 'note' ? undefined : a.data.color ?? a.data.strokes?.[0]?.color,
                    background: a.kind === 'highlight' ? a.data.color : undefined }}>{KIND_ICON[a.kind]}</span>
                <span className="rail-text">{snippet(a)}</span>
                {a.kind === 'note' && a.data.hidden && <span className="rail-hidden" title="Hidden note">hidden</span>}
                <button className="x-btn rail-x" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(a); }}>×</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
