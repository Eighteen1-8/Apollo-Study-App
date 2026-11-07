/* Notes and cheat sheets: sections of styled HTML (or older Markdown) with their sources. */
import { ArtifactContent } from '../../api';
import Markdown, { RESOLVED } from '../../components/Markdown';

export function Source({ s }: { s?: string }) {
  return s ? <div className="src-note">Source: {s}</div> : null;
}


export function Sections({ content, onCite }: { content: ArtifactContent; onCite?: (file: string, label: string) => void }) {
  const secs = content.sections ?? [];
  return (
    <div className="notes">
      {secs.length > 1 && (
        <nav className="notes-toc">
          {secs.map((s, i) => <a key={i} href={`#sec-${i}`} onClick={(e) => {
            e.preventDefault();
            // scoped to this page: with split view, two pages can be open at once
            const el = e.currentTarget.closest('.notes')?.querySelector<HTMLElement>(`[data-sec="${i}"]`);
            const pane = el?.closest<HTMLElement>('.artifact-scroll, .fs-body');
            if (el && pane) pane.scrollTo({ top: el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12, behavior: 'smooth' });
          }}>{s.title}</a>)}
        </nav>
      )}
      {secs.map((s, i) => (
        <section key={i} id={`sec-${i}`} className="notes-section" data-sec={i}>
          {secs.length > 1 && <div className="notes-src">{s.title}</div>}
          {!(s.html ?? s.markdown ?? '').trim()
            ? <div className="banner banner-warn">This section came back empty. Use Regenerate to write it again.</div>
            : s.html != null
              ? <Markdown html text={s.html} figures={s.figures ?? RESOLVED} onCite={onCite} />
              : <Markdown text={s.markdown ?? ''} onCite={onCite} />}
        </section>
      ))}
    </div>
  );
}
