/* Exams generated from a practice exam: answer, submit for marking, and the marked script with feedback. */
import { useEffect, useMemo, useState } from 'react';
import { api, Artifact, ArtifactContent, Attempt, ExamQuestion } from '../../api';
import ErrorText from '../../components/ErrorText';
import Markdown from '../../components/Markdown';
import { useOverlay } from '../../components/overlay';
import { Progress } from '../../components/ui';
import { onChange } from '../../events';
import { logError } from '../../log';
import { getPref, removePref, setPref } from '../../prefs';

export function leaves(parts: NonNullable<ArtifactContent['parts']>) {
  const out: { key: string; label: string; q: ExamQuestion | (ExamQuestion['subquestions'][number] & { type?: string; options?: string[] }) }[] = [];
  let n = 0;
  parts.forEach((p, pi) => p.questions.forEach((q, qi) => {
    n += 1;
    if (q.subquestions?.length) q.subquestions.forEach((s, si) => out.push({ key: `p${pi}q${qi}s${si}`, label: `Q${n}${String.fromCharCode(97 + si)}`, q: s }));
    else out.push({ key: `p${pi}q${qi}`, label: `Q${n}`, q });
  }));
  return out;
}

export function Exam({ artifact }: { artifact: Artifact }) {
  const ov = useOverlay();
  const c = artifact.content!;
  const parts = c.parts ?? [];
  const keys = useMemo(() => leaves(parts), [parts]);
  // A new attempt's answers are kept as they are typed (examDraft:<id>), so closing the viewer doesn't lose them.
  const draftKey = `examDraft:${artifact.id}`;
  const [draft, setDraft] = useState<Record<string, string>>(() => getPref(draftKey, {}, (v) => { try { return JSON.parse(v); } catch { return {}; } }));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [attempts, setAttempts] = useState<Artifact['attempts']>(artifact.attempts);
  const [showKey, setShowKey] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setAttempts(artifact.attempts), [artifact.attempts]);

  const answers = attempt ? attempt.answers : draft;
  const setAnswers = (a: Record<string, string>) => {
    if (attempt) return;
    setDraft(a);
    if (Object.values(a).some((v) => v.trim())) setPref(draftKey, JSON.stringify(a)); else removePref(draftKey);
  };

  // The attempt picker and score follow the attempt being marked: a 'mark' job's progress changes the jobs list.
  const track = (a: Attempt) => {
    setAttempt((cur) => (cur && cur.id !== a.id ? cur : a));
    setAttempts((list) => [{ id: a.id, kind: a.kind, status: a.status, score: a.score, total: a.total, created_at: a.created_at },
      ...list.filter((t) => t.id !== a.id)].sort((x, y) => y.id - x.id));
  };
  const marking = attempt?.status === 'marking' ? attempt.id : null;
  useEffect(() => {
    if (marking == null) return;
    let alive = true;
    const refresh = () => { api.attempt(marking).then((a) => alive && track(a)).catch((e) => logError('exam marking', e, 'warning')); };
    refresh();
    const off = onChange(['jobs'], refresh);
    return () => { alive = false; off(); };
  }, [marking]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAttempt = async (id: number | null) => {
    setErr(null);
    if (id == null) { setAttempt(null); return; }
    try { const a = await api.attempt(id); track(a); setAttempt(a); }
    catch (e) { setErr(String(e)); }
  };
  const send = async (ans: Record<string, string>) => {
    setErr(null);
    try {
      const a = await api.submitAttempt(artifact.id, ans);
      track(a);
      setAttempt(a);
      setDraft({});
      removePref(draftKey);
    } catch (e) { setErr(String(e)); }
  };
  const submit = async () => {
    const blank = keys.filter((k) => !(answers[k.key] ?? '').trim()).length;
    if (!(await ov.confirm({ title: 'Submit exam for marking?', confirmText: 'Submit',
      body: blank ? `${blank} question(s) are unanswered and will score 0.` : 'Apollo will mark every answer against the marking guide.' }))) return;
    await send(answers);
  };
  /** A failed or cancelled marking: change the answers and submit them again as a new attempt. */
  const editAgain = () => {
    if (!attempt) return;
    setDraft(attempt.answers);
    setPref(draftKey, JSON.stringify(attempt.answers));
    setAttempt(null);
  };

  const marked = attempt?.status === 'marked' ? attempt.result : null;
  const unfinished = attempt && (attempt.status === 'failed' || attempt.status === 'cancelled');
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
        {attempts.length > 0 && (
          <select value={attempt?.id ?? ''} onChange={(e) => loadAttempt(e.target.value ? Number(e.target.value) : null)}>
            <option value="">New attempt</option>
            {attempts.map((t) => (
              <option key={t.id} value={t.id}>Attempt #{t.id}{t.score != null ? ` · ${t.score}/${t.total}`
                : t.status === 'marking' ? ' · marking…' : t.status === 'failed' ? ' · not marked' : t.status === 'cancelled' ? ' · cancelled' : ''}</option>
            ))}
          </select>
        )}
        <label className="check"><input type="checkbox" checked={showKey} onChange={(e) => setShowKey(e.target.checked)} /> Show answers</label>
      </div>
      {c.blueprint?.instructions && <div className="exam-instructions">{c.blueprint.instructions}</div>}

      {err && <div className="banner banner-bad"><ErrorText text={err} /></div>}
      {attempt?.status === 'marking' && (
        <div className="marking"><div>{attempt.message || 'Marking…'}</div><Progress value={attempt.progress} /></div>
      )}
      {attempt && unfinished && (
        <div className="banner banner-bad exam-unmarked">
          <div>{attempt.status === 'cancelled' ? 'Marking was cancelled.' : <>This attempt couldn't be marked: <ErrorText text={attempt.message} /></>}</div>
          <div className="exam-unmarked-actions">
            <button className="btn btn-sm btn-primary" onClick={() => send(attempt.answers)}>Mark again</button>
            <button className="btn btn-sm" onClick={editAgain}>Change answers</button>
          </div>
        </div>
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

export function keyText(options: string[] | undefined, idx: number | null | undefined, model: string) {
  return options?.length && idx != null ? `${String.fromCharCode(65 + idx)}. ${options[idx]}${model ? `\n\n${model}` : ''}` : model;
}

export function Answer({ k, q, answers, setAnswers, locked }: {
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

export function Marked({ r, showKey, model }: {
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
