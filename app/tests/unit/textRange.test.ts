import { describe, expect, it } from 'vitest';
import { findAll, offsetsOf, rangeAt, rangesAt } from '../../src/components/textRange';

const make = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
};

describe('textRange', () => {
  it('finds matches across element boundaries, case-insensitively', () => {
    const el = make('<p>The <b>Wave</b> eq<i>uation</i> and the wave.</p>');
    const hits = findAll(el, 'wave');
    expect(hits.map((r) => r.toString())).toEqual(['Wave', 'wave']);
    expect(findAll(el, 'equation').map((r) => r.toString())).toEqual(['equation']);
    expect(findAll(el, '')).toEqual([]);
  });

  it('respects the limit', () => {
    const el = make('<p>' + 'ab '.repeat(50) + '</p>');
    expect(findAll(el, 'ab', 10)).toHaveLength(10);
  });

  it('rangesAt gives the same ranges as rangeAt, one span at a time', () => {
    const el = make('<div>alpha <span>beta</span><em>gamma</em> delta<br>epsilon</div><p>zeta eta</p>');
    const len = el.textContent!.length;
    const spans: [number, number][] = [];
    for (let s = 0; s < len; s += 3) spans.push([s, Math.min(len, s + 5)]);
    const many = rangesAt(el, spans);
    expect(many).toHaveLength(spans.length);
    spans.forEach(([s, e], i) => {
      const one = rangeAt(el, s, e)!;
      expect(many[i].toString()).toBe(one.toString());
      expect(offsetsOf(el, many[i])).toEqual([s, e]);
    });
  });

  it('leaves out spans past the end', () => {
    const el = make('<p>short</p>');
    expect(rangesAt(el, [[0, 2], [3, 50]]).map((r) => r.toString())).toEqual(['sh']);
  });
});
