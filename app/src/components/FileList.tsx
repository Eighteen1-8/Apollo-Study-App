import { api, Doc } from '../api';
import { fmtTokens } from '../hooks';
import { useOverlay } from './overlay';
import { Pill, Progress } from './ui';

const ICON: Record<string, string> = { '.pdf': 'PDF', '.pptx': 'PPT', '.docx': 'DOC' };

/** Drag payload for a file row: dropped on a topic / the reference library it moves there; on the chat it attaches. */
export const DOC_DRAG = 'application/x-study-doc';
export type DraggedDoc = { id: number; filename: string; kind: 'topic' | 'reference'; topic_id: number | null };
const BUSY = ['queued', 'parsing', 'embedding', 'vision'];

function statusOf(d: Doc): [string, string] {
  if (d.status === 'vision') return ['vision', `Vision ${d.vision_done}/${d.vision_total}`];
  if (d.status === 'ready' && d.vision_total > d.vision_done) return ['pending', 'Vision incomplete'];
  return [d.status, d.status];
}

/** Compact file rows: click opens, drag moves or attaches, hover shows ×, right-click gives more actions. */
export default function FileList({ docs, onOpen, onDetails, onChange, empty, compact }: {
  docs: Doc[]; onOpen: (d: Doc) => void; onDetails?: (d: Doc) => void; onChange: () => void; empty?: string; compact?: boolean;
}) {
  const ov = useOverlay();
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
          <div key={d.id} className="file" onClick={() => onOpen(d)} draggable
            onDragStart={(e) => {
              const payload: DraggedDoc = { id: d.id, filename: d.filename, kind: d.kind, topic_id: d.topic_id };
              e.dataTransfer.setData(DOC_DRAG, JSON.stringify(payload));
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onContextMenu={(e) => ov.menu(e, [
              { label: 'Open', onClick: () => onOpen(d) },
              ...(onDetails ? [{ label: 'View ingested details', onClick: () => onDetails(d) }] : []),
              { label: 'Run / resume vision', onClick: () => api.vision(d.id).then(onChange), disabled: busy || d.vision_total <= d.vision_done },
              { label: 'Re-ingest', onClick: () => api.reingest(d.id).then(onChange), disabled: busy },
              { label: 'Remove', onClick: () => remove(d), danger: true, separatorBefore: true },
            ])}>
            <span className={`file-icon ext-${d.ext.slice(1)}`}>{ICON[d.ext] ?? d.ext.slice(1).toUpperCase()}</span>
            <span className="file-name" title={`${d.filename}${d.unit_count ? ` · ${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'} · ~${fmtTokens(d.token_count)} tokens` : ''}`}>{d.filename}</span>
            <span className="file-meta">
              {d.unit_count > 0 && `${d.unit_count} ${d.ext === '.pptx' ? 'slides' : d.ext === '.pdf' ? 'pages' : 'sections'} · ~${fmtTokens(d.token_count)} tok`}
            </span>
            {busy && d.status === 'vision' ? (
              <span className="file-progress"><Progress value={d.vision_total ? d.vision_done / d.vision_total : 0} /></span>
            ) : null}
            <Pill status={tone}>{label}</Pill>
            <button className="x-btn file-x" title="Remove file" onClick={(e) => { e.stopPropagation(); remove(d); }}>×</button>
          </div>
        );
      })}
    </div>
  );
}
