import { useState } from 'react';
import { api, Doc, Subject, Topic, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import { useLibraryActions } from '../components/actions';
import FileList, { DOC_DRAG, DraggedDoc } from '../components/FileList';
import { MenuItem, useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import UploadDialog, { droppedPaths } from '../components/UploadDialog';
import { CREATE_ITEMS } from './SubjectView';

type UploadTarget = { title: string; target: { topic_id?: number; subject_id?: number }; mode: 'auto' | 'all'; paths?: string[] };

/** Right sidebar: revision to-do, reference library (textbooks), topics with their files. */
export default function ResourcePanel({ subject, go, onChange, onOpenDoc, onCreate, onDocsChanged }: {
  subject: Subject; go: (r: Route) => void; onChange: () => void; onOpenDoc: (id: number, focus?: string, details?: boolean) => void;
  onCreate: (tool: ToolName, topicId: number | null) => void; onDocsChanged: () => void;
}) {
  const ov = useOverlay();
  const act = useLibraryActions([subject], go, onChange);
  const refs = usePoll(() => api.referenceDocs(subject.id), 2500, [subject.id]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [refDrag, setRefDrag] = useState(false);

  const refresh = () => { refs.reload(); onChange(); onDocsChanged(); };
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const uploadRef = (paths?: string[]) =>
    setUpload({ title: `Add textbooks to ${subject.name}`, target: { subject_id: subject.id }, mode: 'all', paths });
  /** A file row dropped on a topic (topicId) or on the reference library (null). */
  const moveTo = async (d: DraggedDoc, topicId: number | null) => {
    if (topicId === null ? d.kind === 'reference' : d.kind === 'topic' && d.topic_id === topicId) return;
    try {
      await api.moveDocument(d.id, topicId);
      refresh();
      if (topicId !== null) setOpen((s) => new Set(s).add(topicId));
    } catch (e) {
      await ov.confirm({ title: `Couldn't move ${d.filename}`, body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };
  /** Drop handler for a topic or the reference library: moves a dragged file row, or uploads files from the OS. */
  const dropOn = (topicId: number | null, upload: (paths: string[]) => void) => (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes(DOC_DRAG)) moveTo(JSON.parse(e.dataTransfer.getData(DOC_DRAG)), topicId);
    else upload(droppedPaths(e));
  };
  const subjectMenu: MenuItem[] = [
    { label: 'New topic…', onClick: () => act.newTopic(subject) },
    { label: 'Add textbook…', onClick: () => uploadRef() },
    { label: 'Rename subject…', onClick: () => act.renameSubject(subject), separatorBefore: true },
    { label: 'Delete subject', onClick: () => act.deleteSubject(subject), danger: true },
  ];

  return (
    <aside className="side side-right">
      <div className="side-head" onContextMenu={(e) => ov.menu(e, subjectMenu)}>
        <SubjectIcon s={subject} size={30} />
        <div className="side-title">{subject.name}</div>
        <button className="icon-btn" title="Subject options" onClick={(e) => ov.menu(e, subjectMenu)}>⋯</button>
      </div>

      <div className="side-scroll">
        <Todos subject={subject} />

        <section className={`side-section${refDrag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setRefDrag(true); }} onDragLeave={() => setRefDrag(false)}
          onDrop={(e) => { setRefDrag(false); dropOn(null, uploadRef)(e); }}>
          <div className="side-section-head">
            <span>Reference library <StaleBadge count={subject.stale_reference_docs} where="the reference library"
              onReingest={async () => { await api.reingestStale(subject.id, { reference: true }); refresh(); }} /></span>
            <button className="icon-btn" title="Add textbook" onClick={() => uploadRef()}>+</button>
          </div>
          <FileList compact docs={refs.data ?? []} onChange={refresh} onOpen={(d) => onOpenDoc(d.id)}
            onDetails={(d) => onOpenDoc(d.id, undefined, true)}
            empty="Drop textbooks here." />
        </section>

        <section className="side-section">
          <div className="side-section-head">
            <span>Topics</span>
            <button className="icon-btn" title="New topic" onClick={() => act.newTopic(subject)}>+</button>
          </div>
          {subject.topics.length === 0 && <div className="files-empty">No topics yet.</div>}
          {subject.topics.map((t) => (
            <TopicRow key={t.id} topic={t} open={open.has(t.id)} onToggle={() => toggle(t.id)}
              onUpload={(paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths })}
              onCreate={(tool) => onCreate(tool, t.id)} onOpenDoc={(d) => onOpenDoc(d.id)}
              onDetails={(d) => onOpenDoc(d.id, undefined, true)}
              onDrop={dropOn(t.id, (paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths }))}
              onRename={() => act.renameTopic(t)} onDelete={() => act.deleteTopic(t)} onChange={refresh} />
          ))}
        </section>
      </div>

      {upload && (
        <UploadDialog title={upload.title} target={upload.target} defaultMode={upload.mode} initialPaths={upload.paths}
          onClose={() => setUpload(null)} onDone={() => {
            refresh();
            if (upload.target.topic_id) setOpen((s) => new Set(s).add(upload.target.topic_id!));
          }} />
      )}
    </aside>
  );
}

function TopicRow({ topic, open, onToggle, onUpload, onCreate, onOpenDoc, onDetails, onDrop, onRename, onDelete, onChange }: {
  topic: Topic; open: boolean; onToggle: () => void; onUpload: (paths?: string[]) => void; onCreate: (tool: ToolName) => void;
  onOpenDoc: (d: Doc) => void; onDetails: (d: Doc) => void; onDrop: (e: React.DragEvent) => void;
  onRename: () => void; onDelete: () => void; onChange: () => void;
}) {
  const ov = useOverlay();
  const [drag, setDrag] = useState(false);
  const createMenu: MenuItem[] = CREATE_ITEMS.map((c) => ({ label: c.label, onClick: () => onCreate(c.tool) }));
  const fullMenu: MenuItem[] = [
    { label: open ? 'Hide files' : 'Show files', onClick: onToggle },
    { label: 'Upload files…', onClick: () => onUpload() },
    ...createMenu.map((m, i) => ({ ...m, label: `Create ${m.label.toLowerCase()}`, separatorBefore: i === 0 })),
    { label: 'Rename…', onClick: onRename, separatorBefore: true },
    { label: 'Delete topic', onClick: onDelete, danger: true },
  ];
  return (
    <div className={`topic${open ? ' open' : ''}${drag ? ' drag' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { setDrag(false); onDrop(e); }}>
      <div className="topic-row" onClick={onToggle} onContextMenu={(e) => ov.menu(e, fullMenu)}>
        <span className="topic-caret">{open ? '▾' : '▸'}</span>
        <span className="topic-name">{topic.name}</span>
        <StaleBadge count={topic.stale_docs} where={topic.name}
          onReingest={async () => { await api.reingestStale(topic.subject_id, { topic_id: topic.id }); onChange(); }} />
        <span className="topic-count">{topic.doc_count ?? 0}</span>
        <span className="topic-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" data-tip="Upload files" onClick={() => onUpload()}>⇪</button>
          <button className="icon-btn icon-accent" data-tip="Create…" onClick={(e) => ov.menu(e, createMenu)}>✦</button>
        </span>
      </div>
      {open && <TopicFiles topicId={topic.id} onOpen={onOpenDoc} onDetails={onDetails} onChange={onChange} />}
    </div>
  );
}

function TopicFiles({ topicId, onOpen, onDetails, onChange }: {
  topicId: number; onOpen: (d: Doc) => void; onDetails: (d: Doc) => void; onChange: () => void;
}) {
  const docs = usePoll(() => api.topicDocs(topicId), 2500, [topicId]);
  return (
    <div className="topic-files">
      <FileList compact docs={docs.data ?? []} onOpen={onOpen} onDetails={onDetails} onChange={() => { docs.reload(); onChange(); }}
        empty="No files yet. Drop files on the topic." />
    </div>
  );
}

function Todos({ subject }: { subject: Subject }) {
  const ov = useOverlay();
  const todos = usePoll(() => api.todos(subject.id), 4000, [subject.id]);
  const [adding, setAdding] = useState('');
  const list = todos.data ?? [];
  const pending = list.filter((t) => !t.done).length;
  return (
    <section className="side-section">
      <div className="side-section-head">
        <span>Revision to-do {pending > 0 && <span className="count-badge">{pending}</span>}</span>
      </div>
      <div className="todos">
        {list.map((t) => (
          <div key={t.id} className={`todo${t.done ? ' done' : ''}`} title={t.note || undefined}
            onContextMenu={(e) => ov.menu(e, [
              { label: 'Edit…', onClick: async () => {
                const text = await ov.prompt({ title: 'Edit to-do', initial: t.text });
                if (text) { await api.setTodo(t.id, { text }); todos.reload(); }
              } },
              { label: 'Delete', danger: true, onClick: async () => { await api.deleteTodo(t.id); todos.reload(); } },
            ])}>
            <input type="checkbox" checked={!!t.done} onChange={async (e) => { await api.setTodo(t.id, { done: e.target.checked }); todos.reload(); }} />
            <span className="todo-text">{t.text}{t.topic_name && <span className="todo-topic">{t.topic_name}</span>}</span>
            <button className="x-btn todo-x" title="Remove" onClick={async () => { await api.deleteTodo(t.id); todos.reload(); }}>×</button>
          </div>
        ))}
        <input className="todo-add" placeholder="+ Add a to-do" value={adding} onChange={(e) => setAdding(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && adding.trim()) { await api.addTodo(subject.id, { text: adding.trim() }); setAdding(''); todos.reload(); }
          }} />
      </div>
    </section>
  );
}
