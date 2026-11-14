/* Tables in the student's notes (NoteEditor). Every change is made by replacing the table's HTML through
   execCommand('insertHTML') (see `replaceTable`), so the editor's own undo and redo cover it. The first row is a
   header row (<th>). Notes keep no classes (the sanitiser drops them), so tables are styled through `.ne-page table`. */

const EMPTY = '<br>';

/** A new table: `rows` × `cols`, the first row a header. */
export function tableHtml(rows: number, cols: number): string {
  const row = (tag: 'th' | 'td') => `<tr>${Array.from({ length: cols }, () => `<${tag}>${EMPTY}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${row('th')}</thead><tbody>${Array.from({ length: Math.max(0, rows - 1), }, () => row('td')).join('')}</tbody></table>`;
}

/** The table cell (td/th) holding `node`, inside `root`. */
export function cellOf(node: Node | null, root: Element | null): HTMLTableCellElement | null {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
  const cell = el?.closest?.('td, th') as HTMLTableCellElement | null;
  return cell && root?.contains(cell) ? cell : null;
}

export type TableOp = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRow' | 'deleteCol' | 'deleteTable';

/** The table's HTML after `op` at `cell` ('' when the table goes). Rows keep the header row as the first; a row
 * added above the header is a body row placed first in the body. */
export function changedTable(cell: HTMLTableCellElement, op: TableOp): string {
  const table = cell.closest('table')!.cloneNode(true) as HTMLTableElement;
  const rows = [...table.rows];
  const orig = cell.closest('table')!;
  const r = [...orig.rows].indexOf(cell.parentElement as HTMLTableRowElement);
  const c = cell.cellIndex;
  const width = Math.max(...rows.map((x) => x.cells.length));
  const blankRow = () => {
    const tr = document.createElement('tr');
    for (let i = 0; i < width; i++) tr.appendChild(Object.assign(document.createElement('td'), { innerHTML: EMPTY }));
    return tr;
  };
  if (op === 'deleteTable') return '';
  if (op === 'rowAbove' || op === 'rowBelow') {
    const at = rows[r];
    const inHead = at.parentElement?.tagName === 'THEAD';
    if (inHead) {
      const body = table.tBodies[0] ?? table.appendChild(document.createElement('tbody'));
      body.insertBefore(blankRow(), body.firstChild);
    } else at.parentElement!.insertBefore(blankRow(), op === 'rowAbove' ? at : at.nextSibling);
  } else if (op === 'deleteRow') {
    if (rows.length <= 1) return '';
    rows[r].remove();
  } else if (op === 'colLeft' || op === 'colRight') {
    for (const row of rows) {
      const tag = row.parentElement?.tagName === 'THEAD' ? 'th' : 'td';
      const fresh = Object.assign(document.createElement(tag), { innerHTML: EMPTY });
      const ref = row.cells[op === 'colLeft' ? c : c + 1] ?? null;
      row.insertBefore(fresh, ref);
    }
  } else if (op === 'deleteCol') {
    if (width <= 1) return '';
    for (const row of rows) row.cells[c]?.remove();
  }
  return table.outerHTML;
}

/** Replace `table` with `html` as one undoable edit, then put the cursor in cell [row, col] of the new table (or
 * where the table was). */
export function replaceTable(table: HTMLTableElement, html: string, focus?: [number, number]) {
  const parent = table.parentNode!;
  const index = [...parent.childNodes].indexOf(table);
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.selectNode(table);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertHTML', false, html || EMPTY);
  if (!html || !focus) return;
  const fresh = parent.childNodes[index] as HTMLTableElement | undefined;
  const target = fresh?.rows?.[Math.min(focus[0], fresh.rows.length - 1)]?.cells?.[focus[1]];
  if (target) placeCaret(target);
}

/** Put the cursor at the start of `cell`. */
export function placeCaret(cell: HTMLTableCellElement) {
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

/** What a key did in a table: nothing (not in one), only moved the cursor, or changed the note. */
export type TableKey = false | 'moved' | 'changed';

/** Tab / Shift+Tab in a table: the next or previous cell (Tab in the last cell adds a row, which is a change). */
export function tabInTable(root: HTMLElement, back: boolean): TableKey {
  const cell = cellOf(window.getSelection()?.anchorNode ?? null, root);
  if (!cell) return false;
  const table = cell.closest('table')!;
  const cells = [...table.querySelectorAll<HTMLTableCellElement>('td, th')];
  const i = cells.indexOf(cell);
  const next = cells[i + (back ? -1 : 1)];
  if (next) { placeCaret(next); return 'moved'; }
  if (back) return 'moved';
  const row = [...table.rows].indexOf(cell.parentElement as HTMLTableRowElement);
  replaceTable(table, changedTable(cell, 'rowBelow'), [row + 1, 0]);
  return 'changed';
}

/** The column a cell starts in, counting colspans. */
const columnOf = (cell: HTMLTableCellElement) => {
  let col = 0;
  for (let c = cell.previousElementSibling; c; c = c.previousElementSibling) col += (c as HTMLTableCellElement).colSpan || 1;
  return col;
};

/** The cell in the row above (-1) or below (1) that covers `cell`'s column (the row's last cell when it's shorter),
 * or null past the table's first or last row. */
export function cellAcross(cell: HTMLTableCellElement, dir: -1 | 1): HTMLTableCellElement | null {
  const table = cell.closest('table')!;
  const rows = [...table.rows];
  const row = rows[rows.indexOf(cell.parentElement as HTMLTableRowElement) + dir];
  if (!row || !row.cells.length) return null;
  const col = columnOf(cell);
  let at = 0;
  for (const c of row.cells) {
    at += c.colSpan || 1;
    if (at > col) return c;
  }
  return row.cells[row.cells.length - 1];
}

/** Whether the cursor sits on the cell's first (up) or last (down) visual line. Without layout (no rects) it counts as
 * yes. */
function onEdgeLine(cell: HTMLTableCellElement, range: Range, down: boolean): boolean {
  const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
  const caret = rects.length ? rects[down ? rects.length - 1 : 0] : null;
  const box = cell.getBoundingClientRect();
  if (!caret || (!caret.height && !caret.top) || !box.height) return true;
  const cs = getComputedStyle(cell);
  const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.4;
  return down
    ? box.bottom - (parseFloat(cs.paddingBottom) || 0) - caret.bottom < line * 0.8
    : caret.top - box.top - (parseFloat(cs.paddingTop) || 0) < line * 0.8;
}

/** Up / Down in a table: from the cell's first or last line, the same column of the row above or below (Chromium
 * would otherwise walk the cells in document order). Down past the last row leaves the table (adding a paragraph
 * after it when there is none: a change); Up past the first row goes to what comes before it. */
export function arrowInTable(root: HTMLElement, down: boolean): TableKey {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const cell = cellOf(sel.anchorNode, root);
  if (!cell) return false;
  if (!onEdgeLine(cell, sel.getRangeAt(0), down)) return false;
  const next = cellAcross(cell, down ? 1 : -1);
  if (next) {
    const r = document.createRange();
    r.selectNodeContents(next);
    r.collapse(down); // into the row below: its start; into the row above: its end
    sel.removeAllRanges();
    sel.addRange(r);
    return 'moved';
  }
  const table = cell.closest('table')!;
  let target = (down ? table.nextElementSibling : table.previousElementSibling) as HTMLElement | null;
  let changed = false;
  if (!target) {
    if (!down) return false; // nothing above: let the browser decide
    target = Object.assign(document.createElement('p'), { innerHTML: EMPTY });
    table.after(target);
    changed = true;
  }
  const r = document.createRange();
  r.selectNodeContents(target);
  r.collapse(down);
  sel.removeAllRanges();
  sel.addRange(r);
  return changed ? 'changed' : 'moved';
}
