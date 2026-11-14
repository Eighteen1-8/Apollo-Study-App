/* App-wide context menus and dialogs. (Electron has no window.prompt, so all text input goes through here.)
   Menus are drawn over everything (portalled), never leave the window, and scroll when taller than it; submenus are
   placed beside their row in window coordinates so a scrolling menu can't clip them. */
import { createPortal, flushSync } from 'react-dom';
import { createContext, CSSProperties, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import ErrorText from './ErrorText';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Shown faintly on the right, e.g. a keyboard shortcut. */
  hint?: string;
  /** A colour dot before the label: a highlight colour name (yellow, green, blue, pink, orange) or a CSS colour. */
  swatch?: string;
  /** A small heading row (not clickable) for grouping, e.g. what was right-clicked. */
  header?: boolean;
  /** A submenu, opened on hover or click. */
  children?: MenuItem[];
  /** One row of clickable colour dots (highlight colours) after the label, instead of a submenu. */
  swatches?: { color: string; label: string; active?: boolean; onClick: () => void; kind?: 'none' | 'custom' }[];
}

interface PromptOpts { title: string; label?: string; initial?: string; placeholder?: string; confirmText?: string }
interface ConfirmOpts { title: string; body?: ReactNode; confirmText?: string; danger?: boolean }
interface ColorOpts { title: string; initial?: string; presets?: string[] }

interface Overlay {
  /** Opens at the pointer, or attached to `opts.anchor` (above or below it) so it doesn't move with the mouse. */
  menu: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[],
    opts?: { anchor?: Element | null; place?: 'above' | 'below' }) => void;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  /** A colour picker (custom highlight colours): resolves to a #rrggbb colour, or null. */
  color: (opts: ColorOpts) => Promise<string | null>;
}

const Ctx = createContext<Overlay | null>(null);
export const useOverlay = () => useContext(Ctx)!;

type Dialog =
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'color'; opts: ColorOpts; resolve: (v: string | null) => void };

/** CSS colour for a swatch: named highlight colours map to the app's highlight palette. */
export const SWATCH_CSS: Record<string, string> = {
  yellow: '#fde047', green: '#86efac', blue: '#93c5fd', pink: '#f9a8d4', orange: '#fdba74', purple: '#c4b5fd',
};
const swatchCss = (c: string) => SWATCH_CSS[c] ?? c;

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: DOMRect; place?: 'above' | 'below'; key: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const api: Overlay = {
    menu: useCallback((e, items, opts) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = opts?.anchor?.getBoundingClientRect();
      setMenu({ x: e.clientX, y: e.clientY, items, anchor, place: opts?.place, key: Date.now() });
    }, []),
    prompt: useCallback((opts) => new Promise((resolve) => setDialog({ kind: 'prompt', opts, resolve })), []),
    confirm: useCallback((opts) => new Promise((resolve) => setDialog({ kind: 'confirm', opts, resolve })), []),
    color: useCallback((opts) => new Promise((resolve) => setDialog({ kind: 'color', opts, resolve })), []),
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (menuKey(e, close)) { e.preventDefault(); e.stopPropagation(); } };
    // a scroll inside the menu itself doesn't close it; scrolling the page does
    const scroll = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.ctx-menu'))) close(); };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [menu]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && createPortal(<ContextMenu key={menu.key} x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} place={menu.place} />, document.body)}
      {dialog?.kind === 'prompt' && (
        <PromptDialog opts={dialog.opts} done={(v) => { dialog.resolve(v); setDialog(null); }} />
      )}
      {dialog?.kind === 'color' && (
        <ColorDialog opts={dialog.opts} done={(v) => { dialog.resolve(v); setDialog(null); }} />
      )}
      {dialog?.kind === 'confirm' && (
        <Modal title={dialog.opts.title} onClose={() => { dialog.resolve(false); setDialog(null); }}
          footer={<>
            <button className="btn" onClick={() => { dialog.resolve(false); setDialog(null); }}>Cancel</button>
            <button autoFocus className={`btn ${dialog.opts.danger ? 'btn-danger-solid' : 'btn-primary'}`}
              onClick={() => { dialog.resolve(true); setDialog(null); }}>{dialog.opts.confirmText ?? 'OK'}</button>
          </>}>
          {dialog.opts.body && <div className="muted">{typeof dialog.opts.body === 'string' ? <ErrorText text={dialog.opts.body} /> : dialog.opts.body}</div>}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

const EDGE = 8;
/** Set around the click that ArrowRight makes on a submenu row, so the submenu it opens focuses its first item. */
let focusNextSub = false;

function ContextMenu({ x, y, items, anchor, place }: { x: number; y: number; items: MenuItem[]; anchor?: DOMRect; place?: 'above' | 'below' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; maxH?: number }>({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const H = window.innerHeight;
    const W = window.innerWidth;
    const h = Math.min(r.height, H - 2 * EDGE); // taller than the window: it scrolls
    const left = Math.max(EDGE, Math.min(anchor ? anchor.left : x, W - r.width - EDGE));
    let top: number;
    if (anchor) {
      const roomAbove = anchor.top - 6 - EDGE;
      const roomBelow = H - anchor.bottom - 6 - EDGE;
      const above = place === 'above' ? roomAbove >= h || roomAbove > roomBelow : roomBelow < h && roomAbove > roomBelow;
      top = above ? anchor.top - 6 - Math.min(h, roomAbove) : anchor.bottom + 6;
      const maxH = Math.max(120, above ? roomAbove : roomBelow);
      setPos({ x: left, y: Math.max(EDGE, top), maxH: Math.min(maxH, H - 2 * EDGE) });
      return;
    }
    top = Math.max(EDGE, Math.min(y, H - h - EDGE));
    setPos({ x: left, y: top, maxH: H - 2 * EDGE });
  }, [x, y, anchor, place]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y, maxHeight: pos.maxH }} onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}>
      <MenuItems items={items} />
    </div>
  );
}

