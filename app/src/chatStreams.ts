/* Chat replies being written, kept outside React. A reply belongs to its chat: switching chats, starting a new one or
   leaving the subject never moves it (the fetch keeps reading here, whatever is on screen). When a reply ends in a chat
   the student isn't looking at, the chat (and its subject, in the mini sidebar) gets an unread dot. */
import { useSyncExternalStore } from 'react';
import { api, ChatEvent, Message } from './api';
import { getPref, setPref } from './prefs';
import { logError } from './log';

export interface LiveReply {
  chatId: number; subjectId: number; level: string;
  text: string; reasoning: string; status: string; started: number | null;
  /** Messages that arrived during this reply (the question, finished parts, tool cards). */
  messages: Message[];
  stopping: boolean;
}

const live = new Map<number, LiveReply>();
const errors = new Map<number, string>();
/** chat id → its subject, for replies that finished while the student was elsewhere (error: it failed). */
let unread: Record<string, { subjectId: number; error?: boolean }> = getPref('chatUnread', {}, (v) => JSON.parse(v));
/* Two channels, so a streamed token wakes only the bubble showing it: `listeners` hear about changes the chat list,
   mini sidebar and chat header care about (a reply starting or ending, its status, messages, unread dots, errors);
   `textListeners` hear about new reply/reasoning text, batched to at most one emit per TEXT_MS. */
const listeners = new Set<() => void>();
const textListeners = new Set<() => void>();
const finished = new Set<(chatId: number, messages: Message[] | null) => void>();
let version = 0;
const TEXT_MS = 60;
let textTimer: ReturnType<typeof setTimeout> | null = null;
/** The chat on screen (null when the chat is minimised or none is open). */
let viewing: number | null = null;

