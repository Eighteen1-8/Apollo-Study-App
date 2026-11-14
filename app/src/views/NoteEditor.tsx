/* The student's own notes: a rich-text page (fonts, sizes, bold/italic/underline, colours, highlights, headings,
   lists) opened in the centre like a document, saved as they type. Notes are never ingested: Apollo only reads one
   when asked to check it or change it (right-click highlighted text, or the header), and its comments sit beside the
   page (Reviews). Spelling is checked in the language chosen in Settings (Australian English by default); right-click
   a misspelled word for suggestions. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { createPortal } from 'react-dom';
import { arrowInTable, cellOf, changedTable, placeCaret, replaceTable, tabInTable, tableHtml, TableOp } from '../components/noteTable';
import { api, Note, Quote, ReviewIssue, saveNoteOnExit, Subject } from '../api';
import { MenuItem, useOverlay } from '../components/overlay';
import Reviews, { useReviews } from '../components/Reviews';
import { useAreaShot } from '../components/areaShot';
import { exportAs } from '../components/exportDoc';
import { highlightCss, highlightRow } from '../components/highlights';
import { quoteParts, replaceText, selectionIn } from '../components/textRange';
import { logError } from '../log';
import { getPref, setPref } from '../prefs';
import Icon from '../components/Icon';
import { toggleCalculator, useCalculatorOpen } from '../components/Calculator';
import { AREA_DRAG, AreaDrag, imageHtml, QUOTE_DRAG, registerNoteInsert, takeQueued } from '../noteInsert';
import { snapshotDataUrl } from '../components/addToNotes';
import { TourButton, useFirstTime } from '../components/Tour';

const FONTS: [string, string][] = [
  ['', 'Default font'], ['Segoe UI, sans-serif', 'Segoe UI'], ['Calibri, sans-serif', 'Calibri'], ['Arial, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'], ['Times New Roman, serif', 'Times New Roman'], ['Cambria, serif', 'Cambria'],
  ['Consolas, monospace', 'Consolas'], ['Segoe Print, Comic Sans MS, cursive', 'Handwriting'],
];
const SIZES = [11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
const BLOCKS: [string, string][] = [['P', 'Normal text'], ['H1', 'Title'], ['H2', 'Heading'], ['H3', 'Subheading'], ['BLOCKQUOTE', 'Quote'], ['PRE', 'Code']];
const TEXT_COLORS: [string, string][] = [
  ['#ef4444', 'Red'], ['#f97316', 'Orange'], ['#eab308', 'Yellow'], ['#22c55e', 'Green'], ['#3b82f6', 'Blue'],
  ['#8b5cf6', 'Purple'], ['#ec4899', 'Pink'], ['#9ca3af', 'Grey'],
];
/** Formatting whose on/off state the toolbar shows. */
const STATES = ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'insertUnorderedList',
  'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'] as const;
type FormatState = Partial<Record<(typeof STATES)[number], boolean>>;

/** What may be pasted or loaded: formatting and text only (data: images allowed), nothing that runs. */
const clean = (html: string) => DOMPurify.sanitize(html, {
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'video', 'audio'],
  FORBID_ATTR: ['id', 'class', 'srcset', 'action', 'formaction'],
});

