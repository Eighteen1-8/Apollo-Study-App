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
import Icon from '../components/Icon';
import { toast } from '../components/toast';
import { errorText } from '../errors';

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
  const subjectMenu = (e: React.MouseEvent, s: Subject) => ov.menu(e, [
    { label: 'Open', onClick: () => go({ name: 'subject', id: s.id }) },
    { label: 'New topic…', onClick: () => act.newTopic(s) },
    { label: 'Rename…', onClick: () => act.renameSubject(s), separatorBefore: true },
    { label: 'Delete subject', onClick: () => act.deleteSubject(s), danger: true },
  ]);
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
            : look.advanced ? 'Everything stays on this computer. Your material is read, embedded and explained by local models only.'
              : 'Everything stays on this computer. Apollo reads and explains your material without sending anything online.'}</p>
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
            <button className="icon-btn" title="New subject" onClick={act.newSubject}><Icon name="add" /></button>
          </div>
          <div className="widget-scroll">
            {subjects.length === 0 && (
              <div className="widget-empty">
                <b>Welcome to Apollo.</b> Here's how it works:
                <ol className="home-steps">
                  <li>Make a <b>subject</b> for each course, e.g. Physics.</li>
                  <li>Add <b>topics</b> inside it, e.g. Motion, and drop in your slides, notes and textbooks.</li>
                  <li>Ask Apollo questions, or have it make flashcards, quizzes, practice exams and notes from them.</li>
                </ol>
                <div className="home-start">
                  <Button kind="primary" onClick={act.newSubject}>Create your first subject</Button>
                  <Button onClick={async () => {
                    try { const r = await api.makeExample(); onChange(); go({ name: 'subject', id: r.id }); }
                    catch (e) { toast(errorText(e)); }
                  }}>Try an example first</Button>
                </div>
                <p className="muted small home-example-note">The example is a small Physics course with flashcards, a quiz, notes
                  and a chat already made, so you can look around. Delete it whenever you like.</p>
              </div>
            )}
            {subjects.map((s, i) => (
              <div key={s.id} className="subj-row" style={{ '--i': i, '--tint': s.color } as CSSProperties}
                onClick={() => go({ name: 'subject', id: s.id })}
                onMouseEnter={() => setHot(s.id)} onMouseLeave={() => setHot(null)}
                onContextMenu={(e) => subjectMenu(e, s)}>
                <SubjectIcon s={s} size={36} />
                <div className="subj-row-main">
                  <div className="subj-row-title">{s.name} <StaleBadge count={s.stale_docs} where={s.name}
                    onReingest={async () => { await api.reingestStale(s.id); onChange(); }} /></div>
                  <div className="muted small">
                    {s.topics.length} topic{s.topics.length === 1 ? '' : 's'} · {s.reference_count} textbook{s.reference_count === 1 ? '' : 's'}
                  </div>
                </div>
                <button className="x-btn subj-more" title="More options" aria-label={`More options for ${s.name}`}
                  onClick={(e) => { e.stopPropagation(); subjectMenu(e, s); }}><Icon name="more" size={16} /></button>
                <span className="home-card-arrow" aria-hidden><Icon name="next" size={18} /></span>
              </div>
            ))}
            {subjects.length > 0 && (
              <button className="subj-row subj-row-new" onClick={act.newSubject}>
                <span className="home-card-plus">+</span> New subject
              </button>
            )}
          </div>
          {subjects.length > 0 && <div className="widget-foot muted small">Right-click a subject or use ⋯ for more options</div>}
        </section>
      </div>
    </div>
  );
}
