/* Chat groups (folders) in the chat history sidebar (LibraryPanel's ChatHistory): which chats go under which group,
   how a move is undone, and the drag that carries chats onto a group header or back out to the ungrouped list. */
import type { Chat, ChatGroup } from '../../api';

/** Chats under each listed group (in the list's order), and the rest. A chat whose group isn't listed (deleted, or
 * not loaded yet) counts as ungrouped. */
export function splitByGroup<C extends Pick<Chat, 'group_id'>>(chats: C[], groups: Pick<ChatGroup, 'id'>[]) {
  const inGroup = new Map<number, C[]>(groups.map((g) => [g.id, []]));
  const ungrouped: C[] = [];
  for (const c of chats) {
    const list = c.group_id != null ? inGroup.get(c.group_id) : undefined;
    if (list) list.push(c); else ungrouped.push(c);
  }
  return { inGroup, ungrouped };
}

/** The moves that put `ids` back where they were: one per previous group (null = ungrouped). Unknown ids are left out. */
export function previousGroups(chats: Pick<Chat, 'id' | 'group_id'>[], ids: number[]): [number | null, number[]][] {
  const by = new Map<number | null, number[]>();
  for (const id of ids) {
    const c = chats.find((x) => x.id === id);
    if (!c) continue;
    const g = c.group_id ?? null;
    by.set(g, [...(by.get(g) ?? []), id]);
  }
  return [...by.entries()];
}

/** Drag type for chats dragged out of the list (JSON array of ids). */
export const CHAT_DRAG = 'application/x-apollo-chats';
// dataTransfer data can't be read during dragover, so the chats being dragged are kept here too
let dragged: number[] | null = null;

export function setChatDrag(dt: DataTransfer, ids: number[]) {
  dragged = ids;
  dt.setData(CHAT_DRAG, JSON.stringify(ids));
  dt.effectAllowed = 'move';
}
export const endChatDrag = () => { dragged = null; };
export const isChatDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(CHAT_DRAG);
/** The chats being dragged (during dragover too). */
export function draggedChats(e: React.DragEvent): number[] {
  if (dragged) return dragged;
  try { return JSON.parse(e.dataTransfer.getData(CHAT_DRAG) || '[]') as number[]; } catch { return []; }
}
