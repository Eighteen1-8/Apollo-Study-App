/* Apollo's marking of the student's own work (marking.py): the score and the overall comment, then each question or
   criterion's feedback beside the pages it is about. Any piece of feedback can be asked about in the chat (the same
   quote flow as highlighted text). "Mark a new version" marks improved work with the same rubric and settings; the new
   marking shows what changed against the previous one and links to the earlier versions (marking.py new_version). */
import { useRef, useState } from 'react';
import { api, Artifact, inElectron, MarkingCriterion, MarkingResult, Quote } from '../../api';
import Markdown from '../../components/Markdown';
import Icon from '../../components/Icon';
import ErrorText from '../../components/ErrorText';
import { toast } from '../../components/toast';
import { useSubjectLinks } from '../../components/subjectLinks';

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const grade = (got: number, max: number) => {
  const p = max > 0 ? got / max : 0;
  return p >= 0.75 ? 'g-good' : p >= 0.5 ? 'g-ok' : 'g-low';
};

/** The chat quote for one question or criterion: its feedback, with the mark and the student's words around it. */
export function criterionQuote(title: string, c: MarkingCriterion): Quote {
  const said = c.quotes.map((q) => `“${q.text}”`).join(' ');
  return {
    document_id: null, filename: title, label: c.label, text: c.feedback.slice(0, 1500),
    before: `${c.label}: ${fmt(c.awarded)} of ${fmt(c.max)} marks.${said ? ` About the student's words ${said}.` : ''}`,
    after: c.corrections.length ? `Corrections: ${c.corrections.join('; ')}` : '',
  };
}

/** The change from an earlier mark, e.g. "+1.5" (marks), shown green or red; nothing when there's no earlier mark. */
function Change({ now, before, max, beforeMax }: { now: number; before: number | null | undefined; max: number; beforeMax?: number }) {
  if (before == null) return null;
  // out of a different total: compare as a share of the marks
  const d = beforeMax && Math.abs(beforeMax - max) > 0.01 ? now - (before / beforeMax) * max : now - before;
  const r = Math.round(d * 10) / 10;
  if (Math.abs(r) < 0.05) return <span className="mark-change same" title="The same as the previous version">±0</span>;
  return (
    <span className={`mark-change ${r > 0 ? 'up' : 'down'}`} title={`${r > 0 ? 'Up' : 'Down'} from ${fmt(before)} in the previous version`}>
      <Icon name={r > 0 ? 'better' : 'worse'} size={12} /> {r > 0 ? '+' : ''}{fmt(r)}
    </span>
  );
}

