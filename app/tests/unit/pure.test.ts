import { describe, expect, it } from 'vitest';
import { moved } from '../../src/components/reorder';
import { score } from '../../src/components/fuzzy';
import { matchCommands, COMMANDS, runsAtOnce, slashMatches } from '../../src/components/slashCommands';
import { markHighlight } from '../../src/components/highlights';
import { calcCommand, graphArg, graphError, plotBlock, resultText, withGraphFn } from '../../src/components/calcText';
import { blockCuts, renderMarkdown, repairTables } from '../../src/components/Markdown';
import { dustPerNode } from '../../src/components/EmbeddingCloud';

describe('reorder.moved', () => {
  it('moves an item before or after another', () => {
    expect(moved([1, 2, 3, 4], 1, 3, false)).toEqual([2, 1, 3, 4]);
    expect(moved([1, 2, 3, 4], 1, 3, true)).toEqual([2, 3, 1, 4]);
    expect(moved([1, 2, 3, 4], 4, 1, false)).toEqual([4, 1, 2, 3]);
  });
  it('leaves the list alone when the target is missing', () => {
    expect(moved([1, 2, 3], 1, 9, false)).toEqual([1, 2, 3]);
  });
});

describe('palette score', () => {
  const s = (hay: string, q: string) => score(hay, q.toLowerCase().split(/\s+/));
  it('matches substrings, best at the start and at word starts', () => {
    expect(s('projectile motion.pdf', 'proj')).toBeLessThan(s('a projectile motion.pdf', 'proj'));
    expect(s('a projectile.pdf', 'proj')).toBeLessThan(s('aprojectile.pdf', 'proj'));
  });
  it('needs every word', () => {
    expect(s('projectile motion.pdf', 'proj zebra')).toBe(-1);
    expect(s('projectile motion.pdf', 'motion proj')).toBeGreaterThanOrEqual(0);
  });
  it('tolerates a small typo but not letters scattered across a long name', () => {
    expect(s('snells law.pdf', 'snels')).toBeGreaterThanOrEqual(0);
    expect(s('second newton law of linear lens.pdf', 'snell')).toBe(-1);
    expect(s('xyz', 'ab')).toBe(-1);
  });
});

describe('slash commands', () => {
  it('lists commands that start with the typed text first', () => {
    expect(matchCommands('st').map((c) => c.name)).toEqual(['stats', 'stop']);
    expect(matchCommands('').length).toBe(COMMANDS.length);
    expect(matchCommands('ats').map((c) => c.name)).toEqual(['stats']);
  });
  it('suggests only while a command name is being typed (the composer and the study bar)', () => {
    expect(slashMatches('/st').map((c) => c.name)).toEqual(['stats', 'stop']);
    expect(slashMatches('/').length).toBe(COMMANDS.length);
    expect(slashMatches('/stats chat')).toEqual([]); // arguments being typed
    expect(slashMatches('what is /st')).toEqual([]);
  });
  it('runs a command at once only when it needs nothing more', () => {
    const byName = (n: string) => COMMANDS.find((c) => c.name === n)!;
    expect(runsAtOnce(byName('new'))).toBe(true); // no arguments
    expect(runsAtOnce(byName('stats'))).toBe(true); // optional ones
    expect(runsAtOnce(byName('todo'))).toBe(false); // needs text
    expect(runsAtOnce(byName('effort'))).toBe(false);
    expect(runsAtOnce(byName('calc'))).toBe(true); // opens the calculator
    expect(runsAtOnce(byName('graph'))).toBe(false); // needs a function
  });
  it('offers the calculator commands', () => {
    expect(slashMatches('/ca').map((c) => c.name)).toEqual(['calc']);
    expect(slashMatches('/gr').map((c) => c.name)).toEqual(['graph']);
    expect(slashMatches('/calc 2+2')).toEqual([]);
    expect(matchCommands('c').map((c) => c.name)).toContain('calc');
  });
});

