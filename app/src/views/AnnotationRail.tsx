/* The annotations rail beside the viewer: every highlight, note, drawing and text box, filtered by kind, with jump-to and export. */
import { useState } from 'react';
import { Annotation, AnnotationKind } from '../api';
import Icon, { IconName } from '../components/Icon';

export const KIND_ICON: Record<AnnotationKind, IconName> = { highlight: 'highlight', note: 'note', ink: 'pen', textbox: 'textbox', region: 'region' };

export type Filter = 'all' | AnnotationKind;

export function AnnotationRail({ items, unitLabel, onGo, onDelete, onExport, onClose }: {
  items: Annotation[]; unitLabel: (unit: number) => string; onGo: (a: Annotation) => void; onDelete: (a: Annotation) => void;
  onExport: (() => void) | null; onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = items.filter((a) => filter === 'all' || a.kind === filter);
  const units = [...new Set(shown.map((a) => a.unit))].sort((a, b) => a - b);
  const snippet = (a: Annotation) => {
    if (a.kind === 'ink') return `Drawing (${a.data.strokes?.length ?? 0} stroke${a.data.strokes?.length === 1 ? '' : 's'})`;
    if (a.kind === 'textbox') return a.data.text || 'Empty text box';
    if (a.kind === 'region') return 'Screenshot sent to the chat';
    if (a.kind === 'note') {
      const body = a.data.pending ? 'Defining…' : a.data.text || (a.data.strokes?.length ? 'Drawing' : 'Empty note');
      return a.data.definition ? `${a.data.title}: ${body}` : a.anchor.text ? `“${a.anchor.text}” · ${body}` : a.data.area ? `Area note · ${body}` : body;
    }
    return `“${a.anchor.text ?? ''}”`;
  };
  return (
    <aside className="anno-rail">
      <div className="rail-head">
        <span>Annotations <span className="count-badge">{items.length}</span></span>
        <button className="icon-btn" title="Hide annotations" onClick={onClose}><Icon name="chevronRight" /></button>
      </div>
      {onExport && items.length > 0 && <button className="btn btn-sm rail-export" onClick={onExport}>Export annotated PDF…</button>}
      <div className="rail-filters">
        {(['all', 'highlight', 'note', 'textbox', 'ink'] as Filter[]).map((f) => (
          <button key={f} className={`rail-filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'highlight' ? 'Highlights' : f === 'note' ? 'Notes' : f === 'textbox' ? 'Text' : 'Drawings'}
          </button>
        ))}
      </div>
      <div className="rail-list">
        {shown.length === 0 && (
          <div className="rail-empty">
            {items.length ? 'Nothing of this kind yet.' : 'Select text to highlight it, define it or add a note. Use the pen, text box and note tools above to write on the page.'}
          </div>
        )}
        {units.map((u) => (
          <div key={u} className="rail-group">
            <div className="rail-unit">{unitLabel(u)}</div>
            {shown.filter((a) => a.unit === u).map((a) => (
              <div key={a.id} className="rail-item" onClick={() => onGo(a)} title="Go to this annotation">
                <span className={`rail-icon k-${a.kind}`}
                  style={{ color: a.kind === 'highlight' || a.kind === 'note' ? undefined : a.data.color ?? a.data.strokes?.[0]?.color,
                    background: a.kind === 'highlight' ? a.data.color : undefined }}><Icon name={KIND_ICON[a.kind]} size={13} /></span>
                <span className="rail-text">{snippet(a)}</span>
                {a.kind === 'note' && a.data.hidden && <span className="rail-hidden" title="Hidden note">hidden</span>}
                <button className="x-btn rail-x" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(a); }}><Icon name="close" size={14} /></button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
