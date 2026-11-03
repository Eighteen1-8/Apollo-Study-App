import { useState } from 'react';
import { api, ArtifactType, Chat, LibraryItem, Subject } from '../api';
import { usePoll } from '../hooks';
import { useOverlay } from '../components/overlay';
import { artifactHtml, exportAs, ExportFormat } from '../components/exportDoc';
import { getPref, setPref } from '../prefs';

export const TYPE_ICON: Record<ArtifactType, string> = { flashcards: '▤', quiz: '?', exam: '✎', notes: '¶', cheatsheet: '≡', mindmap: '✺' };
const TYPE_LABEL: Record<ArtifactType, string> = { flashcards: 'Flashcards', quiz: 'Quiz', exam: 'Exam', notes: 'Notes', cheatsheet: 'Cheat sheet', mindmap: 'Mind map' };
const EXPORTABLE: ArtifactType[] = ['notes', 'cheatsheet', 'exam'];

/** The chat the centre shows, and how the sidebar opens or starts one. */
export interface ChatNav { activeId: number | null; onOpen: (id: number) => void; onNew: () => void }

/** Left sidebar: the subject's chats (searchable, newest first) above everything generated for it, grouped by topic. */
export default function LibraryPanel({ subject, onOpen, chats }: { subject: Subject; onOpen: (id: number) => void; chats: ChatNav }) {
  const ov = useOverlay();
  const lib = usePoll(() => api.library(subject.id), 1000, [subject.id], ['library']);
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

  const groups = new Map<string, LibraryItem[]>();
  for (const t of subject.topics) groups.set(t.name, []);
  for (const it of items) {
    const key = it.topic_name ?? 'All topics';
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }

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
      if (t) { await api.renameArtifact(it.id, t); lib.reload(); }
    } },
    { label: 'Delete', danger: true, separatorBefore: true, onClick: async () => {
      if (await ov.confirm({ title: `Delete ${it.title}?`, danger: true, confirmText: 'Delete', body: 'Ratings and attempts for it are deleted too.' })) {
        await api.deleteArtifact(it.id);
        lib.reload();
      }
    } },
  ]);

  return (
    <aside className="side side-left">
      <ChatHistory subject={subject} nav={chats} />
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
            {!hidden.has(name) && list.map((it) => {
              const busy = it.status === 'queued' || it.status === 'running';
              // Default titles are "Type: Topic (extra)"; inside a topic group the topic part is redundant.
              const rest = it.title.replace(/^[^:]+:\s*/, '');
              const extra = it.topic_name && rest.startsWith(it.topic_name) ? rest.slice(it.topic_name.length).trim() : rest;
              const title = it.title.includes(':') ? `${TYPE_LABEL[it.type]}${extra ? ` ${extra}` : ''}` : it.title;
              const date = new Date(it.created_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
              return (
                <button key={it.id} className={`lib-item status-${it.status}`} onClick={() => it.status === 'ready' && onOpen(it.id)}
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

/** The subject's chats: search by title, grouped by when they were last used; right-click to rename or delete. */
function ChatHistory({ subject, nav }: { subject: Subject; nav: ChatNav }) {
  const ov = useOverlay();
  const chats = usePoll(() => api.chats(subject.id), 600, [subject.id], ['chats']);
  const [q, setQ] = useState('');
  const [folded, setFolded] = useState(() => getPref('chatsFolded', false, (v) => v === '1'));
  const list = (chats.data ?? []).filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()));
  const topic = (id: number | null) => subject.topics.find((t) => t.id === id)?.name;

  const groups: [string, Chat[]][] = [];
  for (const c of list) {
    const g = when(c.updated_at);
    if (groups.length && groups[groups.length - 1][0] === g) groups[groups.length - 1][1].push(c);
    else groups.push([g, [c]]);
  }

  const menu = (e: React.MouseEvent, c: Chat) => ov.menu(e, [
    { label: 'Open', onClick: () => nav.onOpen(c.id) },
    { label: 'Rename…', onClick: async () => {
      const t = await ov.prompt({ title: 'Rename chat', initial: c.title });
      if (t) { await api.renameChat(c.id, t); chats.reload(); }
    } },
    { label: 'Delete', danger: true, separatorBefore: true, onClick: async () => {
      if (await ov.confirm({ title: `Delete “${c.title}”?`, danger: true, confirmText: 'Delete', body: 'Generated content stays in the library.' })) {
        await api.deleteChat(c.id);
        chats.reload();
        if (c.id === nav.activeId) nav.onNew();
      }
    } },
  ]);
  const fold = () => { setFolded(!folded); setPref('chatsFolded', folded ? '0' : '1'); };

  return (
    <section className={`chat-history${folded ? ' folded' : ''}`}>
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
          <div className="ch-scroll">
            {chats.data && !chats.data.length && <div className="files-empty side-empty">Your conversations with Apollo will be listed here.</div>}
            {q && !list.length && <div className="files-empty side-empty">No chat titles match.</div>}
            {groups.map(([g, cs]) => (
              <div key={g}>
                <div className="ch-group">{g}</div>
                {cs.map((c) => (
                  <button key={c.id} className={`ch-item${c.id === nav.activeId ? ' active' : ''}`} title={c.title}
                    onClick={() => nav.onOpen(c.id)} onContextMenu={(e) => menu(e, c)}>
                    <span className="ch-name">{c.title}</span>
                    {topic(c.topic_id) && <span className="ch-topic">{topic(c.topic_id)}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
