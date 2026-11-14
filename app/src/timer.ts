/* The study timer (the clock in the left bar, components/StudyTimer.tsx). An external store, so anything can read it
   (useTimer) or hear it finish (onTimerFinished: the toast and taskbar flash, and the pet).

   Presets: a plain timer of any length ('custom'), or focus-and-break rounds (25 / 5 or 50 / 10). With a preset, a
   finished focus phase switches to its break and starts it at once; a finished break switches back to focus and
   waits for Start (so time away from the desk isn't counted). Every finished focus phase (and every finished custom
   timer) counts as a focus session for today (`useStudyToday`: sessions and minutes, reset at local midnight).

   Saved per machine (pref `studyTimer`; today's count in pref `studyToday`): while it runs only its end time is
   stored, so a reload or a restart of the app carries on counting; if it ended while the app was closed, it finishes
   as soon as it's next looked at. */
import { useSyncExternalStore } from 'react';
import { getPref, setPref } from './prefs';

const MIN = 60_000;
export const TIMER_MIN = MIN;
export const TIMER_MAX = 180 * MIN;
const DEFAULT = 25 * MIN;

export type TimerPreset = 'custom' | 'p25' | 'p50';
export type TimerPhase = 'focus' | 'break';
/** The focus-and-break presets (minutes). */
export const PRESETS: Record<Exclude<TimerPreset, 'custom'>, { focus: number; rest: number; label: string }> = {
  p25: { focus: 25, rest: 5, label: '25 / 5' },
  p50: { focus: 50, rest: 10, label: '50 / 10' },
};

interface Saved {
  /** The length it was set to (what Reset goes back to). */
  length: number;
  /** When it will finish, while running. */
  endsAt: number | null;
  /** Time left while paused or not started. */
  left: number;
  preset: TimerPreset;
  phase: TimerPhase;
  /** The custom timer's length, kept while a preset is used. */
  custom: number;
}

export interface TimerState {
  length: number;
  running: boolean;
  /** Milliseconds left (counting down while running). */
  left: number;
  /** Set and not started, or reset: nothing has been counted yet. */
  fresh: boolean;
  preset: TimerPreset;
  /** Always 'focus' for a custom timer. */
  phase: TimerPhase;
}

const okMs = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

let saved: Saved = getPref<Saved>('studyTimer', { length: DEFAULT, endsAt: null, left: DEFAULT, preset: 'custom', phase: 'focus', custom: DEFAULT }, (v) => {
  const p = JSON.parse(v);
  const length = okMs(p?.length, MIN, TIMER_MAX) ? p.length : DEFAULT;
  const preset: TimerPreset = p?.preset === 'p25' || p?.preset === 'p50' ? p.preset : 'custom';
  return {
    length,
    endsAt: typeof p?.endsAt === 'number' && Number.isFinite(p.endsAt) ? p.endsAt : null,
    left: okMs(p?.left, 0, TIMER_MAX) ? p.left : length,
    preset,
    phase: preset !== 'custom' && p?.phase === 'break' ? 'break' : 'focus',
    custom: okMs(p?.custom, MIN, TIMER_MAX) ? p.custom : preset === 'custom' ? length : DEFAULT,
  };
});

const listeners = new Set<() => void>();
const finishListeners = new Set<(length: number, phase: TimerPhase) => void>();
let snap: TimerState = view();
let ticker = 0;

function view(): TimerState {
  const running = saved.endsAt !== null;
  const left = running ? Math.max(0, saved.endsAt! - Date.now()) : saved.left;
  return { length: saved.length, running, left, fresh: !running && saved.left === saved.length, preset: saved.preset, phase: saved.phase };
}

function commit(next: Saved) {
  saved = next;
  if (saved.preset === 'custom') saved.custom = saved.length;
  setPref('studyTimer', JSON.stringify(saved));
  refresh(true);
  schedule();
}

