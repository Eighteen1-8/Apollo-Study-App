/* The chat's composer (ChatView). */
import { AreaSource, Chat, ChatFileCheck, inElectron, Quote, ToolName } from '../../api';
import { DraggedDoc } from '../../components/FileList';
import { useOverlay } from '../../components/overlay';
import { CREATE_ITEMS } from '../SubjectView';
import { stopReply } from '../../chatStreams';
import { runsAtOnce, SlashCommand, SlashMenu, useSlashMenu } from '../../components/slashCommands';
import ContextMeter from '../../components/ContextMeter';
import { levelLabel } from './types';
import { useTerms } from '../../terms';
import { useAdvanced } from '../../theme';
import Icon from '../../components/Icon';

/** The chat box and what sits around it: the highlight being replied to, attached files, slash-command suggestions,
 * send/stop, and the bar below (attach, topic, reasoning, context meter, create). */
export function Composer({ quote, onClearQuote, attached, setAttached, tempFiles, setTempFiles, onShowArea, input, setInput,
  textarea, busy, stopping, chat, send, runCommand, card, addFiles, pickTopic, pickReasoning, reasoning, topicName,
  finishedTick, messageCount, floating, quick }: {
  quote: (Quote & { nonce: number }) | null; onClearQuote: () => void;
  attached: DraggedDoc[]; setAttached: React.Dispatch<React.SetStateAction<DraggedDoc[]>>;
  tempFiles: ChatFileCheck[]; setTempFiles: React.Dispatch<React.SetStateAction<ChatFileCheck[]>>;
  onShowArea: (s: AreaSource) => void; input: string; setInput: (s: string) => void;
  textarea: React.RefObject<HTMLTextAreaElement>; busy: boolean; stopping: boolean; chat: Chat | null;
  send: () => void; runCommand: (text: string) => Promise<void>; card: (node: React.ReactNode) => void;
  addFiles: (paths: string[]) => void; pickTopic: (e: React.MouseEvent) => void; pickReasoning: (e: React.MouseEvent) => void;
  reasoning: string; topicName: (id: number | null | undefined) => string; finishedTick: number; messageCount: number;
  floating: boolean; quick: (tool: ToolName) => void;
}) {
  const ov = useOverlay();
  const tr = useTerms();
  const advanced = useAdvanced();
  /** Enter or a click on a suggestion: run it when it needs nothing more; otherwise put it in the box to finish
   * typing. Tab always just completes the name. */
  const slash = useSlashMenu(input, (c: SlashCommand, complete: boolean) => {
    textarea.current?.focus();
    if (!complete && runsAtOnce(c)) {
      setInput('');
      runCommand(`/${c.name}`).catch((e) => card(<div className="banner banner-bad">{String(e).replace(/^Error: /, '')}</div>));
      return;
    }
    setInput(`/${c.name}${c.args ? ' ' : ''}`);
  }, () => setInput(''));

  return (
    <div className="composer">
      {quote && (
        <div className="reply-banner">
          <div className="reply-main">
            <div className="reply-label">{quote.kind === 'reply'
              ? <>Replying to part of Apollo's answer</>
              : <>Replying to a highlight in <b>{quote.filename}</b>{quote.label && ` · ${quote.label.split(' · ')[0]}`}</>}</div>
            <div className="reply-text">“{quote.text}”</div>
          </div>
          <button className="x-btn" title={quote.kind === 'reply' ? 'Stop replying to this' : 'Remove highlight'} onClick={onClearQuote}><Icon name="close" size={14} /></button>
        </div>
      )}
      {attached.length > 0 && (
        <div className="attach-row">
          {attached.map((d) => (
            <span key={d.id} className="attach-chip" title={d.filename}>
              <span className="attach-icon"><Icon name="attach" size={13} /></span><span className="attach-name">{d.filename}</span>
              <button className="x-btn" title="Remove" onClick={() => setAttached((a) => a.filter((x) => x.id !== d.id))}><Icon name="close" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      {tempFiles.length > 0 && (
        <div className="attach-row">
          {tempFiles.map((f) => (
            <span key={f.path} className="attach-chip attach-temp"
              title={`${f.name}: sent with this message only, not added to your library${f.words ? ` (${f.words.toLocaleString()} words)` : ''}`}>
              <span className="attach-icon"><Icon name={f.kind === 'image' ? 'image' : 'file'} size={13} /></span>
              {f.source
                ? <button className="attach-name attach-jump" title="Show where this screenshot came from" onClick={() => onShowArea(f.source!)}>{f.name}</button>
                : <span className="attach-name">{f.name}</span>}
              <span className="attach-tag">temporary</span>
              <button className="x-btn" title="Remove" onClick={() => setTempFiles((a) => a.filter((x) => x.path !== f.path))}><Icon name="close" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input">
        <SlashMenu menu={slash} />
        <textarea ref={textarea} rows={1}
          placeholder={quote ? (quote.kind === 'reply' ? 'Reply to that part of the answer…' : 'Ask about the highlighted text…') : attached.length || tempFiles.length ? 'Ask about the attached file…' : `Message Apollo about ${topicName(chat?.topic_id)}… (/ for commands)`}
          value={input} onChange={(e) => { setInput(e.target.value); slash.reset(); }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (e.key === 'Escape' && busy && chat) { e.preventDefault(); stopReply(chat.id); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy || input.trim().startsWith('/')) send(); }
          }} />
        {busy && !input.trim().startsWith('/') ? (
          <button className="send-btn stop-btn" disabled={stopping} onClick={() => chat && stopReply(chat.id)}
            title="Stop generating (Esc)" aria-label="Stop generating">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg>
          </button>
        ) : (
          <button className="send-btn" disabled={!input.trim()} onClick={send} title="Send (Enter)"><Icon name="send" size={18} strokeWidth={2.4} /></button>
        )}
      </div>
      <div className="composer-bar">
        <button className="pill-btn attach-btn" disabled={!inElectron} title="Attach a file to this message (not added to your library)"
          onClick={async () => addFiles(await window.studyApp!.openFiles({ multi: true }))}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.2-4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
        <button className="pill-btn" onClick={pickTopic} title="Which material Apollo uses">
          <span className="pill-select-label">{tr('topicPill')}</span> <b>{topicName(chat?.topic_id)}</b> <Icon name="chevronDown" size={13} className="caret" />
        </button>
        <button className={`pill-btn reasoning-btn lvl-${reasoning}`} onClick={pickReasoning} title="How much Apollo thinks before answering">
          <Icon name="brain" size={14} className="brain" /> {tr('reasoning')}: <b>{levelLabel(reasoning)}</b> <Icon name="chevronDown" size={13} className="caret" />
        </button>
        {chat && <ContextMeter chatId={chat.id} deps={[chat.topic_id, finishedTick, messageCount]} advanced={advanced}
          onNewChat={() => { runCommand('/new').catch((e) => card(<div className="banner banner-bad">{String(e).replace(/^Error: /, '')}</div>)); }} />}
        <span className="spacer" />
        {!floating && CREATE_ITEMS.filter((c) => c.chat !== false).map((c) => (
          <button key={c.tool} className="chip" onClick={() => quick(c.tool)}>{c.label.replace(' (from a practice exam)', '')}</button>
        ))}
        {floating && (
          <button className="pill-btn" onClick={(e) => ov.menu(e, CREATE_ITEMS.filter((c) => c.chat !== false).map((c) => ({ label: c.label, onClick: () => quick(c.tool) })),
            { anchor: e.currentTarget, place: 'above' })}><Icon name="create" size={14} /> Create <Icon name="chevronDown" size={13} className="caret" /></button>
        )}
      </div>
    </div>
  );
}