export default function NoteEditor({ id, subject, onClose, onAsk, onAttach }: {
  id: number; subject: Subject; onClose: () => void; onAsk: (q: Quote) => void; onAttach: (paths: string[]) => void;
}) {
  const ov = useOverlay();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [showReviews, setShowReviews] = useState(false);
  const [block, setBlock] = useState('P');
  const [size, setSizeShown] = useState('');
  const [fmt, setFmt] = useState<FormatState>({});
  // the last colours used: the colour buttons apply them in one click
  const [textColor, setTextColor] = useState(() => getPref('noteTextColor', '#ef4444'));
  const [hlColor, setHlColor] = useState(() => getPref('noteHighlight', 'yellow'));
  const editor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dirty = useRef(false);
  const reviews = useReviews('note', id);
  const active = (reviews.data ?? []).length;
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !reviews.data) return;
    opened.current = true;
    if (reviews.data.some((r) => r.status === 'queued' || r.status === 'running' || (r.status === 'ready' && !r.applied))) setShowReviews(true);
  }, [reviews.data]);
  const shot = useAreaShot(title || 'note', onAttach, (msg) => ov.confirm({ title: "Couldn't take a screenshot", body: msg, confirmText: 'OK' }));

  const loads = useRef(0);
  const insertRef = useRef<(html: string) => void>(() => {});
  const load = useCallback(async () => {
    const mine = ++loads.current;
    const n = await api.note(id);
    if (mine !== loads.current) return; // a newer load is on its way (StrictMode runs the effect twice): it sets the page
    setNote(n);
    setTitle(n.title);
    if (editor.current) editor.current.innerHTML = clean(n.html);
    dirty.current = false;
    setState('saved');
    // content sent here before the note was open ("Add to notes" → a note picked or made): only now, after the page
    // is filled, so a load can never wipe it
    takeQueued(id).forEach((html) => insertRef.current(clean(html)));
  }, [id]);
  useEffect(() => { load().catch((e) => logError('opening a note', e)); }, [load]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current || !editor.current) return;
    dirty.current = false;
    setState('saving');
    try {
      await api.saveNote(id, { html: editor.current.innerHTML });
      setState((s) => (dirty.current ? s : 'saved'));
    } catch (e) {
      dirty.current = true;
      setState('error');
      logError('saving a note', e);
    }
  }, [id]);
  const changed = () => {
    dirty.current = true;
    setState('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 700);
  };
  // Save what's left when the note closes. A layout effect: by the time an ordinary effect's cleanup runs on unmount,
  // React has already cleared `editor.current`, and the last second of typing was silently dropped.
  useLayoutEffect(() => () => {
    clearTimeout(timer.current);
    if (dirty.current && editor.current) {
      dirty.current = false;
      api.saveNote(id, { html: editor.current.innerHTML }).catch((e) => logError('saving a note', e));
    }
  }, [id]);
  // ...and when the window itself closes or reloads
  useEffect(() => {
    const flush = () => { if (dirty.current && editor.current) { dirty.current = false; saveNoteOnExit(id, editor.current.innerHTML); } };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [id]);

  // ---- "Insert into the open note" (noteInsert.ts: the calculator, Add to notes from a file or the chat): where the
  // cursor last was in the page (the other panel has the focus by then), or the end, through insertHTML so Ctrl+Z
  // takes it out again
  const lastRange = useRef<Range | null>(null);
  const insertAt = (html: string, at?: Range | null) => {
    const root = editor.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection()!;
    let r = at ?? lastRange.current;
    if (!r || !root.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(root); r.collapse(false); }
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('insertHTML', false, html);
    changed();
  };
  const titleRef = useRef(title);
  titleRef.current = title;
  useEffect(() => {
    const keep = () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && editor.current?.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', keep);
    const off = registerNoteInsert((html) => insertAt(html), { noteId: id, title: () => titleRef.current || 'Untitled note' });
    return () => { document.removeEventListener('selectionchange', keep); off(); };
  }, [save]); // eslint-disable-line react-hooks/exhaustive-deps
  insertRef.current = insertAt;

  // ---- drops: a quote dragged from a file or the chat (QUOTE_DRAG, with its source line) goes in at the drop point;
  // a screenshot area of a file (AREA_DRAG) is taken first, then put where it was dropped. Anything else (moving text
  // within the note) is left to the browser.
  const rangeAt = (x: number, y: number): Range | null => {
    const r = document.caretRangeFromPoint?.(x, y) ?? null;
    return r && editor.current?.contains(r.startContainer) ? r : null;
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(AREA_DRAG) && !e.dataTransfer.types.includes(QUOTE_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    if (dt.types.includes(AREA_DRAG)) {
      e.preventDefault();
      const a = JSON.parse(dt.getData(AREA_DRAG)) as AreaDrag;
      const at = rangeAt(e.clientX, e.clientY);
      snapshotDataUrl(a).then((src) => insertAt(imageHtml(src, a.source), at))
        .catch((err) => ov.confirm({ title: "Couldn't take a screenshot", body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }));
    } else if (dt.types.includes(QUOTE_DRAG) && dt.getData('text/html')) {
      e.preventDefault();
      insertAt(clean(dt.getData('text/html')), rangeAt(e.clientX, e.clientY));
    }
  };
  const calcOpen = useCalculatorOpen();
  useFirstTime('notes', !!note);

  const saveTitle = async (t: string) => {
    const v = t.trim() || 'Untitled note';
    setTitle(v);
    if (note && v !== note.title) setNote(await api.saveNote(id, { title: v }));
  };

  // ---- what the toolbar shows: paragraph style, size, and which formatting is on where the cursor is
  const track = useCallback(() => {
    const sel = window.getSelection();
    if (!editor.current || !sel?.rangeCount || !editor.current.contains(sel.anchorNode)) return;
    const v = String(document.queryCommandValue('formatBlock') || 'p').toUpperCase();
    setBlock(BLOCKS.some(([k]) => k === v) ? v : 'P');
    const next: FormatState = {};
    for (const c of STATES) { try { next[c] = document.queryCommandState(c); } catch { /* unsupported */ } }
    setFmt((f) => (STATES.every((c) => !!f[c] === !!next[c]) ? f : next));
    const n = sel.anchorNode;
    const el = n?.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element | null);
    const px = el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0;
    setSizeShown(SIZES.includes(px) ? String(px) : '');
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', track);
    return () => document.removeEventListener('selectionchange', track);
  }, [track]);

  // ---- formatting (execCommand keeps the browser's own undo history working)
  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    changed();
    track();
  };
  const setSize = (px: number) => {
    editor.current?.focus();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand('fontSize', false, '7'); // marks the selection with <font size="7">, swapped for a real size
    editor.current?.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      span.append(...f.childNodes);
      f.replaceWith(span);
    });
    changed();
    track();
  };
  const highlight = (color: string) => {
    exec('hiliteColor', color === 'transparent' ? 'transparent' : highlightCss(color));
    if (color !== 'transparent') { setHlColor(color); setPref('noteHighlight', color); }
  };
  const foreColor = (c: string) => {
    exec('foreColor', c || 'inherit');
    if (c) { setTextColor(c); setPref('noteTextColor', c); }
  };
  /** A dialog takes the focus (and the selection) away: keep the selection and put it back before applying. */
  const withSelection = async (pick: () => Promise<string | null>, apply: (c: string) => void) => {
    const sel = window.getSelection();
    const saved = sel?.rangeCount && editor.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const c = await pick();
    if (!c) return;
    editor.current?.focus();
    if (saved) { sel?.removeAllRanges(); sel?.addRange(saved); }
    apply(c);
  };
  const customHighlight = () => withSelection(() => ov.color({ title: 'Highlight colour', initial: hlColor.startsWith('#') ? hlColor : undefined }), highlight);
  const customText = () => withSelection(() => ov.color({ title: 'Text colour', initial: textColor,
    presets: [...TEXT_COLORS.map(([c]) => c), '#111827', '#ffffff'] }), foreColor);

  const onPaste = (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData('text/html');
    if (!html) return; // plain text: the browser inserts it as is
    e.preventDefault();
    document.execCommand('insertHTML', false, clean(html));
    changed();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    // Tab moves between table cells (Tab in the last cell adds a row); Up/Down keep the column. Only a real change saves.
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const done = !editor.current || !plain ? false
      : e.key === 'Tab' ? tabInTable(editor.current, e.shiftKey)
      : (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey ? arrowInTable(editor.current, e.key === 'ArrowDown')
      : false;
    if (done) { e.preventDefault(); if (done === 'changed') changed(); placeRing(); }
  };

  // ---- the ring around the table cell holding the cursor (the page has the focus, so `td:focus-within` never matches,
  // and a class on the cell would be saved with the note)
  const scroller = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const placeRing = useCallback(() => {
    const sel = window.getSelection();
    const cell = sel?.rangeCount && document.activeElement === editor.current ? cellOf(sel.anchorNode, editor.current) : null;
    const box = scroller.current;
    if (!cell || !box) { setRing((r) => (r ? null : r)); return; }
    const c = cell.getBoundingClientRect(), b = box.getBoundingClientRect();
    const next = { top: c.top - b.top + box.scrollTop, left: c.left - b.left + box.scrollLeft, width: c.width, height: c.height };
    setRing((r) => (r && r.top === next.top && r.left === next.left && r.width === next.width && r.height === next.height ? r : next));
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', placeRing);
    window.addEventListener('resize', placeRing);
    return () => { document.removeEventListener('selectionchange', placeRing); window.removeEventListener('resize', placeRing); };
  }, [placeRing]);

  // ---- tables
  const [tablePick, setTablePick] = useState<DOMRect | null>(null);
  /** A new table where the cursor is (after the table it's in, if any: tables don't nest), cursor in its first cell. */
  const insertTable = (rows: number, cols: number) => {
    setTablePick(null);
    const root = editor.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection()!;
    if (!sel.rangeCount || !root.contains(sel.anchorNode)) { const r = document.createRange(); r.selectNodeContents(root); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    const inTable = cellOf(sel.anchorNode, root)?.closest('table');
    if (inTable) { const r = document.createRange(); r.setStartAfter(inTable); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    const before = new Set(root.querySelectorAll('table'));
    document.execCommand('insertHTML', false, tableHtml(rows, cols) + '<p><br></p>');
    const fresh = [...root.querySelectorAll('table')].find((t) => !before.has(t));
    const first = fresh?.rows[0]?.cells[0];
    if (first) placeCaret(first);
    changed();
  };
  const tableOp = (cell: HTMLTableCellElement, op: TableOp) => {
    const table = cell.closest('table')!;
    const r = [...table.rows].indexOf(cell.parentElement as HTMLTableRowElement), c = cell.cellIndex;
    const focus: [number, number] = op === 'rowBelow' ? [r + 1, c] : op === 'colRight' ? [r, c + 1]
      : op === 'deleteRow' ? [Math.max(0, r - 1), c] : op === 'deleteCol' ? [r, Math.max(0, c - 1)] : [r, c];
    editor.current?.focus();
    replaceTable(table, changedTable(cell, op), focus);
    changed();
  };
  const tableItems = (cell: HTMLTableCellElement | null): MenuItem[] => (cell ? [{
    label: 'Table', separatorBefore: true, children: [
      { label: 'Insert row above', onClick: () => tableOp(cell, 'rowAbove') },
      { label: 'Insert row below', onClick: () => tableOp(cell, 'rowBelow') },
      { label: 'Insert column left', onClick: () => tableOp(cell, 'colLeft'), separatorBefore: true },
      { label: 'Insert column right', onClick: () => tableOp(cell, 'colRight') },
      { label: 'Delete row', onClick: () => tableOp(cell, 'deleteRow'), separatorBefore: true },
      { label: 'Delete column', onClick: () => tableOp(cell, 'deleteCol') },
      { label: 'Delete table', danger: true, onClick: () => tableOp(cell, 'deleteTable') },
    ],
  }] : []);

  // ---- Apollo
  const quoteOf = (r: Range): Quote => ({ document_id: null, filename: title || 'My note', label: 'My notes', ...quoteParts(editor.current!, r) });
  const check = (quote = '') => api.startReview({ target: 'note', target_id: id, mode: 'check', quote })
    .then(() => { setShowReviews(true); reviews.reload(); });
  const revise = async (quote = '') => {
    const instruction = await ov.prompt({
      title: quote ? 'What should Apollo change here?' : 'What should Apollo change in this note?',
      placeholder: 'e.g. add the units, explain it more simply, fix the formula', confirmText: 'Ask Apollo',
    });
    if (!instruction) return;
    await save();
    await api.startReview({ target: 'note', target_id: id, mode: 'revise', quote, instruction });
    setShowReviews(true);
    reviews.reload();
  };
  const fixIssue = async (issue: ReviewIssue) => {
    if (!editor.current || !replaceText(editor.current, issue.quote, issue.fix)) return false;
    changed();
    await save();
    return true;
  };

  const paste = async () => {
    editor.current?.focus();
    if (document.execCommand('paste')) return;
    try { document.execCommand('insertText', false, await navigator.clipboard.readText()); changed(); } catch { /* clipboard unavailable */ }
  };

  /** Spelling suggestions for a misspelled word Chromium found under the pointer, as menu items. */
  const spellingItems = (sp: { misspelledWord: string; suggestions: string[] } | null): MenuItem[] => {
    const spell = window.studyApp?.spell;
    if (!spell || !sp?.misspelledWord) return [];
    const word = sp.misspelledWord;
    return [
      { label: `Spelling: “${word}”`, header: true },
      ...(sp.suggestions.length
        ? sp.suggestions.slice(0, 5).map((s) => ({ label: s, onClick: () => { editor.current?.focus(); spell.replace(s).then(changed); } }))
        : [{ label: 'No suggestions', disabled: true }]),
      { label: 'Add to dictionary', onClick: () => { spell.add(word); } },
    ];
  };

  const contextMenu = (e: React.MouseEvent) => {
    const area = shot.takeMenu();
    if (area) { ov.menu(e, area); return; }
    const r = selectionIn(editor.current);
    const cell = cellOf(e.target as Node, editor.current);
    const spell = window.studyApp?.spell;
    // a right-click in the text: Chromium knows whether the word there is misspelled, but only tells us if the event
    // isn't cancelled, so let it through and open our menu once the answer is back
    if (!r && spell && editor.current?.contains(e.target as Node)) {
      e.stopPropagation();
      const at = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
      spell.menuParams().then((sp) => ov.menu(at, buildMenu(null, spellingItems(sp), cell)));
      return;
    }
    ov.menu(e, buildMenu(r, [], cell));
  };

  const buildMenu = (r: Range | null, spelling: MenuItem[], cell: HTMLTableCellElement | null = null): MenuItem[] => {
    const items: MenuItem[] = [...spelling];
    if (r) {
      const text = r.toString().trim();
      items.push(
        { label: 'Ask Apollo about this', onClick: () => onAsk(quoteOf(r)) },
        { label: 'Check this with Apollo', onClick: () => { check(text); } },
        { label: 'Ask Apollo to change this…', onClick: () => { revise(text); } },
        { ...highlightRow({ onPick: highlight, onCustom: customHighlight, onRemove: () => highlight('transparent') }), separatorBefore: true },
        { label: 'Cut', hint: 'Ctrl+X', separatorBefore: true, onClick: () => { document.execCommand('cut'); changed(); } },
        { label: 'Copy', hint: 'Ctrl+C', onClick: () => document.execCommand('copy') },
      );
    } else {
      items.push(
        { label: 'Check the whole note with Apollo', separatorBefore: spelling.length > 0, onClick: () => { save().then(() => check()); } },
        { label: 'Ask Apollo to change the note…', onClick: () => { revise(); } },
      );
    }
    items.push(...tableItems(cell));
    items.push(
      { label: 'Paste', hint: 'Ctrl+V', separatorBefore: !r || !!cell, onClick: paste },
      { label: 'Select all', hint: 'Ctrl+A', onClick: () => { editor.current?.focus(); document.execCommand('selectAll'); } },
      { label: 'Tip: right-drag to screenshot an area', disabled: true, separatorBefore: true, onClick: () => {} },
    );
    return items;
  };

  const exportMenu = (e: React.MouseEvent) => ov.menu(e, (['docx', 'pdf'] as const).map((f) => ({
    label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
    onClick: async () => {
      await save();
      try { await exportAs(f, title || 'Note', () => clean(editor.current?.innerHTML ?? '')); }
      catch (err) { ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }); }
    },
  })), { anchor: e.currentTarget, place: 'below' });

  /** A toolbar button. `on`: shown pressed (bold where the cursor is…). The mousedown is cancelled so the editor keeps
   * its selection. */
  const tb = (label: React.ReactNode, tip: string, onClick: () => void, on?: boolean, cls = '') => (
    <button className={`ne-btn${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`} data-tip={tip} aria-label={tip} aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  const colourPopover = (e: React.MouseEvent, kind: 'text' | 'hilite') => {
    e.preventDefault();
    ov.menu(e, kind === 'hilite'
      ? [highlightRow({ current: hlColor, onPick: highlight, onCustom: customHighlight, onRemove: () => highlight('transparent') })]
      : [{
        label: 'Text colour',
        swatches: [
          ...TEXT_COLORS.map(([c, l]) => ({ color: c, label: l, active: c === textColor, onClick: () => foreColor(c) })),
          { color: '', label: 'Custom colour…', kind: 'custom' as const, onClick: customText },
          { color: '', label: 'Automatic', kind: 'none' as const, onClick: () => foreColor('') },
        ],
      }],
    { anchor: e.currentTarget.parentElement, place: 'below' });
  };

  return (
    <div className={`source note-editor${showReviews ? ' with-reviews' : ''}`}>
      <header className="source-head">
        <input className="ne-title" value={title} placeholder="Untitled note" onChange={(e) => setTitle(e.target.value)}
          onBlur={(e) => saveTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <select className="ne-topic" value={note?.topic_id ?? ''} title="Which topic this note is about (Apollo checks it against that material)"
          onChange={async (e) => setNote(await api.saveNote(id, { topic_id: e.target.value ? Number(e.target.value) : null, set_topic: true }))}>
          <option value="">All of {subject.name}</option>
          {subject.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span className={`ne-state ${state}`}>{{ saved: 'Saved', saving: 'Saving…', unsaved: 'Editing…', error: 'Not saved' }[state]}</span>
        <button className="btn btn-sm" data-tip="Have Apollo check this note against your material" onClick={() => { save().then(() => check()); }}>Check with Apollo</button>
        <button className={`btn btn-sm${showReviews ? ' on' : ''}`} onClick={() => setShowReviews(!showReviews)}>
          Comments{active ? ` (${active})` : ''}
        </button>
        <button className="btn btn-sm" onClick={exportMenu}>Export <Icon name="chevronDown" size={14} /></button>
        <TourButton id="notes" />
        <button className="close-x" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </header>
      <div className="ne-toolbar" role="toolbar" aria-label="Formatting">
        <div className="ne-group">
          <select className="ne-select ne-block" value={block} aria-label="Paragraph style" data-tip="Paragraph style"
            onChange={(e) => { setBlock(e.target.value); exec('formatBlock', e.target.value); }}>
            {BLOCKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="ne-select ne-font" defaultValue="" aria-label="Font" data-tip="Font"
            onChange={(e) => { exec('fontName', e.target.value || 'inherit'); e.target.value = ''; }}>
            {FONTS.map(([v, l]) => <option key={l} value={v} style={{ fontFamily: v || undefined }}>{l}</option>)}
          </select>
          <select className="ne-select ne-size" value={size} aria-label="Text size" data-tip="Text size"
            onChange={(e) => { if (e.target.value) setSize(Number(e.target.value)); }}>
            <option value="">Size</option>
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="ne-group">
          {tb(<b>B</b>, 'Bold (Ctrl+B)', () => exec('bold'), fmt.bold)}
          {tb(<i>I</i>, 'Italic (Ctrl+I)', () => exec('italic'), fmt.italic)}
          {tb(<u>U</u>, 'Underline (Ctrl+U)', () => exec('underline'), fmt.underline)}
          {tb(<s>S</s>, 'Strikethrough', () => exec('strikeThrough'), fmt.strikeThrough)}
          {tb(<>x<sub>2</sub></>, 'Subscript', () => exec('subscript'), fmt.subscript)}
          {tb(<>x<sup>2</sup></>, 'Superscript', () => exec('superscript'), fmt.superscript)}
        </div>
        <div className="ne-group">
          <span className="ne-split">
            <button className="ne-btn ne-color" data-tip="Text colour" aria-label="Text colour" onMouseDown={(e) => e.preventDefault()} onClick={() => foreColor(textColor)}>
              <span className="ne-a">A</span><span className="ne-swatch" style={{ background: textColor }} />
            </button>
            <button className="ne-btn ne-caret" data-tip="More text colours" aria-label="More text colours" onMouseDown={(e) => e.preventDefault()} onClick={(e) => colourPopover(e, 'text')}><Icon name="chevronDown" size={12} /></button>
          </span>
          <span className="ne-split">
            <button className="ne-btn ne-hl" data-tip="Highlight" aria-label="Highlight" onMouseDown={(e) => e.preventDefault()} onClick={() => highlight(hlColor)}>
              <HighlighterIcon /><span className="ne-swatch" style={{ background: highlightCss(hlColor) }} />
            </button>
            <button className="ne-btn ne-caret" data-tip="Highlight colours" aria-label="Highlight colours" onMouseDown={(e) => e.preventDefault()} onClick={(e) => colourPopover(e, 'hilite')}><Icon name="chevronDown" size={12} /></button>
          </span>
        </div>
        <div className="ne-group">
          {tb(<ListIcon kind="bullet" />, 'Bulleted list', () => exec('insertUnorderedList'), fmt.insertUnorderedList)}
          {tb(<ListIcon kind="number" />, 'Numbered list', () => exec('insertOrderedList'), fmt.insertOrderedList)}
          {tb(<IndentIcon out />, 'Decrease indent', () => exec('outdent'))}
          {tb(<IndentIcon />, 'Increase indent', () => exec('indent'))}
        </div>
        <div className="ne-group ne-seg" role="group" aria-label="Alignment">
          {tb(<AlignIcon a="left" />, 'Align left', () => exec('justifyLeft'), fmt.justifyLeft)}
          {tb(<AlignIcon a="center" />, 'Centre', () => exec('justifyCenter'), fmt.justifyCenter)}
          {tb(<AlignIcon a="right" />, 'Align right', () => exec('justifyRight'), fmt.justifyRight)}
        </div>
        <div className="ne-group">
          <button className={`ne-btn${tablePick ? ' on' : ''}`} data-tip="Table" aria-label="Insert a table" aria-expanded={!!tablePick}
            onMouseDown={(e) => { e.preventDefault(); setTablePick(tablePick ? null : e.currentTarget.getBoundingClientRect()); }}>
            <TableIcon />
          </button>
          {tb(<RuleIcon />, 'Horizontal line', () => exec('insertHorizontalRule'))}
          {tb(<ClearIcon />, 'Clear formatting', () => { exec('removeFormat'); exec('formatBlock', 'P'); })}
        </div>
        <div className="ne-group">
          <button className={`ne-btn tool-calc${calcOpen ? ' on' : ''}`} data-tip={calcOpen ? 'Close the calculator' : 'Calculator and graphs (it can insert results into this note)'}
            aria-label="Calculator" aria-pressed={calcOpen} onMouseDown={(e) => e.preventDefault()} onClick={toggleCalculator}>
            <Icon name="calculator" size={16} />
          </button>
        </div>
        <span className="ne-fill" />
        <div className="ne-group">
          {tb(<UndoIcon />, 'Undo (Ctrl+Z)', () => exec('undo'))}
          {tb(<UndoIcon redo />, 'Redo (Ctrl+Y)', () => exec('redo'))}
        </div>
      </div>
      <div className="ne-body">
        <div ref={scroller} className="ne-scroll" onPointerDown={shot.onPointerDown} onContextMenu={contextMenu}>
          <div ref={editor} className="ne-page" contentEditable suppressContentEditableWarning spellCheck data-find="this note"
            data-placeholder="Start writing… (these notes are yours: they're never added to the material Apollo learns from)"
            onInput={() => { changed(); placeRing(); }} onPaste={onPaste} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} onBlur={() => { save(); placeRing(); }} onFocus={placeRing} />
          {ring && <div className="ne-cell-ring" style={ring} aria-hidden />}
        </div>
        {showReviews && (
          <Reviews target="note" id={id} list={reviews.data ?? []} onApplied={() => { reviews.reload(); load(); }}
            onFix={fixIssue} onClose={() => setShowReviews(false)} />
        )}
      </div>
      {shot.overlay}
      {tablePick && <TablePicker at={tablePick} onPick={insertTable} onClose={() => setTablePick(null)} />}
    </div>
  );
}

/** Pick a table's size by pointing at a grid (up to 10 × 8). */
function TablePicker({ at, onPick, onClose }: { at: DOMRect; onPick: (rows: number, cols: number) => void; onClose: () => void }) {
  const [hover, setHover] = useState<[number, number]>([2, 2]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  // below the button, or above it when there's no room below
  const [top, setTop] = useState(at.bottom + 6);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    if (at.bottom + 6 + h > window.innerHeight - 8 && at.top - 6 - h >= 8) setTop(at.top - 6 - h);
  }, [at]);
  const ROWS = 10, COLS = 8;
  return createPortal(
    <div ref={box} className="table-pick" style={{ top, left: Math.max(8, Math.min(at.left, window.innerWidth - 230)) }}
      onMouseDown={(e) => e.preventDefault()}>
      <div className="table-pick-grid" style={{ gridTemplateColumns: `repeat(${COLS}, 18px)` }}>
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const r = Math.floor(i / COLS) + 1, c = (i % COLS) + 1;
          return <button key={i} className={`table-pick-cell${r <= hover[0] && c <= hover[1] ? ' on' : ''}`}
            aria-label={`${r} by ${c}`} onMouseEnter={() => setHover([r, c])} onClick={() => onPick(r, c)} />;
        })}
      </div>
      <div className="table-pick-size">{hover[0]} × {hover[1]} <span className="muted">(rows × columns, header row first)</span></div>
    </div>,
    document.body,
  );
}

