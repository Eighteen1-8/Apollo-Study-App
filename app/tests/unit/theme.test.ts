import { describe, expect, it } from 'vitest';
import { migrateAppearance, scaleStep } from '../../src/theme';

describe('saved appearance', () => {
  it('moves the old default frame rate (60) to the display rate once', () => {
    expect(migrateAppearance({ cloudFps: 60 }).cloudFps).toBe(0);
    expect(migrateAppearance({ cloudFps: 30 }).cloudFps).toBe(30);
    // chosen after the change: kept
    expect(migrateAppearance({ cloudFps: 60, version: 1 }).cloudFps).toBe(60);
    expect(migrateAppearance({}).cloudFps).toBe(0);
  });

  it('turns the three-step text size into a UI size', () => {
    expect(migrateAppearance({ textSize: 'large' }).uiScale).toBe(112);
    expect(migrateAppearance({ textSize: 'xl' }).uiScale).toBe(125);
    expect(migrateAppearance({ textSize: 'normal' }).uiScale).toBe(100);
    expect('textSize' in migrateAppearance({ textSize: 'xl' })).toBe(false);
    expect(migrateAppearance({ uiScale: 400 }).uiScale).toBe(160);
  });

  it('steps the UI size on a 5% grid within 80–160%', () => {
    expect(scaleStep(100, 1)).toBe(105);
    expect(scaleStep(112, 1)).toBe(115);
    expect(scaleStep(112, -1)).toBe(110);
    expect(scaleStep(160, 1)).toBe(160);
    expect(scaleStep(80, -1)).toBe(80);
    expect(scaleStep(135, 0)).toBe(100);
  });
});
