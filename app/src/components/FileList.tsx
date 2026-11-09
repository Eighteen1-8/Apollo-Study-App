import { useEffect, useRef, useState } from 'react';
import { toast } from './toast';
import { deleteUndoably } from '../views/chatActions';
import { ErrorCode } from './ErrorText';
import { splitError } from '../errors';
import { api, Doc } from '../api';
import { fmtTokens } from '../hooks';
import { MenuItem, useOverlay } from './overlay';
import { Pill, Progress } from './ui';
import { useReorder } from './reorder';
import { statusWord, term, useTerms } from '../terms';
import { useAdvanced } from '../theme';
import Icon from './Icon';

const ICON: Record<string, string> = { '.pdf': 'PDF', '.pptx': 'PPT', '.docx': 'DOC' };

/** Drag payload for a file row: dropped on a topic / the reference library it moves there; on the chat it attaches. */
export const DOC_DRAG = 'application/x-study-doc';
export type DraggedDoc = { id: number; filename: string; kind: 'topic' | 'reference'; topic_id: number | null };
/** The dragged file rows: one, or every picked file when a multi-selection is dragged. */
export const draggedDocs = (e: React.DragEvent): DraggedDoc[] => {
  if (!e.dataTransfer.types.includes(DOC_DRAG)) return [];
  const v = JSON.parse(e.dataTransfer.getData(DOC_DRAG));
  return Array.isArray(v) ? v : [v];
};
export const asDragged = (d: Doc): DraggedDoc => ({ id: d.id, filename: d.filename, kind: d.kind, topic_id: d.topic_id });

/** Shift/Ctrl multi-selection, owned by the sidebar. Keys are `d:<doc id>` for files (`f:<folder id>` for folders). */
export interface Picker {
  has: (key: string) => boolean;
  /** A click with Shift, Ctrl or ⌘ held: extend / toggle the selection instead of the usual click. */
  click: (key: string, e: React.MouseEvent) => void;
  register: (d: Doc) => void;
  /** Right-click menu for the whole selection, when the row is part of a multi-selection. */
  menu: (key: string) => MenuItem[] | null;
  /** Rows dragged along with this one (it's picked with others). */
  drag: (d: Doc) => DraggedDoc[] | null;
}
export const pickKey = (d: Doc) => `d:${d.id}`;
export const isPickClick = (e: React.MouseEvent) => e.shiftKey || e.ctrlKey || e.metaKey;
const BUSY = ['queued', 'parsing', 'embedding', 'vision'];

function statusOf(d: Doc): [string, string] {
  if (d.status === 'vision') return ['vision', `${term('vision') === 'Vision' ? 'Vision' : 'Pictures'} ${d.vision_done}/${d.vision_total}`];
  if (d.status === 'ready' && d.vision_total > d.vision_done) return ['pending', term('visionIncomplete')];
  return [d.status, statusWord(d.status)];
}

/** Compact file rows: click opens (or, with `onSelect`, click selects and double-click opens), drag moves or
 * attaches, hover shows ×, right-click gives more actions (plus `menu`'s). */
