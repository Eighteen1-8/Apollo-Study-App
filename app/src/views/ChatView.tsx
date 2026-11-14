import { useCallback, useEffect, useRef, useState } from 'react';
import { api, AreaSource, Chat, ChatEvent, ChatFileCheck, Message, Quote, Reasoning, Subject, ToolName } from '../api';
import type { Launch } from '../App';
import { DOC_DRAG, DraggedDoc, draggedDocs } from '../components/FileList';
import { useOverlay } from '../components/overlay';
import { logError } from '../log';
import { onChange } from '../events';
import { getPref, setPref } from '../prefs';
import { clearError, isLive, onReplyFinished, setViewing, startReply, useChatStreams } from '../chatStreams';
import { confirmDeleteChats, renameChatUndoable } from './chatActions';
import { levelLabel, ChatMode } from './chat/types';
import { levelHint } from '../terms';
import { isAdvanced } from '../theme';
import { EXPLAIN_PROMPT, LiveBubble, MessageView, ReplyPop } from './chat/messages';
import { runCommand as runSlashCommand } from './chat/commands';
import { Composer } from './chat/Composer';
import Icon from '../components/Icon';
import ErrorText from '../components/ErrorText';
import { TourButton, useFirstTime } from '../components/Tour';
import { appendDraft, registerComposer } from '../composerBridge';

export { levelLabel } from './chat/types';
export type { ChatMode } from './chat/types';
type Card = { id: number; chatId: number | null; node: React.ReactNode };
export type ChatDraft = { text: string; send: boolean; nonce: number; attachments?: DraggedDoc[]; files?: string[] };
/** What goes with a message instead of the composer's own chips (the study panel's bar has its own). */
type SendExtra = { attachments?: DraggedDoc[]; files?: string[]; /** instead of the banner's quote ("Explain this") */ quote?: Quote };

