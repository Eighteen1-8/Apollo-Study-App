import { useEffect, useState } from 'react';
import { api, Backups as BackupList, FlagKind, inElectron, MaintDoc, MaintOverview, MaintScope, VisionFlag } from '../api';
import { fmtBytes, usePoll } from '../hooks';
import { MenuItem, useOverlay } from '../components/overlay';
import { Button, Empty, Pill } from '../components/ui';
import { logError } from '../log';
import Icon from '../components/Icon';
import ErrorText from '../components/ErrorText';

const KIND: Record<FlagKind, string> = {
  malformed: 'Malformed output', incomplete: 'Incomplete', misleading: 'False or misleading', failed: 'Vision failed',
};

type Scope = MaintScope & { label: string };
const scopeKey = (s: Scope) => `${s.subject_id ?? ''}/${s.topic_id ?? ''}/${s.document_id ?? ''}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sum = (ds: MaintDoc[], f: (d: MaintDoc) => number) => ds.reduce((n, d) => n + f(d), 0);

/** Settings → Maintenance: disk use per subject/topic/file, leftovers, the search index, and vision notes problems
 * (the quick checks plus Apollo's review against each page image) with re-running vision on just the flagged pages. */
export default function MaintenanceView({ subjectId }: { subjectId?: number }) {
  const ov = useOverlay();
  const data = usePoll(api.maintenance, 4000, [], ['documents', 'flags', 'jobs']);
  const [open, setOpen] = useState<Set<number>>(new Set(subjectId ? [subjectId] : []));
  const [compact, setCompact] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const o = data.data;
  if (!o) return <div className="maint">{data.error ? <div className="banner banner-bad">{data.error}</div> : <p className="muted">Loading…</p>}</div>;

  const subjectName = (id: number) => o.subjects.find((s) => s.id === id)?.name ?? 'Subject';
  const issues: Scope = scope ?? (subjectId ? { subject_id: subjectId, label: subjectName(subjectId) } : { label: 'All subjects' });
  const showIssues = (s: Scope) => {
    setScope(s);
    requestAnimationFrame(() => document.querySelector('.maint-issues')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const reload = () => data.reload();

  const check = async (s: Scope) => {
    const r = await api.visionScan(s);
    showIssues(s);
    reload();
    await ov.confirm({
      title: `Checking vision notes: ${s.label}`, confirmText: 'OK',
      body: <>{r.rule_flags ? `${plural(r.rule_flags, 'problem')} found by the quick checks. ` : 'The quick checks found no problems. '}
        {r.units ? `Apollo is comparing ${plural(r.units, 'page')} with the images in the background; what it flags appears below with the reason.`
          : 'Apollo has already reviewed every page here (use “Review again” to recheck).'}</>,
    });
  };
  const rerun = async (s: Scope, n: number) => {
    if (!(await ov.confirm({ title: `Re-run vision on ${plural(n, 'flagged page')}?`, confirmText: 'Re-run vision',
      body: 'Only the flagged pages are sent to the vision model again. Their flags are cleared and the new notes are checked automatically.' }))) return;
    await api.rerunFlagged(s);
    reload();
  };
  const scopeMenu = (s: Scope, docs: MaintDoc[]): MenuItem[] => {
    const flags = sum(docs, (d) => d.flags);
    return [
      { label: 'Check vision notes', onClick: () => check(s) },
      { label: 'Review again with Apollo', onClick: async () => { await api.visionScan(s, true, true); showIssues(s); reload(); } },
      { label: `Re-run vision on flagged pages${flags ? ` (${flags})` : ''}`, disabled: !flags, onClick: () => rerun(s, flags) },
      { label: 'Show vision issues', onClick: () => showIssues(s) },
      { label: 'Re-embed missing vectors', separatorBefore: true, disabled: !docs.some((d) => d.unembedded || d.stale),
        onClick: async () => { await api.reembed(s); reload(); } },
    ];
  };
  const docMenu = (d: MaintDoc): MenuItem[] => {
    const s = { document_id: d.id, label: d.filename };
    return [
      { label: 'Show in folder', disabled: !inElectron || d.missing, onClick: () => window.studyApp!.showItem(d.path) },
      ...scopeMenu(s, [d]).map((m, i) => (i ? m : { ...m, separatorBefore: true })),
      { label: 'Re-ingest', onClick: async () => { await api.reingest(d.id); reload(); } },
      { label: 'Delete file', danger: true, separatorBefore: true, onClick: async () => {
        if (await ov.confirm({ title: `Delete ${d.filename}?`, danger: true, confirmText: 'Delete',
          body: 'It goes to the trash for a week (Undo brings it back), then it and everything read from it are removed.' })) { await api.deleteDocument(d.id); reload(); }
      } },
    ];
  };

  return (
    <div className="maint">
      <Storage o={o} compact={compact} setCompact={setCompact} onClean={async () => {
        const n = o.orphans.files.count + o.orphans.renders.count + o.orphans.assets.count + o.orphans.cache.count + o.stale_rows;
        if (!(await ov.confirm({ title: 'Clean up?', confirmText: 'Clean up', danger: true,
          body: <>{n ? `${plural(n, 'leftover item')} will be removed: files of deleted documents, figures and chat images nothing uses, and records pointing at nothing.` : 'There are no leftovers.'}
            {compact && ' The database is compacted too, which can take a while on a large library.'}</> }))) return;
        const r = await api.cleanup(compact);
        reload();
        await ov.confirm({ title: 'Cleaned up', body: `${fmtBytes(r.freed)} freed.`, confirmText: 'OK' });
      }} />

      <Backups />

      <Index o={o} onReembed={async () => { const r = await api.reembed({}); reload();
        await ov.confirm({ title: 'Re-embedding', confirmText: 'OK', body: r.queued ? `${plural(r.queued, 'file')} queued (see the jobs list).` : 'Everything is up to date.' }); }}
        onReparse={async () => { const r = await api.reparse({}); reload();
          await ov.confirm({ title: 'Reading files again', confirmText: 'OK', body: `${plural(r.queued, 'file')} queued (see the jobs list). Vision notes are kept for every page whose content hasn't changed.` }); }} />
      <Copies o={o} onChange={reload} />

      <section className="section">
        <h2>Library</h2>
        <p className="muted maint-help">Files are stored once by content in the data folder, not in per-subject folders. Sizes include each file,
          its exact copy for the viewer, its page images and its share of the search index.</p>
        {!o.subjects.length && <Empty title="No subjects yet" />}
        <div className="maint-tree">
          {o.subjects.map((s) => {
            const docs = o.documents.filter((d) => d.subject_id === s.id);
            const isOpen = open.has(s.id);
            const sc = { subject_id: s.id, label: s.name };
            const groups = [
              ...o.topics.filter((t) => t.subject_id === s.id).map((t) => ({ key: `t${t.id}`, name: t.name, scope: { topic_id: t.id, label: t.name } as Scope,
                docs: docs.filter((d) => d.topic_id === t.id) })),
              { key: 'ref', name: 'Reference library', scope: null, docs: docs.filter((d) => d.kind === 'reference') },
            ].filter((g) => g.docs.length || g.scope);
            return (
              <div key={s.id} className={`maint-subject${isOpen ? ' open' : ''}`} style={{ '--tint': s.color } as React.CSSProperties}>
                <div className="maint-row maint-subject-row" onClick={() => setOpen((p) => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}
                  onContextMenu={(e) => ov.menu(e, scopeMenu(sc, docs))}>
                  <span className={`topic-caret${isOpen ? ' open' : ''}`}><Icon name="chevronRight" size={13} /></span>
                  <span className="maint-dot" />
                  <span className="maint-name">{s.name}</span>
                  <Stats docs={docs} onFlags={() => showIssues(sc)} />
                  <span className="maint-actions" onClick={(e) => e.stopPropagation()}>
                    <Button small onClick={() => check(sc)}>Check vision</Button>
                    <button className="icon-btn" title="More" onClick={(e) => ov.menu(e, scopeMenu(sc, docs))}><Icon name="more" /></button>
                  </span>
                </div>
                {isOpen && groups.map((g) => (
                  <div key={g.key} className="maint-group">
                    <div className="maint-row maint-group-row" onContextMenu={g.scope ? (e) => ov.menu(e, scopeMenu(g.scope!, g.docs)) : undefined}>
                      <span className="maint-name">{g.name}</span>
                      <Stats docs={g.docs} onFlags={() => showIssues(g.scope ?? sc)} />
                      <span className="maint-actions">
                        {g.scope && <button className="icon-btn" title="More" onClick={(e) => ov.menu(e, scopeMenu(g.scope!, g.docs))}><Icon name="more" /></button>}
                      </span>
                    </div>
                    {!g.docs.length && <div className="maint-empty muted">No files</div>}
                    {g.docs.map((d) => <DocRow key={d.id} d={d} onFlags={() => showIssues({ document_id: d.id, label: d.filename })}
                      onMenu={(e) => ov.menu(e, docMenu(d))} />)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      <Issues key={scopeKey(issues)} scope={issues} o={o} onScope={setScope} onChange={reload} />
    </div>
  );
}

function Storage({ o, compact, setCompact, onClean }: { o: MaintOverview; compact: boolean; setCompact: (v: boolean) => void; onClean: () => void }) {
  const parts = [
    { k: 'database', label: 'Database (text, notes, index)', v: o.disk.database },
    { k: 'files', label: 'Original files', v: o.disk.files },
    { k: 'renders', label: 'Exact copies for the viewer', v: o.disk.renders },
    { k: 'assets', label: 'Page images and previews', v: o.disk.assets },
  ];
  const total = parts.reduce((n, p) => n + p.v, 0) || 1;
  const left = o.orphans.files.bytes + o.orphans.renders.bytes + o.orphans.assets.bytes + o.orphans.cache.bytes;
  const leftN = o.orphans.files.count + o.orphans.renders.count + o.orphans.assets.count + o.orphans.cache.count + o.stale_rows;
  return (
    <section className="section">
      <h2>Storage</h2>
      <div className="maint-disk">
        <div className="maint-disk-bar">{parts.map((p) => <span key={p.k} className={`seg-${p.k}`} style={{ flexGrow: p.v / total }} title={`${p.label}: ${fmtBytes(p.v)}`} />)}</div>
        <div className="maint-disk-legend">
          {parts.map((p) => <span key={p.k}><i className={`seg-${p.k}`} />{p.label} <b>{fmtBytes(p.v)}</b></span>)}
          <span className="maint-disk-total">Total <b>{fmtBytes(total)}</b></span>
        </div>
      </div>
      <div className="maint-line">
        <code className="maint-path" title={o.data_dir}>{o.data_dir}</code>
        <Button small disabled={!inElectron} onClick={() => window.studyApp!.showItem(o.db_path)}>Open data folder</Button>
        <Button small disabled={!inElectron} onClick={() => window.studyApp!.showItem(o.log_path)}>Open log</Button>
      </div>
      <div className="maint-line">
        <span>{leftN ? <>Leftovers (deleted files, unused figures and screenshots, stale records): <b>{plural(leftN, 'item')}</b>, {fmtBytes(left)}</> : 'No leftovers.'}</span>
        <label className="field-bool maint-check"><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> Also compact the database</label>
        <Button small onClick={onClean} disabled={!leftN && !compact}>Clean up</Button>
      </div>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { daily: 'Daily', 'before-update': 'Before an app update', 'before-restore': 'Before a restore', manual: 'Made by you' };

/** Database backups: made daily and before every database update; restoring swaps the database at the next start. */
function Backups() {
  const ov = useOverlay();
  const [b, setB] = useState<BackupList | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.backups().then(setB).catch((e) => logError('backups', e));
  useEffect(() => { load(); }, []);
  if (!b) return null;
  const pending = b.backups.find((x) => x.name === b.pending_restore);
  const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const now = async () => {
    setBusy(true);
    try { await api.backupNow(); await load(); } catch (e) { await ov.confirm({ title: 'Backup failed', body: String(e), confirmText: 'OK' }); }
    finally { setBusy(false); }
  };
  const restore = async (name: string, t: number) => {
    if (!(await ov.confirm({
      title: 'Restore this backup?', confirmText: 'Restore at next start', danger: true,
      body: <>Your library goes back to how it was on <b>{when(t)}</b>: anything added or changed since is undone. Your current data is
        backed up first, so this can be reversed. It happens the next time Apollo starts; restart the app to finish.</>,
    }))) return;
    await api.restoreBackup(name);
    load();
  };
  const remove = async (name: string) => {
    if (await ov.confirm({ title: 'Delete this backup?', confirmText: 'Delete', danger: true })) { await api.deleteBackup(name); load(); }
  };
  return (
    <section className="section">
      <h2>Backups</h2>
      <p className="muted maint-help">The database (subjects, files' text and vision notes, generated content, progress) is copied once a day
        and before every app update changes it. The original files aren't copied; they're kept in the data folder. Older copies are deleted
        automatically ({b.keep.daily} daily, {b.keep['before-update']} before updates, {b.keep.manual} of your own).</p>
      {pending && (
        <div className="banner banner-warn maint-restore">
          <span>Restoring the backup from <b>{when(pending.created_at)}</b> the next time Apollo starts. Restart the app to finish.</span>
          <Button small onClick={async () => { await api.restoreBackup(null); load(); }}>Cancel restore</Button>
        </div>
      )}
      <div className="maint-line">
        <span>{b.backups.length ? <>{plural(b.backups.length, 'backup')}, {fmtBytes(b.backups.reduce((n, x) => n + x.size, 0))}</> : 'No backups yet: the first daily one is made a minute after the app starts.'}</span>
        <span className="grow" />
        <Button small disabled={!inElectron} onClick={() => window.studyApp!.showItem(b.folder)}>Open backups folder</Button>
        <Button small kind="primary" disabled={busy} onClick={now}>{busy ? 'Backing up…' : 'Back up now'}</Button>
      </div>
      {b.backups.length > 0 && (
        <div className="maint-backups">
          {b.backups.map((x) => (
            <div key={x.name} className={`maint-row maint-backup${x.name === b.pending_restore ? ' pending' : ''}`}>
              <span className="maint-name">{when(x.created_at)}</span>
              <span className="maint-backup-kind">{KIND_LABEL[x.kind] ?? x.kind}</span>
              <span className="maint-size">{fmtBytes(x.size)}</span>
              <span className="maint-actions">
                <Button small disabled={x.name === b.pending_restore} onClick={() => restore(x.name, x.created_at)}>Restore…</Button>
                <button className="x-btn" title="Delete this backup" onClick={() => remove(x.name)}><Icon name="close" size={14} /></button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Index({ o, onReembed, onReparse }: { o: MaintOverview; onReembed: () => void; onReparse: () => void }) {
  const missing = o.documents.filter((d) => d.unembedded || d.stale);
  const oldParser = o.documents.filter((d) => d.old_parser);
  const vision = sum(o.documents, (d) => d.vision_chunks);
  return (
    <section className="section">
      <h2>Search index</h2>
      <div className="maint-line">
        <span>Embedding model <code>{o.embed_model}</code> · {sum(o.documents, (d) => d.text_chunks).toLocaleString()} text and {vision.toLocaleString()} visual
          chunks. Vision notes are embedded too, so scanned pages and diagrams can be found by search.</span>
      </div>
      <div className="maint-line">
        <span>{missing.length ? <><b>{plural(missing.length, 'file')}</b> {missing.length === 1 ? 'has' : 'have'} chunks without a vector from this model and {missing.length === 1 ? "isn't" : "aren't"} fully searchable.</>
          : 'Every chunk has a vector from the current model.'}</span>
        <Button small disabled={!missing.length} onClick={onReembed}>Re-embed</Button>
      </div>
      {oldParser.length > 0 && (
        <div className="maint-line">
          <span><b>{plural(oldParser.length, 'file')}</b> {oldParser.length === 1 ? 'was' : 'were'} read by an older version of the file reader and
            may be missing text the current one finds (e.g. SmartArt and chart labels).</span>
          <Button small onClick={onReparse}>Read again</Button>
        </div>
      )}
    </section>
  );
}

/** Word/PowerPoint files without an exact PDF copy (render.py): the viewer shows them in a simpler layout. */
function Copies({ o, onChange }: { o: MaintOverview; onChange: () => void }) {
  const failed = o.documents.filter((d) => d.render_error);
  const [busy, setBusy] = useState<number | null>(null);
  if (!failed.length) return null;
  const retry = async (ids: number[]) => {
    for (const id of ids) {
      setBusy(id);
      try { await api.retryRender(id); } catch (e) { logError('retrying an Office copy', e, 'warning'); }
    }
    setBusy(null);
    onChange();
  };
  return (
    <section className="section">
      <h2>Exact copies for the viewer</h2>
      <div className="maint-line">
        <span><b>{plural(failed.length, 'Word or PowerPoint file')}</b> {failed.length === 1 ? 'has' : 'have'} no exact copy, so the viewer
          shows a simpler layout. The reason is below each one.</span>
        <Button small disabled={busy !== null} onClick={() => retry(failed.map((d) => d.id))}>{busy !== null ? 'Trying…' : 'Try all again'}</Button>
      </div>
      <div className="maint-copies">
        {failed.map((d) => (
          <div key={d.id} className="maint-row maint-copy">
            <span className="maint-name" title={d.path}>{d.filename}</span>
            <span className="small"><ErrorText text={d.render_error} /></span>
            <Button small disabled={busy !== null} onClick={() => retry([d.id])}>{busy === d.id ? 'Trying…' : 'Try again'}</Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Stats({ docs, onFlags }: { docs: MaintDoc[]; onFlags: () => void }) {
  const flags = sum(docs, (d) => d.flags);
  const reviewing = docs.some((d) => d.reviewing);
  return (
    <span className="maint-stats">
      {reviewing && <Pill status="running">reviewing</Pill>}
      {flags > 0 && <button className="maint-flags" onClick={(e) => { e.stopPropagation(); onFlags(); }} title="Show vision issues">⚑ {flags}</button>}
      <span>{plural(docs.length, 'file')}</span>
      <span className="maint-size">{fmtBytes(sum(docs, (d) => d.size.total))}</span>
    </span>
  );
}

function DocRow({ d, onFlags, onMenu }: { d: MaintDoc; onFlags: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const s = d.size;
  return (
    <div className="maint-row maint-doc" onContextMenu={onMenu}>
      <span className="maint-name" title={d.path}>{d.filename}</span>
      <span className="maint-doc-meta">
        {d.missing && <Pill status="failed">file missing</Pill>}
        {(d.stale || d.unembedded > 0) && <span className="maint-warn" title="Chunks without a vector from the current embedding model">not fully indexed</span>}
        {d.status !== 'ready' && <Pill status={d.status} />}
        <span title="Text chunks · visual chunks">{d.text_chunks} + {d.vision_chunks} chunks</span>
        {d.vision_total > 0 && <span title="Pages with vision notes">vision {d.vision_done}/{d.vision_total}{d.vision_failed ? `, ${d.vision_failed} failed` : ''}</span>}
        {d.reviewing && <Pill status="running">reviewing</Pill>}
        {d.render_error && <span className="maint-warn" title={d.render_error}>simplified view</span>}
        {d.flags > 0 && <button className="maint-flags" onClick={onFlags} title="Show vision issues">⚑ {d.flags}</button>}
        <span className="maint-size" title={`File ${fmtBytes(s.file)} · viewer copy ${fmtBytes(s.render)} · images ${fmtBytes(s.assets)} · index ${fmtBytes(s.index)}`}>{fmtBytes(s.total)}</span>
      </span>
      <button className="icon-btn" title="File options" onClick={onMenu}><Icon name="more" /></button>
    </div>
  );
}

function Issues({ scope, o, onScope, onChange }: { scope: Scope; o: MaintOverview; onScope: (s: Scope) => void; onChange: () => void }) {
  const ov = useOverlay();
  const [dismissed, setDismissed] = useState(false);
  const flags = usePoll(() => api.visionFlags(scope, dismissed), 1500, [dismissed], ['flags']);
  const list = flags.data ?? [];
  const reload = () => { flags.reload(); onChange(); };
  const options: Scope[] = [{ label: 'All subjects' }, ...o.subjects.flatMap((s) => [
    { subject_id: s.id, label: s.name },
    ...o.topics.filter((t) => t.subject_id === s.id).map((t) => ({ topic_id: t.id, label: `${s.name} › ${t.name}` })),
  ])];
  if (scope.document_id && !options.some((x) => x.document_id === scope.document_id)) options.push(scope);
  const rerun = async (ids: number[]) => { await api.rerunFlagged({ flag_ids: ids }); reload(); };
  const dismiss = async (ids: number[]) => { await api.dismissFlags(ids, dismissed); reload(); };

  return (
    <section className="section maint-issues">
      <h2>Vision issues</h2>
      <p className="muted maint-help">The quick checks catch broken output (the model's reasoning left in, cut-off or looping text, broken LaTeX,
        failed calls). Apollo's review compares each page's notes with its image and flags false or misleading descriptions. It is the
        same model checking its own work, so read the reason before re-running.</p>
      <div className="maint-line">
        <select value={scopeKey(scope)} onChange={(e) => onScope(options.find((x) => scopeKey(x) === e.target.value)!)}>
          {options.map((x) => <option key={scopeKey(x)} value={scopeKey(x)}>{x.label}</option>)}
        </select>
        <label className="field-bool maint-check"><input type="checkbox" checked={dismissed} onChange={(e) => setDismissed(e.target.checked)} /> Show dismissed</label>
        <span className="grow" />
        {!dismissed && list.length > 0 && <Button small kind="primary" onClick={async () => {
          const units = new Set(list.map((f) => `${f.document_id}:${f.unit}`)).size;
          if (await ov.confirm({ title: `Re-run vision on ${plural(units, 'page')}?`, confirmText: 'Re-run vision',
            body: 'Only these pages are sent to the vision model again.' })) rerun(list.map((f) => f.id));
        }}>Re-run all shown</Button>}
        {list.length > 0 && <Button small onClick={() => dismiss(list.map((f) => f.id))}>{dismissed ? 'Restore all' : 'Dismiss all'}</Button>}
      </div>
      {flags.data && !list.length && <Empty title={dismissed ? 'Nothing dismissed' : 'No vision issues'}>
        {!dismissed && 'Use “Check vision” on a subject, topic or file to run the checks and Apollo\'s review.'}</Empty>}
      <div className="flag-list">
        {list.map((f) => <FlagCard key={f.id} f={f} dismissed={dismissed} onRerun={() => rerun([f.id])} onDismiss={() => dismiss([f.id])} />)}
      </div>
    </section>
  );
}

function FlagCard({ f, dismissed, onRerun, onDismiss }: { f: VisionFlag; dismissed: boolean; onRerun: () => void; onDismiss: () => void }) {
  const [img, setImg] = useState(true);
  return (
    <div className={`flag-card flag-${f.kind}`}>
      {img && <img className="flag-thumb" loading="lazy" src={api.previewUrl(f.document_id, f.unit)} alt="" onError={() => setImg(false)} />}
      <div className="flag-body">
        <div className="flag-head">
          <b>{f.filename}</b><span className="muted">· {f.label}{f.topic ? ` · ${f.topic}` : ''}</span>
          <span className={`flag-kind kind-${f.kind}`}>{KIND[f.kind] ?? f.kind}</span>
          <span className="flag-source">{f.source === 'rule' ? 'Quick check' : "Apollo's review"}</span>
        </div>
        <p className="flag-reason">{f.reason}</p>
        {f.notes && <details className="flag-notes"><summary>Saved notes ({f.notes_length.toLocaleString()} characters)</summary>
          <pre>{f.notes}{f.notes_length > f.notes.length ? '\n…' : ''}</pre></details>}
      </div>
      <div className="flag-actions">
        {!dismissed && <Button small kind="primary" onClick={onRerun}>Re-run vision</Button>}
        <Button small kind="ghost" onClick={onDismiss}>{dismissed ? 'Restore' : 'Dismiss'}</Button>
      </div>
    </div>
  );
}
