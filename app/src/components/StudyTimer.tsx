/* The study timer's button in the left bar. It shows a clock, or the time left while it runs. A click grows it into a
   pill beside the bar, `− 25:00 +` with start/pause and reset (− / + change 5 minutes, 1 with Shift); a click anywhere
   else or Escape shrinks it back. When the time is up: a notice and, if the window is behind others, a flashing
   taskbar button. The pill also picks the kind of timer (25 / 5 or 50 / 10 focus-and-break rounds, or Custom: see
   timer.ts) and shows today's focus sessions. The pill is portalled to the body (the bar's backdrop-filter would clip it, as in JobsPanel). */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { toast } from './toast';
import { motionMs } from '../theme';
import {
  adjustTimer, formatClock, formatShort, formatToday, onTimerFinished, PRESETS, resetTimer, setTimerPreset, skipBreak, startTimer, timerState,
  TimerPreset, toggleTimer, useStudyToday, useTimer,
} from '../timer';

const MIN = 60_000;

/** The notice and taskbar flash when the time is up (mounted once, with the button). */
function useFinishNotice() {
  useEffect(() => onTimerFinished((length, phase) => {
    const mins = Math.round(length / MIN);
    const now = timerState(); // already switched to the next phase
    if (now.preset === 'custom') toast(`Time’s up: your ${mins}-minute study timer has finished.`, { label: 'Start again', run: startTimer }, 12000);
    else if (phase === 'focus' && now.phase === 'break') {
      toast(`Focus done: ${mins} minutes. Your ${Math.round(now.length / MIN)}-minute break has started.`, { label: 'Skip the break', run: skipBreak }, 12000);
    } else toast(`Break’s over: ready for the next ${Math.round(now.length / MIN)} minutes?`, { label: 'Start focusing', run: startTimer }, 12000);
    window.studyApp?.flash?.();
  }), []);
}

export default function StudyTimer() {
  const t = useTimer();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useFinishNotice();

  const close = () => {
    if (!open || closing) return;
    const ms = motionMs(160);
    if (!ms) { setOpen(false); return; }
    setClosing(true);
    window.setTimeout(() => { setOpen(false); setClosing(false); }, ms);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setAt({ left: r.left, top: r.top + r.height / 2 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!btn.current?.contains(e.target as Node) && !pill.current?.contains(e.target as Node)) closeRef.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); btn.current?.focus(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open]);
  // opened from the keyboard: the focus goes to the start button
  useEffect(() => { if (open) pill.current?.querySelector<HTMLButtonElement>('.timer-go')?.focus({ preventScroll: true }); }, [open]);

  const clock = formatClock(t.left);
  const step = (sign: 1 | -1) => (e: React.MouseEvent) => adjustTimer(sign * (e.shiftKey ? 1 : 5) * MIN);
  const what = t.preset === 'custom' ? 'Study timer' : t.phase === 'break' ? 'Break' : 'Focus';
  const tip = t.running ? `${what}: ${clock} left` : t.fresh ? `${what} (${clock})` : `${what}: paused at ${clock}`;
  const today = useStudyToday();
  const todayText = formatToday(today);
  const presets: [TimerPreset, string, string][] = [
    ...Object.entries(PRESETS).map(([id, p]): [TimerPreset, string, string] => [id as TimerPreset, p.label, `${p.focus} minutes of focus, then a ${p.rest}-minute break`]),
    ['custom', 'Custom', 'One timer of the length you set'],
  ];

  return (
    <>
      <button ref={btn} className={`mini-icon mini-tool mini-timer${t.running ? ' running' : ''}${!t.running && !t.fresh ? ' paused' : ''}${open ? ' open' : ''}${t.phase === 'break' ? ' break' : ''}`}
        data-tip={open ? undefined : tip} aria-label={tip} aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        {t.running || !t.fresh ? <span className="timer-short">{formatShort(t.left)}</span> : <Icon name="timer" size={19} strokeWidth={1.9} />}
      </button>
      {open && createPortal(
        <div ref={pill} className={`timer-pill${closing ? ' closing' : ''}${t.running ? ' running' : ''}${t.phase === 'break' ? ' break' : ''}`} role="group" aria-label="Study timer"
          style={at ? { left: at.left, top: at.top } : { visibility: 'hidden' }}>
          <button className="timer-step" data-tip="5 minutes less (Shift: 1 minute)" aria-label="Less time" onClick={step(-1)}
            disabled={t.left <= MIN && !t.fresh}><Icon name="minus" size={16} /></button>
          <span className="timer-clock" aria-live="off">{clock}</span>
          <button className="timer-step" data-tip="5 minutes more (Shift: 1 minute)" aria-label="More time" onClick={step(1)}><Icon name="add" size={16} /></button>
          <span className="timer-sep" aria-hidden />
          <button className="timer-go" data-tip={t.running ? 'Pause' : t.fresh ? 'Start' : 'Carry on'} aria-label={t.running ? 'Pause' : 'Start'}
            onClick={toggleTimer}><Icon name={t.running ? 'pause' : 'play'} size={16} /></button>
          <button className="timer-reset" data-tip="Reset" aria-label="Reset" disabled={t.fresh && t.phase === 'focus'} onClick={resetTimer}><Icon name="reset" size={15} /></button>
          <span className="timer-sep" aria-hidden />
          <div className="timer-presets" role="group" aria-label="Timer kind">
            {presets.map(([id, label, hint]) => (
              <button key={id} className={`timer-preset${t.preset === id ? ' on' : ''}`} aria-pressed={t.preset === id}
                data-tip={t.running && t.preset !== id ? `${hint} (pause or reset first)` : hint}
                disabled={t.running && t.preset !== id} onClick={() => t.preset !== id && setTimerPreset(id)}>{label}</button>
            ))}
          </div>
          {t.preset !== 'custom' && <span className={`timer-phase ${t.phase}`}>{t.phase === 'break' ? 'Break' : 'Focus'}</span>}
          {todayText && <span className="timer-today" data-tip={todayText} aria-label={todayText}>{formatToday(today, true)}</span>}
        </div>,
        document.body,
      )}
    </>
  );
}
