import { describe, expect, it } from 'vitest';
import { meteors } from '../../src/components/Ambient';

/** A 2D context that only counts strokes (jsdom has no canvas). */
function fakeCtx() {
  const calls = { stroke: 0 };
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'stroke' ? () => { calls.stroke++; } : () => {}),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('background meteors', () => {
  it('sends a few streaks across, not a constant shower, and clears them away', () => {
    const fx = meteors(1280, 800, 1, false, '#8b9bff');
    const { ctx, calls } = fakeCtx();
    let framesWithMeteor = 0;
    for (let i = 0; i < 60 * 30; i++) { // 30 seconds at 60 fps
      const before = calls.stroke;
      fx.step(1 / 60, i / 60);
      fx.draw(ctx);
      if (calls.stroke > before) framesWithMeteor++;
    }
    expect(framesWithMeteor).toBeGreaterThan(0); // at least one went by
    expect(framesWithMeteor).toBeLessThan(60 * 30 * 0.5); // the sky is empty most of the time
  });
});
