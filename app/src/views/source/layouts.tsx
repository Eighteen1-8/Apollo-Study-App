/* The viewer's page layouts: the exact PDF (pdf.js, also Office files' copies), composed slides, Word blocks and text. */
import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { api, DocDetail, DocLayout, DocxBlock, SlideItem } from '../../api';
import Markdown from '../../components/Markdown';
import { Empty, MathText } from '../../components/ui';
import { UnitOverlay } from '../annotate';
import { FindHit, registerFind } from '../../components/FindBar';
import { findAll } from '../../components/textRange';

export const BASE_WIDTH = 920; // px at 100%, or the pane width if narrower
export const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function useWidth(ref: React.RefObject<HTMLElement>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setW(el.clientWidth), w ? 150 : 0);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps
  return w;
}

export function PdfView({ url, zoom, onReady, slides }: { url: string; zoom: number; onReady: () => void; slides?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const avail = useWidth(wrap);

  useEffect(() => {
    let alive = true;
    const task = pdfjs.getDocument({ url }); // pdf.js 6 never evaluates code from a file (isEvalSupported is gone)
    task.promise.then(async (d) => {
      // Every page's size up front, so placeholders are exact and scrolling to a cited page lands precisely.
      const out = [];
      for (let i = 1; i <= d.numPages; i++) {
        const v = (await d.getPage(i)).getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
      }
      if (alive) { setPdf(d); setSizes(out); }
    }).catch((e) => alive && setErr(String(e)));
    return () => { alive = false; task.destroy(); };
  }, [url]);

  const width = Math.min(Math.max(avail - 48, 200), BASE_WIDTH) * zoom;
  useEffect(() => { if (sizes.length && avail) onReady(); }, [sizes.length, avail, onReady]);

  // Ctrl+F searches every page's text, not just the pages drawn so far (they render as they scroll into view)
  useEffect(() => {
    const root = wrap.current?.closest('[data-find]');
    if (!pdf || !root) return;
    const texts = new Map<number, Promise<string>>();
    const pageText = (n: number) => {
      if (!texts.has(n)) {
        // the same strings, in the same order, as the text layer's spans (so the nth match lines up)
        texts.set(n, pdf.getPage(n).then((pg) => pg.getTextContent()).then((c) =>
          c.items.map((it) => ('str' in it ? it.str : '')).join('').toLowerCase()));
      }
      return texts.get(n)!;
    };
    // reading a big textbook's text takes seconds (3.8 s for 917 pages): pages are asked for 8 at a time, so pdf.js's
    // worker stays busy, and a search reports its matches every few pages instead of only at the end
    const AHEAD = 8;
    let warming = false;
    const warm = async () => {
      if (warming) return;
      warming = true;
      for (let n = 1; n <= pdf.numPages && alive; n += AHEAD) {
        await Promise.all(Array.from({ length: Math.min(AHEAD, pdf.numPages - n + 1) }, (_, k) => pageText(n + k).catch(() => '')));
      }
    };
    let alive = true;
    const off = registerFind(root, {
      warm: () => { void warm(); },
      search: async (q, partial) => {
        const needle = q.toLowerCase();
        const out: FindHit[] = [];
        let shown = performance.now();
        for (let n = 1; n <= pdf.numPages && alive; n++) {
          for (let k = n + 1; k < Math.min(n + AHEAD, pdf.numPages + 1); k++) void pageText(k).catch(() => '');
          const t = await pageText(n).catch(() => '');
          let k = 0;
          for (let i = t.indexOf(needle); i >= 0 && out.length < 5000; i = t.indexOf(needle, i + needle.length)) out.push({ page: n, index: k++ });
          if (partial && performance.now() - shown > 150) { shown = performance.now(); partial(out.slice()); }
        }
        return out;
      },
      reveal: async (hit, q) => {
        const el = wrap.current?.querySelector<HTMLElement>(`[data-unit="${hit.page}"]`);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        for (let i = 0; i < 60; i++) { // up to ~6 s for the page to draw its text layer
          const layer = el.querySelector('.textLayer');
          if (layer) return findAll(layer, q)[hit.index] ?? null;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      },
    });
    return () => { alive = false; off(); };
  }, [pdf]);

  return (
    <div ref={wrap} className="src-pages">
      {err && <Empty title="Couldn't render this PDF">{err}</Empty>}
      {avail > 0 && sizes.map((s, i) => (slides ? (
        <div key={i} className="src-slide-wrap" style={{ width }}>
          <div className="src-slide-num">Slide {i + 1}</div>
          <PdfPage pdf={pdf} n={i + 1} size={s} width={width} />
        </div>
      ) : <PdfPage key={i} pdf={pdf} n={i + 1} size={s} width={width} />))}
    </div>
  );
}

export function PdfPage({ pdf, n, size, width }: { pdf: pdfjs.PDFDocumentProxy | null; n: number; size: { w: number; h: number }; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const render = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / size.w;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = render.current;
    if (!visible || !pdf || !el) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | undefined;
    let text: pdfjs.TextLayer | undefined;
    (async () => {
      const page = await pdf.getPage(n);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: vp });
      await text.render();
      if (!cancelled) el.replaceChildren(canvas, layer);
    })().catch(() => { /* cancelled by a zoom change or unmount */ });
    return () => { cancelled = true; task?.cancel(); text?.cancel(); };
  }, [visible, pdf, n, scale]);

  return (
    <div ref={ref} className="src-page pdf-page" data-unit={n}
      style={{ width, height: size.h * scale, '--scale-factor': scale, '--total-scale-factor': scale } as React.CSSProperties}>
      <div ref={render} className="pdf-render" />
      <UnitOverlay unit={n} />
    </div>
  );
}

