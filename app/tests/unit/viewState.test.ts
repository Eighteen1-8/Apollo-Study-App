import { describe, expect, it } from 'vitest';
import { snapOf, View, viewKey, viewReducer } from '../../src/views/subject/viewState';

const empty: View = { doc: null, page: null, split: null, chatFull: true };

describe('subject view reducer', () => {
  it('opening a document or page replaces the other and leaves full-screen chat', () => {
    const a = viewReducer(empty, { type: 'doc', id: 4, focus: 'Slide 2' });
    expect(a.doc).toMatchObject({ id: 4, focus: 'Slide 2', details: false });
    expect(a.chatFull).toBe(false);
    const b = viewReducer(a, { type: 'page', kind: 'note', id: 9 });
    expect(b.doc).toBeNull();
    expect(b.page).toEqual({ kind: 'note', id: 9 });
  });

  it('split, swap and closing the first pane', () => {
    let v = viewReducer(empty, { type: 'doc', id: 1 });
    v = viewReducer(v, { type: 'split', pane: { kind: 'note', id: 2 } });
    expect(v.split).toMatchObject({ kind: 'note', id: 2 });
    v = viewReducer(v, { type: 'swap' });
    expect(v.page).toEqual({ kind: 'note', id: 2 });
    expect(v.doc).toBeNull();
    expect(v.split).toMatchObject({ kind: 'doc', id: 1 });
    v = viewReducer(v, { type: 'closePrimary' }); // the second pane takes the first's place
    expect(v.doc).toMatchObject({ id: 1 });
    expect(v.page).toBeNull();
    expect(v.split).toBeNull();
    v = viewReducer(v, { type: 'closePrimary' });
    expect(v).toMatchObject({ doc: null, page: null, split: null });
  });

  it('details keeps the viewer; back remounts it', () => {
    const v = viewReducer(empty, { type: 'doc', id: 1 });
    const d = viewReducer(v, { type: 'details', on: true });
    expect(d.doc!.details).toBe(true);
    expect(d.doc!.nonce).toBe(v.doc!.nonce);
    const back = viewReducer(d, { type: 'details', on: false });
    expect(back.doc!.nonce).not.toBe(v.doc!.nonce);
  });

  it('snapshot and restore round-trip, and the undo key ignores remounts', () => {
    let v = viewReducer(empty, { type: 'doc', id: 3, focus: 'p. 4' });
    v = viewReducer(v, { type: 'split', pane: { kind: 'artifact', id: 8 } });
    const snap = snapOf(v);
    const restored = viewReducer(empty, { type: 'restore', snap });
    expect(snapOf(restored)).toEqual(snap);
    expect(viewKey(restored)).toBe(viewKey(v));
    expect(viewKey(viewReducer(v, { type: 'details', on: true }))).toBe(viewKey(v));
  });
});
