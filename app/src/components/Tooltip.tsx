import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/* One styled tooltip for the whole app, drawn in a fixed layer so panes with overflow: hidden never clip it.
   Text comes from the nearest hovered element's `data-tip`, its `title` (moved to `data-tip-title` so the native
   tooltip doesn't show as well), an icon button's `aria-label`, or, for text cut off with an ellipsis, the text
   itself. `data-tip-side="right|left|bottom"` picks a side; minibar tips go to the right. Beside a tall element the tip sits
   level with the pointer. */

const SHOW_DELAY = 380;
const WARM_MS = 400; // moving between tips shortly after one closed shows the next at once

type Side = 'top' | 'bottom' | 'right' | 'left';
type Tip = { text: string; x: number; y: number; side: Side; key: number };

function truncated(el: HTMLElement) {
  return el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis';
}

/** The element whose tip applies to `start`, and that tip's text. */
function findTip(start: Element | null): [HTMLElement, string] | null {
  for (let el = start as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title') ?? '';
      el.removeAttribute('title');
      if (t) el.dataset.tipTitle = t; else delete el.dataset.tipTitle;
    }
    if (el.dataset.tipOff !== undefined) return null;
    const text = el.dataset.tip || el.dataset.tipTitle
      || ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && !el.textContent?.trim() ? el.getAttribute('aria-label') : '')
      || (truncated(el) ? el.textContent?.trim() : '');
    if (text) return [el, text];
  }
  return null;
}

let pointerY = 0;

function place(el: HTMLElement): Omit<Tip, 'text' | 'key'> {
  const r = el.getBoundingClientRect();
  const want = el.dataset.tipSide as Side | undefined;
  const y = r.height > 120 ? Math.min(Math.max(pointerY, r.top + 12), r.bottom - 12) : r.top + r.height / 2;
  if (want === 'right' || (!want && el.closest('.minibar'))) return { side: 'right', x: r.right + 10, y };
  if (want === 'left') return { side: 'left', x: r.left - 10, y };
  if (want === 'bottom' || r.top < 44) return { side: 'bottom', x: r.left + r.width / 2, y: r.bottom + 8 };
  return { side: 'top', x: r.left + r.width / 2, y: r.top - 8 };
}

export default function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let timer = 0;
    let poll = 0;
    let closedAt = 0;
    let key = 0;

    const hide = () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      if (anchor) closedAt = Date.now();
      anchor = null;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      const found = findTip(el);
      if (!found || found[0] !== el || !el.isConnected) return hide();
      setTip({ text: found[1], ...place(el), key: ++key });
      // live tips (job progress) and elements that move keep the tip current
      window.clearInterval(poll);
      poll = window.setInterval(() => {
        if (!el.isConnected) return hide();
        const f = findTip(el);
        if (!f || f[0] !== el) return hide();
        setTip((t) => (t ? { ...t, text: f[1], ...place(el) } : t));
      }, 500);
    };
    const over = (e: PointerEvent) => {
      pointerY = e.clientY;
      if (e.pointerType === 'touch' || document.body.classList.contains('col-resizing')) return;
      const found = findTip(e.target as Element);
      const el = found?.[0] ?? null;
      if (el === anchor) return;
      hide();
      if (!el) return;
      anchor = el;
      const warm = Date.now() - closedAt < WARM_MS;
      timer = window.setTimeout(() => anchor === el && show(el), warm ? 0 : SHOW_DELAY);
    };
    const out = (e: PointerEvent) => {
      if (anchor && !(e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget))) hide();
    };
    const blur = () => hide();
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', blur, true);
    document.addEventListener('keydown', blur, true);
    document.addEventListener('wheel', blur, { capture: true, passive: true });
    window.addEventListener('blur', blur);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', blur, true);
      document.removeEventListener('keydown', blur, true);
      document.removeEventListener('wheel', blur, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // keep the bubble inside the window
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.marginLeft = '0px';
    if (tip?.side === 'left' || tip?.side === 'right') return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const dx = r.left < pad ? pad - r.left : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0;
    el.style.marginLeft = `${dx}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} key={tip.key} className={`tooltip tooltip-${tip.side}`} role="tooltip"
      style={tip.side === 'left' ? { right: window.innerWidth - tip.x, top: tip.y } : { left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
}