/** Keyboard use of the open menu (window capture phase, so nothing under the menu sees these keys): Up/Down/Home/End
 * move between items, Enter (the focused button's own) runs one, Right opens a submenu and Left closes it, Escape
 * closes the whole menu. Other keys are left alone and don't close it. Returns true when the key was used. */
function menuKey(e: KeyboardEvent, close: () => void): boolean {
  if (e.key === 'Escape') { close(); return true; }
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return false;
  const menus = [...document.querySelectorAll<HTMLElement>('.ctx-menu')]; // the root first, open submenus after it
  if (!menus.length) return false;
  const focused = document.activeElement as HTMLElement | null;
  // the menu holding the focus, else the innermost open one
  const menu = menus.find((m) => m.contains(focused)) ?? menus[menus.length - 1];
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const at = focused ? buttons.indexOf(focused as HTMLButtonElement) : -1;
  const focus = (b?: HTMLElement | null) => b?.focus();
  if (e.key === 'ArrowDown') focus(buttons[at < 0 ? 0 : (at + 1) % buttons.length]);
  else if (e.key === 'ArrowUp') focus(buttons[at < 0 ? buttons.length - 1 : (at - 1 + buttons.length) % buttons.length]);
  else if (e.key === 'Home') focus(buttons[0]);
  else if (e.key === 'End') focus(buttons[buttons.length - 1]);
  else if (e.key === 'ArrowRight') {
    const b = buttons[at];
    if (b?.classList.contains('has-sub')) {
      // the submenu focuses its own first item in its layout effect (right after the click's render), so keys that
      // follow are already directed at it; if it was open already, focus it now
      const subs = document.querySelectorAll<HTMLElement>('.ctx-sub');
      if (b.classList.contains('sub-open') && subs.length) focus(subs[subs.length - 1].querySelector<HTMLButtonElement>('button:not(:disabled)'));
      else {
        focusNextSub = true;
        flushSync(() => b.click());
        focusNextSub = false;
      }
    } else if (b?.classList.contains('ctx-dot')) focus(buttons[at + 1]);
  } else if (e.key === 'ArrowLeft') {
    const b = buttons[at];
    if (b?.classList.contains('ctx-dot') && buttons[at - 1]?.classList.contains('ctx-dot')) focus(buttons[at - 1]);
    else if (menu.classList.contains('ctx-sub')) {
      const parent = menus[menus.indexOf(menu) - 1];
      const row = parent?.querySelector<HTMLButtonElement>('.sub-open');
      row?.click(); // toggles the submenu shut
      focus(row);
    }
  }
  return true;
}

function MenuItems({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const timer = useRef<number>();
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const hover = (i: number | null) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(i), 120); };
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = (fn: () => void) => { window.dispatchEvent(new Event('click')); fn(); };
  return (
    <>
      {items.map((it, i) => (
        <div key={i} ref={(el) => { rows.current[i] = el; }} className="ctx-row" onMouseEnter={() => hover(it.children ? i : null)}>
          {it.separatorBefore && <div className="ctx-sep" />}
          {it.header ? <div className="ctx-header">{it.label}</div> : it.swatches ? (
            <div className="ctx-swatch-row" role="group" aria-label={it.label}>
              <span className="ctx-label">{it.label}</span>
              <span className="ctx-dots">
                {it.swatches.map((s) => (
                  <button key={s.label} className={`ctx-dot${s.active ? ' active' : ''}${s.kind ? ` dot-${s.kind}` : ''}`} data-tip={s.label}
                    aria-label={s.label} style={s.kind ? undefined : { background: swatchCss(s.color) }} onClick={() => run(s.onClick)}>
                    {s.kind === 'custom' ? '+' : null}
                  </button>
                ))}
              </span>
            </div>
          ) : (
            <button className={`ctx-item${it.danger ? ' danger' : ''}${it.children ? ' has-sub' : ''}${open === i ? ' sub-open' : ''}`}
              disabled={it.disabled || (!it.onClick && !it.children?.length)}
              onClick={() => {
                if (it.children) { clearTimeout(timer.current); setOpen(open === i ? null : i); return; }
                if (it.onClick) run(it.onClick);
              }}>
              {it.swatch && <span className="ctx-swatch" style={{ background: swatchCss(it.swatch) }} />}
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
              {it.children && <span className="ctx-arrow"><Icon name="chevronRight" size={14} /></span>}
            </button>
          )}
          {it.children && open === i && <SubMenu items={it.children} row={rows.current[i]} onEnter={() => hover(i)} />}
        </div>
      ))}
    </>
  );
}