// ---------------------------------------------------------------- slides (positioned HTML, real text)

export function SlidesView({ layout, onReady }: { layout: Extract<DocLayout, { kind: 'slides' }>; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  const { width: W, height: H } = layout;
  return (
    <div className="src-pages">
      {layout.slides.map((s) => (
        <div key={s.idx} className="src-slide-wrap">
          <div className="src-slide-num">Slide {s.idx}</div>
          <div className="src-page src-slide" data-unit={s.idx} style={{ aspectRatio: `${W} / ${H}` }}>
            {s.items.map((it, i) => <SlideShape key={i} it={it} W={W} H={H} />)}
            <UnitOverlay unit={s.idx} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SlideShape({ it, W, H }: { it: SlideItem; W: number; H: number }) {
  const cq = (pt: number) => `${(pt / W) * 100}cqw`; // slide points → share of the slide's width
  const box: React.CSSProperties = {
    left: pct(it.x, W), top: pct(it.y, H), width: pct(it.w, W), height: pct(it.h, H),
    transform: it.rot ? `rotate(${it.rot}deg)` : undefined,
  };
  if (it.type === 'image') {
    if (!it.src) return <div className="shape shape-missing" style={box}>image not shown</div>;
    const [l, t, r, b] = it.crop ?? [0, 0, 0, 0];
    const fw = 1 - l - r || 1;
    const fh = 1 - t - b || 1;
    return (
      <div className="shape shape-img" style={box}>
        <img src={api.assetUrl(it.src)} alt="" draggable={false}
          style={{ width: pct(1, fw), height: pct(1, fh), left: pct(-l, fw), top: pct(-t, fh) }} />
      </div>
    );
  }
  if (it.type === 'table') {
    return (
      <div className="shape shape-table" style={{ ...box, fontSize: cq(12) }}>
        <table><tbody>{it.rows!.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><MathText text={c} /></td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  return (
    <div className={`shape shape-text anchor-${it.anchor}`} style={{ ...box, padding: `${cq(3.6)} ${cq(7.2)}` }}>
      {it.paras!.map((p, i) => (
        <div key={i} className={`sp${p.bullet ? ' sp-bullet' : ''}`}
          style={{ fontSize: cq(p.size), fontWeight: p.bold ? 700 : 400, textAlign: p.align as React.CSSProperties['textAlign'],
            marginLeft: cq(p.level * 24 + (p.bullet ? 16 : 0)) }}>
          {p.text ? <MathText text={p.text} /> : ' '}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Word (flowing page, real text)

export function DocxView({ blocks, onReady }: { blocks: DocxBlock[]; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  // Consecutive blocks of one section share a [data-unit] wrapper: the citation target and the highlight's context.
  const sections: { unit: number | null; blocks: DocxBlock[] }[] = [];
  for (const b of blocks) {
    const last = sections[sections.length - 1];
    if (last && last.unit === b.unit) last.blocks.push(b);
    else sections.push({ unit: b.unit, blocks: [b] });
  }
  return (
    <div className="src-pages">
      <div className="src-page src-paper">
        {sections.map((s, i) => (
          <section key={i} data-unit={s.unit ?? undefined}>
            {s.blocks.map((b, j) => <DocxBlockView key={j} b={b} />)}
            {s.unit != null && <UnitOverlay unit={s.unit} />}
          </section>
        ))}
      </div>
    </div>
  );
}

export function DocxBlockView({ b }: { b: DocxBlock }) {
  if (b.type === 'table') {
    return (
      <div className="dx-table">
        <table><tbody>{b.rows!.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><MathText text={c} /></td>)}</tr>)}</tbody></table>
      </div>
    );
  }
  const content = (
    <>
      {b.text && <MathText text={b.text} />}
      {b.images?.map((src, i) => <img key={i} className="dx-img" src={api.assetUrl(src)} alt="" draggable={false} />)}
    </>
  );
  if (b.type === 'heading') return <div className={`dx-h dx-h${b.level ?? 3}`}>{content}</div>;
  return (
    <div className={`dx-p${b.list != null ? ' dx-li' : ''}`}
      style={{ textAlign: b.align as React.CSSProperties['textAlign'], marginLeft: b.list != null ? b.list * 22 + 20 : undefined }}>
      {content}
    </div>
  );
}

// ---------------------------------------------------------------- text / markdown

export function TextView({ doc, onReady }: { doc: DocDetail; onReady: () => void }) {
  useEffect(onReady, [onReady]);
  const md = doc.ext === '.md';
  return (
    <div className="src-pages">
      <div className="src-page src-paper">
        {doc.units.map((u) => (
          <section key={u.id} data-unit={u.idx}>
            {md ? <Markdown text={u.text} /> : <div className="src-plain">{u.text}</div>}
            <UnitOverlay unit={u.idx} />
          </section>
        ))}
        {doc.units.length === 0 && <div className="muted">This file hasn't been read yet.</div>}
      </div>
    </div>
  );
}
