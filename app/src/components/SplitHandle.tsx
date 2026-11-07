import { useRef, useState } from 'react';
import { getPref, setPref } from '../prefs';

/** Height of one section of a sidebar (the chat list, my notes) as a share of the sidebar, saved per machine.
 * `null` until the student drags it: the section keeps its CSS default. */
export function useSplit(key: string) {
  const [frac, setFrac] = useState<number | null>(() => getPref<number | null>(key, null, (v) => (Number(v) > 0 ? Number(v) : null)));
  const save = (f: number | null) => { setFrac(f); setPref(key, f === null ? '' : String(f)); };
  /** Inline style for the section: a fixed share of the sidebar, overriding its default max-height. */
  const style = frac === null ? undefined : { height: `${(frac * 100).toFixed(2)}%`, maxHeight: 'none', flexShrink: 0 };
  return { frac, setFrac, save, style };
}

/** A horizontal grip between two sidebar sections. `section` finds the element whose height it sets; `edge` says
 * whether the grip sits below that section (dragging down grows it) or above it (dragging down shrinks it).
 * Double-click puts the default back. */
export default function SplitHandle({ split, section, edge, label, min = 0.1, max = 0.8 }: {
  split: ReturnType<typeof useSplit>; section: () => HTMLElement | null | undefined; edge: 'below' | 'above'; label: string;
  min?: number; max?: number;
}) {
  const [active, setActive] = useState(false);
  const lastClick = useRef(0);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = section();
    const parent = el?.parentElement;
    if (!el || !parent) return;
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = el.getBoundingClientRect().height;
    const total = parent.getBoundingClientRect().height || 1;
    let last = split.frac;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dy = (ev.clientY - y0) * (edge === 'below' ? 1 : -1);
      if (!moved && Math.abs(dy) < 3) return;
      if (!moved) { moved = true; setActive(true); document.body.classList.add('row-resizing'); }
      last = Math.max(min, Math.min(max, (h0 + dy) / total));
      split.setFrac(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('row-resizing');
      setActive(false);
      if (!moved) {
        const dbl = Date.now() - lastClick.current < 400;
        lastClick.current = dbl ? 0 : Date.now();
        if (dbl) split.save(null);
        return;
      }
      split.save(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`split-handle${active ? ' active' : ''}`} role="separator" aria-orientation="horizontal" aria-label={`Resize ${label}`}
      data-tip={`Drag to resize ${label} · double-click to reset`} onPointerDown={down} onClick={(e) => e.stopPropagation()}>
      <span className="split-grip" aria-hidden />
    </div>
  );
}
