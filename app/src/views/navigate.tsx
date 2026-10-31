import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Annotation, OutlineItem } from '../api';
import { HIGHLIGHT_COLORS } from './annotate';

/** Where a unit sits in the scroll content (px). */
type UnitBox = { unit: number; top: number; left: number; w: number; h: number };

const MAP_W = 74;

/** Unit boxes measured from the DOM, kept current as the content resizes (zoom, lazy pages, images). */
function useUnitBoxes(scroller: React.RefObject<HTMLDivElement>, deps: unknown[]) {
  const [boxes, setBoxes] = useState<UnitBox[]>([]);
  const measure = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const base = sc.getBoundingClientRect();
    const seen = new Set<number>();
    const out: UnitBox[] = [];
    for (const el of sc.querySelectorAll<HTMLElement>('[data-unit]')) {
      const unit = Number(el.dataset.unit);
      if (seen.has(unit)) continue;
      seen.add(unit);
      const r = el.getBoundingClientRect();
      out.push({ unit, top: r.top - base.top + sc.scrollTop, left: r.left - base.left + sc.scrollLeft, w: r.width, h: r.height });
    }
    setBoxes(out);
  }, [scroller]);
  useLayoutEffect(() => {
    const sc = scroller.current;
    const content = sc?.firstElementChild;
    if (!sc || !content) return;
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(content);
    ro.observe(sc);
    return () => ro.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return boxes;
}

/**
 * VS Code-style minimap over the right edge of the document: every page as a thumbnail (PDFs and Office copies) or a
 * block, coloured ticks for annotations, and a slider for the visible part. Click to jump, drag the slider to scroll.
 * When the document is taller than the map, the map scrolls along with it.
 */
export function Minimap({ scroller, docId, thumbs, items, deps, onClose }: {
  scroller: React.RefObject<HTMLDivElement>; docId: number; thumbs: boolean; items: Annotation[]; deps: unknown[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const boxes = useUnitBoxes(scroller, deps);
  const [view, setView] = useState({ top: 0, h: 1, H: 1, mapH: 1, sbw: 0 });

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ top: sc.scrollTop, h: sc.clientHeight, H: sc.scrollHeight,
        mapH: ref.current?.clientHeight ?? 1, sbw: sc.offsetWidth - sc.clientWidth }));
    };
    update();
    sc.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    return () => { sc.removeEventListener('scroll', update); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [scroller]);

  const minLeft = Math.min(...boxes.map((b) => b.left), Infinity);
  const maxW = Math.max(...boxes.map((b) => b.left + b.w), 1) - (Number.isFinite(minLeft) ? minLeft : 0);
  const s = (MAP_W - 12) / Math.max(maxW, 1); // fixed horizontal scale, like VS Code
  const contentH = view.H * s;
  const overflow = contentH > view.mapH;
  const offset = overflow ? (view.top / Math.max(view.H - view.h, 1)) * (contentH - view.mapH) : 0;
  const k = overflow ? (view.mapH - s * view.h) / Math.max(view.H - view.h, 1) : s; // slider px per document px

  const markers = useMemo(() => items.flatMap((a) => {
    const b = boxes.find((x) => x.unit === a.unit);
    if (!b) return [];
    const y = a.anchor.rects?.[0]?.[1] ?? a.data.y
      ?? (a.data.strokes?.length ? Math.min(...a.data.strokes.flatMap((st) => st.points.filter((_, i) => i % 2 === 1))) : 0);
    const color = a.kind === 'highlight' ? a.data.color ?? HIGHLIGHT_COLORS[0] : a.kind === 'note' ? '#ffd84d'
      : a.kind === 'region' ? '#7c8cff' : a.data.color ?? a.data.strokes?.[0]?.color ?? '#e5484d';
    return [{ id: a.id, top: (b.top + y * b.h) * s, color }];
  }), [items, boxes, s]);

  const down = (e: React.PointerEvent) => {
    const sc = scroller.current;
    if (!sc || e.button !== 0) return;
    e.preventDefault();
    const mapTop = ref.current!.getBoundingClientRect().top;
    const sliderTop = view.top * s - offset;
    const y = e.clientY - mapTop;
    const startTop = (y < sliderTop || y > sliderTop + view.h * s)
      ? Math.max(0, (y + offset) / s - view.h / 2) // jump: centre the clicked point, then keep dragging from there
      : sc.scrollTop;
    sc.scrollTop = startTop;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => { sc.scrollTop = startTop + (ev.clientY - y0) / k; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const visTop = offset - 300;
  const visBottom = offset + view.mapH + 300;
  return (
    <div ref={ref} className="minimap" style={{ right: view.sbw, width: MAP_W }} onPointerDown={down}>
      <div className="mm-content" style={{ transform: `translateY(${-offset}px)` }}>
        {boxes.map((b) => {
          const top = b.top * s;
          const h = Math.max(b.h * s, 1);
          const inView = top + h > visTop && top < visBottom;
          return (
            <div key={b.unit} className="mm-page" style={{ top, left: 6 + (b.left - minLeft) * s, width: Math.max(b.w * s, 2), height: h }}>
              {thumbs && inView && h >= 12 && <img src={api.thumbUrl(docId, b.unit, 120)} alt="" draggable={false} loading="lazy" />}
            </div>
          );
        })}
        {markers.map((m) => <span key={m.id} className="mm-marker" style={{ top: m.top, background: m.color }} />)}
      </div>
      <div className="mm-slider" style={{ top: view.top * s - offset, height: Math.max(view.h * s, 8) }} />
      <button className="mm-close" title="Hide the minimap" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>›</button>
    </div>
  );
}

/** Chapter list (PDF bookmarks, Word headings, slide titles) as a collapsible tree; the current chapter is marked. */
export function OutlinePanel({ items, current, onGo, onClose }: {
  items: OutlineItem[]; current: { unit: number; y: number }; onGo: (o: OutlineItem) => void; onClose: () => void;
}) {
  const [folded, setFolded] = useState<Set<number>>(() => new Set(items.flatMap((o, i) => (o.level >= 2 && items[i + 1]?.level > o.level ? [i] : []))));
  const [q, setQ] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const hasKids = (i: number) => (items[i + 1]?.level ?? 0) > items[i].level;
  let cur = -1;
  items.forEach((o, i) => { if (o.unit < current.unit || (o.unit === current.unit && o.y <= current.y + 0.02)) cur = i; });

  // An item is shown when no ancestor is folded (or when searching).
  const visible: number[] = [];
  const stack: number[] = [];
  items.forEach((o, i) => {
    while (stack.length && items[stack[stack.length - 1]].level >= o.level) stack.pop();
    const hidden = stack.some((j) => folded.has(j));
    if (q ? o.title.toLowerCase().includes(q.toLowerCase()) : !hidden) visible.push(i);
    stack.push(i);
  });

  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('.ol-item.current');
    if (el && list.current) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 3;
  }, []);

  return (
    <div className="outline-panel" onContextMenu={(e) => e.stopPropagation()}>
      <div className="ol-head">
        <span>Chapters</span>
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>
      {items.length > 12 && <input className="ol-search" placeholder="Find a chapter" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="ol-list" ref={list}>
        {visible.map((i) => {
          const o = items[i];
          return (
            <div key={i} className={`ol-item${i === cur ? ' current' : ''}`} style={{ paddingLeft: 8 + (q ? 0 : (o.level - 1) * 14) }}>
              {!q && hasKids(i) ? (
                <button className={`ol-caret${folded.has(i) ? ' folded' : ''}`} onClick={() => setFolded((f) => {
                  const n = new Set(f);
                  if (n.has(i)) n.delete(i); else n.add(i);
                  return n;
                })}>▾</button>
              ) : <span className="ol-caret-space" />}
              <button className="ol-title" title={o.title} onClick={() => onGo(o)}>{o.title}</button>
              <span className="ol-page">{o.unit}</span>
            </div>
          );
        })}
        {visible.length === 0 && <div className="ol-empty">No chapters match.</div>}
      </div>
    </div>
  );
}
