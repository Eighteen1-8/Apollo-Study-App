/* Deleting and renaming chats from anywhere (the chat header, the sidebar's × and its multi-select, /delete), with a
   confirmation first and an undo afterwards. */
import { api, Chat } from '../api';
import type { useOverlay } from '../components/overlay';
import { toast } from '../components/toast';
import { isLive, markRead, stopReply } from '../chatStreams';
import { undoable, undoEntry } from '../undo';

type Overlay = ReturnType<typeof useOverlay>;

/** Ask, then delete (soft: Undo restores them). Returns whether they were deleted. */
export async function confirmDeleteChats(ov: Overlay, chats: Pick<Chat, 'id' | 'title'>[]): Promise<boolean> {
  if (!chats.length) return false;
  const n = chats.length;
  const replying = chats.filter((c) => isLive(c.id)).length;
  const ok = await ov.confirm({
    title: n === 1 ? `Delete “${chats[0].title}”?` : `Delete ${n} chats?`, danger: true, confirmText: 'Delete',
    body: `${replying ? 'Apollo is still replying in ' + (n === 1 ? 'it' : `${replying} of them`) + '; that reply stops. ' : ''}`
      + 'Generated content stays in the library. You can undo this with Ctrl+Z.',
  });
  if (!ok) return false;
  const ids = chats.map((c) => c.id);
  ids.forEach((id) => { if (isLive(id)) stopReply(id); });
  await api.deleteChats(ids);
  markRead(...ids);
  const entry = undoable({
    label: n === 1 ? `delete chat “${chats[0].title}”` : `delete ${n} chats`,
    undo: () => api.restoreChats(ids), redo: () => api.deleteChats(ids),
  });
  toast(n === 1 ? 'Chat deleted' : `${n} chats deleted`, { label: 'Undo', run: () => undoEntry(entry) });
  return true;
}

/** Delete something that's deleted softly on the server (generated content, a note), with Undo in a toast and on
 * Ctrl+Z. Deleted items are purged after a week. */
export async function deleteUndoably({ what, name, del, restore }: {
  what: string; name: string; del: () => Promise<unknown>; restore: () => Promise<unknown>;
}) {
  await del();
  const entry = undoable({ label: `delete ${what} “${name}”`, undo: restore, redo: del });
  toast(`Deleted “${name}”`, { label: 'Undo', run: () => undoEntry(entry) });
}

export async function renameChatUndoable(chat: Pick<Chat, 'id' | 'title'>, title: string): Promise<Chat> {
  const was = chat.title;
  const c = await api.renameChat(chat.id, title);
  undoable({ label: `rename chat to “${title}”`, undo: () => api.renameChat(chat.id, was), redo: () => api.renameChat(chat.id, title) });
  return c;
}
