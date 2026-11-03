/* Mind maps: the material's ideas as a tree growing right from its centre. Click a node to see its detail and
   source; its dot folds or unfolds its branch. Drag to pan, scroll to zoom. Each main branch keeps one colour. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MindNode } from '../../api';
import Markdown from '../../components/Markdown';

const ROW = 38;      // vertical space per leaf
const GAP_X = 64;    // between columns
const PAD = 40;
const NODE_H = 30;
const MAX_W = 230;
const PALETTE = ['#7c8cff', '#43d39e', '#f6c35b', '#ff7a7a', '#b49bff', '#4cc9f0', '#f78fb3', '#9ccc65', '#ffb74d', '#80cbc4'];

type Laid = { node: MindNode; path: string; depth: number; x: number; y: number; w: number; color: string; parent: Laid | null; folded: boolean; kids: number };

let canvas: CanvasRenderingContext2D | null = null;
function textWidth(s: string, bold: boolean) {
  canvas ??= document.createElement('canvas').getContext('2d');
  if (!canvas) return s.length * 7.4;
  canvas.font = `${bold ? 650 : 500} 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  return canvas.measureText(s).width;
}
const clipLabel = (s: string, bold: boolean) => {
  if (textWidth(s, bold) + 26 <= MAX_W) return s;
  let t = s;
  while (t.length > 4 && textWidth(`${t}…`, bold) + 26 > MAX_W) t = t.slice(0, -1);
  return `${t}…`;
};

function layout(root: MindNode, folded: Set<string>) {
  const nodes: Laid[] = [];
  const colW: number[] = [];
  let cursor = 0;
  const walk = (node: MindNode, path: string, depth: number, parent: Laid | null, color: string): Laid => {
    const label = clipLabel(node.label, depth <= 1);
    const me: Laid = { node: { ...node, label }, path, depth, x: 0, y: 0, w: Math.min(MAX_W, textWidth(label, depth <= 1) + 26), color, parent,
      folded: folded.has(path) && node.children.length > 0, kids: node.children.length };
    colW[depth] = Math.max(colW[depth] ?? 0, me.w);
    nodes.push(me);
    if (node.children.length && !me.folded) {
      const kids = node.children.map((c, i) => walk(c, `${path}.${i}`, depth + 1, me, depth === 0 ? PALETTE[i % PALETTE.length] : color));
      me.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    } else {
      me.y = cursor;
      cursor += ROW;
    }
    return me;
  };
  walk(root, '0', 0, null, 'var(--accent)');
  const colX: number[] = [];
  colW.forEach((w, d) => { colX[d] = d === 0 ? PAD : colX[d - 1] + colW[d - 1] + GAP_X; });
  for (const n of nodes) { n.x = colX[n.depth]; n.y += PAD; }
  const width = colX[colX.length - 1] + colW[colW.length - 1] + PAD;
  return { nodes, width, height: cursor - ROW + NODE_H + 2 * PAD };
}

/** Paths of every node from depth `d` down (to fold the map to its first levels). */
function pathsFrom(node: MindNode, path: string, depth: number, d: number, out: string[] = []) {
  if (depth >= d && node.children.length) out.push(path);
  node.children.forEach((c, i) => pathsFrom(c, `${path}.${i}`, depth + 1, d, out));
  return out;
}

