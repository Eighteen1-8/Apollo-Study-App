import { CSSProperties } from 'react';
import { api, Subject } from '../api';
import type { Route } from '../App';
import { useLibraryActions } from '../components/actions';
import EmbeddingCloud from '../components/EmbeddingCloud';
import { useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import { Button, Empty, spotlight } from '../components/ui';
import { useAppearance } from '../theme';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home({ subjects, go, onChange }: { subjects: Subject[]; go: (r: Route) => void; onChange: () => void }) {
  const ov = useOverlay();
  const act = useLibraryActions(subjects, go, onChange);
  const [look] = useAppearance();
  const topics = subjects.reduce((n, s) => n + s.topics.length, 0);
  const files = subjects.reduce((n, s) => n + s.reference_count + s.topics.reduce((m, t) => m + (t.doc_count ?? 0), 0), 0);
  const stats = [
    { label: 'Subjects', value: subjects.length },
    { label: 'Topics', value: topics },
    { label: 'Files', value: files },
  ];

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-kicker">Apollo · offline study</div>
          <h1 className="hero-title">{greeting()}.</h1>
          <p className="hero-sub">Everything stays on this computer. Your material is read, embedded and explained by local models only.</p>
          <div className="hero-stats">
            {stats.map((s, i) => (
              <div key={s.label} className="hero-stat" style={{ '--i': i } as CSSProperties}>
                <div className="hero-stat-value">{s.value}</div>
                <div className="hero-stat-label">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="hero-actions">
            <Button kind="primary" onClick={act.newSubject}>New subject</Button>
            <Button kind="ghost" onClick={() => go({ name: 'settings' })}>Appearance &amp; settings</Button>
          </div>
        </div>
        {look.cloud && <EmbeddingCloud onOpenSubject={(id) => go({ name: 'subject', id })} />}
      </section>

      <div className="section-head home-head">
        <h2>Your subjects</h2>
        <span className="muted small">Right-click a subject for more options</span>
      </div>
      {subjects.length === 0 ? (
        <Empty title="No subjects yet">
          Create a subject (e.g. Physics), add topics under it (e.g. Motion), then upload your slides, notes and textbooks.
        </Empty>
      ) : (
        <div className="card-grid home-grid">
          {subjects.map((s, i) => (
            <div key={s.id} className="card card-click home-card" onMouseMove={spotlight}
              style={{ '--i': i, '--tint': s.color } as CSSProperties}
              onClick={() => go({ name: 'subject', id: s.id })}
              onContextMenu={(e) => ov.menu(e, [
                { label: 'Rename…', onClick: () => act.renameSubject(s) },
                { label: 'Delete subject', onClick: () => act.deleteSubject(s), danger: true },
              ])}>
              <SubjectIcon s={s} size={46} />
              <div className="home-card-main">
                <div className="card-title">{s.name} <StaleBadge count={s.stale_docs} where={s.name}
                  onReingest={async () => { await api.reingestStale(s.id); onChange(); }} /></div>
                <div className="muted small">
                  {s.topics.length} topic{s.topics.length === 1 ? '' : 's'} · {s.reference_count} textbook{s.reference_count === 1 ? '' : 's'}
                </div>
              </div>
              <span className="home-card-arrow" aria-hidden>→</span>
            </div>
          ))}
          <button className="card home-card home-card-new" style={{ '--i': subjects.length } as CSSProperties} onClick={act.newSubject}>
            <span className="home-card-plus">+</span>
            <span>New subject</span>
          </button>
        </div>
      )}
    </div>
  );
}
