/**
 * Graphs Apollo describes as JSON (```plot blocks in chat, <pre class="plot"> in notes).
 *
 * `plotHtml` renders a static SVG (it goes through the HTML sanitiser with the rest of the message) and keeps the
 * spec in `data-plot`; `hydratePlots` then makes each graph interactive in place: a crosshair with the value of every
 * curve under the mouse, snapping to labelled points, and sliders for any `params` the spec declares, which redraw the
 * curves live.
 *
 * Expressions are parsed by a small recursive-descent parser (never eval): numbers, x, parameter names, pi, e,
 * + - * / ^, unary minus, parentheses, implicit multiplication (2x, 3(x+1), a x) and
 * sin cos tan asin acos atan sqrt abs exp ln log.
 */

export interface PlotParam { name: string; min: number; max: number; step?: number; value?: number; label?: string }
export interface PlotSpec {
  title?: string; x?: [number, number]; y?: [number, number]; xlabel?: string; ylabel?: string;
  functions?: { expr: string; label?: string }[];
  points?: { x: number; y: number; label?: string }[];
  series?: { label?: string; points: [number, number][] }[];
  params?: PlotParam[];
}

type Vars = Record<string, number>;
type Fn = (x: number, p: Vars) => number;
const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
};

export function compile(src: string, params: string[] = []): Fn {
  const s = src.replace(/\s+/g, ' ').trim().replace(/\*\*/g, '^').replace(/·|×/g, '*').replace(/−/g, '-');
  let i = 0;
  const skip = () => { while (s[i] === ' ') i++; };
  const peek = () => { skip(); return s[i]; };
  const fail = (): never => { throw new Error(`Can't read "${src}"`); };
  // longest name first, so a parameter called "ab" isn't read as a·b
  const names = [...params].sort((a, b) => b.length - a.length);
  const expr = (): Fn => {
    let f = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const a = f, b = term();
      f = op === '+' ? (x, p) => a(x, p) + b(x, p) : (x, p) => a(x, p) - b(x, p);
    }
    return f;
  };
  const term = (): Fn => {
    let f = unary();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const a = f, b = unary();
        f = c === '*' ? (x, p) => a(x, p) * b(x, p) : (x, p) => a(x, p) / b(x, p);
      } else if (c && /[a-z(0-9.]/i.test(c)) {
        const a = f, b = unary();
        f = (x, p) => a(x, p) * b(x, p);
      } else return f;
    }
  };
  const unary = (): Fn => {
    if (peek() === '-') { i++; const a = unary(); return (x, p) => -a(x, p); }
    if (peek() === '+') { i++; return unary(); }
    return power();
  };
  const power = (): Fn => {
    const a = atom();
    if (peek() === '^') { i++; const b = unary(); return (x, p) => Math.pow(a(x, p), b(x, p)); }
    return a;
  };
  const atom = (): Fn => {
    const c = peek();
    if (c === '(') { i++; const a = expr(); if (peek() !== ')') fail(); i++; return a; }
    const num = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { i += num[0].length; const v = parseFloat(num[0]); return () => v; }
    const rest = s.slice(i);
    const fn = Object.keys(FUNCS).sort((a, b) => b.length - a.length).find((f) => rest.toLowerCase().startsWith(f) && /^[\s(]/.test(rest.slice(f.length)));
    if (fn) { i += fn.length; const a = atom(); const g = FUNCS[fn]; return (x, p) => g(a(x, p)); }
    const param = names.find((n) => rest.startsWith(n));
    if (param) { i += param.length; return (_x, p) => p[param]; }
    if (/^pi/i.test(rest)) { i += 2; return () => Math.PI; }
    if (rest[0] === 'x' || rest[0] === 'X') { i++; return (x) => x; }
    if (rest[0] === 'e') { i++; return () => Math.E; }
    return fail();
  };
  const f = expr();
  if (peek() !== undefined) fail();
  return f;
}

const COLORS = ['#5b8def', '#e5484d', '#16a37f', '#d97706', '#8b5cf6', '#db2777'];
const W = 520, H = 320, L = 56, R = 16, B = 46;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (v: number) => (!Number.isFinite(v) ? '—' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : String(+v.toPrecision(4)));

