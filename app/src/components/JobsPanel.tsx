import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Pill, Progress } from './ui';

/** Vertical jobs indicator for the mini sidebar; click for the full list. */
export default function JobsPanel() {
  const [open, setOpen] = useState(false);
  const jobs = usePoll(() => api.jobs(false), 1500);
  const list = jobs.data ?? [];
  const active = list.filter((j) => j.status === 'running' || j.status === 'queued');
  const running = active.find((j) => j.status === 'running');

  return (
    <div className="jobs-v">
      <button className={`jobs-v-btn${active.length ? ' busy' : ''}`} onClick={() => setOpen(!open)}
        data-tip={running ? running.message || running.filename || 'Working' : active.length ? `${active.length} queued` : 'No active jobs'}>
        <span className="jobs-v-track"><span className="jobs-v-fill" style={{ height: `${Math.round((running?.progress ?? 0) * 100)}%` }} /></span>
        <span className="jobs-v-count">{active.length || ''}</span>
      </button>
      {open && (
        <>
          <div className="jobs-v-backdrop" onClick={() => setOpen(false)} />
          <div className="jobs-popover jobs-popover-side">
            <div className="jobs-popover-head">Background jobs <span className="muted">(last hour)</span></div>
            {list.length === 0 && <div className="muted small">Nothing yet.</div>}
            {list.map((j) => (
              <div key={j.id} className="job-row">
                <div className="job-row-top">
                  <span className="job-type">{j.type}</span>
                  <span className="job-file" title={j.filename ?? ''}>{j.filename ?? `#${j.document_id}`}</span>
                  <Pill status={j.status} />
                </div>
                {(j.status === 'running' || j.status === 'queued') && (
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
            ))}
          </div>
        </>
      )}
    </div>
  );
}
