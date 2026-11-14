/* Make content, step by step: what to make, from which material (plus optional extra files with instructions just for
   this request), then a few choices, with Advanced (choose pages or slides) folded away. Marking takes the student's
   own work instead: files to mark, an optional rubric, and what to check them against (or nothing). It sits in the
   study sheet that slides up over the centre (SubjectView); the result appears in the left panel under "Being made". */
import { useEffect, useMemo, useState } from 'react';
import { api, ArtifactType, DocRef, inElectron, Subject } from '../../api';
import PagePicker, { UnitChoice } from '../../components/PagePicker';
import { topicColor } from '../../theme';
import { TourButton, useFirstTime } from '../../components/Tour';
import Icon from '../../components/Icon';
import ErrorText from '../../components/ErrorText';
import Info from '../../components/Info';
import { toast } from '../../components/toast';
import { CREATE_BLURB, TYPE_ICON } from '../LibraryPanel';

export const MAKE_TYPES: { type: ArtifactType; name: string; unit?: string; counts?: number[] }[] = [
  { type: 'flashcards', name: 'Flashcards', unit: 'cards', counts: [10, 20, 40] },
  { type: 'quiz', name: 'Quiz', unit: 'questions', counts: [5, 10, 20] },
  { type: 'exam', name: 'Practice exam' },
  { type: 'notes', name: 'Study notes' },
  { type: 'cheatsheet', name: 'Cheat sheet' },
  { type: 'mindmap', name: 'Mind map' },
  { type: 'marking', name: 'Marking' },
];
const blurb = (t: ArtifactType) => CREATE_BLURB[`create_${t}`];
const QUIZ_KINDS = { mcq: ['mcq'], mixed: ['mcq', 'tf'], tf: ['tf'] } as const;
const LEVEL_HELP = { easy: 'Recall and simple steps, obvious wrong answers.', normal: 'A mix of recall and applying ideas.',
  hard: 'Analysis, multi-step working and close wrong answers.' };
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What the steps start from: a type picked on a button, a topic (its menu), or one file (the viewer's toolbar). */
export interface MakeStart { type?: ArtifactType; topicId?: number | null; doc?: { id: number; name: string }; nonce: number }

export default function MakeContent({ subject, start, onClose }: { subject: Subject; start: MakeStart; onClose: () => void }) {
  const [step, setStep] = useState(start.type ? 1 : 0);
  const [type, setType] = useState<ArtifactType | null>(start.type ?? null);
  // the material: 'all', a topic id, 'doc' (the file it was started from), or 'none' (marking against nothing)
  const [from, setFrom] = useState<'all' | 'doc' | 'none' | number>(start.doc ? 'doc' : start.topicId ?? 'all');
  // marking: the work, the rubric, what it's out of
  const [work, setWork] = useState<string[]>([]);
  const [rubric, setRubric] = useState('');
  const [outOf, setOutOf] = useState('');
  // Advanced: chosen pages/slides of files in the material
  const [units, setUnits] = useState<UnitChoice>({});
  const [allDocs, setAllDocs] = useState<DocRef[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [count, setCount] = useState(1);
  const [focus, setFocus] = useState('');
  const [exam, setExam] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
  // quiz options (Advanced): how hard, and which kinds of question (generate.QUIZ_TYPES)
  const [quizLevel, setQuizLevel] = useState<'easy' | 'normal' | 'hard'>('normal');
  const [quizKinds, setQuizKinds] = useState<'mcq' | 'mixed' | 'tf'>('mcq');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const meta = MAKE_TYPES.find((t) => t.type === type) ?? null;
  const marking = type === 'marking';
  const blocked = (step === 0 && !type) || (step === 1 && marking && !work.length) || (step === 2 && type === 'exam' && !exam);
  useEffect(() => { setUnits({}); }, [from]);  // a choice of pages belongs to its material
  useEffect(() => {  // marking can check against nothing; other content can't
    if (!marking && from === 'none') setFrom('all');
  }, [marking, from]);
  useEffect(() => {
    if (!advanced || allDocs) return;
    api.allDocuments(subject.id).then(setAllDocs).catch((e) => setErr(String(e).replace(/^Error: /, '')));
  }, [advanced, allDocs, subject.id]);
  // the files whose pages can be chosen: the one file, the topic's, or every file of the subject
  const scopeDocs = useMemo(() => (from === 'doc' && start.doc ? [{ id: start.doc.id, filename: start.doc.name }]
    : (allDocs ?? []).filter((d) => (typeof from === 'number' ? d.kind === 'topic' && d.topic_id === from : from === 'all'))),
  [from, allDocs, start.doc]);
  const chosenCount = Object.values(units).reduce((n, xs) => n + xs.length, 0);
  const pickFiles = async (multi: boolean) => (await window.studyApp?.openFiles({ multi })) ?? [];
  const steps = ['What', 'From', 'Choices'];

  const pickExtra = async () => {
    const paths = await window.studyApp?.openFiles({ multi: true });
    if (paths?.length) setExtra((xs) => [...xs, ...paths.filter((p) => !xs.includes(p))]);
  };
  const submit = async () => {
    if (!type) return;
    setBusy(true);
    setErr(null);
    try {
      const args: Record<string, unknown> = type === 'exam' ? { difficulty, practice_exam_path: exam }
        : marking ? { work_paths: work, rubric_path: rubric || null, out_of: outOf.trim() ? Number(outOf) : null, against: from === 'none' ? 'nothing' : 'material' }
        : type === 'quiz' ? { count: meta!.counts![count], focus, difficulty: quizLevel, types: QUIZ_KINDS[quizKinds] }
        : meta?.counts ? { count: meta.counts[count], focus } : { focus };
      const r = await api.createContent(subject.id, {
        type, topic_id: typeof from === 'number' ? from : null, document_ids: from === 'doc' && start.doc ? [start.doc.id] : [],
        args, extra_paths: marking ? [] : extra, instructions, ...(chosenCount && from !== 'none' ? { units } : {}),
      });
      setMade(r.title);
      setStep(3);
      toast(`Apollo is making “${r.title}”. It's under Being made on the left.`);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const next = () => (step === 2 ? submit() : setStep(step + 1));

  useFirstTime('make');
  const choice = (on: boolean) => `make-choice${on ? ' on' : ''}`;
  return (
    <div className="make" role="dialog" aria-labelledby="make-title">
      <div className="make-head">
        <span className="make-head-icon"><Icon name="create" size={18} /></span>
        <h2 id="make-title">Make content</h2>
        {step < 3 && (
          <ol className="make-steps" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>
                <span className="make-step-dot">{i < step ? <Icon name="check" size={12} strokeWidth={3} /> : i + 1}</span>{s}
              </li>
            ))}
          </ol>
        )}
        <TourButton id="make" />
      </div>

      <div className="make-body" key={step}>
        {step === 0 && (
          <>
            <h3>What would you like Apollo to make?</h3>
            <div className="make-types">
              {MAKE_TYPES.map((t, i) => (
                <button key={t.type} className={`${choice(type === t.type)} make-type kind-${t.type}`} style={{ '--i': i } as React.CSSProperties}
                  onClick={() => setType(t.type)} onDoubleClick={() => { setType(t.type); setStep(1); }}>
                  <span className={`make-type-icon t-${t.type}`}>{TYPE_ICON(t.type, 20)}</span>
                  <span className="make-type-text"><b>{t.name}</b><span>{blurb(t.type)}</span></span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 1 && marking && (
          <div className="make-marking">
            <h3>What should Apollo mark?</h3>
            <div className="make-extra make-mark-work">
              <div className="make-extra-head">
                <b>Your work</b>
                <p>An essay, assignment or worked answers: Word, PDF, PowerPoint, text, or photos of handwritten pages.
                  It's copied for this marking only and isn't added to your files.</p>
              </div>
              <button className="make-drop" disabled={!inElectron} onClick={async () => {
                const paths = await pickFiles(true);
                if (paths.length) setWork((xs) => [...xs, ...paths.filter((p) => !xs.includes(p))]);
              }}><Icon name="upload" size={17} /> {work.length ? 'Add more' : 'Choose files'}</button>
              {work.length > 0 && (
                <div className="make-chips">
                  {work.map((p) => (
                    <span key={p} className="make-chip">
                      <Icon name="file" size={13} /> {fileName(p)}
                      <button className="x-btn" aria-label={`Remove ${fileName(p)}`} onClick={() => setWork((xs) => xs.filter((x) => x !== p))}><Icon name="close" size={12} /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="make-field make-mark-rubric">
              <span>Rubric or marking guide <span className="muted">(optional)</span>{' '}
                <Info text="Without one, Apollo works out fair criteria from the task, your instructions and your material." /></span>
              <div className="file-pick">
                <button className="btn btn-sm" disabled={!inElectron} onClick={async () => { const p = await pickFiles(false); if (p[0]) setRubric(p[0]); }}>
                  {rubric ? 'Change…' : 'Choose file…'}</button>
                <span className={rubric ? '' : 'muted'}>{rubric ? fileName(rubric) : 'The criteria or marking scheme you were given.'}</span>
                {rubric && <button className="x-btn" aria-label="Remove the rubric" onClick={() => setRubric('')}><Icon name="close" size={12} /></button>}
              </div>
            </div>
            <h3>Check it against</h3>
            <div className="make-from make-mark-against">
              <button className={choice(from === 'none')} onClick={() => setFrom('none')}>
                <span className="make-from-dot"><Icon name="marking" size={13} /></span>
                <span className="make-from-name">Nothing<small>Just the rubric and what Apollo knows</small></span>
              </button>
              {start.doc && (
                <button className={choice(from === 'doc')} onClick={() => setFrom('doc')}>
                  <span className="make-from-dot"><Icon name="file" size={13} /></span>
                  <span className="make-from-name">Just this file<small>{start.doc.name}</small></span>
                </button>
              )}
              <button className={choice(from === 'all')} onClick={() => setFrom('all')}>
                <span className="make-from-dot all"><Icon name="map" size={13} /></span>
                <span className="make-from-name">Everything in {subject.name}<small>Every topic</small></span>
              </button>
              {subject.topics.map((t) => (
                <button key={t.id} className={choice(from === t.id)} onClick={() => setFrom(t.id)}
                  style={{ '--tint': topicColor(subject.topics, t.id) } as React.CSSProperties}>
                  <span className="make-from-dot" />
                  <span className="make-from-name">{t.name}<small>{t.doc_count ?? 0} file{t.doc_count === 1 ? '' : 's'}</small></span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && !marking && (
          <>
            <h3>Which material should it use?</h3>
            <div className="make-from">
              {start.doc && (
                <button className={choice(from === 'doc')} onClick={() => setFrom('doc')}>
                  <span className="make-from-dot"><Icon name="file" size={13} /></span>
                  <span className="make-from-name">Just this file<small>{start.doc.name}</small></span>
                </button>
              )}
              <button className={choice(from === 'all')} onClick={() => setFrom('all')}>
                <span className="make-from-dot all"><Icon name="map" size={13} /></span>
                <span className="make-from-name">Everything in {subject.name}<small>Every topic{subject.topics.length ? ` (${subject.topics.length})` : ''}</small></span>
              </button>
              {subject.topics.map((t) => (
                <button key={t.id} className={choice(from === t.id)} onClick={() => setFrom(t.id)}
                  style={{ '--tint': topicColor(subject.topics, t.id) } as React.CSSProperties}>
                  <span className="make-from-dot" />
                  <span className="make-from-name">{t.name}<small>{t.doc_count ?? 0} file{t.doc_count === 1 ? '' : 's'}</small></span>
                </button>
              ))}
            </div>

            <div className="make-extra">
              <div className="make-extra-head">
                <b>Extra material</b> <span className="muted">(optional)</span>{' '}
                <Info text="Read once for this request and then forgotten. Use it for things like a past exam whose style you want copied; to study a file properly, add it to a topic instead." />
                <p>Add files just for this, like a past exam, a marking guide or an assignment brief. They're only used for
                  this and aren't added to your files.</p>
              </div>
              <button className="make-drop" disabled={!inElectron} onClick={pickExtra}>
                <Icon name="upload" size={17} /> Choose files
              </button>
              {extra.length > 0 && (
                <>
                  <div className="make-chips">
                    {extra.map((p) => (
                      <span key={p} className="make-chip">
                        <Icon name="file" size={13} /> {fileName(p)}
                        <button className="x-btn" aria-label={`Remove ${fileName(p)}`} onClick={() => setExtra((xs) => xs.filter((x) => x !== p))}><Icon name="close" size={12} /></button>
                      </span>
                    ))}
                  </div>
                </>
              )}
              {/* always there and always sent: instructions don't need an extra file */}
              <label className="make-field">
                <span>{extra.length ? `What should Apollo do with ${extra.length === 1 ? 'this file' : 'these files'}?`
                  : <>Instructions for Apollo <span className="muted">(optional)</span></>}</span>
                <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                  placeholder={extra.length ? "e.g. Use the same question style as this past exam, but only cover what I've studied."
                    : 'e.g. Keep it short, use simple words, include worked examples.'} />
              </label>
              {extra.length > 0 && (
                <div className="make-ideas">
                  {['Copy its question style', 'Focus on what it asks for', 'Mark answers like this guide'].map((t) => (
                    <button key={t} className="make-idea" onClick={() => setInstructions((v) => (v.trim() ? `${v.trim()} ${t}.` : `${t}.`))}>{t}</button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {step === 2 && meta && (
          <>
            <h3>A few choices</h3>
            {meta.counts && (
              <div className="make-field">
                <span>How many {meta.unit}?</span>
                <div className="seg">
                  {meta.counts.map((c, i) => <button key={c} className={count === i ? 'active' : ''} onClick={() => setCount(i)}>{c}</button>)}
                </div>
              </div>
            )}
            {marking ? (
              <>
                <label className="make-field">
                  <span>Marked out of <span className="muted">(optional)</span></span>
                  <input className="input make-mark-outof" inputMode="decimal" value={outOf} placeholder="e.g. 20"
                    onChange={(e) => setOutOf(e.target.value.replace(/[^0-9.]/g, ''))} />
                </label>
                <label className="make-field">
                  <span>Instructions for Apollo <span className="muted">(optional)</span></span>
                  <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                    placeholder="e.g. This is a year 11 physics assignment on forces. Be strict about units and working." />
                </label>
              </>
            ) : type === 'exam' ? (
              <>
                <div className="make-field">
                  <span>Practice exam</span>
                  <div className="file-pick">
                    <button className="btn btn-sm" disabled={!inElectron} onClick={async () => {
                      const p = await window.studyApp!.openFiles({ multi: false });
                      if (p[0]) setExam(p[0]);
                    }}>{exam ? 'Change…' : 'Choose file…'}</button>
                    <span className={exam ? '' : 'muted'}>{exam ? fileName(exam) : 'An exam you were given for this subject (PDF, Word, image).'}</span>
                  </div>
                  <small className="muted">Only its layout is copied (parts, question types, marks). It isn't added to your files.</small>
                </div>
                <div className="make-field">
                  <span>Difficulty</span>
                  <div className="seg">
                    {(['easy', 'normal', 'hard'] as const).map((d) => (
                      <button key={d} className={difficulty === d ? 'active' : ''} onClick={() => setDifficulty(d)}>{d[0].toUpperCase() + d.slice(1)}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <label className="make-field">
                <span>Anything to focus on? <span className="muted">(optional)</span></span>
                <input className="input" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. the equations, or projectile motion" />
              </label>
            )}
            {from !== 'none' && (
              <details className="make-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
                <summary><Icon name="advanced" size={15} /> Advanced{chosenCount ? <span className="make-advanced-note"> · {chosenCount} chosen</span> : null}
                  {type === 'quiz' && (quizLevel !== 'normal' || quizKinds !== 'mcq') ? <span className="make-advanced-note"> · {quizLevel}{quizKinds !== 'mcq' ? `, ${quizKinds === 'tf' ? 'true/false' : 'with true/false'}` : ''}</span> : null}</summary>
                {type === 'quiz' && (
                  <div className="make-quiz-options">
                    <div className="make-field">
                      <span>Difficulty</span>
                      <div className="seg">
                        {(['easy', 'normal', 'hard'] as const).map((d) => (
                          <button key={d} className={quizLevel === d ? 'active' : ''} onClick={() => setQuizLevel(d)}>{d[0].toUpperCase() + d.slice(1)}</button>
                        ))}
                      </div>
                      <small className="muted">{LEVEL_HELP[quizLevel]}</small>
                    </div>
                    <div className="make-field">
                      <span>Kinds of question{' '}
                        <Info text="Quizzes are marked instantly, so they use questions with one right answer. For written answers marked by Apollo, make a practice exam." /></span>
                      <div className="seg">
                        {([['mcq', 'Multiple choice'], ['mixed', 'Mixed'], ['tf', 'True / false']] as const).map(([k, l]) => (
                          <button key={k} className={quizKinds === k ? 'active' : ''} onClick={() => setQuizKinds(k)}>{l}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div className="make-field">
                  <span>Choose pages or slides <span className="muted">(optional)</span>{' '}
                    <Info text={marking ? 'Check the work against only these pages of your material.' : 'Make it from only these pages, slides or sections, e.g. a quiz on slides 10 to 20.'} /></span>
                  {advanced && (allDocs || from === 'doc') && (scopeDocs.length
                    ? <PagePicker docs={scopeDocs} value={units} onChange={setUnits} />
                    : <span className="muted small">There are no files in this material yet.</span>)}
                </div>
              </details>
            )}
            <div className="make-note"><Icon name="clock" size={16} /> Apollo works in the background, so you can keep studying. It shows up in the left panel when it's ready.</div>
          </>
        )}

        {step === 3 && type && (
          <div className="make-done">
            <span className={`make-done-icon t-${type}`}>{TYPE_ICON(type, 30)}</span>
            <h3>Apollo is making it</h3>
            <p>“{made}” is under <b>Being made</b> in the left panel, then moves to {meta?.name ?? 'its type'} when it's ready.</p>
            <div className="make-done-bar"><span /></div>
          </div>
        )}
        {err && <div className="banner banner-bad"><ErrorText text={err} /></div>}
      </div>

      <div className="make-foot">
        {step > 0 && step < 3 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
        <span className="spacer" />
        {step < 3 ? (
          <>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={blocked || busy} onClick={next}>
              {busy ? 'Starting…' : step === 2 ? `Make ${meta?.name.toLowerCase() ?? 'it'}` : 'Next'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => {
              setStep(0); setType(null); setExtra([]); setInstructions(''); setFocus(''); setMade(null);
              setWork([]); setRubric(''); setOutOf(''); setUnits({}); setQuizLevel('normal'); setQuizKinds('mcq');
            }}>Make something else</button>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}
