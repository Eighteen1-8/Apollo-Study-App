import { useEffect, useRef, useState } from 'react';
import { api, ArtifactType, Chat, ChatGroup, LibraryItem, Subject, ToolName } from '../api';
import { usePoll } from '../hooks';
import { MenuItem, useOverlay } from '../components/overlay';
import { artifactHtml, exportAs, ExportFormat } from '../components/exportDoc';
import { getPref, setPref } from '../prefs';
import SplitHandle, { useSplit } from '../components/SplitHandle';
import { useReorder } from '../components/reorder';
import { setPaneDrag } from './subject/PaneDrop';
import { useChatStreams } from '../chatStreams';
import { confirmDeleteChats, deleteUndoably, renameChatUndoable } from './chatActions';
import { draggedChats, endChatDrag, isChatDrag, previousGroups, setChatDrag, splitByGroup } from './chat/chatGroups';
import { undoable } from '../undo';
import { CREATE_ITEMS } from './SubjectView';
import Icon from '../components/Icon';
import ErrorText from '../components/ErrorText';
import Info from '../components/Info';
import { TourButton } from '../components/Tour';

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
        <TourButton id="library" />
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

/** The subject's chats: search by title; the student's groups (folders) first, then the other chats grouped by when
 * they were last used. × deletes one (after asking); Ctrl-click and Shift-click select several (Delete key or the bar
 * to delete them all); right-click for more. A chat dragged onto a group goes into it, and out of it when dropped
 * among the other chats. A dot marks a reply that finished while the chat wasn't open, a spinner one being written
 * now. */
