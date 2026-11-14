/* Where annotations sit: text anchors (character offsets into a unit's text) to and from DOM ranges and boxes, note placement. */
import { TextAnchor } from '../api';

export const NOTE_W = 240; // px; note boxes stay readable at any zoom
export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Text nodes of a unit in order, leaving out the annotation layer itself. */
export function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.anno-layer') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (w.nextNode()) out.push(w.currentNode as Text);
  return out;
}

export function offsetOf(root: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  let acc = 0;
  for (const t of textNodes(root)) {
    if (!r.intersectsNode(t)) continue;
    if (t === r.endContainer) return acc + r.endOffset;
    acc += t.length;
  }
  return acc;
}

export function rangeAt(root: Element, start: number, end: number): Range | null {
  const r = document.createRange();
  let acc = 0;
  let started = false;
  for (const t of textNodes(root)) {
    if (!started && start <= acc + t.length) { r.setStart(t, Math.max(0, start - acc)); started = true; }
    if (started && end <= acc + t.length) { r.setEnd(t, Math.max(0, end - acc)); return r; }
    acc += t.length;
  }
  return null;
}

/** Line boxes of a range (from its text only, so wholly-selected blocks don't add a box each), merged per line. */
export function rangeBoxes(range: Range, root: Element): DOMRect[] {
  const boxes: DOMRect[] = [];
  for (const t of textNodes(root)) {
    if (!range.intersectsNode(t)) continue;
    const r = document.createRange();
    r.setStart(t, t === range.startContainer ? range.startOffset : 0);
    r.setEnd(t, t === range.endContainer ? range.endOffset : t.length);
    for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) boxes.push(b);
  }
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: DOMRect[] = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.top - b.top) < Math.min(last.height, b.height) * 0.5 && b.left <= last.right + 6) {
      const top = Math.min(last.top, b.top);
      merged[merged.length - 1] = new DOMRect(Math.min(last.left, b.left), top, Math.max(last.right, b.right) - Math.min(last.left, b.left),
        Math.max(last.bottom, b.bottom) - top);
    } else merged.push(b);
  }
  return merged;
}

/** Anchor for a selection inside one unit element (a selection running past the unit is cut at its end). */
export function anchorFromRange(range: Range, unitEl: Element): TextAnchor {
  const r = range.cloneRange();
  if (!unitEl.contains(r.endContainer)) r.setEnd(unitEl, unitEl.childNodes.length);
  const box = unitEl.getBoundingClientRect();
  const start = offsetOf(unitEl, r.startContainer, r.startOffset);
  const end = offsetOf(unitEl, r.endContainer, r.endOffset);
  const full = textNodes(unitEl).map((t) => t.data).join('');
  return {
    start, end, text: full.slice(start, end),
    rects: rangeBoxes(r, unitEl).map((b) => [(b.left - box.left) / box.width, (b.top - box.top) / box.height, b.width / box.width, b.height / box.height]),
  };
}

export type Px = { x: number; y: number; w: number; h: number };

export function anchorPx(anchor: TextAnchor, el: Element, fixed: boolean, size: { w: number; h: number }): Px[] {
  const fromRects = () => (anchor.rects ?? []).map(([x, y, w, h]) => ({ x: x * size.w, y: y * size.h, w: w * size.w, h: h * size.h }));
  if (fixed && anchor.rects?.length) return fromRects();
  if (anchor.start != null && anchor.end != null && anchor.text) {
    let r = rangeAt(el, anchor.start, anchor.end);
    if (!r || squash(r.toString()) !== squash(anchor.text)) {
      // The text moved (e.g. the file was re-saved): look for the same words, nearest to where they were.
      const full = textNodes(el).map((t) => t.data).join('');
      let best = -1;
      for (let i = full.indexOf(anchor.text); i >= 0; i = full.indexOf(anchor.text, i + 1)) {
        if (best < 0 || Math.abs(i - anchor.start) < Math.abs(best - anchor.start)) best = i;
      }
      r = best >= 0 ? rangeAt(el, best, best + anchor.text.length) : null;
    }
    if (r) {
      const box = el.getBoundingClientRect();
      const sx = size.w / (box.width || 1);
      const sy = size.h / (box.height || 1);
      return rangeBoxes(r, el).map((b) => ({ x: (b.left - box.left) * sx, y: (b.top - box.top) * sy, w: b.width * sx, h: b.height * sy }));
    }
  }
  return fromRects();
}

/** Where a note about some text goes: just below the end of the text, kept on the page. */
export function notePlacement(anchor: TextAnchor, unitEl: Element) {
  const box = unitEl.getBoundingClientRect();
  const w = Math.min(NOTE_W / box.width, 0.9);
  const last = anchor.rects?.[anchor.rects.length - 1] ?? [0.05, 0.05, 0, 0];
  return {
    x: Math.max(0.01, Math.min(last[0], 0.99 - w)), y: Math.min(last[1] + last[3] + 0.006, 0.95),
    w, h: Math.min(150 / box.height, 0.5),
  };
}

// (hit-testing ink strokes: components/ink.tsx nearStroke)

