/* Apollo's comments on a note or generated notes / cheat sheet: checks (is it correct?) and revisions (change it as
   asked), started from a right-click on highlighted text, the page's header, or the chat (review_content). A check
   lists each wrong passage with its fix; a revision shows what Apollo would write and changes nothing until applied
   (and can be undone). A check's comments are short, and each cites the slide or page it relies on as a link that
   opens it (the subject's citation handler, from props or subjectLinks). */
import { useState } from 'react';
import { api, Review, ReviewIssue, ReviewTarget } from '../api';
import { usePoll } from '../hooks';
import Markdown from './Markdown';
import { Progress } from './ui';
import Icon from './Icon';
import { useSubjectLinks } from './subjectLinks';

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: 'Looks correct', cls: 'ok' },
  mostly_correct: { label: 'Mostly correct', cls: 'warn' },
  incorrect: { label: 'Has errors', cls: 'bad' },
  unsure: { label: 'Not in your material', cls: 'muted' },
};
const busy = (r: Review) => r.status === 'queued' || r.status === 'running';

export function useReviews(target: ReviewTarget, id: number) {
  return usePoll(() => api.reviews(target, id), 800, [target, id], ['reviews']);
}

export default function Reviews({ target, id, list, onApplied, onFix, onClose, checkOnly, onIssue, emptyText, onCite }: {
  target: ReviewTarget; id: number; list: Review[];
  /** After a revision is applied or undone: reload the content. */
  onApplied: () => void;
  /** Put a check's fix into the text (the student's own note); returns false when the passage isn't there any more. */
  onFix?: (issue: ReviewIssue) => boolean | Promise<boolean>;
  onClose: () => void;
  /** Mind maps and drawings: checks only, no fix or revision buttons. */
  checkOnly?: boolean;
  /** Clicking an issue (a map shows the box or link it quotes). */
  onIssue?: (issue: ReviewIssue) => void;
  emptyText?: string;
  /** Open a cited file at its page (else the subject's, via subjectLinks). */
  onCite?: (file: string, label: string) => void;
}) {
  const links = useSubjectLinks();
  const cite = onCite ?? links.cite;
  return (
    <aside className="reviews" aria-label="Apollo's comments">
      <div className="reviews-head">
        <span>Apollo's comments</span>
        <button className="icon-btn" title="Hide" onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
      <div className="reviews-scroll">
        {list.length === 0 && (
          <div className="muted small reviews-empty">
            {emptyText ?? 'Highlight text and right-click it to have Apollo check it against your material, or to ask for a change.'}
          </div>
        )}
        {list.map((r) => <ReviewCard key={r.id} r={r} target={target} id={id} onApplied={onApplied} onFix={onFix} checkOnly={checkOnly} onIssue={onIssue} onCite={cite} />)}
      </div>
    </aside>
  );
}

function ReviewCard({ r, target, id, onApplied, onFix, checkOnly, onIssue, onCite }: {
  r: Review; target: ReviewTarget; id: number; onApplied: () => void; onFix?: (issue: ReviewIssue) => boolean | Promise<boolean>;
  checkOnly?: boolean; onIssue?: (issue: ReviewIssue) => void; onCite?: (file: string, label: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [fixed, setFixed] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const res = r.result;
  const v = res?.verdict ? VERDICT[res.verdict] : null;

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); onApplied(); } catch (e) { setErr(String(e).replace(/^Error: /, '')); }
  };
  /** A check's fix: straight into the student's own note, or (generated content, or the passage moved) a revision. */
  const fix = async (issue: ReviewIssue, i: number) => {
    if (onFix && (await onFix(issue))) { setFixed((s) => new Set(s).add(i)); return; }
    await run(() => api.startReview({
      target, target_id: id, mode: 'revise', quote: issue.quote, section: r.section,
      instruction: `Correct this: ${issue.problem} Use: ${issue.fix}`,
    }));
    setFixed((s) => new Set(s).add(i));
  };

  return (
    <div className={`review-card status-${r.status}${r.applied ? ' applied' : ''}`}>
      <div className="review-top">
        <span className={`review-kind ${r.mode}`}>{r.mode === 'check' ? 'Check' : 'Revision'}</span>
        {v && <span className={`review-verdict ${v.cls}`}>{v.label}</span>}
        {r.applied ? <span className="review-verdict ok">Applied</span> : null}
        <span className="spacer" />
        <button className="x-btn" title={busy(r) ? 'Cancel' : 'Dismiss'} onClick={() => run(() => api.dismissReview(r.id))}><Icon name="close" size={14} /></button>
      </div>
      {r.quote && <div className="review-quote">“{r.quote.length > 220 ? `${r.quote.slice(0, 220)}…` : r.quote}”</div>}
      {r.instruction && r.mode === 'revise' && <div className="review-instr">{r.instruction}</div>}
      {busy(r) && (
        <>
          <div className="muted small">{r.status === 'queued' ? 'Waiting for Apollo…' : r.message}</div>
          <Progress value={r.progress} />
        </>
      )}
      {r.status === 'failed' && <div className="small bad">{r.error}</div>}
      {r.status === 'ready' && r.mode === 'check' && res && (
        <>
          {res.summary && <Markdown className="review-text" text={res.summary} onCite={onCite} />}
          {(res.issues ?? []).map((iss, i) => (
            <div key={i} className={`review-issue${onIssue ? ' review-issue-link' : ''}`} onClick={onIssue ? () => onIssue(iss) : undefined}
              title={onIssue ? 'Show it' : undefined}>
              <div className="review-wrong">“{iss.quote}”</div>
              <Markdown className="review-text" text={iss.problem} onCite={onCite} />
              <div className="review-fix"><b>Fix:</b> <Markdown className="review-text inline" text={iss.fix} onCite={onCite} /></div>
              {iss.source && (/\[\[/.test(iss.source)
                ? <div className="review-src" onClick={(e) => e.stopPropagation()}><Markdown className="review-text inline" text={iss.source} onCite={onCite} /></div>
                : <div className="src-note">{iss.source}</div>)}
              {!checkOnly && <div className="review-actions">
                {fixed.has(i)
                  ? <span className="small ok">{onFix ? '✓ Fixed' : '✓ Revision started'}</span>
                  : <button className="btn btn-sm" onClick={() => fix(iss, i)}>{onFix ? 'Apply fix' : 'Fix with Apollo'}</button>}
              </div>}
            </div>
          ))}
        </>
      )}
      {r.status === 'ready' && r.mode === 'revise' && res && (
        <>
          {res.comment && <Markdown className="review-text" text={res.comment} />}
          <div className="review-actions">
            <button className="link-btn" onClick={() => setPreview(!preview)}>{preview ? 'Hide' : 'Show'} the new version</button>
            <span className="spacer" />
            {r.applied
              ? <button className="btn btn-sm" onClick={() => run(() => api.undoReview(r.id))}>Undo</button>
              : <button className="btn btn-sm btn-primary" onClick={() => run(() => api.applyReview(r.id))}>Apply</button>}
          </div>
          {preview && (
            <div className="review-preview">
              {(res.sections ?? []).map((s) => (
                <div key={s.index}>
                  {s.html != null ? <Markdown html text={s.html} figures={s.figures ?? {}} /> : <Markdown text={s.markdown ?? ''} />}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {err && <div className="small bad">{err}</div>}
    </div>
  );
}
