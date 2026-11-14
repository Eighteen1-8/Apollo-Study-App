/* The student's own mind map / flowchart: boxes and labelled arrows on a free canvas (SVG, pan and zoom), saved as
   they change (user_notes.data, see mapModel.ts). Like the student's notes it is never ingested; "Check with Apollo"
   reads it as text (boxes, then links "A → B (label)") and lists wrong boxes or links in the Comments panel, and
   clicking an issue shows the box or link it quotes. Apollo never rewrites a map.

   Mouse: double-click the canvas for a new box, double-click a box or link to write on it, drag a box's handle onto
   another box to link them (or onto empty canvas for a new linked box), drag the background to pan, Shift-drag for a
   selection box, wheel to zoom. Keys while the canvas has the focus: Delete, Enter (edit), Tab (new linked box),
   Ctrl+Z / Ctrl+Y, Ctrl+D (duplicate), Ctrl+A, arrows (nudge), Escape. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Quote, ReviewIssue, Subject } from '../../api';
import { useOverlay } from '../../components/overlay';
import { exportAs } from '../../components/exportDoc';
import { savePng, svgToPng } from '../../components/ink';
import Icon, { IconName } from '../../components/Icon';
import { toggleCalculator, useCalculatorOpen } from '../../components/Calculator';
import { TourButton, useFirstTime } from '../../components/Tour';
import { History } from './history';
import {
  addChild, addNode, bounds, connect, duplicate, edgeMid, findQuoted, MAP_COLORS, MapData, mapSvg, moveNodes, nodeSize,
  nodesIn, normalizeMap, removeItems, Shape, SHAPES, tidy, updateEdge, updateNode, updateNodes, wrapText,
} from './mapModel';
import { NoteComments, NoteHead, useNoteDoc, useNoteReviews } from './useNoteDoc';

type View = { tx: number; ty: number; k: number };
type Sel = { nodes: Set<string>; edges: Set<string> };
const EMPTY: Sel = { nodes: new Set(), edges: new Set() };
const SHAPE_ICON: Record<Shape, IconName> = { box: 'shapeBox', rounded: 'shapeRounded', diamond: 'shapeDiamond', circle: 'shapeCircle' };
const SHAPE_NAME: Record<Shape, string> = { box: 'Box', rounded: 'Rounded box', diamond: 'Diamond (a decision)', circle: 'Circle' };
const LINE_H = 19;

export default function MapEditor({ id, subject, onClose }: {
  id: number; subject: Subject; onClose: () => void; onAsk?: (q: Quote) => void;
}) {
  const ov = useOverlay();
  const doc = useNoteDoc<MapData>(id, normalizeMap);
  const comments = useNoteReviews(id);
  const calcOpen = useCalculatorOpen();
  useFirstTime('map', !!doc.data);
  const d = doc.data ?? { nodes: [], edges: [] };
  const hist = useRef(new History<MapData>());
  const [, bump] = useState(0); // re-render when undo / redo availability changes
  const [sel, setSel] = useState<Sel>(EMPTY);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, k: 1 });
  const [editing, setEditing] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [shape, setShape] = useState<Shape>('rounded');
  const [flash, setFlash] = useState<Sel | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fitted = useRef(false);

  /** Apply a change: remembered for undo, shown, saved. */
  const commit = useCallback((next: MapData) => {
    const cur = doc.dataRef.current;
    if (!cur || next === cur) return;
    hist.current.push(cur);
    doc.setData(next);
    bump((n) => n + 1);
  }, [doc]);
  const undo = () => { const p = hist.current.undo(doc.dataRef.current!); if (p) { doc.setData(p); setSel(EMPTY); bump((n) => n + 1); } };
  const redo = () => { const p = hist.current.redo(doc.dataRef.current!); if (p) { doc.setData(p); setSel(EMPTY); bump((n) => n + 1); } };

  // ---- coordinates
  const toWorld = useCallback((cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
  }, [view]);
  const fit = useCallback((data = doc.dataRef.current) => {
    const el = canvas.current;
    const b = data && bounds(data, 40);
    if (!el) return;
    if (!b) { setView({ tx: el.clientWidth / 2, ty: el.clientHeight / 2, k: 1 }); return; }
    const k = Math.max(0.2, Math.min(1.5, el.clientWidth / b.w, el.clientHeight / b.h));
    setView({ k, tx: (el.clientWidth - b.w * k) / 2 - b.x * k, ty: (el.clientHeight - b.h * k) / 2 - b.y * k });
  }, [doc.dataRef]);
  useLayoutEffect(() => { if (doc.data && !fitted.current) { fitted.current = true; fit(doc.data); } }, [doc.data, fit]);
  const zoomBy = (f: number, cx?: number, cy?: number) => {
    const el = canvas.current!;
    const r = el.getBoundingClientRect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    setView((v) => {
      const k = Math.max(0.15, Math.min(4, v.k * f));
      const wx = (px - r.left - v.tx) / v.k, wy = (py - r.top - v.ty) / v.k;
      return { k, tx: px - r.left - wx * k, ty: py - r.top - wy * k };
    });
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); };
    el.addEventListener('wheel', wheel, { passive: false }); // React's onWheel is passive: it can't stop the page scrolling
    return () => el.removeEventListener('wheel', wheel);
  });

  // ---- pointer gestures
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    canvas.current?.focus();
    const start = { x: e.clientX, y: e.clientY };
    if (e.shiftKey && e.button === 0) {
      const w = toWorld(e.clientX, e.clientY);
      setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
      const move = (ev: PointerEvent) => { const p = toWorld(ev.clientX, ev.clientY); setMarquee((m) => m && { ...m, x1: p.x, y1: p.y }); };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        const p = toWorld(ev.clientX, ev.clientY);
        const r = { x: Math.min(w.x, p.x), y: Math.min(w.y, p.y), w: Math.abs(p.x - w.x), h: Math.abs(p.y - w.y) };
        setMarquee(null);
        const hit = nodesIn(doc.dataRef.current!, r);
        setSel((s) => ({ nodes: new Set([...s.nodes, ...hit]), edges: s.edges }));
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    // drag to pan; a click without moving clears the selection
    const v0 = view;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) moved = true;
      setView({ ...v0, tx: v0.tx + ev.clientX - start.x, ty: v0.ty + ev.clientY - start.y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) setSel(EMPTY);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const onNodeDown = (e: React.PointerEvent, nid: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    canvas.current?.focus();
    let ids: Set<string>;
    if (e.shiftKey) {
      const n = new Set(sel.nodes);
      if (n.has(nid)) n.delete(nid); else n.add(nid);
      setSel({ nodes: n, edges: sel.edges });
      return;
    }
    if (sel.nodes.has(nid)) ids = sel.nodes;
    else { ids = new Set([nid]); setSel({ nodes: ids, edges: new Set() }); }
    const start = { x: e.clientX, y: e.clientY };
    const k = view.k;
    let last = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => { last = { dx: (ev.clientX - start.x) / k, dy: (ev.clientY - start.y) / k }; setDrag(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.hypot(last.dx, last.dy) > 2 / k) commit(moveNodes(doc.dataRef.current!, ids, last.dx, last.dy));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const onHandleDown = (e: React.PointerEvent, from: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p0 = toWorld(e.clientX, e.clientY);
    setLink({ from, ...p0 });
    const move = (ev: PointerEvent) => { const p = toWorld(ev.clientX, ev.clientY); setLink({ from, ...p }); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setLink(null);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest('[data-node]')?.getAttribute('data-node');
      const cur = doc.dataRef.current!;
      if (target && target !== from) {
        const [next, edge] = connect(cur, from, target);
        if (edge) { commit(next); setSel({ nodes: new Set(), edges: new Set([edge.id]) }); }
        return;
      }
      if (target) return;
      const p = toWorld(ev.clientX, ev.clientY);
      const src = cur.nodes.find((n) => n.id === from);
      if (!src || Math.hypot(p.x - src.x, p.y - src.y) < nodeSize(src).w / 2 + 20) return;
      // let go on empty canvas: a new box there, linked from this one
      const [d1, n] = addNode(cur, p, { shape: src.shape, color: src.color });
      const [d2] = connect(d1, from, n.id);
      commit(d2);
      setSel({ nodes: new Set([n.id]), edges: new Set() });
      setEditing({ kind: 'node', id: n.id });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const onEdgeDown = (e: React.PointerEvent, eid: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    canvas.current?.focus();
    if (e.shiftKey) {
      const s = new Set(sel.edges);
      if (s.has(eid)) s.delete(eid); else s.add(eid);
      setSel({ nodes: sel.nodes, edges: s });
    } else setSel({ nodes: new Set(), edges: new Set([eid]) });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const t = e.target as Element;
    const nid = t.closest('[data-node]')?.getAttribute('data-node');
    const eid = t.closest('[data-edge]')?.getAttribute('data-edge');
    if (nid) { setEditing({ kind: 'node', id: nid }); return; }
    if (eid) { setEditing({ kind: 'edge', id: eid }); return; }
    const p = toWorld(e.clientX, e.clientY);
    const [next, n] = addNode(doc.dataRef.current!, p, { shape });
    commit(next);
    setSel({ nodes: new Set([n.id]), edges: new Set() });
    setEditing({ kind: 'node', id: n.id });
  };

  // ---- commands
  const one = sel.nodes.size === 1 && !sel.edges.size ? [...sel.nodes][0] : null;
  const removeSelected = () => {
    if (!sel.nodes.size && !sel.edges.size) return;
    commit(removeItems(doc.dataRef.current!, sel.nodes, sel.edges));
    setSel(EMPTY);
  };
  const duplicateSelected = () => {
    if (!sel.nodes.size) return;
    const [next, ids] = duplicate(doc.dataRef.current!, sel.nodes);
    commit(next);
    setSel({ nodes: new Set(ids), edges: new Set() });
  };
  const addLinked = (from: string) => {
    const [next, n] = addChild(doc.dataRef.current!, from);
    if (!n) return;
    commit(next);
    setSel({ nodes: new Set([n.id]), edges: new Set() });
    setEditing({ kind: 'node', id: n.id });
  };
  const addBox = () => {
    const el = canvas.current!;
    const r = el.getBoundingClientRect();
    const p = toWorld(r.left + r.width / 2 + (Math.random() - 0.5) * 60, r.top + r.height / 2 + (Math.random() - 0.5) * 60);
    const [next, n] = addNode(doc.dataRef.current!, p, { shape });
    commit(next);
    setSel({ nodes: new Set([n.id]), edges: new Set() });
    setEditing({ kind: 'node', id: n.id });
  };
  const pickShape = (s: Shape) => {
    setShape(s);
    if (sel.nodes.size) commit(updateNodes(doc.dataRef.current!, sel.nodes, { shape: s }));
  };
  const pickColor = (c: string) => { if (sel.nodes.size) commit(updateNodes(doc.dataRef.current!, sel.nodes, { color: c })); };
  const colourMenu = (e: React.MouseEvent) => ov.menu(e, [{
    label: sel.nodes.size ? 'Box colour' : 'Select boxes to colour them',
    swatches: MAP_COLORS.map(([c, l]) => (c
      ? { color: c, label: l, onClick: () => pickColor(c) }
      : { color: '', label: 'Default', kind: 'none' as const, onClick: () => pickColor('') })),
  }], { anchor: e.currentTarget, place: 'below' });
  const doTidy = () => { const next = tidy(doc.dataRef.current!); commit(next); requestAnimationFrame(() => fit(next)); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let done = true;
    if (ctrl && k === 'z' && !e.shiftKey) undo();
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
    else if (ctrl && k === 'd') duplicateSelected();
    else if (ctrl && k === 'a') setSel({ nodes: new Set(d.nodes.map((n) => n.id)), edges: new Set(d.edges.map((x) => x.id)) });
    else if (ctrl && k === 's') doc.save();
    else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
    else if (e.key === 'Enter' && one) setEditing({ kind: 'node', id: one });
    else if (e.key === 'Enter' && sel.edges.size === 1 && !sel.nodes.size) setEditing({ kind: 'edge', id: [...sel.edges][0] });
    else if (e.key === 'Tab' && one) addLinked(one);
    else if (e.key === 'Escape') setSel(EMPTY);
    else if (e.key.startsWith('Arrow') && sel.nodes.size) {
      const step = e.shiftKey ? 20 : 4;
      commit(moveNodes(doc.dataRef.current!, sel.nodes, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); } // the app's own Ctrl+Z (src/undo.ts) is for everything else
  };

  // ---- Apollo
  const check = async () => {
    await doc.save();
    if (!(doc.dataRef.current?.nodes.length)) {
      await ov.confirm({ title: 'Nothing to check yet', body: 'Add some boxes first (double-click the canvas).', confirmText: 'OK' });
      return;
    }
    try {
      await api.startReview({ target: 'note', target_id: id, mode: 'check' });
      comments.setShow(true);
      comments.reviews.reload();
    } catch (err) {
      ov.confirm({ title: "Couldn't start the check", body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });
    }
  };
  const showIssue = (issue: ReviewIssue) => {
    const cur = doc.dataRef.current!;
    const hit = findQuoted(cur, issue.quote);
    const s = { nodes: new Set(hit.nodes), edges: new Set(hit.edges) };
    if (!hit.nodes.length && !hit.edges.length) return;
    setSel(s);
    setFlash(s);
    setTimeout(() => setFlash(null), 1600);
    // bring it into view
    const ids = new Set([...hit.nodes, ...hit.edges.flatMap((eid) => { const x = cur.edges.find((e) => e.id === eid); return x ? [x.from, x.to] : []; })]);
    const b = bounds({ nodes: cur.nodes.filter((n) => ids.has(n.id)), edges: [] }, 60);
    const el = canvas.current;
    if (b && el) {
      const k = Math.min(view.k, el.clientWidth / b.w, el.clientHeight / b.h);
      setView({ k, tx: el.clientWidth / 2 - (b.x + b.w / 2) * k, ty: el.clientHeight / 2 - (b.y + b.h / 2) * k });
    }
  };

  // ---- export
  const png = async () => { const m = mapSvg(doc.dataRef.current!); return svgToPng(m.svg, m.w, m.h); };
  const exportMenu = (e: React.MouseEvent) => ov.menu(e, [
    { label: 'Picture (.png)', onClick: async () => { try { await savePng(await png(), doc.title || 'Mind map'); } catch (err) { failed(err); } } },
    ...(['docx', 'pdf'] as const).map((f) => ({
      label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
      onClick: async () => {
        await doc.save();
        try {
          const img = await png();
          await exportAs(f, doc.title || 'Mind map', () => `<p><img src="${img}" alt="" style="max-width:100%"></p>`);
        } catch (err) { failed(err); }
      },
    })),
  ], { anchor: e.currentTarget, place: 'below' });
  const failed = (err: unknown) => ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' });

  // ---- what's drawn: the dragged boxes follow the pointer
  const shown = useMemo(() => (drag && sel.nodes.size ? moveNodes(d, sel.nodes, drag.dx, drag.dy) : d), [d, drag, sel.nodes]);
  const nodeById = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown]);
  const lit = (kind: 'nodes' | 'edges', x: string) => (flash?.[kind].has(x) ? ' flash' : '') + (sel[kind].has(x) ? ' selected' : '');
  const editNode = editing?.kind === 'node' ? nodeById.get(editing.id) : null;
  const editEdge = editing?.kind === 'edge' ? shown.edges.find((x) => x.id === editing.id) : null;
  const editMid = editEdge ? edgeMid(shown, editEdge) : null;

  const tb = (icon: IconName, tip: string, onClick: () => void, on?: boolean, disabled?: boolean, cls = '') => (
    <button className={`ne-btn${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`} data-tip={tip} aria-label={tip} aria-pressed={on} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}><Icon name={icon} size={15} /></button>
  );

  return (
    <div className={`source note-editor map-editor${comments.show ? ' with-reviews' : ''}`}>
      <NoteHead doc={doc} subject={subject} placeholder="Untitled mind map" fallbackTitle="Untitled mind map"
        comments={{ show: comments.show, count: comments.count, toggle: () => comments.setShow(!comments.show) }} onClose={onClose}
        extra={<>
          <button className="btn btn-sm map-check" data-tip="Have Apollo check the boxes and links against your material" onClick={check}>Check with Apollo</button>
          <button className="btn btn-sm map-export" onClick={exportMenu}>Export <Icon name="chevronDown" size={14} /></button>
          <TourButton id="map" />
        </>} />
      <div className="ne-toolbar map-toolbar" role="toolbar" aria-label="Mind map tools">
        <div className="ne-group">
          {tb('add', 'New box (or double-click the canvas)', addBox)}
          {tb('next', 'New linked box (Tab)', () => one && addLinked(one), false, !one)}
        </div>
        <div className="ne-group ne-seg" role="group" aria-label="Shape">
          {SHAPES.map((s) => <span key={s}>{tb(SHAPE_ICON[s], SHAPE_NAME[s], () => pickShape(s), shape === s)}</span>)}
        </div>
        <div className="ne-group">
          <button className="ne-btn map-colour" data-tip="Box colour" aria-label="Box colour" onMouseDown={(e) => e.preventDefault()} onClick={colourMenu}>
            <span className="ne-swatch map-swatch" style={{ background: (one && nodeById.get(one)?.color) || 'var(--map-node-bg)' }} />
            <Icon name="chevronDown" size={12} />
          </button>
          {tb('copy', 'Duplicate (Ctrl+D)', duplicateSelected, false, !sel.nodes.size)}
          {tb('trash', 'Delete (Delete)', removeSelected, false, !sel.nodes.size && !sel.edges.size)}
        </div>
        <div className="ne-group">
          {tb('tidy', 'Tidy the layout', doTidy, false, !d.nodes.length)}
          {tb('zoomOut', 'Zoom out', () => zoomBy(1 / 1.25))}
          <span className="map-zoom muted small">{Math.round(view.k * 100)}%</span>
          {tb('zoomIn', 'Zoom in', () => zoomBy(1.25))}
          {tb('fit', 'Show the whole map', () => fit())}
        </div>
        <div className="ne-group">
          <button className={`ne-btn tool-calc${calcOpen ? ' on' : ''}`} data-tip={calcOpen ? 'Close the calculator' : 'Calculator and graphs'}
            aria-label="Calculator" aria-pressed={calcOpen} onMouseDown={(e) => e.preventDefault()} onClick={toggleCalculator}>
            <Icon name="calculator" size={16} />
          </button>
        </div>
        <span className="ne-fill" />
        <div className="ne-group">
          {tb('undo', 'Undo (Ctrl+Z)', undo, false, !hist.current.canUndo)}
          {tb('redo', 'Redo (Ctrl+Y)', redo, false, !hist.current.canRedo)}
        </div>
      </div>
      <div className="ne-body">
        <div ref={canvas} className="map-canvas" tabIndex={0} data-find="this mind map" aria-label="Mind map canvas"
          onPointerDown={onBackgroundDown} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>
          <svg ref={svgRef} className="map-svg" width="100%" height="100%">
            <defs>
              <pattern id={`map-dots-${id}`} width={24 * view.k} height={24 * view.k} patternUnits="userSpaceOnUse"
                x={view.tx % (24 * view.k)} y={view.ty % (24 * view.k)}>
                <circle cx={1} cy={1} r={1} className="map-dot" />
              </pattern>
              <marker id={`map-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="map-arrowhead" />
              </marker>
            </defs>
            <rect width="100%" height="100%" fill={`url(#map-dots-${id})`} />
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
              {shown.edges.map((e) => {
                const m = edgeMid(shown, e);
                if (!m) return null;
                const lw = Math.max(e.label.length * 6.6 + 12, 18);
                return (
                  <g key={e.id} className={`map-edge${lit('edges', e.id)}`} data-edge={e.id} onPointerDown={(ev) => onEdgeDown(ev, e.id)}>
                    <line className="map-edge-hit" x1={m.ends.a.x} y1={m.ends.a.y} x2={m.ends.b.x} y2={m.ends.b.y} />
                    <line className="map-edge-line" x1={m.ends.a.x} y1={m.ends.a.y} x2={m.ends.b.x} y2={m.ends.b.y} markerEnd={`url(#map-arrow-${id})`} />
                    {e.label && editEdge?.id !== e.id && (
                      <g transform={`translate(${m.x},${m.y})`}>
                        <rect className="map-edge-label-bg" x={-lw / 2} y={-10} width={lw} height={20} rx={4} />
                        <text className="map-edge-label" textAnchor="middle" y={4}>{e.label}</text>
                      </g>
                    )}
                  </g>
                );
              })}
              {link && (() => {
                const src = nodeById.get(link.from);
                return src ? <line className="map-edge-line map-linking" x1={src.x} y1={src.y} x2={link.x} y2={link.y} markerEnd={`url(#map-arrow-${id})`} /> : null;
              })()}
              {shown.nodes.map((n) => {
                const { w, h } = nodeSize(n);
                const lines = wrapText(n.text);
                const y0 = -((lines.length - 1) * LINE_H) / 2 + 5;
                return (
                  <g key={n.id} className={`map-node shape-${n.shape}${lit('nodes', n.id)}`} data-node={n.id} transform={`translate(${n.x},${n.y})`}
                    onPointerDown={(e) => onNodeDown(e, n.id)}>
                    <NodeShape shape={n.shape} w={w} h={h} color={n.color} />
                    {editNode?.id !== n.id && (
                      <text className={`map-node-text${n.text ? '' : ' empty'}`} textAnchor="middle">
                        {(n.text ? lines : ['Double-click to write']).map((l, i) => <tspan key={i} x={0} y={y0 + i * LINE_H}>{l}</tspan>)}
                      </text>
                    )}
                    <circle className="map-handle" cx={w / 2 + 2} cy={0} r={6} onPointerDown={(e) => onHandleDown(e, n.id)}>
                      <title>Drag onto another box to link them</title>
                    </circle>
                  </g>
                );
              })}
              {marquee && (
                <rect className="map-marquee" x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
                  width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)} />
              )}
            </g>
          </svg>
          {!d.nodes.length && doc.data && (
            <div className="map-empty muted">Double-click anywhere to add a box. Drag a box's dot onto another to link them.</div>
          )}
          {editNode && (() => {
            const { w, h } = nodeSize(editNode);
            return <LabelEditor key={editNode.id} initial={editNode.text} multiline
              style={{ left: view.tx + (editNode.x - w / 2) * view.k, top: view.ty + (editNode.y - h / 2) * view.k, width: w * view.k, height: h * view.k, fontSize: 14 * view.k }}
              onDone={(t) => { setEditing(null); if (t !== editNode.text) commit(updateNode(doc.dataRef.current!, editNode.id, { text: t })); canvas.current?.focus(); }} />;
          })()}
          {editEdge && editMid && (
            <LabelEditor key={editEdge.id} initial={editEdge.label} placeholder="Label"
              style={{ left: view.tx + editMid.x * view.k - 70, top: view.ty + editMid.y * view.k - 14, width: 140, height: 28, fontSize: 12 * Math.max(view.k, 0.8) }}
              onDone={(t) => { setEditing(null); if (t !== editEdge.label) commit(updateEdge(doc.dataRef.current!, editEdge.id, { label: t })); canvas.current?.focus(); }} />
          )}
        </div>
        <NoteComments id={id} r={comments} onIssue={showIssue}
          empty="Press Check with Apollo to have your boxes and links checked against your material. Click an issue to see the box or link it's about." />
      </div>
    </div>
  );
}

function NodeShape({ shape, w, h, color }: { shape: Shape; w: number; h: number; color: string }) {
  const style = color ? { fill: color } : undefined;
  if (shape === 'circle') return <ellipse className="map-shape" rx={w / 2} ry={h / 2} style={style} />;
  if (shape === 'diamond') return <polygon className="map-shape" points={`0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`} style={style} />;
  return <rect className="map-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={shape === 'rounded' ? 14 : 3} style={style} />;
}

/** Writing on a box or a link, over the canvas: Enter finishes (Shift+Enter: new line in a box), Escape cancels. */
function LabelEditor({ initial, style, onDone, multiline, placeholder }: {
  initial: string; style: React.CSSProperties; onDone: (text: string) => void; multiline?: boolean; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (t: string) => { if (done.current) return; done.current = true; onDone(t.trim()); };
  return (
    <textarea ref={ref} className={`map-label-edit${multiline ? '' : ' single'}`} defaultValue={initial} style={style} placeholder={placeholder ?? 'Type here'}
      spellCheck onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); finish(e.currentTarget.value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(initial); }
      }} />
  );
}
