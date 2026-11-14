import { useEffect, useRef, useState } from 'react';
import { toast } from '../components/toast';
import { undoable, undoEntry } from '../undo';
import { api, Doc, FolderMap, Subject, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import { useLibraryActions } from '../components/actions';
import type { CloudFocus } from '../components/EmbeddingCloud';
import FileList, { asDragged, DOC_DRAG, DraggedDoc, draggedDocs, isPickClick } from '../components/FileList';
import { MenuItem, useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import UploadDialog, { droppedPaths } from '../components/UploadDialog';
import { useReorder } from '../components/reorder';
import SplitHandle, { useSplit } from '../components/SplitHandle';
import { topicColor } from '../theme';
import { openFind } from '../components/FindBar';
import { logError } from '../log';
import { EMPTY_FOLDERS, FileProps, Folder, FolderOps, SidePicker, TopicRow } from './resources/topics';
import { MyNotes } from './resources/MyNotes';
import { Todos } from './resources/Todos';
import { FileSearchResults } from './resources/FileSearch';
import { useAdvanced } from '../theme';
import { useTerms } from '../terms';
import { getPref, setPref } from '../prefs';
import Icon from '../components/Icon';
import Info from '../components/Info';

type UploadTarget = { title: string; target: { topic_id?: number; subject_id?: number }; mode: 'auto' | 'all'; paths?: string[] };

/** What a sidebar file click does, and what the sidebar shows as selected / open. With the knowledge cloud showing,
 * a click narrows the cloud to the file and a double-click opens it; with a file already open, a click switches. */
export interface Selection {
  focus: CloudFocus; onFocus: (f: CloudFocus) => void; cloudVisible: boolean; openId: number | null;
}

/** Right sidebar: revision to-do, reference library (textbooks), topics with their files and folders, and the
 * student's own notes pinned at the bottom. Clicking a topic name, folder or file narrows the subject's cloud to it; a
 * click anywhere else in the sidebar resets it. */
export default function ResourcePanel({ subject, go, onChange, onOpenDoc, onCreate, onDocsChanged, onAddFiles, sel, notes, onOpenSplit, showTodos }: {
  /** The to-do list lives in the study panel; it's shown here only when the map (and so the panel) is turned off. */
  showTodos: boolean;
  onOpenSplit: (kind: 'note' | 'doc', id: number) => void;
  /** The "What are you adding?" dialog (SubjectView). */
  onAddFiles: () => void;
  subject: Subject; go: (r: Route) => void; onChange: () => void; onOpenDoc: (id: number, focus?: string, details?: boolean) => void;
  onCreate: (tool: ToolName, topicId: number | null) => void; onDocsChanged: () => void; sel: Selection;
  notes: { openId: number | null; onOpen: (id: number) => void };
}) {
  const ov = useOverlay();
  const advanced = useAdvanced();
  const tr = useTerms();
  const act = useLibraryActions([subject], go, onChange);
  const refs = usePoll(() => api.referenceDocs(subject.id), 1000, [subject.id], ['documents']);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [refDrag, setRefDrag] = useState(false);
  const [booksOpen, setBooksOpen] = useState(() => getPref<string>('booksFolded', '0') !== '1');
  const toggleBooks = () => setBooksOpen((v) => { setPref('booksFolded', v ? '1' : '0'); return !v; });
  const [folders, setFolders] = useState<FolderMap>({});
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  useEffect(() => { setFolders({}); api.folders(subject.id).then(setFolders).catch(() => setFolders({})); }, [subject.id]);

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

  /** Folder changes: each is one request (only its own rows change), then the folders are read back. */
  const loadFolders = () => api.folders(subject.id).then((f) => { foldersRef.current = f; setFolders(f); }).catch((e) => logError('folders', e, 'warning'));
  const folderOp = async (run: () => Promise<unknown>) => {
    try { await run(); } catch (e) {
      ov.confirm({ title: "Couldn't change folders", body: `${String(e).replace(/^Error: /, '')}. Restart the app if it was just updated.`, confirmText: 'OK' });
    }
    await loadFolders();
  };
  const ops: FolderOps = {
    create: (topicId, name, docIds) => folderOp(() => api.createFolder(subject.id, topicId, name, docIds)),
    rename: (id, name) => folderOp(() => api.renameFolder(id, name)),
    remove: (id) => folderOp(() => api.deleteFolder(id)),
    place: (docIds, folderId) => folderOp(() => api.placeFiles(docIds, folderId)),
    order: (topicId, ids) => folderOp(() => api.orderFolders(topicId, ids)),
  };

  const refresh = () => { refs.reload(); onChange(); onDocsChanged(); };
  const notesSplit = useSplit('split:notes');
  const topicOrder = useReorder(`topics:${subject.id}`, subject.topics.map((t) => t.id),
    async (ids) => { await api.orderTopics(subject.id, ids); onChange(); });
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const uploadRef = (paths?: string[]) =>
    setUpload({ title: `Add textbooks to ${subject.name}`, target: { subject_id: subject.id }, mode: 'auto', paths });
  /** Move files to a topic (topicId) or the reference library (null); a file that changes topic leaves its folder
   * (the backend does that). Resolves to the ids that are now there (failures are reported). */
  const moveTo = async (ds: DraggedDoc[], topicId: number | null) => {
    const ok: number[] = [], failed: string[] = [];
    for (const d of ds) {
      if (topicId === null ? d.kind === 'reference' : d.kind === 'topic' && d.topic_id === topicId) { ok.push(d.id); continue; }
      try {
        await api.moveDocument(d.id, topicId);
        ok.push(d.id);
      } catch (e) {
        failed.push(`${d.filename}: ${String(e).replace(/^Error: /, '')}`);
      }
    }
    if (ok.length) { refresh(); loadFolders(); }
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
      await ops.remove(folder.id);
      if (topicId !== null) await ops.create(topicId, folder.name, moved); // the folder goes along, under the same name
    }
  };
  const moveToFolder = async (fid: string, topicId: number) => {
    const docs = pickedItems().docs;
    clearPicked();
    const moved = await moveTo(docs.map(asDragged), topicId);
    await ops.place(moved, fid);
  };
  const deletePicked = async () => {
    const { docs, folders: fs } = pickedItems();
    const parts = [docs.length && `${docs.length} file${docs.length === 1 ? '' : 's'}`, fs.length && `${fs.length} folder${fs.length === 1 ? '' : 's'}`].filter(Boolean);
    if (!parts.length) return clearPicked();
    // folders can't be brought back, so only they ask first; files go to the trash with Undo
    if (fs.length && !(await ov.confirm({ title: `Delete ${parts.join(' and ')}?`, confirmText: 'Delete', danger: true,
      body: `Files inside the deleted folders stay in their topic.${docs.length ? ' Deleted files can be brought back with Undo.' : ''}` }))) return;
    clearPicked();
    const gone: number[] = [];
    for (const d of docs) await api.deleteDocument(d.id).then(() => gone.push(d.id)).catch((e) => logError('delete file', e));
    for (const { folder } of fs) await ops.remove(folder.id);
    if (docs.some((d) => sel.focus?.kind === 'doc' && sel.focus.id === d.id)) sel.onFocus(null);
    refresh();
    if (gone.length) {
      const restore = async () => { for (const id of gone) await api.restoreDocument(id).catch((e) => logError('restore file', e)); refresh(); };
      const entry = undoable({ label: `delete ${gone.length} file${gone.length === 1 ? '' : 's'}`, undo: restore,
        redo: async () => { for (const id of gone) await api.deleteDocument(id); refresh(); } });
      toast(`${gone.length} file${gone.length === 1 ? '' : 's'} deleted`, { label: 'Undo', run: () => undoEntry(entry) });
    }
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
        ? [{ label: 'Remove from folder', onClick: () => { ops.place(docs.map((d) => d.id), null); clearPicked(); }, separatorBefore: true }] : []),
    ];
  };
  const bulkMenu = (): MenuItem[] => [
    ...moveItems(),
    { label: 'Clear selection', onClick: clearPicked, separatorBefore: true },
    { label: `Delete ${picked.size} selected`, onClick: deletePicked, danger: true },
  ];
  const deleteRef = useRef(deletePicked);
  deleteRef.current = deletePicked;
  useEffect(() => {
    if (!picked.size) return;
    const k = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key !== 'Delete' || document.querySelector('.modal-backdrop') || el?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      deleteRef.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [picked.size]);
  const [query, setQuery] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); searchBox.current?.focus(); searchBox.current?.select(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

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
    { label: 'Add files…', onClick: onAddFiles },
    { label: 'Add textbook…', onClick: () => uploadRef() },
    ...(advanced ? [
      { label: tr('checkVision'), onClick: () => act.checkVision({ subject_id: subject.id }, subject.name, subject.id), separatorBefore: true },
      { label: 'Maintenance…', onClick: () => go({ name: 'settings', tab: 'maintenance', subjectId: subject.id }) },
    ] : []),
    { label: 'Export / share…', onClick: () => go({ name: 'settings', tab: 'share', subjectId: subject.id }), separatorBefore: !advanced },
    { label: 'Rename subject…', onClick: () => act.renameSubject(subject), separatorBefore: true },
    { label: 'Delete subject', onClick: () => act.deleteSubject(subject), danger: true },
  ];
  /** A file click: narrow the cloud to it, and open it straight away unless the cloud is what's showing. */
  const selectDoc = (d: Doc) => {
    anchor.current = `d:${d.id}`;
    sel.onFocus({ kind: 'doc', id: d.id, name: d.filename });
    // advanced mode: with the map showing, a click narrows it to the file and a double-click opens it
    if (!sel.cloudVisible || !advanced) onOpenDoc(d.id);
  };
  const files: FileProps = { subjectId: subject.id, onSelect: selectDoc, selectedId: sel.focus?.kind === 'doc' ? sel.focus.id : null, openId: sel.openId, picker,
    onOpenSide: (d) => onOpenSplit('doc', d.id),
    menu: (d) => (advanced ? [{ label: tr('checkVision'), onClick: () => act.checkVision({ document_id: d.id }, d.filename, subject.id) }] : []) };

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
        <div className="side-title" data-tip={subject.name}>{subject.name}</div>
        <button className="icon-btn" title="Subject options" onClick={(e) => ov.menu(e, subjectMenu)}><Icon name="more" /></button>
      </div>

      <div className="file-search">
        <svg className="file-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        <input ref={searchBox} className="file-search-input" placeholder="Search files (Ctrl+Shift+F)" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
        {query && <button className="x-btn" title="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14} /></button>}
      </div>
      {!advanced && (
        <div className="side-add">
          <button className="btn btn-primary btn-sm side-add-btn" onClick={onAddFiles}>+ Add files</button>
        </div>
      )}
      {query.trim() ? (
        <FileSearchResults subject={subject} query={query.trim()} onOpen={(id, label, q) => {
          onOpenDoc(id, label);
          if (q) openFind(q);
        }} />
      ) : (
      <div className="side-scroll">
        {showTodos && <Todos subject={subject} />}

        <section className={`topic res-books${booksOpen ? ' open' : ''}${refDrag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setRefDrag(true); }} onDragLeave={() => setRefDrag(false)}
          onDrop={(e) => { setRefDrag(false); dropOn(null, uploadRef)(e); }}>
          <div className="topic-row" onClick={toggleBooks} role="button" aria-expanded={booksOpen}
            data-tip={advanced ? undefined : 'Textbooks and references for the whole subject: Apollo looks things up in them for every question'}>
            <span className="topic-badge"><Icon name="textbook" size={14} /></span>
            <span className="topic-name">{tr('references')}</span>
            <StaleBadge count={subject.stale_reference_docs} where="the reference library"
              onReingest={async () => { await api.reingestStale(subject.id, { reference: true }); refresh(); }} />
            <span className="topic-count">{refs.data?.length ?? 0}</span>
            <span className="topic-actions" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" data-tip="Add textbook" aria-label="Add textbook" onClick={() => uploadRef()}><Icon name="add" size={15} /></button>
            </span>
            <span className={`topic-caret${booksOpen ? ' open' : ''}`}><Icon name="chevronRight" size={14} /></span>
          </div>
          {booksOpen && (
            <div className="topic-files">
              <FileList compact docs={refs.data ?? []} onChange={refresh} onOpen={(d) => onOpenDoc(d.id)} {...files}
                onDetails={(d) => onOpenDoc(d.id, undefined, true)}
                reorder={{ group: `refs:${subject.id}`, commit: async (ids) => { await api.orderDocuments(subject.id, ids); refs.reload(); } }}
                empty={advanced ? 'Drop textbooks here.' : 'Drop textbooks here, or use + to add one.'} />
            </div>
          )}
        </section>

        <section className="side-section">
          <div className="side-section-head">
            <span>Topics <Info text="A topic holds the material for one part of the subject, like a chapter or a week. Textbooks are for the whole subject: Apollo looks things up in them for every question." /></span>
            <button className="icon-btn" title="New topic" onClick={() => act.newTopic(subject)}><Icon name="add" /></button>
          </div>
          {subject.topics.length === 0 && (advanced ? <div className="files-empty">No topics yet.</div> : (
            <div className="files-empty">Topics hold your lecture material, e.g. one per chapter or week.{' '}
              <button className="link-btn" onClick={() => act.newTopic(subject)}>Create your first topic</button></div>
          ))}
          {topicOrder.order.map((id) => subject.topics.find((x) => x.id === id)!).map((t) => (
            <TopicRow key={t.id} topic={t} reorder={topicOrder.item(t.id)} color={topicColor(subject.topics, t.id)} open={open.has(t.id)}
              focused={sel.focus?.kind === 'topic' && sel.focus.id === t.id}
              onToggle={() => toggle(t.id)} onFocus={() => sel.onFocus({ kind: 'topic', id: t.id, name: t.name })}
              onUpload={(paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths })}
              onCreate={(tool) => onCreate(tool, t.id)} onOpenDoc={(d) => onOpenDoc(d.id)}
              onDetails={(d) => onOpenDoc(d.id, undefined, true)}
              onDrop={dropOn(t.id, (paths) => setUpload({ title: `Add files to ${t.name}`, target: { topic_id: t.id }, mode: 'auto', paths }))}
              onMoveHere={(d) => moveTo(d, t.id)}
              folders={folders[t.id] ?? EMPTY_FOLDERS} ops={ops}
              files={files} sel={sel}
              onRename={() => act.renameTopic(t)} onDelete={() => act.deleteTopic(t)} onChange={refresh}
              onCheckVision={advanced ? () => act.checkVision({ topic_id: t.id }, t.name, subject.id) : undefined} />
          ))}
        </section>
      </div>
      )}

      <SplitHandle split={notesSplit} label="my notes" edge="above" section={() => asideRef.current?.querySelector<HTMLElement>(':scope > .my-notes:not(.folded)')} />
      <MyNotes subject={subject} {...notes} style={notesSplit.style} onOpenSplit={(id) => onOpenSplit('note', id)} />

      {picked.size > 0 && (
        <div className="pick-bar" role="toolbar" aria-label="Selected files and folders">
          <span className="pick-count">{picked.size} selected</span>
          <button className="btn btn-sm" onClick={(e) => ov.menu(e, moveItems(), { anchor: e.currentTarget, place: 'above' })}>Move to…</button>
          <button className="btn btn-sm btn-danger" onClick={deletePicked}>Delete</button>
          <button className="icon-btn" title="Clear selection (Esc)" onClick={clearPicked}><Icon name="close" size={15} /></button>
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
