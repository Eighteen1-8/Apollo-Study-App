/* Quizzes: answer one question at a time, then results with Apollo's review of what to revise. Questions are
   multiple choice (A-D) or true/false (T/F: options ["True", "False"], `type: 'tf'`). */
import { useEffect, useState } from 'react';
import { api, Artifact, QuizReview, Subject } from '../../api';
import Markdown from '../../components/Markdown';
import { Source } from './Sections';
import Icon from '../../components/Icon';
import ErrorText from '../../components/ErrorText';

/** Some quizzes repeat the A-D options at the end of the question text; they're already shown as buttons. Cut that
 * tail only when it really starts with the first option. */
export const OPTS_IN_Q = /\n\s*\(?A[.)]\s/g;

export const WS = /\s+/;

export function questionText(q: { question: string; options: string[] }) {
  const found = [...q.question.matchAll(OPTS_IN_Q)];
  const m = found[found.length - 1];
  if (!m || !q.options.length) return q.question;
  const norm = (t: string) => t.split(WS).join(' ').trim().toLowerCase();
  return norm(q.question.slice(m.index! + m[0].length)).startsWith(norm(q.options[0]).slice(0, 30)) ? q.question.slice(0, m.index).trimEnd() : q.question;
}

/** The key shown on (and typed for) option k: A-D, or T/F for a true/false question. */
const optionKey = (q: { type?: string }, k: number) => (q.type === 'tf' ? (k === 0 ? 'T' : 'F') : String.fromCharCode(65 + k));

