import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Pill, Progress } from './ui';
import { statusWord, useTerms } from '../terms';
import { useAdvanced } from '../theme';
import Icon from './Icon';
import ErrorText from './ErrorText';

const ACTIVE = ['running', 'queued'];
const USES: Record<'llm' | 'embed', string[]> = { llm: ['vision', 'audit', 'generate', 'mark', 'review', 'questions', 'chat', 'define', 'quiz_review'], embed: ['ingest', 'embed'] };
/** What each kind of job is called in the list (chat replies, definitions and quiz reviews run while you wait). */
const TYPE_NAME: Record<string, string> = { quiz_review: 'quiz review', generate: 'create', audit: 'vision check', mark: 'marking', questions: 'questions' };
const TYPE_PLAIN: Record<string, string> = { ...TYPE_NAME, ingest: 'adding file', embed: 'indexing', vision: 'reading pictures', audit: 'checking picture notes', define: 'definition', review: 'feedback', questions: 'example questions' };
/** Standard mode: each job as a sentence ("Reading pictures in ‘Lecture 3.pdf’"). */
const VERB: Record<string, [string, string]> = {
  ingest: ['Adding', 'Added'], embed: ['Indexing', 'Indexed'], vision: ['Reading the pictures in', 'Read the pictures in'],
  audit: ['Checking the picture notes of', 'Checked the picture notes of'], generate: ['Making', 'Made'], mark: ['Marking', 'Marked'],
  review: ['Giving feedback on', 'Gave feedback on'], chat: ['Replying in', 'Replied in'], define: ['Defining', 'Defined'],
  quiz_review: ['Reviewing', 'Reviewed'], questions: ['Thinking of example questions for', 'Thought of example questions for'],
};
const sentence = (type: string, name: string, live: boolean) => {
  const v = VERB[type];
  return v ? `${v[live ? 0 : 1]} ‘${name}’` : name;
};
/** "about 3 min left" from how fast the progress has moved since this job was first seen. */
const left = (secs: number) => (secs < 50 ? 'less than a minute left' : `about ${Math.max(1, Math.round(secs / 60))} min left`);
/** Long jobs that end while the window isn't focused get a Windows notification (made on this computer, nothing online). */
const NOTIFY = ['ingest', 'generate', 'mark', 'vision', 'review'];
function notifyDone(type: string, name: string, ok: boolean) {
  if (typeof Notification === 'undefined' || document.hasFocus()) return;
  const title = !ok ? `Couldn’t finish ‘${name}’` : type === 'generate' ? `‘${name}’ is ready to study`
    : type === 'ingest' ? `‘${name}’ has been added` : type === 'mark' ? `‘${name}’ has been marked` : `${sentence(type, name, false)}`;
  try { new Notification(title, { body: ok ? 'Open Apollo to carry on.' : 'Open Apollo and see the Activity list for why.', silent: false }); } catch { /* not allowed here */ }
}

/** Jobs indicator for the mini sidebar: a check while idle; while anything is queued, an hourglass that drains and
 * flips inside a ring that fills with the running job's progress. Click for the full list; finished jobs can be dismissed from it.
 * The list also pauses the language and embedding models separately (e.g. to unload Qwen and free VRAM). */
