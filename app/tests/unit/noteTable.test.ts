import { describe, expect, it } from 'vitest';
import { arrowInTable, cellAcross, cellOf, changedTable, tableHtml, tabInTable } from '../../src/components/noteTable';

const mount = (rows = 3, cols = 3) => {
  const root = document.createElement('div');
  root.innerHTML = tableHtml(rows, cols);
  document.body.appendChild(root);
  const t = root.querySelector('table')!;
  [...t.rows].forEach((r, i) => [...r.cells].forEach((c, j) => { c.textContent = `${i}${j}`; }));
  return { root, t };
};
const grid = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelector('table')!.rows].map((r) => [...r.cells].map((c) => (c.tagName === 'TH' ? '^' : '') + (c.textContent || '_')));
};

describe('note tables', () => {
  it('makes a table with a header row', () => {
    expect(grid(tableHtml(3, 2))).toEqual([['^_', '^_'], ['_', '_'], ['_', '_']]);
  });

  it('adds and deletes rows and columns around a cell', () => {
    const { t, root } = mount();
    const cell = t.rows[1].cells[1];
    expect(grid(changedTable(cell, 'rowAbove'))).toEqual([['^00', '^01', '^02'], ['_', '_', '_'], ['10', '11', '12'], ['20', '21', '22']]);
    expect(grid(changedTable(cell, 'rowBelow'))[2]).toEqual(['_', '_', '_']);
    expect(grid(changedTable(cell, 'colLeft'))[0]).toEqual(['^00', '^_', '^01', '^02']);
    expect(grid(changedTable(cell, 'colRight'))[1]).toEqual(['10', '11', '_', '12']);
    expect(grid(changedTable(cell, 'deleteRow'))).toEqual([['^00', '^01', '^02'], ['20', '21', '22']]);
    expect(grid(changedTable(cell, 'deleteCol'))).toEqual([['^00', '^02'], ['10', '12'], ['20', '22']]);
    expect(changedTable(cell, 'deleteTable')).toBe('');
    expect(cellOf(cell.firstChild, root)).toBe(cell);
    expect(cellOf(cell.firstChild, document.createElement('div'))).toBeNull(); // only inside the editor
  });

  it('a row added from the header goes first in the body; the last row or column takes the table with it', () => {
    const { t } = mount(2, 1);
    expect(grid(changedTable(t.rows[0].cells[0], 'rowBelow'))).toEqual([['^00'], ['_'], ['10']]);
    expect(changedTable(t.rows[0].cells[0], 'deleteCol')).toBe('');
    const one = mount(1, 2).t;
    expect(changedTable(one.rows[0].cells[0], 'deleteRow')).toBe('');
  });
});

const caretIn = (node: Node) => {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
};
const caretCell = (root: HTMLElement) => cellOf(window.getSelection()!.anchorNode, root);

describe('arrow keys in note tables', () => {
  it('Down and Up keep the column', () => {
    const { root, t } = mount(3, 3);
    caretIn(t.rows[0].cells[1].firstChild!);
    expect(arrowInTable(root, true)).toBe('moved');
    expect(caretCell(root)).toBe(t.rows[1].cells[1]);
    expect(arrowInTable(root, true)).toBe('moved');
    expect(caretCell(root)).toBe(t.rows[2].cells[1]);
    expect(arrowInTable(root, false)).toBe('moved');
    expect(caretCell(root)).toBe(t.rows[1].cells[1]);
    root.remove();
  });

  it('respects colspans', () => {
    const { root, t } = mount(2, 3);
    // row 0: [00][01][02]; row 1 becomes [10 spanning two][12]
    t.rows[1].cells[0].colSpan = 2;
    t.rows[1].cells[1].remove();
    caretIn(t.rows[0].cells[1].firstChild!);
    arrowInTable(root, true);
    expect(caretCell(root)).toBe(t.rows[1].cells[0]);
    expect(cellAcross(t.rows[1].cells[1], -1)).toBe(t.rows[0].cells[2]);
    root.remove();
  });

  it('Down from the last row leaves the table, adding a paragraph only when there is nothing after it', () => {
    const { root, t } = mount(2, 2);
    caretIn(t.rows[1].cells[0].firstChild!);
    expect(arrowInTable(root, true)).toBe('changed');
    expect(t.nextElementSibling?.tagName).toBe('P');
    expect(caretCell(root)).toBeNull();
    caretIn(t.rows[1].cells[1].firstChild!);
    expect(arrowInTable(root, true)).toBe('moved'); // the paragraph is there now
    expect(root.querySelectorAll('p').length).toBe(1);
    // Up from the first row with nothing before the table is left to the browser
    caretIn(t.rows[0].cells[0].firstChild!);
    expect(arrowInTable(root, false)).toBe(false);
    root.remove();
  });

  it('Tab only moves (no change) unless it adds a row', () => {
    const { root, t } = mount(2, 2);
    caretIn(t.rows[0].cells[0].firstChild!);
    expect(tabInTable(root, false)).toBe('moved');
    expect(caretCell(root)).toBe(t.rows[0].cells[1]);
    expect(tabInTable(root, true)).toBe('moved');
    expect(caretCell(root)).toBe(t.rows[0].cells[0]);
    expect(tabInTable(document.createElement('div'), false)).toBe(false);
    root.remove();
  });
});
