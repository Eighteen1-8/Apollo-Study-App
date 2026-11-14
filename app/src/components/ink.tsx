/* Ink shared by the document viewer's pen (views/annotate.tsx) and the student's drawings (views/notes/DrawingEditor):
   stroke paths, hit-testing, the small drawing pad inside a viewer note, and the drawing editor's vector items with
   their geometry (pure functions, tested in tests/unit/notesModel.test.ts) and PNG rendering. */
import { useState, useRef } from 'react';
import { api, Stroke } from '../api';

// ---------------------------------------------------------------- the viewer's strokes (points as fractions of a box)

export const strokePath = (s: Stroke, w: number, h: number) => {
  const p = s.points;
  let d = `M${p[0] * w},${p[1] * h}`;
  for (let i = 2; i < p.length; i += 2) d += ` L${p[i] * w},${p[i + 1] * h}`;
  return d;
};

/** Whether (x, y) in px is within `tol` px of a stroke drawn in a w × h box. */
export function nearStroke(s: Stroke, x: number, y: number, w: number, h: number, tol: number) {
  const p = s.points;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distToSegment(x, y, p[i] * w, p[i + 1] * h, p[i + 2] * w, p[i + 3] * h) <= tol) return true;
  }
  return p.length === 2 && Math.hypot(p[0] * w - x, p[1] * h - y) <= tol;
}

export function distToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(ax + t * dx - x, ay + t * dy - y);
}

/** A small drawing area inside a viewer note; strokes are fractions of the pad. */
export function NotePad({ strokes, active, color, onChange, width }: {
  strokes: Stroke[]; active: boolean; color: string; onChange: (s: Stroke[]) => void; width: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const W = width;
  const H = 120;
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000];
  };
  return (
    <svg ref={ref} className={`note-pad${active ? ' active' : ''}`} width={W} height={H}
      onPointerDown={(e) => { if (!active) return; e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); setLive(at(e)); }}
      onPointerMove={(e) => live && setLive([...live, ...at(e)])}
      onPointerUp={() => { if (live && live.length >= 4) onChange([...strokes, { color, width: 2 / W, points: live }]); setLive(null); }}>
      {[...strokes, ...(live ? [{ color, width: 2 / W, points: live }] : [])].map((s, i) => (
        <path key={i} d={strokePath(s, W, H)} stroke={s.color} strokeWidth={Math.max(s.width * W, 1)} />
      ))}
      {active && strokes.length > 0 && (
        <text x={W - 6} y={H - 6} textAnchor="end" className="note-pad-clear" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onChange([])}>clear</text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- the student's drawings (canvas units, any size)

/** x, y and pen pressure (0..1; 0.5 when the pointer doesn't report it). */
export type InkPoint = [number, number, number];
export type Paper = 'plain' | 'grid' | 'lined';
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';
type FreeItem<K> = { id: string; type: K; color: string; width: number; points: InkPoint[] };
type ShapeItem<K> = { id: string; type: K; color: string; width: number; x1: number; y1: number; x2: number; y2: number };
// one member per type, so a check on `type` narrows
export type DrawItem = FreeItem<'pen'> | FreeItem<'highlighter'>
  | ShapeItem<'line'> | ShapeItem<'arrow'> | ShapeItem<'rect'> | ShapeItem<'ellipse'>
  | { id: string; type: 'text'; color: string; size: number; x: number; y: number; text: string };
export type ShapeDrawItem = Extract<DrawItem, { x1: number }>;
export interface DrawingData { items: DrawItem[]; paper: Paper; description: string }
export type Box = { x: number; y: number; w: number; h: number };

export const INK_PALETTE = ['#1b1d22', '#e5484d', '#f97316', '#eab308', '#16a34a', '#2463eb', '#8b5cf6', '#ec4899', '#ffffff'];
export const WIDTHS = [2, 4, 8, 14];

export function normalizeDrawing(raw: unknown): DrawingData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<DrawingData>;
  const items = (Array.isArray(d.items) ? d.items : []).filter((it) => it && typeof it === 'object' && typeof it.type === 'string'
    && (it.type === 'text' ? typeof (it as { text?: unknown }).text === 'string'
      : it.type === 'pen' || it.type === 'highlighter' ? Array.isArray((it as { points?: unknown }).points) : true));
  return { items, paper: d.paper === 'grid' || d.paper === 'lined' ? d.paper : 'plain', description: typeof d.description === 'string' ? d.description : '' };
}

