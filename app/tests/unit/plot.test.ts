import { describe, expect, it } from 'vitest';
import { compile, plotRange, traceRuns } from '../../src/components/plot';

/** Sample `expr` like the plot does (401 points) and split it into runs for the window [y0, y1]. */
function trace(expr: string, x0: number, x1: number, y0: number, y1: number) {
  const f = compile(expr);
  const fn = (x: number) => f(x, {});
  const pts: [number, number][] = [];
  for (let k = 0; k <= 400; k++) { const x = x0 + ((x1 - x0) * k) / 400; pts.push([x, fn(x)]); }
  return traceRuns(pts, fn, y0, y1).runs;
}

/** No drawn segment may cross the whole window from beyond one edge to beyond the other (a joined asymptote). */
function noJoinedPoles(runs: [number, number][][], y0: number, y1: number) {
  for (const run of runs) {
    for (let j = 1; j < run.length; j++) {
      const [a, b] = [run[j - 1][1], run[j][1]];
      expect((a > y1 && b < y0) || (a < y0 && b > y1)).toBe(false);
    }
  }
}

describe('plot asymptotes', () => {
  it('lifts the pen at every pole of tan x', () => {
    const runs = trace('tan(x)', -10, 10, -10, 10);
    expect(runs.length).toBe(7); // poles at ±π/2, ±3π/2, ±5π/2
    noJoinedPoles(runs, -10, 10);
  });

  it('splits 1/x on a range that does not sample x = 0', () => {
    const runs = trace('1/x', -3, 7, -5, 5);
    expect(runs.length).toBe(2);
    noJoinedPoles(runs, -5, 5);
    // the branches run off opposite edges
    expect(runs[0][runs[0].length - 1][1]).toBeLessThan(-5);
    expect(runs[1][0][1]).toBeGreaterThan(5);
  });

  it('splits 1/(x-2)', () => {
    const runs = trace('1/(x-2)', -5, 5.3, -4, 4);
    expect(runs.length).toBe(2);
    noJoinedPoles(runs, -4, 4);
  });

  it('keeps steep continuous curves joined', () => {
    expect(trace('x^5', -10, 10, -1e5, 1e5).length).toBe(1);
    expect(trace('x^5', -2, 2, -1, 1).length).toBe(1);
    expect(trace('1000x', -1, 1, -1, 1).length).toBe(1);
  });

  it('fits the window to the curve, not to the values beside a pole', () => {
    const [y0, y1] = plotRange({ functions: [{ expr: 'tan(x)' }], x: [-10, 10] });
    expect(y1 - y0).toBeLessThan(60);
    expect(y1).toBeGreaterThan(2);
  });
});