const svg = (children: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
function AlignIcon({ a }: { a: 'left' | 'center' | 'right' }) {
  const rows = [[2, 14], [2, 10], [2, 14], [2, 8]].map(([x, w], i) => {
    const width = i % 2 ? w : 12;
    const left = a === 'left' ? x : a === 'right' ? 14 - width : (16 - width) / 2;
    return <line key={i} x1={left} x2={left + width} y1={3 + i * 3.4} y2={3 + i * 3.4} />;
  });
  return svg(rows);
}
const ListIcon = ({ kind }: { kind: 'bullet' | 'number' }) => svg(<>
  {kind === 'bullet'
    ? <><circle cx="2.8" cy="4" r="1" fill="currentColor" stroke="none" /><circle cx="2.8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="2.8" cy="12" r="1" fill="currentColor" stroke="none" /></>
    : <text x="0.6" y="13.4" fontSize="6.5" fill="currentColor" stroke="none" fontFamily="sans-serif">1.</text>}
  <path d="M6 4h8M6 8h8M6 12h8" />
</>);
const IndentIcon = ({ out }: { out?: boolean }) => svg(<>
  <path d="M7 6h7M7 10h7M2 3h12M2 13h12" />
  <path d={out ? 'M4.5 6 2.5 8l2 2' : 'M2.5 6l2 2-2 2'} />
</>);
const TableIcon = () => svg(<><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6.5h12M2 10h12M6.3 3v10M10 3v10" /></>);
const RuleIcon = () => svg(<><path d="M2 8h12" /><path d="M2 4h5M2 12h8" strokeOpacity="0.4" /></>);
const ClearIcon = () => svg(<><path d="M3 3h8M7 3 5 13" /><path d="m10 9 4 4M14 9l-4 4" /></>);
const UndoIcon = ({ redo }: { redo?: boolean }) => svg(
  <g transform={redo ? 'matrix(-1 0 0 1 16 0)' : undefined}><path d="M5.5 9 2.5 6l3-3" /><path d="M2.5 6h7a4 4 0 0 1 0 8H7" /></g>,
);
const HighlighterIcon = () => svg(<><path d="m9.5 2.5 4 4-6 6H4.5v-3z" /><path d="M3 14h4" /></>);
