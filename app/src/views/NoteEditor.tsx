/* The student's own notes: a rich-text page (fonts, sizes, bold/italic/underline, colours, highlights, headings,
   lists) opened in the centre like a document, saved as they type. Notes are never ingested: Apollo only reads one
   when asked to check it or change it (right-click highlighted text, or the header), and its comments sit beside the
   page (Reviews). */
import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api, Note, Quote, ReviewIssue, Subject } from '../api';
import { MenuItem, useOverlay } from '../components/overlay';
import Reviews, { useReviews } from '../components/Reviews';
import { useAreaShot } from '../components/areaShot';
import { exportAs } from '../components/exportDoc';
import { quoteParts, replaceText, selectionIn } from '../components/textRange';
import { logError } from '../log';

const FONTS: [string, string][] = [
  ['', 'Default font'], ['Segoe UI, sans-serif', 'Segoe UI'], ['Calibri, sans-serif', 'Calibri'], ['Arial, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'], ['Times New Roman, serif', 'Times New Roman'], ['Cambria, serif', 'Cambria'],
  ['Consolas, monospace', 'Consolas'], ['Segoe Print, Comic Sans MS, cursive', 'Handwriting'],
];
const SIZES = [11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
const BLOCKS: [string, string][] = [['P', 'Normal text'], ['H1', 'Title'], ['H2', 'Heading'], ['H3', 'Subheading'], ['BLOCKQUOTE', 'Quote'], ['PRE', 'Code']];
export const HL_COLORS: { name: string; css: string }[] = [
  { name: 'Yellow', css: '#fde047' }, { name: 'Green', css: '#86efac' }, { name: 'Blue', css: '#93c5fd' },
  { name: 'Pink', css: '#f9a8d4' }, { name: 'Orange', css: '#fdba74' },
];
const TEXT_COLORS = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#9ca3af'];

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

  const load = useCallback(async () => {
    const n = await api.note(id);
    setNote(n);
    setTitle(n.title);
    if (editor.current) editor.current.innerHTML = clean(n.html);
    dirty.current = false;
    setState('saved');
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
  // save what's left when the note closes
  useEffect(() => () => { if (dirty.current && editor.current) api.saveNote(id, { html: editor.current.innerHTML }).catch((e) => logError('saving a note', e)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTitle = async (t: string) => {
    const v = t.trim() || 'Untitled note';
    setTitle(v);
    if (note && v !== note.title) setNote(await api.saveNote(id, { title: v }));
  };

  // ---- formatting (execCommand keeps the browser's own undo history working)
  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    changed();
    trackBlock();
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
  };
  const highlight = (css: string) => exec('hiliteColor', css);
  const trackBlock = () => {
    const v = String(document.queryCommandValue('formatBlock') || 'p').toUpperCase();
    setBlock(BLOCKS.some(([k]) => k === v) ? v : 'P');
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData('text/html');
    if (!html) return; // plain text: the browser inserts it as is
    e.preventDefault();
    document.execCommand('insertHTML', false, clean(html));
    changed();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  };

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

  const contextMenu = (e: React.MouseEvent) => {
    const area = shot.takeMenu();
    if (area) { ov.menu(e, area); return; }
    const r = selectionIn(editor.current);
    const items: MenuItem[] = [];
    if (r) {
      const text = r.toString().trim();
      items.push(
        { label: 'Ask Apollo about this', onClick: () => onAsk(quoteOf(r)) },
        { label: 'Check this with Apollo', onClick: () => { check(text); } },
        { label: 'Ask Apollo to change this…', onClick: () => { revise(text); } },
        ...HL_COLORS.map((c, i) => ({ label: `Highlight ${c.name.toLowerCase()}`, separatorBefore: i === 0, onClick: () => highlight(c.css) })),
        { label: 'Remove highlight', onClick: () => highlight('transparent') },
        { label: 'Cut', separatorBefore: true, onClick: () => { document.execCommand('cut'); changed(); } },
        { label: 'Copy', onClick: () => document.execCommand('copy') },
      );
    } else {
      items.push(
        { label: 'Check the whole note with Apollo', onClick: () => { save().then(() => check()); } },
        { label: 'Ask Apollo to change the note…', onClick: () => { revise(); } },
      );
    }
    items.push(
      { label: 'Paste', separatorBefore: !r, onClick: paste },
      { label: 'Select all', onClick: () => { editor.current?.focus(); document.execCommand('selectAll'); } },
      { label: 'Tip: right-drag to screenshot an area', disabled: true, separatorBefore: true, onClick: () => {} },
    );
    ov.menu(e, items);
  };

  const exportMenu = (e: React.MouseEvent) => ov.menu(e, (['docx', 'pdf'] as const).map((f) => ({
    label: f === 'docx' ? 'Word document (.docx)' : 'PDF',
    onClick: async () => {
      await save();
      try { await exportAs(f, title || 'Note', () => clean(editor.current?.innerHTML ?? '')); }
      catch (err) { ov.confirm({ title: 'Export failed', body: String(err).replace(/^Error: /, ''), confirmText: 'OK' }); }
    },
  })), { anchor: e.currentTarget, place: 'below' });

  const tb = (label: React.ReactNode, tip: string, onClick: () => void, cls = '') => (
    <button className={`ne-btn ${cls}`} data-tip={tip} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  const colorMenu = (e: React.MouseEvent, kind: 'fore' | 'hilite') => {
    e.preventDefault();
    ov.menu(e, kind === 'hilite'
      ? [...HL_COLORS.map((c) => ({ label: c.name, onClick: () => highlight(c.css) })), { label: 'None', separatorBefore: true, onClick: () => highlight('transparent') }]
      : TEXT_COLORS.map((c) => ({ label: c ? c : 'Automatic', onClick: () => exec('foreColor', c || 'inherit') })),
    { anchor: e.currentTarget, place: 'below' });
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
        <button className="btn btn-sm" onClick={exportMenu}>Export ▾</button>
        <button className="close-x" title="Close" onClick={onClose}>×</button>
      </header>
      <div className="ne-toolbar" role="toolbar" aria-label="Formatting">
        <select className="ne-select" value={block}
          onChange={(e) => { setBlock(e.target.value); exec('formatBlock', e.target.value); }} title="Paragraph style">
          {BLOCKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="ne-select" defaultValue="" onChange={(e) => { exec('fontName', e.target.value || 'inherit'); e.target.value = ''; }} title="Font">
          {FONTS.map(([v, l]) => <option key={l} value={v} style={{ fontFamily: v || undefined }}>{l}</option>)}
        </select>
        <select className="ne-select ne-size" defaultValue="" onChange={(e) => { if (e.target.value) setSize(Number(e.target.value)); e.target.value = ''; }} title="Text size">
          <option value="">Size</option>
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="ne-sep" />
        {tb(<b>B</b>, 'Bold (Ctrl+B)', () => exec('bold'))}
        {tb(<i>I</i>, 'Italic (Ctrl+I)', () => exec('italic'))}
        {tb(<u>U</u>, 'Underline (Ctrl+U)', () => exec('underline'))}
        {tb(<s>S</s>, 'Strikethrough', () => exec('strikeThrough'))}
        {tb(<>x<sub>2</sub></>, 'Subscript', () => exec('subscript'))}
        {tb(<>x<sup>2</sup></>, 'Superscript', () => exec('superscript'))}
        <span className="ne-sep" />
        <button className="ne-btn ne-color" data-tip="Text colour" onMouseDown={(e) => colorMenu(e, 'fore')}>A<span className="ne-swatch" style={{ background: 'linear-gradient(90deg,#ef4444,#3b82f6)' }} /></button>
        <button className="ne-btn ne-hl" data-tip="Highlight yellow (click) · other colours (right-click)"
          onMouseDown={(e) => { e.preventDefault(); if (e.button === 0) highlight(HL_COLORS[0].css); }}
          onContextMenu={(e) => colorMenu(e, 'hilite')}>
          <span className="ne-hl-mark">ab</span>
        </button>
        <button className="ne-btn" data-tip="More highlight colours" onMouseDown={(e) => colorMenu(e, 'hilite')}>▾</button>
        <span className="ne-sep" />
        {tb('•', 'Bulleted list', () => exec('insertUnorderedList'))}
        {tb('1.', 'Numbered list', () => exec('insertOrderedList'))}
        {tb('⇤', 'Decrease indent', () => exec('outdent'))}
        {tb('⇥', 'Increase indent', () => exec('indent'))}
        <span className="ne-sep" />
        {tb(<AlignIcon a="left" />, 'Align left', () => exec('justifyLeft'))}
        {tb(<AlignIcon a="center" />, 'Centre', () => exec('justifyCenter'))}
        {tb(<AlignIcon a="right" />, 'Align right', () => exec('justifyRight'))}
        <span className="ne-sep" />
        {tb('—', 'Horizontal line', () => exec('insertHorizontalRule'))}
        {tb('⌫', 'Clear formatting', () => { exec('removeFormat'); exec('formatBlock', 'P'); })}
        {tb('↶', 'Undo (Ctrl+Z)', () => exec('undo'))}
        {tb('↷', 'Redo (Ctrl+Y)', () => exec('redo'))}
      </div>
      <div className="ne-body">
        <div className="ne-scroll" onPointerDown={shot.onPointerDown} onContextMenu={contextMenu}>
          <div ref={editor} className="ne-page" contentEditable suppressContentEditableWarning spellCheck data-find="this note"
            data-placeholder="Start writing… (these notes are yours: they're never added to the material Apollo learns from)"
            onInput={changed} onPaste={onPaste} onKeyDown={onKeyDown} onKeyUp={trackBlock} onMouseUp={trackBlock} onBlur={save} />
        </div>
        {showReviews && (
          <Reviews target="note" id={id} list={reviews.data ?? []} onApplied={() => { reviews.reload(); load(); }}
            onFix={fixIssue} onClose={() => setShowReviews(false)} />
        )}
      </div>
      {shot.overlay}
    </div>
  );
}

function AlignIcon({ a }: { a: 'left' | 'center' | 'right' }) {
  const rows = [[2, 14], [2, 10], [2, 14], [2, 8]].map(([x, w], i) => {
    const width = i % 2 ? w : 12;
    const left = a === 'left' ? x : a === 'right' ? 14 - width : (16 - width) / 2;
    return <line key={i} x1={left} x2={left + width} y1={3 + i * 3.4} y2={3 + i * 3.4} />;
  });
  return <svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>{rows}</svg>;
}
