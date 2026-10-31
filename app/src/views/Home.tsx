import { api, Subject } from '../api';
import type { Route } from '../App';
import { useLibraryActions } from '../components/actions';
import { useOverlay } from '../components/overlay';
import StaleBadge from '../components/StaleBadge';
import SubjectIcon from '../components/SubjectIcon';
import { Button, Empty } from '../components/ui';

export default function Home({ subjects, go, onChange }: { subjects: Subject[]; go: (r: Route) => void; onChange: () => void }) {
  const ov = useOverlay();
  const act = useLibraryActions(subjects, go, onChange);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Your subjects</h1>
          <p className="muted">Everything stays on this computer. Material is processed by your local models only.</p>
        </div>
        <Button kind="primary" onClick={act.newSubject}>New subject</Button>
      </header>

      {subjects.length === 0 ? (
        <Empty title="No subjects yet">
          Create a subject (e.g. Physics), add topics under it (e.g. Motion), then upload your slides, notes and textbooks.
        </Empty>
      ) : (
        <div className="card-grid">
          {subjects.map((s) => (
            <div key={s.id} className="card card-click home-card" onClick={() => go({ name: 'subject', id: s.id })}
              onContextMenu={(e) => ov.menu(e, [
                { label: 'Rename…', onClick: () => act.renameSubject(s) },
                { label: 'Delete subject', onClick: () => act.deleteSubject(s), danger: true },
              ])}>
              <SubjectIcon s={s} size={46} />
              <div>
                <div className="card-title">{s.name} <StaleBadge count={s.stale_docs} where={s.name}
                  onReingest={async () => { await api.reingestStale(s.id); onChange(); }} /></div>
                <div className="muted small">
                  {s.topics.length} topic{s.topics.length === 1 ? '' : 's'} · {s.reference_count} textbook{s.reference_count === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