/** Recompute what's shown; listeners hear about it when the shown second (or anything else) changed. */
function refresh(force = false) {
  const n = view();
  if (!force && n.running === snap.running && Math.ceil(n.left / 1000) === Math.ceil(snap.left / 1000) && n.length === snap.length) return;
  snap = n;
  listeners.forEach((f) => f());
}

function tick() {
  if (saved.endsAt !== null && Date.now() >= saved.endsAt) { finish(); return; }
  refresh();
}

function schedule() {
  if (saved.endsAt !== null && !ticker && typeof window !== 'undefined') ticker = window.setInterval(tick, 250);
  if (saved.endsAt === null && ticker) { window.clearInterval(ticker); ticker = 0; }
}

/** The phase's set length for a preset. */
const phaseLength = (preset: Exclude<TimerPreset, 'custom'>, phase: TimerPhase) => (phase === 'focus' ? PRESETS[preset].focus : PRESETS[preset].rest) * MIN;

function finish() {
  const { length, phase, preset, endsAt } = saved;
  if (phase === 'focus') addFocusSession(length, endsAt ?? Date.now());
  if (preset === 'custom') {
    commit({ ...saved, endsAt: null, left: length });
  } else if (phase === 'focus') {
    // straight into the break, counted from when the focus phase ended (it may have ended while the app was closed)
    const rest = phaseLength(preset, 'break');
    const restEnds = (endsAt ?? Date.now()) + rest;
    if (restEnds > Date.now()) commit({ ...saved, phase: 'break', length: rest, endsAt: restEnds, left: rest });
    else { const focus = phaseLength(preset, 'focus'); commit({ ...saved, phase: 'focus', length: focus, endsAt: null, left: focus }); } // the break is over too
  } else {
    const focus = phaseLength(preset, 'focus');
    commit({ ...saved, phase: 'focus', length: focus, endsAt: null, left: focus });
  }
  finishListeners.forEach((f) => { try { f(length, phase); } catch { /* a listener's problem isn't the timer's */ } });
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  schedule();
  // ended while the app was closed (or the page was asleep): finish now that someone is looking
  if (saved.endsAt !== null && Date.now() >= saved.endsAt) queueMicrotask(tick);
  return () => { listeners.delete(f); };
};

/** The timer as it is now; re-renders every second while it runs. */
export function useTimer(): TimerState {
  return useSyncExternalStore(subscribe, () => snap);
}
export function timerState(): TimerState { return view(); }

/** Called with the length (ms) and the phase that ended each time the timer reaches zero (a custom timer's phase is
 * 'focus'). Returns the unsubscribe function. */
export function onTimerFinished(f: (length: number, phase: TimerPhase) => void): () => void {
  finishListeners.add(f);
  schedule();
  return () => { finishListeners.delete(f); };
}

export function startTimer() {
  if (saved.endsAt !== null) return;
  const left = saved.left > 0 ? saved.left : saved.length;
  commit({ ...saved, endsAt: Date.now() + left });
}
export function pauseTimer() {
  if (saved.endsAt === null) return;
  commit({ ...saved, endsAt: null, left: Math.max(0, saved.endsAt - Date.now()) });
}
export function toggleTimer() { if (saved.endsAt === null) startTimer(); else pauseTimer(); }
/** Back to the start: a preset goes back to its focus phase. */
export function resetTimer() {
  if (saved.preset === 'custom') { commit({ ...saved, endsAt: null, left: saved.length }); return; }
  const length = saved.phase === 'focus' ? saved.length : phaseLength(saved.preset, 'focus');
  commit({ ...saved, phase: 'focus', length, endsAt: null, left: length });
}

/** During a break: straight on to the next focus phase, started. */
export function skipBreak() {
  if (saved.preset === 'custom' || saved.phase !== 'break') return;
  const length = phaseLength(saved.preset, 'focus');
  commit({ ...saved, phase: 'focus', length, endsAt: Date.now() + length, left: length });
}

