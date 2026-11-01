import { useEffect, useRef, useState } from 'react';
import { api, Doc } from '../api';
import { fmtTokens } from '../hooks';
import { MenuItem, useOverlay } from './overlay';
import { Pill, Progress } from './ui';

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
  if (d.status === 'vision') return ['vision', `Vision ${d.vision_done}/${d.vision_total}`];
  if (d.status === 'ready' && d.vision_total > d.vision_done) return ['pending', 'Vision incomplete'];
  return [d.status, d.status];
}

/** Compact file rows: click opens (or, with `onSelect`, click selects and double-click opens), drag moves or
 * attaches, hover shows ×, right-click gives more actions (plus `menu`'s). */
export default function FileList({ docs, onOpen, onSelect, onDetails, onChange, empty, compact, selectedId, openId, menu, picker }: {
  docs: Doc[]; onOpen: (d: Doc) => void; onSelect?: (d: Doc) => void; onDetails?: (d: Doc) => void; onChange: () => void;
  empty?: string; compact?: boolean; selectedId?: number | null; openId?: number | null; menu?: (d: Doc) => MenuItem[];
  picker?: Picker;
}) {
  const ov = useOverlay();
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
  const remove = async (d: Doc) => {
    if (await ov.confirm({ title: `Remove ${d.filename}?`, body: 'Its extracted text, embeddings and vision notes are deleted from the app.', confirmText: 'Remove', danger: true })) {
      await api.deleteDocument(d.id);
      onChange();
    }
  };
  if (!docs.length) return <div className="files-empty">{empty ?? 'No files yet.'}</div>;
  return (
    <div className={`files${compact ? ' files-compact' : ''}`}>
      {docs.map((d) => {
        const [tone, label] = statusOf(d);
        const busy = BUSY.includes(d.status);
        return (
          <div key={d.id} draggable data-focus data-pick={pickKey(d)}
            className={`file${d.id === selectedId ? ' selected' : ''}${d.id === openId ? ' open' : ''}${picker?.has(pickKey(d)) ? ' picked' : ''}`}
            onClick={(e) => {
              if (picker && isPickClick(e)) { e.preventDefault(); picker.click(pickKey(d), e); return; }
              if (e.detail > 1) { cancelHint(); return; }
              if (onSelect && d.id === selectedId && d.id !== openId) showHint(d.id);
              (onSelect ?? onOpen)(d);
            }}
            onDoubleClick={(e) => { if (isPickClick(e)) return; cancelHint(); if (onSelect) onOpen(d); }}
            onDragStart={(e) => {
              e.dataTransfer.setData(DOC_DRAG, JSON.stringify(picker?.drag(d) ?? asDragged(d)));
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onContextMenu={(e) => { const bulk = picker?.menu(pickKey(d)); if (bulk) return ov.menu(e, bulk); ov.menu(e, [
              { label: 'Open', onClick: () => onOpen(d) },
              ...(onDetails ? [{ label: 'View ingested details', onClick: () => onDetails(d) }] : []),
              { label: 'Run / resume vision', onClick: () => api.vision(d.id).then(onChange), disabled: busy || d.vision_total <= d.vision_done },
              { label: 'Re-ingest', onClick: () => api.reingest(d.id).then(onChange), disabled: busy },
              ...(menu?.(d) ?? []).map((m, i) => (i ? m : { ...m, separatorBefore: true })),
              { label: 'Remove', onClick: () => remove(d), danger: true, separatorBefore: true },
            ]); }}>
            <span className={`file-icon ext-${d.ext.slice(1)}`}>{ICON[d.ext] ?? d.ext.slice(1).toUpperCase()}</span>
            <span className="file-name" title={`${d.filename}${d.unit_count ? ` · ${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'} · ~${fmtTokens(d.token_count)} tokens` : ''}`}>{d.filename}</span>
            <span className="file-meta">
              {d.unit_count > 0 && `${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'} · ~${fmtTokens(d.token_count)} tok`}
            </span>
            {busy && d.status === 'vision' ? (
              <span className="file-progress"><Progress value={d.vision_total ? d.vision_done / d.vision_total : 0} /></span>
            ) : null}
            <Pill status={tone}>{label}</Pill>
            {hint === d.id && <span className="dbl-hint" role="status">Double-click to open</span>}
            <button className="x-btn file-x" title="Remove file" onClick={(e) => { e.stopPropagation(); remove(d); }}>×</button>
          </div>
        );
      })}
    </div>
  );
}
