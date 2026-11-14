import { describe, expect, it } from 'vitest';
import { besideWhere, dropZones, View, viewKey, viewReducer, zoneAt } from '../../src/views/subject/viewState';
import {
  currentNoteInsert, currentNoteTarget, escapeHtml, imageHtml, queueForNote, quoteHtml, quotePlain, recentNotes,
  registerNoteInsert, sourceLine, takeQueued,
} from '../../src/noteInsert';
import { registerNoteInsert as fromCalculator } from '../../src/components/Calculator';
import { draggedPane, PANE_DRAG, setPaneDrag } from '../../src/views/subject/PaneDrop';
import { DEFAULT_VISION } from '../../src/components/UploadDialog';
import type { NoteSummary } from '../../src/api';

const empty: View = { doc: null, page: null, split: null, chatFull: false };

describe('dropping a sidebar row in the centre (place)', () => {
  it('offers open over nothing, left/replace/right over one pane, left/right when split', () => {
    expect(dropZones(empty)).toEqual(['open']);
    const one = viewReducer(empty, { type: 'doc', id: 1 });
    expect(dropZones(one)).toEqual(['left', 'replace', 'right']);
    const two = viewReducer(one, { type: 'split', pane: { kind: 'note', id: 2 } });
    expect(dropZones(two)).toEqual(['left', 'right']);
    expect(zoneAt(['left', 'replace', 'right'], 0.1)).toBe('left');
    expect(zoneAt(['left', 'replace', 'right'], 0.5)).toBe('replace');
    expect(zoneAt(['left', 'replace', 'right'], 1)).toBe('right');
  });

  it('right opens beside, left puts it first and moves what was open beside it, replace swaps it', () => {
    const one = viewReducer(empty, { type: 'doc', id: 1 });
    const right = viewReducer(one, { type: 'place', pane: { kind: 'doc', id: 5 }, where: 'right' });
    expect(right.doc).toMatchObject({ id: 1 });
    expect(right.split).toMatchObject({ kind: 'doc', id: 5 });
    const left = viewReducer(one, { type: 'place', pane: { kind: 'note', id: 7 }, where: 'left' });
    expect(left.page).toEqual({ kind: 'note', id: 7 });
    expect(left.doc).toBeNull();
    expect(left.split).toMatchObject({ kind: 'doc', id: 1 });
    const replaced = viewReducer(one, { type: 'place', pane: { kind: 'artifact', id: 3 }, where: 'replace' });
    expect(replaced).toMatchObject({ doc: null, page: { kind: 'artifact', id: 3 }, split: null });
    // each is a step of its own for undo/redo
    expect(new Set([one, right, left, replaced].map(viewKey)).size).toBe(4);
  });

  it('when split, a side is replaced and the other kept; open over nothing just opens', () => {
    let v = viewReducer(empty, { type: 'doc', id: 1 });
    v = viewReducer(v, { type: 'split', pane: { kind: 'doc', id: 2 } });
    const l = viewReducer(v, { type: 'place', pane: { kind: 'note', id: 9 }, where: 'left' });
    expect(l).toMatchObject({ doc: null, page: { kind: 'note', id: 9 } });
    expect(l.split).toMatchObject({ kind: 'doc', id: 2 });
    const r = viewReducer(v, { type: 'place', pane: { kind: 'note', id: 9 }, where: 'right' });
    expect(r.doc).toMatchObject({ id: 1 });
    expect(r.split).toMatchObject({ kind: 'note', id: 9 });
    const o = viewReducer({ ...empty, chatFull: true }, { type: 'place', pane: { kind: 'doc', id: 4 }, where: 'open' });
    expect(o).toMatchObject({ doc: { id: 4 }, split: null, chatFull: false });
  });

  it('a note opened beside a file never covers it', () => {
    const file = viewReducer(empty, { type: 'doc', id: 1 });
    expect(besideWhere(empty)).toBe('open');
    expect(besideWhere(file)).toBe('right');
    const fileRight = viewReducer(viewReducer(empty, { type: 'page', kind: 'artifact', id: 3 }), { type: 'split', pane: { kind: 'doc', id: 1 } });
    expect(besideWhere(fileRight)).toBe('left');
  });

  it('the drag payload round-trips and rejects junk', () => {
    const store = new Map<string, string>();
    const dt = { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? '' } as unknown as DataTransfer;
    setPaneDrag(dt, { kind: 'note', id: 12, name: 'Week 1' });
    expect(store.has(PANE_DRAG)).toBe(true);
    expect(draggedPane(dt)).toEqual({ kind: 'note', id: 12, name: 'Week 1' });
    store.set(PANE_DRAG, '{"kind":"chat","id":1}');
    expect(draggedPane(dt)).toBeNull();
    store.set(PANE_DRAG, 'not json');
    expect(draggedPane(dt)).toBeNull();
  });
});

describe('insert into the open note', () => {
  it('builds a quote block with its source line, escaped, then a paragraph to keep typing in', () => {
    const h = quoteHtml('F = ma <b>\n\nsecond line\nwrapped', sourceLine('Lecture 3.pdf', 'Page 4'));
    expect(h).toBe('<blockquote><p>F = ma &lt;b&gt;</p><p>second line<br>wrapped</p><p><small>— Lecture 3.pdf · Page 4</small></p></blockquote><p><br></p>');
    expect(sourceLine('notes.txt', null)).toBe('notes.txt');
    expect(quotePlain('  hi ', "Apollo's answer")).toBe('“hi”\n— Apollo\'s answer');
    expect(escapeHtml(`"a'&`)).toBe('&quot;a&#39;&amp;');
    expect(imageHtml('data:image/png;base64,AAA', 'A.pdf · Page 1')).toContain('<img src="data:image/png;base64,AAA" alt="A.pdf · Page 1"');
  });

  it('the latest registered note wins; the calculator still registers through the same registry', () => {
    const got: string[] = [];
    const offA = registerNoteInsert((h) => got.push(`a:${h}`), { noteId: 1, title: () => 'A' });
    const offB = fromCalculator((h) => got.push(`b:${h}`));
    currentNoteInsert()!('x');
    offB();
    expect(currentNoteTarget()?.title?.()).toBe('A');
    currentNoteInsert()!('y');
    offA();
    expect(currentNoteInsert()).toBeNull();
    expect(got).toEqual(['b:x', 'a:y']);
  });

  it('queues content for a note until it has loaded, once', () => {
    queueForNote(42, '<p>1</p>');
    queueForNote(42, '<p>2</p>');
    expect(takeQueued(42)).toEqual(['<p>1</p>', '<p>2</p>']);
    expect(takeQueued(42)).toEqual([]);
  });

  it('offers rich-text notes only, most recently changed first', () => {
    const n = (id: number, kind: NoteSummary['kind'], updated_at: number) =>
      ({ id, kind, updated_at, title: `n${id}`, subject_id: 1, topic_id: null, topic_name: null, created_at: 0, size: 0 }) as NoteSummary;
    expect(recentNotes([n(1, 'note', 5), n(2, 'map', 9), n(3, 'note', 7), n(4, 'drawing', 8)]).map((x) => x.id)).toEqual([3, 1]);
    expect(recentNotes(Array.from({ length: 10 }, (_, i) => n(i, 'note', i)), 3).map((x) => x.id)).toEqual([9, 8, 7]);
  });
});

describe('adding files', () => {
  it('starts on Auto vision', () => { expect(DEFAULT_VISION).toBe('auto'); });
});
