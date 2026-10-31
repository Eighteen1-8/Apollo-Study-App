import { useEffect, useRef, useState } from 'react';
import { api, Unit, VisionMode } from '../api';
import { fmtTokens, usePoll } from '../hooks';
import Markdown from '../components/Markdown';
import { Button, Empty, MathText, Pill, Progress } from '../components/ui';

type Filter = 'all' | 'vision' | 'duplicates' | 'text';

/** Which unit a citation label points at: "Slide 32", "Page 20" by number, otherwise by section heading text. */
export function matchUnit(units: Unit[], label: string): Unit | undefined {
  const l = label.toLowerCase().trim();
  const num = l.match(/^(slide|page|part)\s+(\d+)/);
  if (num) return units.find((u) => u.idx === Number(num[2]));
  return units.find((u) => u.label.toLowerCase() === l)
    ?? units.find((u) => u.label.toLowerCase().startsWith(l) || l.startsWith(u.label.toLowerCase()))
    ?? units.find((u) => u.label.toLowerCase().includes(l));
}

/** Ingest details: what was extracted, embedded and described by vision, unit by unit. */
export default function DocumentView({ id, focus, onClose, onBack }: { id: number; focus?: string; onClose: () => void; onBack: () => void }) {
  const doc = usePoll(() => api.document(id), 4000, [id]);
  const [filter, setFilter] = useState<Filter>('all');
  const scrolled = useRef(false);
  const d = doc.data;
  const target = d && focus ? matchUnit(d.units, focus) : undefined;

  useEffect(() => {
    if (!target || scrolled.current) return;
    scrolled.current = true;
    requestAnimationFrame(() => {
      const el = document.getElementById(`unit-${target.id}`);
      const pane = el?.closest('.doc-pane');
      if (el && pane) pane.scrollTo({ top: el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12, behavior: 'smooth' });
    });
  }, [target]);

  if (!d) return <div className="page">{doc.error ? <Empty title="Document not found" /> : null}</div>;

  const units = d.units.filter((u) =>
    filter === 'all' ? true : filter === 'vision' ? u.needs_vision : filter === 'duplicates' ? !!u.duplicate_of : !u.needs_vision && !u.duplicate_of);
  const busy = ['queued', 'parsing', 'embedding', 'vision'].includes(d.status);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="doc-title">{d.filename}</h1>
          <div className="muted small">
            {d.kind === 'reference' ? 'Reference textbook' : 'Topic material'} · {d.unit_count} units · ~{fmtTokens(d.token_count)} tokens embedded
            · {d.chunk_count} chunks · {d.duplicate_units} exact duplicates skipped · {d.stripped_lines} repeated header/footer lines removed
          </div>
        </div>
        <div className="head-actions">
          <Button small onClick={onBack}>← Back to document</Button>
          <Pill status={d.status}>{d.status === 'vision' ? `Vision ${d.vision_done}/${d.vision_total}` : d.status}</Pill>
          <button className="close-x" title="Close document" onClick={onClose}>×</button>
        </div>
      </header>

      {d.status === 'vision' && <Progress value={d.vision_total ? d.vision_done / d.vision_total : 0} />}
      {d.error && <div className="banner banner-bad">{d.error}</div>}
      {focus && !target && <div className="banner banner-warn">Couldn't find “{focus}” in this file; showing the whole document.</div>}

      <div className="toolbar">
        <div className="seg">
          {(['all', 'vision', 'text', 'duplicates'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? `All (${d.units.length})` : f === 'vision' ? `Vision (${d.units.filter((u) => u.needs_vision).length})`
                : f === 'text' ? 'Text only' : `Duplicates (${d.duplicate_units})`}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <label className="select-label">
            Vision mode
            <select value={d.vision_mode} disabled={busy} onChange={(e) => api.vision(id, e.target.value as VisionMode).then(doc.reload)}>
              <option value="auto">Auto</option>
              <option value="all">Every page/slide</option>
              <option value="off">Off</option>
            </select>
          </label>
          {!busy && d.vision_total > d.vision_done && <Button small kind="primary" onClick={() => api.vision(id).then(doc.reload)}>Run vision</Button>}
          {!busy && <Button small onClick={() => api.reingest(id).then(doc.reload)}>Re-ingest</Button>}
        </div>
      </div>

      <div className="units">
        {units.map((u) => <UnitCard key={u.id} u={u} docId={id} ext={d.ext} focused={u.id === target?.id} />)}
        {units.length === 0 && <Empty title="Nothing in this filter" />}
      </div>
    </div>
  );
}

function UnitCard({ u, docId, ext, focused }: { u: Unit; docId: number; ext: string; focused?: boolean }) {
  const hasPreview = ext === '.pdf' || ext === '.pptx' || u.images.length > 0;
  const [showImg, setShowImg] = useState(!!focused && hasPreview);
  return (
    <div id={`unit-${u.id}`} className={`unit${u.duplicate_of ? ' unit-dup' : ''}${focused ? ' unit-focus' : ''}`}>
      <div className="unit-head">
        <span className="unit-label">{u.label}</span>
        {u.equations > 0 && <span className="tag">{u.equations} eq</span>}
        {u.duplicate_of ? (
          <span className="tag tag-dup" title="Exact text match (deterministic)">Duplicate of {u.duplicate_label ?? `#${u.duplicate_of}`}</span>
        ) : (
          <>
            {u.needs_vision ? <Pill status={u.vision_status}>vision: {u.vision_status}</Pill> : null}
            {u.vision_reasons.length > 0 && <span className="muted small">{u.vision_reasons.join(', ')}</span>}
          </>
        )}
        <span className="spacer" />
        <span className="muted small">~{u.token_count} tok</span>
        {hasPreview && <button className="link-btn" onClick={() => setShowImg(!showImg)}>{showImg ? 'Hide image' : 'Show image'}</button>}
      </div>
      {showImg && <img className="unit-img" src={api.previewUrl(docId, u.idx)} alt={u.label} loading="lazy" />}
      {!u.duplicate_of && (
        <div className="unit-body">
          <div className="unit-col">
            <div className="col-label">Extracted text <span className="muted">(embedded)</span></div>
            {u.text ? <MathText text={u.text} className="unit-text" /> : <div className="muted small">No text on this {u.kind}.</div>}
          </div>
          {u.needs_vision ? (
            <div className="unit-col unit-vision">
              <div className="col-label">Vision notes <span className="muted">(stored alongside, not embedded)</span></div>
              {u.vision_status === 'done' && u.vision_relevant === 0 && <div className="muted small">Apollo judged the visuals decorative.</div>}
              {u.vision_notes ? <Markdown text={u.vision_notes} className={u.vision_status === 'failed' ? 'bad' : ''} />
                : u.vision_status === 'pending' ? <div className="muted small">Waiting for Apollo…</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
