/* Drag to rearrange a list (subjects in the mini sidebar, topics, folders, files, to-dos, generated content). Each list
   is a `group`, so an item can only be dropped among its own siblings. The drag uses its own type so it never looks
   like an upload from Windows; a file keeps its file drag too (`carry`), so it can still be dropped on a topic or the
   chat. The new order shows at once, is then saved by `commit`, and can be undone. */
import { useEffect, useState } from 'react';
import { undoable } from '../undo';

export const ORDER_DRAG = 'application/x-apollo-order';

// dataTransfer data can't be read during dragover, so the item being dragged is kept here
let dragging: { group: string; id: string } | null = null;

export const isOrderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(ORDER_DRAG);
/** Whether a reorder drag of this group is under way (a file drag that started as one can then skip its own drop). */
export const draggingIn = (group: string) => dragging?.group === group;

export function moved<K>(ids: K[], from: K, to: K, after: boolean): K[] {
  const rest = ids.filter((x) => x !== from);
  const i = rest.indexOf(to);
  if (i < 0) return ids;
  rest.splice(after ? i + 1 : i, 0, from);
  return rest;
}

const queues = new Map<string, Promise<unknown>>();
/** Run `fn` after every earlier save of the same list has finished. */
function inOrder(group: string, fn: () => unknown): Promise<unknown> {
  const run = (queues.get(group) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queues.set(group, run);
  return run;
}

/** `label`: what the undo button says ("reorder to-dos"). */
export function useReorder<K extends string | number>(group: string, ids: K[], commit: (ids: K[]) => void | Promise<unknown>,
  label = 'reorder') {
  const [local, setLocal] = useState<K[] | null>(null);
  const [over, setOver] = useState<{ id: K; after: boolean } | null>(null);
  const key = ids.join(',');
  useEffect(() => { setLocal(null); }, [key]); // the saved order came back (or the list changed)
  // keep only ids that still exist, and show new ones at the end
  const order = local ? [...local.filter((x) => ids.includes(x)), ...ids.filter((x) => !local.includes(x))] : ids;
  const mine = (e: React.DragEvent) => isOrderDrag(e) && dragging?.group === group;

  /** Spread on each item's element. `handlers.onDragOver` etc. return true when they handled a reorder drag, so an
   * element that also takes file drops can call them first. `carry`: the element sets its own drag data in its
   * onDragStart too (call `item.onDragStart` from it) instead of this replacing it. */
  const item = (id: K) => ({
    draggable: true,
    'data-drop': over && over.id === id ? (over.after ? 'after' : 'before') : undefined,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      dragging = { group, id: String(id) };
      e.dataTransfer.setData(ORDER_DRAG, String(id));
      e.dataTransfer.effectAllowed = e.dataTransfer.effectAllowed === 'uninitialized' ? 'move' : 'all';
    },
    onDragEnd: () => { dragging = null; setOver(null); },
    onDragOver: (e: React.DragEvent): boolean => {
      if (!mine(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      setOver((o) => (o && o.id === id && o.after === after ? o : { id, after }));
      return true;
    },
    onDragLeave: (e: React.DragEvent): boolean => {
      if (!mine(e)) return false;
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o?.id === id ? null : o));
      return true;
    },
    onDrop: (e: React.DragEvent): boolean => {
      if (!mine(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      const from = order.find((x) => String(x) === dragging!.id);
      const after = over?.id === id ? over.after : false;
      dragging = null;
      setOver(null);
      if (from === undefined || from === id) return true;
      const before = order;
      const next = moved(order, from, id, after);
      if (next.join(',') === before.join(',')) return true;
      setLocal(next);
      // the step is recorded at once, so an immediate Ctrl+Z undoes this and not the step before it; saves of one
      // list run one after another, so an undo can't overtake the save it undoes
      const save = (ids: K[]) => inOrder(group, () => commit(ids));
      undoable({ label, undo: () => save(before), redo: () => save(next) });
      save(next).catch(() => setLocal(null));
      return true;
    },
  });
  return { order, item };
}
