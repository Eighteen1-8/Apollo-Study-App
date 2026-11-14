import { describe, expect, it } from 'vitest';
import { clampView, cropRect, zoomAt } from '../../src/components/ImageCrop';

// a 600×300 picture in a 300 px frame: at zoom 1 its height just fills the frame (scale 1), so it is 600 px wide
const W = 600, H = 300, F = 300;

describe('icon crop maths', () => {
  it('keeps the picture covering the whole frame', () => {
    expect(clampView({ z: 1, x: 50, y: 20 }, W, H, F)).toEqual({ z: 1, x: 0, y: 0 });
    expect(clampView({ z: 1, x: -900, y: 0 }, W, H, F)).toEqual({ z: 1, x: -300, y: 0 });
    expect(clampView({ z: 0.2, x: 0, y: 0 }, W, H, F).z).toBe(1); // never smaller than the frame
  });

  it('crops the square the frame shows, in picture pixels', () => {
    expect(cropRect({ z: 1, x: -150, y: 0 }, W, H, F)).toEqual([150, 0, 300]);
    expect(cropRect({ z: 2, x: -300, y: -150 }, W, H, F)).toEqual([150, 75, 150]);
  });

  it('zooms around the pointer: the picture point under it stays put', () => {
    const v = { z: 1, x: -150, y: 0 };
    const z = zoomAt(v, 2, 100, 100, W, H, F);
    const before = cropRect(v, W, H, F), after = cropRect(z, W, H, F);
    const under = (r: number[]) => [r[0] + (100 / F) * r[2], r[1] + (100 / F) * r[2]];
    expect(under(after)[0]).toBeCloseTo(under(before)[0]);
    expect(under(after)[1]).toBeCloseTo(under(before)[1]);
    expect(z.z).toBe(2);
  });
});
