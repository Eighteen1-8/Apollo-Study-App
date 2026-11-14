/**
 * Maths expressions for the calculator and for graphs (plot.ts). A small recursive-descent parser turns the text into
 * a function of its variables once; it never uses eval.
 *
 * Reads: numbers (2, .5, 1.2e-3), + - * / ^ (also × ÷ − · ** and ² ³), unary minus, brackets, |abs bars|, implicit
 * multiplication (2x, 3(x+1), 2pi, x sin x), postfix ! (factorial) and % (per cent), √ (square root), the constants
 * pi π tau τ phi φ e, the caller's variable names (x, ans, a graph's parameters), and the functions in FUNCS
 * (sin x and sin(x) both work; several arguments are separated by commas: log(8, 2), root(27, 3), nCr(5, 2)).
 *
 * Errors are `MathError`s with a plain message that says what's wrong ("A bracket isn't closed").
 */

export type Scope = Record<string, number>;
export type Evaluator = (scope: Scope) => number;
export interface CompileOptions {
  /** Variable names the expression may use (looked up in the scope when it runs). */
  names?: string[];
  /** Trigonometry in degrees (sin, cos, tan… take degrees; asin, acos, atan… give degrees). */
  deg?: boolean;
}

export class MathError extends Error {}

const DEG = Math.PI / 180;

/** Γ(z) by the Lanczos approximation (for factorials of non-integers). */
function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

export function factorial(n: number): number {
  if (!Number.isFinite(n)) return n > 0 ? Infinity : NaN;
  if (Number.isInteger(n)) {
    if (n < 0) return NaN;
    if (n > 170) return Infinity;
    let r = 1;
    for (let k = 2; k <= n; k++) r *= k;
    return r;
  }
  return gamma(n + 1);
}

const nCr = (n: number, r: number) => {
  if (!Number.isInteger(n) || !Number.isInteger(r) || r < 0 || n < 0 || r > n) return r > n && r >= 0 && Number.isInteger(r) && Number.isInteger(n) ? 0 : NaN;
  let out = 1;
  const k = Math.min(r, n - r);
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return Math.round(out);
};
const nPr = (n: number, r: number) => (Number.isInteger(n) && Number.isInteger(r) && r >= 0 && n >= 0 && r <= n
  ? factorial(n) / factorial(n - r) : NaN);

type Fn = { args: [number, number]; f: (deg: boolean) => (...a: number[]) => number; help: string };
const one = (help: string, f: (v: number) => number): Fn => ({ args: [1, 1], f: () => f, help });
const trig = (help: string, f: (v: number) => number): Fn => ({ args: [1, 1], f: (deg) => (deg ? (v) => f(v * DEG) : f), help });
const arc = (help: string, f: (v: number) => number): Fn => ({ args: [1, 1], f: (deg) => (deg ? (v) => f(v) / DEG : f), help });
/** Rounding helper: sin(180°) should be 0, not 1.2e-16. */
const tidy = (v: number) => (Math.abs(v) < 1e-15 ? 0 : v);

/** Every function the parser knows, by lower-case name. `help` is shown in the calculator's list. */
export const FUNCS: Record<string, Fn> = {
  sin: trig('sine', (v) => tidy(Math.sin(v))),
  cos: trig('cosine', (v) => tidy(Math.cos(v))),
  // in degrees, tan(90) has no value (the radian version only gets close to the pole: 1.6e16)
  tan: { args: [1, 1], f: (deg) => (deg ? (v) => (Math.abs((((v % 180) + 180) % 180) - 90) < 1e-9 ? Infinity : tidy(Math.tan(v * DEG))) : (v) => tidy(Math.tan(v))), help: 'tangent' },
  sec: trig('secant, 1/cos', (v) => 1 / tidy(Math.cos(v))),
  csc: trig('cosecant, 1/sin', (v) => 1 / tidy(Math.sin(v))),
  cot: trig('cotangent, 1/tan', (v) => 1 / tidy(Math.tan(v))),
  asin: arc('inverse sine', Math.asin), acos: arc('inverse cosine', Math.acos), atan: arc('inverse tangent', Math.atan),
  arcsin: arc('inverse sine', Math.asin), arccos: arc('inverse cosine', Math.acos), arctan: arc('inverse tangent', Math.atan),
  atan2: { args: [2, 2], f: (deg) => (y, x) => Math.atan2(y, x) / (deg ? DEG : 1), help: 'angle of the point (x, y): atan2(y, x)' },
  sinh: one('hyperbolic sine', Math.sinh), cosh: one('hyperbolic cosine', Math.cosh), tanh: one('hyperbolic tangent', Math.tanh),
  asinh: one('inverse hyperbolic sine', Math.asinh), acosh: one('inverse hyperbolic cosine', Math.acosh), atanh: one('inverse hyperbolic tangent', Math.atanh),
  sqrt: one('square root', Math.sqrt),
  cbrt: one('cube root', Math.cbrt),
  root: { args: [2, 2], f: () => (x, n) => (x < 0 && Math.abs(n % 2) === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)), help: 'nth root: root(27, 3) = 3' },
  abs: one('size without the sign', Math.abs),
  exp: one('e to the power', Math.exp),
  ln: one('natural log (base e)', Math.log),
  log: { args: [1, 2], f: () => (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)), help: 'log base 10; log(x, b) is base b' },
  log10: one('log base 10', Math.log10),
  log2: one('log base 2', Math.log2),
  floor: one('round down', Math.floor),
  ceil: one('round up', Math.ceil),
  round: { args: [1, 2], f: () => (x, d) => { const p = Math.pow(10, d ?? 0); return Math.round(x * p) / p; }, help: 'round; round(x, 2) keeps 2 decimals' },
  sign: one('−1, 0 or 1', Math.sign), sgn: one('−1, 0 or 1', Math.sign),
  fact: one('factorial (same as n!)', factorial),
  ncr: { args: [2, 2], f: () => nCr, help: 'combinations: nCr(5, 2) = 10' },
  npr: { args: [2, 2], f: () => nPr, help: 'permutations: nPr(5, 2) = 20' },
  mod: { args: [2, 2], f: () => (a, b) => ((a % b) + b) % b, help: 'remainder: mod(17, 5) = 2' },
  max: { args: [1, 99], f: () => Math.max, help: 'largest of several' },
  min: { args: [1, 99], f: () => Math.min, help: 'smallest of several' },
  hypot: { args: [1, 99], f: () => Math.hypot, help: '√(a² + b² + …)' },
};

