/* A topic in the sidebar: its row, and its files grouped into folders. */
import { useState } from 'react';
import { api, Doc, FolderMap, Topic, ToolName } from '../../api';
import { usePoll } from '../../hooks';
import FileList, { DOC_DRAG, DraggedDoc, draggedDocs, isPickClick, Picker } from '../../components/FileList';
import { MenuItem, useOverlay } from '../../components/overlay';
import StaleBadge from '../../components/StaleBadge';
import { useReorder } from '../../components/reorder';
import { CREATE_ITEMS } from '../SubjectView';
import { useAdvanced } from '../../theme';
import { term } from '../../terms';

import type { Selection } from '../ResourcePanel';
import Icon from '../../components/Icon';

export type TopicFolders = FolderMap[string];

export type SidePicker = Picker & { registerFolder: (f: Folder, topicId: number) => void; setAnchor: (key: string) => void };
export type FileProps = { subjectId: number; onSelect: (d: Doc) => void; onOpenSide: (d: Doc) => void; selectedId: number | null; openId: number | null; picker: SidePicker; menu: (d: Doc) => MenuItem[] };
export type Folder = TopicFolders['folders'][number];
export type ReorderItem = ReturnType<ReturnType<typeof useReorder<number>>['item']>;
export const EMPTY_FOLDERS: TopicFolders = { folders: [], files: {} };
/** Folder changes, each saved on its own (ResourcePanel). */
export interface FolderOps {
  create: (topicId: number, name: string, docIds?: number[]) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  place: (docIds: number[], folderId: string | null) => Promise<void>;
  order: (topicId: number, ids: string[]) => Promise<void>;
}

