import { useEffect, useRef, useState } from 'react';
import { api, ArtifactType, Chat, LibraryItem, Subject, ToolName } from '../api';
import { usePoll } from '../hooks';
import { useOverlay } from '../components/overlay';
import { artifactHtml, exportAs, ExportFormat } from '../components/exportDoc';
import { getPref, setPref } from '../prefs';
import SplitHandle, { useSplit } from '../components/SplitHandle';
import { useReorder } from '../components/reorder';
import { setPaneDrag } from './subject/PaneDrop';
import { useChatStreams } from '../chatStreams';
import { confirmDeleteChats, deleteUndoably, renameChatUndoable } from './chatActions';
import { undoable } from '../undo';
import { CREATE_ITEMS } from './SubjectView';
import Icon from '../components/Icon';
import ErrorText from '../components/ErrorText';
import Info from '../components/Info';

/** Each kind of generated content's icon (components/Icon.tsx names them after the types). */
export const TYPE_ICON = (t: ArtifactType, size = 15) => <Icon name={t} size={size} />;
const EXPORTABLE: ArtifactType[] = ['notes', 'cheatsheet', 'exam', 'marking'];
export const PANE_TYPES: ArtifactType[] = ['notes', 'cheatsheet', 'mindmap', 'marking']; // open in the centre, so also in split view
const KIND_ORDER: ArtifactType[] = ['flashcards', 'quiz', 'exam', 'notes', 'cheatsheet', 'mindmap', 'marking'];
const KIND_LABEL: Record<ArtifactType, string> = { flashcards: 'Flashcards', quiz: 'Quizzes', exam: 'Practice exams', notes: 'Study notes', cheatsheet: 'Cheat sheets', mindmap: 'Mind maps', marking: 'Marking' };

/** The chat the centre shows, and how the sidebar opens or starts one. */
export interface ChatNav { activeId: number | null; onOpen: (id: number) => void; onNew: () => void }

/** Left sidebar: the subject's chats (searchable, newest first), then what Apollo is making, then everything it made,
 * grouped by kind in collapsible cards. */
/** What each kind of generated content is for, on the Create menu and the empty list. */
export const CREATE_BLURB: Record<string, string> = {
  create_flashcards: 'Quick recall: rate each card and the ones you miss come back',
  create_quiz: 'Multiple-choice and short questions, marked as you go',
  create_exam: 'A full practice exam in the same layout as one you upload',
  create_notes: 'Complete study notes covering every file',
  create_cheatsheet: 'The key facts and formulas on one page',
  create_mindmap: 'How the ideas connect, as a map you can expand',
  create_marking: 'Apollo marks your own work, like an essay or assignment, with feedback',
};

