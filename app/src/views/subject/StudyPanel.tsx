/* The study panel that "Start studying" fades in over the subject's map: a chat bar across the top (Enter opens the
   chat, grown out of the bar, and sends the text), what to continue, the to-do list, and the Make content buttons. */
import { useEffect, useRef, useState } from 'react';
import { api, ArtifactType, Subject } from '../../api';
import { usePoll } from '../../hooks';
import Icon from '../../components/Icon';
import { Todos } from '../resources/Todos';
import { TYPE_ICON } from '../LibraryPanel';
import { MAKE_TYPES } from './MakeContent';

const ago = (t: number) => {
  const d = Math.floor((Date.now() / 1000 - t) / 86400);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const ACTION: Record<ArtifactType, string> = { flashcards: 'Practise', quiz: 'Start', exam: 'Start', notes: 'Read', cheatsheet: 'Read', mindmap: 'Open' };

export default function StudyPanel({ subject, open, onAsk, onOpenChat, onOpenArtifact, onMake }: {
  subject: Subject;
  /** Slid up (it stays mounted while hidden, so it slides away with its content). */
  open: boolean;
  /** Text for the chat: put in a new chat's composer (typing), or sent straight away (a suggestion). */
  onAsk: (text: string, send: boolean, from?: DOMRect) => void;
  onOpenChat: (id: number) => void; onOpenArtifact: (id: number) => void; onMake: (type: ArtifactType) => void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // the placeholder cycles through the three questions Apollo wrote for this subject (made once it had material)
  const asks = subject.questions?.length ? subject.questions : [`Ask anything about ${subject.name}…`];
  const [ask, setAsk] = useState(0);
  const [swap, setSwap] = useState(false);
  useEffect(() => {
    setAsk(0);
    if (!open || asks.length < 2) return;
    let fade = 0;
    const t = window.setInterval(() => {
      setSwap(true);
      fade = window.setTimeout(() => { setAsk((i) => (i + 1) % asks.length); setSwap(false); }, 400);
    }, 4500);
    return () => { clearInterval(t); clearTimeout(fade); setSwap(false); };
  }, [open, asks.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const lib = usePoll(() => api.library(subject.id), 5000, [subject.id], ['library']);
  const chats = usePoll(() => api.chats(subject.id), 5000, [subject.id], ['chats']);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus({ preventScroll: true }), 420);
    return () => clearTimeout(t);
  }, [open]);

  // typing stays here; Enter (or the send button) opens the chat, which grows out of this box, and sends the text
  const send = (t = text) => {
    const v = t.trim();
    onAsk(v, !!v, input.current?.getBoundingClientRect());
    setText('');
  };

  const topics = subject.topics.filter((t) => t.doc_count);
  const first = topics[0]?.name;
  const ideas = [
    first ? `Quiz me on ${first}` : 'Quiz me on what I’ve added',
    topics[1] ? `Explain the key ideas in ${topics[1].name} simply` : 'Explain the key ideas simply',
    'What should I revise first?',
  ];
  const recentChat = (chats.data ?? []).find((c) => c.title && c.title !== 'New chat');
  const recent = (lib.data ?? []).filter((it) => it.status === 'ready').slice(0, recentChat ? 2 : 3);

  return (
    <div className="study">
      <div className="study-ask">
        <div className="study-ask-head">
          <span className="study-ask-orb"><Icon name="ask" size={16} /></span>
          <b>Ask Apollo anything about {subject.name}</b>
        </div>
        <div className="study-ask-row">
          <textarea ref={input} rows={3} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim()) send(); } }} aria-label={`Ask Apollo about ${subject.name}`}
            className={swap ? 'swap' : undefined} placeholder={subject.questions?.length ? `e.g. ${asks[ask % asks.length]}` : asks[0]} />
          <button className="send-btn" aria-label="Open the chat" title="Open the chat" onClick={() => send()}>
            <Icon name="send" size={18} strokeWidth={2.4} />
          </button>
        </div>
        <div className="study-ideas">
          {ideas.map((t) => <button key={t} className="study-idea" onClick={() => send(t)}>{t}</button>)}
        </div>
      </div>

      <div className="study-row">
        <section className="study-card" aria-labelledby="study-continue">
          <h3 id="study-continue"><Icon name="history" size={16} /> Continue where you left off</h3>
          {!recent.length && !recentChat && (
            <p className="study-empty">Nothing yet. Ask Apollo something above, or make some flashcards below.</p>
          )}
          {recent.map((it) => (
            <button key={it.id} className="study-item" onClick={() => onOpenArtifact(it.id)}>
              <span className={`study-item-icon t-${it.type}`}>{TYPE_ICON(it.type, 17)}</span>
              <span className="study-item-main"><b>{it.title}</b><small>{it.topic_name ?? 'All topics'} · {ago(it.created_at)}</small></span>
              <span className="study-item-go">{ACTION[it.type]} <Icon name="chevronRight" size={14} /></span>
            </button>
          ))}
          {recentChat && (
            <button className="study-item" onClick={() => onOpenChat(recentChat.id)}>
              <span className="study-item-icon t-chat"><Icon name="chat" size={17} /></span>
              <span className="study-item-main"><b>{recentChat.title}</b><small>Chat · {ago(recentChat.updated_at)}</small></span>
              <span className="study-item-go">Open <Icon name="chevronRight" size={14} /></span>
            </button>
          )}
        </section>
        <section className="study-card study-todos" aria-label="To-do list">
          <Todos subject={subject} />
        </section>
      </div>

      <section className="study-card" aria-labelledby="study-make">
        <h3 id="study-make"><Icon name="create" size={16} /> Make content
          <span className="study-sub">Apollo makes it from your files; it appears on the left when it’s ready.</span></h3>
        <div className="study-makers">
          {MAKE_TYPES.map((t, i) => (
            <button key={t.type} className={`study-maker kind-${t.type}`} style={{ '--i': i } as React.CSSProperties} onClick={() => onMake(t.type)}>
              <span className={`study-maker-icon t-${t.type}`}>{TYPE_ICON(t.type, 18)}</span>{t.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
