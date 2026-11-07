/* Ctrl+K: search everything (subjects, topics, files, generated content, notes, chats in every subject) and app
   actions, then go there. Opens over everything, even from a text field. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, PaletteData } from '../api';
import type { Route } from '../App';
import { TYPE_ICON } from '../views/LibraryPanel';
import { redo, undo } from '../undo';
import { logError } from '../log';
import { score } from './fuzzy';
import type { OpenRequest } from '../viewHistory';

let open = false;
const listeners = new Set<() => void>();
const set = (v: boolean) => { open = v; listeners.forEach((fn) => fn()); };
export const openPalette = () => set(true);

interface Item {
  key: string; kind: string; icon: string; title: string; sub?: string;
  run: () => void;
  /** Lower case text matched against the query. */
  hay: string;
}


export default function CommandPalette({ go, route }: { go: (r: Route) => void; route: Route }) {
  const isOpen = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => open);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); set(!open); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  return isOpen ? <Palette go={go} route={route} onClose={() => set(false)} /> : null;
}

function Palette({ go, route, onClose }: { go: (r: Route) => void; route: Route; onClose: () => void }) {
  const [data, setData] = useState<PaletteData | null>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); api.palette().then(setData).catch((e) => logError('palette', e)); }, []);

  const here = route.name === 'subject' ? route.id : null;
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const subjectName = (id: number) => data?.subjects.find((s) => s.id === id)?.name ?? '';
    const topicName = (id: number | null) => (id == null ? '' : data?.topics.find((t) => t.id === id)?.name ?? '');
    const openIn = (sid: number, o: Omit<OpenRequest, 'nonce'>) => go({ name: 'subject', id: sid, open: { ...o, nonce: Date.now() } });
    const add = (it: Omit<Item, 'hay'>) => out.push({ ...it, hay: `${it.title} ${it.sub ?? ''} ${it.kind}`.toLowerCase() });
    const actions: [string, string, () => void][] = [
      ['All subjects', 'Home', () => go({ name: 'home' })],
      ['Settings', 'Models, appearance, spelling', () => go({ name: 'settings' })],
      ['Maintenance', 'Disk use, clean-up, vision checks', () => go({ name: 'settings', tab: 'maintenance' })],
      ['Share / study packs', 'Export or import', () => go({ name: 'settings', tab: 'share' })],
      ['Undo', 'Ctrl+Z', () => { undo(); }],
      ['Redo', 'Ctrl+Y', () => { redo(); }],
    ];
    for (const [title, sub, run] of actions) add({ key: `a:${title}`, kind: 'action', icon: '›', title, sub, run });
    if (!data) return out;
    for (const s of data.subjects) add({ key: `s${s.id}`, kind: 'subject', icon: '◆', title: s.name, sub: 'Subject', run: () => go({ name: 'subject', id: s.id }) });
    if (here != null) add({ key: 'newchat', kind: 'action', icon: '＋', title: 'New chat', sub: subjectName(here), run: () => openIn(here, { kind: 'chat', id: -1 }) });
    for (const t of data.topics) add({ key: `t${t.id}`, kind: 'topic', icon: '▸', title: t.name, sub: `Topic · ${subjectName(t.subject_id)}`, run: () => openIn(t.subject_id, { kind: 'topic', id: t.id }) });
    for (const d of data.documents) add({ key: `d${d.id}`, kind: 'file', icon: '📄', title: d.filename,
      sub: `${d.kind === 'reference' ? 'Textbook' : topicName(d.topic_id) || 'File'} · ${subjectName(d.subject_id)}`, run: () => openIn(d.subject_id, { kind: 'doc', id: d.id }) });
    for (const a of data.artifacts) add({ key: `g${a.id}`, kind: a.type, icon: TYPE_ICON[a.type], title: a.title,
      sub: `Generated · ${subjectName(a.subject_id)}`, run: () => openIn(a.subject_id, { kind: 'artifact', id: a.id }) });
    for (const n of data.notes) add({ key: `n${n.id}`, kind: 'note', icon: '✎', title: n.title, sub: `My notes · ${subjectName(n.subject_id)}`, run: () => openIn(n.subject_id, { kind: 'note', id: n.id }) });
    for (const c of data.chats) add({ key: `c${c.id}`, kind: 'chat', icon: '💬', title: c.title, sub: `Chat · ${subjectName(c.subject_id)}`, run: () => openIn(c.subject_id, { kind: 'chat', id: c.id }) });
    return out;
  }, [data, go, here]);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      // nothing typed: actions, then what's in this subject
      const inHere = here == null ? [] : items.filter((i) => i.sub?.endsWith(data?.subjects.find((s) => s.id === here)?.name ?? '\0') && i.kind !== 'topic');
      return [...items.filter((i) => i.kind === 'action'), ...inHere].slice(0, 60);
    }
    return items.map((i) => ({ i, s: score(i.hay, words) + (i.kind === 'action' ? -1 : 0) }))
      .filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 60).map((x) => x.i);
  }, [items, q, here, data]);

  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const pick = (it: Item | undefined) => { if (!it) return; onClose(); it.run(); };

  return createPortal(
    <div className="modal-backdrop pal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search and go">
        <input ref={input} className="pal-input" value={q} placeholder="Search files, notes, chats, content, topics, subjects, actions…"
          spellCheck={false} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(results[at]); }
          }} />
        <div ref={list} className="pal-list">
          {!data && <div className="pal-empty">Loading…</div>}
          {data && !results.length && <div className="pal-empty">Nothing matches “{q}”.</div>}
          {results.map((it, i) => (
            <button key={it.key} className={`pal-item${i === at ? ' on' : ''}`} onMouseMove={() => i !== at && setAt(i)} onClick={() => pick(it)}>
              <span className={`pal-icon k-${it.kind}`}>{it.icon}</span>
              <span className="pal-title">{it.title}</span>
              {it.sub && <span className="pal-sub">{it.sub}</span>}
            </button>
          ))}
        </div>
        <div className="pal-foot"><span>↑↓ to move · Enter to open · Esc to close</span><span>Ctrl+K</span></div>
      </div>
    </div>,
    document.body,
  );
}