/** A submenu beside its row (window coordinates), flipped left or up when it would leave the window. Portalled to
 * the body: inside its parent, whose backdrop-filter and transform make it the containing block for `position:fixed`
 * and whose scrolling clips it, it was placed wrongly and cut off. The pointer moving onto it counts as staying on its
 * row (`onEnter`), it follows the parent when that scrolls, and it closes with the parent (it is the parent's child in
 * React). */
function SubMenu({ items, row, onEnter }: { items: MenuItem[]; row: HTMLDivElement | null; onEnter: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      const rr = row?.getBoundingClientRect();
      if (!el || !rr) return;
      const r = el.getBoundingClientRect();
      const H = window.innerHeight;
      const h = Math.min(r.height, H - 2 * EDGE);
      const left = rr.right + r.width + 4 > window.innerWidth ? Math.max(EDGE, rr.left - r.width - 2) : rr.right + 2;
      const top = Math.max(EDGE, Math.min(rr.top - 5, H - h - EDGE));
      setStyle({ left, top, maxHeight: H - 2 * EDGE });
    };
    place();
    const parent = row?.closest('.ctx-menu');
    parent?.addEventListener('scroll', place);
    return () => parent?.removeEventListener('scroll', place);
  }, [row]);
  // opened with ArrowRight: take the focus as soon as it is placed (a hidden element can't be focused), before any
  // later key is handled
  const takeFocus = useRef(focusNextSub);
  useLayoutEffect(() => {
    if (!takeFocus.current || style.visibility === 'hidden') return;
    takeFocus.current = false;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [style]);
  return createPortal(
    <div ref={ref} className="ctx-menu ctx-sub" style={style} onClick={(e) => e.stopPropagation()} onMouseEnter={onEnter}
      onContextMenu={(e) => e.preventDefault()}>
      <MenuItems items={items} />
    </div>,
    document.body,
  );
}

export function Modal({ title, children, footer, onClose, wide }: {
  title: ReactNode; children?: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // portalled: a modal opened from a sidebar would otherwise be positioned and clipped by that panel
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function PromptDialog({ opts, done }: { opts: PromptOpts; done: (v: string | null) => void }) {
  const [v, setV] = useState(opts.initial ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const ok = () => v.trim() && done(v.trim());
  return (
    <Modal title={opts.title} onClose={() => done(null)}
      footer={<>
        <button className="btn" onClick={() => done(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={!v.trim()} onClick={ok}>{opts.confirmText ?? 'Save'}</button>
      </>}>
      {opts.label && <div className="field-label">{opts.label}</div>}
      <input ref={ref} className="input input-full" value={v} placeholder={opts.placeholder}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} />
    </Modal>
  );
}

const CUSTOM_PRESETS = ['#fde047', '#fdba74', '#fca5a5', '#f9a8d4', '#c4b5fd', '#93c5fd', '#67e8f9', '#86efac', '#bef264', '#d6d3d1'];

function ColorDialog({ opts, done }: { opts: ColorOpts; done: (v: string | null) => void }) {
  const [c, setC] = useState(opts.initial && /^#[0-9a-f]{6}$/i.test(opts.initial) ? opts.initial : '#fde047');
  const [hex, setHex] = useState(c);
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  return (
    <Modal title={opts.title} onClose={() => done(null)}
      footer={<>
        <button className="btn" onClick={() => done(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => done(hex.toLowerCase())}>Use colour</button>
      </>}>
      <div className="color-pick">
        <span className="color-pick-preview"><mark style={{ background: valid ? hex : c }}>Highlighted text</mark></span>
        <div className="swatches">
          {(opts.presets ?? CUSTOM_PRESETS).map((p) => (
            <button key={p} className={`swatch${p === c ? ' active' : ''}`} style={{ background: p }} aria-label={p}
              onClick={() => { setC(p); setHex(p); }} />
          ))}
          <label className="swatch swatch-custom" title="Any colour">
            <input type="color" value={valid ? hex : c} onChange={(e) => { setC(e.target.value); setHex(e.target.value); }} />+
          </label>
        </div>
        <input className="input color-hex" value={hex} spellCheck={false} aria-label="Hex colour"
          onChange={(e) => { setHex(e.target.value.trim()); if (/^#[0-9a-f]{6}$/i.test(e.target.value.trim())) setC(e.target.value.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) done(hex.toLowerCase()); }} />
      </div>
    </Modal>
  );
}
