import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, Artifact, ArtifactContent, Attempt, ExamQuestion, QuizReview, Subject } from '../api';
import Markdown, { RESOLVED } from '../components/Markdown';
import { useOverlay } from '../components/overlay';
import { Progress } from '../components/ui';

/** Fullscreen viewer for generated content, closed with the × at the top right (or Escape). */
export default function ArtifactViewer({ id, subject, onClose }: { id: number; subject: Subject; onClose: () => void }) {
  const [a, setA] = useState<Artifact | null>(null);
  useEffect(() => { api.artifact(id).then(setA); }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-backdrop') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // portalled so it always covers the window, whatever transformed/clipped panel it was opened from
  return createPortal(
    <div className="fullscreen">
      <div className="fs-top">
        <div className="fs-title">{a?.title ?? 'Loading…'}</div>
        <button className="close-x close-x-lg" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      <div className="fs-body">
        {a?.content && (
          a.type === 'flashcards' ? <Flashcards artifact={a} />
            : a.type === 'quiz' ? <Quiz artifact={a} subject={subject} />
            : <div className="fs-doc">{a.type === 'exam' ? <Exam artifact={a} /> : <Sections content={a.content} />}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Notes and cheat sheets read like a document, so they open in the centre pane (the chat floats beside them). */
export function ArtifactPage({ id, onClose, onCite }: { id: number; onClose: () => void; onCite: (file: string, label: string) => void }) {
  const [a, setA] = useState<Artifact | null>(null);
  const [gen, setGen] = useState(0); // bumped by Regenerate to restart polling
  useEffect(() => {
    let alive = true;
    const load = () => api.artifact(id).then((x) => {
      if (!alive) return;
      setA(x);
      if (x.status === 'queued' || x.status === 'running') setTimeout(load, 2500); // regenerating
    });
    load();
    return () => { alive = false; };
  }, [id, gen]);
  const busy = a?.status === 'queued' || a?.status === 'running';
  return (
    <div className="source artifact-page">
      <header className="source-head">
        <div className="source-title" title={a?.title}>{a?.title ?? ''}</div>
        {a && <span className="muted small">{a.type === 'notes' ? 'Full notes' : 'Cheat sheet'} · {(a.content?.sections ?? []).length} sections</span>}
        {a && (busy
          ? <span className="muted small">{a.message || 'Regenerating…'} {Math.round(a.progress * 100)}%</span>
          : <button className="btn btn-sm" title="Write this again from your material" onClick={async () => {
            await api.retryArtifact(id);
            setA({ ...a, status: 'queued', progress: 0, message: 'Waiting for Apollo…' });
            setGen((g) => g + 1);
          }}>Regenerate</button>)}
        <button className="close-x" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="artifact-scroll">
        {a?.content && <div className="fs-doc"><Sections content={a.content} onCite={onCite} /></div>}
      </div>
    </div>
  );
}

function Source({ s }: { s?: string }) {
  return s ? <div className="src-note">Source: {s}</div> : null;
}

/* ---------------------------------------------------------------- flashcards */

type Rating = 'confident' | 'struggling';

function Flashcards({ artifact }: { artifact: Artifact }) {
  const ov = useOverlay();
  const [cards, setCards] = useState(() => artifact.content!.cards ?? []);
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [list, setList] = useState(false);
  const [ratings, setRatings] = useState<Record<number, Rating>>(() =>
    Object.fromEntries(Object.entries(artifact.ratings ?? {}).map(([k, v]) => [Number(k), v])));
  const [toast, setToast] = useState<string | null>(null);
  const idx = order[i];
  const c = cards[idx];
  const go = (d: number) => { setFlipped(false); setI((x) => (x + d + order.length) % order.length); };

  /** Delete badly generated cards (by deck index). Ratings follow the cards that stay, as the backend renumbers them. */
  const removeCards = async (idxs: number[]) => {
    const ok = await ov.confirm({ title: idxs.length === 1 ? 'Delete this card?' : `Delete ${idxs.length} cards?`,
      body: 'It is removed from the deck for good, along with its ✓/✗ rating.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    await api.deleteCards(artifact.id, idxs);
    const drop = new Set(idxs);
    const remap = new Map<number, number>();
    cards.forEach((_, k) => { if (!drop.has(k)) remap.set(k, remap.size); });
    setCards(cards.filter((_, k) => !drop.has(k)));
    setRatings((r) => Object.fromEntries(Object.entries(r).filter(([k]) => remap.has(Number(k))).map(([k, v]) => [remap.get(Number(k))!, v])));
    const kept = order.filter((k) => remap.has(k)).map((k) => remap.get(k)!);
    const next = kept.length ? kept : [...remap.values()];
    setOrder(next);
    setI((x) => Math.min(x, Math.max(0, next.length - 1)));
    setFlipped(false);
  };

  const rate = async (r: Rating) => {
    const next = ratings[idx] === r ? undefined : r;
    setRatings((m) => { const n = { ...m }; if (next) n[idx] = next; else delete n[idx]; return n; });
    await api.rateCard(artifact.id, idx, next ?? 'none');
    if (next === 'struggling') setToast('Noted. Apollo will give this extra attention in chat.');
    else if (next === 'confident') setToast('Marked as confident.');
    setTimeout(() => setToast(null), 2200);
    if (next) setTimeout(() => go(1), 350);
  };

  useEffect(() => {
    if (list) return;
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ') { e.preventDefault(); setFlipped((f) => !f); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  if (!cards.length) return <div className="muted">No cards were generated.</div>;
  const confident = Object.values(ratings).filter((r) => r === 'confident').length;
  const struggling = Object.values(ratings).filter((r) => r === 'struggling').length;

  return (
    <div className="fc-wrap">
      <div className="fc-bar">
        <span className="muted">{list ? `${cards.length} cards` : `Card ${i + 1} of ${cards.length}`}</span>
        <span className="fc-tally"><span className="ok">✓ {confident}</span><span className="bad">✗ {struggling}</span></span>
        <span className="spacer" />
        {!list && <button className="btn btn-sm" onClick={() => { setOrder([...order].sort(() => Math.random() - 0.5)); setI(0); setFlipped(false); }}>Shuffle</button>}
        {!list && struggling > 0 && <button className="btn btn-sm" onClick={() => { setOrder(order.filter((k) => ratings[k] === 'struggling')); setI(0); setFlipped(false); }}>Only ✗ cards</button>}
        {!list && order.length !== cards.length && <button className="btn btn-sm" onClick={() => { setOrder(cards.map((_, k) => k)); setI(0); }}>All cards</button>}
        {!list && <button className="btn btn-sm" data-tip="Delete this card from the deck" onClick={() => removeCards([idx])}>Delete card</button>}
        <button className="btn btn-sm" onClick={() => setList(!list)}>{list ? 'Study mode' : 'List all'}</button>
      </div>
      {list ? (
        <div className="card-list">
          {cards.map((c, k) => (
            <div key={k} className={`card-list-item${ratings[k] ? ` rated-${ratings[k]}` : ''}`}>
              <button className="x-btn card-x" title="Delete card" onClick={() => removeCards([k])}>×</button>
              <Markdown text={c.front} className="card-list-front" />
              <Markdown text={c.back} />
              <Source s={c.source} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className={`flashcard${flipped ? ' flipped' : ''}${ratings[idx] ? ` rated-${ratings[idx]}` : ''}`} onClick={() => setFlipped(!flipped)}>
            <div className="flashcard-inner">
              <div className="flashcard-face front"><Markdown text={c.front} /><div className="flip-hint">Click or press Space to flip</div></div>
              <div className="flashcard-face back"><Markdown text={c.back} /><Source s={c.source} /></div>
            </div>
          </div>
          <div className="fc-rate">
            <button className={`rate-btn rate-yes${ratings[idx] === 'confident' ? ' on' : ''}`} data-tip="I'm confident with this" onClick={() => rate('confident')}>✓</button>
            <button className={`rate-btn rate-no${ratings[idx] === 'struggling' ? ' on' : ''}`} data-tip="I need more revision on this" onClick={() => rate('struggling')}>✗</button>
          </div>
          <div className="viewer-nav">
            <button className="btn" onClick={() => go(-1)}>← Previous</button>
            <Progress value={(i + 1) / order.length} />
            <button className="btn btn-primary" onClick={() => go(1)}>Next →</button>
          </div>
          {toast && <div className="toast">{toast}</div>}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- quiz */

/** Some quizzes repeat the A-D options at the end of the question text; they're already shown as buttons. Cut that
 * tail only when it really starts with the first option. */
const OPTS_IN_Q = /\n\s*\(?A[.)]\s/g;
const WS = /\s+/;
function questionText(q: { question: string; options: string[] }) {
  const found = [...q.question.matchAll(OPTS_IN_Q)];
  const m = found[found.length - 1];
  if (!m || !q.options.length) return q.question;
  const norm = (t: string) => t.split(WS).join(' ').trim().toLowerCase();
  return norm(q.question.slice(m.index! + m[0].length)).startsWith(norm(q.options[0]).slice(0, 30)) ? q.question.slice(0, m.index).trimEnd() : q.question;
}

function Quiz({ artifact, subject }: { artifact: Artifact; subject: Subject }) {
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

function QuizResults({ artifact, subject, picked, onRestart }: {
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

/* ---------------------------------------------------------------- notes / cheat sheet */

function Sections({ content, onCite }: { content: ArtifactContent; onCite?: (file: string, label: string) => void }) {
  const secs = content.sections ?? [];
  return (
    <div className="notes">
      {secs.length > 1 && (
        <nav className="notes-toc">
          {secs.map((s, i) => <a key={i} href={`#sec-${i}`} onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById(`sec-${i}`);
            const pane = el?.closest<HTMLElement>('.artifact-scroll, .fs-body');
            if (el && pane) pane.scrollTo({ top: el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12, behavior: 'smooth' });
          }}>{s.title}</a>)}
        </nav>
      )}
      {secs.map((s, i) => (
        <section key={i} id={`sec-${i}`} className="notes-section">
          {secs.length > 1 && <div className="notes-src">{s.title}</div>}
          {!(s.html ?? s.markdown ?? '').trim()
            ? <div className="banner banner-warn">This section came back empty. Use Regenerate to write it again.</div>
            : s.html != null
              ? <Markdown html text={s.html} figures={s.figures ?? RESOLVED} onCite={onCite} />
              : <Markdown text={s.markdown ?? ''} onCite={onCite} />}
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- exam */

function leaves(parts: NonNullable<ArtifactContent['parts']>) {
  const out: { key: string; label: string; q: ExamQuestion | (ExamQuestion['subquestions'][number] & { type?: string; options?: string[] }) }[] = [];
  let n = 0;
  parts.forEach((p, pi) => p.questions.forEach((q, qi) => {
    n += 1;
    if (q.subquestions?.length) q.subquestions.forEach((s, si) => out.push({ key: `p${pi}q${qi}s${si}`, label: `Q${n}${String.fromCharCode(97 + si)}`, q: s }));
    else out.push({ key: `p${pi}q${qi}`, label: `Q${n}`, q });
  }));
  return out;
}

function Exam({ artifact }: { artifact: Artifact }) {
  const ov = useOverlay();
  const c = artifact.content!;
  const parts = c.parts ?? [];
  const keys = useMemo(() => leaves(parts), [parts]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (!attempt || attempt.status !== 'marking') return;
    const t = setTimeout(() => api.attempt(attempt.id).then(setAttempt), 2000);
    return () => clearTimeout(t);
  }, [attempt]);

  const loadAttempt = async (id: number) => {
    const a = await api.attempt(id);
    setAttempt(a);
    setAnswers(a.answers);
  };
  const submit = async () => {
    const blank = keys.filter((k) => !(answers[k.key] ?? '').trim()).length;
    if (!(await ov.confirm({ title: 'Submit exam for marking?', confirmText: 'Submit',
      body: blank ? `${blank} question(s) are unanswered and will score 0.` : 'Apollo will mark every answer against the marking guide.' }))) return;
    setAttempt(await api.submitAttempt(artifact.id, answers));
  };

  const marked = attempt?.status === 'marked' ? attempt.result : null;
  const locked = !!attempt;
  let qn = 0;

  return (
    <div className="exam">
      {c.warning && <div className="banner banner-warn">{c.warning}</div>}
      <div className="exam-meta">
        <span>Based on <b>{c.practice_exam}</b></span>
        <span>Difficulty: <b>{(c.difficulty ?? 'normal').replace(/^./, (x) => x.toUpperCase())}</b></span>
        <span>Total: <b>{c.total_marks} marks</b></span>
        {c.time_minutes ? <span>Time: <b>{c.time_minutes} min</b></span> : null}
        <span className="spacer" />
        {artifact.attempts.length > 0 && (
          <select value={attempt?.id ?? ''} onChange={(e) => e.target.value ? loadAttempt(Number(e.target.value)) : (setAttempt(null), setAnswers({}))}>
            <option value="">New attempt</option>
            {artifact.attempts.map((t) => <option key={t.id} value={t.id}>Attempt #{t.id}{t.score != null ? ` · ${t.score}/${t.total}` : ''}</option>)}
          </select>
        )}
        <label className="check"><input type="checkbox" checked={showKey} onChange={(e) => setShowKey(e.target.checked)} /> Show answers</label>
      </div>
      {c.blueprint?.instructions && <div className="exam-instructions">{c.blueprint.instructions}</div>}

      {attempt?.status === 'marking' && (
        <div className="marking"><div>{attempt.message || 'Marking…'}</div><Progress value={attempt.progress} /></div>
      )}
      {marked && (
        <div className="score">
          <div className="score-big">{attempt!.score}/{attempt!.total}</div>
          <div className="muted">{Math.round(((attempt!.score ?? 0) / (attempt!.total || 1)) * 100)}%</div>
        </div>
      )}

      {parts.map((p, pi) => (
        <section key={pi} className="exam-part">
          <h3>{p.name}</h3>
          {p.instructions && <div className="muted small">{p.instructions}</div>}
          {p.questions.map((q, qi) => {
            qn += 1;
            const subs = q.subquestions?.length ? q.subquestions : null;
            return (
              <div key={qi} className="exam-q">
                <div className="exam-q-head"><b>Question {qn}</b><span className="muted">{q.marks} mark{q.marks === 1 ? '' : 's'}</span></div>
                {q.stimulus && <div className="stimulus"><Markdown text={q.stimulus} /></div>}
                <Markdown text={q.prompt} />
                {subs ? subs.map((s, si) => (
                  <div key={si} className="exam-sub">
                    <div className="exam-q-head"><b>({String.fromCharCode(97 + si)})</b><span className="muted">{s.marks} marks</span></div>
                    <Markdown text={s.prompt} />
                    <Answer k={`p${pi}q${qi}s${si}`} q={{ ...q, ...s, options: s.options ?? [], answer_index: s.answer_index ?? null }}
                      answers={answers} setAnswers={setAnswers} locked={locked} />
                    <Marked r={marked?.[`p${pi}q${qi}s${si}`]} showKey={showKey || !!marked} model={keyText(s.options, s.answer_index, s.model_answer)} />
                  </div>
                )) : (
                  <>
                    <Answer k={`p${pi}q${qi}`} q={q} answers={answers} setAnswers={setAnswers} locked={locked} />
                    <Marked r={marked?.[`p${pi}q${qi}`]} showKey={showKey || !!marked}
                      model={keyText(q.options, q.answer_index, q.model_answer)} />
                  </>
                )}
                {(showKey || marked) && q.source && <div className="src-note">Source: {q.source}</div>}
              </div>
            );
          })}
        </section>
      ))}

      {!attempt && (
        <div className="exam-submit">
          <button className="btn btn-primary" onClick={submit}>Submit for marking</button>
        </div>
      )}
    </div>
  );
}

function keyText(options: string[] | undefined, idx: number | null | undefined, model: string) {
  return options?.length && idx != null ? `${String.fromCharCode(65 + idx)}. ${options[idx]}${model ? `\n\n${model}` : ''}` : model;
}

function Answer({ k, q, answers, setAnswers, locked }: {
  k: string; q?: ExamQuestion; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void; locked: boolean;
}) {
  const v = answers[k] ?? '';
  if (q?.options?.length) {
    return (
      <div className="options">
        {q.options.map((o, i) => (
          <button key={i} disabled={locked} className={`option${v === String(i) ? ' selected' : ''}`}
            onClick={() => setAnswers({ ...answers, [k]: String(i) })}>
            <span className="option-letter">{String.fromCharCode(65 + i)}</span><Markdown text={o} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <textarea className="answer" rows={q?.type === 'long' || q?.type === 'case_study' ? 8 : 4} disabled={locked} value={v}
      placeholder="Type your answer…" onChange={(e) => setAnswers({ ...answers, [k]: e.target.value })} />
  );
}

function Marked({ r, showKey, model }: {
  r?: { marks_awarded: number; max: number; feedback: string; missing_points: string[] }; showKey: boolean; model: string;
}) {
  if (!r && !showKey) return null;
  return (
    <div className="marked">
      {r && (
        <div className={`marked-score ${r.marks_awarded >= r.max ? 'ok' : r.marks_awarded > 0 ? 'warn' : 'bad'}`}>
          {r.marks_awarded}/{r.max} marks
        </div>
      )}
      {r?.feedback && <Markdown text={r.feedback} />}
      {r?.missing_points?.length ? <ul className="missing">{r.missing_points.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
      {showKey && model && <div className="model-answer"><div className="col-label">Model answer</div><Markdown text={model} /></div>}
    </div>
  );
}
