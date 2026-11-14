/* The app pet: a small cat in the bottom-left corner that shows what Apollo is doing (petStatus.ts works out the mood
   from the jobs list, paused models, chat replies and the study timer). Off unless turned on (Appearance.pet: the cat
   button beside the study timer, or Settings → Appearance).

   The sprite sheet (assets/spritesheets/cat.webp, see ATTRIBUTION.md) is 8 columns × 11 rows of 192×208 cells; each
   row is one animation (ANIMS). Frames are stepped by requestAnimationFrame at a calm rate, only while the window is
   focused and visible; with animations off it shows a still frame. A word bubble appears when the mood changes (and on
   hover), then fades. Drag it anywhere (`useFloating('pet')`); click opens the activity list; right-click to hide it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import sheet from '../../assets/spritesheets/cat.webp';
import { api } from '../api';
import { onReplyFinished, useChatStreams } from '../chatStreams';
import { usePoll } from '../hooks';
import { jobTransitions, petMood, PetEvent, PetState, ERROR_MS, TIMER_MS, DONE_MS } from '../petStatus';
import { reducedMotion, useAppearance } from '../theme';
import { onTimerFinished } from '../timer';
import { useFloating } from './floating';
import Icon from './Icon';
import { openJobsList } from './JobsPanel';
import { useOverlay } from './overlay';

/** One cell of the sheet, and how big it is drawn (5/16: 60×65 px, so every frame sits on whole pixels). */
const CELL = { w: 192, h: 208 };
const COLS = 8, ROWS = 11;
const SCALE = 5 / 16;
const W = CELL.w * SCALE, H = CELL.h * SCALE;

interface Anim { row: number; frames: number; fps: number; pingpong?: boolean }
/** The sheet's rows (frame counts measured from the image). */
const ANIMS = {
  idle: { row: 0, frames: 7, fps: 4 },           // sitting at the desk
  walkRight: { row: 1, frames: 8, fps: 8 },
  walkLeft: { row: 2, frames: 8, fps: 8 },
  wave: { row: 3, frames: 4, fps: 5 },
  spin: { row: 4, frames: 5, fps: 6, pingpong: true }, // leans back and spins in the chair
  doze: { row: 5, frames: 8, fps: 3 },           // asleep under a blanket
  laptop: { row: 6, frames: 6, fps: 5 },         // calm work at a laptop
  busy: { row: 7, frames: 6, fps: 8 },           // typing hard at a big screen
  stressed: { row: 8, frames: 6, fps: 6 },       // head in paws
  turnAway: { row: 9, frames: 8, fps: 6 },       // turns round to face away…
  turnBack: { row: 10, frames: 8, fps: 6 },      // …and back again
} satisfies Record<string, Anim>;

interface Step { a: Anim; times: number; dx?: number }
const BASE: Record<PetState, Step[]> = {
  idle: [{ a: ANIMS.idle, times: 1 }],
  error: [{ a: ANIMS.stressed, times: 1 }],
  offline: [{ a: ANIMS.stressed, times: 1 }],
  paused: [{ a: ANIMS.doze, times: 1 }],
  timer: [{ a: ANIMS.wave, times: 1 }],
  replying: [{ a: ANIMS.busy, times: 1 }],
  writing: [{ a: ANIMS.busy, times: 1 }],
  thinking: [{ a: ANIMS.laptop, times: 1 }],
  reading: [{ a: ANIMS.laptop, times: 1 }],
  checking: [{ a: ANIMS.laptop, times: 1 }],
  waiting: [{ a: ANIMS.turnAway, times: 1 }, { a: ANIMS.turnBack, times: 1 }, { a: ANIMS.idle, times: 2 }],
  celebrate: [{ a: ANIMS.spin, times: 1 }, { a: ANIMS.idle, times: 3 }],
};
/** Now and then while idle: turn round, wave, or a few steps and back (never more than WALK px from its spot). */
const WALK = 24;
const walk = (first: 1 | -1): Step[] => {
  const n = ANIMS.walkRight.frames * 2, dx = WALK / n;
  const go = (d: 1 | -1): Step => ({ a: d > 0 ? ANIMS.walkRight : ANIMS.walkLeft, times: 2, dx: d * dx });
  return [go(first), go(first === 1 ? -1 : 1)];
};
const FIDGET_MS = [25_000, 60_000];

const span = (a: Anim) => (a.pingpong ? 2 * a.frames - 2 : a.frames);
const column = (a: Anim, f: number) => (a.pingpong && f >= a.frames ? 2 * a.frames - 2 - f : f);

