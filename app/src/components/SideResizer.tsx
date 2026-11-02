import { useRef, useState } from 'react';

export interface SidePanel { width: number; open: boolean }
export interface SideLimits { def: number; min: number; max: number }

/** Drag handle on a workspace sidebar's inner edge. Drag to resize; dragging well past the minimum folds the
 * sidebar away, and a click on the handle of a folded one brings it back. Double-click resets the width; arrow keys
 * nudge it. `room` is the most the sidebar may take without squeezing the centre. */
export default function SideResizer({ side, panel, limits, room, onChange, onCommit, onSizing }: {
  side: 'left' | 'right'; panel: SidePanel; limits: SideLimits; room: () => number;
  onChange: (p: SidePanel) => void; onCommit: (p: SidePanel) => void; onSizing: (on: boolean) => void;
}) {
  const [active, setActive] = useState(false);
  const lastClick = useRef(0); // pointerdown's preventDefault swallows dblclick, so double-clicks are timed here
  const dir = side === 'left' ? 1 : -1;
  const clamp = (w: number) => Math.round(Math.max(limits.min, Math.min(w, limits.max, room())));

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = panel.open ? panel.width : 0;
    let last = panel;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * dir;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; setActive(true); onSizing(true); document.body.classList.add('col-resizing'); }
      const w = w0 + dx;
      last = w < limits.min - 70 ? { width: panel.width, open: false } : { width: clamp(w), open: true };
      onChange(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
      setActive(false);
      onSizing(false);
      if (!moved) {
        const dbl = Date.now() - lastClick.current < 400;
        lastClick.current = dbl ? 0 : Date.now();
        last = dbl ? { width: limits.def, open: true } : panel.open ? panel : { ...panel, open: true };
      }
      onCommit(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const key = (e: React.KeyboardEvent) => {
    const step = (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0) * dir * (e.shiftKey ? 48 : 16);
    if (step) { e.preventDefault(); onCommit({ width: clamp(panel.width + step), open: true }); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCommit({ ...panel, open: !panel.open }); }
  };

  const name = side === 'left' ? 'Generated' : 'Resources';
  return (
    <div className={`side-resizer side-resizer-${side}${active ? ' active' : ''}${panel.open ? '' : ' folded'}`}
      role="separator" aria-orientation="vertical" aria-label={`Resize ${name} sidebar`} tabIndex={0}
      aria-valuenow={panel.open ? panel.width : 0} aria-valuemin={0} aria-valuemax={limits.max}
      data-tip={panel.open ? `Drag to resize ${name} · double-click to reset` : `Show ${name}`} data-tip-side={side === 'left' ? 'right' : 'left'}
      onPointerDown={down} onKeyDown={key}>
      <span className="side-grip" aria-hidden />
      {!panel.open && <span className="side-unfold" aria-hidden>{side === 'left' ? '›' : '‹'}</span>}
    </div>
  );
}