export default function ChatView({ subject, launch, floating, collapsed, mode, onMode, sideBySide, onToggleCollapse, onCite, onOpenArtifact,
  onOpenDoc, onOpenNote, quote, onClearQuote, onQuote, incoming, onShowArea, openRequest, onActiveChat, draft, closeOnly }: {
  subject: Subject; launch?: Launch; floating: boolean; collapsed: boolean; mode: ChatMode; onMode: (m: ChatMode) => void;
  /** Side by side is the chosen layout (also while full screen, so leaving full screen goes back to it). */
  sideBySide: boolean;
  /** Opened over the study panel: the header only offers Close (back to the panel), not minimise, split or full screen. */
  closeOnly?: boolean;
  onToggleCollapse: () => void; onCite: (file: string, label: string) => void; onOpenArtifact: (id: number) => void;
  onOpenDoc: (id: number) => void; quote: (Quote & { nonce: number }) | null; onClearQuote: () => void;
  /** Reply to a part of one of Apollo's answers (selected, then "Reply"): it becomes the composer's quote. */
  onQuote: (q: Quote) => void;
  /** Jump to where a screenshot came from. */
  onShowArea: (s: AreaSource) => void;
  /** Files dropped on the "send to chat" bar: read for one message, not ingested. */
  incoming: { paths: string[]; nonce: number } | null;
  onOpenNote: (id: number) => void;
  /** A chat picked in the sidebar's history (id null: start a new one). */
  openRequest: { id: number | null; nonce: number } | null;
  /** The chat now showing, for the sidebar's history. */
  onActiveChat: (id: number | null) => void;
  /** Text from the study panel's chat bar: a new chat with it in the composer, or sent straight away (`send`), with
   * the library files dropped on the bar (`attachments`) and files from the computer (`files`, paths). */
  draft?: ChatDraft | null;
}) {
  const ov = useOverlay();
  const streams = useChatStreams();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [levels, setLevels] = useState<string[]>(['low', 'medium', 'xhigh']);
  const [reasoning, setReasoning] = useState<Reasoning>('off');
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<DraggedDoc[]>([]);
  const [tempFiles, setTempFiles] = useState<ChatFileCheck[]>([]);
  const [dropping, setDropping] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [finishedTick, setFinishedTick] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const handledLaunch = useRef<number | null>(null);
  const chatRef = useRef<Chat | null>(null);
  chatRef.current = chat;
  const creating = useRef<Promise<Chat> | null>(null);

  const live = streams.live(chat?.id);
  const busy = !!live;
  const streamError = streams.error(chat?.id);

  // A new highlight from a document: show it as a reply banner and put the cursor in the composer.
  useEffect(() => { if (quote) setTimeout(() => textarea.current?.focus(), 50); }, [quote?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Files for this message only. They're checked now so a too-long file is refused before anything is typed. */
  const addFiles = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const checks = await api.inspectChatFiles(paths);
      setTempFiles((fs) => [...fs, ...checks.filter((c) => c.ok && !fs.some((f) => f.path === c.path))]);
      const bad = checks.filter((c) => !c.ok);
      setError(bad.length ? bad.map((c) => c.error).join('\n') : null);
    } catch (e) {
      setError(String(e));
    }
    setTimeout(() => textarea.current?.focus(), 50);
  };
  useEffect(() => {
    if (!incoming) return;
    if (collapsed) onToggleCollapse();
    addFiles(incoming.paths);
  }, [incoming?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.settings().then((s) => {
      const lv = Array.isArray(s.reasoning_levels) ? s.reasoning_levels as string[] : ['low', 'medium', 'xhigh'];
      setLevels(lv);
      const pref = getPref('chatReasoning', String(s.chat_reasoning_default ?? 'off'));
      setReasoning((pref === 'off' || lv.includes(pref) ? pref : 'off') as Reasoning);
    }).catch((e) => logError('chat', e, 'warning'));
  }, []);

  const loadChats = async () => {
    const list = await api.chats(subject.id);
    setChats(list);
    return list;
  };
  const openChat = async (id: number) => {
    const c = await api.chat(id);
    setChat(c);
    setMessages(c.messages);
    setError(null);
  };
  /** Never more than one blank chat: an empty open chat is reused, and so is a request already on its way (the
   * backend also hands back the subject's existing empty chat). */
  const newChat = async (topicId: number | null): Promise<Chat> => {
    const cur = chatRef.current;
    if (cur && !messages.length && !isLive(cur.id)) {
      if ((cur.topic_id ?? null) !== topicId) setChat(await api.setChatTopic(cur.id, topicId));
      setTimeout(() => textarea.current?.focus(), 50);
      return cur;
    }
    if (creating.current) return creating.current;
    creating.current = (async () => {
      const c = await api.createChat(subject.id, topicId);
      await loadChats();
      await openChat(c.id);
      setTimeout(() => textarea.current?.focus(), 50);
      return c;
    })();
    try { return await creating.current; } finally { creating.current = null; }
  };

  useEffect(() => {
    // Claim the launch synchronously, before any await, so a re-run of this effect can't open it twice.
    const doLaunch = !!launch && handledLaunch.current !== launch.nonce;
    if (doLaunch) handledLaunch.current = launch!.nonce;
    (async () => {
      const list = await loadChats();
      if (doLaunch && launch) {
        const c = await newChat(launch.topicId);
        const m = await api.openTool(c.id, launch.tool);
        setMessages((ms) => [...ms, m]);
      } else if (!chatRef.current && list.length) {
        await openChat(list[0].id);
      }
    })();
  }, [subject.id, launch?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reply that ends in the chat on screen: show the messages as the server stored them.
  useEffect(() => onReplyFinished((chatId, fresh) => {
    if (chatRef.current?.id === chatId && fresh) setMessages(fresh);
    setFinishedTick((t) => t + 1);
    loadChats().catch((e) => logError('chat', e, 'warning'));
  }), [subject.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chat on screen has no unread dot (and a reply ending in it adds none).
  useEffect(() => {
    setViewing(collapsed ? null : chat?.id ?? null);
    return () => setViewing(null);
  }, [chat?.id, collapsed]);

  // Scroll only the message list (scrollIntoView would also scroll the clipped chat shell and the window).
  const scrollDown = useCallback(() => {
    const list = bottom.current?.parentElement;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, []);
  useEffect(scrollDown, [messages.length, live?.status, live?.messages.length, cards.length, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onActiveChat(chat?.id ?? null); }, [chat?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Apollo names a chat in the background after its first reply: pick the new title up for the header and menu.
  useEffect(() => onChange(['chats'], () => {
    loadChats().then((list) => {
      setChat((c) => {
        if (!c) return c;
        const fresh = list.find((x) => x.id === c.id);
        if (!fresh) return c; // deleted elsewhere: handled by the sidebar
        return fresh.title !== c.title ? { ...c, title: fresh.title } : c;
      });
    }).catch((e) => logError('chat', e, 'warning'));
  }), [subject.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.id === null) newChat(chat?.topic_id ?? null);
    else if (openRequest.id !== chat?.id) openChat(openRequest.id).catch(() => loadChats());
    setTimeout(() => textarea.current?.focus(), 80);
  }, [openRequest?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureChat = async () => chat ?? (await newChat(null));

  // Typed in (or picked from) the study panel: always a fresh chat, so it never lands in an old conversation.
  const handledDraft = useRef<number | null>(null);
  const lastDraft = useRef(0);
  const draftText = useRef('');
  useEffect(() => {
    if (!draft || handledDraft.current === draft.nonce) return;
    handledDraft.current = draft.nonce; // claimed before any await (StrictMode runs effects twice)
    // more keystrokes of the same question (typed before the focus moved here): just the text
    const typing = !draft.send && draft.nonce - lastDraft.current < 3000;
    lastDraft.current = draft.nonce;
    draftText.current = draft.text;
    const docs = draft.attachments ?? [];
    if (!draft.send && docs.length) setAttached((a) => [...a, ...docs.filter((d) => !a.some((x) => x.id === d.id))]);
    if (typing) { setInput(draft.text); return; }
    (async () => {
      // a slash command picked or typed in the bar runs in the app (in the chat already open), never a new chat
      if (draft.send && draft.text.trim().startsWith('/')) { await sendText(draft.text); return; }
      const c = await newChat(null);
      if (draft.send) { await sendText(draft.text, c, { attachments: docs, files: draft.files ?? [] }); return; }
      if (draft.files?.length) addFiles(draft.files);
      setInput(draftText.current); // the latest text: more may have been typed while the chat opened
      setTimeout(() => {
        const t = textarea.current;
        if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
      }, 60);
    })().catch((e) => logError('chat', e, 'warning'));
  }, [draft?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const card = (node: React.ReactNode) => setCards((cs) => [...cs, { id: Date.now() + Math.random(), chatId: chatRef.current?.id ?? null, node }]);

  const send = () => sendText(input);
  /** `over`: the files to send instead of the composer's chips (the study panel's bar sends its own; read here, the
   * chips would be this render's, already stale after the awaits before it). */
  const sendText = async (raw: string, into?: Chat, over?: SendExtra) => {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      setInput('');
      await runCommand(text).catch((e) => card(<div className="banner banner-bad">{String(e).replace(/^Error: /, '')}</div>));
      return;
    }
    const c = into ?? await ensureChat();
    if (isLive(c.id)) return;
    const docs = over ? over.attachments ?? [] : attached;
    const paths = over ? over.files ?? [] : tempFiles.map((f) => f.path);
    const extra = { attachments: docs.map((d) => d.id), files: paths, quote: over?.quote ?? (quote ? stripNonce(quote) : null) };
    const before = { attached: over ? docs : attached, tempFiles: over ? [] : tempFiles };
    let accepted = false;
    if (!over?.quote) { // "Explain this" leaves what's being typed in the box alone
      setInput('');
      setAttached([]);
      setTempFiles([]);
    }
    setError(null);
    try {
      await startReply(c.id, subject.id, reasoning, (on) => api.ask(c.id, text, reasoning, on, extra), (e) => {
        if (e.type === 'user') { accepted = true; if (!over?.quote) onClearQuote(); }
      });
    } catch {
      // refused before it started: give the text back (only if the student is still in that chat)
      if (!accepted && chatRef.current?.id === c.id && !over?.quote) {
        setInput(text); setAttached(before.attached); setTempFiles(before.tempFiles);
        if (over?.files?.length) addFiles(over.files);
      }
    }
  };

  /** Edit or regenerate: drop the replaced messages locally, then stream the new turn. */
  const rerun = async (keep: (m: Message) => boolean, start: (on: (e: ChatEvent) => void) => Promise<void>) => {
    if (busy || !chat) return;
    setMessages((ms) => ms.filter(keep));
    setError(null);
    try { await startReply(chat.id, subject.id, reasoning, start); } catch { /* shown as the chat's error */ }
  };
  const editMessage = (m: Message, text: string) => rerun((x) => x.id < m.id, (on) => api.editMessage(m.id, text, reasoning, on));
  const regenerate = (m: Message) => {
    const asked = [...messages].reverse().find((x) => x.role === 'user' && x.id < m.id);
    if (asked) rerun((x) => x.id <= asked.id, (on) => api.regenerate(m.id, reasoning, on));
  };
  const rollback = async (m: Message) => {
    if (busy) return;
    const later = messages.filter((x) => x.id > m.id).length;
    const ok = await ov.confirm({
      title: 'Undo from this message?', confirmText: 'Undo', danger: true,
      body: `This message${later ? ` and the ${later} after it` : ''} will be removed and its text put back in the box below so you can change it. Anything generated stays in the library.`,
    });
    if (!ok) return;
    const removed = await api.rollback(m.id);
    setMessages((ms) => ms.filter((x) => x.id < m.id));
    setInput(removed.content);
    setTimeout(() => textarea.current?.focus(), 50);
    loadChats();
  };

  const quick = async (tool: ToolName, args: Record<string, unknown> = {}) => {
    const c = await ensureChat();
    const m = await api.openTool(c.id, tool, args);
    setMessages((ms) => [...ms, m]);
  };

  const setTopic = async (topicId: number | null) => {
    const c = await ensureChat();
    setChat(await api.setChatTopic(c.id, topicId));
  };
  const pickLevel = (l: string) => { setReasoning(l as Reasoning); setPref('chatReasoning', l); };

  const pickReasoning = (e: React.MouseEvent) => ov.menu(e, ['off', ...levels].map((l) => ({
    label: `${l === reasoning ? '✓ ' : '   '}${levelLabel(l)}${isAdvanced() ? (l === 'off' ? ' (fastest)' : l === levels[levels.length - 1] ? ' (most thorough)' : '') : levelHint(l) ? ` · ${levelHint(l)}` : ''}`,
    onClick: () => pickLevel(l),
  })), { anchor: e.currentTarget, place: 'above' });

  const pickTopic = (e: React.MouseEvent) => ov.menu(e, [null, ...subject.topics.map((t) => t.id)].map((id) => ({
    label: `${(chat?.topic_id ?? null) === id ? '✓ ' : '   '}${topicName(id)}`, onClick: () => setTopic(id),
  })), { anchor: e.currentTarget, place: 'above' });

  const afterDelete = async (ids: number[]) => {
    if (!chatRef.current || !ids.includes(chatRef.current.id)) { loadChats(); return; }
    setChat(null);
    setMessages([]);
    const list = await loadChats();
    if (list[0]) openChat(list[0].id);
  };
  const deleteThis = async () => {
    if (chat && await confirmDeleteChats(ov, [chat])) afterDelete([chat.id]);
  };
  const renameThis = async () => {
    if (!chat) return;
    const t = await ov.prompt({ title: 'Rename chat', initial: chat.title });
    if (t) { setChat(await renameChatUndoable(chat, t)); loadChats(); }
  };

  const historyMenu = (e: React.MouseEvent) => ov.menu(e, [
    { label: '+ New chat', onClick: () => newChat(chat?.topic_id ?? null) },
    ...chats.slice(0, 20).map((c, i) => ({
      label: `${c.id === chat?.id ? '● ' : '   '}${c.title.slice(0, 48)}`, separatorBefore: i === 0, onClick: () => openChat(c.id),
    })),
    ...(chat ? [
      { label: 'Rename this chat…', separatorBefore: true, onClick: renameThis },
      { label: 'Delete this chat…', danger: true, onClick: deleteThis },
    ] : []),
  ], { anchor: e.currentTarget, place: 'below' });

  // two separate toggles: side by side (with the document) and full screen; leaving full screen goes back to
  // whichever of floating / side by side it came from
  const toggleSplit = () => onMode(mode === 'split' ? 'float' : 'split');
  const toggleFull = () => onMode(mode === 'full' ? (sideBySide ? 'split' : 'float') : 'full');

  const runCommand = (text: string) => runSlashCommand(text, {
    chat, subject, levels, reasoning, busy, card, ensureChat, pickLevel, quick, setTopic, newChat, renameThis, deleteThis,
    setChat, loadChats,
  });
  const replace = (m: Message) => setMessages((ms) => ms.map((x) => (x.id === m.id ? m : x)));
  const topicName = (id: number | null | undefined) => subject.topics.find((t) => t.id === id)?.name ?? 'All topics';

  const isDocDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DOC_DRAG);
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    if (!isDocDrag(e)) return;
    e.preventDefault();
    const ds = draggedDocs(e);
    setAttached((a) => [...a, ...ds.filter((d) => !a.some((x) => x.id === d.id))]);
    if (collapsed) onToggleCollapse();
    setTimeout(() => textarea.current?.focus(), 50);
  };

  // the calculator's "Send to chat" (composerBridge.ts): the text goes in the box, editable, never sent by itself
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggleRef = useRef(onToggleCollapse);
  toggleRef.current = onToggleCollapse;
  useEffect(() => registerComposer((text) => {
    setInput((cur) => appendDraft(cur, text));
    if (collapsedRef.current) toggleRef.current();
    setTimeout(() => {
      const t = textarea.current;
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    }, 60);
  }), []);

  const shown = new Set(messages.map((m) => m.id));
  const liveMessages = (live?.messages ?? []).filter((m) => !shown.has(m.id));
  const myCards = cards.filter((c) => c.chatId === (chat?.id ?? null));
  const msgActions = { busy, onEdit: editMessage, onRollback: rollback, onRegenerate: regenerate };
  useFirstTime('chat', !collapsed && !!chat);

  return (
    <div className={`chat${dropping ? ' chat-dropping' : ''}`}
      onDragOver={(e) => { if (isDocDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={onDrop}>
      {dropping && <div className="chat-drop-hint">Drop to ask Apollo about this file</div>}
      <div className="chat-head" title={floating && mode !== 'full' ? 'Drag to move to the other side' : undefined}>
        <button className="chat-title-btn" onClick={historyMenu} title="Past chats">
          <span className="chat-title-text">{chat?.title ?? 'New chat'}</span>
          <svg className="chat-title-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-btn" data-tip="New chat" onClick={() => newChat(chat?.topic_id ?? null)}><Icon name="add" /></button>
        <span className="spacer" />
        {collapsed && streams.anyLive() && <span className="chat-busy">Apollo is replying…</span>}
        {!collapsed && <TourButton id="chat" className="head-tour" />}
        {floating && !collapsed && mode !== 'full' && !closeOnly && (
          <button className={`icon-btn head-tool${mode === 'split' ? ' on' : ''}`} aria-pressed={mode === 'split'}
            data-tip={mode === 'split' ? 'Back to a floating chat' : 'Side by side with what’s open (half and half)'} onClick={toggleSplit}>
            <SplitIcon />
          </button>
        )}
        {floating && !collapsed && !closeOnly && (
          <button className={`icon-btn head-tool${mode === 'full' ? ' on' : ''}`} aria-pressed={mode === 'full'}
            data-tip={mode === 'full' ? 'Exit full screen' : 'Full screen'} onClick={toggleFull}>
            {mode === 'full' ? <ShrinkIcon /> : <ExpandIcon />}
          </button>
        )}
        {floating && (closeOnly
          ? <button className="icon-btn" data-tip="Close the chat" aria-label="Close the chat" onClick={onToggleCollapse}><Icon name="close" /></button>
          : <button className="icon-btn" data-tip={collapsed ? 'Open chat' : 'Minimise chat'} onClick={onToggleCollapse}><Icon name={collapsed ? 'chevronUp' : 'minus'} /></button>
        )}
      </div>

      <div className="chat-body" aria-hidden={collapsed}>
          <div className="chat-scroll" data-find="the chat" ref={scroller}>
            {!collapsed && <ReplyPop scroller={scroller} onReply={onQuote} subjectId={subject.id}
              onExplain={(q) => { if (!busy) sendText(EXPLAIN_PROMPT, undefined, { quote: q }); }} />}
            {messages.length === 0 && !live && !myCards.length && (
              <div className="chat-empty">
                <div className="chat-empty-title">Ask anything about {subject.name}</div>
                {isAdvanced() ? (
                  <div className="muted">Pick a topic below, then ask a question, or ask Apollo to make flashcards, a quiz, an exam, notes, a cheat sheet or a mind map. Type <b>/</b> for commands.</div>
                ) : subject.reference_count === 0 && subject.topics.every((t) => !t.doc_count) ? (
                  <div className="muted">Apollo answers from your own material, and there's none in {subject.name} yet. Add your slides, notes or
                    textbooks with <b>+ Add files</b> on the right (or drag them into the window), then come back here. You can still ask general questions.</div>
                ) : (
                  <div className="muted">Ask a question about your material, e.g. <i>“Explain the main idea of the first lecture”</i>, or press
                    <b> Create</b> below to make flashcards, a quiz, an exam, notes, a cheat sheet or a mind map. <b>Using</b> picks which topic Apollo reads;
                    type <b>/</b> for commands.</div>
                )}
              </div>
            )}
            {[...messages, ...liveMessages].map((m) => (
              <MessageView key={m.id} m={m} subject={subject} chatTopic={chat?.topic_id ?? null}
                onReplace={replace} onOpenArtifact={onOpenArtifact} onCite={onCite} onOpenDoc={onOpenDoc} onOpenNote={onOpenNote}
                actions={msgActions} onShowArea={onShowArea} />
            ))}
            {live && <LiveBubble chatId={live.chatId} onCite={onCite} onGrow={scrollDown} />}
            {myCards.map((c) => (
              <div key={c.id} className="msg msg-local">
                {c.node}
                <button className="x-btn msg-local-x" title="Dismiss" onClick={() => setCards((cs) => cs.filter((x) => x.id !== c.id))}><Icon name="close" size={14} /></button>
              </div>
            ))}
            {(error || streamError) && (
              <div className="banner banner-bad"><ErrorText text={error || streamError} />
                <button className="x-btn" title="Dismiss" onClick={() => { setError(null); if (chat) clearError(chat.id); }}><Icon name="close" size={14} /></button>
              </div>
            )}
            <div ref={bottom} />
          </div>

          <Composer quote={quote} onClearQuote={onClearQuote} attached={attached} setAttached={setAttached}
            tempFiles={tempFiles} setTempFiles={setTempFiles} onShowArea={onShowArea} input={input} setInput={setInput}
            textarea={textarea} busy={busy} stopping={!!live?.stopping} chat={chat} send={send} runCommand={runCommand}
            card={card} addFiles={addFiles} pickTopic={pickTopic} pickReasoning={pickReasoning} reasoning={reasoning}
            topicName={topicName} finishedTick={finishedTick} messageCount={messages.length} floating={floating} quick={quick} />
      </div>
    </div>
  );
}

const stripNonce = ({ nonce: _n, ...q }: Quote & { nonce: number }): Quote => q;
const SplitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.4" /></svg>
);

const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const ShrinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