interface Player { steps: Step[]; loop: boolean; i: number; f: number; rep: number; x: number; last: number }

/** The pet layer (mounted once in App): nothing at all while the pet is off. */
export default function PetLayer() {
  const [a] = useAppearance();
  return a.pet ? <Pet /> : null;
}

/** The cat button beside the study timer: shows or hides the pet. */
export function PetButton() {
  const [a, set] = useAppearance();
  const tip = a.pet ? 'Hide the cat' : 'Show the cat: it keeps you company and shows what Apollo is doing';
  return (
    <button className={`mini-icon mini-tool mini-pet${a.pet ? ' on' : ''}`} data-tip={tip} aria-label={a.pet ? 'Hide the cat' : 'Show the cat'}
      aria-pressed={a.pet} onClick={() => set({ pet: !a.pet })}>
      <Icon name="pet" size={19} strokeWidth={1.9} />
    </button>
  );
}

function Pet() {
  const [a, set] = useAppearance();
  const ov = useOverlay();
  const fl = useFloating<HTMLDivElement>('pet');
  const sprite = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  dragging.current = fl.dragging;

  // ---- the signals
  const jobs = usePoll(() => api.jobs(false), 1500, [], ['jobs']);
  const pause = usePoll(api.pauseState, 1500, [], ['pause']);
  const models = usePoll(api.modelStatus, 30000, [], ['pause']);
  const streams = useChatStreams();
  const [failed, setFailed] = useState<PetEvent | null>(null);
  const [finished, setFinished] = useState<PetEvent | null>(null);
  const [timerAt, setTimerAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const seen = useRef(new Map<number, string>());

  useEffect(() => {
    if (!jobs.data) return;
    const t = jobTransitions(seen.current, jobs.data, Date.now());
    if (t.failed) setFailed(t.failed);
    if (t.finished) setFinished(t.finished);
  }, [jobs.data]);
  // "Time's up! Take a break": after a focus phase (or a plain timer), not when a break ends
  useEffect(() => onTimerFinished((_length, phase) => { if (phase === 'focus') setTimerAt(Date.now()); }), []);
  useEffect(() => onReplyFinished((chatId) => {
    if (streams.error(chatId)) setFailed({ name: '', type: 'chat', at: Date.now() });
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const mood = petMood({
    now, jobs: jobs.data ?? [], paused: pause.data, models: models.data,
    replies: streams.allLive().map((r) => ({ status: r.status, text: r.text, reasoning: r.reasoning })),
    failed, finished, timerAt,
  });
  // the brief moods end by themselves: look again when the next one runs out
  useEffect(() => {
    const ends = [failed && failed.at + ERROR_MS, finished && finished.at + DONE_MS, timerAt && timerAt + TIMER_MS]
      .filter((t): t is number => !!t && t > Date.now());
    if (!ends.length) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.min(...ends) - Date.now() + 20);
    return () => window.clearTimeout(id);
  }, [failed, finished, timerAt]);

  // ---- the animation
  const still = a.motion === 'off' || reducedMotion();
  const player = useRef<Player>({ steps: [{ a: ANIMS.wave, times: 2 }], loop: false, i: 0, f: 0, rep: 0, x: 0, last: 0 });
  const base = useRef<PetState>(mood.state);

  const draw = () => {
    const el = sprite.current;
    if (!el) return;
    const p = player.current;
    const s = p.steps[p.i];
    el.style.backgroundPosition = `${-column(s.a, p.f) * W}px ${-s.a.row * H}px`;
    el.style.transform = p.x ? `translateX(${p.x}px)` : '';
  };
  const setSteps = (steps: Step[], loop: boolean) => {
    player.current = { steps, loop, i: 0, f: 0, rep: 0, x: 0, last: player.current.last };
    draw();
  };
  const advance = () => {
    const p = player.current;
    const s = p.steps[p.i];
    p.f++;
    p.x += s.dx ?? 0;
    if (p.f < span(s.a)) return;
    p.f = 0;
    if (++p.rep < s.times) return;
    p.rep = 0;
    if (++p.i < p.steps.length) return;
    if (p.loop) p.i = 0;
    else setSteps(BASE[base.current], true); // a one-off (greeting, fidget) ends: back to the mood
  };

  // a new mood: its animation (the greeting wave plays out first when the pet has just appeared and nothing's going on)
  useEffect(() => {
    const first = base.current === mood.state && !player.current.loop;
    base.current = mood.state;
    if (first && mood.state === 'idle' && !still) { draw(); return; }
    setSteps(BASE[mood.state], true);
  }, [mood.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // frames advance only while the window is focused and visible; animations off: a still frame
  useEffect(() => {
    if (still) {
      player.current = { ...player.current, steps: BASE[base.current], loop: true, i: 0, f: 0, rep: 0, x: 0 };
      draw();
      return;
    }
    let raf = 0;
    let on = false;
    const tick = (t: number) => {
      const p = player.current;
      if (t - p.last >= 1000 / p.steps[p.i].a.fps) { p.last = t; advance(); draw(); }
      raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      const want = document.hasFocus() && document.visibilityState === 'visible';
      if (want && !on) { on = true; raf = requestAnimationFrame(tick); }
      else if (!want && on) { on = false; cancelAnimationFrame(raf); }
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [still]); // eslint-disable-line react-hooks/exhaustive-deps

  // now and then, while idle: a small fidget
  useEffect(() => {
    if (still || mood.state !== 'idle') return;
    let id = 0;
    const later = () => { id = window.setTimeout(fidget, FIDGET_MS[0] + Math.random() * (FIDGET_MS[1] - FIDGET_MS[0])); };
    const fidget = () => {
      if (document.hasFocus() && base.current === 'idle' && player.current.loop && !dragging.current) {
        const r = Math.random();
        const box = sprite.current?.getBoundingClientRect();
        const roomRight = !box || box.right + WALK + 8 < window.innerWidth;
        setSteps(r < 0.45 ? [{ a: ANIMS.turnAway, times: 1 }, { a: ANIMS.turnBack, times: 1 }]
          : r < 0.8 ? walk(roomRight ? 1 : -1) : [{ a: ANIMS.wave, times: 2 }], false);
      }
      later();
    };
    later();
    return () => window.clearTimeout(id);
  }, [still, mood.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the word bubble: when the mood changes, and while hovered. Not for going back to idle, nor for a chat reply
  // (the student is watching the chat already)
  const [said, setSaid] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const lastSaid = useRef(mood.text);
  const firstMood = useRef(true);
  useEffect(() => {
    const first = firstMood.current;
    firstMood.current = false;
    if (mood.state === 'idle' || mood.state === 'replying' || mood.state === 'thinking') { setSaid(null); return; }
    if (first && mood.state === 'waiting') return;
    setSaid(mood.text);
    const id = window.setTimeout(() => setSaid(null), 4500);
    return () => window.clearTimeout(id);
  }, [mood.state, mood.text]);
  const text = hover ? mood.text : said;
  if (text) lastSaid.current = text;
  // the bubble opens away from the window's edges
  const side = useMemo(() => {
    const box = fl.ref.current?.getBoundingClientRect();
    if (!box) return { below: false, right: false };
    return { below: box.top < 70, right: box.left + 120 > window.innerWidth / 2 && box.left > window.innerWidth / 2 };
  }, [text, fl.offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pointer: drag (the grip), click (activity list), right-click (menu)
  const down = useRef<{ x: number; y: number } | null>(null);
  const menu = (e: React.MouseEvent) => ov.menu(e, [
    { label: 'Show the activity list', onClick: openJobsList },
    { label: 'Put the cat back in its corner', onClick: fl.reset, separatorBefore: true },
    { label: 'Hide the cat', onClick: () => set({ pet: false }) },
  ]);

  return (
    <div ref={fl.ref} className={`pet pet-${mood.state}${fl.dragging ? ' dragging' : ''}`}
      style={{ left: 82 + fl.offset.dx, bottom: 12 - fl.offset.dy, width: W, height: H }}>
      <div className={`pet-bubble${text ? ' show' : ''}${side.below ? ' below' : ''}${side.right ? ' right' : ''}`} aria-hidden>
        {lastSaid.current}
      </div>
      <button ref={sprite} className="pet-sprite" aria-label={`Cat: ${mood.text}. Click for the activity list`}
        style={{ width: W, height: H, backgroundImage: `url(${sheet})`, backgroundSize: `${COLS * W}px ${ROWS * H}px` }}
        {...fl.grip}
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; fl.grip.onPointerDown(e); }}
        onClick={(e) => {
          const d = down.current;
          down.current = null;
          if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // that was a drag
          openJobsList();
        }}
        onContextMenu={menu}
        onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)} onBlur={() => setHover(false)} />
    </div>
  );
}