/** Moving-average smoothing of a freehand stroke (the ends stay where they were). */
export function smooth(points: InkPoint[], radius = 2): InkPoint[] {
  if (points.length < 3 || radius < 1) return points;
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    const lo = Math.max(0, i - radius), hi = Math.min(points.length - 1, i + radius);
    let x = 0, y = 0, n = 0;
    for (let j = lo; j <= hi; j++) { x += points[j][0]; y += points[j][1]; n++; }
    return [Math.round((x / n) * 10) / 10, Math.round((y / n) * 10) / 10, p[2]];
  });
}

/** Drop points closer than `min` to the last one kept (a pen reports hundreds per second). */
export function thin(points: InkPoint[], min = 0.8): InkPoint[] {
  const out: InkPoint[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p);
  }
  const last = points[points.length - 1];
  if (last && out[out.length - 1] !== last && out.length > 1) out[out.length - 1] = last;
  return out;
}

/** A smooth centre line through the points (quadratic curves through the midpoints). */
export function centerPath(pts: InkPoint[]): string {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0][0]},${pts[0][1]}` + pts.slice(1).map((p) => ` L${p[0]},${p[1]}`).join('') + (pts.length === 1 ? ' l0.01,0' : '');
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]},${pts[i][1]} ${r1(mx)},${r1(my)}`;
  }
  const l = pts[pts.length - 1];
  return `${d} L${l[0]},${l[1]}`;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Whether a stroke's pressure varies enough to be worth drawing as a filled outline. */
export const hasPressure = (pts: InkPoint[]) => pts.some((p) => Math.abs(p[2] - pts[0][2]) > 0.05);

/**
 * A pressure-sensitive pen stroke as a filled outline: each point pushed out to both sides by half its width
 * (width × (0.35 + pressure)), forward along one side and back along the other, with round ends.
 */
export function outlinePath(pts: InkPoint[], width: number): string {
  if (pts.length < 2) return '';
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const half = (width * (0.35 + pts[i][2])) / 2;
    left.push([pts[i][0] + nx * half, pts[i][1] + ny * half]);
    right.push([pts[i][0] - nx * half, pts[i][1] - ny * half]);
  }
  const f = (p: [number, number]) => `${r1(p[0])},${r1(p[1])}`;
  const endR = (width * (0.35 + pts[pts.length - 1][2])) / 2, startR = (width * (0.35 + pts[0][2])) / 2;
  return `M${f(left[0])} ${left.slice(1).map((p) => `L${f(p)}`).join(' ')} A${r1(endR)},${r1(endR)} 0 0 1 ${f(right[right.length - 1])} `
    + `${right.slice(0, -1).reverse().map((p) => `L${f(p)}`).join(' ')} A${r1(startR)},${r1(startR)} 0 0 1 ${f(left[0])} Z`;
}

