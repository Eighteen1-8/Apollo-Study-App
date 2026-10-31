import { useEffect, useRef, useState } from 'react';
import { api, Doc, FolderMap, Subject, Topic, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import { useLibraryActions } from '../components/actions';
import type { CloudFocus } from '../components/EmbeddingCloud';
import FileList, { DOC_DRAG, DraggedDoc } from '../components/FileList';
import { MenuItem, useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import UploadDialog, { droppedPaths } from '../components/UploadDialog';
import { topicColor } from '../theme';
import { CREATE_ITEMS } from './SubjectView';

type UploadTarget = { title: string; target: { topic_id?: number; subject_id?: number }; mode: 'auto' | 'all'; paths?: string[] };
type TopicFolders = FolderMap[string];

/** What a sidebar file click does, and what the sidebar shows as selected / open. With the knowledge cloud showing,
 * a click narrows the cloud to the file and a double-click opens it; with a file already open, a click switches. */
export interface Selection {
  focus: CloudFocus; onFocus: (f: CloudFocus) => void; cloudVisible: boolean; openId: number | null;
}

/** Right sidebar: revision to-do, reference library (textbooks), topics with their files and folders. Clicking a
 * topic name, folder or file narrows the subject's cloud to it; a click anywhere else in the sidebar resets it. */
export default function ResourcePanel({ subject, go, onChange, onOpenDoc, onCreate, onDocsChanged, sel }: {
  subject: Subject; go: (r: Route) => void; onChange: () => void; onOpenDoc: (id: number, focus?: string, details?: boolean) => void;
  onCreate: (tool: ToolName, topicId: number | null) => void; onDocsChanged: () => void; sel: Selection;
}) {
  const ov = useOverlay();
  const act = useLibraryActions([subject], go, onChange);
  const refs = usePoll(() => api.referenceDocs(subject.id), 2500, [subject.id]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [refDrag, setRefDrag] = useState(false);
  const [folders, setFolders] = useState<FolderMap>({});
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  useEffect(() => { api.folders(subject.id).then(setFolders).catch(() => setFolders({})); }, [subject.id]);

  /** Folders are display only: saved as one blob per subject, never read by the backend. */
  const saveFolders = (topicId: number, f: TopicFolders) => {
    const next = { ...foldersRef.current, [topicId]: f };
    foldersRef.current = next;
    setFolders(next);
    api.saveFolders(subject.id, next).catch((e) =>
      ov.confirm({ title: "Couldn't save folders", body: `${String(e).replace(/^Error: /, '')}. Restart the app if it was just updated.`, confirmText: 'OK' }));
  };

  const refresh = () => { refs.reload(); onChange(); onDocsChanged(); };
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const uploadRef = (paths?: string[]) =>
    setUpload({ title: `Add textbooks to ${subject.name}`, target: { subject_id: subject.id }, mode: 'all', paths });
  /** A file row dropped on a topic (topicId) or on the reference library (null). Resolves false if the move failed. */
  const moveTo = async (d: DraggedDoc, topicId: number | null) => {
    if (topicId === null ? d.kind === 'reference' : d.kind === 'topic' && d.topic_id === topicId) return true;
    try {
      await api.moveDocument(d.id, topicId);
      refresh();
      if (topicId !== null) setOpen((s) => new Set(s).add(topicId));
      return true;
    } catch (e) {
      await ov.confirm({ title: `Couldn't move ${d.filename}`, body: String(e).replace(/^Error: /, ''), confirmText: 'OK' });
      return false;
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
  /** A file click: narrow the cloud to it, and open it straight away unless the cloud is what's showing. */
  const selectDoc = (d: Doc) => {
    sel.onFocus({ kind: 'doc', id: d.id, name: d.filename });
    if (!sel.cloudVisible) onOpenDoc(d.id);
  };
  const files: FileProps = { onSelect: selectDoc, selectedId: sel.focus?.kind === 'doc' ? sel.focus.id : null, openId: sel.openId };

  return (
    <aside className="side side-right" onClick={(e) => {
      // anything that isn't a topic name, folder or file (or inside a dialog opened from here) shows the whole subject
      if (!(e.target as Element).closest('[data-focus], .modal-backdrop')) sel.onFocus(null);
    }}>
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
          <FileList compact docs={refs.data ?? []} onChange={refresh} onOpen={(d) => onOpenDoc(d.id)} {...files}
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
            <TopicRow key={t.id} topic={t} color={topicColor(subject.topics, t.id)} open={open.has(t.id)}
              focused={sel.focus?.kind === 'topic' && sel.focus.id === t.id}
              onToggle={() => toggle(t.id)} onFocus={() => sel.onFocus({ kind: 'topic', id: t.id, name: t.name })}
              onUpload={(paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths })}
              onCreate={(tool) => onCreate(tool, t.id)} onOpenDoc={(d) => onOpenDoc(d.id)}
              onDetails={(d) => onOpenDoc(d.id, undefined, true)}
              onDrop={dropOn(t.id, (paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths }))}
              onMoveHere={(d) => moveTo(d, t.id)}
              folders={folders[t.id] ?? EMPTY_FOLDERS} onFolders={(f) => saveFolders(t.id, f)}
              files={files} sel={sel}
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

type FileProps = { onSelect: (d: Doc) => void; selectedId: number | null; openId: number | null };
type Folder = TopicFolders['folders'][number];
const EMPTY_FOLDERS: TopicFolders = { folders: [], files: {} };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const draggedDoc = (e: React.DragEvent): DraggedDoc | null =>
  e.dataTransfer.types.includes(DOC_DRAG) ? JSON.parse(e.dataTransfer.getData(DOC_DRAG)) : null;
const without = (files: Record<string, string>, docId: number) => Object.fromEntries(Object.entries(files).filter(([k]) => k !== String(docId)));

function TopicRow({ topic, color, open, focused, onToggle, onFocus, onUpload, onCreate, onOpenDoc, onDetails, onDrop, onMoveHere,
  folders, onFolders, files, sel, onRename, onDelete, onChange }: {
  topic: Topic; color: string; open: boolean; focused: boolean; onToggle: () => void; onFocus: () => void;
  onUpload: (paths?: string[]) => void; onCreate: (tool: ToolName) => void;
  onOpenDoc: (d: Doc) => void; onDetails: (d: Doc) => void; onDrop: (e: React.DragEvent) => void;
  onMoveHere: (d: DraggedDoc) => Promise<boolean>; folders: TopicFolders; onFolders: (f: TopicFolders) => void;
  files: FileProps; sel: Selection; onRename: () => void; onDelete: () => void; onChange: () => void;
}) {
  const ov = useOverlay();
  const [drag, setDrag] = useState(false);
  const newFolder = async () => {
    const name = (await ov.prompt({ title: `New folder in ${topic.name}`, placeholder: 'e.g. Week 1 lectures', confirmText: 'Create folder' }))?.trim();
    if (!name) return;
    onFolders({ ...folders, folders: [...folders.folders, { id: newId(), name }] });
    if (!open) onToggle();
  };
  const createMenu: MenuItem[] = CREATE_ITEMS.map((c) => ({ label: c.label, onClick: () => onCreate(c.tool) }));
  const fullMenu: MenuItem[] = [
    { label: open ? 'Hide files' : 'Show files', onClick: onToggle },
    { label: 'Upload files…', onClick: () => onUpload() },
    { label: 'New folder…', onClick: newFolder },
    ...createMenu.map((m, i) => ({ ...m, label: `Create ${m.label.toLowerCase()}`, separatorBefore: i === 0 })),
    { label: 'Rename…', onClick: onRename, separatorBefore: true },
    { label: 'Delete topic', onClick: onDelete, danger: true },
  ];
  return (
    <div className={`topic${open ? ' open' : ''}${drag ? ' drag' : ''}${focused ? ' focused' : ''}`} style={{ '--tint': color } as React.CSSProperties}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        // a file of this topic dropped outside its folders leaves its folder
        const d = draggedDoc(e);
        if (d && d.kind === 'topic' && d.topic_id === topic.id) {
          e.preventDefault();
          if (folders.files[d.id]) onFolders({ ...folders, files: without(folders.files, d.id) });
        } else onDrop(e);
      }}>
      <div className="topic-row" data-focus onClick={() => { onToggle(); onFocus(); }} onContextMenu={(e) => ov.menu(e, fullMenu)}>
        <span className="topic-caret">{open ? '▾' : '▸'}</span>
        <span className="topic-dot" aria-hidden />
        <span className="topic-name">{topic.name}</span>
        <StaleBadge count={topic.stale_docs} where={topic.name}
          onReingest={async () => { await api.reingestStale(topic.subject_id, { topic_id: topic.id }); onChange(); }} />
        <span className="topic-count">{topic.doc_count ?? 0}</span>
        <span className="topic-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" data-tip="New folder" onClick={newFolder}><FolderIcon /></button>
          <button className="icon-btn" data-tip="Upload files" onClick={() => onUpload()}>⇪</button>
          <button className="icon-btn icon-accent" data-tip="Create…" onClick={(e) => ov.menu(e, createMenu)}>✦</button>
        </span>
      </div>
      {open && <TopicFiles topicId={topic.id} onOpen={onOpenDoc} onDetails={onDetails} onChange={onChange}
        folders={folders} onFolders={onFolders} onMoveHere={onMoveHere} files={files} sel={sel} />}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z" />
    </svg>
  );
}

/** A topic's files: its folders (collapsible, display only) first, then the files in no folder. */
function TopicFiles({ topicId, onOpen, onDetails, onChange, folders, onFolders, onMoveHere, files, sel }: {
  topicId: number; onOpen: (d: Doc) => void; onDetails: (d: Doc) => void; onChange: () => void;
  folders: TopicFolders; onFolders: (f: TopicFolders) => void; onMoveHere: (d: DraggedDoc) => Promise<boolean>;
  files: FileProps; sel: Selection;
}) {
  const ov = useOverlay();
  const docs = usePoll(() => api.topicDocs(topicId), 2500, [topicId]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const list = docs.data ?? [];
  const sorted = [...folders.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const known = new Set(sorted.map((f) => f.id));
  const folderOf = (d: Doc) => (known.has(folders.files[d.id]) ? folders.files[d.id] : null);
  const reload = () => { docs.reload(); onChange(); };

  const place = (docId: number, folderId: string | null) =>
    onFolders({ ...folders, files: folderId ? { ...without(folders.files, docId), [docId]: folderId } : without(folders.files, docId) });
  const menu = (d: Doc): MenuItem[] => [
    ...sorted.filter((f) => f.id !== folderOf(d)).map((f) => ({ label: `Move to folder “${f.name}”`, onClick: () => place(d.id, f.id) })),
    ...(folderOf(d) ? [{ label: 'Remove from folder', onClick: () => place(d.id, null) }] : []),
  ];
  const rename = async (f: Folder) => {
    const name = (await ov.prompt({ title: 'Rename folder', initial: f.name }))?.trim();
    if (name) onFolders({ ...folders, folders: folders.folders.map((x) => (x.id === f.id ? { ...x, name } : x)) });
  };
  const remove = async (f: Folder) => {
    if (!await ov.confirm({ title: `Delete folder “${f.name}”?`, body: 'Its files stay in the topic; only the folder goes.', confirmText: 'Delete folder', danger: true })) return;
    onFolders({ folders: folders.folders.filter((x) => x.id !== f.id),
      files: Object.fromEntries(Object.entries(folders.files).filter(([, v]) => v !== f.id)) });
  };
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const props = { onOpen, onDetails, onChange: reload, menu, ...files };

  return (
    <div className="topic-files">
      {sorted.map((f) => {
        const inside = list.filter((d) => folderOf(d) === f.id);
        const isOpen = !closed.has(f.id);
        const focused = sel.focus?.kind === 'folder' && sel.focus.id === f.id;
        return (
          <div key={f.id} className={`folder${isOpen ? ' open' : ''}${over === f.id ? ' drag' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DOC_DRAG)) { e.preventDefault(); e.stopPropagation(); setOver(f.id); } }}
            onDragLeave={() => setOver(null)}
            onDrop={async (e) => {
              const d = draggedDoc(e);
              if (!d) return;
              e.preventDefault(); e.stopPropagation(); setOver(null);
              if (await onMoveHere(d)) place(d.id, f.id);
            }}>
            <div className={`folder-row${focused ? ' focused' : ''}`} data-focus
              onClick={() => { toggle(f.id); sel.onFocus({ kind: 'folder', id: f.id, docs: inside.map((d) => d.id), name: f.name }); }}
              onContextMenu={(e) => ov.menu(e, [
                { label: isOpen ? 'Collapse' : 'Expand', onClick: () => toggle(f.id) },
                { label: 'Rename…', onClick: () => rename(f), separatorBefore: true },
                { label: 'Delete folder', onClick: () => remove(f), danger: true },
              ])}>
              <span className="topic-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="folder-icon"><FolderIcon /></span>
              <span className="folder-name">{f.name}</span>
              <span className="topic-count">{inside.length}</span>
            </div>
            {isOpen && <div className="folder-files"><FileList compact docs={inside} {...props} empty="Drag files here." /></div>}
          </div>
        );
      })}
      {(list.some((d) => !folderOf(d)) || !sorted.length) && (
        <FileList compact docs={list.filter((d) => !folderOf(d))} {...props} empty="No files yet. Drop files on the topic." />
      )}
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
