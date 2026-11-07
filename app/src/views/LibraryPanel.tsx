import { useEffect, useRef, useState } from 'react';
import { api, ArtifactType, Chat, LibraryItem, Subject } from '../api';
import { usePoll } from '../hooks';
import { useOverlay } from '../components/overlay';
import { artifactHtml, exportAs, ExportFormat } from '../components/exportDoc';
import { getPref, setPref } from '../prefs';
import SplitHandle, { useSplit } from '../components/SplitHandle';
import { useReorder } from '../components/reorder';
import { useChatStreams } from '../chatStreams';
import { confirmDeleteChats, deleteUndoably, renameChatUndoable } from './chatActions';
import { undoable } from '../undo';

export const TYPE_ICON: Record<ArtifactType, string> = { flashcards: '▤', quiz: '?', exam: '✎', notes: '¶', cheatsheet: '≡', mindmap: '✺' };
const TYPE_LABEL: Record<ArtifactType, string> = { flashcards: 'Flashcards', quiz: 'Quiz', exam: 'Exam', notes: 'Notes', cheatsheet: 'Cheat sheet', mindmap: 'Mind map' };
const EXPORTABLE: ArtifactType[] = ['notes', 'cheatsheet', 'exam'];
const PANE_TYPES: ArtifactType[] = ['notes', 'cheatsheet', 'mindmap']; // open in the centre, so also in split view

/** The chat the centre shows, and how the sidebar opens or starts one. */
export interface ChatNav { activeId: number | null; onOpen: (id: number) => void; onNew: () => void }