export default function JobsPanel() {
  const [open, setOpen] = useState(false);
  const tr = useTerms();
  const advanced = useAdvanced();
  const root = useRef<HTMLDivElement>(null);
  const jobs = usePoll(() => api.jobs(false), 700, [], ['jobs']);
  const list = jobs.data ?? [];
  const active = list.filter((j) => ACTIVE.includes(j.status));
  const running = active.find((j) => j.status === 'running');
  const finished = list.length - active.length;
  const failed = list.some((j) => j.status === 'failed');
  const pct = running?.progress ?? 0;
  const pause = usePoll(api.pauseState, 300, [], ['pause', 'jobs']);
  const paused = { llm: !!pause.data?.llm, embed: !!pause.data?.embed };
  const anyPaused = paused.llm || paused.embed;
  // a job already mid-request keeps the model busy until that request ends; after that it waits
  const finishing = (k: 'llm' | 'embed') => paused[k] && list.some((j) => j.status === 'running' && USES[k].includes(j.type) && !j.message.startsWith('Paused'));
  const togglePause = (k: 'llm' | 'embed') => api.setPause({ [k]: !paused[k] }).then(() => { pause.reload(); jobs.reload(); });
  const pausedLabel = [paused.llm && tr('llm'), paused.embed && tr('embeddings')].filter(Boolean).join(' and ');

  // a press anywhere outside the button and the list closes it (a backdrop can't: the sidebar's blur traps it)
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open]);

  const dismiss = (id?: number) => api.dismissJob(id).then(jobs.reload);
  const R = 17, C = 2 * Math.PI * R;

  // time left: progress since each running job was first seen; notifications when a long job ends
  const seen = useRef(new Map<number, { t: number; p: number }>());
  const prev = useRef(new Map<number, string>());
  const now = Date.now() / 1000;
  for (const j of list) if (j.status === 'running' && !seen.current.has(j.id)) seen.current.set(j.id, { t: now, p: j.progress });
  const eta = (j: { id: number; progress: number }) => {
    const s0 = seen.current.get(j.id);
    if (!s0 || j.progress - s0.p < 0.02 || now - s0.t < 4) return null;
    return ((now - s0.t) / (j.progress - s0.p)) * (1 - j.progress);
  };
  useEffect(() => {
    for (const j of list) {
      const was = prev.current.get(j.id);
      if (was && ACTIVE.includes(was) && !ACTIVE.includes(j.status) && NOTIFY.includes(j.type) && j.status !== 'cancelled')
        notifyDone(j.type, j.filename ?? 'a file', j.status !== 'failed');
      prev.current.set(j.id, j.status);
    }
  }, [list]);

  return (
    <div className="jobs-v" ref={root}>
      <button className={`jobs-v-btn${active.length ? ' busy' : ''}${failed && !active.length ? ' failed' : ''}${open ? ' open' : ''}${anyPaused ? ' paused' : ''}`}
        onClick={() => setOpen(!open)} aria-expanded={open}
        data-tip={(anyPaused ? `Paused: ${pausedLabel}
` : '') + (running ? `${running.message || running.filename || 'Working'} · ${Math.round(pct * 100)}%` : active.length ? `${active.length} queued` : failed ? `${advanced ? 'Background jobs' : 'Activity'} · something failed` : `${advanced ? 'Background jobs' : 'Activity'} · all done`)}>
        <svg className="jobs-ring" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r={R} className="jobs-ring-track" />
          {active.length > 0 && <circle cx="20" cy="20" r={R} className="jobs-ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />}
        </svg>
        {/* idle: a check (or a warning after a failure); busy: an hourglass that drains, then flips */}
        <svg className="jobs-idle" viewBox="0 0 20 20" aria-hidden>
          {failed
            ? <path d="M10 3.2 17.4 16H2.6zM10 8.2v3.6M10 13.9v.1" />
            : <><circle cx="10" cy="10" r="7" /><path d="m6.9 10.2 2.2 2.2 4-4.3" /></>}
        </svg>
        <svg className="hourglass" viewBox="0 0 16 20" aria-hidden>
          <g className="hg-body">
            <path className="hg-frame" d="M2.5 1.5h11M2.5 18.5h11M4 1.5c0 4 4 5.5 4 8.5s-4 4.5-4 8.5M12 1.5c0 4-4 5.5-4 8.5s4 4.5 4 8.5" />
            <path className="hg-sand-top" d="M5.2 4.5h5.6c-.5 1.8-2.8 3-2.8 4.6 0-1.6-2.3-2.8-2.8-4.6z" />
            <path className="hg-sand-bottom" d="M5 17.5c.3-2.2 3-2.6 3-4.4 0 1.8 2.7 2.2 3 4.4z" />
            <g className="hg-grains">
              <circle cx="8" cy="10.4" r=".55" /><circle cx="8" cy="10.4" r=".55" /><circle cx="8" cy="10.4" r=".55" />
            </g>
          </g>
        </svg>
        {active.length > 0 && <span key={active.length} className="jobs-v-count">{active.length}</span>}
        {anyPaused && <span className="jobs-v-paused" aria-label="Paused"><Icon name="pause" size={10} /></span>}
      </button>
      {open && (
        <div className="jobs-popover jobs-popover-side" role="dialog" aria-label={advanced ? 'Background jobs' : 'Activity'}>
          <div className="jobs-popover-head">
            <span>{advanced ? 'Jobs' : 'Activity'} <span className="muted">(last hour)</span></span>
            {finished > 0 && <button className="link-btn" onClick={() => dismiss()}>Clear finished</button>}
          </div>
          <div className="pause-row" role="group" aria-label="Pause models">
            {(['llm', 'embed'] as const).map((k) => (
              <button key={k} className={`pause-chip${paused[k] ? ' on' : ''}`} aria-pressed={paused[k]} onClick={() => togglePause(k)}
                data-tip={paused[k] ? 'Resume: queued jobs carry on' : k === 'llm'
                  ? (advanced ? 'Pause the language model: chat, vision and generation stop using it so it can be unloaded'
                    : 'Pause Apollo: chat and anything being made wait until you resume (frees the graphics card)')
                  : (advanced ? 'Pause the embedding model: uploads wait before embedding; search uses keywords only'
                    : 'Pause the search model: new files wait; search matches exact words only')}>
                <span className="pause-icon" aria-hidden><Icon name={paused[k] ? 'play' : 'pause'} size={12} /></span>
                {paused[k] ? 'Resume' : 'Pause'} {tr(k === 'llm' ? 'llm' : 'embeddings')}
              </button>
            ))}
          </div>
          {(paused.llm || paused.embed) && (
            <div className="pause-note small">
              {(['llm', 'embed'] as const).filter((k) => paused[k]).map((k) => (
                <div key={k}>
                  {k === 'llm' ? tr('llm') : advanced ? 'Embeddings' : 'Search'}: {finishing(k) ? 'finishing the request in progress…' : <b>idle, safe to unload</b>}
                </div>
              ))}
            </div>
          )}
          {list.length === 0 && <div className="muted small">Nothing yet.</div>}
          {list.map((j) => {
            const live = ACTIVE.includes(j.status);
            const name = j.filename ?? `#${j.document_id}`;
            const secs = j.status === 'running' ? eta(j) : null;
            return (
              <div key={j.id} className="job-row">
                <div className="job-row-top">
                  {advanced ? (
                    <>
                      <span className={`job-type jt-${j.type}`}>{TYPE_NAME[j.type] ?? j.type}</span>
                      <span className="job-file" title={j.filename ?? ''}>{name}</span>
                    </>
                  ) : (
                    <span className="job-file job-sentence" title={TYPE_PLAIN[j.type] ?? j.type}>{sentence(j.type, name, live)}</span>
                  )}
                  {!advanced && secs !== null ? <span className="job-eta">{left(secs)}</span> : (advanced || j.status !== 'running') && <Pill status={j.status}>{statusWord(j.status)}</Pill>}
                  {!live && <button className="x-btn job-x" title="Dismiss" onClick={() => dismiss(j.id)}><Icon name="close" size={14} /></button>}
                </div>
                {live && (
                  <>
                    <div className="small muted">{j.message}</div>
                    <div className="job-row-bottom">
                      <Progress value={j.progress} />
                      {j.status === 'queued' && (
                        <button className="link-btn" title="Start this one before the others waiting" onClick={() => api.prioritizeJob(j.id).then(jobs.reload)}>Run next</button>
                      )}
                      <button className="link-btn" onClick={() => api.cancelJob(j.id).then(jobs.reload)}>{j.type === 'chat' ? 'Stop' : 'Cancel'}</button>
                    </div>
                  </>
                )}
                {j.error && <div className="small bad"><ErrorText text={j.error} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
