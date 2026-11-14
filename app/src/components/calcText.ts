/* The calculator's results as text for the chat (Calculator.tsx "Send to chat", the /calc and /graph commands). Pure,
   so the unit tests cover it. */
import { compileExpr, evaluate, formatNumber, MathError } from './mathExpr';

/** "2sin(30) = 1" for the chat box. */
export const resultText = (expr: string, value: number) => `${expr.trim()} = ${formatNumber(value)}`;

/** The graph as a ```plot block the chat draws (and Apollo can read): only the functions that can be drawn. */
export function plotBlock(fns: string[], x: [number, number], y?: [number, number]): string {
  const functions = fns.map((f) => f.trim()).filter((f) => f && graphError(f) === null).map((expr) => ({ expr, label: `y = ${expr}` }));
  const round = (n: number) => Number(n.toPrecision(6));
  const spec: Record<string, unknown> = { functions, x: x.map(round) };
  if (y) spec.y = y.map(round);
  return `\`\`\`plot\n${JSON.stringify(spec)}\n\`\`\``;
}

/** /graph's text without a leading "y =" or "f(x) =". */
export const graphArg = (arg: string) => arg.trim().replace(/^(y|f\s*\(\s*x\s*\))\s*=\s*/i, '').trim();

/** Why a function of x can't be drawn, in plain words (null: it can). */
export function graphError(expr: string): string | null {
  if (!expr.trim()) return 'Write the function after the command, e.g. /graph x^2 - 3';
  try {
    compileExpr(expr, { names: ['x'] });
    return null;
  } catch (e) {
    return e instanceof MathError ? e.message : 'That function can’t be read.';
  }
}

/** The graph rows with `expr` added: kept where it already is, else in the first empty row, else after the others
 * (the last row is replaced when all `max` are used). */
export function withGraphFn(fns: string[], expr: string, max: number): string[] {
  const e = expr.trim();
  if (fns.some((f) => f.trim() === e)) return fns;
  const empty = fns.findIndex((f) => !f.trim());
  if (empty >= 0) return fns.map((f, i) => (i === empty ? e : f));
  if (fns.length < max) return [...fns, e];
  return [...fns.slice(0, max - 1), e];
}

/** /calc <expression>: the answer, or a plain reason it can't be worked out. */
export function calcCommand(expr: string, opts: { deg: boolean; ans: number }): { value: number } | { error: string } {
  const r = evaluate(expr, { ans: opts.ans }, { deg: opts.deg });
  return r.error !== undefined ? { error: r.error } : { value: r.value };
}
