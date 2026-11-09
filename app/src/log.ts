import { api } from './api';
import { ApiError } from './errors';
import { toast } from './components/toast';

/** Report an error the UI handles quietly (a background save, a panel that failed to load) to the backend log
 * (<data>/logs/backend.log, logger studyapp.ui), so it can still be traced. At most 20 reports a minute. */
let sent: number[] = [];
export function logError(where: string, e: unknown, level: 'error' | 'warning' = 'error') {
  const err = e instanceof Error ? e : new Error(String(e));
  console.warn(`[${where}]`, err);
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= 20) return;
  sent.push(now);
  api.clientLog({ level, where, message: err.message, stack: err.stack ?? '' }).catch(() => { /* backend down: console only */ });
}

/** Uncaught errors anywhere in the page go to the log too. A failed request nothing else handled (a button whose
 * action threw) is also shown, with its code, instead of failing silently; the same message at most every 5 s. */
let lastShown = { text: '', at: 0 };
export function installGlobalErrorLogging() {
  window.addEventListener('error', (e) => logError('window', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => {
    logError('promise', e.reason);
    if (!(e.reason instanceof ApiError)) return;
    const text = e.reason.message;
    if (text === lastShown.text && Date.now() - lastShown.at < 5000) return;
    lastShown = { text, at: Date.now() };
    toast(text, undefined, 9000);
  });
}
