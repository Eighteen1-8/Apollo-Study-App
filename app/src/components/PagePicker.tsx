/* Choose pages, slides or sections of a file (Make content → Advanced): a range box ("3-7, 12") kept in step with a
   thumbnail grid (click to toggle, Shift-click for a range), chapter shortcuts from the file's outline, and a list of
   labels when the file has no PDF copy to draw thumbnails from (Word sections map to their PDF pages via render_map).
   The choice is {document id: [unit idx, …]}: once anything is chosen, only the chosen pages are used (files with no
   choice are left out; see context.topic_documents). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, DocUnits, OutlineItem } from '../api';
import { logError } from '../log';
import Icon from './Icon';

export type UnitChoice = Record<number, number[]>;

/** "3-7, 12" → [3, 4, 5, 6, 7, 12] (only numbers in `valid`), and the numbers that aren't. */
export function parseRanges(text: string, valid: Set<number>): { picked: number[]; unknown: number[] } {
  const picked = new Set<number>();
  const unknown: number[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    let a = Number(m[1]);
    let b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b && i - a <= 5000; i++) {
      if (valid.has(i)) picked.add(i);
      else unknown.push(i);
    }
  }
  return { picked: [...picked].sort((x, y) => x - y), unknown };
}

/** [3, 4, 5, 7] → "3-5, 7" */
export function formatRanges(idxs: number[]): string {
  const s = [...new Set(idxs)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(', ');
}

const noun = (kind: string, n: number) => {
  const w = kind === 'slide' ? 'slide' : kind === 'section' ? 'section' : 'page';
  return n === 1 ? w : `${w}s`;
};

export default function PagePicker({ docs, value, onChange }: {
  docs: { id: number; filename: string }[]; value: UnitChoice; onChange: (v: UnitChoice) => void;
}) {
  const [docId, setDocId] = useState<number | null>(() => Number(Object.keys(value)[0]) || docs[0]?.id || null);
  const [info, setInfo] = useState<DocUnits | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const last = useRef<number | null>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (docId !== null && !docs.some((d) => d.id === docId)) setDocId(docs[0]?.id ?? null);
  }, [docs, docId]);
  useEffect(() => {
    if (docId === null) return;
    let alive = true;
    setInfo(null);
    setError(null);
    api.documentUnits(docId).then((u) => alive && setInfo(u)).catch((e) => alive && setError(String(e).replace(/^Error: /, '')));
    api.outline(docId).then((o) => alive && setOutline(o)).catch((e) => { logError('page picker outline', e, 'warning'); if (alive) setOutline([]); });
    return () => { alive = false; };
  }, [docId]);

  const chosen = useMemo(() => new Set(docId !== null ? value[docId] ?? [] : []), [value, docId]);
  const valid = useMemo(() => new Set(info?.units.map((u) => u.idx) ?? []), [info]);
  // the box follows clicks, but not while it's being typed in ("3-" is on its way to "3-7")
  useEffect(() => { if (document.activeElement !== box.current) setText(formatRanges([...chosen])); }, [chosen]);

  const set = (idxs: Iterable<number>) => {
    if (docId === null) return;
    const list = [...new Set(idxs)].filter((i) => valid.has(i)).sort((a, b) => a - b);
    const next = { ...value };
    if (list.length) next[docId] = list; else delete next[docId];
    onChange(next);
  };
  const click = (idx: number, shift: boolean) => {
    const next = new Set(chosen);
    if (shift && last.current !== null && info) {
      const [a, b] = [Math.min(last.current, idx), Math.max(last.current, idx)];
      const on = !chosen.has(idx);
      for (const u of info.units) if (u.idx >= a && u.idx <= b) { if (on) next.add(u.idx); else next.delete(u.idx); }
    } else if (next.has(idx)) next.delete(idx); else next.add(idx);
    last.current = idx;
    set(next);
  };
  const typed = parseRanges(text, valid);

  // chapters: the outline's top level, each covering the units up to the next chapter
  const chapters = useMemo(() => {
    if (!info || !outline.length) return [];
    const top = Math.min(...outline.map((o) => o.level));
    const heads = outline.filter((o) => o.level === top).slice(0, 40);
    const pos = (u: DocUnits['units'][number]) => u.page ?? u.idx;
    return heads.map((h, i) => {
      const end = heads[i + 1]?.unit ?? Infinity;
      const idxs = info.units.filter((u) => pos(u) >= h.unit && pos(u) < end).map((u) => u.idx);
      return { title: h.title, idxs };
    }).filter((c) => c.idxs.length);
  }, [info, outline]);

  const kind = info?.units[0]?.kind ?? 'page';
  const picks = Object.entries(value).filter(([id]) => Number(id) !== docId);
  return (
    <div className="page-picker">
      {docs.length > 1 && (
        <label className="page-picker-file">
          <span>File</span>
          <select className="input" value={docId ?? ''} onChange={(e) => { setDocId(Number(e.target.value)); last.current = null; }}>
            {docs.map((d) => <option key={d.id} value={d.id}>{d.filename}{value[d.id] ? ` (${value[d.id].length} chosen)` : ''}</option>)}
          </select>
        </label>
      )}
      {error && <div className="banner banner-bad">{error}</div>}
      {info && (
        <>
          <div className="page-picker-bar">
            <input ref={box} className="input page-picker-range" value={text} onBlur={() => setText(formatRanges([...chosen]))} placeholder={`e.g. 3-7, 12 (${noun(kind, 2)} 1-${info.units.length ? info.units[info.units.length - 1].idx : 0})`}
              aria-label={`Which ${noun(kind, 2)}`}
              onChange={(e) => { setText(e.target.value); set(parseRanges(e.target.value, valid).picked); }} />
            <span className="page-picker-count">{chosen.size ? `${chosen.size} of ${info.units.length} ${noun(kind, info.units.length)}` : `All ${info.units.length} ${noun(kind, info.units.length)}`}</span>
            <button className="btn btn-sm" onClick={() => set(info.units.map((u) => u.idx))}>All</button>
            <button className="btn btn-sm" disabled={!chosen.size} onClick={() => set([])}>Clear</button>
          </div>
          {typed.unknown.length > 0 && <div className="muted small">{info.filename} has no {noun(kind, typed.unknown.length)} {formatRanges(typed.unknown)}.</div>}
          {chapters.length > 1 && (
            <div className="page-picker-chapters">
              <Icon name="chapters" size={14} />
              {chapters.map((c, i) => {
                const on = c.idxs.every((x) => chosen.has(x));
                return (
                  <button key={i} className={`make-idea${on ? ' on' : ''}`} title={`${noun(kind, 2)} ${formatRanges(c.idxs)}`}
                    onClick={() => set(on ? [...chosen].filter((x) => !c.idxs.includes(x)) : [...chosen, ...c.idxs])}>{c.title}</button>
                );
              })}
            </div>
          )}
          <div className={`page-picker-grid${info.pdf ? '' : ' labels'}`} role="listbox" aria-multiselectable>
            {info.units.map((u) => (
              <button key={u.idx} role="option" aria-selected={chosen.has(u.idx)}
                className={`page-picker-unit${chosen.has(u.idx) ? ' on' : ''}${u.empty ? ' empty' : ''}`}
                title={`${u.label}${u.duplicate_label ? ` (same as ${u.duplicate_label})` : ''}${u.empty ? ' (nothing to read yet)' : ''}`}
                onClick={(e) => click(u.idx, e.shiftKey)}>
                {info.pdf && u.page ? <img src={api.thumbUrl(info.id, u.page, 120)} alt="" loading="lazy" draggable={false} />
                  : info.pdf ? <span className="page-picker-blank" /> : null}
                <span className="page-picker-label">{info.pdf ? u.idx : u.label}</span>
                {chosen.has(u.idx) && <span className="page-picker-check"><Icon name="check" size={11} strokeWidth={3} /></span>}
              </button>
            ))}
          </div>
          <div className="muted small">Click to choose, Shift-click for a range. With nothing chosen, all the material is used;
            once you choose, only the chosen {noun(kind, 2)} are.</div>
        </>
      )}
      {picks.length > 0 && (
        <div className="page-picker-others small">
          Also chosen: {picks.map(([id, idxs]) => `${docs.find((d) => d.id === Number(id))?.filename ?? 'a file'} (${formatRanges(idxs)})`).join('; ')}
          <button className="link-btn" onClick={() => onChange(docId !== null && value[docId] ? { [docId]: value[docId] } : {})}>Clear the others</button>
        </div>
      )}
    </div>
  );
}
