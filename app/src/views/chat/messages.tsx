/* The chat's messages: saved ones (MessageView), the reply being written (LiveBubble) and their parts. */
import { useEffect, useState } from 'react';
import { api, AreaSource, Message, Review, Subject } from '../../api';
import Markdown, { RESOLVED, StreamingMarkdown } from '../../components/Markdown';
import { Progress } from '../../components/ui';
import { onChange } from '../../events';
import { useLiveReply } from '../../chatStreams';

import { LEVEL_LABEL } from './types';
import { ArtifactCard, ToolForm } from './ToolForm';

/** The reply being written: the only part of the chat that re-renders as text streams in (`useLiveReply`). */
export function LiveBubble({ chatId, onCite, onGrow }: { chatId: number; onCite: (file: string, label: string) => void; onGrow: () => void }) {
  const live = useLiveReply(chatId);
  useEffect(onGrow, [live?.text.length, live?.reasoning.length, live?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!live) return null;
  return (
    <div className="msg msg-assistant">
      {live.reasoning && (
        <ReasoningBlock text={live.reasoning} live={!live.text} started={live.started ?? undefined} level={live.level} />
      )}
      {live.text ? <StreamingMarkdown text={live.text} onCite={onCite} />
        : !live.reasoning && <div className="typing">{live.status || 'Thinking'}<span className="dots" /></div>}
      {live.text && live.status && <div className="typing small">{live.status}<span className="dots" /></div>}
    </div>
  );
}

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

export type MsgActions = { busy: boolean; onEdit: (m: Message, text: string) => void; onRollback: (m: Message) => void; onRegenerate: (m: Message) => void };

export function MessageView({ m, subject, chatTopic, onReplace, onOpenArtifact, onCite, onOpenDoc, onOpenNote, actions, onShowArea }: {
  m: Message; subject: Subject; chatTopic: number | null; onReplace: (m: Message) => void;
  onOpenArtifact: (id: number) => void; onCite: (file: string, label: string) => void; onOpenDoc: (id: number) => void;
  onOpenNote: (id: number) => void;
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
        {m.meta.stopped && <div className="msg-stopped">■ Stopped</div>}
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
  if (m.meta.tool === 'review_content') {
    if (!m.meta.review_id) return <div className="msg msg-note small bad">{m.meta.error || m.content}</div>;
    return <ReviewMsgCard id={m.meta.review_id} title={m.meta.title ?? ''} mode={m.meta.mode ?? 'check'}
      onOpen={() => (m.meta.target === 'note' ? onOpenNote(m.meta.target_id!) : onOpenArtifact(m.meta.target_id!))} />;
  }
  if (m.meta.status === 'form') return <ToolForm m={m} subject={subject} chatTopic={chatTopic} onReplace={onReplace} />;
  if (m.meta.status === 'dismissed') return <div className="msg msg-note muted small">Cancelled: {m.content.toLowerCase()}</div>;
  return m.meta.artifact_id ? <ArtifactCard id={m.meta.artifact_id} initial={m.artifact ?? null} onOpen={onOpenArtifact} /> : null;
}

/** Apollo checking or revising a note because the student asked in chat: follows the review, opens the note. */
function ReviewMsgCard({ id, title, mode, onOpen }: { id: number; title: string; mode: 'check' | 'revise'; onOpen: () => void }) {
  const [r, setR] = useState<Review | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () => api.review(id).then((x) => alive && setR(x)).catch(() => alive && setGone(true));
    tick();
    const off = onChange(['reviews'], tick);
    return () => { alive = false; off(); };
  }, [id]);
  const busy = !r || r.status === 'queued' || r.status === 'running';
  const verdict = r?.result?.verdict;
  return (
    <div className={`msg artifact-card status-${r?.status ?? 'queued'}`}>
      <div className="artifact-icon t-notes">{mode === 'check' ? '✓' : '✎'}</div>
      <div className="artifact-main">
        <div className="artifact-title">{mode === 'check' ? 'Checking' : 'Revising'} {title}</div>
        {gone && <div className="muted small">This comment was dismissed.</div>}
        {!gone && busy && <><div className="muted small">{r?.status === 'running' ? r.message : 'Waiting for Apollo…'}</div><Progress value={r?.progress ?? 0} /></>}
        {r?.status === 'failed' && <div className="small bad">{r.error}</div>}
        {r?.status === 'ready' && (
          <div className="muted small">
            {mode === 'check'
              ? `${{ correct: 'Looks correct', mostly_correct: 'Mostly correct', incorrect: 'Has errors', unsure: 'Not covered by your material' }[verdict ?? 'unsure']}`
                + (r.result?.issues?.length ? ` · ${r.result.issues.length} issue${r.result.issues.length === 1 ? '' : 's'}` : '')
              : r.applied ? 'Applied' : 'Ready: open it to see the changes and apply them'}
          </div>
        )}
      </div>
      <div className="artifact-actions"><button className="btn btn-sm btn-primary" onClick={onOpen}>Open</button></div>
    </div>
  );
}