/** Pick a preset (or the custom timer): it starts again from its focus phase, stopped. */
export function setTimerPreset(preset: TimerPreset) {
  const length = preset === 'custom' ? saved.custom : phaseLength(preset, 'focus');
  commit({ ...saved, preset, phase: 'focus', length, endsAt: null, left: length });
}

/** − / + : before it starts this changes the length; once counting, the time left (never below a minute, unless it
 * was already under one). */
export function adjustTimer(ms: number) {
  const { left, fresh } = view();
  let next = Math.min(TIMER_MAX, left + ms);
  if (next < MIN) next = Math.min(left, MIN);
  if (fresh) {
    const length = Math.max(MIN, Math.round(next / MIN) * MIN);
    commit({ ...saved, length, endsAt: null, left: length });
  } else if (saved.endsAt !== null) {
    commit({ ...saved, endsAt: Date.now() + next });
  } else {
    commit({ ...saved, left: next });
  }
}

// ---- today's focus sessions

export interface StudyToday { sessions: number; minutes: number }
interface SavedToday extends StudyToday { day: string }

/** The local date, "2026-11-14". */
export function localDay(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const todayListeners = new Set<() => void>();
const ZERO: StudyToday = { sessions: 0, minutes: 0 };
let todaySnap: { key: string; value: StudyToday } = { key: '', value: ZERO };

function readToday(): SavedToday {
  return getPref<SavedToday>('studyToday', { day: '', ...ZERO }, (v) => {
    const p = JSON.parse(v);
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    return { day: typeof p?.day === 'string' ? p.day : '', sessions: n(p?.sessions), minutes: n(p?.minutes) };
  });
}

/** Focus sessions finished today and the minutes they took (zero after local midnight). */
export function studyToday(): StudyToday {
  const t = readToday();
  const value = t.day === localDay() ? { sessions: t.sessions, minutes: t.minutes } : ZERO;
  const key = `${localDay()}|${value.sessions}|${value.minutes}`;
  if (key !== todaySnap.key) todaySnap = { key, value };
  return todaySnap.value;
}

/** A focus phase of `length` ms finished at `at` (counted on the day it finished). */
function addFocusSession(length: number, at: number) {
  const day = localDay(at);
  if (day !== localDay()) return; // finished on an earlier day while the app was closed
  const t = readToday();
  const base = t.day === day ? t : { day, ...ZERO };
  setPref('studyToday', JSON.stringify({ day, sessions: base.sessions + 1, minutes: base.minutes + Math.round(length / MIN) }));
  todayListeners.forEach((f) => f());
}

const subscribeToday = (f: () => void) => {
  todayListeners.add(f);
  // at local midnight the count goes back to zero
  let timer = 0;
  const arm = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1).getTime();
    timer = window.setTimeout(() => { f(); arm(); }, Math.min(next - now.getTime(), 2 ** 31 - 1));
  };
  if (typeof window !== 'undefined') arm();
  return () => { todayListeners.delete(f); window.clearTimeout(timer); };
};

/** Today's focus sessions; re-renders when one finishes and at midnight. */
export function useStudyToday(): StudyToday {
  return useSyncExternalStore(subscribeToday, studyToday);
}

/** "2 focus sessions · 50 min today" ('' when there are none). */
export function formatToday(t: StudyToday, short = false): string {
  if (!t.sessions) return '';
  const mins = t.minutes >= 60 ? `${Math.floor(t.minutes / 60)} h ${t.minutes % 60 ? `${t.minutes % 60} min` : ''}`.trim() : `${t.minutes} min`;
  if (short) return `${t.sessions} · ${mins}`;
  return `${t.sessions} focus session${t.sessions === 1 ? '' : 's'} · ${mins} today`;
}

/** "25:00", "4:05", or "1:05:00" from milliseconds (rounded up, so it shows 0:00 only at the end). */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** The narrow form for the left bar's button: "24:59", or "1h05" for an hour or more. */
export function formatShort(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return formatClock(ms);
}
