import { describe, expect, it } from 'vitest';
import { meteors } from '../../src/components/Ambient';
import type { EffectAmount } from '../../src/theme';

/** A 2D context that only counts strokes (jsdom has no canvas). */
function fakeCtx() {
  const calls = { stroke: 0 };
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'stroke' ? () => { calls.stroke++; } : () => {}),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** 30 seconds at 60 fps: how many frames showed a meteor, and the most shown in one frame. */
function run(level: EffectAmount) {
  const fx = meteors(1280, 800, level, false, '#8b9bff');
  const { ctx, calls } = fakeCtx();
  let framesWithMeteor = 0, most = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const before = calls.stroke;
    fx.step(1 / 60, i / 60);
    fx.draw(ctx);
    const n = calls.stroke - before;
    if (n > 0) framesWithMeteor++;
    most = Math.max(most, n);
  }
  return { framesWithMeteor, most };
}

describe('background meteors', () => {
  it('light sends a few streaks across, not a constant shower, and clears them away', () => {
    const { framesWithMeteor } = run('light');
    expect(framesWithMeteor).toBeGreaterThan(0); // at least one went by
    expect(framesWithMeteor).toBeLessThan(60 * 30 * 0.5); // the sky is empty most of the time
  });

  it('heavy keeps the sky busy and shows several at once', () => {
    const { framesWithMeteor, most } = run('heavy');
    expect(framesWithMeteor).toBeGreaterThan(60 * 30 * 0.5);
    expect(most).toBeGreaterThanOrEqual(3); // a shower went by
    expect(most).toBeLessThanOrEqual(40); // capped
  });
});
