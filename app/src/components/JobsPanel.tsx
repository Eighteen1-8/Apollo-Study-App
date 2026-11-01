import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Pill, Progress } from './ui';

const ACTIVE = ['running', 'queued'];

/** Hourglass jobs indicator for the mini sidebar: the ring fills with the running job's progress and the sand runs
 * while anything is queued. Click for the full list; finished jobs can be dismissed from it. */
export default function JobsPanel() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const jobs = usePoll(() => api.jobs(false), 1500);
  const list = jobs.data ?? [];
  const active = list.filter((j) => ACTIVE.includes(j.status));
  const running = active.find((j) => j.status === 'running');
  const finished = list.length - active.length;
  const failed = list.some((j) => j.status === 'failed');
  const pct = running?.progress ?? 0;

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

  return (
    <div className="jobs-v" ref={root}>
      <button className={`jobs-v-btn${active.length ? ' busy' : ''}${failed && !active.length ? ' failed' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)} aria-expanded={open}
        data-tip={running ? `${running.message || running.filename || 'Working'} · ${Math.round(pct * 100)}%` : active.length ? `${active.length} queued` : 'Background jobs'}>
        <svg className="jobs-ring" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r={R} className="jobs-ring-track" />
          {active.length > 0 && <circle cx="20" cy="20" r={R} className="jobs-ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />}
        </svg>
        <svg className="hourglass" viewBox="0 0 16 20" aria-hidden>
          <path className="hg-frame" d="M2.5 1.5h11M2.5 18.5h11M4 1.5c0 4 4 5.5 4 8.5s-4 4.5-4 8.5M12 1.5c0 4-4 5.5-4 8.5s4 4.5 4 8.5" />
          <path className="hg-sand-top" d="M5.2 4.5h5.6c-.5 1.8-2.8 3-2.8 4.6 0-1.6-2.3-2.8-2.8-4.6z" />
          <path className="hg-sand-bottom" d="M5 17.5c.3-2.2 3-2.6 3-4.4 0 1.8 2.7 2.2 3 4.4z" />
          <path className="hg-stream" d="M8 9.6v6" />
        </svg>
        {active.length > 0 && <span className="jobs-v-count">{active.length}</span>}
      </button>
      {open && (
        <div className="jobs-popover jobs-popover-side" role="dialog" aria-label="Background jobs">
          <div className="jobs-popover-head">
            <span>Background jobs <span className="muted">(last hour)</span></span>
            {finished > 0 && <button className="link-btn" onClick={() => dismiss()}>Clear finished</button>}
          </div>
          {list.length === 0 && <div className="muted small">Nothing yet.</div>}
          {list.map((j) => {
            const live = ACTIVE.includes(j.status);
            return (
              <div key={j.id} className="job-row">
                <div className="job-row-top">
                  <span className="job-type">{j.type}</span>
                  <span className="job-file" title={j.filename ?? ''}>{j.filename ?? `#${j.document_id}`}</span>
                  <Pill status={j.status} />
                  {!live && <button className="x-btn job-x" title="Dismiss" onClick={() => dismiss(j.id)}>×</button>}
                </div>
                {live && (
                  <>
                    <div className="small muted">{j.message}</div>
                    <div className="job-row-bottom">
                      <Progress value={j.progress} />
                      <button className="link-btn" onClick={() => api.cancelJob(j.id).then(jobs.reload)}>Cancel</button>
                    </div>
                  </>
                )}
                {j.error && <div className="small bad">{j.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