export function TopicRow({ topic, reorder, color, open, focused, onToggle, onFocus, onUpload, onCreate, onOpenDoc, onDetails, onDrop, onMoveHere,
  folders, ops, files, sel, onRename, onDelete, onChange, onCheckVision }: {
  topic: Topic; reorder: ReorderItem; color: string; open: boolean; focused: boolean; onToggle: () => void; onFocus: () => void;
  onUpload: (paths?: string[]) => void; onCreate: (tool: ToolName) => void;
  onOpenDoc: (d: Doc) => void; onDetails: (d: Doc) => void; onDrop: (e: React.DragEvent) => void;
  onMoveHere: (ds: DraggedDoc[]) => Promise<number[]>; folders: TopicFolders; ops: FolderOps;
  files: FileProps; sel: Selection; onRename: () => void; onDelete: () => void; onChange: () => void; onCheckVision?: () => void;
}) {
  const ov = useOverlay();
  const advanced = useAdvanced();
  const [drag, setDrag] = useState(false);
  const newFolder = async () => {
    const name = (await ov.prompt({ title: `New folder in ${topic.name}`, placeholder: 'e.g. Week 1 lectures', confirmText: 'Create folder' }))?.trim();
    if (!name) return;
    await ops.create(topic.id, name);
    if (!open) onToggle();
  };
  const createMenu: MenuItem[] = CREATE_ITEMS.map((c) => ({ label: c.label, onClick: () => onCreate(c.tool) }));
  const fullMenu: MenuItem[] = [
    { label: open ? 'Hide files' : 'Show files', onClick: onToggle },
    { label: 'Upload files…', onClick: () => onUpload() },
    { label: 'New folder…', onClick: newFolder },
    ...createMenu.map((m, i) => ({ ...m, label: `Create ${m.label.toLowerCase()}`, separatorBefore: i === 0 })),
    ...(onCheckVision ? [{ label: term('checkVision'), onClick: onCheckVision, separatorBefore: true }] : []),
    { label: 'Rename…', onClick: onRename, separatorBefore: true },
    { label: 'Delete topic', onClick: onDelete, danger: true },
  ];
  return (
    <div className={`topic${open ? ' open' : ''}${drag ? ' drag' : ''}${focused ? ' focused' : ''}`} style={{ '--tint': color } as React.CSSProperties}
      data-drop={reorder['data-drop']}
      onDragOver={(e) => { if (reorder.onDragOver(e)) return; e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!reorder.onDragLeave(e)) setDrag(false); }}
      onDrop={(e) => {
        if (reorder.onDrop(e)) return;
        setDrag(false);
        // files of this topic dropped outside its folders leave their folder; others move here
        const ds = draggedDocs(e);
        if (!ds.length) return onDrop(e);
        e.preventDefault();
        const mine = ds.filter((d) => d.kind === 'topic' && d.topic_id === topic.id);
        const filed = mine.filter((d) => folders.files[d.id]);
        if (filed.length) ops.place(filed.map((d) => d.id), null);
        const rest = ds.filter((d) => !mine.includes(d));
        if (rest.length) onMoveHere(rest);
      }}>
      <div className="topic-row" data-focus draggable onDragStart={reorder.onDragStart} onDragEnd={reorder.onDragEnd} onClick={() => { onToggle(); onFocus(); }} onContextMenu={(e) => ov.menu(e, fullMenu)}>
        <span className="topic-badge" aria-hidden><Icon name="topic" size={14} /></span>
        <span className="topic-name" data-tip={topic.name}>{topic.name}</span>
        <StaleBadge count={topic.stale_docs} where={topic.name}
          onReingest={async () => { await api.reingestStale(topic.subject_id, { topic_id: topic.id }); onChange(); }} />
        <span className="topic-count" data-tip={`${topic.doc_count ?? 0} file${topic.doc_count === 1 ? '' : 's'}`}>{topic.doc_count ?? 0}</span>
        <span className="topic-actions" onClick={(e) => e.stopPropagation()}>
          {advanced ? (
            <>
              <button className="icon-btn" data-tip="New folder" onClick={newFolder}><FolderIcon /></button>
              <button className="icon-btn" data-tip="Upload files" onClick={() => onUpload()}><Icon name="upload" size={14} /></button>
              <button className="icon-btn icon-accent" data-tip="Create…" onClick={(e) => ov.menu(e, createMenu)}><Icon name="create" size={14} /></button>
            </>
          ) : (
            <>
              <button className="icon-btn topic-label-btn" data-tip="Add files to this topic" onClick={() => onUpload()}><Icon name="upload" size={14} /> Add</button>
              <button className="icon-btn icon-accent topic-label-btn" data-tip="Make flashcards, a quiz, notes… from this topic" onClick={(e) => ov.menu(e, createMenu)}><Icon name="create" size={14} /> Create</button>
            </>
          )}
          <button className="icon-btn" data-tip="More options" aria-label={`More options for ${topic.name}`} onClick={(e) => ov.menu(e, fullMenu)}><Icon name="more" size={15} /></button>
        </span>
        <span className={`topic-caret${open ? ' open' : ''}`}><Icon name="chevronRight" size={14} /></span>
      </div>
      {open && <TopicFiles topicId={topic.id} onOpen={onOpenDoc} onDetails={onDetails} onChange={onChange}
        folders={folders} ops={ops} onMoveHere={onMoveHere} files={files} sel={sel} />}
    </div>
  );
}

export function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z" />
    </svg>
  );
}