function ticks(lo: number, hi: number, n = 6): number[] {
  const span = hi - lo || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => span / m <= n) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** A parsed spec plus everything needed to draw it for given parameter values. */
interface Model {
  spec: PlotSpec; x0: number; x1: number; y0: number; y1: number; T: number;
  fns: { fn: Fn; label: string }[]; errors: string[]; params: PlotParam[];
}

function model(spec: PlotSpec): Model {
  const params = (spec.params ?? []).filter((p) => p && p.name && Number.isFinite(p.min) && Number.isFinite(p.max) && p.max > p.min);
  const [x0, x1] = spec.x && spec.x[1] > spec.x[0] ? spec.x : [-10, 10];
  const fns: Model['fns'] = [];
  const errors: string[] = [];
  for (const f of spec.functions ?? []) {
    try { fns.push({ fn: compile(f.expr, params.map((p) => p.name)), label: f.label ?? `y = ${f.expr}` }); } catch (e) { errors.push((e as Error).message); }
  }
  const m: Model = { spec, x0, x1, y0: -1, y1: 1, T: spec.title ? 34 : 14, fns, errors, params };
  if (spec.y && spec.y[1] > spec.y[0]) [m.y0, m.y1] = spec.y;
  else fitY(m, initialVars(m));
  return m;
}

/** y range from the data at these slider values (ignoring wild values such as asymptotes), with some headroom when
 * there are sliders. It stays fixed while a slider is dragged, so the change is visible, and is re-fitted on release. */
function fitY(m: Model, vars: Vars) {
  const ys = [...curves(m, vars).flatMap((c) => c.pts.map((p) => p[1])), ...(m.spec.points ?? []).map((p) => p.y)]
    .filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return;
  const lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.ceil(ys.length * 0.98) - 1];
  const pad = (hi - lo || 1) * 0.08;
  [m.y0, m.y1] = [lo - pad, hi + pad];
  if (m.y0 > 0 && m.y0 < (m.y1 - m.y0) * 0.3) m.y0 = 0;
  if (m.params.length) { const span = m.y1 - m.y0; m.y1 += span * 0.2; if (m.y0 < 0) m.y0 -= span * 0.2; }
}

const initialVars = (m: Model): Vars => Object.fromEntries(m.params.map((p) => [p.name, p.value ?? (p.min + p.max) / 2]));

function curves(m: Model, vars: Vars) {
  const out: { label?: string; pts: [number, number][]; dots?: boolean; fn?: (x: number) => number }[] = m.fns.map(({ fn, label }) => {
    const pts: [number, number][] = [];
    for (let k = 0; k <= 400; k++) { const x = m.x0 + ((m.x1 - m.x0) * k) / 400; pts.push([x, fn(x, vars)]); }
    return { label, pts, fn: (x: number) => fn(x, vars) };
  });
  for (const sr of m.spec.series ?? []) out.push({ label: sr.label, pts: sr.points.map((p) => [p[0], p[1]] as [number, number]), dots: true });
  return out;
}

const sx = (m: Model, x: number) => L + ((x - m.x0) / (m.x1 - m.x0)) * (W - L - R);
const sy = (m: Model, y: number) => m.T + (1 - (y - m.y0) / (m.y1 - m.y0)) * (H - m.T - B);