export default function FileList({ docs, onOpen, onOpenSide, onSelect, onDetails, onChange, empty, compact, selectedId, openId, menu, picker, reorder }: {
  docs: Doc[]; onOpen: (d: Doc) => void; onSelect?: (d: Doc) => void; onDetails?: (d: Doc) => void; onChange: () => void;
  /** Open beside what's already open (split view). */
  onOpenSide?: (d: Doc) => void;
  empty?: string; compact?: boolean; selectedId?: number | null; openId?: number | null; menu?: (d: Doc) => MenuItem[];
  picker?: Picker;
  /** Drag a file among its siblings to reorder them (`group`: this list; `commit` saves the order). */
  reorder?: { group: string; commit: (ids: number[]) => Promise<unknown> };
}) {
  const ov = useOverlay();
  const tr = useTerms();
  const advanced = useAdvanced();
  // clicking the already-selected file again (when a click only selects) shows a "double-click to open" hint
  const [hint, setHint] = useState<number | null>(null);
  const hintTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const showHint = (id: number) => {
    window.clearTimeout(hintTimer.current);
    // wait out a double-click's first click, so a real double-click never flashes the hint
    hintTimer.current = window.setTimeout(() => {
      setHint(id);
      hintTimer.current = window.setTimeout(() => setHint(null), 2200);
    }, 320);
  };
  const cancelHint = () => { window.clearTimeout(hintTimer.current); setHint(null); };
  docs.forEach((d) => picker?.register(d));
  const order = useReorder(reorder?.group ?? 'files:none', docs.map((d) => d.id), (ids) => reorder?.commit(ids), 'reorder files');
  const sorted = reorder ? order.order.map((id) => docs.find((d) => d.id === id)!).filter(Boolean) : docs;
  /** At once, with Undo (toast or Ctrl+Z): the file waits a week in the trash, so nothing is read again. */
  const remove = async (d: Doc) => {
    await deleteUndoably({ what: 'file', name: d.filename, del: () => api.deleteDocument(d.id),
      restore: async () => { const r = await api.restoreDocument(d.id); if (r.note) toast(r.note); onChange(); } });
    onChange();
  };
  /** The row's menu (right-click or its ⋯ button); the selection's when the row is part of a multi-selection. */
  const rowMenu = (e: React.MouseEvent, d: Doc, busy: boolean) => {
    const bulk = picker?.menu(pickKey(d));
    if (bulk) return ov.menu(e, bulk);
    ov.menu(e, [
      { label: 'Open', onClick: () => onOpen(d) },
      ...(onOpenSide ? [{ label: 'Open side by side', onClick: () => onOpenSide(d) }] : []),
      ...(onDetails ? [{ label: tr('details'), onClick: () => onDetails(d) }] : []),
      { label: tr('runVision'), onClick: () => api.vision(d.id).then(onChange), disabled: busy || d.vision_total <= d.vision_done },
      { label: tr('reingest'), onClick: () => api.reingest(d.id).then(onChange), disabled: busy },
      ...(menu?.(d) ?? []).map((m, i) => (i ? m : { ...m, separatorBefore: true })),
      { label: 'Remove', onClick: () => remove(d), danger: true, separatorBefore: true },
    ]);
  };
  if (!docs.length) return <div className="files-empty">{empty ?? 'No files yet.'}</div>;
  return (
    <div className={`files${compact ? ' files-compact' : ''}`}>
      {sorted.map((d) => {
        const [tone, label] = statusOf(d);
        const r = reorder ? order.item(d.id) : null;
        const busy = BUSY.includes(d.status);
        return (
          <div key={d.id} draggable data-focus data-pick={pickKey(d)} data-drop={r?.['data-drop']}
            className={`file${d.id === selectedId ? ' selected' : ''}${d.id === openId ? ' open' : ''}${picker?.has(pickKey(d)) ? ' picked' : ''}`}
            onClick={(e) => {
              if (picker && isPickClick(e)) { e.preventDefault(); picker.click(pickKey(d), e); return; }
              if (e.detail > 1) { cancelHint(); return; }
              if (onSelect && d.id === selectedId && d.id !== openId) showHint(d.id);
              (onSelect ?? onOpen)(d);
            }}
            onDoubleClick={(e) => { if (isPickClick(e)) return; cancelHint(); if (onSelect) onOpen(d); }}
            onDragStart={(e) => {
              const many = picker?.drag(d);
              e.dataTransfer.setData(DOC_DRAG, JSON.stringify(many ?? asDragged(d)));
              e.dataTransfer.effectAllowed = 'copyMove';
              if (r && !many) r.onDragStart(e); // a single file can also be dropped among its siblings to reorder
            }}
            onDragEnd={() => r?.onDragEnd()}
            onDragOver={(e) => { r?.onDragOver(e); }}
            onDragLeave={(e) => { r?.onDragLeave(e); }}
            onDrop={(e) => { r?.onDrop(e); }}
            onContextMenu={(e) => rowMenu(e, d, busy)}>
            <span className={`file-icon ext-${d.ext.slice(1)}`}>{ICON[d.ext] ?? d.ext.slice(1).toUpperCase()}</span>
            <span className="file-name" title={`${d.filename}${d.unit_count ? ` · ${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'} · ~${fmtTokens(d.token_count)} tokens` : ''}`}>{d.filename}</span>
            <span className="file-meta">
              {d.unit_count > 0 && `${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'}${advanced ? ` · ~${fmtTokens(d.token_count)} tok` : ''}`}
            </span>
            {busy && d.status === 'vision' ? (
              <span className="file-progress"><Progress value={d.vision_total ? d.vision_done / d.vision_total : 0} /></span>
            ) : busy && !advanced ? <span className="file-progress file-progress-busy"><Progress value={d.status === 'queued' ? 0.05 : d.status === 'parsing' ? 0.35 : 0.7} /></span> : null}
            {(advanced || tone !== 'ready') && <Pill status={tone}>{label}</Pill>}
            {d.status === 'failed' && d.error && splitError(d.error).code && <ErrorCode code={splitError(d.error).code!} context={splitError(d.error).message} />}
            {hint === d.id && <span className="dbl-hint" role="status">Double-click to open</span>}
            {!busy && <span className="file-open" aria-hidden>Open<Icon name="chevronRight" size={13} /></span>}
            <button className="x-btn file-more" title="More options" aria-label={`More options for ${d.filename}`}
              onClick={(e) => { e.stopPropagation(); rowMenu(e, d, busy); }}><Icon name="more" size={15} /></button>
            <button className="x-btn file-x" title="Remove file" onClick={(e) => { e.stopPropagation(); remove(d); }}><Icon name="close" size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
