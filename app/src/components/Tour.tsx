/* A short tour of the subject page: four tips, each lighting up the area it's about. It starts after the setup steps
   (the `tourPending` pref) the first time a subject is open, and the help window replays it. */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getPref, setPref } from '../prefs';
import Icon from './Icon';

const STEPS: { at: string; title: string; body: string }[] = [
  { at: '.side-right', title: 'Your files', body: 'Add your slides, notes and textbooks here, grouped into topics. Click any file to open it. Your own notes sit at the bottom.' },
  { at: '.start-studying .start-btn, .getting-started .gs-card, .center', title: 'Start studying', body: 'Ask Apollo about your material, pick up where you left off, keep a to-do list, and make flashcards, quizzes, notes and more.' },
  { at: '.side-left', title: 'What Apollo makes', body: 'Your chats, anything being made, and everything finished, grouped by kind. Click one to study it.' },
  { at: '.mini-help', title: 'Help is always here', body: 'The ? lists every shortcut and can show this tour again. The dot above it turns red if Apollo can’t reach its models.' },
];

let replay = 0;
const listeners = new Set<() => void>();
/** Show the tour again (help window). */
export function startTour() { replay++; listeners.forEach((f) => f()); }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export default function Tour({ ready }: { ready: boolean }) {
  const asked = useSyncExternalStore(subscribe, () => replay);
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);

  // pending after setup: start once the subject page is on screen
  useEffect(() => {
    if (!ready || step !== null || getPref<string>('tourPending', '') !== '1') return;
    const t = setTimeout(() => { setPref('tourPending', ''); setStep(0); }, 900);
    return () => clearTimeout(t);
  }, [ready, step]);
  useEffect(() => { if (asked) setStep(0); }, [asked]);

  useLayoutEffect(() => {
    if (step === null) return;
    const place = () => {
      const el = STEPS[step].at.split(', ').map((s) => document.querySelector(s)).find(Boolean);
      setBox(el ? el.getBoundingClientRect() : null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [step]);
  useEffect(() => {
    if (step === null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStep(null);
      if (e.key === 'ArrowRight' || e.key === 'Enter') setStep((s) => (s === null || s + 1 >= STEPS.length ? null : s + 1));
      if (e.key === 'ArrowLeft') setStep((s) => (s ? s - 1 : s));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [step]);
  if (step === null) return null;

  const s = STEPS[step];
  const pad = 8;
  const hole = box ? { left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 } : null;
  // the tip goes beside the area, on whichever side has room
  const W = 340;
  let tip: React.CSSProperties = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  if (hole) {
    const right = hole.left + hole.width + 16, left = hole.left - W - 16;
    const top = Math.min(Math.max(16, hole.top + 20), window.innerHeight - 240);
    if (right + W < window.innerWidth) tip = { left: right, top };
    else if (left > 0) tip = { left, top };
    else tip = { left: Math.max(16, hole.left + hole.width / 2 - W / 2), top: Math.min(hole.top + hole.height + 16, window.innerHeight - 220) };
  }
  const last = step === STEPS.length - 1;
  return createPortal(
    <div className="tour" role="dialog" aria-label={`Tour, step ${step + 1} of ${STEPS.length}: ${s.title}`}>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-tip" style={{ ...tip, width: W }} key={step}>
        <div className="tour-count">{step + 1} of {STEPS.length}</div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-foot">
          <button className="link-btn" onClick={() => setStep(null)}>Skip tour</button>
          <span className="spacer" />
          {step > 0 && <button className="btn btn-sm" onClick={() => setStep(step - 1)}><Icon name="back" size={14} /> Back</button>}
          <button className="btn btn-sm btn-primary" autoFocus onClick={() => setStep(last ? null : step + 1)}>
            {last ? 'Finish' : 'Next'} {!last && <Icon name="next" size={14} />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