/** The curves layer (redrawn when a slider moves). */
function curvesSvg(m: Model, vars: Vars): string {
  const out: string[] = [];
  curves(m, vars).forEach((c, k) => {
    let d = '', pen = false;
    for (const [x, y] of c.pts) {
      if (!Number.isFinite(y) || y < m.y0 - (m.y1 - m.y0) * 3 || y > m.y1 + (m.y1 - m.y0) * 3) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${sx(m, x).toFixed(1)},${sy(m, y).toFixed(1)}`;
      pen = true;
    }
    out.push(`<path d="${d}" fill="none" stroke="${COLORS[k % COLORS.length]}" stroke-width="2.2"/>`);
    if (c.dots) for (const [x, y] of c.pts) out.push(`<circle cx="${sx(m, x)}" cy="${sy(m, y)}" r="3" fill="${COLORS[k % COLORS.length]}"/>`);
  });
  return out.join('');
}

function svg(m: Model, vars: Vars): string {
  const { spec, T } = m;
  const out: string[] = [`<svg class="plot-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title ?? 'graph')}">`];
  if (spec.title) out.push(`<text x="${W / 2}" y="20" text-anchor="middle" class="plot-title">${esc(spec.title)}</text>`);
  for (const t of ticks(m.x0, m.x1)) {
    out.push(`<line x1="${sx(m, t)}" y1="${T}" x2="${sx(m, t)}" y2="${H - B}" class="plot-grid"/>`,
      `<text x="${sx(m, t)}" y="${H - B + 16}" text-anchor="middle" class="plot-tick">${fmt(t)}</text>`);
  }
  for (const t of ticks(m.y0, m.y1)) {
    out.push(`<line x1="${L}" y1="${sy(m, t)}" x2="${W - R}" y2="${sy(m, t)}" class="plot-grid"/>`,
      `<text x="${L - 6}" y="${sy(m, t) + 4}" text-anchor="end" class="plot-tick">${fmt(t)}</text>`);
  }
  const ax = Math.min(Math.max(0, m.y0), m.y1), ay = Math.min(Math.max(0, m.x0), m.x1);
  out.push(`<line x1="${L}" y1="${sy(m, ax)}" x2="${W - R}" y2="${sy(m, ax)}" class="plot-axis"/>`,
    `<line x1="${sx(m, ay)}" y1="${T}" x2="${sx(m, ay)}" y2="${H - B}" class="plot-axis"/>`);
  if (spec.xlabel) out.push(`<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" class="plot-label">${esc(spec.xlabel)}</text>`);
  if (spec.ylabel) out.push(`<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="plot-label">${esc(spec.ylabel)}</text>`);
  out.push(`<svg x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" viewBox="${L} ${T} ${W - L - R} ${H - T - B}" overflow="hidden"><g class="plot-curves">${curvesSvg(m, vars)}</g></svg>`);
  for (const p of spec.points ?? []) {
    out.push(`<circle cx="${sx(m, p.x)}" cy="${sy(m, p.y)}" r="4.5" class="plot-point"/>`);
    if (p.label) out.push(`<text x="${sx(m, p.x) + 8}" y="${sy(m, p.y) - 8}" class="plot-plabel">${esc(p.label)}</text>`);
  }
  curves(m, vars).forEach((c, k) => {
    if (!c.label) return;
    const y = T + 8 + k * 17;
    out.push(`<line x1="${W - R - 150}" y1="${y}" x2="${W - R - 132}" y2="${y}" stroke="${COLORS[k % COLORS.length]}" stroke-width="3"/>`,
      `<text x="${W - R - 126}" y="${y + 4}" class="plot-legend">${esc(c.label.slice(0, 28))}</text>`);
  });
  out.push('<g class="plot-hover"></g></svg>');
  return out.join('');
}

/** Static markup for a plot (sanitised with the message); `hydratePlots` makes it interactive. */
export function plotHtml(json: string): string {
  let spec: PlotSpec;
  try { spec = JSON.parse(json); } catch { return `<div class="plot"><div class="plot-error">This graph couldn't be read.</div></div>`; }
  const m = model(spec);
  const errors = m.errors.length ? `<div class="plot-error">${esc(m.errors.join('; '))}</div>` : '';
  return `<div class="plot" data-plot="${esc(JSON.stringify(spec))}">${svg(m, initialVars(m))}${errors}</div>`;
}

/** Make every not-yet-interactive plot under `root` interactive: hover readout and parameter sliders. */
export function hydratePlots(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.plot[data-plot]:not([data-live])')) {
    let spec: PlotSpec;
    try { spec = JSON.parse(el.dataset.plot!); } catch { continue; }
    el.dataset.live = '1';
    const m = model(spec);
    const vars = initialVars(m);
    const tip = document.createElement('div');
    tip.className = 'plot-tip';
    el.appendChild(tip);

    const svgEl = () => el.querySelector<SVGSVGElement>(':scope > svg.plot-svg')!;
    const redraw = () => { const g = svgEl().querySelector('.plot-curves'); if (g) g.innerHTML = curvesSvg(m, vars); };

    if (m.params.length) {
      const box = document.createElement('div');
      box.className = 'plot-sliders';
      for (const p of m.params) {
        const row = document.createElement('label');
        row.className = 'plot-slider';
        const step = p.step ?? (p.max - p.min) / 100;
        row.innerHTML = `<span class="ps-name" title="${esc(p.name)}">${esc(p.label || p.name)}</span>`
          + `<input type="range" min="${p.min}" max="${p.max}" step="${step}" value="${vars[p.name]}">`
          + `<span class="ps-val">${fmt(vars[p.name])}</span>`;
        const input = row.querySelector('input')!;
        const val = row.querySelector('.ps-val')!;
        input.addEventListener('input', () => { vars[p.name] = Number(input.value); val.textContent = fmt(vars[p.name]); redraw(); });
        input.addEventListener('change', () => { // released: re-fit the axes to the new curve
          if (spec.y) return;
          fitY(m, vars);
          svgEl().outerHTML = svg(m, vars);
        });
        box.appendChild(row);
      }
      el.appendChild(box);
    }

    const hover = (e: PointerEvent) => {
      const s = svgEl();
      const r = s.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const py = ((e.clientY - r.top) / r.height) * H;
      const g = s.querySelector('.plot-hover')!;
      if (px < L || px > W - R || py < m.T || py > H - B) { g.innerHTML = ''; tip.style.display = 'none'; return; }
      // snap to a labelled point or data point within 12px, else read the curves at this x
      const near = [...(spec.points ?? []).map((p) => ({ x: p.x, y: p.y, label: p.label })),
        ...(spec.series ?? []).flatMap((sr) => sr.points.map(([x, y]) => ({ x, y, label: sr.label })))]
        .map((p) => ({ ...p, d: Math.hypot(sx(m, p.x) - px, sy(m, p.y) - py) })).sort((a, b) => a.d - b.d)[0];
      let rows: string[];
      let marks = '';
      let at = px;
      if (near && near.d < 12) {
        at = sx(m, near.x);
        marks = `<circle cx="${at}" cy="${sy(m, near.y)}" r="6" class="plot-hl"/>`;
        rows = [`${near.label ? `<b>${esc(near.label)}</b><br>` : ''}x = ${fmt(near.x)}, y = ${fmt(near.y)}`];
      } else {
        const x = m.x0 + ((px - L) / (W - L - R)) * (m.x1 - m.x0);
        rows = [`x = ${fmt(x)}`];
        curves(m, vars).forEach((c, k) => {
          if (!c.fn) return;
          const y = c.fn(x);
          if (Number.isFinite(y) && y >= m.y0 && y <= m.y1) marks += `<circle cx="${px}" cy="${sy(m, y)}" r="4.5" fill="${COLORS[k % COLORS.length]}" class="plot-dot"/>`;
          rows.push(`<span style="color:${COLORS[k % COLORS.length]}">●</span> ${esc((c.label ?? '').slice(0, 24))}: ${fmt(y)}`);
        });
      }
      g.innerHTML = `<line x1="${at}" y1="${m.T}" x2="${at}" y2="${H - B}" class="plot-cross"/>${marks}`;
      tip.innerHTML = rows.join('<br>');
      tip.style.display = 'block';
      const er = el.getBoundingClientRect();
      const left = e.clientX - er.left + 14;
      tip.style.left = `${Math.min(left, er.width - tip.offsetWidth - 6)}px`;
      tip.style.top = `${e.clientY - er.top + 14}px`;
    };
    el.addEventListener('pointermove', hover);
    el.addEventListener('pointerleave', () => { svgEl().querySelector('.plot-hover')!.innerHTML = ''; tip.style.display = 'none'; });
  }
}
