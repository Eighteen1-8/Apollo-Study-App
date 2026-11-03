/* Text positions inside rendered content (notes, cheat sheets, chat): character offsets into an element's text, so
   highlights and find results survive re-rendering, and CSS Custom Highlights that paint them without touching the
   DOM (the rendered HTML stays exactly what the sanitiser produced). */

/** The selection's range when it lies inside `root` and isn't empty. */
export function selectionIn(root: Element | null): Range | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return root.contains(r.commonAncestorContainer) && sel.toString().trim() ? r : null;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text);
  return out;
}

/** [start, end) of a range in `root`'s text (textContent order). */
export function offsetsOf(root: Element, r: Range): [number, number] {
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return [start, start + r.toString().length];
}

/** The range covering [start, end) of `root`'s text, or null when the text is shorter. */
export function rangeAt(root: Element, start: number, end: number): Range | null {
  let pos = 0;
  let r: Range | null = null;
  for (const t of textNodes(root)) {
    const len = t.data.length;
    if (!r && start <= pos + len) {
      r = document.createRange();
      r.setStart(t, Math.max(0, start - pos));
    }
    if (r && end <= pos + len) {
      r.setEnd(t, Math.max(0, end - pos));
      return r;
    }
    pos += len;
  }
  return null;
}

/** Every case-insensitive occurrence of `needle` in `root`'s text, as ranges. */
export function findAll(root: Element, needle: string, limit = 2000): Range[] {
  if (!needle) return [];
  const text = (root.textContent ?? '').toLowerCase();
  const q = needle.toLowerCase();
  const out: Range[] = [];
  for (let i = text.indexOf(q); i >= 0 && out.length < limit; i = text.indexOf(q, i + q.length)) {
    const r = rangeAt(root, i, i + q.length);
    if (r) out.push(r);
  }
  return out;
}

/** The highlighted text with a sentence or so either side (what Apollo sees when asked about it). */
export function quoteParts(root: Element, r: Range): { text: string; before: string; after: string } {
  const [start, end] = offsetsOf(root, r);
  const all = root.textContent ?? '';
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim();
  return { text: clip(r.toString()), before: clip(all.slice(Math.max(0, start - 240), start)), after: clip(all.slice(end, end + 240)) };
}

/** Paint ranges under a CSS highlight name (`::highlight(name)` in the styles). No-op where unsupported. */
export function paint(name: string, ranges: Range[]) {
  const css = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !H) return;
  if (ranges.length) css.highlights.set(name, new H(...ranges));
  else css.highlights.delete(name);
}

/** Replace the first occurrence of `find` in an editable element's text with plain `replacement` (keeps the
 * surrounding formatting). Returns false when the text isn't there. */
export function replaceText(root: Element, find: string, replacement: string): boolean {
  const words = find.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  // any run of whitespace in the quote matches any run in the text (line breaks, non-breaking spaces)
  const m = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).exec(root.textContent ?? '');
  if (!m) return false;
  const r = rangeAt(root, m.index, m.index + m[0].length);
  if (!r) return false;
  r.deleteContents();
  r.insertNode(document.createTextNode(replacement));
  root.normalize();
  return true;
}
