/* Text put into the open chat's composer from outside the chat (the calculator's "Send to chat"). The chat that's
   showing registers itself (ChatView, `registerComposer`; the latest registered wins), and anything can then add
   editable text to its box (`sendToComposer`): nothing is sent to Apollo until the student presses Enter. */
import { useSyncExternalStore } from 'react';

type Put = (text: string) => void;
const targets: Put[] = [];
const listeners = new Set<() => void>();
const sub = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const current = (): Put | null => (targets.length ? targets[targets.length - 1] : null);

/** The chat offers its composer (returns the unregister). */
export function registerComposer(fn: Put): () => void {
  targets.push(fn);
  listeners.forEach((f) => f());
  return () => {
    const k = targets.lastIndexOf(fn);
    if (k >= 0) targets.splice(k, 1);
    listeners.forEach((f) => f());
  };
}

/** Whether a chat is there to take text (re-renders when one comes or goes). */
export function useComposerReady(): boolean {
  return useSyncExternalStore(sub, () => current() !== null);
}

/** Put text in the open chat's box (after what's already typed). False when no chat is open. */
export function sendToComposer(text: string): boolean {
  const put = current();
  if (!put || !text.trim()) return false;
  put(text);
  return true;
}

/** What's already typed, then the new text on its own line(s). */
export function appendDraft(typed: string, text: string): string {
  const t = typed.replace(/\s+$/, '');
  return t ? `${t}\n${text}` : text;
}