describe('calculator text for the chat', () => {
  it('writes a result and a graph Apollo can read', () => {
    expect(resultText(' 2sin(30) ', 1)).toBe('2sin(30) = 1');
    const block = plotBlock(['sin(x)', '', 'x^', 'x^2'], [-10, 10]);
    expect(block.startsWith('```plot\n') && block.endsWith('\n```')).toBe(true);
    const spec = JSON.parse(block.slice(8, -4));
    expect(spec.functions.map((f: { expr: string }) => f.expr)).toEqual(['sin(x)', 'x^2']); // only drawable rows
    expect(spec.x).toEqual([-10, 10]);
    expect(spec.y).toBeUndefined();
    expect(JSON.parse(plotBlock(['x'], [0, 1], [0.123456789, 2]).slice(8, -4)).y).toEqual([0.123457, 2]); // a moved view
  });
  it('reads /graph and /calc', () => {
    expect(graphArg('y = x^2')).toBe('x^2');
    expect(graphArg('f(x)= sin x')).toBe('sin x');
    expect(graphError('x^2 - 3')).toBeNull();
    expect(graphError('')).toMatch(/after the command/);
    expect(graphError('x^')).toMatch(/missing/);
    expect(calcCommand('2sin(30) + 5!', { deg: true, ans: 0 })).toEqual({ value: 121 });
    expect(calcCommand('ans * 2', { deg: true, ans: 21 })).toEqual({ value: 42 });
    expect('error' in calcCommand('1/0', { deg: true, ans: 0 })).toBe(true);
  });
  it('adds a function to the graph rows', () => {
    expect(withGraphFn(['sin(x)', ''], 'x^2', 6)).toEqual(['sin(x)', 'x^2']);
    expect(withGraphFn(['sin(x)'], 'sin(x)', 6)).toEqual(['sin(x)']);
    expect(withGraphFn(['a', 'b'], 'x', 3)).toEqual(['a', 'b', 'x']);
    expect(withGraphFn(['a', 'b', 'c'], 'x', 3)).toEqual(['a', 'b', 'x']);
  });
});

describe('markHighlight', () => {
  it('names presets and custom colours, and styles a custom colour once', () => {
    expect(markHighlight('yellow')).toBe('mark-yellow');
    expect(markHighlight('#AABBCC')).toBe('mark-c-aabbcc');
    markHighlight('#aabbcc');
    const css = document.getElementById('mark-colours')!.textContent!;
    expect(css.match(/mark-c-aabbcc/g)).toHaveLength(1);
    expect(document.getElementById('mark-colours')!.textContent).not.toContain('mark-yellow');
  });
});

describe('Markdown', () => {
  it('repairs a bare pipe table', () => {
    expect(repairTables('Intro\na | b\n1 | 2')).toBe('Intro\n\na | b\n--- | ---\n1 | 2');
  });
  it('cuts a streaming reply only between independent blocks', () => {
    const text = 'One para.\n\nTwo para.\n\n```\ncode\n\nmore\n```\n\n- a\n\n- b\n\n$$\nx\n\ny\n$$\n\nEnd';
    const cuts = blockCuts(text);
    const parts = cuts.map((c, i) => text.slice(cuts[i - 1] ?? 0, c));
    expect(parts[0]).toBe('One para.\n\n');
    expect(parts[1]).toBe('Two para.\n\n');
    // no cut inside the code fence, between list items, or inside $$ maths
    expect(parts.some((p) => p.includes('code\n\n') && !p.includes('more'))).toBe(false);
    expect(parts.some((p) => p.includes('- a') && !p.includes('- b'))).toBe(false);
    expect(parts.some((p) => p.includes('x\n\n') && !p.includes('y'))).toBe(false);
  });
  it('renders blocks the same as the whole, for plain paragraphs and headings', () => {
    const text = '## Title\n\nFirst $x^2$ para.\n\nSecond **bold** para.';
    const cuts = blockCuts(text);
    const blocks = [0, ...cuts].map((c, i) => text.slice(c, cuts[i]));
    const joined = blocks.map((b) => renderMarkdown(b)).join('').replace(/\s+/g, '');
    expect(joined).toBe(renderMarkdown(text).replace(/\s+/g, ''));
  });
  it('strips scripts and outside links', () => {
    const html = renderMarkdown('<img src="http://evil/x.png" onerror="alert(1)"> [a](http://evil) <script>x()</script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('http://evil');
    expect(html).not.toContain('<script');
  });
});

describe('cloud dust budget', () => {
  const per = dustPerNode;
  it('keeps small libraries as before and caps big ones at 2,500 specks', () => {
    expect(per(20)).toBe(40);
    expect(per(100)).toBe(14);
    expect(per(500) * 500).toBe(2000);
    expect(per(3000) * 3000).toBeCloseTo(2500);
    expect(per(3000)).toBeGreaterThan(0);
  });
});
