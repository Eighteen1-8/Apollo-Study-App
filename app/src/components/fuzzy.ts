/* The command palette's matching (Ctrl+K), kept apart so it can be tested without the UI. */

/** Fuzzy score: every query word must appear (as a substring, or as word starts); earlier and tighter is better.
 * Lower is better; -1 means no match. */
export function score(hay: string, words: string[]): number {
  let total = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i >= 0) { total += i === 0 ? 0 : /[\s·/_.-]/.test(hay[i - 1]) ? 2 : 6; continue; }
    // a typo-tolerant fallback: the letters in order, close together (not scattered across a long file name)
    if (w.length < 3) return -1;
    let j = hay.indexOf(w[0]);
    if (j < 0) return -1;
    const begin = j;
    for (const ch of w.slice(1)) {
      const k = hay.indexOf(ch, j + 1);
      if (k < 0) return -1;
      j = k;
    }
    const span = j - begin + 1;
    if (span > w.length + 2) return -1;
    total += 20 + span - w.length;
  }
  return total + hay.length / 200;
}
