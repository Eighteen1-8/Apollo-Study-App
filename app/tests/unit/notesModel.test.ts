import { describe, expect, it } from 'vitest';
import {
  addChild, addNode, borderPoint, bounds, connect, duplicate, findQuoted, MapData, mapSvg, moveNodes, nodeSize, nodesIn,
  normalizeMap, removeItems, tidy, wrapText,
} from '../../src/views/notes/mapModel';
import {
  DrawItem, drawingSvg, hitItem, itemBounds, itemInBox, nearStroke, normalizeDrawing, outlinePath, scaleItem, smooth, thin,
  translateItem, unionBounds,
} from '../../src/components/ink';
import { History } from '../../src/views/notes/history';

const base = (): MapData => ({
  nodes: [
    { id: 'a', x: 0, y: 0, text: 'Voltage', shape: 'box', color: '' },
    { id: 'b', x: 300, y: 0, text: 'Current', shape: 'rounded', color: '' },
    { id: 'c', x: 0, y: 300, text: 'Lonely', shape: 'circle', color: '' },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b', label: 'drives' }],
});

describe('mind map data', () => {
  it('cleans stored data: unknown shapes become boxes, broken and self links are dropped', () => {
    const d = normalizeMap({ nodes: [{ id: 1, x: '5', text: 'x', shape: 'star' }, { id: 'y' }],
      edges: [{ id: 'e', from: '1', to: 'y' }, { from: '1', to: 'zz' }, { from: 'y', to: 'y' }] });
    expect(d.nodes.map((n) => [n.id, n.x, n.shape])).toEqual([['1', 5, 'box'], ['y', 0, 'box']]);
    expect(d.edges).toHaveLength(1);
    expect(normalizeMap(null)).toEqual({ nodes: [], edges: [] });
  });

  it('connects boxes once, never to themselves', () => {
    let [d, e] = connect(base(), 'b', 'a');
    expect(e).not.toBeNull();
    [d, e] = connect(d, 'b', 'a');
    expect(e).toBeNull();
    expect(connect(d, 'a', 'a')[1]).toBeNull();
    expect(connect(d, 'a', 'missing')[1]).toBeNull();
  });

  it('removes boxes with their links, duplicates boxes with the links between them', () => {
    const d = removeItems(base(), ['a']);
    expect(d.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(d.edges).toEqual([]);
    const [d2, ids] = duplicate(base(), ['a', 'b']);
    expect(ids).toHaveLength(2);
    expect(d2.edges).toHaveLength(2);
    const copy = d2.edges[1];
    expect(ids).toContain(copy.from);
    expect(ids).toContain(copy.to);
  });

  it('adds a linked box to the right (Tab) and moves boxes', () => {
    const [d, n] = addChild(base(), 'a');
    expect(n!.x).toBeGreaterThan(0);
    expect(d.edges.some((e) => e.from === 'a' && e.to === n!.id)).toBe(true);
    const [, second] = addChild(d, 'a');
    expect(second!.y).toBeGreaterThan(n!.y); // below the first child
    expect(moveNodes(base(), ['a'], 10, -5).nodes[0]).toMatchObject({ x: 10, y: -5 });
    const [d3, added] = addNode(base(), { x: 1.4, y: 2.6 });
    expect(d3.nodes).toHaveLength(4);
    expect(added).toMatchObject({ x: 1, y: 3, text: '' });
  });

  it('sizes boxes to their text and finds where links meet the outline', () => {
    expect(wrapText('one two three four five six seven eight nine ten eleven twelve').length).toBeGreaterThan(1);
    const small = nodeSize({ text: 'x', shape: 'box' });
    const circle = nodeSize({ text: 'x', shape: 'circle' });
    expect(circle.w).toBe(circle.h);
    const p = borderPoint(base().nodes[0], 1000, 0);
    expect(p.x).toBeCloseTo(small.w / 2 > 0 ? nodeSize(base().nodes[0]).w / 2 : 0);
    expect(p.y).toBe(0);
  });

  it('tidies into columns along the links, with unlinked boxes in a row underneath', () => {
    let d = base();
    d = connect(d, 'b', 'a')[0]; // a cycle must not hang the layout
    const t = tidy(d);
    const [a, b, c] = t.nodes;
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.y).toBeGreaterThan(Math.max(a.y, b.y));
    const box = bounds(t)!;
    expect(nodesIn(t, box).sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds the box or link an issue quotes', () => {
    const d = base();
    expect(findQuoted(d, 'Voltage → Current')).toEqual({ nodes: [], edges: ['e1'] });
    expect(findQuoted(d, 'voltage -> current (drives)')).toEqual({ nodes: [], edges: ['e1'] });
    expect(findQuoted(d, '“Lonely”')).toEqual({ nodes: ['c'], edges: [] });
    expect(findQuoted(d, 'drives')).toEqual({ nodes: [], edges: ['e1'] });
    expect(findQuoted(d, 'nothing like it')).toEqual({ nodes: [], edges: [] });
  });

  it('exports as a standalone SVG', () => {
    const s = mapSvg(base());
    expect(s.svg).toContain('Voltage');
    expect(s.svg).toContain('marker-end');
    expect(s.w).toBeGreaterThan(300);
  });
});

describe('ink geometry', () => {
  const pen: DrawItem = { id: 'p', type: 'pen', color: '#000', width: 4, points: [[0, 0, 0.5], [10, 0, 0.5], [20, 0, 0.5]] };
  const rect: DrawItem = { id: 'r', type: 'rect', color: '#000', width: 2, x1: 0, y1: 0, x2: 100, y2: 50 };
  const ell: DrawItem = { id: 'e', type: 'ellipse', color: '#000', width: 2, x1: 0, y1: 0, x2: 100, y2: 50 };
  const text: DrawItem = { id: 't', type: 'text', color: '#000', size: 20, x: 0, y: 0, text: 'Hi\nthere' };

  it('hit-tests the viewer strokes (fractions of a box)', () => {
    const s = { color: '#000', width: 0.01, points: [0, 0, 1, 0] };
    expect(nearStroke(s, 50, 3, 100, 100, 5)).toBe(true);
    expect(nearStroke(s, 50, 30, 100, 100, 5)).toBe(false);
  });

  it('hit-tests drawing items near their lines, not inside shapes', () => {
    expect(hitItem(pen, 15, 2, 1)).toBe(true);
    expect(hitItem(pen, 15, 20, 1)).toBe(false);
    expect(hitItem(rect, 50, 1, 2)).toBe(true);
    expect(hitItem(rect, 50, 25, 2)).toBe(false);
    expect(hitItem(ell, 100, 25, 2)).toBe(true);
    expect(hitItem(ell, 50, 25, 2)).toBe(false);
    expect(hitItem(text, 5, 30, 0)).toBe(true);
  });

  it('measures, moves and scales items', () => {
    expect(itemBounds(rect)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(itemBounds(text).h).toBeCloseTo(50);
    expect(unionBounds([rect, translateItem(rect, 100, 100)])).toEqual({ x: 0, y: 0, w: 200, h: 150 });
    const scaled = scaleItem(rect, { x: 0, y: 0, w: 100, h: 50 }, { x: 10, y: 10, w: 200, h: 100 });
    expect(scaled).toMatchObject({ x1: 10, y1: 10, x2: 210, y2: 110 });
    expect(scaleItem(text, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 20 }).size).toBe(40);
    expect(itemInBox(rect, { x: -1, y: -1, w: 102, h: 52 })).toBe(true);
    expect(itemInBox(rect, { x: 1, y: -1, w: 102, h: 52 })).toBe(false);
  });

  it('thins and smooths strokes, keeping the ends', () => {
    const pts: [number, number, number][] = [[0, 0, 0.5], [0.1, 0, 0.5], [5, 5, 0.5], [10, 0, 0.5], [20, 0, 0.5]];
    const t = thin(pts, 1);
    expect(t[0]).toEqual(pts[0]);
    expect(t[t.length - 1]).toEqual(pts[4]);
    expect(t).toHaveLength(4);
    const s = smooth(pts, 1);
    expect(s[0]).toEqual(pts[0]);
    expect(s[4]).toEqual(pts[4]);
    expect(s[2][1]).toBeLessThan(5);
  });

  it('draws pressure strokes as a closed outline and whole drawings as SVG', () => {
    expect(outlinePath([[0, 0, 0.2], [10, 0, 0.9]], 4)).toMatch(/^M.*Z$/);
    const d = normalizeDrawing({ items: [pen, rect, { type: 'pen' }], paper: 'grid', description: 'x' });
    expect(d.items).toHaveLength(2);
    const svg = drawingSvg(d);
    expect(svg.svg).toContain('<rect');
    expect(svg.svg).toContain('#c7d2fe'); // grid lines
    expect(normalizeDrawing(undefined)).toEqual({ items: [], paper: 'plain', description: '' });
  });
});

describe('editor history', () => {
  it('undoes and redoes snapshots, and a new change clears redo', () => {
    const h = new History<number>();
    h.push(1);
    expect(h.undo(2)).toBe(1);
    expect(h.redo(1)).toBe(2);
    h.push(2);
    expect(h.canRedo).toBe(false);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
  });
});
