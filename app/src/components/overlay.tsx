/* App-wide context menus and dialogs. (Electron has no window.prompt, so all text input goes through here.) */
import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface PromptOpts { title: string; label?: string; initial?: string; placeholder?: string; confirmText?: string }
interface ConfirmOpts { title: string; body?: ReactNode; confirmText?: string; danger?: boolean }

interface Overlay {
  /** Opens at the pointer, or attached to `opts.anchor` (above or below it) so it doesn't move with the mouse. */
  menu: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[],
    opts?: { anchor?: Element | null; place?: 'above' | 'below' }) => void;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<Overlay | null>(null);
export const useOverlay = () => useContext(Ctx)!;

type Dialog =
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void };

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: DOMRect; place?: 'above' | 'below' } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const api: Overlay = {
    menu: useCallback((e, items, opts) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = opts?.anchor?.getBoundingClientRect();
      setMenu({ x: e.clientX, y: e.clientY, items, anchor, place: opts?.place });
    }, []),
    prompt: useCallback((opts) => new Promise((resolve) => setDialog({ kind: 'prompt', opts, resolve })), []),
    confirm: useCallback((opts) => new Promise((resolve) => setDialog({ kind: 'confirm', opts, resolve })), []),
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && <ContextMenu {...menu} />}
      {dialog?.kind === 'prompt' && (
        <PromptDialog opts={dialog.opts} done={(v) => { dialog.resolve(v); setDialog(null); }} />
      )}
      {dialog?.kind === 'confirm' && (
        <Modal title={dialog.opts.title} onClose={() => { dialog.resolve(false); setDialog(null); }}
          footer={<>
            <button className="btn" onClick={() => { dialog.resolve(false); setDialog(null); }}>Cancel</button>
            <button autoFocus className={`btn ${dialog.opts.danger ? 'btn-danger-solid' : 'btn-primary'}`}
              onClick={() => { dialog.resolve(true); setDialog(null); }}>{dialog.opts.confirmText ?? 'OK'}</button>
          </>}>
          {dialog.opts.body && <div className="muted">{dialog.opts.body}</div>}
        </Modal>
      )}
    </Ctx.Provider>
  );
}

function ContextMenu({ x, y, items, anchor, place }: { x: number; y: number; items: MenuItem[]; anchor?: DOMRect; place?: 'above' | 'below' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    if (anchor) {
      const above = place === 'above' ? anchor.top - r.height - 6 >= 8 : anchor.bottom + r.height + 6 > window.innerHeight - 8;
      setPos({ x: Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)), y: above ? anchor.top - r.height - 6 : anchor.bottom + 6 });
    } else setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y, anchor, place]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="ctx-sep" />}
          <button className={`ctx-item${it.danger ? ' danger' : ''}`} disabled={it.disabled}
            onClick={() => { window.dispatchEvent(new Event('click')); it.onClick(); }}>
            {it.label}
          </button>
        </div>
      ))}
    </div>
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
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
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
