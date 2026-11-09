/* How much of Apollo's "memory" this chat uses: a small ring in the composer that fills up, turns amber when the chat is
   getting long and red when Apollo has started leaving out the earliest messages, with a plain-words explanation on
   hover (the token numbers too, in advanced mode). Two limits count, whichever is nearer: the model's context window,
   and the share of the conversation sent with each question (chat_prompt.HISTORY_TOKENS). Once the chat is long,
   the ring gets a short label and clicking it starts a new chat. */
import { useEffect, useState } from 'react';
import { api, ChatContext } from '../api';
import { fmtTokens } from '../hooks';
import { logError } from '../log';

const R = 7;
const CIRC = 2 * Math.PI * R;

export function memoryUse(c: ChatContext) {
  const windowFrac = c.total / Math.max(1, c.limit);
  const convoFrac = c.history_limit ? (c.conversation ?? 0) / c.history_limit : 0; // (a backend not yet restarted has neither)
  const frac = Math.max(windowFrac, convoFrac);
  const level: 'ok' | 'warn' | 'bad' = frac >= 1 || windowFrac >= 0.9 ? 'bad' : frac >= 0.7 ? 'warn' : 'ok';
  return { frac, level, convoOver: convoFrac >= 1 };
}

function plainTip(c: ChatContext, pct: number, level: 'ok' | 'warn' | 'bad', convoOver: boolean) {
  if (level === 'ok') {
    return `Apollo's memory for this chat: ${pct}% used. Apollo can see your whole conversation, so you can keep asking `
      + 'follow-up questions here.';
  }
  if (level === 'warn') {
    return `This chat is getting long (${pct}% of Apollo's memory). Soon Apollo will start forgetting the earliest `
      + 'messages. For a new question, a new chat gives the clearest answers. Click to start one.';
  }
  return (convoOver
    ? 'Apollo\'s memory for this chat is full, so it can no longer see the earliest messages here (it still sees your study material). '
    : 'This chat is close to the most Apollo can read at once, so answers may get slower or leave things out. ')
    + 'Click to start a new chat; this one stays in your chat list.';
}

export default function ContextMeter({ chatId, deps, advanced, onNewChat }: {
  chatId: number; deps: unknown[]; advanced: boolean; onNewChat: () => void;
}) {
  const [c, setC] = useState<ChatContext | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.chatContext(chatId).then((x) => alive && setC(x)).catch((e) => logError('context meter', e, 'warning'));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [chatId, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const { frac, level, convoOver } = memoryUse(c);
  const pct = Math.min(100, Math.round(frac * 100));
  let tip = plainTip(c, pct, level, convoOver);
  if (advanced) {
    tip += `\n\nContext window: ${c.exact ? '' : '≈ '}${c.total.toLocaleString()} / ${c.limit.toLocaleString()} tokens `
      + `(instructions ≈ ${c.system.toLocaleString()}, material ≈ ${c.material.toLocaleString()}`
      + `${c.full_context ? '' : ' plus excerpts per question'}, conversation sent ≈ ${c.history.toLocaleString()}). `
      + `Conversation ≈ ${c.conversation.toLocaleString()} of the ${c.history_limit.toLocaleString()} sent with each question.`;
  }
  const label = level === 'bad' ? 'Memory full' : level === 'warn' ? 'Chat getting long' : null;
  const ring = (
    <svg className="ctx-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="ctx-ring-track" cx="9" cy="9" r={R} />
      <circle className="ctx-ring-fill" cx="9" cy="9" r={R}
        strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - Math.max(0.03, Math.min(1, frac)))} />
    </svg>
  );
  const aria = `Apollo's memory for this chat: ${pct}% used`;
  if (!label) {
    return (
      <span className="ctx-meter lvl-ok" data-tip={tip} role="img" tabIndex={0} aria-label={aria}>
        {ring}{advanced && <span className="ctx-meter-num">{fmtTokens(c.total)}</span>}
      </span>
    );
  }
  return (
    <button type="button" className={`ctx-meter lvl-${level}`} data-tip={tip} aria-label={`${aria}. Start a new chat`} onClick={onNewChat}>
      {ring}<span className="ctx-meter-label">{label}</span>
    </button>
  );
}
