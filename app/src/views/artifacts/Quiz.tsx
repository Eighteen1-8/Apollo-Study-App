/* Quizzes: answer one question at a time, then results with Apollo's review of what to revise. */
import { useState } from 'react';
import { api, Artifact, QuizReview, Subject } from '../../api';
import Markdown from '../../components/Markdown';
import { Source } from './Sections';

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

export function Quiz({ artifact, subject }: { artifact: Artifact; subject: Subject }) {
  const qs = artifact.content!.questions ?? [];
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState(false);
  const q = qs[i];
  const score = qs.filter((qq, k) => checked[k] && picked[k] === qq.answer_index).length;

  const restart = () => { setI(0); setPicked({}); setChecked({}); setDone(false); };
  if (!qs.length) return <div className="muted">No questions were generated.</div>;
  if (done) return <QuizResults artifact={artifact} subject={subject} picked={picked} onRestart={restart} />;

  const isChecked = !!checked[i];
  const right = picked[i] === q.answer_index;
  return (
    <div className="quiz-page">
      <div className="quiz-steps">
        {qs.map((qq, k) => (
          <span key={k} className={`step${k === i ? ' current' : ''}${checked[k] ? (picked[k] === qq.answer_index ? ' right' : ' wrong') : ''}`} />
        ))}
      </div>
      <div className="quiz-card" key={i}>
        <div className="quiz-num">Question {i + 1} of {qs.length}</div>
        <Markdown text={questionText(q)} className="quiz-prompt" />
        <div className="options">
          {q.options.map((o, k) => (
            <button key={k} disabled={isChecked}
              className={`option${picked[i] === k ? ' selected' : ''}${isChecked && k === q.answer_index ? ' correct' : ''}${isChecked && k === picked[i] && !right ? ' wrong' : ''}`}
              onClick={() => setPicked({ ...picked, [i]: k })}>
              <span className="option-letter">{String.fromCharCode(65 + k)}</span><Markdown text={o} />
            </button>
          ))}
        </div>
        {isChecked && (
          <div className={`explain ${right ? 'explain-ok' : 'explain-bad'}`}>
            <b>{right ? 'Correct!' : `Not quite. The answer is ${String.fromCharCode(65 + q.answer_index)}.`}</b>
            <Markdown text={q.explanation} />
            <Source s={q.source} />
          </div>
        )}
        <div className="quiz-actions">
          <span className="muted small">{score} correct so far</span>
          <span className="spacer" />
          {!isChecked ? (
            <button className="btn btn-primary" disabled={picked[i] === undefined} onClick={() => setChecked({ ...checked, [i]: true })}>Check answer</button>
          ) : i < qs.length - 1 ? (
            <button className="btn btn-primary" onClick={() => setI(i + 1)}>Next question →</button>
          ) : (
            <button className="btn btn-primary" onClick={() => setDone(true)}>See results</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function QuizResults({ artifact, subject, picked, onRestart }: {
  artifact: Artifact; subject: Subject; picked: Record<number, number>; onRestart: () => void;
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
      setErr(String(e));
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
        <button className="btn" onClick={onRestart}>Retake quiz</button>
      </div>

      <div className="results-list">
        {qs.map((q, k) => (
          <div key={k} className={`result-row ${picked[k] === q.answer_index ? 'right' : 'wrong'}`}>
            <span className="result-mark">{picked[k] === q.answer_index ? '✓' : '✗'}</span>
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
        {err && <div className="small bad">{err}</div>}
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
                        {added.has(k) ? '✓ Added' : '+ Add to to-do'}
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
