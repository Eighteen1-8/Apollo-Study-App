import { describe, expect, it } from 'vitest';
import { ApiError, errorText, splitError } from '../../src/errors';

describe('error codes', () => {
  it('finds the code after or before the message', () => {
    expect(splitError('Apollo can’t reach it. [APO-LLM-101]')).toEqual({ message: 'Apollo can’t reach it.', code: 'APO-LLM-101' });
    expect(splitError('[APO-FILE-303] notes.xlsx: can’t read')).toEqual({ message: 'notes.xlsx: can’t read', code: 'APO-FILE-303' });
    expect(splitError('Error: Something failed [APO-APP-900]')).toEqual({ message: 'Something failed', code: 'APO-APP-900' });
    expect(splitError('no code here')).toEqual({ message: 'no code here', code: null });
  });
  it('keeps the code in an ApiError’s text', () => {
    const e = new ApiError('Item not found.', 'APO-DATA-504', 404);
    expect(String(e)).toBe('Error: Item not found. [APO-DATA-504]');
    expect(errorText(e)).toBe('Item not found. [APO-DATA-504]');
    expect(splitError(String(e)).code).toBe('APO-DATA-504');
  });
});
