/* Small notices at the bottom of the window ("Chat deleted · Undo"). They go away by themselves. */
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

interface Toast { id: number; text: string; action?: { label: string; run: () => unknown } }

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function toast(text: string, action?: Toast['action'], ms = 6000) {
  const t = { id: Date.now() + Math.random(), text, action };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => dismiss(t.id), ms);
}
const dismiss = (id: number) => { toasts = toasts.filter((t) => t.id !== id); emit(); };

export function ToastLayer() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  if (!list.length) return null;
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-text">{t.text}</span>
          {t.action && <button className="toast-action" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
          <button className="x-btn toast-x" title="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
