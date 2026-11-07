/* Where the chat sits in the subject workspace's centre, and how it moves: floating in a bottom corner (drag the header
   to switch corners or onto a note's Comments panel, drag the inner top corner to resize), minimised to a pill, side
   by side with what's open (a draggable divider), or full screen. The shell's box is set in pixels so every change
   animates. Positions and sizes are remembered on this computer (prefs). */
import { useLayoutEffect, useState } from 'react';
import type { ChatMode } from '../ChatView';
import { getPref, setPref } from '../../prefs';

type Side = 'left' | 'right';
const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.75;
const MARGIN = 18;
const MIN_W = 320;
const MIN_H = 240;
const CENTER_MIN = 380;

export function useChatDock({ center, shell, ready, floating, chatFull, setChatFull, startCollapsed }: {
  center: React.RefObject<HTMLElement>; shell: React.RefObject<HTMLDivElement>;
  /** The workspace has rendered its centre (the subject exists). */
  ready: boolean;
  /** Something is open in the centre (cloud, document or page): the chat floats over or beside it. */
  floating: boolean;
  chatFull: boolean; setChatFull: (on: boolean) => void;
  startCollapsed: () => boolean;
}) {
  const [chatCollapsed, setChatCollapsed] = useState(startCollapsed);
  // side by side: the chat takes `chatFrac` of the centre beside the document / cloud instead of floating
  const [chatSplit, setChatSplit] = useState(() => getPref('chatSplit', false, (v) => v === '1'));
  const [chatFrac, setChatFrac] = useState(() => getPref('chatSplitFrac', 0.5, (v) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(v) || 0.5))));
  const [chatSizing, setChatSizing] = useState(false);
  // docked over the note's Comments panel instead of beside it
  const [overReviews, setOverReviews] = useState(() => getPref('chatOverReviews', false, (v) => v === '1'));
  const [dragOverReviews, setDragOverReviews] = useState(false);
  const [side, setSide] = useState<Side>(() => getPref<Side>('chatSide', 'right', (v) => (v === 'left' ? 'left' : 'right')));
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => getPref<{ w: number; h: number } | null>('chatSize', null, JSON.parse));
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  useLayoutEffect(() => {
    const el = center.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Follow window resizes instantly; only state changes animate.
      shell.current?.classList.add('instant');
      setBox({ w: el.clientWidth, h: el.clientHeight });
      setTimeout(() => shell.current?.classList.remove('instant'), 60);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const collapsed = floating && chatCollapsed;
  const full = floating && chatFull && !collapsed;
  const halves = floating && chatSplit && !collapsed && !full;
  const mode: ChatMode = full ? 'full' : chatSplit ? 'split' : 'float';
  const maxW = box.w - 2 * MARGIN;
  const maxH = box.h - 2 * MARGIN;
  let geo: { left: number; top: number; width: number; height: number };
  if (!floating || full) geo = { left: 0, top: 0, width: box.w, height: box.h };
  else if (halves) {
    const width = Math.round(Math.min(Math.max(box.w * chatFrac, MIN_W), Math.max(MIN_W, box.w - CENTER_MIN + 80)));
    geo = { width, height: box.h, top: 0, left: side === 'right' ? box.w - width : 0 };
  } else {
    const width = Math.max(collapsed ? Math.min(300, maxW) : Math.min(Math.max(size?.w ?? 460, MIN_W), maxW), 0);
    const height = Math.max(collapsed ? 48 : Math.min(Math.max(size?.h ?? Math.min(Math.round(box.h * 0.7), 680), MIN_H), maxH), 0);
    geo = { width, height, top: box.h - height - MARGIN, left: side === 'right' ? box.w - width - MARGIN : MARGIN };
  }

  /** Drag the floating chat by its header; on release it docks to the nearer bottom corner. A plain click on the
   * pill's header opens it. */
  const startDrag = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!floating || full || e.button !== 0 || !t.closest('.chat-head') || t.closest('button, select, input, textarea')) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let over = false;
    // the note's Comments panel: the floating chat can dock over it (release with the pointer on it) or beside it
    const reviews = !halves ? center.current?.querySelector('.with-reviews .reviews')?.getBoundingClientRect() : undefined;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      setDrag({ dx, dy });
      const now = !!reviews && ev.clientX >= reviews.left && ev.clientX <= reviews.right && ev.clientY >= reviews.top && ev.clientY <= reviews.bottom;
      if (now !== over) { over = now; setDragOverReviews(now); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        if (collapsed) setChatCollapsed(false);
        return;
      }
      const r = shell.current!.getBoundingClientRect();
      const c = center.current!.getBoundingClientRect();
      const next: Side = over ? 'right' : r.left + r.width / 2 < c.left + c.width / 2 ? 'left' : 'right';
      setSide(next);
      setPref('chatSide', next);
      if (reviews) { setOverReviews(over); setPref('chatOverReviews', over ? '1' : '0'); }
      setDragOverReviews(false);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Resize from the inner top corner/edges. `sx`: +1 when the handle is on the right edge, -1 on the left, 0 none;
   * `sy`: -1 for the top edge (the chat stays anchored to the bottom). */
  const startResize = (sx: number, sy: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = geo.width;
    const h0 = geo.height;
    let last = { w: w0, h: h0 };
    setResizing(true);
    const move = (ev: PointerEvent) => {
      last = {
        w: Math.round(Math.min(Math.max(w0 + sx * (ev.clientX - x0), MIN_W), maxW)),
        h: Math.round(Math.min(Math.max(h0 + sy * (ev.clientY - y0), MIN_H), maxH)),
      };
      setSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      setPref('chatSize', JSON.stringify(last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const inner = side === 'right' ? -1 : 1; // the inner side faces the middle of the screen

  const setMode = (m: ChatMode) => {
    setChatFull(m === 'full');
    if (m !== 'full') { setChatSplit(m === 'split'); setPref('chatSplit', m === 'split' ? '1' : '0'); }
    setChatCollapsed(false);
  };
  /** Side by side: drag the edge between the chat and the document. */
  const startChatSplitDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const c = center.current?.getBoundingClientRect();
    if (!c) return;
    let last = chatFrac;
    setChatSizing(true);
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => {
      const x = (ev.clientX - c.left) / c.width;
      last = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, side === 'right' ? 1 - x : x));
      setChatFrac(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
      setChatSizing(false);
      setPref('chatSplitFrac', String(last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const halfAndHalf = () => { setChatFrac(0.5); setPref('chatSplitFrac', '0.5'); };

  return {
    chatCollapsed, setChatCollapsed, chatSplit, collapsed, full, halves, mode, geo, side, inner, box, drag, resizing, chatSizing,
    overReviews, dragOverReviews, startDrag, startResize, setMode, startChatSplitDrag, halfAndHalf,
  };
}
