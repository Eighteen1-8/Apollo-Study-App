import { CSSProperties, useState } from 'react';
import { api, Subject } from '../api';
import type { Route } from '../App';
import { useLibraryActions } from '../components/actions';
import EmbeddingCloud from '../components/EmbeddingCloud';
import { useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import { Button } from '../components/ui';
import { useAppearance } from '../theme';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Home: the knowledge cloud fills the page as its background; greeting, stats and subjects float over it as
 * glass widgets. Hovering a subject lights up its region of the cloud. */
export default function Home({ subjects, go, onChange, online }: {
  subjects: Subject[]; go: (r: Route) => void; onChange: () => void; online: string[];
}) {
  const ov = useOverlay();
  const act = useLibraryActions(subjects, go, onChange);
  const [look] = useAppearance();
  const [hot, setHot] = useState<number | null>(null);
  const topics = subjects.reduce((n, s) => n + s.topics.length, 0);
  const files = subjects.reduce((n, s) => n + s.reference_count + s.topics.reduce((m, t) => m + (t.doc_count ?? 0), 0), 0);
  const stats = [
    { label: 'Subjects', value: subjects.length },
    { label: 'Topics', value: topics },
    { label: 'Files', value: files },
  ];

  return (
    <div className={`home-stage${look.cloud ? '' : ' no-cloud'}`}>
      {look.cloud && <EmbeddingCloud className="cloud-bg" highlight={hot} onOpenSubject={(id) => go({ name: 'subject', id })} />}
      <div className="home-widgets">
        <section className="widget widget-hero" style={{ '--i': 0 } as CSSProperties}>
          <div className="hero-kicker">{online.length ? 'Apollo · online models on' : 'Apollo · offline study'}</div>
          <h1 className="hero-title">{greeting()}.</h1>
          <p className="hero-sub">{online.length
            ? `Online models are on (${online.join(' and ')} via OpenRouter), so material used there is sent to external servers. Switch back to Local in Settings to keep everything on this computer.`
            : 'Everything stays on this computer. Your material is read, embedded and explained by local models only.'}</p>
          <div className="hero-actions">
            <Button kind="primary" onClick={act.newSubject}>New subject</Button>
            <Button kind="ghost" onClick={() => go({ name: 'settings' })}>Appearance &amp; settings</Button>
          </div>
        </section>

        <section className="widget widget-stats" style={{ '--i': 1 } as CSSProperties}>
          {stats.map((s, i) => (
            <div key={s.label} className="hero-stat" style={{ '--i': i } as CSSProperties}>
              <div className="hero-stat-value">{s.value}</div>
              <div className="hero-stat-label">{s.label}</div>
            </div>
          ))}
        </section>

        <section className="widget widget-subjects" style={{ '--i': 2 } as CSSProperties}>
          <div className="widget-head">
            <h2>Your subjects</h2>
            <button className="icon-btn" title="New subject" onClick={act.newSubject}>+</button>
          </div>
          <div className="widget-scroll">
            {subjects.length === 0 && (
              <div className="widget-empty">
                Create a subject (e.g. Physics), add topics under it (e.g. Motion), then upload your slides, notes and textbooks.
              </div>
            )}
            {subjects.map((s, i) => (
              <div key={s.id} className="subj-row" style={{ '--i': i, '--tint': s.color } as CSSProperties}
                onClick={() => go({ name: 'subject', id: s.id })}
                onMouseEnter={() => setHot(s.id)} onMouseLeave={() => setHot(null)}
                onContextMenu={(e) => ov.menu(e, [
                  { label: 'Rename…', onClick: () => act.renameSubject(s) },
                  { label: 'Delete subject', onClick: () => act.deleteSubject(s), danger: true },
                ])}>
                <SubjectIcon s={s} size={36} />
                <div className="subj-row-main">
                  <div className="subj-row-title">{s.name} <StaleBadge count={s.stale_docs} where={s.name}
                    onReingest={async () => { await api.reingestStale(s.id); onChange(); }} /></div>
                  <div className="muted small">
                    {s.topics.length} topic{s.topics.length === 1 ? '' : 's'} · {s.reference_count} textbook{s.reference_count === 1 ? '' : 's'}
                  </div>
                </div>
                <span className="home-card-arrow" aria-hidden>→</span>
              </div>
            ))}
            <button className="subj-row subj-row-new" onClick={act.newSubject}>
              <span className="home-card-plus">+</span> New subject
            </button>
          </div>
          {subjects.length > 0 && <div className="widget-foot muted small">Right-click a subject for more options</div>}
        </section>
      </div>
    </div>
  );
}
