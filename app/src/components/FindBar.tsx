/* Ctrl+F and Ctrl+A inside the app's renderers (documents, notes, cheat sheets, the chat, exams).
   Each renderer marks its root with data-find="<what it is>". Ctrl+F opens a find bar over the renderer the student
   last clicked or typed in; Ctrl+A outside a text field selects that renderer's content instead of the whole window.
   Matches are painted with CSS Custom Highlights, so nothing in the rendered content changes.
   A renderer whose text isn't all in the page (a PDF draws its pages lazily) registers a find provider: it searches
   the whole text itself and brings a match's page in on demand. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findAll, paint } from './textRange';
import Icon from './Icon';
import { useFloating } from './floating';

let lastTarget: Element | null = null;

/** A match somewhere in a renderer's full text (not necessarily rendered yet). */
export interface FindHit { page: number; index: number }
export interface FindProvider {
  /** Every match of `q` (case-insensitive) in order. `partial` gets the matches found so far while a long search runs
   * (so the count can grow instead of waiting for the last page). */
  search: (q: string, partial?: (hits: FindHit[]) => void) => Promise<FindHit[]>;
  /** The find bar opened: start reading the text now, so the first search is quick. */
  warm?: () => void;
  /** Show the hit (render its page) and return its range, or null when it can't be found on the page. */
  reveal: (hit: FindHit, q: string) => Promise<Range | null>;
}
const providers = new WeakMap<Element, FindProvider>();
export function registerFind(root: Element, p: FindProvider) {
  providers.set(root, p);
  return () => { if (providers.get(root) === p) providers.delete(root); };
}

/** The renderer to act on: a fullscreen viewer first, then where the student last clicked or typed, then the first
 * renderer on screen. */
function activeScope(): HTMLElement | null {
  const fs = document.querySelector<HTMLElement>('.fullscreen [data-find]');
  if (fs) return fs;
  // inside a renderer, or in a pane that has one (the chat's message box searches the chat)
  const scopeOf = (el: Element | null) => (el?.isConnected
    ? el.closest<HTMLElement>('[data-find]') ?? el.closest('.chat, .source, .doc-pane')?.querySelector<HTMLElement>('[data-find]') ?? null
    : null);
  const active = document.activeElement !== document.body ? document.activeElement : null;
  return scopeOf(active) ?? scopeOf(lastTarget) ?? document.querySelector<HTMLElement>('[data-find]');
}

const editable = (el: Element | null) => !!el?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');

let requestFind: ((q: string) => void) | null = null;
/** Open the find bar on the document viewer with `q` filled in (after a search result opens a file). The viewer may
 * still be loading, so this waits for it a little. */
export function openFind(q: string) { requestFind?.(q); }

export default function FindLayer() {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [nonce, setNonce] = useState(0);
  const [initial, setInitial] = useState<string | undefined>(undefined);

  useEffect(() => {
    const down = (e: PointerEvent) => { lastTarget = e.target as Element; };
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        const s = activeScope();
        if (!s) return;
        e.preventDefault();
        setInitial(undefined);
        setScope(s);
        setNonce((n) => n + 1);
      } else if (k === 'a' && !editable(document.activeElement)) {
        const s = activeScope();
        if (!s || document.querySelector('.modal-backdrop')) return;
        e.preventDefault();
        const r = document.createRange();
        r.selectNodeContents(s);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    };
    let timer = 0;
    requestFind = (q) => {
      window.clearInterval(timer);
      const t0 = Date.now();
      let seen: Element | null = null;
      timer = window.setInterval(() => {
        const s = document.querySelector<HTMLElement>('.doc-pane .source-scroll[data-find]');
        // wait for the newly opened document (a different element, or its provider/pages ready)
        if (s && (s !== seen || Date.now() - t0 > 400) && (providers.has(s) || s.querySelector('[data-unit]'))) {
          window.clearInterval(timer);
          setInitial(q);
          setScope(s);
          setNonce((n) => n + 1);
        }
        seen = seen ?? s;
        if (Date.now() - t0 > 6000) window.clearInterval(timer);
      }, 150);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); requestFind = null; window.clearInterval(timer); };
  }, []);

  return scope ? <FindBar key={nonce} scope={scope} initial={initial} onClose={() => setScope(null)} /> : null;
}

