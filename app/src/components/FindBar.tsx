/* Ctrl+F and Ctrl+A inside the app's renderers (documents, notes, cheat sheets, the chat, exams).
   Each renderer marks its root with data-find="<what it is>". Ctrl+F opens a find bar over the renderer the student
   last clicked or typed in; Ctrl+A outside a text field selects that renderer's content instead of the whole window.
   Matches are painted with CSS Custom Highlights, so nothing in the rendered content changes. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findAll, paint } from './textRange';

let lastTarget: Element | null = null;

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

export default function FindLayer() {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const down = (e: PointerEvent) => { lastTarget = e.target as Element; };
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        const s = activeScope();
        if (!s) return;
        e.preventDefault();
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
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, []);

  return scope ? <FindBar key={nonce} scope={scope} onClose={() => setScope(null)} /> : null;
}

function FindBar({ scope, onClose }: { scope: HTMLElement; onClose: () => void }) {
  const [q, setQ] = useState(() => window.getSelection()?.toString().trim().slice(0, 80) ?? '');
  const [hits, setHits] = useState<Range[]>([]);
  const [cur, setCur] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState(() => scope.getBoundingClientRect());

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  // find again when the text changes underneath (a reply streaming in, a page of a PDF rendering)
  useEffect(() => {
    const run = () => {
      if (!scope.isConnected) { onClose(); return; }
      setBox(scope.getBoundingClientRect());
      setHits(findAll(scope, q.trim()));
    };
    run();
    const mo = new MutationObserver(() => run());
    mo.observe(scope, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [q, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setCur(0); }, [q]);
  const at = hits.length ? Math.min(cur, hits.length - 1) : -1;
  const scrolledTo = useRef('');
  useEffect(() => {
    paint('find-hit', hits);
    paint('find-current', at >= 0 ? [hits[at]] : []);
    // scroll when the student moves to another match, not every time the content re-renders
    const key = `${q}|${at}`;
    if (at >= 0 && scrolledTo.current !== key) {
      scrolledTo.current = key;
      hits[at].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [hits, at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { paint('find-hit', []); paint('find-current', []); }, []);

  const step = (d: number) => hits.length && setCur((c) => (Math.min(c, hits.length - 1) + d + hits.length) % hits.length);
  const what = scope.dataset.find || 'this page';

  return createPortal(
    <div className="find-bar" role="search" style={{ top: Math.max(box.top + 8, 44), right: Math.max(window.innerWidth - box.right + 12, 12) }}>
      <input ref={input} className="find-input" value={q} placeholder={`Find in ${what}`} spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }} />
      <span className="find-count">{q.trim() ? (hits.length ? `${at + 1}/${hits.length}` : 'No matches') : ''}</span>
      <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!hits.length} onClick={() => step(-1)}>↑</button>
      <button className="icon-btn" title="Next (Enter)" disabled={!hits.length} onClick={() => step(1)}>↓</button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>×</button>
    </div>,
    document.body,
  );
}
