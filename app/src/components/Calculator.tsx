/* The calculator: a popup that floats over the app (dragged by its top bar, floating.tsx), opened from the file
   viewer's and the note editor's toolbars (`toggleCalculator`). Only its × closes it, so it stays open while the
   student switches files and notes. Mounted once in App.tsx (`CalculatorLayer`).
   - Scientific: typed or tapped calculations (mathExpr.ts, never eval), history, `ans`, degrees or radians.
   - Graphing: several functions in the graph colours, drawn by plot.ts (so asymptotes and the hover readout work as
     in the chat); drag to pan, scroll to zoom, and a table of values.
   With a note open (the note editor registers itself: `registerNoteInsert`), a result or the graph can be put into
   the note where its cursor was; the editor inserts it with insertHTML, so Ctrl+Z takes it out again.
   With a chat open, "Send to chat" puts a result, or the graph's functions as a ```plot block, in its box as editable
   text (composerBridge.ts); the chat's /calc and /graph commands use `calcFromChat` and `graphInCalculator`.
   Settings and history are kept per machine (pref `calc`). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { useFloating } from './floating';
import { useOverlay } from './overlay';
import { COLORS, hydratePlots, PLOT_BOX, plotHtml, plotRange } from './plot';
import { compileExpr, evaluate, formatNumber, FUNCS, MathError } from './mathExpr';
import { TourButton, useFirstTime } from './Tour';
import { calcCommand, plotBlock, resultText, withGraphFn } from './calcText';
import { getPref, setPref } from '../prefs';
import { logError } from '../log';
import { sendToComposer, useComposerReady } from '../composerBridge';
import { useNoteInsert } from '../noteInsert';

// ---- open / closed (one calculator for the whole app)
let open = false;
const openListeners = new Set<() => void>();
const setOpen = (v: boolean) => { open = v; openListeners.forEach((f) => f()); };
const subOpen = (f: () => void) => { openListeners.add(f); return () => { openListeners.delete(f); }; };
export function openCalculator() { setOpen(true); }
export function closeCalculator() { setOpen(false); }
export function toggleCalculator() { setOpen(!open); }
export function useCalculatorOpen() { return useSyncExternalStore(subOpen, () => open); }

// ---- the open note, if any: where "Insert into note" goes (the shared registry in noteInsert.ts)
export { registerNoteInsert } from '../noteInsert';
const useNoteTarget = useNoteInsert;

// ---- saved settings and history
type Mode = 'sci' | 'graph';
interface Entry { expr: string; value: number }
interface Saved { mode: Mode; deg: boolean; fns: string[]; history: Entry[] }
const DEFAULTS: Saved = { mode: 'sci', deg: true, fns: ['sin(x)', ''], history: [] };
function loadSaved(): Saved {
  return getPref<Saved>('calc', DEFAULTS, (v) => {
    const p = JSON.parse(v);
    return {
      mode: p?.mode === 'graph' ? 'graph' : 'sci',
      deg: p?.deg !== false,
      fns: Array.isArray(p?.fns) && p.fns.every((f: unknown) => typeof f === 'string') && p.fns.length ? p.fns.slice(0, COLORS.length) : DEFAULTS.fns,
      history: Array.isArray(p?.history) ? p.history.filter((h: Entry) => typeof h?.expr === 'string' && Number.isFinite(h?.value)).slice(-50) : [],
    };
  });
}
// changes made from outside (the /graph and /calc commands): saved, then the open calculator reloads
const savedListeners = new Set<() => void>();
function patchSaved(patch: (cur: Saved) => Partial<Saved>) {
  const cur = loadSaved();
  setPref('calc', JSON.stringify({ ...cur, ...patch(cur) }));
  savedListeners.forEach((f) => f());
}
/** /graph: the calculator opens in graphing mode with `expr` among its functions (check it with calcText.graphError). */
export function graphInCalculator(expr: string) {
  patchSaved((cur) => ({ mode: 'graph', fns: withGraphFn(cur.fns, expr, COLORS.length) }));
  setOpen(true);
}
/** /calc <expression>: worked out with the calculator's degrees/radians and `ans`; an answer joins its history. */
export function calcFromChat(expr: string): { value: number } | { error: string } {
  const cur = loadSaved();
  const r = calcCommand(expr, { deg: cur.deg, ans: cur.history.length ? cur.history[cur.history.length - 1].value : 0 });
  if ('value' in r) patchSaved((c) => ({ history: [...c.history, { expr: expr.trim(), value: r.value }].slice(-50) }));
  return r;
}
function useSaved(): [Saved, (patch: Partial<Saved>) => void] {
  const [s, setS] = useState(loadSaved);
  useEffect(() => { const f = () => setS(loadSaved()); savedListeners.add(f); return () => { savedListeners.delete(f); }; }, []);
  const update = (patch: Partial<Saved>) => setS((cur) => {
    const next = { ...cur, ...patch };
    setPref('calc', JSON.stringify(next));
    return next;
  });
  return [s, update];
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export default function CalculatorLayer() {
  const isOpen = useCalculatorOpen();
  return isOpen ? createPortal(<Calculator />, document.body) : null;
}

function Calculator() {
  const [saved, update] = useSaved();
  const fl = useFloating<HTMLDivElement>('calc');
  const mode = saved.mode;
  useFirstTime('calculator');
  // a wider graph mode may no longer fit where the narrow one was
  useLayoutEffect(() => { fl.keepIn(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // the top bar drags it (but not from its buttons)
  const grip = {
    ...fl.grip,
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as Element).closest('button, input, select, a')) return;
      fl.grip.onPointerDown(e);
    },
    onDoubleClick: (e: React.MouseEvent) => { if (!(e.target as Element).closest('button')) fl.grip.onDoubleClick(); },
  };

  return (
    <div ref={fl.ref} className={`calc calc-${mode}${fl.dragging ? ' dragging' : ''}`} role="dialog" aria-label="Calculator"
      style={{ right: 24 - fl.offset.dx, top: 92 + fl.offset.dy }}>
      <div className="calc-head calc-grip" title="Drag to move (double-click to put it back)" {...grip}>
        <Icon name={mode === 'graph' ? 'graph' : 'calculator'} size={16} />
        <div className="calc-seg calc-modes" role="tablist" aria-label="Calculator mode">
          <button role="tab" aria-selected={mode === 'sci'} className={mode === 'sci' ? 'on' : ''} onClick={() => update({ mode: 'sci' })}>Scientific</button>
          <button role="tab" aria-selected={mode === 'graph'} className={mode === 'graph' ? 'on' : ''} onClick={() => update({ mode: 'graph' })}>Graphing</button>
        </div>
        <span className="spacer" />
        <TourButton id="calculator" />
        <button className="icon-btn" title="Close the calculator" aria-label="Close the calculator" onClick={closeCalculator}><Icon name="close" size={16} /></button>
      </div>
      {mode === 'sci' ? <Scientific saved={saved} update={update} /> : <Graphing saved={saved} update={update} />}
    </div>
  );
}

// ---------------------------------------------------------------- scientific

type Key = { label: React.ReactNode; put?: string; act?: 'clear' | 'back' | 'equals'; tip?: string; cls?: string };
const K = (label: React.ReactNode, put: string, tip?: string, cls?: string): Key => ({ label, put, tip, cls });
const KEYS: Key[] = [
  K('(', '('), K(')', ')'), K(',', ', ', 'Between a function’s numbers: log(8, 2)'), K('%', '%', 'Per cent'), K('n!', '!', 'Factorial'),
  { label: <Icon name="backspace" size={16} />, act: 'back', tip: 'Delete (Backspace)', cls: 'k-fn' }, { label: 'AC', act: 'clear', tip: 'Clear (Esc)', cls: 'k-fn' },
  K('sin', 'sin('), K('cos', 'cos('), K('tan', 'tan('), K('7', '7', undefined, 'k-num'), K('8', '8', undefined, 'k-num'), K('9', '9', undefined, 'k-num'), K('÷', '÷', 'Divide (/)', 'k-op'),
  K(<>sin<sup>−1</sup></>, 'asin(', 'Inverse sine'), K(<>cos<sup>−1</sup></>, 'acos(', 'Inverse cosine'), K(<>tan<sup>−1</sup></>, 'atan(', 'Inverse tangent'),
  K('4', '4', undefined, 'k-num'), K('5', '5', undefined, 'k-num'), K('6', '6', undefined, 'k-num'), K('×', '×', 'Multiply (*)', 'k-op'),
  K('ln', 'ln(', 'Natural log'), K('log', 'log(', 'Log base 10; log(x, b) for base b'), K(<>e<sup>x</sup></>, 'e^', 'e to the power'),
  K('1', '1', undefined, 'k-num'), K('2', '2', undefined, 'k-num'), K('3', '3', undefined, 'k-num'), K('−', '−', 'Subtract', 'k-op'),
  K(<>x<sup>2</sup></>, '²', 'Squared'), K(<>x<sup>y</sup></>, '^', 'To the power (^)'), K('√', '√(', 'Square root'),
  K('0', '0', undefined, 'k-num'), K('.', '.', undefined, 'k-num'), K('π', 'π', 'Pi'), K('+', '+', 'Add', 'k-op'),
  K(<>x<sup>−1</sup></>, '^(-1)', 'One over'), K('|x|', 'abs(', 'Absolute value'), K(<>×10<sup>x</sup></>, '×10^', 'Times ten to the power'),
  K('e', 'e', 'Euler’s number'), K('Ans', 'ans', 'The last answer'), { label: '=', act: 'equals', tip: 'Work it out (Enter)', cls: 'k-eq' },
];

const CONSTS: [string, string, string][] = [
  ['Speed of light, c', '299792458', 'm/s'],
  ['Gravity at Earth’s surface, g', '9.80665', 'm/s²'],
  ['Gravitational constant, G', '6.6743e-11', 'N m²/kg²'],
  ['Planck constant, h', '6.62607015e-34', 'J s'],
  ['Elementary charge, e', '1.602176634e-19', 'C'],
  ['Electron mass', '9.1093837015e-31', 'kg'],
  ['Proton mass', '1.67262192369e-27', 'kg'],
  ['Avogadro constant', '6.02214076e23', 'per mol'],
  ['Boltzmann constant, k', '1.380649e-23', 'J/K'],
  ['Gas constant, R', '8.314462618', 'J/(mol K)'],
  ['Coulomb constant, k', '8.9875517923e9', 'N m²/C²'],
  ['Vacuum permittivity, ε₀', '8.8541878128e-12', 'F/m'],
];
const FN_SHOWN: Record<string, string> = { ncr: 'nCr', npr: 'nPr' };
const FN_LIST = Object.keys(FUNCS).filter((f) => !['arcsin', 'arccos', 'arctan', 'sgn', 'log10', 'fact'].includes(f));

function Scientific({ saved, update }: { saved: Saved; update: (p: Partial<Saved>) => void }) {
  const ov = useOverlay();
  const note = useNoteTarget();
  const chatReady = useComposerReady();
  const [input, setInput] = useState('');
  const [shownError, setShownError] = useState<string | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const history = saved.history;
  const ans = history.length ? history[history.length - 1].value : 0;
  const scope = { ans };
  const preview = input.trim() ? evaluate(input, scope, { deg: saved.deg }) : null;

  useEffect(() => { inp.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [history.length]);

  /** Put text in at the cursor. An operator typed first carries on from the last answer (as calculators do). */
  const put = (text: string) => {
    const el = inp.current;
    const a = el?.selectionStart ?? input.length, b = el?.selectionEnd ?? a;
    const t = !input && history.length && /^[+×÷^!%²*/]/.test(text) ? `ans${text}` : text;
    const next = input.slice(0, a) + t + input.slice(b);
    setInput(next);
    setShownError(null);
    requestAnimationFrame(() => { el?.focus({ preventScroll: true }); const p = a + t.length; el?.setSelectionRange(p, p); });
  };
  const back = () => {
    const el = inp.current;
    const a = el?.selectionStart ?? input.length, b = el?.selectionEnd ?? a;
    const from = a === b ? Math.max(0, a - 1) : a;
    setInput(input.slice(0, from) + input.slice(b));
    requestAnimationFrame(() => { el?.focus({ preventScroll: true }); el?.setSelectionRange(from, from); });
  };
  const equals = () => {
    if (!input.trim()) return;
    const r = evaluate(input, scope, { deg: saved.deg });
    if (r.error !== undefined) { setShownError(r.error); return; }
    update({ history: [...history, { expr: input.trim(), value: r.value }].slice(-50) });
    setInput('');
    setShownError(null);
  };
  const press = (k: Key) => {
    if (k.act === 'clear') { setInput(''); setShownError(null); inp.current?.focus(); } else if (k.act === 'back') back();
    else if (k.act === 'equals') equals();
    else if (k.put) put(k.put);
  };
  const insertResult = (e: Entry) => note?.(esc(`${e.expr} = ${formatNumber(e.value)}`));

  return (
    <div className="calc-body calc-sci">
      <div className="calc-bar">
        <div className="calc-seg calc-angle" role="group" aria-label="Angles in">
          <button className={saved.deg ? 'on' : ''} aria-pressed={saved.deg} title="Angles in degrees" onClick={() => update({ deg: true })}>Deg</button>
          <button className={!saved.deg ? 'on' : ''} aria-pressed={!saved.deg} title="Angles in radians" onClick={() => update({ deg: false })}>Rad</button>
        </div>
        <button className="link-btn" onClick={(e) => ov.menu(e, FN_LIST.map((f) => ({
          label: `${FN_SHOWN[f] ?? f}(…)`, hint: FUNCS[f].help, onClick: () => put(`${FN_SHOWN[f] ?? f}(`),
        })), { anchor: e.currentTarget, place: 'below' })}>Functions <Icon name="chevronDown" size={12} /></button>
        <button className="link-btn" onClick={(e) => ov.menu(e, CONSTS.map(([label, v, unit]) => ({
          label, hint: `${formatNumber(Number(v), 6)} ${unit}`, onClick: () => put(v),
        })), { anchor: e.currentTarget, place: 'below' })}>Constants <Icon name="chevronDown" size={12} /></button>
        <span className="spacer" />
        {history.length > 0 && (
          <button className="icon-btn" title="Clear the history" aria-label="Clear the history" onClick={() => update({ history: [] })}><Icon name="trash" size={14} /></button>
        )}
      </div>
      <div className="calc-history" ref={list} aria-label="History">
        {history.length === 0 && <div className="calc-empty muted small">Your answers will appear here.</div>}
        {history.map((h, k) => (
          <div key={k} className="calc-entry">
            <button className="calc-entry-main" title="Use this calculation again" onClick={() => { setInput(h.expr); setShownError(null); inp.current?.focus(); }}>
              <span className="calc-entry-expr">{h.expr}</span>
              <span className="calc-entry-val">= {formatNumber(h.value)}</span>
            </button>
            {note && <button className="icon-btn calc-insert" title="Insert into the note" aria-label="Insert into the note" onClick={() => insertResult(h)}><Icon name="insert" size={14} /></button>}
            {chatReady && <button className="icon-btn calc-to-chat" title="Send to the chat (you can change it before sending)" aria-label="Send to the chat"
              onClick={() => sendToComposer(resultText(h.expr, h.value))}><Icon name="chat" size={14} /></button>}
          </div>
        ))}
      </div>
      <div className={`calc-screen${shownError ? ' bad' : ''}`}>
        <input ref={inp} className="calc-input" value={input} spellCheck={false} autoComplete="off" aria-label="Calculation"
          placeholder={history.length ? 'Type a calculation (ans = last answer)' : 'Type a calculation, e.g. 2sin(30) + 5!'}
          onChange={(e) => {
            const v = e.target.value;
            // an operator typed into an empty box carries on from the last answer
            setInput(!input && history.length && /^[+*/^!%×÷]$/.test(v) ? `ans${v}` : v);
            setShownError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); equals(); }
            else if (e.key === 'Escape') { e.preventDefault(); setInput(''); setShownError(null); }
            else if (e.key === 'ArrowUp' && !input && history.length) { e.preventDefault(); setInput(history[history.length - 1].expr); }
          }} />
        <div className="calc-result" aria-live="polite">
          {shownError ? <span className="calc-error">{shownError}</span>
            : preview && preview.error === undefined ? <span className="calc-preview">= {formatNumber(preview.value)}</span>
              : <span className="calc-preview muted">&nbsp;</span>}
          {note && preview && preview.error === undefined && (
            <button className="link-btn calc-insert-now" onClick={() => note(esc(`${input.trim()} = ${formatNumber(preview.value)}`))}>
              <Icon name="insert" size={13} /> Insert into note</button>
          )}
          {chatReady && preview && preview.error === undefined && (
            <button className="link-btn calc-insert-now calc-to-chat" title="Put it in the chat box (you can change it before sending)"
              onClick={() => sendToComposer(resultText(input, preview.value))}>
              <Icon name="chat" size={13} /> Send to chat</button>
          )}
        </div>
      </div>
      <div className="calc-keys">
        {KEYS.map((k, i) => (
          <button key={i} className={`calc-key${k.cls ? ` ${k.cls}` : ''}`} title={k.tip} aria-label={typeof k.label === 'string' ? undefined : k.tip}
            onMouseDown={(e) => e.preventDefault()} onClick={() => press(k)}>{k.label}</button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- graphing

interface View { x0: number; x1: number; y0: number; y1: number }
const { W, H, L, R, B, T } = PLOT_BOX;

/** Where the graph itself is drawn (the box its viewBox maps onto). */
const svgBox = (host: HTMLElement) => (host.querySelector('svg.plot-svg') ?? host).getBoundingClientRect();

/** Each function row: whether it can be drawn, and why not. */
function readFn(expr: string): { ok: boolean; error?: string; f?: (x: number) => number } {
  if (!expr.trim()) return { ok: false };
  try {
    const f = compileExpr(expr, { names: ['x'] });
    const scope = { x: 0 };
    return { ok: true, f: (x) => { scope.x = x; return f(scope); } };
  } catch (e) {
    return { ok: false, error: e instanceof MathError ? e.message : 'Can’t read this' };
  }
}

/** The plot spec for these rows: rows that can't be drawn keep their place (and colour) but draw nothing. */
function specFor(fns: string[], view: View | null) {
  const functions = fns.map((expr) => (readFn(expr).ok ? { expr, label: `y = ${expr}` } : { expr: '0/0', label: '' }));
  const x: [number, number] = view ? [view.x0, view.x1] : [-10, 10];
  const auto = functions.some((f) => f.label) ? plotRange({ functions, x }) : [-10, 10];
  const y: [number, number] = view ? [view.y0, view.y1] : [auto[0], auto[1]];
  return { functions, x, y };
}

/** A white-background PNG of the graph (for a note: it prints and exports to Word like any picture). */
async function graphPng(spec: ReturnType<typeof specFor>): Promise<string> {
  const html = plotHtml(JSON.stringify(spec));
  const svg = /<svg class="plot-svg"[\s\S]*<\/svg>/.exec(html)?.[0];
  if (!svg) throw new Error('The graph couldn’t be drawn');
  const css = '.plot-grid{stroke:#e5e7eb;stroke-width:1}.plot-axis{stroke:#6b7280;stroke-width:1.4}'
    + 'text{font-family:Segoe UI,Arial,sans-serif}.plot-tick{fill:#4b5563;font-size:12px}'
    + '.plot-label,.plot-legend{fill:#1f2937;font-size:13px}.plot-title{fill:#111827;font-size:13.5px;font-weight:600}'
    + '.plot-point{fill:#f59e0b;stroke:#fff;stroke-width:1.5}.plot-plabel{fill:#111827;font-size:12.5px}';
  const doc = svg.replace('<svg class="plot-svg"', `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" class="plot-svg"`)
    .replace(/(<svg [^>]*>)/, `$1<style>${css}</style><rect width="${W}" height="${H}" fill="#fff"/>`);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const g = c.getContext('2d');
  if (!g) throw new Error('The graph couldn’t be drawn');
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function Graphing({ saved, update }: { saved: Saved; update: (p: Partial<Saved>) => void }) {
  const note = useNoteTarget();
  const chatReady = useComposerReady();
  const fns = saved.fns;
  const [view, setView] = useState<View | null>(null);
  const [table, setTable] = useState(false);
  const [start, setStart] = useState('0');
  const [step, setStep] = useState('1');
  const [panning, setPanning] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => fns.map(readFn), [fns]);
  const spec = useMemo(() => specFor(fns, view), [fns, view]);
  const shown: View = { x0: spec.x[0], x1: spec.x[1], y0: spec.y[0], y1: spec.y[1] };
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = plotHtml(JSON.stringify(spec));
    hydratePlots(el);
  }, [spec]);

  // scroll to zoom around the pointer (a native listener: React's wheel listener can't cancel the page scroll)
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svgBox(el);
      const v = shownRef.current;
      const fx = ((e.clientX - r.left) / r.width * W - L) / (W - L - R);
      const fy = ((e.clientY - r.top) / r.height * H - T) / (H - T - B);
      const xc = v.x0 + fx * (v.x1 - v.x0), yc = v.y1 - fy * (v.y1 - v.y0);
      const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
      setView({ x0: xc - (xc - v.x0) * k, x1: xc + (v.x1 - xc) * k, y0: yc - (yc - v.y0) * k, y1: yc + (v.y1 - yc) * k });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // drag to pan
  const pan = useRef<{ id: number; x: number; y: number; v: View; w: number; h: number } | null>(null);
  const frame = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !host.current) return;
    const r = svgBox(host.current);
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, v: shownRef.current, w: r.width * (W - L - R) / W, h: r.height * (H - T - B) / H };
    host.current.setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = ((e.clientX - p.x) / p.w) * (p.v.x1 - p.v.x0), dy = ((e.clientY - p.y) / p.h) * (p.v.y1 - p.v.y0);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setView({ x0: p.v.x0 - dx, x1: p.v.x1 - dx, y0: p.v.y0 + dy, y1: p.v.y1 + dy }));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!pan.current || pan.current.id !== e.pointerId) return;
    pan.current = null;
    setPanning(false);
  };
  const zoom = (k: number) => {
    const v = shownRef.current;
    const xc = (v.x0 + v.x1) / 2, yc = (v.y0 + v.y1) / 2;
    setView({ x0: xc - (xc - v.x0) * k, x1: xc + (v.x1 - xc) * k, y0: yc - (yc - v.y0) * k, y1: yc + (v.y1 - yc) * k });
  };

  const setFn = (k: number, v: string) => update({ fns: fns.map((f, i) => (i === k ? v : f)) });
  const addFn = () => update({ fns: [...fns, ''] });
  const removeFn = (k: number) => update({ fns: fns.length > 1 ? fns.filter((_f, i) => i !== k) : [''] });

  // table of values: start and step may be calculations too (pi/4)
  const num = (s: string, d: number) => { const r = evaluate(s); return r.error === undefined ? r.value : d; };
  const x0 = num(start, 0), dx = num(step, 1) || 1;
  const drawn = rows.map((r, k) => ({ ...r, k, expr: fns[k] })).filter((r) => r.ok);

  const insertGraph = async () => {
    try {
      const png = await graphPng(spec);
      const alt = `Graph of ${drawn.map((r) => `y = ${r.expr}`).join(', ')}`;
      note?.(`<p><img src="${png}" alt="${esc(alt)}" width="${W}"></p>`);
    } catch (e) { logError('putting a graph into a note', e); }
  };

  return (
    <div className="calc-body calc-graph">
      <div className="calc-fns">
        {fns.map((f, k) => (
          <div key={k} className="calc-fn">
            <span className="calc-fn-dot" style={{ background: rows[k].ok ? COLORS[k % COLORS.length] : 'transparent', borderColor: COLORS[k % COLORS.length] }} aria-hidden />
            <label className="calc-fn-label" htmlFor={`calc-fn-${k}`}>y =</label>
            <input id={`calc-fn-${k}`} className="calc-fn-input" value={f} spellCheck={false} autoComplete="off" placeholder="e.g. x^2 - 3"
              aria-invalid={!!rows[k].error} onChange={(e) => setFn(k, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && k === fns.length - 1 && f.trim() && fns.length < COLORS.length) addFn(); }} />
            <button className="icon-btn" title="Remove this function" aria-label="Remove this function" onClick={() => removeFn(k)}><Icon name="close" size={14} /></button>
            {rows[k].error && <div className="calc-fn-error">{rows[k].error}</div>}
          </div>
        ))}
        {fns.length < COLORS.length && <button className="link-btn calc-add" onClick={addFn}><Icon name="add" size={13} /> Add a function</button>}
      </div>
      <div ref={host} className={`calc-plot${panning ? ' panning' : ''}`} title="Drag to move, scroll to zoom"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp} />
      <div className="calc-bar">
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.8)}><Icon name="zoomIn" size={15} /></button>
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.25)}><Icon name="zoomOut" size={15} /></button>
        <button className="icon-btn" title="Back to the starting view" aria-label="Reset the view" disabled={!view} onClick={() => setView(null)}><Icon name="reset" size={15} /></button>
        <button className={`icon-btn${table ? ' on' : ''}`} title="Table of values" aria-label="Table of values" aria-pressed={table} onClick={() => setTable(!table)}><Icon name="table" size={15} /></button>
        <span className="spacer" />
        {note && drawn.length > 0 && (
          <button className="link-btn" onClick={insertGraph}><Icon name="insert" size={13} /> Insert graph into note</button>
        )}
        {chatReady && drawn.length > 0 && (
          <button className="link-btn calc-to-chat" title="Put these functions in the chat box as a graph, to ask Apollo about them"
            onClick={() => sendToComposer(plotBlock(fns, spec.x, view ? spec.y : undefined))}><Icon name="chat" size={13} /> Send to chat</button>
        )}
      </div>
      {table && (
        <div className="calc-table-wrap">
          <div className="calc-table-opts">
            <label>Start at x = <input value={start} onChange={(e) => setStart(e.target.value)} spellCheck={false} /></label>
            <label>Step <input value={step} onChange={(e) => setStep(e.target.value)} spellCheck={false} /></label>
          </div>
          {drawn.length ? (
            <table className="calc-table">
              <thead><tr><th>x</th>{drawn.map((r) => <th key={r.k} style={{ color: COLORS[r.k % COLORS.length] }} title={`y = ${r.expr}`}>{r.expr}</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: 11 }, (_x, n) => x0 + n * dx).map((x, n) => (
                  <tr key={n}><td>{formatNumber(x, 6)}</td>{drawn.map((r) => {
                    const y = r.f!(x);
                    return <td key={r.k}>{Number.isFinite(y) ? formatNumber(y, 6) : '—'}</td>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          ) : <div className="muted small">Type a function above to see its values.</div>}
        </div>
      )}
    </div>
  );
}
