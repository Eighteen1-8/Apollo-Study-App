/* Things that float over the app and can be dragged by a grip (the find bar, the calculator). The position is an offset
   from wherever the thing normally sits, kept inside the window, and remembered per machine (pref `float:<key>`).

     const fl = useFloating<HTMLDivElement>('calc');
     <div ref={fl.ref} style={{ right: 24 - fl.offset.dx, top: 90 + fl.offset.dy }}>
       <span {...fl.grip} />   // pointer handlers (+ double-click puts it back)

   The drag uses pointer capture, so it keeps following the pointer over iframes and canvases and ends cleanly when the
   pointer is lost (pointercancel). */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getPref, setPref } from '../prefs';

export interface Offset { dx: number; dy: number }

const cache = new Map<string, Offset>();
function load(key: string): Offset {
  const hit = cache.get(key);
  if (hit) return hit;
  const o = getPref<Offset>(`float:${key}`, { dx: 0, dy: 0 }, (v) => {
    const p = JSON.parse(v);
    return Number.isFinite(p?.dx) && Number.isFinite(p?.dy) ? { dx: p.dx, dy: p.dy } : { dx: 0, dy: 0 };
  });
  cache.set(key, o);
  return o;
}
function save(key: string, o: Offset) {
  cache.set(key, o);
  setPref(`float:${key}`, JSON.stringify(o));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function useFloating<T extends HTMLElement = HTMLElement>(key: string, opts: {
  /** Kept this far inside the window (px). */
  margin?: number;
  /** After a drag ends (e.g. give the focus back to a field). */
  onDragEnd?: () => void;
} = {}) {
  const margin = opts.margin ?? 8;
  const ref = useRef<T>(null);
  const [offset, setOffset] = useState<Offset>(() => load(key));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x0: number; y0: number; o0: Offset; box: DOMRect } | null>(null);
  const end = useRef(opts.onDragEnd);
  end.current = opts.onDragEnd;

  /** The offset that keeps a box (now at `box`, drawn with offset `o0`) inside the window when moved to `want`. */
  const fit = useCallback((want: Offset, o0: Offset, box: DOMRect): Offset => ({
    dx: clamp(want.dx, o0.dx + margin - box.left, o0.dx + window.innerWidth - margin - box.right),
    dy: clamp(want.dy, o0.dy + margin - box.top, o0.dy + window.innerHeight - margin - box.bottom),
  }), [margin]);

  // a saved position from a bigger window (or a different anchor) may be off-screen: bring it back in, without saving.
  // Also callable after the thing changes size (`keepIn`).
  const keepIn = useCallback(() => {
    const el = ref.current;
    if (!el || drag.current) return;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return;
    setOffset((o) => {
      const n = fit(o, o, box);
      return Math.abs(n.dx - o.dx) < 0.5 && Math.abs(n.dy - o.dy) < 0.5 ? o : n;
    });
  }, [fit]);
  useLayoutEffect(() => {
    keepIn();
    window.addEventListener('resize', keepIn);
    return () => window.removeEventListener('resize', keepIn);
  }, [keepIn]);

  const finish = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    setOffset((o) => { save(key, o); return o; });
    end.current?.();
  };

  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || !ref.current) return;
      e.preventDefault();
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* not capturable: moves still arrive here */ }
      drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, o0: offset, box: ref.current.getBoundingClientRect() };
      setDragging(true);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      setOffset(fit({ dx: d.o0.dx + e.clientX - d.x0, dy: d.o0.dy + e.clientY - d.y0 }, d.o0, d.box));
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onDoubleClick: () => { const o = { dx: 0, dy: 0 }; setOffset(o); save(key, o); },
  };

  return { ref, offset, grip, dragging, keepIn, reset: grip.onDoubleClick };
}
