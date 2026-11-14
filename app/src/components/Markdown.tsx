import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { api, BASE, FigureRef } from '../api';
import { hydratePlots, plotHtml } from './plot';

marked.setOptions({ gfm: true, breaks: true });

/* Everything rendered here is model output or text from someone else's study pack, so it's sanitised strictly:
   no forms, frames, embedded objects or SVG foreignObject; links and SVG references may only point inside the page;
   images only from the backend's assets or inline data. (KaTeX's inline styles are kept.) */
const PURIFY = {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'base',
    'meta', 'link', 'style', 'foreignObject', 'animate', 'set', 'animateMotion', 'animateTransform', 'audio', 'video', 'source'],
  FORBID_ATTR: ['action', 'formaction', 'srcset', 'ping', 'target'],
};
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  for (const attr of ['href', 'xlink:href']) {
    const v = node.getAttribute(attr);
    if (v !== null && !v.startsWith('#')) node.removeAttribute(attr);
  }
  if (node.tagName === 'IMG' || node.tagName.toLowerCase() === 'image') {
    const src = node.getAttribute('src') ?? '';
    if (!(src.startsWith(`${BASE}/assets/`) || /^data:image\/(png|jpe?g|gif|webp);/.test(src))) node.removeAttribute('src');
  }
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// [[file.ext · label]] (what the tutor is told to write), also tolerating [file.ext · label] and a "-" or "|" separator.
const CITE = /\[\[?\s*([^\[\]\n]+?\.(?:pdf|pptx|docx|txt|md|html?|png|jpe?g))\s*[·|\-–]\s*([^\[\]\n]+?)\s*\]?\]/gi;
// [[figure: file.ext · label | what it shows]] — a figure cropped from the student's material (figures.py)
const FIGURE = /\[\[\s*figure:\s*([^\]|]+?\.[A-Za-z0-9]{2,5})\s*[·|\-–]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]\]/gi;
const PLOT_MD = /```plot\s*\n([\s\S]*?)```/g;
const PLOT_HTML = /<pre class="plot">([\s\S]*?)<\/pre>/gi;

const SEP_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return t.split(/(?<!\\)\|/).length;
};

/** Generated quizzes/cards often write a table as bare `a | b | c` lines with no `|---|` row, or straight after a
 * sentence, which Markdown then reads as a paragraph. A run of 2+ lines with the same number (2+) of pipe-separated
 * cells becomes a proper table: a blank line before it and a separator row after its first line. Code is left alone. */
export function repairTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const n = !fence && line.includes('|') && !SEP_ROW.test(line) ? cells(line) : 0;
    if (n < 2) { out.push(line); continue; }
    let j = i + 1;
    const hasSep = j < lines.length && SEP_ROW.test(lines[j]);
    if (hasSep) j++;
    while (j < lines.length && lines[j].includes('|') && !SEP_ROW.test(lines[j]) && cells(lines[j]) === n) j++;
    if (j - i - (hasSep ? 1 : 0) < 2) { out.push(line); continue; }
    if (out.length && out[out.length - 1].trim()) out.push('');
    out.push(line);
    if (!hasSep) out.push(Array(n).fill('---').join(' | '));
    out.push(...lines.slice(i + 1, j));
    if (j < lines.length && lines[j].trim()) out.push('');
    i = j - 1;
  }
  return out.join('\n');
}

const citeLink = (file: string, label: string) => {
  const short = label.split(' · ')[0];
  return `<a class="cite" data-file="${esc(file.trim())}" data-label="${esc(label.trim())}" title="${esc(`${file} · ${label}`)}">`
    + `<span class="cite-doc">${esc(file.replace(/\.[a-z]+$/i, '').slice(0, 28))}</span>${esc(short)}</a>`;
};

/**
 * Markdown (chat) or HTML (notes and cheat sheets) with LaTeX ($...$, $$...$$, \(...\), \[...\]), source citations,
 * figures from the student's material, plots and inline SVG. Maths, citations, figures and plots are cut out before
 * parsing so `_`/`*`/`<` inside them survive, then restored; everything is sanitised.
 * `figures`: resolved figure tags (message/section meta). Without it (a reply still streaming) figures show as pending.
 */