export default function MindMap({ root, title, onAsk, onCite }: {
  root: MindNode; title: string; onAsk: (text: string, context: string) => void; onCite?: (file: string, label: string) => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set(pathsFrom(root, '0', 0, 3)));
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [picked, setPicked] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { nodes, width, height } = useMemo(() => layout(root, folded), [root, folded]);
  const sel = nodes.find((n) => n.path === picked) ?? null;
  const full = sel ? findFull(root, sel.path)?.label ?? sel.node.label : '';

  const fit = () => {
    const el = box.current;
    if (!el) return;
    const k = Math.min(1.2, Math.max(0.25, Math.min(el.clientWidth / width, el.clientHeight / height)));
    setView({ k, x: (el.clientWidth - width * k) / 2, y: Math.max(0, (el.clientHeight - height * k) / 2) });
  };
  useLayoutEffect(fit, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  // zoom around the pointer (a non-passive listener, so the page doesn't scroll as well)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const pan = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-mm], .mm-tools, .mm-detail')) return;
    const x0 = e.clientX - view.x;
    const y0 = e.clientY - view.y;
    const move = (ev: PointerEvent) => setView((v) => ({ ...v, x: ev.clientX - x0, y: ev.clientY - y0 }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    setPicked(null);
  };
  const toggle = (path: string) => setFolded((f) => { const n = new Set(f); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const zoom = (f: number) => {
    const el = box.current!;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => { const k = Math.min(2.5, Math.max(0.2, v.k * f)); return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }; });
  };
  const trail = (n: Laid) => { const out: string[] = []; for (let p: Laid | null = n; p; p = p.parent) out.unshift(p.node.label); return out.join(' › '); };

  return (
    <div ref={box} className="mindmap" onPointerDown={pan} aria-label={`Mind map: ${title}`}>
      <svg width="100%" height="100%">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {nodes.filter((n) => n.parent).map((n) => {
            const p = n.parent!;
            const x1 = p.x + p.w;
            const y1 = p.y + NODE_H / 2;
            const x2 = n.x;
            const y2 = n.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return <path key={`e${n.path}`} className="mm-edge" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} stroke={n.color} />;
          })}
          {nodes.map((n) => (
            <g key={n.path} data-mm={n.path} data-mm-label={n.node.label} data-mm-context={trail(n)} transform={`translate(${n.x},${n.y})`}
              className={`mm-node d${Math.min(n.depth, 3)}${picked === n.path ? ' picked' : ''}`} style={{ '--mm': n.color } as React.CSSProperties}
              onClick={() => setPicked(picked === n.path ? null : n.path)}>
              <rect width={n.w} height={NODE_H} rx={n.depth === 0 ? 15 : 8} />
              <text x={13} y={NODE_H / 2 + 4.5}>{n.node.label}</text>
              {n.node.note && <circle className="mm-has-note" cx={n.w - 7} cy={7} r={2.2} />}
              {n.kids > 0 && (
                <g className="mm-fold" transform={`translate(${n.w + 9},${NODE_H / 2})`}
                  onClick={(e) => { e.stopPropagation(); toggle(n.path); }}>
                  <circle r={7.5} />
                  <text y={4} textAnchor="middle">{n.folded ? n.kids : '−'}</text>
                </g>
              )}
            </g>
          ))}
        </g>
      </svg>
      <div className="mm-tools">
        <button className="ne-btn" data-tip="Zoom in" onClick={() => zoom(1.2)}>+</button>
        <button className="ne-btn" data-tip="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button>
        <button className="ne-btn" data-tip="Fit to the screen" onClick={fit}>⤢</button>
        <button className="ne-btn" data-tip="Unfold every branch" onClick={() => setFolded(new Set())}>Expand all</button>
        <button className="ne-btn" data-tip="Show only the main branches" onClick={() => setFolded(new Set(pathsFrom(root, '0', 0, 1)))}>Collapse</button>
      </div>
      {sel && (
        <div className="mm-detail" style={{ '--mm': sel.color } as React.CSSProperties}>
          <div className="mm-trail">{trail(sel)}</div>
          <div className="mm-label">{full}</div>
          {sel.node.note && <Markdown className="mm-note" text={sel.node.note} />}
          {sel.node.source && (
            <Markdown className="mm-src" text={/\[\[/.test(sel.node.source) ? sel.node.source : `[[${sel.node.source}]]`} onCite={onCite} />
          )}
          <div className="mm-actions">
            <button className="btn btn-sm" onClick={() => onAsk(`${full}${sel.node.note ? `: ${sel.node.note}` : ''}`, trail(sel))}>Ask Apollo about this</button>
            {sel.kids > 0 && <button className="btn btn-sm" onClick={() => toggle(sel.path)}>{sel.folded ? 'Unfold' : 'Fold'} branch</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The node at a path, with its full (unclipped) label. */
function findFull(root: MindNode, path: string): MindNode | null {
  let n: MindNode | undefined = root;
  for (const i of path.split('.').slice(1)) n = n?.children[Number(i)];
  return n ?? null;
}
