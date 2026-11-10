import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../../src/events', () => ({ onChange: () => () => {} }));

const { usePoll } = await import('../../src/hooks');

/** A request whose answer the test delivers when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('usePoll', () => {
  it('keeps the newest answer when requests answer out of order', async () => {
    const calls: ReturnType<typeof deferred<string>>[] = [];
    const box = { data: null as string | null, reload: async () => {} };
    const C = () => {
      const p = usePoll(() => { const d = deferred<string>(); calls.push(d); return d.promise; }, 0);
      box.data = p.data;
      box.reload = p.reload;
      return null;
    };
    act(() => { createRoot(document.createElement('div')).render(<C />); });
    act(() => { box.reload(); }); // a second request while the first is still out
    expect(calls.length).toBe(2);
    await act(async () => { calls[1].resolve('new'); await calls[1].promise; });
    expect(box.data).toBe('new');
    await act(async () => { calls[0].resolve('old'); await calls[0].promise; }); // the slow first one lands last
    expect(box.data).toBe('new');
  });

  it('ignores an answer that was asked for the previous deps', async () => {
    const calls: Record<number, ReturnType<typeof deferred<string>>> = {};
    const box = { data: null as string | null };
    const C = ({ id }: { id: number }) => {
      box.data = usePoll(() => { calls[id] = deferred<string>(); return calls[id].promise; }, 0, [id]).data;
      return null;
    };
    const root = createRoot(document.createElement('div'));
    act(() => { root.render(<C id={1} />); });
    act(() => { root.render(<C id={2} />); });
    await act(async () => { calls[1].resolve('subject 1'); await calls[1].promise; }); // would show the wrong subject's data
    expect(box.data).toBe(null);
    await act(async () => { calls[2].resolve('subject 2'); await calls[2].promise; });
    expect(box.data).toBe('subject 2');
  });
});