/** A topic's files: its folders (collapsible, display only) first, then the files in no folder. */
function TopicFiles({ topicId, onOpen, onDetails, onChange, folders, ops, onMoveHere, files, sel }: {
  topicId: number; onOpen: (d: Doc) => void; onDetails: (d: Doc) => void; onChange: () => void;
  folders: TopicFolders; ops: FolderOps; onMoveHere: (ds: DraggedDoc[]) => Promise<number[]>;
  files: FileProps; sel: Selection;
}) {
  const ov = useOverlay();
  const docs = usePoll(() => api.topicDocs(topicId), 1000, [topicId], ['documents']);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const list = docs.data ?? [];
  list.forEach(files.picker.register); // so a picked, collapsed folder still knows its files
  const byName = folders.ordered ? folders.folders : [...folders.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const folderOrder = useReorder(`folders:${topicId}`, byName.map((f) => f.id), (ids) => ops.order(topicId, ids), 'reorder folders');
  const sorted = folderOrder.order.map((id) => folders.folders.find((f) => f.id === id)!).filter(Boolean);
  const known = new Set(sorted.map((f) => f.id));
  const folderOf = (d: Doc) => (known.has(folders.files[d.id]) ? folders.files[d.id] : null);
  const reload = () => { docs.reload(); onChange(); };

  const place = (docId: number, folderId: string | null) => ops.place([docId], folderId);
  const menu = (d: Doc): MenuItem[] => [
    ...sorted.filter((f) => f.id !== folderOf(d)).map((f) => ({ label: `Move to folder “${f.name}”`, onClick: () => place(d.id, f.id) })),
    ...(folderOf(d) ? [{ label: 'Remove from folder', onClick: () => place(d.id, null) }] : []),
    ...files.menu(d),
  ];
  const rename = async (f: Folder) => {
    const name = (await ov.prompt({ title: 'Rename folder', initial: f.name }))?.trim();
    if (name) await ops.rename(f.id, name);
  };
  const remove = async (f: Folder) => {
    if (!await ov.confirm({ title: `Delete folder “${f.name}”?`, body: 'Its files stay in the topic; only the folder goes.', confirmText: 'Delete folder', danger: true })) return;
    await ops.remove(f.id);
  };
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const props = { onOpen, onDetails, onChange: reload, ...files, menu };
  const order = (group: string) => ({ group: `files:${topicId}:${group}`,
    commit: async (ids: number[]) => { await api.orderDocuments(files.subjectId, ids); docs.reload(); } });
  const pk = files.picker;

  return (
    <div className="topic-files">
      {sorted.map((f) => {
        const inside = list.filter((d) => folderOf(d) === f.id);
        const isOpen = !closed.has(f.id);
        const focused = sel.focus?.kind === 'folder' && sel.focus.id === f.id;
        const key = `f:${f.id}`;
        pk.registerFolder(f, topicId);
        const ro = folderOrder.item(f.id);
        return (
          <div key={f.id} className={`folder${isOpen ? ' open' : ''}${over === f.id ? ' drag' : ''}`} data-drop={ro['data-drop']}
            onDragOver={(e) => { if (ro.onDragOver(e)) return; if (e.dataTransfer.types.includes(DOC_DRAG)) { e.preventDefault(); e.stopPropagation(); setOver(f.id); } }}
            onDragLeave={(e) => { if (!ro.onDragLeave(e)) setOver(null); }}
            onDrop={async (e) => {
              if (ro.onDrop(e)) return;
              const ds = draggedDocs(e);
              if (!ds.length) return;
              e.preventDefault(); e.stopPropagation(); setOver(null);
              const moved = await onMoveHere(ds);
              if (moved.length) await ops.place(moved, f.id);
            }}>
            <div className={`folder-row${focused ? ' focused' : ''}${pk.has(key) ? ' picked' : ''}`} data-focus data-pick={key}
              draggable onDragStart={ro.onDragStart} onDragEnd={ro.onDragEnd}
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
              <span className={`topic-caret${isOpen ? ' open' : ''}`}><Icon name="chevronRight" size={13} /></span>
              <span className="folder-icon"><FolderIcon /></span>
              <span className="folder-name" data-tip={f.name}>{f.name}</span>
              <span className="topic-count" data-tip={`${inside.length} file${inside.length === 1 ? '' : 's'}`}>{inside.length}</span>
            </div>
            {isOpen && <div className="folder-files"><FileList compact docs={inside} {...props} reorder={order(f.id)} empty="Drag files here." /></div>}
          </div>
        );
      })}
      {(list.some((d) => !folderOf(d)) || !sorted.length) && (
        <FileList compact docs={list.filter((d) => !folderOf(d))} {...props} reorder={order('root')} empty="No files yet. Drop files on the topic." />
      )}
    </div>
  );
}

/** The student's own notes, pinned to the bottom of the sidebar. Never ingested: Apollo only reads one when asked. */