export function renderMarkdown(src: string, opts: { citations?: boolean; figures?: Record<string, FigureRef>; html?: boolean; mathText?: boolean; inline?: boolean } = {}): string {
  const keep: string[] = [];
  const hold = (html: string) => { keep.push(html); return `@@KEEP${keep.length - 1}@@`; };
  // mathText (Word export): Word can't take KaTeX's HTML, so the LaTeX stays as text
  const math = (tex: string, display: boolean) => hold(opts.mathText
    ? `<span class="tex">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</span>`
    // data-tex keeps the source so the notes' menu can copy it as LaTeX
    : katex.renderToString(tex, { throwOnError: false, displayMode: display, output: 'html' }).replace(/^<span /, `<span data-tex="${esc(tex)}" `));
  let text = src;
  text = text.replace(opts.html ? PLOT_HTML : PLOT_MD, (_, json: string) => hold(plotHtml(unesc(json.trim()))));
  text = text.replace(FIGURE, (tag: string, file: string, label: string, hint: string) => {
    const f = opts.figures?.[tag];
    const caption = `<figcaption>${esc(hint)}${opts.citations ? ` ${citeLink(file, label)}` : ''}</figcaption>`;
    if (f && f.asset) return hold(`<figure class="src-fig"><img src="${api.assetUrl(f.asset)}" alt="${esc(hint)}" loading="lazy">${caption}</figure>`);
    if (f?.missing || (!f && opts.figures)) return hold(`<figure class="src-fig missing"><div class="fig-wait">Figure not found in your material</div>${caption}</figure>`);
    return hold(`<figure class="src-fig pending"><div class="fig-wait">Finding the figure…</div>${caption}</figure>`);
  });
  if (opts.citations) text = text.replace(CITE, (_, file: string, label: string) => hold(citeLink(file, label)));
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => math(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => math(t, true))
    .replace(/\\\((.+?)\\\)/g, (_, t) => math(t, false))
    .replace(/\$([^$\n]+?)\$/g, (_, t) => math(t, false));
  const body = opts.html ? text
    : opts.inline ? (marked.parseInline(text, { async: false }) as string)  // one line, no <p> around it
    : (marked.parse(repairTables(text), { async: false }) as string);
  const clean = DOMPurify.sanitize(body.replace(/@@KEEP(\d+)@@/g, (_, i) => keep[Number(i)]), PURIFY) as string;
  // each table in a scroller, so a wide one scrolls while the table itself keeps a real grid (Word export: as is)
  return opts.mathText ? clean : clean.replace(/<table\b/g, '<div class="table-scroll"><table').replace(/<\/table>/g, '</table></div>');
}

/** For saved messages/sections: every figure tag in them was already resolved (an empty map = none were found). */
export const RESOLVED: Record<string, FigureRef> = Object.freeze({}) as Record<string, FigureRef>;

export default function Markdown({ text, className, onCite, figures, html }: {
  text: string; className?: string; onCite?: (file: string, label: string) => void;
  figures?: Record<string, FigureRef>; html?: boolean;
}) {
  const out = useMemo(() => renderMarkdown(text, { citations: !!onCite, figures, html }), [text, onCite, figures, html]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) hydratePlots(ref.current); }, [out]); // graphs: hover readout + sliders
  return (
    <div ref={ref} className={`md ${html ? 'nb ' : ''}${className ?? ''}`} dangerouslySetInnerHTML={{ __html: out }}
      onClick={onCite ? (e) => {
        const a = (e.target as HTMLElement).closest('a.cite') as HTMLElement | null;
        if (a) { e.preventDefault(); onCite(a.dataset.file!, a.dataset.label!); }
      } : undefined} />
  );
}

/** Where a streaming reply can be cut into blocks that parse the same on their own: blank lines outside code fences
 * and $$ maths, not inside a table or list that continues after the blank line. Returns the cut offsets. */
export function blockCuts(text: string): number[] {
  const cuts: number[] = [];
  let fence = false, dollars = 0, pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) dollars += (line.match(/\$\$/g) ?? []).length;
    pos += line.length + 1;
    const next = lines[i + 1];
    if (!fence && dollars % 2 === 0 && line.trim() === '' && i > 0 && lines[i - 1].trim() !== ''
        && next !== undefined && next.trim() !== '' && !/^\s*([-*+]|\d+[.)]|\|)\s/.test(next) && !/^\s{2,}/.test(next)) {
      cuts.push(pos);
    }
  }
  return cuts;
}

const blockCache = new Map<string, string>();
const cachedBlock = (src: string, citations: boolean) => {
  const key = (citations ? '1' : '0') + src;
  let html = blockCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(src, { citations });
    if (blockCache.size > 400) blockCache.delete(blockCache.keys().next().value!);
    blockCache.set(key, html);
  }
  return html;
};

/** A reply still being written. Finished blocks are parsed once and never touched again; only the last, growing
 * block is re-parsed as text arrives (a full re-parse per token is quadratic in the reply's length). Once the reply
 * is saved it's shown with `Markdown`, which parses it as a whole. */
export function StreamingMarkdown({ text, onCite }: { text: string; onCite?: (file: string, label: string) => void }) {
  const cuts = blockCuts(text);
  const blocks: string[] = [];
  let from = 0;
  for (const c of cuts) { blocks.push(text.slice(from, c)); from = c; }
  blocks.push(text.slice(from));
  const last = blocks.length - 1;
  return (
    <div className="md md-stream" onClick={onCite ? (e) => {
      const a = (e.target as HTMLElement).closest('a.cite') as HTMLElement | null;
      if (a) { e.preventDefault(); onCite(a.dataset.file!, a.dataset.label!); }
    } : undefined}>
      {blocks.map((b, i) => (
        <div key={i} className="md-block" dangerouslySetInnerHTML={{ __html: i < last ? cachedBlock(b, !!onCite) : renderMarkdown(b, { citations: !!onCite }) }} />
      ))}
    </div>
  );
}