/** The two short strokes of an arrowhead at (x2, y2). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = (t: number) => `${r1(x2 - size * Math.cos(a + t))},${r1(y2 - size * Math.sin(a + t))}`;
  return `M${p(0.45)} L${r1(x2)},${r1(y2)} L${p(-0.45)}`;
}

const TEXT_CHAR = 0.56; // a character's width as a fraction of the font size, roughly
export const textLines = (t: string) => (t || ' ').split('\n');

export function itemBounds(it: DrawItem): Box {
  if (it.type === 'pen' || it.type === 'highlighter') {
    const xs = it.points.map((p) => p[0]), ys = it.points.map((p) => p[1]);
    const pad = it.width / 2;
    const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
  }
  if (it.type === 'text') {
    const lines = textLines(it.text);
    return { x: it.x, y: it.y, w: Math.max(...lines.map((l) => l.length), 1) * it.size * TEXT_CHAR, h: lines.length * it.size * 1.25 };
  }
  const x = Math.min(it.x1, it.x2), y = Math.min(it.y1, it.y2);
  return { x, y, w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
}

export function unionBounds(items: DrawItem[]): Box | null {
  if (!items.length) return null;
  const bs = items.map(itemBounds);
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

/** Whether (x, y) touches an item, within `tol` (for the eraser and clicking to select). */
export function hitItem(it: DrawItem, x: number, y: number, tol: number): boolean {
  if (it.type === 'pen' || it.type === 'highlighter') {
    const t = tol + it.width / 2;
    const p = it.points;
    if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= t;
    for (let i = 0; i + 1 < p.length; i++) if (distToSegment(x, y, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= t) return true;
    return false;
  }
  if (it.type === 'text') {
    const b = itemBounds(it);
    return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
  }
  const t = tol + it.width / 2;
  if (it.type === 'line' || it.type === 'arrow') return distToSegment(x, y, it.x1, it.y1, it.x2, it.y2) <= t;
  const b = itemBounds(it);
  if (it.type === 'rect') {
    const inside = (m: number) => x >= b.x + m && x <= b.x + b.w - m && y >= b.y + m && y <= b.y + b.h - m;
    return inside(-t) && !inside(t);
  }
  // ellipse: near its outline
  const rx = b.w / 2, ry = b.h / 2, cx = b.x + rx, cy = b.y + ry;
  if (rx < 1 || ry < 1) return distToSegment(x, y, b.x, b.y, b.x + b.w, b.y + b.h) <= t;
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return Math.abs(k - 1) * Math.min(rx, ry) <= t;
}

/** Whether an item lies wholly inside a box (marquee selection). */
export function itemInBox(it: DrawItem, b: Box): boolean {
  const ib = itemBounds(it);
  return ib.x >= b.x && ib.y >= b.y && ib.x + ib.w <= b.x + b.w && ib.y + ib.h <= b.y + b.h;
}

export function translateItem<T extends DrawItem>(it: T, dx: number, dy: number): T {
  if (it.type === 'pen' || it.type === 'highlighter') return { ...it, points: it.points.map(([x, y, p]) => [r1(x + dx), r1(y + dy), p]) };
  if (it.type === 'text') return { ...it, x: r1(it.x + dx), y: r1(it.y + dy) };
  return { ...it, x1: r1(it.x1 + dx), y1: r1(it.y1 + dy), x2: r1(it.x2 + dx), y2: r1(it.y2 + dy) } as T;
}

/** An item mapped from one box onto another (resizing a selection); text scales its font with the height. */
export function scaleItem<T extends DrawItem>(it: T, from: Box, to: Box): T {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const X = (x: number) => r1(to.x + (x - from.x) * sx), Y = (y: number) => r1(to.y + (y - from.y) * sy);
  if (it.type === 'pen' || it.type === 'highlighter') return { ...it, points: it.points.map(([x, y, p]) => [X(x), Y(y), p]) };
  if (it.type === 'text') return { ...it, x: X(it.x), y: Y(it.y), size: Math.max(6, Math.round(it.size * Math.abs(sy) * 10) / 10) };
  return { ...it, x1: X(it.x1), y1: Y(it.y1), x2: X(it.x2), y2: Y(it.y2) } as T;
}

// ---------------------------------------------------------------- pictures

const escXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** One drawing item as SVG markup (used both on screen, through React, and for the PNG). */
export function itemSvg(it: DrawItem): string {
  if (it.type === 'pen') {
    return hasPressure(it.points)
      ? `<path d="${outlinePath(it.points, it.width)}" fill="${it.color}" stroke="none"/>`
      : `<path d="${centerPath(it.points)}" fill="none" stroke="${it.color}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (it.type === 'highlighter') {
    return `<path d="${centerPath(it.points)}" fill="none" stroke="${it.color}" stroke-opacity="0.38" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (it.type === 'text') {
    return `<text x="${it.x}" y="${it.y}" fill="${it.color}" font-size="${it.size}" font-family="Segoe UI, Arial, sans-serif">`
      + textLines(it.text).map((l, i) => `<tspan x="${it.x}" dy="${i ? it.size * 1.25 : it.size}">${escXml(l)}</tspan>`).join('') + '</text>';
  }
  const s = `stroke="${it.color}" stroke-width="${it.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  if (it.type === 'line') return `<path d="M${it.x1},${it.y1} L${it.x2},${it.y2}" ${s}/>`;
  if (it.type === 'arrow') return `<path d="M${it.x1},${it.y1} L${it.x2},${it.y2} ${arrowHead(it.x1, it.y1, it.x2, it.y2, 8 + it.width * 2.2)}" ${s}/>`;
  const b = itemBounds(it);
  if (it.type === 'rect') return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="2" ${s}/>`;
  return `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" ${s}/>`;
}

/** The paper's lines between `b`'s edges (grid: 24-unit squares; lined: 32-unit lines with a margin). */
export function paperSvg(paper: Paper, b: Box): string {
  if (paper === 'plain') return '';
  const lines: string[] = [];
  const step = paper === 'grid' ? 24 : 32;
  for (let y = Math.ceil(b.y / step) * step; y <= b.y + b.h; y += step) lines.push(`M${b.x},${y} H${b.x + b.w}`);
  if (paper === 'grid') for (let x = Math.ceil(b.x / step) * step; x <= b.x + b.w; x += step) lines.push(`M${x},${b.y} V${b.y + b.h}`);
  return `<path d="${lines.join(' ')}" stroke="#c7d2fe" stroke-width="1" fill="none"/>`
    + (paper === 'lined' ? `<path d="M${b.x + 48},${b.y} V${b.y + b.h}" stroke="#fca5a5" stroke-width="1"/>` : '');
}

/** A whole drawing as a standalone SVG on white (paper included), framed around what's drawn. */
export function drawingSvg(d: DrawingData, pad = 24): { svg: string; w: number; h: number } {
  const u = unionBounds(d.items) ?? { x: 0, y: 0, w: 400, h: 300 };
  const b = { x: Math.floor(u.x - pad), y: Math.floor(u.y - pad), w: Math.ceil(u.w + 2 * pad), h: Math.ceil(u.h + 2 * pad) };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">`
    + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffffff"/>${paperSvg(d.paper, b)}`
    + d.items.map(itemSvg).join('') + '</svg>';
  return { svg, w: b.w, h: b.h };
}

/** An SVG string drawn into a PNG (data URL), scaled so its longer side is at most `maxSide` px. */
export function svgToPng(svg: string, w: number, h: number, maxSide = 2400, scale = 2): Promise<string> {
  const k = Math.min(scale, maxSide / Math.max(w, h, 1));
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        const g = c.getContext('2d')!;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't draw the picture")); };
    img.src = url;
  });
}

/** Save a PNG data URL where the student picks (the desktop app's save dialog), or as a download in a browser.
 * Returns the saved path (desktop), the file name (browser) or null when cancelled. */
export async function savePng(dataUrl: string, title: string): Promise<string | null> {
  const name = `${title.replace(/[<>:"/\\|?*]+/g, ' ').trim().slice(0, 80) || 'picture'}.png`;
  if (window.studyApp?.saveFile) {
    const path = await window.studyApp.saveFile({ defaultName: name, filters: [{ name: 'PNG picture', extensions: ['png'] }] });
    if (!path) return null;
    const res = await api.exportPng(dataUrl, path);
    await window.studyApp.showItem(res.path);
    return res.path;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
  return name;
}
