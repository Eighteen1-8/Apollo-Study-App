/* The student's mind maps / flowcharts as data, and every change to them as a pure function (MapEditor draws and
   edits; tests/unit/notesModel.test.ts checks these). Stored in user_notes.data as {nodes, edges}; positions are the
   centre of each box in canvas units. */

export type Shape = 'box' | 'rounded' | 'diamond' | 'circle';
export interface MapNode { id: string; x: number; y: number; text: string; shape: Shape; color: string }
export interface MapEdge { id: string; from: string; to: string; label: string }
export interface MapData { nodes: MapNode[]; edges: MapEdge[] }

export const SHAPES: Shape[] = ['box', 'rounded', 'diamond', 'circle'];
/** Box colours: '' is the theme's own; the rest are fills readable with dark text in any theme. */
export const MAP_COLORS: [string, string][] = [
  ['', 'Default'], ['#fde68a', 'Yellow'], ['#bbf7d0', 'Green'], ['#bfdbfe', 'Blue'], ['#ddd6fe', 'Purple'],
  ['#fbcfe8', 'Pink'], ['#fed7aa', 'Orange'], ['#e5e7eb', 'Grey'],
];

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Anything stored (or nothing) as a valid map: unknown shapes become boxes, links to missing boxes are dropped. */
export function normalizeMap(raw: unknown): MapData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<MapData>;
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).filter((n) => n && n.id != null).map((n) => ({
    id: String(n.id), x: Number(n.x) || 0, y: Number(n.y) || 0, text: String(n.text ?? ''),
    shape: SHAPES.includes(n.shape as Shape) ? n.shape as Shape : 'box', color: typeof n.color === 'string' ? n.color : '',
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(d.edges) ? d.edges : [])
    .filter((e) => e && ids.has(String(e.from)) && ids.has(String(e.to)) && e.from !== e.to)
    .map((e) => ({ id: String(e.id ?? newId('e')), from: String(e.from), to: String(e.to), label: String(e.label ?? '') }));
  return { nodes, edges };
}

// ---------------------------------------------------------------- sizes and geometry

const CHAR_W = 7.6; // px per character at the map's 14px font, roughly
const LINE_H = 19;
const MAX_W = 220;

/** How a box's text wraps: lines of at most MAX_W (words kept whole unless one is longer). */
export function wrapText(text: string, maxW = MAX_W): string[] {
  const out: string[] = [];
  for (const para of (text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length * CHAR_W <= maxW - 24 || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/** A box's width and height for its text and shape (diamonds and circles need more room around the words). */
export function nodeSize(n: Pick<MapNode, 'text' | 'shape'>): { w: number; h: number } {
  const lines = wrapText(n.text);
  const textW = Math.max(...lines.map((l) => l.length * CHAR_W), 40);
  let w = Math.min(Math.max(textW + 28, 90), MAX_W + 8);
  let h = Math.max(lines.length * LINE_H + 20, 42);
  if (n.shape === 'diamond') { w *= 1.45; h *= 1.6; }
  if (n.shape === 'circle') { const d = Math.max(w, h) * 1.08; w = d; h = d; }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Where the line from a box's centre towards (tx, ty) leaves the box's outline. */
export function borderPoint(n: MapNode, tx: number, ty: number): { x: number; y: number } {
  const { w, h } = nodeSize(n);
  const dx = tx - n.x, dy = ty - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  let t: number;
  if (n.shape === 'circle') t = (w / 2) / Math.hypot(dx, dy);
  else if (n.shape === 'diamond') t = 1 / (Math.abs(dx) / (w / 2) + Math.abs(dy) / (h / 2));
  else t = Math.min(dx ? (w / 2) / Math.abs(dx) : Infinity, dy ? (h / 2) / Math.abs(dy) : Infinity);
  return { x: n.x + dx * t, y: n.y + dy * t };
}

/** A link's end points on its boxes' outlines (null when a box is missing). */
export function edgeEnds(d: MapData, e: MapEdge) {
  const a = d.nodes.find((n) => n.id === e.from), b = d.nodes.find((n) => n.id === e.to);
  if (!a || !b) return null;
  return { a: borderPoint(a, b.x, b.y), b: borderPoint(b, a.x, a.y) };
}

export function bounds(d: MapData, pad = 0): { x: number; y: number; w: number; h: number } | null {
  if (!d.nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of d.nodes) {
    const { w, h } = nodeSize(n);
    x0 = Math.min(x0, n.x - w / 2); y0 = Math.min(y0, n.y - h / 2);
    x1 = Math.max(x1, n.x + w / 2); y1 = Math.max(y1, n.y + h / 2);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** The boxes inside (or touching) a rectangle, for a marquee selection. */
export function nodesIn(d: MapData, r: { x: number; y: number; w: number; h: number }): string[] {
  return d.nodes.filter((n) => {
    const { w, h } = nodeSize(n);
    return n.x + w / 2 >= r.x && n.x - w / 2 <= r.x + r.w && n.y + h / 2 >= r.y && n.y - h / 2 <= r.y + r.h;
  }).map((n) => n.id);
}

// ---------------------------------------------------------------- changes (each returns a new map)

export function addNode(d: MapData, at: { x: number; y: number }, patch: Partial<MapNode> = {}): [MapData, MapNode] {
  const n: MapNode = { id: newId('n'), x: Math.round(at.x), y: Math.round(at.y), text: '', shape: 'rounded', color: '', ...patch };
  return [{ ...d, nodes: [...d.nodes, n] }, n];
}

/** A link from one box to another (none to itself, and never two the same way between the same boxes). */
export function connect(d: MapData, from: string, to: string, label = ''): [MapData, MapEdge | null] {
  if (from === to || !d.nodes.some((n) => n.id === from) || !d.nodes.some((n) => n.id === to)) return [d, null];
  if (d.edges.some((e) => e.from === from && e.to === to)) return [d, null];
  const e: MapEdge = { id: newId('e'), from, to, label };
  return [{ ...d, edges: [...d.edges, e] }, e];
}

/** A new box linked from `fromId`, placed to its right below any boxes it already links to (Tab in the editor). */
export function addChild(d: MapData, fromId: string): [MapData, MapNode | null] {
  const p = d.nodes.find((n) => n.id === fromId);
  if (!p) return [d, null];
  const kids = d.edges.filter((e) => e.from === fromId).map((e) => d.nodes.find((n) => n.id === e.to)!).filter(Boolean);
  const x = p.x + nodeSize(p).w / 2 + 90 + 60;
  const y = kids.length ? Math.max(...kids.map((k) => k.y + nodeSize(k).h / 2)) + 50 : p.y;
  const [d1, n] = addNode(d, { x, y }, { shape: p.shape, color: p.color });
  const [d2] = connect(d1, fromId, n.id);
  return [d2, n];
}

export function updateNode(d: MapData, id: string, patch: Partial<MapNode>): MapData {
  return { ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch, id } : n)) };
}

export function updateNodes(d: MapData, ids: Iterable<string>, patch: Partial<Omit<MapNode, 'id'>>): MapData {
  const s = new Set(ids);
  return { ...d, nodes: d.nodes.map((n) => (s.has(n.id) ? { ...n, ...patch } : n)) };
}

export function updateEdge(d: MapData, id: string, patch: Partial<MapEdge>): MapData {
  return { ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, ...patch, id } : e)) };
}

export function moveNodes(d: MapData, ids: Iterable<string>, dx: number, dy: number): MapData {
  const s = new Set(ids);
  return { ...d, nodes: d.nodes.map((n) => (s.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) };
}

/** Remove boxes (with every link touching them) and links. */
export function removeItems(d: MapData, nodeIds: Iterable<string>, edgeIds: Iterable<string> = []): MapData {
  const ns = new Set(nodeIds), es = new Set(edgeIds);
  return {
    nodes: d.nodes.filter((n) => !ns.has(n.id)),
    edges: d.edges.filter((e) => !es.has(e.id) && !ns.has(e.from) && !ns.has(e.to)),
  };
}

/** Copies of boxes (and the links between them), offset; returns the copies' ids. */
export function duplicate(d: MapData, ids: Iterable<string>, offset = 30): [MapData, string[]] {
  const s = new Set(ids);
  const map = new Map<string, string>();
  const copies = d.nodes.filter((n) => s.has(n.id)).map((n) => {
    const id = newId('n');
    map.set(n.id, id);
    return { ...n, id, x: n.x + offset, y: n.y + offset };
  });
  const links = d.edges.filter((e) => map.has(e.from) && map.has(e.to))
    .map((e) => ({ ...e, id: newId('e'), from: map.get(e.from)!, to: map.get(e.to)! }));
  return [{ nodes: [...d.nodes, ...copies], edges: [...d.edges, ...links] }, copies.map((c) => c.id)];
}

/**
 * Lay the map out left to right: each box goes one column right of the deepest box linking to it (boxes nothing links
 * to start the columns; a cycle is broken where it's first met), and each column is stacked with its boxes in the
 * order of their parents, so related boxes stay level. Unlinked boxes go in a row underneath.
 */
export function tidy(d: MapData, gapX = 90, gapY = 36): MapData {
  if (!d.nodes.length) return d;
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(d.nodes.map((n) => [n.id, 0]));
  for (const e of d.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const linked = new Set(d.edges.flatMap((e) => [e.from, e.to]));
  // ranks by longest path from a root, through a DFS that ignores edges back into its own path (cycles)
  const rank = new Map<string, number>();
  const order: string[] = [];
  const onPath = new Set<string>();
  const visit = (id: string, r: number) => {
    if (onPath.has(id)) return;
    if ((rank.get(id) ?? -1) >= r) return;
    if (!rank.has(id)) order.push(id);
    rank.set(id, r);
    onPath.add(id);
    for (const k of out.get(id) ?? []) visit(k, r + 1);
    onPath.delete(id);
  };
  const byPos = [...d.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of byPos) if (linked.has(n.id) && !indeg.get(n.id)) visit(n.id, 0);
  for (const n of byPos) if (linked.has(n.id) && !rank.has(n.id)) visit(n.id, 0); // only in cycles
  const cols = new Map<number, string[]>();
  for (const id of order) cols.set(rank.get(id)!, [...(cols.get(rank.get(id)!) ?? []), id]);
  const node = new Map(d.nodes.map((n) => [n.id, n]));
  const pos = new Map<string, { x: number; y: number }>();
  const ranks = [...cols.keys()].sort((a, b) => a - b);
  // column widths, so a wide box doesn't overlap the next column
  let x = 0;
  const left = d.nodes.length ? Math.min(...d.nodes.map((n) => n.x)) : 0;
  const top = d.nodes.length ? Math.min(...d.nodes.map((n) => n.y)) : 0;
  let maxBottom = top;
  for (const r of ranks) {
    const ids = cols.get(r)!;
    // keep children in the order of their parents' positions
    const parentY = (id: string) => {
      const ps = d.edges.filter((e) => e.to === id && pos.has(e.from)).map((e) => pos.get(e.from)!.y);
      return ps.length ? Math.min(...ps) : 0;
    };
    if (r > 0) ids.sort((a, b) => parentY(a) - parentY(b));
    const width = Math.max(...ids.map((id) => nodeSize(node.get(id)!).w));
    let y = top;
    for (const id of ids) {
      const { h } = nodeSize(node.get(id)!);
      pos.set(id, { x: left + x + width / 2, y: y + h / 2 });
      y += h + gapY;
    }
    maxBottom = Math.max(maxBottom, y);
    x += width + gapX;
  }
  // unlinked boxes: a row underneath
  let rx = left;
  const rowY = maxBottom + (pos.size ? gapY : 0);
  const loose = byPos.filter((n) => !linked.has(n.id));
  const rowH = loose.length ? Math.max(...loose.map((n) => nodeSize(n).h)) : 0;
  for (const n of loose) {
    const { w } = nodeSize(n);
    pos.set(n.id, { x: rx + w / 2, y: rowY + rowH / 2 });
    rx += w + 30;
  }
  return { ...d, nodes: d.nodes.map((n) => { const p = pos.get(n.id)!; return { ...n, x: Math.round(p.x), y: Math.round(p.y) }; }) };
}

// ---------------------------------------------------------------- Check with Apollo

const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

/**
 * The boxes and links an issue's quote points at: a link written "A → B" (or "A -> B", with or without its label),
 * else the boxes whose text matches the quote (exactly, then containing it, then contained in it).
 */
export function findQuoted(d: MapData, quote: string): { nodes: string[]; edges: string[] } {
  const q = norm(quote);
  if (!q) return { nodes: [], edges: [] };
  const name = (id: string) => norm(d.nodes.find((n) => n.id === id)?.text ?? '');
  const arrow = q.split(/\s*(?:→|->|=>|⟶)\s*/);
  if (arrow.length === 2) {
    const [a, rest] = arrow;
    const b = rest.replace(/\s*\(([^)]*)\)\s*$/, '');
    const hits = d.edges.filter((e) => name(e.from) === a && name(e.to) === b);
    const loose = hits.length ? hits : d.edges.filter((e) => (name(e.from).includes(a) || a.includes(name(e.from)))
      && (name(e.to).includes(b) || b.includes(name(e.to))) && name(e.from) && name(e.to));
    if (loose.length) return { nodes: [], edges: loose.map((e) => e.id) };
  }
  for (const test of [(t: string) => t === q, (t: string) => !!t && t.includes(q), (t: string) => !!t && q.includes(t) && t.length > 2]) {
    const nodes = d.nodes.filter((n) => test(norm(n.text))).map((n) => n.id);
    if (nodes.length) return { nodes, edges: [] };
  }
  const edges = d.edges.filter((e) => e.label && norm(e.label) === q).map((e) => e.id);
  return { nodes: [], edges };
}

// ---------------------------------------------------------------- pictures

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A box's outline as SVG markup, centred on (0, 0). */
export function shapeSvg(shape: Shape, w: number, h: number, attrs: string): string {
  if (shape === 'circle') return `<ellipse cx="0" cy="0" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`;
  if (shape === 'diamond') return `<polygon points="0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0" ${attrs}/>`;
  return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${shape === 'rounded' ? 14 : 3}" ${attrs}/>`;
}

/** The point halfway along a link and the angle of the line there (for its label). */
export function edgeMid(d: MapData, e: MapEdge) {
  const ends = edgeEnds(d, e);
  if (!ends) return null;
  return { x: (ends.a.x + ends.b.x) / 2, y: (ends.a.y + ends.b.y) / 2, ends };
}

/** The whole map as a standalone SVG on white, in light colours (export and Word/PDF). */
export function mapSvg(d: MapData, pad = 30): { svg: string; w: number; h: number } {
  const b = bounds(d, pad) ?? { x: 0, y: 0, w: 300, h: 160 };
  const parts: string[] = [];
  for (const e of d.edges) {
    const m = edgeMid(d, e);
    if (!m) continue;
    parts.push(`<line x1="${m.ends.a.x}" y1="${m.ends.a.y}" x2="${m.ends.b.x}" y2="${m.ends.b.y}" stroke="#64748b" stroke-width="1.6" marker-end="url(#arr)"/>`);
    if (e.label) {
      const w = e.label.length * 6.6 + 12;
      parts.push(`<rect x="${m.x - w / 2}" y="${m.y - 10}" width="${w}" height="20" rx="4" fill="#ffffff"/>`
        + `<text x="${m.x}" y="${m.y + 4}" text-anchor="middle" font-size="12" fill="#475569" font-family="Segoe UI, Arial, sans-serif">${esc(e.label)}</text>`);
    }
  }
  for (const n of d.nodes) {
    const { w, h } = nodeSize(n);
    const lines = wrapText(n.text);
    const y0 = -((lines.length - 1) * LINE_H) / 2 + 5;
    parts.push(`<g transform="translate(${n.x},${n.y})">${shapeSvg(n.shape, w, h, `fill="${n.color || '#f8fafc'}" stroke="#334155" stroke-width="1.4"`)}`
      + `<text text-anchor="middle" font-size="14" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif">`
      + lines.map((l, i) => `<tspan x="0" y="${y0 + i * LINE_H}">${esc(l)}</tspan>`).join('') + '</text></g>');
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.w)}" height="${Math.ceil(b.h)}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">`
    + '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    + '<path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker></defs>'
    + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffffff"/>${parts.join('')}</svg>`;
  return { svg, w: Math.ceil(b.w), h: Math.ceil(b.h) };
}
