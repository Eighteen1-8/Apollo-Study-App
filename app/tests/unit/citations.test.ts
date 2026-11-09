import { describe, expect, it } from 'vitest';
import { matchUnit } from '../../src/views/DocumentView';

const units = [
  { idx: 1, label: 'Answer: D' }, { idx: 2, label: 'Question 2' }, { idx: 3, label: 'Answer: D' },
] as Parameters<typeof matchUnit>[0];

describe('citation labels', () => {
  it('finds numbered sections, ranges and old chunk names', () => {
    expect(matchUnit(units, 'Section 3 · Answer: D')?.idx).toBe(3); // repeated heading: the number decides
    expect(matchUnit(units, 'Page 2 – Page 3')?.idx).toBe(2);
    expect(matchUnit(units, 'Question 2 (part 4)')?.idx).toBe(2);
    expect(matchUnit(units, 'Slide 1')?.idx).toBe(1);
  });
});