function FindBar({ scope, initial, onClose }: { scope: HTMLElement; initial?: string; onClose: () => void }) {
  const [q, setQ] = useState(() => initial ?? window.getSelection()?.toString().trim().slice(0, 80) ?? '');
  const [hits, setHits] = useState<Range[]>([]);
  const [cur, setCur] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState(() => scope.getBoundingClientRect());
  const provider = providers.get(scope);
  // with a provider: every match in the whole text, and the current one's range once its page is shown
  const [all, setAll] = useState<FindHit[] | null>(null);
  const [current, setCurrent] = useState<Range | null>(null);
  // a provider's search is still running (the count shown so far can grow)
  const [partial, setPartial] = useState(false);

  useEffect(() => { input.current?.focus(); input.current?.select(); provider?.warm?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching file, note, page or subject replaces the content it searches: then it goes. (Content that has been
  // swapped out gets no more changes, so this is checked on a timer rather than by watching it.)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!scope.isConnected || !scope.getClientRects().length) onClose();
      else setBox((b) => { const n = scope.getBoundingClientRect(); return n.top === b.top && n.right === b.right ? b : n; });
    }, 250);
    return () => window.clearInterval(t);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // dragged by its grip; the offset from its usual corner is kept for the next time it opens (floating.tsx)
  const fl = useFloating<HTMLDivElement>('find', { onDragEnd: () => input.current?.focus() });
  const offset = fl.offset;

  // find again when the text changes underneath (a reply streaming in, a page of a PDF rendering)
  useEffect(() => {
    const run = () => {
      if (!scope.isConnected) { onClose(); return; }
      setBox(scope.getBoundingClientRect());
      setHits(findAll(scope, q.trim()));
    };
    run();
    // changes come in bursts (a page's text layer, a streamed reply): search once they pause, at most every 150 ms
    let timer = 0;
    const mo = new MutationObserver(() => { if (!timer) timer = window.setTimeout(() => { timer = 0; run(); }, 150); });
    mo.observe(scope, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); clearTimeout(timer); };
  }, [q, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!provider) return;
    setAll(null);
    if (!q.trim()) { setAll([]); return; }
    let alive = true;
    setPartial(true);
    const t = setTimeout(() => provider.search(q.trim(), (h) => { if (alive) setAll(h); })
      .then((h) => { if (alive) { setAll(h); setPartial(false); } })
      .catch(() => { if (alive) { setAll([]); setPartial(false); } }), 120);
    return () => { alive = false; clearTimeout(t); };
  }, [q, provider]);

  useEffect(() => { setCur(0); }, [q]);
  const count = provider ? all?.length ?? 0 : hits.length;
  const at = count ? Math.min(cur, count - 1) : -1;

  // with a provider, bring the current match's page in and find it there
  useEffect(() => {
    if (!provider || !all || at < 0) { setCurrent(null); return; }
    let alive = true;
    provider.reveal(all[at], q.trim()).then((r) => {
      if (!alive) return;
      setCurrent(r);
      r?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }).catch(() => alive && setCurrent(null));
    return () => { alive = false; };
  }, [provider, all, at]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrolledTo = useRef('');
  useEffect(() => {
    paint('find-hit', hits);
    if (provider) { paint('find-current', current ? [current] : []); return; }
    paint('find-current', at >= 0 ? [hits[at]] : []);
    // scroll when the student moves to another match, not every time the content re-renders
    const key = `${q}|${at}`;
    if (at >= 0 && scrolledTo.current !== key) {
      scrolledTo.current = key;
      hits[at].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [hits, at, current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { paint('find-hit', []); paint('find-current', []); }, []);

  const step = (d: number) => count && setCur((c) => (Math.min(c, count - 1) + d + count) % count);
  const what = scope.dataset.find || 'this page';
  const searching = provider && q.trim() && all === null;
  const more = provider && partial ? '+' : '';

  return createPortal(
    <div ref={fl.ref} className="find-bar" role="search" style={{ top: Math.max(box.top + 8, 44) + offset.dy, right: Math.max(window.innerWidth - box.right + 12, 12) - offset.dx }}>
      <span className="find-grip" title="Drag to move (double-click to put it back)" {...fl.grip} aria-hidden><Icon name="grip" size={15} /></span>
      <input ref={input} className="find-input" value={q} placeholder={`Find in ${what}`} spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }} />
      <span className="find-count" title={more ? 'Still searching the rest of the file' : undefined}>
        {q.trim() ? (searching ? '…' : count ? `${at + 1}/${count}${more}` : more ? '…' : 'No matches') : ''}</span>
      <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!count} onClick={() => step(-1)}><Icon name="chevronUp" /></button>
      <button className="icon-btn" title="Next (Enter)" disabled={!count} onClick={() => step(1)}><Icon name="chevronDown" /></button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}><Icon name="close" size={15} /></button>
    </div>,
    document.body,
  );
}
