import { useEffect, useRef, useState } from 'react';
import { api, AreaSource, ArtifactSummary, Chat, ChatEvent, ChatFileCheck, inElectron, Message, Quote, Reasoning, Subject, ToolName } from '../api';
import type { Launch } from '../App';
import { DOC_DRAG, DraggedDoc, draggedDocs } from '../components/FileList';
import Markdown, { RESOLVED } from '../components/Markdown';
import { useOverlay } from '../components/overlay';
import { Progress } from '../components/ui';
import { TYPE_ICON } from './LibraryPanel';
import { CREATE_ITEMS } from './SubjectView';

const TERMINAL = ['ready', 'failed', 'cancelled'];
const LEVEL_LABEL: Record<string, string> = { off: 'Off', low: 'Low', medium: 'Medium', xhigh: 'XHigh' };

function loadPref(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

export default function ChatView({ subject, launch, floating, collapsed, full, onToggleCollapse, onToggleFull, onCite, onOpenArtifact,
  onOpenDoc, quote, onClearQuote, incoming, onShowArea }: {
  subject: Subject; launch?: Launch; floating: boolean; collapsed: boolean; full: boolean; onToggleCollapse: () => void;
  onToggleFull: () => void; onCite: (file: string, label: string) => void; onOpenArtifact: (id: number) => void;
  onOpenDoc: (id: number) => void; quote: (Quote & { nonce: number }) | null; onClearQuote: () => void;
  /** Jump to where a screenshot came from. */
  onShowArea: (s: AreaSource) => void;
  /** Files dropped on the "send to chat" bar: read for one message, not ingested. */
  incoming: { paths: string[]; nonce: number } | null;
}) {
  const ov = useOverlay();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [levels, setLevels] = useState<string[]>(['low', 'medium', 'xhigh']);
  const [reasoning, setReasoning] = useState<Reasoning>('off');
  const [streaming, setStreaming] = useState<{ text: string; reasoning: string; status: string; started: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<DraggedDoc[]>([]);
  const [tempFiles, setTempFiles] = useState<ChatFileCheck[]>([]);
  const [dropping, setDropping] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const handledLaunch = useRef<number | null>(null);

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
      const pref = loadPref('chatReasoning', String(s.chat_reasoning_default ?? 'off'));
      setReasoning((pref === 'off' || lv.includes(pref) ? pref : 'off') as Reasoning);
    }).catch(() => {});
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
  };
  const newChat = async (topicId: number | null) => {
    const c = await api.createChat(subject.id, topicId);
    await loadChats();
    await openChat(c.id);
    return c;
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
      } else if (!chat && list.length) {
        await openChat(list[0].id);
      }
    })();
  }, [subject.id, launch?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll only the message list (scrollIntoView would also scroll the clipped chat shell and the window).
  useEffect(() => {
    const list = bottom.current?.parentElement;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streaming?.text, streaming?.status, collapsed]);

  const ensureChat = async () => chat ?? (await newChat(null));

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const c = await ensureChat();
    const extra = { attachments: attached.map((d) => d.id), files: tempFiles.map((f) => f.path), quote: quote ? stripNonce(quote) : null };
    const before = { attached, tempFiles };
    let accepted = false;
    setInput('');
    setAttached([]);
    setTempFiles([]);
    setError(null);
    setStreaming({ text: '', reasoning: '', status: 'Sending…', started: null });
    try {
      await api.ask(c.id, text, reasoning, (e) => {
        if (e.type === 'user') { accepted = true; onClearQuote(); }
        onEvent(e);
      }, extra);
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
      if (!accepted) { setInput(text); setAttached(before.attached); setTempFiles(before.tempFiles); } // refused: give it back
    } finally {
      setStreaming(null);
      loadChats();
    }
  };

  /** Applies one streamed chat event to the message list / live reply. */
  const onEvent = (e: ChatEvent) => {
    if (e.type === 'user' || e.type === 'assistant' || e.type === 'tool') {
      setMessages((ms) => [...ms, e.message]);
      if (e.type === 'assistant') setStreaming((s) => s && { ...s, text: '', reasoning: '' });
    } else if (e.type === 'delta') setStreaming((s) => s && { ...s, text: s.text + e.text, status: '' });
    else if (e.type === 'reasoning') setStreaming((s) => s && { ...s, reasoning: s.reasoning + e.text, status: '', started: s.started ?? Date.now() });
    else if (e.type === 'status') setStreaming((s) => s && { ...s, status: e.text });
    else if (e.type === 'error') setError(e.text);
  };

  /** Edit or regenerate: drop the replaced messages locally, then stream the new turn. */
  const rerun = async (keep: (m: Message) => boolean, start: (on: (e: ChatEvent) => void) => Promise<void>) => {
    if (streaming || !chat) return;
    setMessages((ms) => ms.filter(keep));
    setError(null);
    setStreaming({ text: '', reasoning: '', status: 'Sending…', started: null });
    try {
      await start(onEvent);
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
      openChat(chat.id); // resync with what the server kept
    } finally {
      setStreaming(null);
      loadChats();
    }
  };
  const editMessage = (m: Message, text: string) => rerun((x) => x.id < m.id, (on) => api.editMessage(m.id, text, reasoning, on));
  const regenerate = (m: Message) => {
    const asked = [...messages].reverse().find((x) => x.role === 'user' && x.id < m.id);
    if (asked) rerun((x) => x.id <= asked.id, (on) => api.regenerate(m.id, reasoning, on));
  };
  const rollback = async (m: Message) => {
    if (streaming) return;
    const later = messages.filter((x) => x.id > m.id).length;
    const ok = await ov.confirm({
      title: 'Undo from this message?', confirmText: 'Undo',
      body: `This message${later ? ` and the ${later} after it` : ''} will be removed and its text put back in the box below so you can change it. Anything generated stays in the library.`,
    });
    if (!ok) return;
    const removed = await api.rollback(m.id);
    setMessages((ms) => ms.filter((x) => x.id < m.id));
    setInput(removed.content);
    setTimeout(() => textarea.current?.focus(), 50);
    loadChats();
  };

  const quick = async (tool: ToolName) => {
    const c = await ensureChat();
    const m = await api.openTool(c.id, tool);
    setMessages((ms) => [...ms, m]);
  };

  const setTopic = async (topicId: number | null) => {
    const c = await ensureChat();
    setChat(await api.setChatTopic(c.id, topicId));
  };

  const pickReasoning = (e: React.MouseEvent) => ov.menu(e, ['off', ...levels].map((l) => ({
    label: `${l === reasoning ? '✓ ' : '   '}${LEVEL_LABEL[l] ?? l}${l === 'off' ? ' (fastest)' : l === levels[levels.length - 1] ? ' (most thorough)' : ''}`,
    onClick: () => { setReasoning(l as Reasoning); savePref('chatReasoning', l); },
  })), { anchor: e.currentTarget, place: 'above' });

  const pickTopic = (e: React.MouseEvent) => ov.menu(e, [null, ...subject.topics.map((t) => t.id)].map((id) => ({
    label: `${(chat?.topic_id ?? null) === id ? '✓ ' : '   '}${topicName(id)}`, onClick: () => setTopic(id),
  })), { anchor: e.currentTarget, place: 'above' });

  const historyMenu = (e: React.MouseEvent) => ov.menu(e, [
    { label: '+ New chat', onClick: () => newChat(chat?.topic_id ?? null) },
    ...chats.slice(0, 20).map((c, i) => ({
      label: `${c.id === chat?.id ? '● ' : '   '}${c.title.slice(0, 48)}`, separatorBefore: i === 0, onClick: () => openChat(c.id),
    })),
    ...(chat ? [
      { label: 'Rename this chat…', separatorBefore: true, onClick: async () => {
        const t = await ov.prompt({ title: 'Rename chat', initial: chat.title });
        if (t) { setChat(await api.renameChat(chat.id, t)); loadChats(); }
      } },
      { label: 'Delete this chat', danger: true, onClick: async () => {
        if (await ov.confirm({ title: 'Delete this chat?', danger: true, confirmText: 'Delete', body: 'Generated content stays in the library.' })) {
          await api.deleteChat(chat.id);
          setChat(null);
          setMessages([]);
          const list = await loadChats();
          if (list[0]) openChat(list[0].id);
        }
      } },
    ] : []),
  ], { anchor: e.currentTarget, place: 'below' });

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

  return (
    <div className={`chat${dropping ? ' chat-dropping' : ''}`}
      onDragOver={(e) => { if (isDocDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={onDrop}>
      {dropping && <div className="chat-drop-hint">Drop to ask Apollo about this file</div>}
      <div className="chat-head" title={floating ? 'Drag to move to the other corner' : undefined}>
        <button className="chat-title-btn" onClick={historyMenu} title="Past chats">
          <span className="chat-title-text">{chat?.title ?? 'New chat'}</span>
          <svg className="chat-title-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="icon-btn" data-tip="New chat" onClick={() => newChat(chat?.topic_id ?? null)}>＋</button>
        <span className="spacer" />
        {streaming && collapsed && <span className="chat-busy">Apollo is replying…</span>}
        {floating && !collapsed && (
          <button className="icon-btn head-tool" data-tip={full ? 'Back to the corner' : 'Full screen'} onClick={onToggleFull}>
            {full ? <ShrinkIcon /> : <ExpandIcon />}
          </button>
        )}
        {floating && (
          <button className="icon-btn" data-tip={collapsed ? 'Open chat' : 'Minimise chat'} onClick={onToggleCollapse}>{collapsed ? '▴' : '–'}</button>
        )}
      </div>

      <div className="chat-body" aria-hidden={collapsed}>
          <div className="chat-scroll">
            {messages.length === 0 && !streaming && (
              <div className="chat-empty">
                <div className="chat-empty-title">Ask anything about {subject.name}</div>
                <div className="muted">Pick a topic below, then ask a question, or ask Apollo to make flashcards, a quiz, an exam, notes or a cheat sheet.</div>
              </div>
            )}
            {messages.map((m) => (
              <MessageView key={m.id} m={m} subject={subject} chatTopic={chat?.topic_id ?? null}
                onReplace={replace} onOpenArtifact={onOpenArtifact} onCite={onCite} onOpenDoc={onOpenDoc}
                actions={{ busy: !!streaming, onEdit: editMessage, onRollback: rollback, onRegenerate: regenerate }} onShowArea={onShowArea} />
            ))}
            {streaming && (
              <div className="msg msg-assistant">
                {streaming.reasoning && (
                  <ReasoningBlock text={streaming.reasoning} live={!streaming.text} started={streaming.started ?? undefined} level={reasoning} />
                )}
                {streaming.text ? <Markdown text={streaming.text} onCite={onCite} />
                  : !streaming.reasoning && <div className="typing">{streaming.status || 'Thinking'}<span className="dots" /></div>}
              </div>
            )}
            {error && <div className="banner banner-bad">{error}</div>}
            <div ref={bottom} />
          </div>

          <div className="composer">
            {quote && (
              <div className="reply-banner">
                <div className="reply-main">
                  <div className="reply-label">Replying to a highlight in <b>{quote.filename}</b>{quote.label && ` · ${quote.label.split(' · ')[0]}`}</div>
                  <div className="reply-text">“{quote.text}”</div>
                </div>
                <button className="x-btn" title="Remove highlight" onClick={onClearQuote}>×</button>
              </div>
            )}
            {attached.length > 0 && (
              <div className="attach-row">
                {attached.map((d) => (
                  <span key={d.id} className="attach-chip" title={d.filename}>
                    <span className="attach-icon">📎</span><span className="attach-name">{d.filename}</span>
                    <button className="x-btn" title="Remove" onClick={() => setAttached((a) => a.filter((x) => x.id !== d.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
            {tempFiles.length > 0 && (
              <div className="attach-row">
                {tempFiles.map((f) => (
                  <span key={f.path} className="attach-chip attach-temp"
                    title={`${f.name}: sent with this message only, not added to your library${f.words ? ` (${f.words.toLocaleString()} words)` : ''}`}>
                    <span className="attach-icon">{f.kind === 'image' ? '🖼' : '📄'}</span>
                    {f.source
                      ? <button className="attach-name attach-jump" title="Show where this screenshot came from" onClick={() => onShowArea(f.source!)}>{f.name}</button>
                      : <span className="attach-name">{f.name}</span>}
                    <span className="attach-tag">temporary</span>
                    <button className="x-btn" title="Remove" onClick={() => setTempFiles((a) => a.filter((x) => x.path !== f.path))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-input">
              <textarea ref={textarea} rows={2}
                placeholder={quote ? 'Ask about the highlighted text…' : attached.length || tempFiles.length ? 'Ask about the attached file…' : `Message Apollo about ${topicName(chat?.topic_id)}…`}
                value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="send-btn" disabled={!input.trim() || !!streaming} onClick={send} title="Send (Enter)">↑</button>
            </div>
            <div className="composer-bar">
              <button className="pill-btn attach-btn" disabled={!inElectron} title="Attach a file to this message (not added to your library)"
                onClick={async () => addFiles(await window.studyApp!.openFiles({ multi: true }))}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.2-4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
              <button className="pill-btn" onClick={pickTopic} title="Which material Apollo uses">
                <span className="pill-select-label">Topic</span> <b>{topicName(chat?.topic_id)}</b> <span className="caret">▾</span>
              </button>
              <button className={`pill-btn reasoning-btn lvl-${reasoning}`} onClick={pickReasoning} title="How much Apollo thinks before answering">
                <span className="brain">◔</span> Reasoning: <b>{LEVEL_LABEL[reasoning] ?? reasoning}</b> <span className="caret">▾</span>
              </button>
              <span className="spacer" />
              {!floating && CREATE_ITEMS.map((c) => (
                <button key={c.tool} className="chip" onClick={() => quick(c.tool)}>{c.label.replace(' (from a practice exam)', '')}</button>
              ))}
              {floating && (
                <button className="pill-btn" onClick={(e) => ov.menu(e, CREATE_ITEMS.map((c) => ({ label: c.label, onClick: () => quick(c.tool) })),
                  { anchor: e.currentTarget, place: 'above' })}>Create <span className="caret">▾</span></button>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}

const stripNonce = ({ nonce: _n, ...q }: Quote & { nonce: number }): Quote => q;

const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const ShrinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function ReasoningBlock({ text, live, seconds, started, level }: {
  text: string; live?: boolean; seconds?: number | null; started?: number; level?: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [live]);
  const secs = live && started ? (now - started) / 1000 : seconds;
  return (
    <div className={`reasoning-block${open ? ' open' : ''}${live ? ' live' : ''}`}>
      <button className="reasoning-head" onClick={() => setOpen(!open)}>
        <span className="reasoning-chevron">{open ? '▾' : '▸'}</span>
        <span className="reasoning-label">{live ? 'Reasoning' : 'Reasoned'}{secs != null ? ` for ${secs.toFixed(1)}s` : ''}</span>
        {level && level !== 'off' && <span className="reasoning-level">{LEVEL_LABEL[level] ?? level}</span>}
      </button>
      {open && <div className="reasoning-body">{text || '…'}</div>}
    </div>
  );
}

type MsgActions = { busy: boolean; onEdit: (m: Message, text: string) => void; onRollback: (m: Message) => void; onRegenerate: (m: Message) => void };

function MessageView({ m, subject, chatTopic, onReplace, onOpenArtifact, onCite, onOpenDoc, actions, onShowArea }: {
  m: Message; subject: Subject; chatTopic: number | null; onReplace: (m: Message) => void;
  onOpenArtifact: (id: number) => void; onCite: (file: string, label: string) => void; onOpenDoc: (id: number) => void;
  actions: MsgActions; onShowArea: (s: AreaSource) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (m.role === 'user') {
    const q = m.meta.quote;
    if (editing !== null) {
      const save = () => { if (editing.trim()) { actions.onEdit(m, editing.trim()); setEditing(null); } };
      return (
        <div className="msg msg-user msg-editing">
          <textarea className="edit-box" autoFocus value={editing} rows={Math.min(10, editing.split('\n').length + 1)}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
              if (e.key === 'Escape') setEditing(null);
            }} />
          <div className="edit-actions">
            <span className="muted small">Everything after this message will be replaced.</span>
            <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={!editing.trim() || actions.busy} onClick={save}>Save &amp; send</button>
          </div>
        </div>
      );
    }
    return (
      <div className="msg msg-user">
        {q && (
          <button className="bubble-quote" title="Show in the document" onClick={() => onCite(q.filename, q.label)}>
            <span className="bubble-quote-src">{q.filename}{q.label && ` · ${q.label.split(' · ')[0]}`}</span>
            <span className="bubble-quote-text">“{q.text}”</span>
          </button>
        )}
        {m.meta.files?.length ? (
          <div className="attach-row attach-row-sent">
            {m.meta.files.map((f, i) => (f.source ? (
              <button key={i} className="attach-chip attach-temp" title="Show where this screenshot came from" onClick={() => onShowArea(f.source!)}>
                <span className="attach-icon">🖼</span><span className="attach-name">{f.name}</span><span className="attach-tag">↗ source</span>
              </button>
            ) : (
              <span key={i} className="attach-chip attach-temp" title="Sent with this message only">
                <span className="attach-icon">{f.kind === 'image' ? '🖼' : '📄'}</span><span className="attach-name">{f.name}</span>
              </span>
            )))}
          </div>
        ) : null}
        {m.meta.attachments?.length ? (
          <div className="attach-row attach-row-sent">
            {m.meta.attachments.map((a) => (
              <button key={a.id} className="attach-chip" title={`Open ${a.filename}`} onClick={() => onOpenDoc(a.id)}>
                <span className="attach-icon">📎</span><span className="attach-name">{a.filename}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="bubble">{m.content}</div>
        {!actions.busy && (
          <div className="msg-actions">
            <button className="msg-act" title="Edit and resend" onClick={() => setEditing(m.content)}>✎ Edit</button>
            <button className="msg-act" title="Remove this message and everything after it" onClick={() => actions.onRollback(m)}>↶ Undo from here</button>
          </div>
        )}
      </div>
    );
  }
  if (m.role === 'assistant') {
    return (
      <div className="msg msg-assistant">
        {m.meta.reasoning && <ReasoningBlock text={m.meta.reasoning} seconds={m.meta.reasoning_seconds} level={m.meta.reasoning_level} />}
        {m.meta.searched_other_topics?.length ? (
          <div className="searched-note">⌕ Searched your other topics for {m.meta.searched_other_topics.map((s) => `“${s}”`).join(', ')}</div>
        ) : null}
        <Markdown text={m.content} onCite={onCite} figures={m.meta.figures ?? RESOLVED} />
        {!actions.busy && (
          <div className="msg-actions">
            <button className="msg-act" title="Write a new answer" onClick={() => actions.onRegenerate(m)}>↻ Regenerate</button>
            <button className="msg-act" title="Copy the answer" onClick={() => {
              navigator.clipboard.writeText(m.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
          </div>
        )}
      </div>
    );
  }
  if (m.meta.tool === 'add_todos') {
    return (
      <div className="msg todo-card">
        <div className="todo-card-title">✓ Added to your revision to-do list</div>
        <ul>{(m.meta.todos ?? []).map((t, i) => <li key={i}>{t}</li>)}</ul>
      </div>
    );
  }
  if (m.meta.status === 'form') return <ToolForm m={m} subject={subject} chatTopic={chatTopic} onReplace={onReplace} />;
  if (m.meta.status === 'dismissed') return <div className="msg msg-note muted small">Cancelled: {m.content.toLowerCase()}</div>;
  return m.meta.artifact_id ? <ArtifactCard id={m.meta.artifact_id} initial={m.artifact ?? null} onOpen={onOpenArtifact} /> : null;
}

const FORM_TITLES: Record<string, string> = {
  flashcards: 'Create flashcards', quiz: 'Create a quiz', exam: 'Create an exam', notes: 'Compile full notes', cheatsheet: 'Create a cheat sheet',
};

function ToolForm({ m, subject, chatTopic, onReplace }: { m: Message; subject: Subject; chatTopic: number | null; onReplace: (m: Message) => void }) {
  const type = m.meta.type!;
  const args = m.meta.args ?? {};
  const [topic, setTopic] = useState<number | null>(m.meta.topic_id ?? chatTopic);
  const [count, setCount] = useState<number>(Number(args.count) || (type === 'quiz' ? 10 : 20));
  const [focus, setFocus] = useState<string>(String(args.focus ?? ''));
  const [difficulty, setDifficulty] = useState<string>(String(args.difficulty ?? ''));
  const [exam, setExam] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = type !== 'exam' || (exam && difficulty);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a: Record<string, unknown> = type === 'exam' ? { difficulty, practice_exam_path: exam }
        : type === 'flashcards' || type === 'quiz' ? { count, focus } : { focus };
      onReplace(await api.submitTool(m.id, a, topic));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg tool-card">
      <div className="tool-title">{FORM_TITLES[type]}</div>
      <div className="tool-grid">
        <label className="field">
          <span className="field-label">Material from</span>
          <select value={topic ?? ''} onChange={(e) => setTopic(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All topics in {subject.name}</option>
            {subject.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {(type === 'flashcards' || type === 'quiz') && (
          <label className="field">
            <span className="field-label">{type === 'quiz' ? 'Questions' : 'Cards'}</span>
            <input className="input" type="number" min={1} max={type === 'quiz' ? 60 : 200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
        )}
        {type !== 'exam' && (
          <label className="field field-wide">
            <span className="field-label">Focus (optional)</span>
            <input className="input" value={focus} placeholder="e.g. refraction and Snell's law" onChange={(e) => setFocus(e.target.value)} />
          </label>
        )}
        {type === 'exam' && (
          <>
            <div className="field field-wide">
              <span className="field-label">Practice exam</span>
              <div className="file-pick">
                <button className="btn btn-sm" disabled={!inElectron} onClick={async () => {
                  const p = await window.studyApp!.openFiles({ multi: false });
                  if (p[0]) setExam(p[0]);
                }}>{exam ? 'Change…' : 'Choose file…'}</button>
                <span className={exam ? '' : 'muted'}>{exam ? exam.split(/[\\/]/).pop() : 'Upload an exam you were given for this subject (PDF, Word, image).'}</span>
              </div>
              <span className="field-help">Only its structure is used (parts, question types, marks). It is not added to your material. Use an exam from the same subject.</span>
            </div>
            <div className="field field-wide">
              <span className="field-label">Difficulty</span>
              <div className="seg">
                {[['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']].map(([k, l]) => (
                  <button key={k} className={difficulty === k ? 'active' : ''} onClick={() => setDifficulty(k)}>{l}</button>
                ))}
              </div>
              <span className="field-help">
                {difficulty === 'easy' ? 'Same structure, simpler questions than the practice exam.'
                  : difficulty === 'hard' ? 'Same structure, harder questions than the practice exam.'
                  : difficulty === 'normal' ? 'Same structure and difficulty as the practice exam.' : 'Choose how hard the new exam should be.'}
              </span>
            </div>
          </>
        )}
      </div>
      {err && <div className="small bad">{err}</div>}
      <div className="tool-actions">
        <button className="btn btn-sm" onClick={async () => onReplace(await api.dismissTool(m.id))}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Starting…' : 'Generate'}</button>
      </div>
    </div>
  );
}

function ArtifactCard({ id, initial, onOpen }: { id: number; initial: ArtifactSummary | null; onOpen: (id: number) => void }) {
  const [a, setA] = useState<ArtifactSummary | null>(initial);
  const [gen, setGen] = useState(0); // bump to restart polling after a retry
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.artifact(id);
        if (!alive) return;
        setA(r);
        if (!TERMINAL.includes(r.status)) setTimeout(tick, 2000);
      } catch { if (alive) setA(null); }
    };
    tick();
    return () => { alive = false; };
  }, [id, gen]);
  if (!a) return <div className="msg msg-note muted small">This content was deleted.</div>;
  return (
    <div className={`msg artifact-card status-${a.status}`}>
      <div className={`artifact-icon t-${a.type}`}>{TYPE_ICON[a.type]}</div>
      <div className="artifact-main">
        <div className="artifact-title">{a.title}</div>
        {a.status === 'ready' && <div className="muted small">Ready · saved to the library</div>}
        {(a.status === 'queued' || a.status === 'running') && (
          <>
            <div className="muted small">{a.status === 'queued' ? 'Waiting for the model…' : a.message}</div>
            <Progress value={a.progress} />
          </>
        )}
        {a.status === 'failed' && <div className="small bad">{a.error}</div>}
        {a.status === 'cancelled' && <div className="muted small">Cancelled</div>}
      </div>
      <div className="artifact-actions">
        {a.status === 'ready' && <button className="btn btn-sm btn-primary" onClick={() => onOpen(a.id)}>Open</button>}
        {(a.status === 'queued' || a.status === 'running') && <button className="link-btn" onClick={() => api.cancelArtifact(a.id)}>Cancel</button>}
        {(a.status === 'failed' || a.status === 'cancelled') && (
          <button className="btn btn-sm" onClick={async () => { await api.retryArtifact(a.id); setGen((g) => g + 1); }}>Retry</button>
        )}
      </div>
    </div>
  );
}