export function Quiz({ artifact, subject }: { artifact: Artifact; subject: Subject }) {
  const qs = artifact.content!.questions ?? [];
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState(false);
  // "Retry the ones you missed": only those questions, in order
  const [subset, setSubset] = useState<number[] | null>(null);
  const items = subset ?? qs.map((_, k) => k);
  const qi = items[i];
  const q = qs[qi];
  const score = items.filter((k) => checked[k] && picked[k] === qs[k].answer_index).length;

  const restart = () => { setI(0); setPicked({}); setChecked({}); setDone(false); setSubset(null); };
  const retryMissed = () => {
    const missed = qs.map((_, k) => k).filter((k) => picked[k] !== qs[k].answer_index);
    const clear = <T,>(m: Record<number, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => !missed.includes(Number(k)))) as Record<number, T>;
    setPicked(clear(picked)); setChecked(clear(checked)); setSubset(missed); setI(0); setDone(false);
  };
  const isChecked = !!checked[qi];
  const right = q ? picked[qi] === q.answer_index : false;
  const next = () => {
    if (picked[qi] === undefined) return;
    if (!isChecked) setChecked({ ...checked, [qi]: true });
    else if (i < items.length - 1) setI(i + 1);
    else setDone(true);
  };
  // keys: A–D (or 1–4) pick an answer, Enter checks it and then moves on
  useEffect(() => {
    if (done || !q) return;
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const n = q.type === 'tf' ? (key === 't' || key === '1' ? 0 : key === 'f' || key === '2' ? 1 : -1)
        : /^[1-9]$/.test(key) ? Number(key) - 1 : /^[a-i]$/.test(key) ? key.charCodeAt(0) - 97 : -1;
      if (n >= 0 && n < q.options.length && !isChecked) setPicked({ ...picked, [qi]: n });
      else if (e.key === 'Enter') { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  if (!qs.length) return <div className="muted">No questions were generated.</div>;
  if (done) return <QuizResults artifact={artifact} subject={subject} picked={picked} onRestart={restart} onRetryMissed={retryMissed} />;
  return (
    <div className="quiz-page">
      <div className="quiz-steps">
        {items.map((k, n) => (
          <span key={k} className={`step${n === i ? ' current' : ''}${checked[k] ? (picked[k] === qs[k].answer_index ? ' right' : ' wrong') : ''}`} />
        ))}
      </div>
      <div className="quiz-card" key={i}>
        <div className="quiz-num">{subset ? 'Retrying: ' : ''}Question {i + 1} of {items.length}</div>
        <Markdown text={questionText(q)} className="quiz-prompt" />
        <div className="options">
          {q.options.map((o, k) => (
            <button key={k} disabled={isChecked}
              className={`option${picked[qi] === k ? ' selected' : ''}${isChecked && k === q.answer_index ? ' correct' : ''}${isChecked && k === picked[qi] && !right ? ' wrong' : ''}`}
              onClick={() => setPicked({ ...picked, [qi]: k })}>
              <span className="option-letter">{optionKey(q, k)}</span><Markdown text={o} />
            </button>
          ))}
        </div>
        {isChecked && (
          <div className={`explain ${right ? 'explain-ok' : 'explain-bad'}`}>
            <b>{right ? 'Correct!' : `Not quite. The answer is ${q.type === 'tf' ? q.options[q.answer_index] : String.fromCharCode(65 + q.answer_index)}.`}</b>
            <Markdown text={q.explanation} />
            <Source s={q.source} />
          </div>
        )}
        <div className="quiz-actions">
          <span className="muted small">{score} correct so far · <span className="quiz-keys">pick with {q.type === 'tf' ? <><kbd>T</kbd> or <kbd>F</kbd></> : <><kbd>A</kbd>–<kbd>{String.fromCharCode(64 + q.options.length)}</kbd></>}, then <kbd>Enter</kbd></span></span>
          <span className="spacer" />
          {!isChecked ? (
            <button className="btn btn-primary" disabled={picked[qi] === undefined} onClick={next}>Check answer</button>
          ) : i < items.length - 1 ? (
            <button className="btn btn-primary" onClick={next}>Next question <Icon name="next" size={15} /></button>
          ) : (
            <button className="btn btn-primary" onClick={next}>See results</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function QuizResults({ artifact, subject, picked, onRestart, onRetryMissed }: {
  artifact: Artifact; subject: Subject; picked: Record<number, number>; onRestart: () => void; onRetryMissed?: () => void;
}) {
  const qs = artifact.content!.questions ?? [];
  const score = qs.filter((q, k) => picked[k] === q.answer_index).length;
  const [review, setReview] = useState<QuizReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const pct = Math.round((score / qs.length) * 100);

  const runReview = async () => {
    setLoading(true);
    setErr(null);
    try {
      setReview(await api.quizReview(artifact.id, Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v]))));
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setLoading(false);
    }
  };
  const addTodo = async (k: number, item: QuizReview['revise'][number]) => {
    await api.addTodo(subject.id, { text: item.topic, note: `${item.reason}${item.source ? ` (Revise: ${item.source})` : ''}`, topic_id: artifact.topic_id, source: 'quiz' });
    setAdded((s) => new Set(s).add(k));
  };

  return (
    <div className="quiz-page">
      <div className="results-hero">
        <div className="ring" style={{ ['--pct' as string]: `${pct}` }}><span>{score}/{qs.length}</span></div>
        <div>
          <div className="results-title">{pct >= 80 ? 'Great work!' : pct >= 50 ? 'Good effort' : 'Keep going'}</div>
          <div className="muted">{pct}% correct</div>
        </div>
        <span className="spacer" />
        {onRetryMissed && score < qs.length && <button className="btn btn-primary" onClick={onRetryMissed}>Retry the {qs.length - score} you missed</button>}
        <button className="btn" onClick={onRestart}>Retake quiz</button>
      </div>

      <div className="results-list">
        {qs.map((q, k) => (
          <div key={k} className={`result-row ${picked[k] === q.answer_index ? 'right' : 'wrong'}`}>
            <span className="result-mark" aria-label={picked[k] === q.answer_index ? 'Right' : 'Wrong'}>
              <Icon name={picked[k] === q.answer_index ? 'check' : 'wrong'} size={15} strokeWidth={2.6} /></span>
            <Markdown text={questionText(q)} />
          </div>
        ))}
      </div>

      <div className="review-box">
        {!review && (
          <>
            <div>
              <div className="review-title">Review with Apollo</div>
              <div className="muted small">Apollo looks at your answers and points out what to revise. You can add those topics to your to-do list.</div>
            </div>
            <button className="btn btn-primary" disabled={loading} onClick={runReview}>{loading ? 'Reviewing…' : 'Review my answers'}</button>
          </>
        )}
        {err && <div className="small bad"><ErrorText text={err} /></div>}
        {review && (
          <div className="review">
            <Markdown text={review.summary} />
            {review.strengths.length > 0 && (
              <>
                <div className="col-label">You understand</div>
                <ul className="strengths">{review.strengths.map((s, k) => <li key={k}>{s}</li>)}</ul>
              </>
            )}
            {review.revise.length > 0 && (
              <>
                <div className="col-label">Revise these</div>
                <div className="revise-list">
                  {review.revise.map((r, k) => (
                    <div key={k} className="revise-item">
                      <div className="revise-main">
                        <div className="revise-topic">{r.topic}</div>
                        <div className="muted small">{r.reason}</div>
                        {r.source && <div className="src-note">Revise from: {r.source}</div>}
                      </div>
                      <button className={`btn btn-sm${added.has(k) ? '' : ' btn-primary'}`} disabled={added.has(k)} onClick={() => addTodo(k, r)}>
                        {added.has(k) ? <><Icon name="check" size={14} /> Added</> : <><Icon name="add" size={14} /> Add to to-do</>}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
