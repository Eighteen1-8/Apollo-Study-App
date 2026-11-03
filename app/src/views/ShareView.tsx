import { useEffect, useState } from 'react';
import { api, DocRef, ExportPreview, ImportPreview, ImportResult, inElectron, PackScope, Subject } from '../api';
import { fmtBytes } from '../hooks';
import { Modal } from '../components/overlay';
import { Button } from '../components/ui';
import { logError } from '../log';

type What = 'subject' | 'topic' | 'files';
const ZIP = [{ name: 'Apollo study pack', extensions: ['zip'] }];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Settings → Share: export embedded files (a subject, a topic or chosen files) as one study pack, and import packs
 * made by someone else. A pack carries the parsed text, vision notes and vectors, so importing skips all of that work. */
export default function ShareView({ subjectId, onChanged }: { subjectId?: number; onChanged: () => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  useEffect(() => { api.subjects().then(setSubjects).catch((e) => logError('share', e)); }, []);
  return (
    <div className="share">
      <ExportCard subjects={subjects} initialSubject={subjectId} />
      <ImportCard subjects={subjects} onDone={() => { api.subjects().then(setSubjects); onChanged(); }} />
    </div>
  );
}

function ExportCard({ subjects, initialSubject }: { subjects: Subject[]; initialSubject?: number }) {
  const [sid, setSid] = useState<number | null>(initialSubject ?? null);
  const [what, setWhat] = useState<What>('subject');
  const [topic, setTopic] = useState<number | null>(null);
  const [docs, setDocs] = useState<DocRef[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [ask, setAsk] = useState<ExportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const subject = subjects.find((s) => s.id === sid) ?? null;

  useEffect(() => { if (sid === null && subjects.length) setSid(subjects[0].id); }, [subjects]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPicked(new Set());
    setTopic(null);
    if (sid !== null) api.allDocuments(sid).then(setDocs).catch(() => setDocs([]));
  }, [sid]);

  const scope = (): PackScope | null => {
    if (sid === null) return null;
    if (what === 'topic') return topic === null ? null : { topic_id: topic };
    if (what === 'files') return picked.size ? { document_ids: [...picked] } : null;
    return { subject_id: sid };
  };

  const start = async () => {
    const s = scope();
    if (!s) return;
    setErr(null);
    setDone(null);
    try {
      const p = await api.exportPreview(s);
      if (!p.documents) { setErr('Nothing to export: none of these files has finished ingesting yet.'); return; }
      if (p.annotated.length) setAsk(p); // the student's notes: keep them, or export clean copies
      else await run(p, true);
    } catch (e) { setErr(String(e)); }
  };

  const run = async (p: ExportPreview, includeNotes: boolean) => {
    const s = scope()!;
    setAsk(null);
    setBusy(true);
    try {
      if (inElectron) {
        const path = await window.studyApp!.saveFile({ defaultName: `${p.label}.apollo.zip`, filters: ZIP });
        if (!path) return;
        const r = await api.exportPack({ ...s, include_notes: includeNotes, path });
        setDone(`Exported ${plural(r.documents, 'file')} (${fmtBytes(r.bytes)}) to ${r.path}`);
      } else {
        const { blob, name } = await api.exportPackBlob({ ...s, include_notes: includeNotes });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        setDone(`Exported ${plural(p.documents, 'file')} as ${name}`);
      }
      if (p.skipped.length) setDone((d) => `${d}. Still ingesting, so left out: ${p.skipped.join(', ')}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const groups = subject ? [
    ...subject.topics.map((t) => ({ name: t.name, docs: docs.filter((d) => d.topic_id === t.id) })),
    { name: 'Reference library', docs: docs.filter((d) => d.kind === 'reference') },
  ].filter((g) => g.docs.length) : [];

  return (
    <section className="card share-card">
      <h2>Export</h2>
      <p className="muted small share-help">Saves files with everything Apollo made from them (text, vision notes and embeddings) as one
        zip. Classmates can import it instead of ingesting the same files themselves.</p>
      <div className="share-row">
        <label>Subject</label>
        <select value={sid ?? ''} onChange={(e) => setSid(Number(e.target.value))}>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="seg">
          {(['subject', 'topic', 'files'] as const).map((w) => (
            <button key={w} className={what === w ? 'active' : ''} onClick={() => setWhat(w)}>
              {w === 'subject' ? 'Whole subject' : w === 'topic' ? 'One topic' : 'Choose files'}
            </button>
          ))}
        </div>
      </div>
      {what === 'topic' && subject && (
        <div className="share-row">
          <label>Topic</label>
          <select value={topic ?? ''} onChange={(e) => setTopic(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose a topic…</option>
            {subject.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {what === 'files' && (
        <div className="share-files">
          {groups.length === 0 && <div className="muted small">No files in this subject.</div>}
          {groups.map((g) => (
            <div key={g.name} className="share-group">
              <div className="share-group-head">{g.name}</div>
              {g.docs.map((d) => (
                <label key={d.id} className="share-file">
                  <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                  <span>{d.filename}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {what === 'subject' && <p className="muted small">Includes every topic and the reference library.</p>}
      <div className="share-actions">
        <Button kind="primary" disabled={!scope() || busy} onClick={start}>{busy ? 'Exporting…' : 'Export…'}</Button>
        {what === 'files' && picked.size > 0 && <span className="muted small">{plural(picked.size, 'file')} selected</span>}
      </div>
      {done && <div className="banner banner-ok share-msg">{done}</div>}
      {err && <div className="banner banner-bad share-msg">{err}</div>}

      {ask && (
        <Modal title="Include your notes?" onClose={() => setAsk(null)}
          footer={<>
            <button className="btn" onClick={() => setAsk(null)}>Cancel</button>
            <button className="btn" onClick={() => run(ask, false)}>Export clean copies</button>
            <button className="btn btn-primary" onClick={() => run(ask, true)}>Keep my notes</button>
          </>}>
          <p>{plural(ask.annotated.length, 'file')} in this export {ask.annotated.length === 1 ? 'has' : 'have'} your own highlights, notes or
            drawings:</p>
          <ul className="share-annotated">
            {ask.annotated.map((a) => <li key={a.id}>{a.filename} <span className="muted">({plural(a.marks, 'mark')})</span></li>)}
          </ul>
          <p className="muted small">Clean copies leave them out: the text Apollo searches is rebuilt without them and the changed parts are
            embedded again for the export (your own copy is not changed).</p>
        </Modal>
      )}
    </section>
  );
}

function ImportCard({ subjects, onDone }: { subjects: Subject[]; onDone: () => void }) {
  const [path, setPath] = useState('');
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [target, setTarget] = useState<number | 'new'>('new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async (p: string) => {
    setErr(null);
    setRes(null);
    setPv(null);
    setPath(p);
    if (!p) return;
    try {
      const x = await api.importPreview(p);
      setPv(x);
      const same = subjects.find((s) => s.name.toLowerCase() === x.subject.toLowerCase());
      setTarget(same ? same.id : 'new');
      setName(x.subject);
    } catch (e) { setErr(String(e)); }
  };
  const choose = async () => {
    const p = await window.studyApp!.openFiles({ multi: false, filters: ZIP });
    if (p[0]) load(p[0]);
  };
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importPack({ path, subject_id: target === 'new' ? null : target, subject_name: target === 'new' ? name.trim() : undefined });
      setRes(r);
      setPv(null);
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card share-card">
      <h2>Import</h2>
      <p className="muted small share-help">Adds the files from a study pack with their text, vision notes and embeddings, without
        parsing or running vision again. Files you already have in the same place are skipped.</p>
      <div className="share-row">
        {inElectron
          ? <Button onClick={choose}>Choose a study pack…</Button>
          : <input className="share-path" placeholder="Full path to a .zip study pack" value={path}
              onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(path)} />}
        {path && <span className="share-chosen" title={path}>{path.split(/[\\/]/).pop()}</span>}
      </div>
      {pv && (
        <div className="share-preview">
          <div className="share-stat"><b>{pv.subject}</b>{pv.scope && pv.scope !== pv.subject ? ` · ${pv.scope}` : ''}</div>
          <div className="share-stat">{plural(pv.documents.length, 'file')}{pv.topics.length ? ` in ${plural(pv.topics.length, 'topic')}: ${pv.topics.join(', ')}` : ''}
            {pv.documents.some((d) => d.kind === 'reference') && ' · includes textbooks'}</div>
          <div className={`share-stat ${pv.same_model ? 'ok' : 'warn'}`}>
            {pv.same_model
              ? `✓ Embedded with ${pv.embed_model}, the model you use: ready to search straight away.`
              : `Embedded with ${pv.embed_model ?? 'an unknown model'}; you use ${pv.current_model}. The text and vision notes are kept and only the embeddings are made again here.`}
          </div>
          {pv.notes_included && pv.documents.some((d) => d.notes) && <div className="share-stat muted">Includes the sender's notes on some files.</div>}
          <div className="share-row">
            <label>Add to</label>
            <select value={target} onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
              <option value="new">A new subject</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {target === 'new' && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Subject name" />}
          </div>
          <p className="muted small">Topics are matched by name; any that don't exist yet are created.</p>
          <div className="share-actions">
            <Button kind="primary" disabled={busy || (target === 'new' && !name.trim())} onClick={run}>{busy ? 'Importing…' : 'Import'}</Button>
          </div>
        </div>
      )}
      {res && (
        <div className="banner banner-ok share-msg">
          Imported {plural(res.imported, 'file')}.
          {res.reembedding > 0 && ` ${plural(res.reembedding, 'file')} are being embedded with your model (see background jobs).`}
          {res.skipped.length > 0 && <ul className="share-annotated">{res.skipped.map((s, i) => <li key={i}>{s.filename}: {s.reason}</li>)}</ul>}
        </div>
      )}
      {err && <div className="banner banner-bad share-msg">{err}</div>}
    </section>
  );
}