/** Mark a new version: pick the new files; the rubric, out-of and instructions start as before and can be changed. */
function NewVersion({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const p = artifact.params as { out_of?: number | null; instructions?: string; rubric?: { name: string } | null };
  const links = useSubjectLinks();
  const [work, setWork] = useState<string[]>([]);
  const [rubric, setRubric] = useState<'keep' | 'none' | string>(p.rubric ? 'keep' : 'none');
  const [outOf, setOutOf] = useState(p.out_of != null ? String(p.out_of) : '');
  const [instructions, setInstructions] = useState(p.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = (x: string) => x.split(/[\\/]/).pop() ?? x;
  const pick = async (multi: boolean) => (await window.studyApp?.openFiles({ multi })) ?? [];
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.newMarkingVersion(artifact.id, {
        work_paths: work, out_of: outOf.trim() ? Number(outOf) : null, instructions,
        ...(rubric === 'none' ? { drop_rubric: true } : rubric !== 'keep' ? { rubric_path: rubric } : {}),
      });
      toast(`Apollo is marking “${r.title}”. It's under Being made on the left.`);
      onClose();
      links.openArtifact?.(r.id);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="marking-newver" role="group" aria-label="Mark a new version">
      <div className="marking-newver-row">
        <b>New version of your work</b>
        <button className="btn btn-sm" disabled={!inElectron} onClick={async () => {
          const paths = await pick(true);
          if (paths.length) setWork((xs) => [...xs, ...paths.filter((x) => !xs.includes(x))]);
        }}><Icon name="upload" size={14} /> {work.length ? 'Add more' : 'Choose files'}</button>
        {work.map((x) => (
          <span key={x} className="make-chip"><Icon name="file" size={13} /> {name(x)}
            <button className="x-btn" aria-label={`Remove ${name(x)}`} onClick={() => setWork((xs) => xs.filter((y) => y !== x))}><Icon name="close" size={12} /></button>
          </span>
        ))}
      </div>
      <div className="marking-newver-row">
        <span>Marking guide:</span>
        <span className={rubric === 'none' ? 'muted' : ''}>{rubric === 'keep' ? p.rubric?.name : rubric === 'none' ? 'none' : name(rubric)}</span>
        <button className="link-btn" disabled={!inElectron} onClick={async () => { const r = await pick(false); if (r[0]) setRubric(r[0]); }}>Change…</button>
        {rubric !== 'none' && <button className="link-btn" onClick={() => setRubric('none')}>Use none</button>}
        {p.rubric && rubric !== 'keep' && <button className="link-btn" onClick={() => setRubric('keep')}>Keep {p.rubric.name}</button>}
        <label className="marking-newver-outof">Out of
          <input className="input" inputMode="decimal" value={outOf} placeholder="as marked" onChange={(e) => setOutOf(e.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
      </div>
      <textarea className="input" rows={2} value={instructions} placeholder="Instructions for Apollo (optional)" onChange={(e) => setInstructions(e.target.value)} />
      {err && <div className="small bad"><ErrorText text={err} /></div>}
      <div className="marking-newver-row">
        <span className="muted small">Apollo marks it the same way and shows what improved.</span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!work.length || busy} onClick={submit}>{busy ? 'Starting…' : 'Mark it'}</button>
      </div>
    </div>
  );
}

/** Earlier versions of this work: the score change overall and links to open each one. */
function Versions({ m }: { m: MarkingResult }) {
  const links = useSubjectLinks();
  if (!m.previous) return null;
  const versions = m.history ?? [];
  return (
    <div className="marking-versions">
      <div className="marking-versions-head">
        <Icon name="history" size={14} />
        <span>Version {versions.length + 1}: {fmt(m.previous.score)} → <b>{fmt(m.score)}</b> / {fmt(m.out_of)}</span>
        <Change now={m.score} before={m.previous.score} max={m.out_of} beforeMax={m.previous.out_of} />
      </div>
      <div className="marking-versions-list">
        {versions.map((v, i) => (
          <button key={v.id} className="link-btn" disabled={!links.openArtifact} onClick={() => links.openArtifact?.(v.id)}
            title={`Open ${v.title}`}>
            Version {versions.length - i}{v.score != null && v.out_of != null ? ` (${fmt(v.score)}/${fmt(v.out_of)})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Marking({ artifact, onAsk, onCite }: {
  artifact: Artifact; onAsk?: (q: Quote) => void; onCite?: (file: string, label: string) => void;
}) {
  const m = artifact.content?.marking;
  const pagesRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [newVersion, setNewVersion] = useState(false);
  if (!m) return null;
  const pct = m.out_of > 0 ? Math.max(0, Math.min(1, m.score / m.out_of)) : 0;
  const lit = active !== null ? new Set(m.criteria[active]?.pages ?? []) : new Set<number>();
  const showPage = (page: number) => {
    const el = pagesRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const pick = (i: number) => {
    setActive(i === active ? null : i);
    const first = m.criteria[i]?.pages[0];
    if (i !== active && first) showPage(first);
  };

  return (
    <div className="marking">
      <header className="marking-head">
        <div className={`marking-score ${grade(m.score, m.out_of)}`} title={m.scaled ? `${fmt(m.raw.awarded)} of ${fmt(m.raw.available)} on the criteria, scaled to ${fmt(m.out_of)}` : undefined}>
          <b>{fmt(m.score)}</b><span>/ {fmt(m.out_of)}</span>
          <div className="marking-bar"><span style={{ width: `${pct * 100}%` }} /></div>
        </div>
        <div className="marking-meta">
          <div><Icon name="file" size={13} /> {m.files.join(', ')}</div>
          <div><Icon name="marking" size={13} /> {m.rubric ? `Marked with ${m.rubric}` : 'No marking guide: Apollo worked out the criteria'}</div>
          <div><Icon name="book" size={13} /> {m.material ? `Checked against ${m.material.split(' › ').pop()}` : 'Not checked against your material'}</div>
        </div>
        {artifact.status === 'ready' && !newVersion && (
          <button className="btn btn-sm marking-newver-btn" disabled={!inElectron} title="Mark an improved version of this work the same way"
            onClick={() => setNewVersion(true)}><Icon name="history" size={14} /> Mark a new version</button>
        )}
      </header>
      {newVersion && <NewVersion artifact={artifact} onClose={() => setNewVersion(false)} />}
      <Versions m={m} />

      <section className="marking-summary">
        {m.overall && <Markdown text={m.overall} onCite={onCite} />}
        <div className="marking-lists">
          {m.strengths.length > 0 && (
            <div className="marking-list good"><h4><Icon name="check" size={14} /> Strengths</h4>
              <ul>{m.strengths.map((s, i) => <li key={i}><Markdown text={s} onCite={onCite} /></li>)}</ul></div>
          )}
          {m.improvements.length > 0 && (
            <div className="marking-list improve"><h4><Icon name="next" size={14} /> To improve</h4>
              <ul>{m.improvements.map((s, i) => <li key={i}><Markdown text={s} onCite={onCite} /></li>)}</ul></div>
          )}
          {(m.improved?.length ?? 0) > 0 && (
            <div className="marking-list good"><h4><Icon name="better" size={14} /> Better than last time</h4>
              <ul>{m.improved!.map((s, i) => <li key={i}><Markdown text={s} onCite={onCite} /></li>)}</ul></div>
          )}
          {(m.still_to_do?.length ?? 0) > 0 && (
            <div className="marking-list improve"><h4><Icon name="history" size={14} /> Still to do from last time</h4>
              <ul>{m.still_to_do!.map((s, i) => <li key={i}><Markdown text={s} onCite={onCite} /></li>)}</ul></div>
          )}
        </div>
      </section>

      <div className="marking-body">
        <div className="marking-criteria">
          {m.criteria.map((c, i) => (
            <article key={i} className={`marking-crit ${grade(c.awarded, c.max)}${active === i ? ' on' : ''}`} data-crit={i}
              onClick={(e) => { if (!(e.target as Element).closest('button, a') && !window.getSelection()?.toString()) pick(i); }}>
              <div className="marking-crit-head">
                <b className="marking-crit-label">{c.label}</b>
                <span className="marking-crit-mark">{fmt(c.awarded)} / {fmt(c.max)}</span>
                {c.previous !== undefined && (c.previous
                  ? <Change now={c.awarded} before={c.previous.awarded} max={c.max} beforeMax={c.previous.max} />
                  : <span className="mark-change new" title="Not in the previous marking">new</span>)}
              </div>
              <div className="marking-bar"><span style={{ width: `${c.max > 0 ? (c.awarded / c.max) * 100 : 0}%` }} /></div>
              {c.quotes.map((q, k) => (
                <blockquote key={k} className="marking-quote">
                  <Markdown text={q.text} />
                  {q.page && <button className="link-btn marking-page-link" onClick={() => { setActive(i); showPage(q.page!); }}>page {q.page}</button>}
                </blockquote>
              ))}
              {c.feedback && <Markdown text={c.feedback} onCite={onCite} className="marking-feedback" />}
              {c.corrections.length > 0 && (
                <div className="marking-corrections"><h5>Corrections</h5>
                  <ul>{c.corrections.map((x, k) => <li key={k}><Markdown text={x} onCite={onCite} /></li>)}</ul></div>
              )}
              {onAsk && (
                <div className="marking-crit-foot">
                  <button className="btn btn-sm marking-ask" onClick={() => onAsk(criterionQuote(artifact.title, c))}>
                    <Icon name="ask" size={14} /> Ask Apollo about this
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="marking-pages" ref={pagesRef}>
          {m.pages.map((p, i) => (
            <figure key={i} className={`marking-page${lit.has(i + 1) ? ' on' : ''}`} data-page={i + 1}>
              <figcaption>{p.asset ? `Page ${i + 1} · ` : ''}{p.label}</figcaption>
              {p.asset ? <img src={api.assetUrl(p.asset)} alt={p.label} loading="lazy" />
                : <pre className="marking-page-text">{p.text}</pre>}
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