const emit = () => { version++; listeners.forEach((fn) => fn()); emitText(); };
const emitText = () => {
  if (textTimer) { clearTimeout(textTimer); textTimer = null; }
  textListeners.forEach((fn) => fn());
};
const emitTextSoon = () => { textTimer ??= setTimeout(() => { textTimer = null; emitText(); }, TEXT_MS); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const subscribeText = (fn: () => void) => { textListeners.add(fn); return () => { textListeners.delete(fn); }; };
const saveUnread = () => setPref('chatUnread', JSON.stringify(unread));

const update = (chatId: number, fn: (r: LiveReply) => Partial<LiveReply>) => {
  const r = live.get(chatId);
  if (!r) return;
  live.set(chatId, { ...r, ...fn(r) });
  emit();
};

/** New text: the bubble hears about it (batched); the rest only if the status line or "has text yet" changed. */
const addText = (chatId: number, field: 'text' | 'reasoning', more: string) => {
  const r = live.get(chatId);
  if (!r) return;
  const next = { ...r, [field]: r[field] + more, status: '', started: field === 'reasoning' ? r.started ?? Date.now() : r.started };
  live.set(chatId, next);
  if (r.status || !r[field] || next.started !== r.started) emit();
  else emitTextSoon();
};

function apply(chatId: number, e: ChatEvent) {
  if (e.type === 'user' || e.type === 'assistant' || e.type === 'tool') {
    update(chatId, (r) => ({ messages: [...r.messages, e.message], ...(e.type === 'assistant' ? { text: '', reasoning: '' } : {}) }));
  } else if (e.type === 'delta') addText(chatId, 'text', e.text);
  else if (e.type === 'reasoning') addText(chatId, 'reasoning', e.text);
  else if (e.type === 'status') update(chatId, () => ({ status: e.text }));
  else if (e.type === 'error') { errors.set(chatId, e.text); emit(); }
}

export const isLive = (chatId: number | null | undefined) => chatId != null && live.has(chatId);

/** Run one streamed reply for `chatId` (ask, edit or regenerate). Resolves when it ends; rejects if it was refused
 * before starting (the error is recorded for the chat too). `onEvent` also sees every event (e.g. the question
 * being accepted). */
export async function startReply(chatId: number, subjectId: number, level: string,
  run: (on: (e: ChatEvent) => void) => Promise<void>, onEvent?: (e: ChatEvent) => void) {
  if (live.has(chatId)) throw new Error('Apollo is still replying in this chat.');
  const others = [...live.values()].some((r) => r.chatId !== chatId);
  errors.delete(chatId);
  live.set(chatId, { chatId, subjectId, level, text: '', reasoning: '', started: null, messages: [], stopping: false,
    status: others ? 'Waiting for Apollo to finish another reply' : 'Sending…' });
  emit();
  let failed = false;
  try {
    await run((e) => { onEvent?.(e); apply(chatId, e); });
  } catch (err) {
    failed = true;
    errors.set(chatId, String(err).replace(/^Error: /, ''));
    throw err;
  } finally {
    let fresh: Message[] | null = null;
    try { fresh = (await api.chat(chatId)).messages; } catch (e) { logError('chat', e, 'warning'); }
    live.delete(chatId);
    if (viewing !== chatId || !document.hasFocus()) {
      unread = { ...unread, [chatId]: { subjectId, error: failed || errors.has(chatId) || undefined } };
      saveUnread();
    }
    finished.forEach((fn) => fn(chatId, fresh));
    emit();
  }
}

export function stopReply(chatId: number) {
  update(chatId, () => ({ stopping: true, status: 'Stopping…' }));
  api.stopChat(chatId).catch((e) => logError('chat', e, 'warning'));
}

/** The chat on screen: its dot clears, and a reply ending there doesn't add one. */
export function setViewing(chatId: number | null) {
  viewing = chatId;
  if (chatId != null && unread[chatId]) markRead(chatId);
}
export function markRead(...chatIds: number[]) {
  if (!chatIds.some((id) => unread[id])) return;
  unread = Object.fromEntries(Object.entries(unread).filter(([k]) => !chatIds.includes(Number(k))));
  saveUnread();
  emit();
}
// the window regaining focus counts as seeing the open chat
if (typeof window !== 'undefined') window.addEventListener('focus', () => { if (viewing != null) markRead(viewing); });

/** Called with the chat's messages as the server has them, once a reply in it ends. */
export function onReplyFinished(fn: (chatId: number, messages: Message[] | null) => void) {
  finished.add(fn);
  return () => { finished.delete(fn); };
}

export const clearError = (chatId: number) => { if (errors.delete(chatId)) emit(); };

/** The reply being written in `chatId`, re-rendered as its text grows (at most every TEXT_MS). Only the live bubble
 * should use this; everything else uses `useChatStreams`, which ignores new text. */
export function useLiveReply(chatId: number | null | undefined): LiveReply | undefined {
  return useSyncExternalStore(subscribeText, () => (chatId == null ? undefined : live.get(chatId)));
}

/** Re-render when a reply starts, ends, changes status or gets a message, and when dots or errors change — never per
 * token. `live(id)` gives the reply as it was at that moment (its text may be behind: use `useLiveReply` for text). */
export function useChatStreams() {
  useSyncExternalStore(subscribe, () => version);
  return {
    live: (chatId: number | null | undefined) => (chatId == null ? undefined : live.get(chatId)),
    error: (chatId: number | null | undefined) => (chatId == null ? undefined : errors.get(chatId)),
    unread: (chatId: number) => unread[chatId],
    /** Subjects with unread replies (error: one of them failed) or replies being written. */
    subjectState: (subjectId: number): 'live' | 'error' | 'unread' | null => {
      if ([...live.values()].some((r) => r.subjectId === subjectId)) return 'live';
      const mine = Object.values(unread).filter((u) => u.subjectId === subjectId);
      return mine.some((u) => u.error) ? 'error' : mine.length ? 'unread' : null;
    },
    anyLive: () => live.size > 0,
    /** Every reply being written (as of the last change; the app pet reads their status). */
    allLive: () => [...live.values()],
  };
}