function ChatHistory({ subject, nav, style }: { subject: Subject; nav: ChatNav; style?: React.CSSProperties }) {
  const ov = useOverlay();
  const streams = useChatStreams();
  const chats = usePoll(() => api.chats(subject.id), 600, [subject.id], ['chats']);
  const groupsQ = usePoll(() => api.chatGroups(subject.id), 600, [subject.id], ['chats']);
  const groups = groupsQ.data ?? [];
  const [q, setQ] = useState('');
  const [folded, setFolded] = useState(() => getPref('chatsFolded', false, (v) => v === '1'));
  const shutKey = `chatGroupsShut:${subject.id}`;
  const [shut, setShut] = useState<Set<number>>(() => getPref(shutKey, new Set<number>(), (v) => new Set(JSON.parse(v) as number[])));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // where dragged chats would land: a group's id, or 'out' (the ungrouped list); `fromGroup`: a grouped chat is dragged
  const [dropOn, setDropOn] = useState<number | 'out' | null>(null);
  const [fromGroup, setFromGroup] = useState(false);
  const anchor = useRef<number | null>(null);
  const all = chats.data ?? [];
  const searching = !!q.trim();
  const list = all.filter((c) => !searching || c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const topic = (id: number | null) => subject.topics.find((t) => t.id === id)?.name;
  // forget picks of chats that are gone
  useEffect(() => {
    if (!chats.data || !picked.size) return;
    const ids = new Set(chats.data.map((c) => c.id));
    if ([...picked].some((id) => !ids.has(id))) setPicked(new Set([...picked].filter((id) => ids.has(id))));
  }, [chats.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const reorderGroups = useReorder(`chatGroups:${subject.id}`, groups.map((g) => g.id),
    async (ids) => { await api.orderChatGroups(subject.id, ids); groupsQ.reload(); }, 'reorder chat groups');
  const shownGroups = sortLike(groups, reorderGroups.order);
  const { inGroup, ungrouped } = splitByGroup(list, shownGroups);
  const isOpen = (gid: number) => searching || !shut.has(gid);
  const setOpen = (gid: number, open: boolean) => setShut((s) => {
    if (s.has(gid) !== open) return s;
    const n = new Set(s);
    if (open) n.delete(gid); else n.add(gid);
    setPref(shutKey, JSON.stringify([...n]));
    return n;
  });

  const buckets: [string, Chat[]][] = [];
  for (const c of ungrouped) {
    const g = when(c.updated_at);
    if (buckets.length && buckets[buckets.length - 1][0] === g) buckets[buckets.length - 1][1].push(c);
    else buckets.push([g, [c]]);
  }
  // the order the rows show in, for Shift-click ranges
  const visible = [...shownGroups.flatMap((g) => (isOpen(g.id) ? inGroup.get(g.id) ?? [] : [])), ...ungrouped];
  const reloadAll = () => { chats.reload(); groupsQ.reload(); };

  const remove = async (cs: Chat[]) => {
    if (!await confirmDeleteChats(ov, cs)) return;
    setPicked(new Set());
    chats.reload();
    if (cs.some((c) => c.id === nav.activeId)) nav.onNew();
  };

  /** Into a group (null: out of any); undo puts each chat back where it was. */
  const moveTo = async (ids: number[], groupId: number | null) => {
    const back = previousGroups(all, ids).filter(([g]) => g !== groupId);
    const moving = back.flatMap(([, x]) => x);
    if (!moving.length) return;
    await api.moveChatsToGroup(moving, groupId);
    const what = moving.length === 1 ? `chat “${all.find((c) => c.id === moving[0])?.title ?? ''}”` : `${moving.length} chats`;
    const where = groupId == null ? 'out of its group' : `to “${groups.find((g) => g.id === groupId)?.name ?? 'group'}”`;
    undoable({
      label: `move ${what} ${where}`,
      undo: async () => { for (const [g, x] of back) await api.moveChatsToGroup(x, g); },
      redo: () => api.moveChatsToGroup(moving, groupId),
    });
    if (groupId != null) setOpen(groupId, true); // show where they went
    setPicked(new Set());
    reloadAll();
  };
  /** A new group, with `ids` moved into it at once. */
  const newGroup = async (ids: number[] = []) => {
    const name = (await ov.prompt({ title: 'New chat group', label: 'Name', placeholder: 'e.g. Exam revision', confirmText: 'Create' }))?.trim();
    if (!name) return;
    try {
      const g = await api.createChatGroup(subject.id, name, ids);
      undoable({ label: `new chat group “${g.name}”`, undo: () => api.deleteChatGroup(g.id), redo: () => api.restoreChatGroup(g.id) });
      setPicked(new Set());
      if (folded) { setFolded(false); setPref('chatsFolded', '0'); }
    } catch (err) {
      ov.confirm({ title: 'Couldn’t make the group', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
    }
    reloadAll();
  };
  const renameGroup = async (g: ChatGroup) => {
    const t = (await ov.prompt({ title: 'Rename group', initial: g.name }))?.trim();
    if (!t || t === g.name) return;
    await api.renameChatGroup(g.id, t);
    undoable({ label: `rename chat group to “${t}”`, undo: () => api.renameChatGroup(g.id, g.name), redo: () => api.renameChatGroup(g.id, t) });
    groupsQ.reload();
  };
  const deleteGroup = async (g: ChatGroup) => {
    // its chats are kept: they move out among the other chats (Undo puts them back in)
    await deleteUndoably({ what: 'chat group', name: g.name, del: () => api.deleteChatGroup(g.id), restore: () => api.restoreChatGroup(g.id) });
    reloadAll();
  };
  const groupMenu = (e: React.MouseEvent, g: ChatGroup) => ov.menu(e, [
    { label: g.name, header: true },
    { label: 'Rename…', onClick: () => renameGroup(g) },
    { label: 'New group…', onClick: () => newGroup() },
    { label: 'Delete group', danger: true, separatorBefore: true, hint: 'keeps its chats', onClick: () => deleteGroup(g) },
  ]);
  /** "Move to group" for these chats: every group, a new one, and out of their group. */
  const moveItems = (cs: Chat[]): MenuItem[] => {
    const ids = cs.map((c) => c.id);
    const inAny = cs.some((c) => c.group_id != null && groups.some((g) => g.id === c.group_id));
    return [
      ...shownGroups.map((g) => ({ label: g.name, disabled: cs.every((c) => c.group_id === g.id), onClick: () => moveTo(ids, g.id) })),
      { label: 'New group…', separatorBefore: groups.length > 0, onClick: () => newGroup(ids) },
      ...(inAny ? [{ label: 'Remove from group', onClick: () => moveTo(ids, null) }] : []),
    ];
  };

  const click = (e: React.MouseEvent, c: Chat) => {
    if (e.shiftKey && anchor.current != null) {
      const ids = visible.map((x) => x.id);
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

  const pickedChats = list.filter((c) => picked.has(c.id));
  const menu = (e: React.MouseEvent, c: Chat) => {
    const many = picked.has(c.id) && picked.size > 1;
    ov.menu(e, many ? [
      { label: `${picked.size} chats selected`, header: true },
      { label: 'Move to group', children: moveItems(pickedChats) },
      { label: `Delete ${picked.size} chats…`, danger: true, separatorBefore: true, onClick: () => remove(pickedChats) },
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
      { label: 'Move to group', children: moveItems([c]) },
      { label: 'Delete…', danger: true, separatorBefore: true, onClick: () => remove([c]) },
    ]);
  };
  const fold = () => { setFolded(!folded); setPref('chatsFolded', folded ? '0' : '1'); };

  /** Drop handlers for chats dragged onto a group (`target`: its id) or out among the other chats (null). */
  const chatDrop = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isChatDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const on = target ?? 'out';
      setDropOn((o) => (o === on ? o : on));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isChatDrag(e) || (e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
      setDropOn((o) => (o === (target ?? 'out') ? null : o));
    },
    onDrop: (e: React.DragEvent) => {
      if (!isChatDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const ids = draggedChats(e);
      endChatDrag();
      setDropOn(null);
      setFromGroup(false);
      moveTo(ids, target);
    },
  });

  const row = (c: Chat) => {
    const live = !!streams.live(c.id);
    const unread = streams.unread(c.id);
    return (
      <div key={c.id} role="button" tabIndex={0} title={c.title} draggable
        className={`ch-item${c.id === nav.activeId ? ' active' : ''}${picked.has(c.id) ? ' picked' : ''}`}
        onClick={(e) => click(e, c)} onContextMenu={(e) => menu(e, c)}
        onKeyDown={(e) => { if (e.key === 'Enter') nav.onOpen(c.id); }}
        onDragStart={(e) => {
          const ids = picked.has(c.id) && picked.size > 1 ? pickedChats.map((x) => x.id) : [c.id];
          setChatDrag(e.dataTransfer, ids);
          setFromGroup(all.some((x) => ids.includes(x.id) && x.group_id != null && inGroup.has(x.group_id)));
        }}
        onDragEnd={() => { endChatDrag(); setDropOn(null); setFromGroup(false); }}>
        {live ? <span className="ch-spin" aria-label="Apollo is replying" />
          : unread ? <span className={`ch-dot${unread.error ? ' bad' : ''}`} aria-label={unread.error ? 'Reply failed' : 'New reply'} /> : null}
        <span className="ch-name">{c.title}</span>
        {topic(c.topic_id) && <span className="ch-topic">{topic(c.topic_id)}</span>}
        <button className="x-btn ch-del" title="Delete chat" aria-label={`Delete ${c.title}`}
          onClick={(e) => { e.stopPropagation(); remove(picked.has(c.id) && picked.size > 1 ? pickedChats : [c]); }}><Icon name="close" size={14} /></button>
      </div>
    );
  };

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
        <span className="ch-head-actions">
          <button className="icon-btn chat-group-add" title="New group" aria-label="New chat group" onClick={() => newGroup()}><Icon name="folderNew" /></button>
          <button className="icon-btn" data-tip="New chat" onClick={nav.onNew}><Icon name="add" /></button>
        </span>
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
              <button className="link-btn" onClick={(e) => ov.menu(e, moveItems(pickedChats), { anchor: e.currentTarget as HTMLElement })}>Move</button>
              <button className="link-btn danger" onClick={() => remove(pickedChats)}>Delete</button>
              <button className="link-btn" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
          )}
          <div className={`ch-scroll${dropOn === 'out' && fromGroup ? ' ch-drop-out' : ''}`} {...chatDrop(null)}>
            {chats.data && !chats.data.length && !groups.length && <div className="files-empty side-empty">Your conversations with Apollo will be listed here.</div>}
            {searching && !list.length && <div className="files-empty side-empty">No chat titles match.</div>}
            {shownGroups.map((g) => {
              const cs = inGroup.get(g.id) ?? [];
              if (searching && !cs.length) return null;
              const open = isOpen(g.id);
              const drag = reorderGroups.item(g.id);
              return (
                <section key={g.id} className={`chat-group${open ? ' open' : ''}${dropOn === g.id ? ' drop-into' : ''}`} {...chatDrop(g.id)}>
                  <button className="chat-group-head" aria-expanded={open} title={open ? `Hide “${g.name}”` : `Show “${g.name}”`}
                    onClick={() => setOpen(g.id, !open)} onContextMenu={(e) => groupMenu(e, g)}
                    draggable data-drop={drag['data-drop']} onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd}
                    onDragOver={drag.onDragOver} onDragLeave={drag.onDragLeave} onDrop={drag.onDrop}>
                    <span className="chat-group-caret"><Icon name="chevronRight" size={13} /></span>
                    <span className="chat-group-icon"><Icon name="chatGroup" size={14} /></span>
                    <span className="chat-group-name">{g.name}</span>
                    <span className="chat-group-count">{cs.length}</span>
                  </button>
                  {open && (
                    <div className="chat-group-list">
                      {cs.length ? cs.map(row) : <div className="chat-group-empty">Drag chats here, or right-click a chat and pick Move to group.</div>}
                    </div>
                  )}
                </section>
              );
            })}
            {buckets.map(([g, cs]) => (
              <div key={g}>
                <div className="ch-group">{g}</div>
                {cs.map(row)}
              </div>
            ))}
            {fromGroup && <div className="chat-ungroup-drop">Drop here to take it out of its group</div>}
          </div>
        </>
      )}
    </section>
  );
}
