import { useEffect, useRef, useState } from 'react';
import { api, Doc, FolderMap, Subject, Topic, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import { useLibraryActions } from '../components/actions';
import type { CloudFocus } from '../components/EmbeddingCloud';
import FileList, { asDragged, DOC_DRAG, DraggedDoc, draggedDocs, isPickClick, Picker } from '../components/FileList';
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

  // Shift/Ctrl multi-selection of files (`d:<id>`) and folders (`f:<id>`). Rows register what they show, so a
  // selection can be acted on even after its rows collapse away.
  const asideRef = useRef<HTMLElement>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const seenDocs = useRef(new Map<number, Doc>());
  const seenFolders = useRef(new Map<string, { folder: Folder; topicId: number }>());
  const clearPicked = () => setPicked((p) => (p.size ? new Set() : p));
  useEffect(() => { setPicked(new Set()); anchor.current = null; }, [subject.id]);
  useEffect(() => {
    if (!picked.size) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) setPicked(new Set()); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [picked.size]);

  /** Folders are display only: saved as one blob per subject, never read by the backend. */
  const saveFolders = (topicId: number, f: TopicFolders) => {
    const next = { ...foldersRef.current, [topicId]: f };
    foldersRef.current = next;
    setFolders(next);
    api.saveFolders(subject.id, next).catch((e) =>
      ov.confirm({ title: "Couldn't save folders", body: `${String(e).replace(/^Error: /, '')}. Restart the app if it was just updated.`, confirmText: 'OK' }));
  };

  const refresh = () => { refs.reload(); onChange(); onDocsChanged(); };
  const editFolders = (topicId: number, fn: (f: TopicFolders) => TopicFolders) =>
    saveFolders(topicId, fn(foldersRef.current[topicId] ?? EMPTY_FOLDERS));
  /** Take a file out of whatever folder it was in (in its current topic). */
  const unfile = (d: { id: number; topic_id: number | null; kind: string }) => {
    if (d.kind === 'topic' && d.topic_id !== null && foldersRef.current[d.topic_id]?.files[d.id])
      editFolders(d.topic_id, (f) => ({ ...f, files: without(f.files, d.id) }));
  };
  const dropFolder = (topicId: number, fid: string) => editFolders(topicId, (f) => ({
    folders: f.folders.filter((x) => x.id !== fid), files: Object.fromEntries(Object.entries(f.files).filter(([, v]) => v !== fid)) }));
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const uploadRef = (paths?: string[]) =>
    setUpload({ title: `Add textbooks to ${subject.name}`, target: { subject_id: subject.id }, mode: 'all', paths });
  /** Move files to a topic (topicId) or the reference library (null); a file that changes topic leaves its folder.
   * Resolves to the ids that are now there (failures are reported). */
  const moveTo = async (ds: DraggedDoc[], topicId: number | null) => {
    const ok: number[] = [], failed: string[] = [];
    for (const d of ds) {
      if (topicId === null ? d.kind === 'reference' : d.kind === 'topic' && d.topic_id === topicId) { ok.push(d.id); continue; }
      try {
        await api.moveDocument(d.id, topicId);
        unfile(d);
        ok.push(d.id);
      } catch (e) {
        failed.push(`${d.filename}: ${String(e).replace(/^Error: /, '')}`);
      }
    }
    if (ok.length) refresh();
    if (ok.length && topicId !== null) setOpen((s) => new Set(s).add(topicId));
    if (failed.length) await ov.confirm({ title: `Couldn't move ${failed.length === 1 ? 'a file' : `${failed.length} files`}`, body: failed.join('\n'), confirmText: 'OK' });
    return ok;
  };
  /** Drop handler for a topic or the reference library: moves dragged file rows, or uploads files from the OS. */
  const dropOn = (topicId: number | null, upload: (paths: string[]) => void) => (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes(DOC_DRAG)) moveTo(draggedDocs(e), topicId);
    else upload(droppedPaths(e));
  };

  /* ------------------------------------------------ bulk actions on the multi-selection */
  const folderDocs = (fid: string, topicId: number) =>
    [...seenDocs.current.values()].filter((d) => d.kind === 'topic' && d.topic_id === topicId && foldersRef.current[topicId]?.files[d.id] === fid);
  /** The picked folders, and the picked files not already inside a picked folder. */
  const pickedItems = () => {
    const fs = [...picked].filter((k) => k.startsWith('f:')).map((k) => seenFolders.current.get(k.slice(2)))
      .filter((x): x is { folder: Folder; topicId: number } => !!x && !!foldersRef.current[x.topicId]?.folders.some((f) => f.id === x.folder.id));
    const inFolders = new Set(fs.flatMap((f) => folderDocs(f.folder.id, f.topicId).map((d) => d.id)));
    const ds = [...picked].filter((k) => k.startsWith('d:')).map((k) => seenDocs.current.get(Number(k.slice(2))))
      .filter((d): d is Doc => !!d && !inFolders.has(d.id));
    return { docs: ds, folders: fs, allDocs: [...ds, ...fs.flatMap((f) => folderDocs(f.folder.id, f.topicId))] };
  };
  const moveTopic = async (topicId: number | null) => {
    const { docs, folders: fs } = pickedItems();
    clearPicked();
    await moveTo(docs.map(asDragged), topicId);
    for (const { folder, topicId: from } of fs) {
      if (from === topicId) continue;
      const moved = await moveTo(folderDocs(folder.id, from).map(asDragged), topicId);
      dropFolder(from, folder.id);
      if (topicId !== null) { // the folder goes along, under the same name
        const id = newId();
        editFolders(topicId, (f) => ({ folders: [...f.folders, { id, name: folder.name }], files: { ...f.files, ...Object.fromEntries(moved.map((m) => [m, id])) } }));
      }
    }
  };
  const moveToFolder = async (fid: string, topicId: number) => {
    const docs = pickedItems().docs;
    clearPicked();
    const moved = await moveTo(docs.map(asDragged), topicId);
    editFolders(topicId, (f) => ({ ...f, files: { ...f.files, ...Object.fromEntries(moved.map((m) => [m, fid])) } }));
  };
  const deletePicked = async () => {
    const { docs, folders: fs } = pickedItems();
    const parts = [docs.length && `${docs.length} file${docs.length === 1 ? '' : 's'}`, fs.length && `${fs.length} folder${fs.length === 1 ? '' : 's'}`].filter(Boolean);
    if (!parts.length) return clearPicked();
    const ok = await ov.confirm({ title: `Delete ${parts.join(' and ')}?`, confirmText: 'Delete', danger: true,
      body: `${docs.length ? 'Files lose their extracted text, embeddings and vision notes. ' : ''}${fs.length ? 'Files inside the deleted folders stay in their topic.' : ''}` });
    if (!ok) return;
    clearPicked();
    for (const d of docs) { await api.deleteDocument(d.id).catch(() => undefined); unfile(d); }
    for (const { folder, topicId } of fs) dropFolder(topicId, folder.id);
    if (docs.some((d) => sel.focus?.kind === 'doc' && sel.focus.id === d.id)) sel.onFocus(null);
    refresh();
  };
  const moveItems = (): MenuItem[] => {
    const { docs, folders: fs } = pickedItems();
    const allFolders = subject.topics.flatMap((t) => [...(foldersRef.current[t.id]?.folders ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((f) => ({ f, t })));
    return [
      ...subject.topics.map((t) => ({ label: `Move to topic “${t.name}”`, onClick: () => moveTopic(t.id) })),
      ...(!fs.length ? [{ label: 'Move to reference library', onClick: () => moveTopic(null) }] : []),
      ...(!fs.length ? allFolders.map(({ f, t }, i) => ({ label: `Move to folder “${t.name} › ${f.name}”`, onClick: () => moveToFolder(f.id, t.id), separatorBefore: i === 0 })) : []),
      ...(docs.some((d) => d.topic_id !== null && foldersRef.current[d.topic_id]?.files[d.id])
        ? [{ label: 'Remove from folder', onClick: () => { docs.forEach(unfile); clearPicked(); }, separatorBefore: true }] : []),
    ];
  };
  const bulkMenu = (): MenuItem[] => [
    ...moveItems(),
    { label: 'Clear selection', onClick: clearPicked, separatorBefore: true },
    { label: `Delete ${picked.size} selected`, onClick: deletePicked, danger: true },
  ];
  const picker: SidePicker = {
    has: (k) => picked.has(k),
    click: (key, e) => {
      const focusKey = sel.focus?.kind === 'doc' ? `d:${sel.focus.id}` : sel.focus?.kind === 'folder' ? `f:${sel.focus.id}` : null;
      const from = anchor.current ?? focusKey;
      if (e.shiftKey && from && asideRef.current) {
        const keys = [...asideRef.current.querySelectorAll<HTMLElement>('[data-pick]')].map((el) => el.dataset.pick!);
        const a = keys.indexOf(from), b = keys.indexOf(key);
        if (a >= 0 && b >= 0) {
          const range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
          setPicked((p) => new Set([...(e.ctrlKey || e.metaKey ? p : []), ...range]));
          anchor.current = from;
          return;
        }
      }
      // Ctrl/⌘ toggles; the first one also takes in the file or folder that was already selected
      setPicked((p) => {
        const n = new Set(p.size || !focusKey || !document.querySelector(`[data-pick="${focusKey}"]`) ? p : [focusKey]);
        if (n.has(key) && key !== focusKey) n.delete(key); else n.add(key);
        return n;
      });
      anchor.current = key;
    },
    register: (d) => { seenDocs.current.set(d.id, d); },
    registerFolder: (folder, topicId) => { seenFolders.current.set(folder.id, { folder, topicId }); },
    setAnchor: (key) => { anchor.current = key; },
    menu: (k) => (picked.has(k) && picked.size > 1 ? bulkMenu() : null),
    drag: (d) => (picked.has(`d:${d.id}`) && picked.size > 1 ? pickedItems().allDocs.map(asDragged) : null),
  };
  const subjectMenu: MenuItem[] = [
    { label: 'New topic…', onClick: () => act.newTopic(subject) },
    { label: 'Add textbook…', onClick: () => uploadRef() },
    { label: 'Rename subject…', onClick: () => act.renameSubject(subject), separatorBefore: true },
    { label: 'Delete subject', onClick: () => act.deleteSubject(subject), danger: true },
  ];
  /** A file click: narrow the cloud to it, and open it straight away unless the cloud is what's showing. */
  const selectDoc = (d: Doc) => {
    anchor.current = `d:${d.id}`;
    sel.onFocus({ kind: 'doc', id: d.id, name: d.filename });
    if (!sel.cloudVisible) onOpenDoc(d.id);
  };
  const files: FileProps = { onSelect: selectDoc, selectedId: sel.focus?.kind === 'doc' ? sel.focus.id : null, openId: sel.openId, picker };

  return (
    <aside ref={asideRef} className="side side-right" onClick={(e) => {
      const t = e.target as Element;
      if (t.closest('.modal-backdrop, .pick-bar')) return;
      if (!isPickClick(e)) clearPicked(); // a plain click anywhere ends a multi-selection
      // anything that isn't a topic name, folder or file (or inside a dialog opened from here) shows the whole subject
      if (!t.closest('[data-focus]')) sel.onFocus(null);
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

      {picked.size > 0 && (
        <div className="pick-bar" role="toolbar" aria-label="Selected files and folders">
          <span className="pick-count">{picked.size} selected</span>
          <button className="btn btn-sm" onClick={(e) => ov.menu(e, moveItems(), { anchor: e.currentTarget, place: 'above' })}>Move to…</button>
          <button className="btn btn-sm btn-danger" onClick={deletePicked}>Delete</button>
          <button className="icon-btn" title="Clear selection (Esc)" onClick={clearPicked}>×</button>
        </div>
      )}

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

type SidePicker = Picker & { registerFolder: (f: Folder, topicId: number) => void; setAnchor: (key: string) => void };
type FileProps = { onSelect: (d: Doc) => void; selectedId: number | null; openId: number | null; picker: SidePicker };
type Folder = TopicFolders['folders'][number];
const EMPTY_FOLDERS: TopicFolders = { folders: [], files: {} };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const without = (files: Record<string, string>, docId: number) => Object.fromEntries(Object.entries(files).filter(([k]) => k !== String(docId)));

function TopicRow({ topic, color, open, focused, onToggle, onFocus, onUpload, onCreate, onOpenDoc, onDetails, onDrop, onMoveHere,
  folders, onFolders, files, sel, onRename, onDelete, onChange }: {
  topic: Topic; color: string; open: boolean; focused: boolean; onToggle: () => void; onFocus: () => void;
  onUpload: (paths?: string[]) => void; onCreate: (tool: ToolName) => void;
  onOpenDoc: (d: Doc) => void; onDetails: (d: Doc) => void; onDrop: (e: React.DragEvent) => void;
  onMoveHere: (ds: DraggedDoc[]) => Promise<number[]>; folders: TopicFolders; onFolders: (f: TopicFolders) => void;
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
        // files of this topic dropped outside its folders leave their folder; others move here
        const ds = draggedDocs(e);
        if (!ds.length) return onDrop(e);
        e.preventDefault();
        const mine = ds.filter((d) => d.kind === 'topic' && d.topic_id === topic.id);
        if (mine.some((d) => folders.files[d.id]))
          onFolders({ ...folders, files: Object.fromEntries(Object.entries(folders.files).filter(([k]) => !mine.some((d) => String(d.id) === k))) });
        const rest = ds.filter((d) => !mine.includes(d));
        if (rest.length) onMoveHere(rest);
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
  folders: TopicFolders; onFolders: (f: TopicFolders) => void; onMoveHere: (ds: DraggedDoc[]) => Promise<number[]>;
  files: FileProps; sel: Selection;
}) {
  const ov = useOverlay();
  const docs = usePoll(() => api.topicDocs(topicId), 2500, [topicId]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const list = docs.data ?? [];
  list.forEach(files.picker.register); // so a picked, collapsed folder still knows its files
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
  const pk = files.picker;

  return (
    <div className="topic-files">
      {sorted.map((f) => {
        const inside = list.filter((d) => folderOf(d) === f.id);
        const isOpen = !closed.has(f.id);
        const focused = sel.focus?.kind === 'folder' && sel.focus.id === f.id;
        const key = `f:${f.id}`;
        pk.registerFolder(f, topicId);
        return (
          <div key={f.id} className={`folder${isOpen ? ' open' : ''}${over === f.id ? ' drag' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DOC_DRAG)) { e.preventDefault(); e.stopPropagation(); setOver(f.id); } }}
            onDragLeave={() => setOver(null)}
            onDrop={async (e) => {
              const ds = draggedDocs(e);
              if (!ds.length) return;
              e.preventDefault(); e.stopPropagation(); setOver(null);
              const moved = await onMoveHere(ds);
              if (moved.length) onFolders({ ...folders, files: { ...folders.files, ...Object.fromEntries(moved.map((m) => [m, f.id])) } });
            }}>
            <div className={`folder-row${focused ? ' focused' : ''}${pk.has(key) ? ' picked' : ''}`} data-focus data-pick={key}
              onClick={(e) => {
                if (isPickClick(e)) return pk.click(key, e);
                pk.setAnchor(key);
                toggle(f.id); sel.onFocus({ kind: 'folder', id: f.id, docs: inside.map((d) => d.id), name: f.name });
              }}
              onContextMenu={(e) => { const bulk = pk.menu(key); if (bulk) return ov.menu(e, bulk); ov.menu(e, [
                { label: isOpen ? 'Collapse' : 'Expand', onClick: () => toggle(f.id) },
                { label: 'Rename…', onClick: () => rename(f), separatorBefore: true },
                { label: 'Delete folder', onClick: () => remove(f), danger: true },
              ]); }}>
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
