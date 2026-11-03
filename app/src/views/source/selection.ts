/* Text selection in the viewer: the quote sent to the chat and which Word section a point on the exact copy is in. */

/** The Word section a point on a page of its exact PDF copy falls in: the last section starting at or before it. */
export function sectionAt(pos: Record<string, [number, number]>, page: number, y: number): number | null {
  let best: number | null = null;
  let bestAt: [number, number] = [0, -1];
  for (const [idx, [p, py]] of Object.entries(pos)) {
    const before = p < page || (p === page && py <= y + 0.002);
    const later = p > bestAt[0] || (p === bestAt[0] && py > bestAt[1]);
    if (before && later) { best = Number(idx); bestAt = [p, py]; }
  }
  return best;
}

// ---------------------------------------------------------------- highlighted text → quote

/** Text of a DOM range: <br> and block boundaries become spaces, KaTeX formulas become their $TeX$. */
export function rangeText(r: Range): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue; return; }
    if (!(n instanceof Element) || n.classList.contains('anno-layer')) return;
    const tex = n.getAttribute('data-tex');
    if (tex) { out += ` $${tex}$ `; return; }
    if (n.tagName === 'BR') { out += ' '; return; }
    n.childNodes.forEach(walk);
    if (/^(DIV|P|LI|TR|TD|TH|H\d|SECTION)$/.test(n.tagName)) out += ' ';
  };
  r.cloneContents().childNodes.forEach(walk);
  return out.replace(/\s+/g, ' ');
}

// Sentence ends; a bullet point also starts a new "sentence" (slides and syllabus lists rarely use full stops).
export const TERMINATOR = /[.!?](?=["')\]]?(\s|$))|\s(?=[•▪◦‣–]\s)/g;

/** The highlighted text plus the previous full sentence and the following full sentence, within its unit. */
export function quoteFromRange(r: Range, root: HTMLElement) {
  const startEl = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
  const unitEl = startEl?.closest<HTMLElement>('[data-unit]') ?? null;
  const scope = unitEl && root.contains(unitEl) ? unitEl : root;
  const text = rangeText(r).trim();

  const pre = document.createRange();
  pre.setStart(scope, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const b = rangeText(pre);
  const ends = [...b.matchAll(TERMINATOR)].map((m) => m.index! + 1);
  // Two terminators back: covers "previous sentence + start of this one", and also "previous sentence" when the
  // highlight starts a sentence (then the last terminator ends that previous sentence).
  const before = b.slice(ends.length >= 2 ? ends[ends.length - 2] : 0).trim().slice(-600);

  let after = '';
  if (scope.contains(r.endContainer)) {
    const post = document.createRange();
    post.setStart(r.endContainer, r.endOffset);
    post.setEnd(scope, scope.childNodes.length);
    const a = rangeText(post);
    const aEnds = [...a.matchAll(TERMINATOR)].map((m) => m.index! + 1);
    const finishesSentence = /[.!?]["')\]]?$/.test(text);
    const cut = finishesSentence ? aEnds[0] : aEnds[1];
    after = a.slice(0, cut ?? a.length).trim().slice(0, 600);
  }
  return { unit: unitEl ? Number(unitEl.dataset.unit) : null, text: text.slice(0, 2000), before, after };
}

// ---------------------------------------------------------------- PDF (pdf.js: canvas + selectable text layer)
