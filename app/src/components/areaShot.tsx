/* Right-drag over generated content (notes, cheat sheets, mind maps, the student's notes) to box an area; the
   right-click menu that follows offers it as a screenshot for the chat or the clipboard. Electron captures exactly
   what's on screen (backend documents use their own page renders instead: SourceView). */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useOverlay, type MenuItem } from './overlay';
import { addToNotes, pointAt } from './addToNotes';
import { imageHtml } from '../noteInsert';

type Box = { x: number; y: number; w: number; h: number };

/** `notes`: the screenshot can also go into the student's notes ("Add to my notes", noteInsert.ts), with `source` as
 * its source line. */
export function useAreaShot(name: string, onAttach: (paths: string[]) => void, onError: (msg: string) => void,
  notes?: { subjectId: number; source: string }) {
  const ov = useOverlay();
  const [drag, setDrag] = useState<Box | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const fresh = useRef<Box | null>(null); // the box the next context menu is about

  useEffect(() => {
    if (!box) return;
    const clear = (e: PointerEvent) => { if (e.button === 0) setTimeout(() => setBox(null), 0); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setBox(null);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', clear, true); window.removeEventListener('keydown', key); };
  }, [box]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let last: Box = { x: x0, y: y0, w: 0, h: 0 };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      moved = true;
      last = { x: Math.min(x0, ev.clientX), y: Math.min(y0, ev.clientY), w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) };
      setDrag(last);
      window.getSelection()?.removeAllRanges();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!moved || last.w < 10 || last.h < 10) return;
      fresh.current = last;
      setBox(last);
      setTimeout(() => { fresh.current = null; }, 500);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const capture = async (b: Box) => {
    setBox(null);
    // let the outline disappear before the window is captured
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.studyApp!.capture!({ x: b.x, y: b.y, width: b.w, height: b.h });
  };
  const run = (fn: () => Promise<void>) => () => { fn().catch((e) => onError(String(e).replace(/^Error: /, ''))); };

  /** Menu items for the box just drawn (call from onContextMenu; empty when the right-click wasn't a drag). */
  const takeMenu = (): MenuItem[] | null => {
    const b = fresh.current;
    fresh.current = null;
    if (!b) return null;
    const can = !!window.studyApp?.capture;
    return [
      { label: 'Send to chat as a screenshot', disabled: !can, onClick: run(async () => {
        const png = await capture(b);
        const saved = await api.saveChatImage(png, `${name} selection`);
        onAttach([saved.path]);
      }) },
      ...(notes ? [{ label: 'Add to my notes…', disabled: !can, onClick: () => {
        addToNotes(async () => imageHtml(`data:image/png;base64,${await capture(b)}`, notes.source),
          { subjectId: notes.subjectId, ov, at: pointAt(null, b.x + b.w, b.y + b.h) });
      } }] : []),
      { label: 'Copy screenshot', disabled: !can, onClick: run(async () => { await window.studyApp!.copyImage!(await capture(b)); }) },
      ...(can ? [] : [{ label: 'Screenshots work in the desktop app', disabled: true, onClick: () => {} }]),
      { label: 'Clear selection', separatorBefore: true, onClick: () => setBox(null) },
    ];
  };

  const shown = drag ?? box;
  const overlay = shown ? createPortal(
    <div className={`shot-box${drag ? ' dragging' : ''}`} style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }} />,
    document.body,
  ) : null;

  return { onPointerDown, takeMenu, overlay };
}
