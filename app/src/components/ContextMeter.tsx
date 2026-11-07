/* How full the model's context window is for the chat's next question: a thin bar in the composer, the numbers on hover. */
import { useEffect, useState } from 'react';
import { api, ChatContext } from '../api';
import { fmtTokens } from '../hooks';
import { logError } from '../log';

export default function ContextMeter({ chatId, deps }: { chatId: number; deps: unknown[] }) {
  const [c, setC] = useState<ChatContext | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.chatContext(chatId).then((x) => alive && setC(x)).catch((e) => logError('context meter', e, 'warning'));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [chatId, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const frac = Math.min(1, c.total / Math.max(1, c.limit));
  const level = frac >= 0.9 ? 'bad' : frac >= 0.75 ? 'warn' : 'ok';
  const tip = `${c.exact ? '' : '≈ '}${c.total.toLocaleString()} / ${c.limit.toLocaleString()} tokens (${Math.round(frac * 100)}%) · `
    + `instructions ≈ ${c.system.toLocaleString()} · material ≈ ${c.material.toLocaleString()}`
    + `${c.full_context ? '' : ' (plus excerpts per question)'} · conversation ≈ ${c.history.toLocaleString()}`;
  return (
    <span className={`ctx-meter lvl-${level}`} data-tip={tip} aria-label={`Context window ${Math.round(frac * 100)}% full`}>
      <span className="ctx-meter-bar"><span style={{ width: `${Math.max(2, frac * 100)}%` }} /></span>
      <span className="ctx-meter-num">{fmtTokens(c.total)}</span>
    </span>
  );
}
