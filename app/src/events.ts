import { authUrl, BASE } from './api';

/** What changed on the backend (backend events.py): panels reload when their topic changes instead of polling. */
export type Topic = 'jobs' | 'documents' | 'subjects' | 'library' | 'todos' | 'flags' | 'pause';

const listeners = new Map<Topic, Set<() => void>>();
let source: EventSource | null = null;
let connected = false;

function connect() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(authUrl(`${BASE}/events`));
  source.onmessage = (e) => {
    let topics: Topic[] = [];
    try { topics = JSON.parse(e.data); } catch { return; }
    for (const t of topics) listeners.get(t)?.forEach((fn) => fn());
  };
  // after a dropped connection (backend restart) anything may have changed: everyone reloads once
  source.onopen = () => {
    if (connected) listeners.forEach((set) => set.forEach((fn) => fn()));
    connected = true;
  };
}

/** Call `fn` whenever any of `topics` changes. Returns the unsubscribe function. */
export function onChange(topics: Topic[], fn: () => void) {
  connect();
  for (const t of topics) {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  }
  return () => topics.forEach((t) => listeners.get(t)?.delete(fn));
}

/** Whether the change stream is up (polling falls back to a slow interval either way). */
export const streamOpen = () => source?.readyState === EventSource.OPEN;
