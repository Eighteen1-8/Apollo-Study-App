import { useCallback, useEffect, useRef, useState } from 'react';
import { onChange, Topic } from './events';

const FALLBACK_MS = 30000;

/** Load data, then reload it whenever one of `topics` changes on the backend (events.ts), with a fallback poll of at
 * least FALLBACK_MS in case the change stream drops. Without topics it polls every `ms` (0 = load once).
 * `reload()` refetches immediately. Reloads triggered by changes are spaced at least `ms` apart. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = [], topics?: Topic[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    setData(null);
    reload();
    if (!topics) {
      if (!ms) return;
      const t = setInterval(reload, ms);
      return () => clearInterval(t);
    }
    let last = 0;
    let pending: number | undefined;
    const soon = () => {  // coalesce bursts (a running job changes every second) into one reload per `ms`
      if (pending !== undefined) return;
      const wait = Math.max(0, last + ms - Date.now());
      pending = window.setTimeout(() => { pending = undefined; last = Date.now(); reload(); }, wait);
    };
    const off = onChange(topics, soon);
    const t = setInterval(reload, Math.max(ms, FALLBACK_MS));
    return () => { off(); clearInterval(t); if (pending !== undefined) clearTimeout(pending); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload };
}

export function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
