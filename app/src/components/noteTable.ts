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

/** Tab / Shift+Tab in a table: the next or previous cell (Tab in the last cell adds a row). Returns false when the
 * cursor isn't in a table. */
export function tabInTable(root: HTMLElement, back: boolean): boolean {
  const cell = cellOf(window.getSelection()?.anchorNode ?? null, root);
  if (!cell) return false;
  const table = cell.closest('table')!;
  const cells = [...table.querySelectorAll<HTMLTableCellElement>('td, th')];
  const i = cells.indexOf(cell);
  const next = cells[i + (back ? -1 : 1)];
  if (next) { placeCaret(next); return true; }
  if (back) return true;
  const row = [...table.rows].indexOf(cell.parentElement as HTMLTableRowElement);
  replaceTable(table, changedTable(cell, 'rowBelow'), [row + 1, 0]);
  return true;
}