/** Left sidebar: the subject's chats (searchable, newest first) above everything generated for it, grouped by topic. */
export default function LibraryPanel({ subject, onOpen, onOpenSplit, chats }: {
  subject: Subject; onOpen: (id: number) => void; onOpenSplit: (id: number) => void; chats: ChatNav;
}) {
  const ov = useOverlay();
  const lib = usePoll(() => api.library(subject.id), 1000, [subject.id], ['library']);
  const chatSplit = useSplit('split:chats');
  const items = lib.data ?? [];
  const key = `libCollapsed:${subject.id}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    return getPref(key, new Set<string>(), (v) => new Set(JSON.parse(v) as string[]));
  });
  const toggle = (name: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(name)) n.delete(name); else n.add(name);
    setPref(key, JSON.stringify([...n]));
    return n;
  });

  const dragDay = useRef<string | null>(null);
  const groups = new Map<string, LibraryItem[]>();
  for (const t of subject.topics) groups.set(t.name, []);
  for (const it of items) {
    const key = it.topic_name ?? 'All topics';
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }

  const dayOf = (t: number) => new Date(t * 1000).toDateString();
  const reorder = useReorder(`lib:${subject.id}`, items.map((it) => it.id),
    async (ids) => { await api.orderArtifacts(subject.id, ids); lib.reload(); }, 'reorder generated content');

  const exportItem = async (it: LibraryItem, format: ExportFormat, answers = false) => {
    try {
      const a = await api.artifact(it.id);
      await exportAs(format, answers ? `${a.title} (with answers)` : a.title, (word) => artifactHtml(a, word, answers));
    } catch (e) {
      ov.confirm({ title: 'Export failed', body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };

  const menu = (e: React.MouseEvent, it: LibraryItem) => ov.menu(e, [
    { label: 'Open', disabled: it.status !== 'ready', onClick: () => onOpen(it.id) },
    ...(PANE_TYPES.includes(it.type) ? [{ label: 'Open side by side', disabled: it.status !== 'ready', onClick: () => onOpenSplit(it.id) }] : []),
    ...(EXPORTABLE.includes(it.type) && it.status === 'ready' ? [
      { label: 'Export to Word…', separatorBefore: true, onClick: () => exportItem(it, 'docx') },
      { label: 'Export to PDF…', onClick: () => exportItem(it, 'pdf') },
      ...(it.type === 'exam' ? [
        { label: 'Export to Word with answers…', onClick: () => exportItem(it, 'docx', true) },
        { label: 'Export to PDF with answers…', onClick: () => exportItem(it, 'pdf', true) },
      ] : []),
    ] : []),
    { label: 'Regenerate', separatorBefore: true, disabled: it.status === 'queued' || it.status === 'running', onClick: async () => { await api.retryArtifact(it.id); lib.reload(); } },
    { label: 'Rename…', onClick: async () => {
      const t = await ov.prompt({ title: 'Rename', initial: it.title });
      if (t) {
        await api.renameArtifact(it.id, t);
        undoable({ label: `rename “${it.title}”`, undo: () => api.renameArtifact(it.id, it.title), redo: () => api.renameArtifact(it.id, t) });
        lib.reload();
      }
    } },
    { label: 'Delete', danger: true, separatorBefore: true, onClick: async () => {
      if (await ov.confirm({ title: `Delete ${it.title}?`, danger: true, confirmText: 'Delete',
        body: 'You can undo this (Ctrl+Z) for a week; after that it and its ratings and attempts are gone.' })) {
        await deleteUndoably({ what: 'content', name: it.title, del: () => api.deleteArtifact(it.id), restore: () => api.restoreArtifact(it.id) });
        lib.reload();
      }
    } },
  ]);

  return (
    <aside className="side side-left">
      <ChatHistory subject={subject} nav={chats} style={chatSplit.style} />
      <SplitHandle split={chatSplit} label="chats" edge="below" section={() => document.querySelector<HTMLElement>('.side-left > .chat-history:not(.folded)')} />
      <div className="side-head side-head-sub"><div className="side-title">Generated</div></div>
      <div className="side-scroll">
        {items.length === 0 && (
          <div className="files-empty side-empty">
            Flashcards, quizzes, exams, notes and mind maps you create in chat are saved here, grouped by topic.
          </div>
        )}
        {[...groups.entries()].filter(([, list]) => list.length).map(([name, list]) => (
          <section key={name} className={`side-section lib-group${hidden.has(name) ? ' folded' : ''}`}>
            <button className="side-section-head lib-group-head" onClick={() => toggle(name)} title={hidden.has(name) ? 'Show' : 'Hide'}>
              <span className="lib-caret">▾</span><span>{name}</span><span className="lib-count">{list.length}</span>
            </button>
            {!hidden.has(name) && sortLike(list, reorder.order).map((it) => {
              // drag to reorder, only among items made the same day in the same topic group (the dates stay in order)
              const drag = reorder.item(it.id);
              const sameDay = (_e: React.DragEvent) => dragDay.current === `${name}|${dayOf(it.created_at)}`;
              const busy = it.status === 'queued' || it.status === 'running';
              // Default titles are "Type: Topic (extra)"; inside a topic group the topic part is redundant.
              const rest = it.title.replace(/^[^:]+:\s*/, '');
              const extra = it.topic_name && rest.startsWith(it.topic_name) ? rest.slice(it.topic_name.length).trim() : rest;
              const title = it.title.includes(':') ? `${TYPE_LABEL[it.type]}${extra ? ` ${extra}` : ''}` : it.title;
              const date = new Date(it.created_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
              return (
                <button key={it.id} className={`lib-item status-${it.status}`} onClick={() => it.status === 'ready' && onOpen(it.id)}
                  draggable data-drop={drag['data-drop']}
                  onDragStart={(e) => { dragDay.current = `${name}|${dayOf(it.created_at)}`; drag.onDragStart(e); }}
                  onDragEnd={() => { dragDay.current = null; drag.onDragEnd(); }}
                  onDragOver={(e) => { if (sameDay(e)) drag.onDragOver(e); }}
                  onDragLeave={(e) => { drag.onDragLeave(e); }}
                  onDrop={(e) => { if (sameDay(e)) drag.onDrop(e); }}
                  onContextMenu={(e) => menu(e, it)} title={busy ? it.message : it.status === 'failed' ? 'Failed: right-click to delete' : it.title}>
                  <span className={`lib-icon t-${it.type}`}>{TYPE_ICON[it.type]}</span>
                  <span className="lib-main">
                    <span className="lib-title">{title}</span>
                    <span className="lib-sub">
                      {date}
                      {busy && ` · ${Math.round(it.progress * 100)}%`}
                      {it.status === 'failed' && ' · failed'}
                    </span>
                    {busy && <span className="lib-progress"><span style={{ width: `${Math.round(it.progress * 100)}%` }} /></span>}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}

/** `list` in the order of `order` (ids), for the optimistic order while a reorder saves. */
function sortLike<T extends { id: number }>(list: T[], order: number[]) {
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}

const DAY = 86400;
function when(t: number) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime() / 1000;
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return 'Previous 7 days';
  if (t >= today - 29 * DAY) return 'Previous 30 days';
  return new Date(t * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** The subject's chats: search by title, grouped by when they were last used. × deletes one (after asking);
 * Ctrl-click and Shift-click select several (Delete key or the bar to delete them all); right-click for more. A dot
 * marks a reply that finished while the chat wasn't open, a spinner one being written now. */
function ChatHistory({ subject, nav, style }: { subject: Subject; nav: ChatNav; style?: React.CSSProperties }) {
  const ov = useOverlay();
  const streams = useChatStreams();
  const chats = usePoll(() => api.chats(subject.id), 600, [subject.id], ['chats']);
  const [q, setQ] = useState('');
  const [folded, setFolded] = useState(() => getPref('chatsFolded', false, (v) => v === '1'));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const list = (chats.data ?? []).filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const topic = (id: number | null) => subject.topics.find((t) => t.id === id)?.name;
  // forget picks of chats that are gone
  useEffect(() => {
    if (!chats.data || !picked.size) return;
    const ids = new Set(chats.data.map((c) => c.id));
    if ([...picked].some((id) => !ids.has(id))) setPicked(new Set([...picked].filter((id) => ids.has(id))));
  }, [chats.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups: [string, Chat[]][] = [];
  for (const c of list) {
    const g = when(c.updated_at);
    if (groups.length && groups[groups.length - 1][0] === g) groups[groups.length - 1][1].push(c);
    else groups.push([g, [c]]);
  }

  const remove = async (cs: Chat[]) => {
    if (!await confirmDeleteChats(ov, cs)) return;
    setPicked(new Set());
    chats.reload();
    if (cs.some((c) => c.id === nav.activeId)) nav.onNew();
  };

  const click = (e: React.MouseEvent, c: Chat) => {
    if (e.shiftKey && anchor.current != null) {
      const ids = list.map((x) => x.id);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(c.id);
      if (a >= 0 && b >= 0) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        setPicked(new Set([...(e.ctrlKey || e.metaKey ? picked : []), ...range]));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const n = new Set(picked);
      if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
      // the open chat counts as picked when starting a selection, like a file manager
      if (!picked.size && nav.activeId != null && nav.activeId !== c.id && list.some((x) => x.id === nav.activeId)) n.add(nav.activeId);
      setPicked(n);
      anchor.current = c.id;
      return;
    }
    setPicked(new Set());
    anchor.current = c.id;
    nav.onOpen(c.id);
  };

  const menu = (e: React.MouseEvent, c: Chat) => {
    const many = picked.has(c.id) && picked.size > 1;
    ov.menu(e, many ? [
      { label: `${picked.size} chats selected`, header: true },
      { label: `Delete ${picked.size} chats…`, danger: true, onClick: () => remove(list.filter((x) => picked.has(x.id))) },
      { label: 'Clear selection', onClick: () => setPicked(new Set()) },
    ] : [
      { label: 'Open', onClick: () => nav.onOpen(c.id) },
      { label: 'Rename…', onClick: async () => {
        const t = await ov.prompt({ title: 'Rename chat', initial: c.title });
        if (t) { await renameChatUndoable(c, t); chats.reload(); }
      } },
      { label: 'Name with Apollo', onClick: async () => {
        try { await api.autoTitleChat(c.id); chats.reload(); }
        catch (err) { ov.confirm({ title: 'Couldn’t name the chat', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }); }
      } },
      { label: 'Delete…', danger: true, separatorBefore: true, onClick: () => remove([c]) },
    ]);
  };
  const fold = () => { setFolded(!folded); setPref('chatsFolded', folded ? '0' : '1'); };
  const pickedChats = list.filter((c) => picked.has(c.id));

  return (
    <section className={`chat-history${folded ? ' folded' : ''}`} style={folded ? undefined : style}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('input') && picked.size) { e.preventDefault(); remove(pickedChats); }
        if (e.key === 'Escape' && picked.size) setPicked(new Set());
      }}>
      <div className="side-head">
        <button className="side-title ch-title" onClick={fold} title={folded ? 'Show chats' : 'Hide chats'}>
          <span className="lib-caret">▾</span> Chats {chats.data && <span className="lib-count">{chats.data.length}</span>}
        </button>
        <button className="icon-btn" data-tip="New chat" onClick={nav.onNew}>＋</button>
      </div>
      {!folded && (
        <>
          {(chats.data?.length ?? 0) > 5 && (
            <input className="ch-search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          )}
          {picked.size > 0 && (
            <div className="ch-selbar">
              <span>{picked.size} selected</span>
              <span className="spacer" />
              <button className="link-btn danger" onClick={() => remove(pickedChats)}>Delete</button>
              <button className="link-btn" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
          )}
          <div className="ch-scroll">
            {chats.data && !chats.data.length && <div className="files-empty side-empty">Your conversations with Apollo will be listed here.</div>}
            {q && !list.length && <div className="files-empty side-empty">No chat titles match.</div>}
            {groups.map(([g, cs]) => (
              <div key={g}>
                <div className="ch-group">{g}</div>
                {cs.map((c) => {
                  const live = !!streams.live(c.id);
                  const unread = streams.unread(c.id);
                  return (
                    <div key={c.id} role="button" tabIndex={0} title={c.title}
                      className={`ch-item${c.id === nav.activeId ? ' active' : ''}${picked.has(c.id) ? ' picked' : ''}`}
                      onClick={(e) => click(e, c)} onContextMenu={(e) => menu(e, c)}
                      onKeyDown={(e) => { if (e.key === 'Enter') nav.onOpen(c.id); }}>
                      {live ? <span className="ch-spin" aria-label="Apollo is replying" />
                        : unread ? <span className={`ch-dot${unread.error ? ' bad' : ''}`} aria-label={unread.error ? 'Reply failed' : 'New reply'} /> : null}
                      <span className="ch-name">{c.title}</span>
                      {topic(c.topic_id) && <span className="ch-topic">{topic(c.topic_id)}</span>}
                      <button className="x-btn ch-del" title="Delete chat" aria-label={`Delete ${c.title}`}
                        onClick={(e) => { e.stopPropagation(); remove(picked.has(c.id) && picked.size > 1 ? pickedChats : [c]); }}>×</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
