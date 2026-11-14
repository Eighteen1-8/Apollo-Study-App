import { describe, expect, it } from 'vitest';
import { compileExpr, evaluate, factorial, formatNumber } from '../../src/components/mathExpr';

const val = (src: string, scope: Record<string, number> = {}, deg = false) => {
  const r = evaluate(src, scope, { deg });
  if (r.error !== undefined) throw new Error(`${src}: ${r.error}`);
  return r.value;
};
const err = (src: string, scope: Record<string, number> = {}) => evaluate(src, scope).error;

describe('the calculator evaluator', () => {
  it('follows the order of operations', () => {
    expect(val('1 + 2 * 3')).toBe(7);
    expect(val('(1 + 2) * 3')).toBe(9);
    expect(val('2^3^2')).toBe(512); // right to left
    expect(val('-2^2')).toBe(-4);
    expect(val('2^-1')).toBe(0.5);
    expect(val('10 / 4 / 5')).toBe(0.5);
    expect(val('8 − 3 × 2 ÷ 4')).toBe(6.5);
  });

  it('multiplies implicitly', () => {
    expect(val('2pi')).toBeCloseTo(2 * Math.PI);
    expect(val('3(1+1)')).toBe(6);
    expect(val('(1+1)(2+1)')).toBe(6);
    expect(val('2x', { x: 4 })).toBe(8);
    expect(val('2 sin(0)')).toBe(0);
    expect(val('2√9')).toBe(6);
  });

  it('knows factorials, per cent, powers and roots', () => {
    expect(val('5!')).toBe(120);
    expect(val('0!')).toBe(1);
    expect(val('2^3!')).toBe(64);
    expect(val('0.5!')).toBeCloseTo(Math.sqrt(Math.PI) / 2, 10);
    expect(factorial(-1)).toBeNaN();
    expect(val('50%')).toBe(0.5);
    expect(val('200 * 15%')).toBeCloseTo(30);
    expect(val('3²')).toBe(9);
    expect(val('2**10')).toBe(1024);
    expect(val('√16')).toBe(4);
    expect(val('root(27, 3)')).toBeCloseTo(3);
    expect(val('root(-8, 3)')).toBeCloseTo(-2);
    expect(val('cbrt(-27)')).toBeCloseTo(-3);
  });

  it('has the usual functions and constants', () => {
    expect(val('ln(e)')).toBeCloseTo(1);
    expect(val('log(1000)')).toBeCloseTo(3);
    expect(val('log(8, 2)')).toBeCloseTo(3);
    expect(val('log2(1024)')).toBe(10);
    expect(val('abs(-3)')).toBe(3);
    expect(val('|2 - 5|')).toBe(3);
    expect(val('2|1-3|')).toBe(4);
    expect(val('nCr(5, 2)')).toBe(10);
    expect(val('nPr(5, 2)')).toBe(20);
    expect(val('mod(-7, 3)')).toBe(2);
    expect(val('max(1, 9, 4)')).toBe(9);
    expect(val('round(3.14159, 2)')).toBe(3.14);
    expect(val('π')).toBeCloseTo(Math.PI);
    expect(val('tau')).toBeCloseTo(2 * Math.PI);
    expect(val('1.5e3')).toBe(1500);
    expect(val('2e')).toBeCloseTo(2 * Math.E);
    expect(val('exp(1)')).toBeCloseTo(Math.E);
  });

  it('works in degrees or radians', () => {
    expect(val('sin(90)', {}, true)).toBe(1);
    expect(val('sin(180)', {}, true)).toBe(0);
    expect(val('cos(60)', {}, true)).toBeCloseTo(0.5);
    expect(val('asin(1)', {}, true)).toBeCloseTo(90);
    expect(val('sin(pi/2)')).toBe(1);
    expect(evaluate('tan(90)', {}, { deg: true }).error).toMatch(/too big|divides by zero/);
  });

  it('uses ans and other variables', () => {
    expect(val('ans * 2', { ans: 21 })).toBe(42);
    expect(val('ans2', { ans: 3 })).toBe(6);
  });

  it('explains what is wrong in plain words', () => {
    expect(err('')).toBe('Type a calculation');
    expect(err('(1 + 2')).toMatch(/bracket isn't closed/);
    expect(err('1 + 2)')).toMatch(/closing bracket with no opening/);
    expect(err('2 +')).toMatch(/missing after “\+”/);
    expect(err('* 3')).toMatch(/missing before “\*”/);
    expect(err('foo(2)')).toMatch(/don't know “foo”/);
    expect(err('sqrt')).toMatch(/needs a number/);
    expect(err('nCr(5)')).toMatch(/takes 2 numbers/);
    expect(err('()')).toMatch(/empty brackets/);
    expect(err('sqrt(-1)')).toMatch(/isn’t a real number/);
    expect(err('1/0')).toMatch(/divides by zero/);
    expect(err('2 # 3')).toMatch(/Can't read/);
  });

  it('never runs code', () => {
    expect(err('alert(1)')).toMatch(/don't know/);
    expect(err('constructor')).toBeDefined();
    expect(() => compileExpr('x; process.exit()', { names: ['x'] })).toThrow();
  });
});

describe('formatNumber', () => {
  it('hides floating-point noise and uses powers of ten for extremes', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.333333333333');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(1.5e20)).toBe('1.5 × 10^20');
    expect(formatNumber(6.62607015e-34)).toBe('6.62607015 × 10^-34');
    expect(formatNumber(123456)).toBe('123456');
    // what it shows can be typed back in
    expect(val(formatNumber(1.5e20))).toBe(1.5e20);
  });
});