export default function LibraryPanel({ subject, onOpen, onOpenSplit, chats, onCreate }: {
  subject: Subject; chats: ChatNav;
  /** `type` lets the workspace open it without fetching it first. */
  onOpen: (id: number, type?: ArtifactType) => void; onOpenSplit: (id: number, type?: ArtifactType) => void;
  /** Open a create form in the chat (null: every topic). */
  onCreate: (tool: ToolName, topicId: number | null) => void;
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
  // being made first (with their progress), then everything else grouped by kind, in the Make content order
  const busyItems = items.filter((it) => it.status === 'queued' || it.status === 'running');
  const groups: [ArtifactType, LibraryItem[]][] = KIND_ORDER
    .map((t): [ArtifactType, LibraryItem[]] => [t, items.filter((it) => it.type === t && !busyItems.includes(it))])
    .filter(([, list]) => list.length);

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

  const createMenu = (e: React.MouseEvent) => ov.menu(e, CREATE_ITEMS.map((c) => ({ label: c.label, onClick: () => onCreate(c.tool, null) })),
    { anchor: e.currentTarget as HTMLElement });
  const retry = async (it: LibraryItem) => { await api.retryArtifact(it.id); lib.reload(); };
  const remove = async (it: LibraryItem) => {
    // deleted at once: Undo (toast or Ctrl+Z) brings it back for a week
    await deleteUndoably({ what: 'content', name: it.title, del: () => api.deleteArtifact(it.id), restore: () => api.restoreArtifact(it.id) });
    lib.reload();
  };
  const menu = (e: React.MouseEvent, it: LibraryItem) => ov.menu(e, [
    { label: 'Open', disabled: it.status !== 'ready', onClick: () => onOpen(it.id, it.type) },
    ...(PANE_TYPES.includes(it.type) ? [{ label: 'Open side by side', disabled: it.status !== 'ready', onClick: () => onOpenSplit(it.id, it.type) }] : []),
    ...(EXPORTABLE.includes(it.type) && it.status === 'ready' ? [
      { label: 'Export to Word…', separatorBefore: true, onClick: () => exportItem(it, 'docx') },
      { label: 'Export to PDF…', onClick: () => exportItem(it, 'pdf') },
      ...(it.type === 'exam' ? [
        { label: 'Export to Word with answers…', onClick: () => exportItem(it, 'docx', true) },
        { label: 'Export to PDF with answers…', onClick: () => exportItem(it, 'pdf', true) },
      ] : []),
    ] : []),
    { label: 'Regenerate', separatorBefore: true, disabled: it.status === 'queued' || it.status === 'running', onClick: () => retry(it) },
    { label: 'Rename…', onClick: async () => {
      const t = await ov.prompt({ title: 'Rename', initial: it.title });
      if (t) {
        await api.renameArtifact(it.id, t);
        undoable({ label: `rename “${it.title}”`, undo: () => api.renameArtifact(it.id, it.title), redo: () => api.renameArtifact(it.id, t) });
        lib.reload();
      }
    } },
    { label: 'Delete', danger: true, separatorBefore: true, onClick: () => remove(it) },
  ]);

  return (
    <aside className="side side-left">
      <ChatHistory subject={subject} nav={chats} style={chatSplit.style} />
      <SplitHandle split={chatSplit} label="chats" edge="below" section={() => document.querySelector<HTMLElement>('.side-left > .chat-history:not(.folded)')} />
      <div className="side-head side-head-sub">
        <div className="side-title">Study material</div>
        <button className="btn btn-sm lib-create" data-tip="Make flashcards, a quiz, an exam, notes, a cheat sheet or a mind map, or mark your work" onClick={createMenu}>
          <Icon name="create" size={14} /> Make
        </button>
      </div>
      <div className="side-scroll lib-scroll">
        {busyItems.length > 0 && (
          <section className="lib-making" aria-label="Being made">
            <div className="lib-label">Being made <Info text="Apollo makes one thing at a time, in order. You can keep studying meanwhile; each one moves into its group below when it's ready." /></div>
            {busyItems.map((it) => (
              <div key={it.id} className="lib-made-card" title={it.message || 'Waiting for Apollo'} onContextMenu={(e) => menu(e, it)}>
                <span className={`lib-icon t-${it.type}`}>{TYPE_ICON(it.type)}</span>
                <span className="lib-main">
                  <span className="lib-title">{it.title}</span>
                  <span className="lib-progress"><span style={{ width: `${Math.max(4, Math.round(it.progress * 100))}%` }} /></span>
                  <span className="lib-sub">{it.status === 'queued' ? 'Waiting its turn…' : `${it.message || 'Working'} · ${Math.round(it.progress * 100)}%`}</span>
                </span>
                <button className="x-btn lib-more" title="More options" aria-label={`More options for ${it.title}`} onClick={(e) => menu(e, it)}><Icon name="more" size={15} /></button>
              </div>
            ))}
          </section>
        )}
        {items.length === 0 && (
          <div className="files-empty side-empty">
            What you make is kept here, grouped by kind. Pick one to start:
            <div className="lib-starters">
              {CREATE_ITEMS.map((c) => (
                <button key={c.tool} className="lib-starter" onClick={() => onCreate(c.tool, null)}>
                  <b>{c.label.replace(' (from a practice exam)', '')}</b><span>{CREATE_BLURB[c.tool]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {groups.map(([type, list], gi) => {
          const open = !hidden.has(type);
          return (
            <section key={type} className={`lib-kind kind-${type}${open ? ' open' : ''}`} style={{ '--i': gi } as React.CSSProperties}>
              <button className="lib-kind-head" onClick={() => toggle(type)} aria-expanded={open} title={open ? 'Hide' : 'Show'}>
                <span className={`lib-kind-icon t-${type}`}>{TYPE_ICON(type, 16)}</span>
                <span className="lib-kind-name">{KIND_LABEL[type]}</span>
                <span className="lib-kind-count">{list.length}</span>
                <span className="lib-kind-caret"><Icon name="chevronRight" size={14} /></span>
              </button>
              {open && (
                <div className="lib-kind-list">
                  {sortLike(list, reorder.order).map((it) => {
                    // drag to reorder, only among items of the same kind made the same day (the dates stay in order)
                    const drag = reorder.item(it.id);
                    const sameDay = (_e: React.DragEvent) => dragDay.current === `${type}|${dayOf(it.created_at)}`;
                    // default titles are "Type: Topic (extra)"; inside the type's group the type part is redundant
                    const title = it.title.includes(':') ? it.title.replace(/^[^:]+:\s*/, '') : it.title;
                    const date = new Date(it.created_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
                    return (
                      <div key={it.id} className="lib-item-wrap">
                        <button className={`lib-item status-${it.status}`} onClick={() => it.status === 'ready' && onOpen(it.id, it.type)}
                          draggable data-drop={drag['data-drop']}
                          onDragStart={(e) => {
                            dragDay.current = `${type}|${dayOf(it.created_at)}`;
                            // notes / cheat sheets / mind maps can also be dropped in the centre (subject/PaneDrop.tsx)
                            if (it.status === 'ready' && PANE_TYPES.includes(it.type)) setPaneDrag(e.dataTransfer, { kind: 'artifact', id: it.id, type: it.type, name: it.title });
                            drag.onDragStart(e);
                          }}
                          onDragEnd={() => { dragDay.current = null; drag.onDragEnd(); }}
                          onDragOver={(e) => { if (sameDay(e)) drag.onDragOver(e); }}
                          onDragLeave={(e) => { drag.onDragLeave(e); }}
                          onDrop={(e) => { if (sameDay(e)) drag.onDrop(e); }}
                          onContextMenu={(e) => menu(e, it)} title={it.status === 'failed' ? `Failed${it.error || it.message ? `: ${it.error || it.message}` : ''}` : it.title}>
                          <span className="lib-main">
                            <span className="lib-title">{title}</span>
                            <span className="lib-sub">{it.topic_name ?? 'All topics'} · {date}{it.status === 'failed' && ' · failed'}{it.status === 'cancelled' && ' · cancelled'}</span>
                            {(it.status === 'failed' || it.status === 'cancelled') && (
                              <span className="lib-failed" onClick={(e) => e.stopPropagation()}>
                                {(it.error || it.message) && <span className="lib-failed-why"><ErrorText text={it.error || it.message} /></span>}
                                <span className="link-btn" role="button" tabIndex={0} onClick={() => retry(it)}>Try again</span>
                                <span className="link-btn danger" role="button" tabIndex={0} onClick={() => remove(it)}>Delete</span>
                              </span>
                            )}
                          </span>
                          {it.status === 'ready' && <span className="lib-go" aria-hidden><Icon name="chevronRight" size={14} /></span>}
                        </button>
                        <button className="x-btn lib-more" title="More options" aria-label={`More options for ${title}`} onClick={(e) => menu(e, it)}><Icon name="more" size={15} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
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
          <span className="lib-caret"><Icon name="chevronDown" size={13} /></span> Chats {chats.data && <span className="lib-count">{chats.data.length}</span>}
        </button>
        <button className="icon-btn" data-tip="New chat" onClick={nav.onNew}><Icon name="add" /></button>
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
                        onClick={(e) => { e.stopPropagation(); remove(picked.has(c.id) && picked.size > 1 ? pickedChats : [c]); }}><Icon name="close" size={14} /></button>
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