/** Named constants (a caller's own variable of the same name wins). */
export const CONSTANTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, tau: 2 * Math.PI, 'τ': 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, 'φ': (1 + Math.sqrt(5)) / 2, e: Math.E };

const FUNC_NAMES = Object.keys(FUNCS).sort((a, b) => b.length - a.length);

/** Tidy what people type: ** and the maths symbols become the operators the parser reads. */
function normalise(src: string) {
  return src.replace(/\s+/g, ' ').trim().replace(/\*\*/g, '^').replace(/[·×∙⋅]/g, '*').replace(/÷/g, '/')
    .replace(/[−–]/g, '-').replace(/²/g, '^2').replace(/³/g, '^3');
}

/** Compile `src` into a function of the scope. Throws `MathError` when it can't be read. */
export function compileExpr(src: string, opts: CompileOptions = {}): Evaluator {
  const s = normalise(src);
  const deg = !!opts.deg;
  if (!s) throw new MathError('Type a calculation');
  let i = 0;
  let bars = 0; // how many |abs bars| are open: a | then closes one instead of starting a product
  const skip = () => { while (s[i] === ' ') i++; };
  const peek = () => { skip(); return s[i]; };
  const names = [...(opts.names ?? [])].sort((a, b) => b.length - a.length);
  const consts = Object.keys(CONSTANTS).sort((a, b) => b.length - a.length);
  const missing = (after?: string) => new MathError(after ? `Something's missing after “${after}”` : 'The calculation stops too early');

  const expr = (): Evaluator => {
    let f = term();
    for (;;) {
      const c = peek();
      if (c !== '+' && c !== '-') return f;
      i++;
      if (peek() === undefined) throw missing(c);
      const a = f, b = term();
      f = c === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v);
    }
  };
  const startsAtom = (c: string | undefined) => !!c && (/[a-z0-9.(√πτφ]/i.test(c) || (c === '|' && bars === 0));
  const term = (): Evaluator => {
    let f = unary();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        if (peek() === undefined) throw missing(c);
        const a = f, b = unary();
        f = c === '*' ? (v) => a(v) * b(v) : (v) => a(v) / b(v);
      } else if (startsAtom(c)) {
        const a = f, b = unary();
        f = (v) => a(v) * b(v);
      } else return f;
    }
  };
  const unary = (): Evaluator => {
    const c = peek();
    if (c === '-') { i++; if (peek() === undefined) throw missing('-'); const a = unary(); return (v) => -a(v); }
    if (c === '+') { i++; return unary(); }
    return power();
  };
  const power = (): Evaluator => {
    const a = postfix();
    if (peek() === '^') {
      i++;
      if (peek() === undefined) throw missing('^');
      const b = unary();
      return (v) => Math.pow(a(v), b(v));
    }
    return a;
  };
  const postfix = (): Evaluator => {
    let a = atom();
    for (;;) {
      const c = peek();
      if (c === '!') { i++; const g = a; a = (v) => factorial(g(v)); } else if (c === '%') { i++; const g = a; a = (v) => g(v) / 100; } else return a;
    }
  };
  const args = (name: string): Evaluator[] => {
    // after the opening bracket
    const out: Evaluator[] = [];
    if (peek() === ')') throw new MathError(`${name} needs a number in its brackets`);
    for (;;) {
      out.push(expr());
      const c = peek();
      if (c === ',') { i++; continue; }
      if (c === ')') { i++; return out; }
      if (c === undefined) throw new MathError("A bracket isn't closed");
      throw new MathError(`Can't read “${s.slice(i, i + 8)}”`);
    }
  };
  const atom = (): Evaluator => {
    const c = peek();
    if (c === undefined) throw missing();
    if (c === '(') {
      i++;
      if (peek() === ')') throw new MathError('There are empty brackets');
      const a = expr();
      const d = peek();
      if (d === undefined) throw new MathError("A bracket isn't closed");
      if (d !== ')') throw new MathError(d === ',' ? 'A comma only goes between a function’s numbers, like log(8, 2)' : `Can't read “${s.slice(i, i + 8)}”`);
      i++;
      return a;
    }
    if (c === ')') throw new MathError("There's a closing bracket with no opening one");
    if (c === '|') {
      i++;
      bars++;
      const a = expr();
      if (peek() !== '|') throw new MathError("An absolute value bar | isn't closed");
      i++;
      bars--;
      return (v) => Math.abs(a(v));
    }
    if (c === '√') {
      i++;
      if (peek() === undefined) throw missing('√');
      const a = postfix();
      return (v) => Math.sqrt(a(v));
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { i += num[0].length; const n = parseFloat(num[0]); return () => n; }
    const rest = s.slice(i);
    const lower = rest.toLowerCase();
    // a function: its name followed by a bracket or a space (so "e" or "x" next to letters aren't mistaken for one)
    const fn = FUNC_NAMES.find((f) => lower.startsWith(f) && /^[\s(]/.test(rest.slice(f.length)));
    if (fn) {
      i += fn.length;
      const spec = FUNCS[fn];
      const g = spec.f(deg);
      let a: Evaluator[];
      if (peek() === '(') { i++; a = args(fn); } else {
        if (peek() === undefined) throw missing(fn);
        a = [postfix()]; // "sin x", "sin 2x" = sin(2)·x, as graphs always read it
      }
      const [lo, hi] = spec.args;
      if (a.length < lo || a.length > hi) {
        throw new MathError(lo === hi ? `${fn} takes ${lo === 1 ? 'one number' : `${lo} numbers`}` : `${fn} takes ${lo} to ${hi} numbers`);
      }
      if (a.length === 1) { const [p] = a; return (v) => g(p(v)); }
      if (a.length === 2) { const [p, q] = a; return (v) => g(p(v), q(v)); }
      return (v) => g(...a.map((p) => p(v)));
    }
    const name = names.find((n) => rest.startsWith(n));
    if (name) { i += name.length; return (v) => v[name] ?? NaN; }
    const k = consts.find((n) => lower.startsWith(n));
    if (k) { i += k.length; const n = CONSTANTS[k]; return () => n; }
    const word = /^[a-z_]+/i.exec(rest)?.[0];
    if (word) {
      if (FUNCS[word.toLowerCase()]) throw new MathError(`${word} needs a number after it, like ${word.toLowerCase()}(2)`);
      throw new MathError(`I don't know “${word}”`);
    }
    if (c === ',') throw new MathError('A comma only goes between a function’s numbers, like log(8, 2)');
    if ('+*/^!%'.includes(c)) throw new MathError(`Something's missing before “${c}”`);
    throw new MathError(`Can't read “${c}”`);
  };
  const f = expr();
  const c = peek();
  if (c !== undefined) {
    if (c === ')') throw new MathError("There's a closing bracket with no opening one");
    if (c === '|') throw new MathError("There's an absolute value bar | with no opening one");
    throw new MathError(`Can't read “${s.slice(i, i + 8)}”`);
  }
  return f;
}

export type EvalResult = { value: number; error?: undefined } | { value?: undefined; error: string };

/** Work out `src` for the calculator: the number, or a plain explanation of why there isn't one. */
export function evaluate(src: string, scope: Scope = {}, opts: CompileOptions = {}): EvalResult {
  let f: Evaluator;
  try { f = compileExpr(src, { names: Object.keys(scope), ...opts }); } catch (e) {
    return { error: e instanceof MathError ? e.message : 'That couldn’t be worked out' };
  }
  const v = f(scope);
  if (Number.isNaN(v)) return { error: 'That isn’t a real number (for example the square root of a negative number, or 0 ÷ 0)' };
  if (!Number.isFinite(v)) return { error: 'That’s too big to show, or it divides by zero' };
  return { value: v };
}

/** A result as people write it: at most 12 significant figures (so 0.1 + 0.2 shows 0.3), powers of ten for huge
 * or tiny numbers ("1.5e+20" becomes "1.5 × 10^20"). */
export function formatNumber(v: number, digits = 12): string {
  if (Number.isNaN(v)) return 'not a number';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e12 || a < 1e-9) {
    const [m, e] = v.toExponential(digits - 3).split('e');
    const mant = String(parseFloat(m));
    return `${mant} × 10^${Number(e)}`;
  }
  return String(parseFloat(v.toPrecision(digits)));
}
