import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatEvent } from '../../src/api';

vi.mock('../../src/api', () => ({
  api: { chat: vi.fn(async () => ({ messages: [] })), stopChat: vi.fn(async () => ({})), logClient: vi.fn(async () => ({})) },
}));

const streams = await import('../../src/chatStreams');

/** Renders a component that counts its renders. */
function mount(use: () => unknown) {
  const box = { renders: 0, value: undefined as unknown };
  const C = () => { box.value = use(); box.renders++; return null; };
  const el = document.createElement('div');
  act(() => { createRoot(el).render(<C />); });
  return box;
}

describe('chat stream store', () => {
  it('keeps text out of the badge subscribers and batches it for the live bubble', async () => {
    vi.useFakeTimers();
    const badges = mount(() => streams.useChatStreams().live(7)?.status);
    const bubble = mount(() => streams.useLiveReply(7)?.text);
    let push!: (e: ChatEvent) => void;
    let finish!: () => void;
    let done!: Promise<void>;
    act(() => {
      done = streams.startReply(7, 1, 'off', (on) => new Promise<void>((res) => { push = on; finish = res; }));
    });
    const b0 = badges.renders, l0 = bubble.renders;
    act(() => { push({ type: 'delta', text: 'Hel' } as ChatEvent); }); // first text: status clears, badges hear once
    const b1 = badges.renders;
    expect(b1).toBe(b0 + 1);
    act(() => { for (const t of 'lo there, how are you'.split('')) push({ type: 'delta', text: t } as ChatEvent); });
    expect(badges.renders).toBe(b1); // no badge re-render per token
    act(() => { vi.advanceTimersByTime(100); });
    expect(bubble.value).toBe('Hello there, how are you');
    expect(bubble.renders - l0).toBeLessThanOrEqual(3); // first text + one batch (not one per token)
    expect(streams.isLive(7)).toBe(true);
    await act(async () => { finish(); await done; });
    expect(streams.isLive(7)).toBe(false);
    expect(bubble.value).toBeUndefined();
    vi.useRealTimers();
  });

  it('marks a reply that ends in a chat not on screen as unread, and clears it when viewed', async () => {
    const badges = mount(() => streams.useChatStreams().unread(9));
    streams.setViewing(null);
    await act(async () => { await streams.startReply(9, 2, 'off', async () => {}); });
    expect(badges.value).toEqual({ subjectId: 2 });
    act(() => { streams.setViewing(9); });
    expect(badges.value).toBeUndefined();
  });
});
