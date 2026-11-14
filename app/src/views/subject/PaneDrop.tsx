/* Drag a file, one of the student's notes or generated notes / a cheat sheet / a mind map from a sidebar into the
   centre to open it there: drop zones show over what's open (left half / right half, plus "replace" while nothing is
   split; just "open" over the map). The drop goes through viewState's `place`, so undo/redo records it like any other
   change of view. The zones sit under the chat (it keeps its own drop: attach), and only a sidebar row's drag
   (PANE_DRAG) shows them: files from Windows still get the full-window drop overlay. */
import { useEffect, useState } from 'react';
import type { ArtifactType } from '../../api';
import Icon from '../../components/Icon';
import type { DropWhere } from './viewState';

export const PANE_DRAG = 'application/x-apollo-pane';
export type DraggedPane = { kind: 'doc' | 'note' | 'artifact'; id: number; type?: ArtifactType; name?: string };

/** Add the pane payload to a row's drag (alongside whatever else it carries). */
export function setPaneDrag(dt: DataTransfer, p: DraggedPane) {
  dt.setData(PANE_DRAG, JSON.stringify(p));
}
export const isPaneDrag = (dt: DataTransfer | null) => !!dt?.types.includes(PANE_DRAG);
export function draggedPane(dt: DataTransfer): DraggedPane | null {
  try {
    const v = JSON.parse(dt.getData(PANE_DRAG));
    return v && (v.kind === 'doc' || v.kind === 'note' || v.kind === 'artifact') && Number.isFinite(v.id) ? v : null;
  } catch {
    return null;
  }
}

const LABEL: Record<DropWhere, string> = { open: 'Open here', replace: 'Open instead', left: 'Open on the left', right: 'Open on the right' };
const ICON: Record<DropWhere, 'chevronLeft' | 'chevronRight' | 'show' | 'swap'> = { open: 'show', replace: 'swap', left: 'chevronLeft', right: 'chevronRight' };

/** `host`: the element whose area takes drops (the centre). */
export function PaneDropZones({ host, zones, onDrop }: {
  host: React.RefObject<HTMLElement>; zones: DropWhere[]; onDrop: (p: DraggedPane, where: DropWhere) => void;
}) {
  const [active, setActive] = useState(false);
  const [over, setOver] = useState<DropWhere | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const enter = (e: DragEvent) => { if (isPaneDrag(e.dataTransfer)) setActive(true); };
    // left the centre (by the pointer's position: relatedTarget can be missing during a drag)
    const leave = (e: DragEvent) => {
      const r = el.getBoundingClientRect();
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) { setActive(false); setOver(null); }
    };
    const end = () => { setActive(false); setOver(null); };
    el.addEventListener('dragenter', enter);
    el.addEventListener('dragleave', leave);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      el.removeEventListener('dragenter', enter);
      el.removeEventListener('dragleave', leave);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, [host]);
  if (!active) return null;
  return (
    <div className={`pane-drop zones-${zones.length}`} aria-hidden>
      {zones.map((z) => (
        <div key={z} className={`pane-drop-zone z-${z}${over === z ? ' over' : ''}`}
          onDragOver={(e) => { if (!isPaneDrag(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== z) setOver(z); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === z ? null : o)); }}
          onDrop={(e) => {
            const p = draggedPane(e.dataTransfer);
            e.preventDefault();
            e.stopPropagation();
            setActive(false);
            setOver(null);
            if (p) onDrop(p, z);
          }}>
          <span className="pane-drop-label"><Icon name={ICON[z]} size={16} /> {LABEL[z]}</span>
        </div>
      ))}
    </div>
  );
}
