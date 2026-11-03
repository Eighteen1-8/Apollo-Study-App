import { api } from './api';

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

/** Uncaught errors anywhere in the page go to the log too. */
export function installGlobalErrorLogging() {
  window.addEventListener('error', (e) => logError('window', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => logError('promise', e.reason));
}
