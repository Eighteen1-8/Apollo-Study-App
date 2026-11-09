/* An error in plain words with its code as a small link; clicking the code opens its entry from the error reference
   (backend errors.py, the same text as docs/ERRORS.md): what it means technically, likely causes, how to fix it. The
   reference can also be browsed and searched as a whole (the help window). */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { ErrorEntry, splitError } from '../errors';
import { Modal } from './overlay';
import Icon from './Icon';
import { toast } from './toast';

let shown: { code: string | null; context: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
/** Open the error reference at a code (null: the whole list). `context` is the message it came with (for Copy). */
export function openErrorHelp(code: string | null, context = '') { shown = { code, context }; emit(); }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

let cache: Promise<ErrorEntry[]> | null = null;
const entries = () => (cache ??= api.errorCodes().catch((e) => { cache = null; throw e; }));

/** The code as a chip (when there is one) after the message. */
export default function ErrorText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  const { message, code } = splitError(text);
  return (
    <span className={`err-text${className ? ` ${className}` : ''}`}>
      {message}
      {code && <>{' '}<ErrorCode code={code} context={message} /></>}
    </span>
  );
}

export function ErrorCode({ code, context = '' }: { code: string; context?: string }) {
  return (
    // a span, not a button: it can sit inside clickable rows that are buttons themselves
    <span role="button" tabIndex={0} className="err-code" title="What does this mean? Click for details and how to fix it"
      onClick={(e) => { e.stopPropagation(); openErrorHelp(code, context); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openErrorHelp(code, context); } }}>
      <Icon name="help" size={11} strokeWidth={2.4} />{code}
    </span>
  );
}

/** Mounted once (App): the reference window. */
export function ErrorHelpLayer() {
  const state = useSyncExternalStore(subscribe, () => shown);
  const [list, setList] = useState<ErrorEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!state || list) return;
    entries().then(setList).catch(() => setFailed(true));
  }, [state, list]);
  const close = () => { shown = null; setQ(''); emit(); };
  const one = state?.code ? list?.find((e) => e.code === state.code) : null;
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list ?? []).filter((e) => !t || `${e.code} ${e.title} ${e.plain} ${e.meaning}`.toLowerCase().includes(t));
  }, [list, q]);
  if (!state) return null;

  const copy = (e: ErrorEntry) => {
    const text = [`${e.code} · ${e.title}`, state.context && `Message: ${state.context}`, `Meaning: ${e.meaning}`,
      `Likely causes: ${e.causes.join('; ')}`, `How to fix: ${e.fixes.join('; ')}`].filter(Boolean).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('Error details copied')).catch(() => undefined);
  };
  return (
    <Modal wide title={one ? <span className="err-help-title"><span className="err-help-code">{one.code}</span>{one.title}</span> : 'Error codes'}
      onClose={close}
      footer={<>
        {one && <button className="btn" onClick={() => { shown = { code: null, context: '' }; emit(); }}>All error codes</button>}
        {one && <button className="btn" onClick={() => copy(one)}><Icon name="copy" size={14} /> Copy details</button>}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={close}>Close</button>
      </>}>
      {failed && <p className="muted">The error reference couldn’t be loaded (the background service may be down). It’s also in
        the app’s folder as <b>docs/ERRORS.md</b>.</p>}
      {!list && !failed && <p className="muted">Loading…</p>}
      {state.code && list && !one && <p className="muted">No entry for {state.code}. It may come from a newer version of Apollo.</p>}
      {one && (
        <div className="err-help">
          {state.context && state.context !== one.plain && <div className="err-help-said"><Icon name="chat" size={14} /> {state.context}</div>}
          <p className="err-help-plain">{one.plain}</p>
          <h4>What it means</h4>
          <p>{one.meaning}</p>
          <h4>Likely causes</h4>
          <ul>{one.causes.map((c) => <li key={c}>{c}</li>)}</ul>
          <h4>How to fix it</h4>
          <ol>{one.fixes.map((f) => <li key={f}>{f}</li>)}</ol>
          <p className="err-help-log muted small">The full technical detail is in the app’s log (<code>logs/backend.log</code> in the data
            folder), on a line starting with {one.code}.</p>
        </div>
      )}
      {!state.code && list && (
        <div className="err-list">
          <input className="input" autoFocus placeholder="Search codes and descriptions" value={q} onChange={(e) => setQ(e.target.value)} />
          {filtered.map((e) => (
            <button key={e.code} className="err-list-item" onClick={() => { shown = { code: e.code, context: '' }; emit(); }}>
              <span className="err-help-code">{e.code}</span>
              <span className="err-list-main"><b>{e.title}</b><small>{e.plain}</small></span>
            </button>
          ))}
          {!filtered.length && <p className="muted">No code matches.</p>}
        </div>
      )}
    </Modal>
  );
}
