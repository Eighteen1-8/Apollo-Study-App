import { useState } from 'react';
import { api, ArtifactType, LibraryItem, Subject } from '../api';
import { usePoll } from '../hooks';
import { useOverlay } from '../components/overlay';

export const TYPE_ICON: Record<ArtifactType, string> = { flashcards: '▤', quiz: '?', exam: '✎', notes: '¶', cheatsheet: '≡' };
const TYPE_LABEL: Record<ArtifactType, string> = { flashcards: 'Flashcards', quiz: 'Quiz', exam: 'Exam', notes: 'Notes', cheatsheet: 'Cheat sheet' };

/** Left sidebar: everything generated for this subject, grouped by the topic it was made from. */
export default function LibraryPanel({ subject, onOpen }: { subject: Subject; onOpen: (id: number) => void }) {
  const ov = useOverlay();
  const lib = usePoll(() => api.library(subject.id), 3000, [subject.id]);
  const items = lib.data ?? [];
  const key = `libCollapsed:${subject.id}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); }
  });
  const toggle = (name: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(name)) n.delete(name); else n.add(name);
    try { localStorage.setItem(key, JSON.stringify([...n])); } catch { /* storage unavailable */ }
    return n;
  });

  const groups = new Map<string, LibraryItem[]>();
  for (const t of subject.topics) groups.set(t.name, []);
  for (const it of items) {
    const key = it.topic_name ?? 'All topics';
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }

  const menu = (e: React.MouseEvent, it: LibraryItem) => ov.menu(e, [
    { label: 'Open', disabled: it.status !== 'ready', onClick: () => onOpen(it.id) },
    { label: 'Regenerate', disabled: it.status === 'queued' || it.status === 'running', onClick: async () => { await api.retryArtifact(it.id); lib.reload(); } },
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
      <div className="side-head"><div className="side-title">Generated</div></div>
      <div className="side-scroll">
        {items.length === 0 && (
          <div className="files-empty side-empty">
            Flashcards, quizzes, exams and notes you create in chat are saved here, grouped by topic.
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
                  onContextMenu={(e) => menu(e, it)} title={busy ? it.message : it.status === 'failed' ? 'Failed: right-click to delete' : ''}>
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
