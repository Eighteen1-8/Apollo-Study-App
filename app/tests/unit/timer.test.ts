import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MIN = 60_000;
/** A fresh copy of the store (it reads the saved state when it loads). */
const load = async () => { vi.resetModules(); return import('../../src/timer'); };

describe('the study timer', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T10:00:00Z')); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sets the length in 5 or 1 minute steps before it starts', async () => {
    const t = await load();
    expect(t.timerState()).toMatchObject({ length: 25 * MIN, left: 25 * MIN, running: false, fresh: true });
    t.adjustTimer(5 * MIN);
    t.adjustTimer(-MIN);
    expect(t.timerState().length).toBe(29 * MIN);
    for (let i = 0; i < 10; i++) t.adjustTimer(-5 * MIN);
    expect(t.timerState().length).toBe(MIN); // never below a minute
  });

  it('counts down, pauses, and carries on after a reload', async () => {
    let t = await load();
    t.startTimer();
    vi.advanceTimersByTime(4 * MIN);
    expect(t.timerState().left).toBe(21 * MIN);
    t.pauseTimer();
    vi.advanceTimersByTime(10 * MIN);
    expect(t.timerState()).toMatchObject({ running: false, left: 21 * MIN, fresh: false });
    t.startTimer();
    vi.advanceTimersByTime(MIN);
    t = await load(); // the app reloads: the end time was saved
    expect(t.timerState().running).toBe(true);
    expect(t.timerState().left).toBe(20 * MIN);
    t.resetTimer();
    expect(t.timerState()).toMatchObject({ running: false, left: 25 * MIN, fresh: true });
  });

  it('tells listeners when the time is up, then resets', async () => {
    const t = await load();
    const done = vi.fn();
    const off = t.onTimerFinished(done);
    t.adjustTimer(-20 * MIN); // 5 minutes
    t.startTimer();
    vi.advanceTimersByTime(5 * MIN + 500);
    expect(done).toHaveBeenCalledWith(5 * MIN, 'focus');
    expect(t.timerState()).toMatchObject({ running: false, left: 5 * MIN, fresh: true });
    off();
  });

  it('runs focus and break rounds with a preset', async () => {
    const t = await load();
    const done = vi.fn();
    const off = t.onTimerFinished(done);
    t.setTimerPreset('p25');
    expect(t.timerState()).toMatchObject({ preset: 'p25', phase: 'focus', length: 25 * MIN, running: false });
    t.startTimer();
    vi.advanceTimersByTime(25 * MIN + 500);
    expect(done).toHaveBeenLastCalledWith(25 * MIN, 'focus');
    // the break starts by itself
    expect(t.timerState()).toMatchObject({ phase: 'break', length: 5 * MIN, running: true });
    vi.advanceTimersByTime(5 * MIN + 500);
    expect(done).toHaveBeenLastCalledWith(5 * MIN, 'break');
    // then focus again, waiting for Start
    expect(t.timerState()).toMatchObject({ phase: 'focus', length: 25 * MIN, running: false, fresh: true });
    expect(t.studyToday()).toEqual({ sessions: 1, minutes: 25 });
    off();
  });

  it('skips a break, resets to focus, and keeps the custom length', async () => {
    const t = await load();
    t.adjustTimer(5 * MIN); // custom: 30 minutes
    t.setTimerPreset('p50');
    t.startTimer();
    vi.advanceTimersByTime(50 * MIN + 500);
    expect(t.timerState()).toMatchObject({ phase: 'break', length: 10 * MIN, running: true });
    t.skipBreak();
    expect(t.timerState()).toMatchObject({ phase: 'focus', length: 50 * MIN, running: true });
    t.pauseTimer();
    t.resetTimer();
    expect(t.timerState()).toMatchObject({ phase: 'focus', length: 50 * MIN, fresh: true });
    t.setTimerPreset('custom');
    expect(t.timerState()).toMatchObject({ preset: 'custom', length: 30 * MIN });
    const again = await load(); // saved
    expect(again.timerState()).toMatchObject({ preset: 'custom', length: 30 * MIN });
  });

  it('counts today’s focus sessions until local midnight', async () => {
    vi.setSystemTime(new Date(2026, 10, 14, 23, 0, 0)); // local time
    const t = await load();
    expect(t.studyToday()).toEqual({ sessions: 0, minutes: 0 });
    expect(t.formatToday(t.studyToday())).toBe('');
    t.adjustTimer(-15 * MIN); // a 10-minute custom timer counts too
    t.startTimer();
    vi.advanceTimersByTime(10 * MIN + 500);
    t.startTimer();
    vi.advanceTimersByTime(10 * MIN + 500);
    expect(t.studyToday()).toEqual({ sessions: 2, minutes: 20 });
    expect(t.formatToday(t.studyToday())).toBe('2 focus sessions · 20 min today');
    expect(t.formatToday(t.studyToday(), true)).toBe('2 · 20 min');
    expect(t.formatToday({ sessions: 3, minutes: 75 })).toBe('3 focus sessions · 1 h 15 min today');
    vi.setSystemTime(new Date(2026, 10, 15, 0, 0, 5)); // after midnight
    expect(t.studyToday()).toEqual({ sessions: 0, minutes: 0 });
    expect((await load()).studyToday()).toEqual({ sessions: 0, minutes: 0 });
  });

  it('formats the time', async () => {
    const t = await load();
    expect(t.formatClock(25 * MIN)).toBe('25:00');
    expect(t.formatClock(65_500)).toBe('1:06');
    expect(t.formatClock(3_725_000)).toBe('1:02:05');
    expect(t.formatShort(3_725_000)).toBe('1h02');
  });
});
