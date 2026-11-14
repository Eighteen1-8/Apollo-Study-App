import { describe, expect, it } from 'vitest';
import { formatRanges, parseRanges } from '../../src/components/PagePicker';

describe('PagePicker ranges', () => {
  const valid = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  it('reads ranges, single pages and either dash, ignoring what is not a number', () => {
    expect(parseRanges('3-5, 7 10–12', valid)).toEqual({ picked: [3, 4, 5, 7, 10, 11, 12], unknown: [] });
    expect(parseRanges('5-3; 4', valid).picked).toEqual([3, 4, 5]);
    expect(parseRanges('abc, 2', valid).picked).toEqual([2]);
    expect(parseRanges('3-', valid).picked).toEqual([]);  // half-typed
  });
  it('lists pages the file does not have', () => {
    expect(parseRanges('11-14', valid)).toEqual({ picked: [11, 12], unknown: [13, 14] });
  });
  it('writes a choice back as ranges', () => {
    expect(formatRanges([7, 3, 4, 5, 12, 11])).toBe('3-5, 7, 11-12');
    expect(formatRanges([])).toBe('');
  });
});
