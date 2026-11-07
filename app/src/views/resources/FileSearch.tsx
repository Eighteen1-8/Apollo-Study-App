/* The sidebar's file search: file names, then text inside the files. */
import { useEffect, useState } from 'react';
import { api, DocRef, SearchResult, Subject } from '../../api';
import { usePoll } from '../../hooks';
import { logError } from '../../log';


export function FileSearchResults({ subject, query, onOpen }: {
  subject: Subject; query: string; onOpen: (docId: number, label?: string, find?: string) => void;
}) {
  const all = usePoll(() => api.allDocuments(subject.id), 0, [subject.id], ['documents']);
  const [hits, setHits] = useState<SearchResult[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  useEffect(() => {
    setHits(null);
    setWarning(null);
    if (query.length < 3) return;
    let alive = true;
    const t = setTimeout(() => {
      api.searchSubject(query, subject.id, 15).then((r) => { if (alive) { setHits(r.results); setWarning(r.warning); } })
        .catch((e) => { logError('file search', e, 'warning'); if (alive) setHits([]); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [query, subject.id]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const names = (all.data ?? []).filter((d: DocRef) => words.every((w) => d.filename.toLowerCase().includes(w)));
  const where = (d: DocRef) => (d.kind === 'reference' ? 'Textbook' : d.topic_name ?? 'Topic');
  const mark = (text: string) => {
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
  };
  const byDoc = new Map<number, SearchResult[]>();
  for (const h of hits ?? []) byDoc.set(h.document_id, [...(byDoc.get(h.document_id) ?? []), h]);
  return (
    <div className="side-scroll file-results">
      <div className="side-section-head"><span>File names</span><span className="count-badge">{names.length}</span></div>
      {!names.length && <div className="files-empty">No file names match.</div>}
      {names.map((d) => (
        <button key={d.id} className="fr-item" onClick={() => onOpen(d.id)} title={d.filename}>
          <span className={`file-icon ext-${d.ext.slice(1)}`}>{d.ext.slice(1).toUpperCase()}</span>
          <span className="fr-main"><span className="fr-name">{mark(d.filename)}</span><span className="fr-where">{where(d)}</span></span>
        </button>
      ))}
      <div className="side-section-head"><span>In file text</span>{hits && <span className="count-badge">{hits.length}</span>}</div>
      {query.length < 3 && <div className="files-empty">Type at least 3 letters to search inside files.</div>}
      {query.length >= 3 && !hits && <div className="files-empty">Searching…</div>}
      {warning && <div className="files-empty bad">{warning}</div>}
      {hits && !hits.length && !warning && <div className="files-empty">Nothing found inside the files.</div>}
      {[...byDoc.entries()].map(([docId, hs]) => (
        <div key={docId} className="fr-doc">
          <div className="fr-doc-name" title={hs[0].filename}>{hs[0].filename}</div>
          {hs.map((h) => (
            <button key={h.chunk_id} className="fr-hit" onClick={() => onOpen(docId, h.label, words.join(' '))}>
              <span className="fr-label">{h.label}</span>
              <span className="fr-snippet">{mark(snippet(h.text, words))}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** About 160 characters of `text` around the first query word found. */
function snippet(text: string, words: string[]) {
  const flat = text.replace(/\s+/g, ' ');
  const low = flat.toLowerCase();
  const at = Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0), flat.length);
  const start = at >= flat.length ? 0 : Math.max(0, at - 60);
  return (start ? '…' : '') + flat.slice(start, start + 160) + (start + 160 < flat.length ? '…' : '');
}
