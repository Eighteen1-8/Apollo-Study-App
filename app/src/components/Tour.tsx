/* Short tours: a few tips, each lighting up the part of the screen it's about.
   - `app`: the subject page. It starts after the setup steps (the `tourPending` pref) the first time a subject is open.
   - one per feature (notes, mind maps, drawings, the file viewer, the chat, each kind of study material including
     marking, the calculator): `useFirstTime(id)`
     in the feature's component starts it once, the first time that feature opens (pref `tourSeen.<id>`), and its
     `<TourButton id>` (a ?) replays it. The help window lists every tour (`TourList`).
   A tour never starts by itself while the setup steps, a dialog or another tour is showing, or under automation
   (navigator.webdriver: the end-to-end tests), and steps whose part of the screen isn't there are skipped. Opened
   from the help window while the feature isn't on screen, it shows all its tips in the middle instead.

   Adding a tour: add an entry to TOURS (its id becomes a TourId), then put `useFirstTime('<id>', ready)` and
   `<TourButton id="<id>" />` in the feature. `at` is a CSS selector list; the first match is lit up. */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getPref, setPref } from '../prefs';
import Icon from './Icon';

export interface TourStep {
  /** What to light up (CSS selectors, first match wins). No `at`: the tip shows in the middle. */
  at?: string;
  title: string;
  body: string;
}
interface TourDef {
  /** The name in the help window's list. */
  title: string;
  /** Where to go to see it on screen ("a note"), said when it's replayed from elsewhere. */
  where: string;
  steps: TourStep[];
}

const TOURS_DEF = {
  app: {
    title: 'The subject page', where: 'a subject',
    steps: [
      { at: '.side-right', title: 'Your files', body: 'Add your slides, notes and textbooks here, grouped into topics. Click any file to open it. Your own notes, mind maps and drawings sit at the bottom.' },
      { at: '.start-studying .start-btn, .getting-started .gs-card, .center', title: 'Start studying', body: 'Ask Apollo about your material, pick up where you left off, keep a to-do list, make flashcards, quizzes, practice exams, notes, cheat sheets and mind maps, or have Apollo mark your own work.' },
      { at: '.side-left', title: 'What Apollo makes', body: 'Your chats, anything being made, and everything finished, grouped by kind. Click one to study it.' },
      { at: '.mini-tools', title: 'Study timer', body: 'Set a timer for a focused study session. Click it, choose the minutes with − and +, then start. Apollo tells you when the time is up.' },
      { at: '.mini-help', title: 'Help is always here', body: 'The ? lists every shortcut and can show any of these tours again. The dot above it turns red if Apollo can’t reach its models.' },
    ],
  },
  notes: {
    title: 'Your notes', where: 'one of your notes',
    steps: [
      { at: '.note-editor .ne-page', title: 'Write your notes', body: 'Type here like any document. It saves as you go. These notes are yours: Apollo never adds them to the material it answers from.' },
      { at: '.note-editor .ne-toolbar', title: 'Format', body: 'Headings, fonts, colours, highlights, lists and tables. Ctrl+B, I and U work too, and Tab moves between table cells.' },
      { at: '.note-editor .ne-page', title: 'Right-click for more', body: 'Select some text and right-click to ask Apollo about it, have just that part checked or rewritten, or highlight it. Right-drag across the page to send a screenshot of an area to the chat.' },
      { at: '.note-editor .source-head [data-tip^="Have Apollo check"]', title: 'Check with Apollo', body: 'Apollo compares your note with your files and points out anything wrong or missing. Its comments appear beside the page, and you can apply a fix with one click.' },
      { at: '.note-editor .tool-calc', title: 'Calculator', body: 'A calculator and graphing tool you can move anywhere. It can put a result or a graph straight into this note.' },
      { at: '.note-editor .source-head', title: 'Comments and export', body: 'Comments shows what Apollo said about this note. Export saves it as a Word document or a PDF.' },
    ],
  },
  viewer: {
    title: 'Reading a file', where: 'one of your files',
    steps: [
      { at: '.doc-pane .source-scroll, .source .source-scroll', title: 'Your file', body: 'Scroll through it, or type a page number at the top to jump. Select some text and right-click to have Apollo define or explain it. Ctrl+F finds words anywhere in the file.' },
      { at: '.source-tools .tools', title: 'Mark it up', body: 'Highlight, draw, write text or stick notes right on the page. Each tool has a key: V select, H highlight, P pen, E eraser, T text, N note.' },
      { at: '.source-tools [data-tip^="Snip"]', title: 'Snip', body: 'Drag a box over part of a page to send it to the chat as a picture, or to pin a note to it. Right-dragging does the same with any tool.' },
      { at: '.source-tools .rail-toggle', title: 'Your highlights and notes', body: 'Everything you’ve marked on this file is listed here. Click one to jump to it.' },
      { at: '.source-tools .tool-calc', title: 'Calculator', body: 'A calculator and graphing tool that floats over the page. It stays open when you switch files.' },
      { at: '.source-head .source-make', title: 'Study from this file', body: 'Make flashcards, a quiz, notes and more from just this file.' },
    ],
  },
  chat: {
    title: 'Chatting with Apollo', where: 'the chat',
    steps: [
      { at: '.chat .composer', title: 'Ask Apollo', body: 'Ask anything about your material. Apollo answers from your files and says where each point came from: click a source to open that page. Type / to see the commands.' },
      { at: '.chat .composer-bar', title: 'What Apollo uses', body: 'Choose which topic Apollo answers from, and how long it thinks first: longer is slower but better for hard questions. The paperclip sends a file with one message without adding it to your library.' },
      { at: '.chat .chat-scroll', title: 'Reply to part of an answer', body: 'Select part of one of Apollo’s answers to ask about just that part. You can also drag a file from the sidebar onto the chat.' },
      { at: '.chat .ctx-meter', title: 'Chat memory', body: 'This ring fills as the chat gets longer. When it’s nearly full, start a new chat so Apollo keeps up with what you’re asking.' },
      { at: '.chat .chat-title-btn', title: 'Your chats', body: 'Switch to an earlier chat here. The + next to it starts a new one, and every chat is also in the left sidebar.' },
      { at: '.chat .chat-head .head-tool', title: 'More room', body: 'Put the chat side by side with what’s open, or make it full screen.' },
    ],
  },
  flashcards: {
    title: 'Flashcards', where: 'a set of flashcards',
    steps: [
      { at: '.fullscreen .flashcard', title: 'Flip the card', body: 'Try to answer, then click the card or press Space to see the back.' },
      { at: '.fullscreen .fc-rate', title: 'Be honest', body: 'Got it (key 1) or Practise again (key 2). Apollo keeps the cards you find hard in mind when you chat with it.' },
      { at: '.fullscreen .viewer-nav', title: 'Through the deck', body: 'Next and Previous, or the arrow keys. At the end of a round you can go over just the cards you missed.' },
      { at: '.fullscreen .fc-bar', title: 'Your deck', body: 'Shuffle, study only the cards to practise, delete a card you don’t need, or see the whole deck as a list.' },
    ],
  },
  quiz: {
    title: 'Quizzes', where: 'a quiz',
    steps: [
      { at: '.fullscreen .options', title: 'Pick an answer', body: 'Click an option, or press its letter.' },
      { at: '.fullscreen .quiz-actions', title: 'Check, then move on', body: 'Check answer (or Enter) shows whether you were right, why, and where it comes from in your files. Enter again goes to the next question.' },
      { at: '.fullscreen .quiz-steps', title: 'How you’re going', body: 'One mark per question, green or red once it’s checked.' },
      { title: 'At the end', body: 'You get your score and can retry just the ones you missed. Apollo can also review your answers and add what to revise to your to-do list.' },
    ],
  },
  exam: {
    title: 'Practice exams', where: 'a practice exam',
    steps: [
      { at: '.fullscreen .exam-meta', title: 'Like the real thing', body: 'This exam follows your practice exam’s parts, marks and time. Tick Show answers to see model answers as you go.' },
      { at: '.fullscreen .exam-q', title: 'Answer the questions', body: 'Pick options or type your answers. They’re kept as you type, even if you close the exam.' },
      { at: '.fullscreen .exam-submit', title: 'Submit for marking', body: 'Apollo marks multiple choice exactly and written answers against the marking scheme, and tells you what was missing.' },
      { at: '.fullscreen .exam-meta select', title: 'Your attempts', body: 'Every submission is kept. Pick one to look back at its marks, or start a new attempt.' },
      { at: '.fullscreen .fs-top .btn-sm', title: 'Print it', body: 'Export saves the exam as Word or PDF, with or without the answers.' },
    ],
  },
  studynotes: {
    title: 'Full notes', where: 'a set of full notes',
    steps: [
      { at: '.artifact-page .notes-toc', title: 'Contents', body: 'Jump straight to any section.' },
      { at: '.artifact-page .artifact-scroll', title: 'Read, ask and highlight', body: 'Select text and right-click to ask Apollo about it, have it checked or rewritten, or highlight it. Source links open the exact page in your files.' },
      { at: '.artifact-page .source-head', title: 'Check, comment, export', body: 'Check with Apollo looks for mistakes against your files, and its comments sit beside the page. Regenerate writes the notes again; Export saves Word or PDF.' },
    ],
  },
  cheatsheet: {
    title: 'Cheat sheets', where: 'a cheat sheet',
    steps: [
      { at: '.artifact-page .artifact-scroll', title: 'Everything on one page', body: 'The key facts, formulas and definitions, short enough to revise from. Select text and right-click to ask Apollo about it or highlight it.' },
      { at: '.artifact-page .source-head', title: 'Check and export', body: 'Check with Apollo looks for mistakes against your files. Export saves it as Word or a PDF to print.' },
    ],
  },
  mindmap: {
    title: 'Mind maps', where: 'a mind map',
    steps: [
      { at: '.artifact-page .mindmap', title: 'Explore the map', body: 'Drag to move around and scroll to zoom. Click an idea to see its detail and where it comes from.' },
      { at: '.artifact-page .mm-fold', title: 'Fold branches', body: 'The dot at the end of an idea folds or unfolds its branch.' },
      { at: '.artifact-page .mm-tools', title: 'Find your way', body: 'Fit the map to the screen, zoom, show only the main branches, or unfold everything.' },
      { at: '.artifact-page .mm-detail', title: 'Ask about an idea', body: 'Ask Apollo about this sends the idea you clicked to the chat.' },
    ],
  },
  marking: {
    title: 'Marking your work', where: 'a marking',
    steps: [
      { at: '.marking .marking-score', title: 'Your mark', body: 'Your total, out of what the work is marked out of. The bar turns green, amber or red with how you did.' },
      { at: '.marking .marking-summary', title: 'The overall picture', body: 'What Apollo thought of the work as a whole: what you did well and what to work on next.' },
      { at: '.marking .marking-criteria', title: 'Question by question', body: 'Each question or criterion with its marks, the words of yours it is about, and corrections. Click one to show the pages it is about.' },
      { at: '.marking .marking-ask', title: 'Ask about the feedback', body: 'Not sure why you lost a mark? Ask Apollo about this sends that feedback to the chat.' },
      { at: '.marking .marking-pages', title: 'Your pages', body: 'Your work as Apollo read it. A page link in the feedback scrolls here.' },
      { at: '.artifact-page .source-head', title: 'Mark it again', body: 'Regenerate marks the same work again from scratch. Export saves the feedback as a Word document or a PDF.' },
    ],
  },
  map: {
    title: 'Your mind maps', where: 'one of your mind maps',
    steps: [
      { at: '.map-editor .map-canvas', title: 'Build the map', body: 'Double-click the canvas for a new box, and double-click a box or an arrow to write on it. Drag a box’s dot onto another box to link them, or onto empty space for a new linked box.' },
      { at: '.map-editor .map-canvas', title: 'Move around', body: 'Drag the background to move, scroll to zoom, and Shift-drag to select several boxes. With a box selected, Tab adds a linked box and Delete removes it.' },
      { at: '.map-editor .map-toolbar', title: 'Shapes and colours', body: 'Pick a shape and colour for new or selected boxes. Use a diamond for a decision in a flowchart. Tidy lays the map out neatly.' },
      { at: '.map-editor .map-check', title: 'Check with Apollo', body: 'Apollo reads your boxes and links and points out any that don’t match your files. Click an issue in Comments to see the box it means.' },
      { at: '.map-editor .map-export', title: 'Save a copy', body: 'Export the map as a picture, a Word document or a PDF. The map itself saves as you go.' },
    ],
  },
  drawing: {
    title: 'Your drawings', where: 'one of your drawings',
    steps: [
      { at: '.drawing-editor .dr-canvas', title: 'Draw', body: 'Draw with a mouse or a pen (it feels how hard you press). The mouse wheel zooms; hold Space and drag to move the page.' },
      { at: '.drawing-editor .dr-toolbar', title: 'Tools', body: 'Pen, highlighter, eraser, lines, arrows, shapes and text. Each has a key: P pen, E eraser, T text, V select (then drag to move or resize).' },
      { at: '.drawing-editor .dr-colours', title: 'Colour and thickness', body: 'Pick a colour and a line thickness. With something selected, they change it too.' },
      { at: '.drawing-editor .dr-paper', title: 'Paper', body: 'Plain, grid or lined paper.' },
      { at: '.drawing-editor .dr-desc', title: 'Say what it shows', body: 'One line, like “forces on a block on a slope”, helps Apollo understand your drawing when it checks it.' },
      { at: '.drawing-editor .dr-check', title: 'Check with Apollo', body: 'Apollo looks at a picture of your drawing and compares it with your files. Its comments appear beside the page.' },
    ],
  },
  calculator: {
    title: 'The calculator', where: 'the calculator',
    steps: [
      { at: '.calc .calc-input', title: 'Type or tap', body: 'Type a calculation like 2sin(30) + 5! or use the keys. Enter works it out; ans is the last answer, and ↑ brings back the last calculation.' },
      { at: '.calc .calc-angle', title: 'Degrees or radians', body: 'Choose how sin, cos and tan read angles.' },
      { at: '.calc .calc-history', title: 'History', body: 'Your answers stay here. Click one to use it again.' },
      { at: '.calc .calc-modes', title: 'Graphs', body: 'Graphing draws several functions at once. Drag to move, scroll to zoom, hover to read values, and show a table of values.' },
      { at: '.calc .calc-grip', title: 'Move it anywhere', body: 'Drag the top bar. It stays open while you switch files and notes; only the × closes it. With a note open, Insert puts a result or a graph into it.' },
    ],
  },
} satisfies Record<string, TourDef>;

export type TourId = keyof typeof TOURS_DEF;
export const TOURS: Record<TourId, TourDef> = TOURS_DEF;

const seenKey = (id: string) => `tourSeen.${id}`;
const seen = (id: string) => getPref<string>(seenKey(id), '') === '1';

const anchor = (sel?: string) => (sel ? sel.split(/,\s*/).map((s) => document.querySelector(s)).find(Boolean) ?? null : null);

interface Running { id: TourId; steps: TourStep[]; step: number; away: boolean }
let running: Running | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const set = (r: Running | null) => { running = r; emit(); };

/** Whether a tour is showing now. */
export function tourRunning() { return running !== null; }

/** Show a tour (the ? buttons and the help window; `app` by default). Steps whose part of the screen is missing are
 * skipped; if none is on screen, every tip shows in the middle (`auto`: then it doesn't start at all). */
export function startTour(id: TourId = 'app', opts: { auto?: boolean } = {}) {
  const def = TOURS[id];
  if (!def) return false;
  const here = def.steps.filter((s) => !s.at || anchor(s.at));
  const anchored = here.some((s) => s.at);
  if (!anchored && opts.auto) return false;
  setPref(seenKey(id), '1');
  set(anchored ? { id, steps: here, step: 0, away: false } : { id, steps: def.steps.map((s) => ({ ...s, at: undefined })), step: 0, away: true });
  return true;
}

/** Something else has the student's attention: setup, the app tour waiting to start, a dialog, or a tour. */
function busy() {
  return running !== null || getPref<string>('tourPending', '') === '1'
    || !!document.querySelector('.setup, .modal-backdrop');
}
/** End-to-end tests drive the app through automation: tours that start by themselves would get in their way. */
const automated = () => typeof navigator !== 'undefined' && navigator.webdriver === true;

/** Start tour `id` once, the first time its feature is on screen (`ready`: the feature has loaded). It waits while
 * something else is showing, and is never started again once seen (the ? replays it). */
export function useFirstTime(id: TourId | null | undefined, ready = true) {
  useEffect(() => {
    if (!id || !ready || seen(id) || automated()) return;
    let t = 0;
    const attempt = () => {
      if (seen(id)) return;
      if (busy() || !startTour(id, { auto: true })) t = window.setTimeout(attempt, 1500);
    };
    t = window.setTimeout(attempt, 900); // let the feature finish appearing first
    return () => window.clearTimeout(t);
  }, [id, ready]);
}

/** The ? button that replays a feature's tour. */
export function TourButton({ id, className = '' }: { id: TourId; className?: string }) {
  return (
    <button className={`icon-btn tour-btn${className ? ` ${className}` : ''}`} data-tip="How this works" aria-label={`How this works: ${TOURS[id].title}`}
      onClick={() => startTour(id)}>
      <Icon name="help" size={16} />
    </button>
  );
}

/** Every tour, for the help window. `onPick` runs before the tour starts (e.g. to close the window). */
export function TourList({ onPick }: { onPick: (id: TourId) => void }) {
  return (
    <div className="tour-list" role="list">
      {(Object.keys(TOURS) as TourId[]).map((id) => (
        <button key={id} className="tour-list-item" role="listitem" onClick={() => onPick(id)}>
          <Icon name="play" size={12} /> {TOURS[id].title}
        </button>
      ))}
    </div>
  );
}

export default function Tour({ ready }: { ready: boolean }) {
  const r = useSyncExternalStore(subscribe, () => running);
  const [box, setBox] = useState<DOMRect | null>(null);

  // the app tour, pending after setup: start once the subject page is on screen
  useEffect(() => {
    if (!ready || r || getPref<string>('tourPending', '') !== '1') return;
    const t = setTimeout(() => { setPref('tourPending', ''); startTour('app'); }, 900);
    return () => clearTimeout(t);
  }, [ready, r]);

  const step = r ? r.steps[r.step] : null;
  useLayoutEffect(() => {
    if (!step) return;
    const el = anchor(step.at);
    if (el) {
      const b = el.getBoundingClientRect();
      if (b.bottom < 0 || b.top > window.innerHeight) el.scrollIntoView({ block: 'center' });
    }
    const place = () => { const e = anchor(step.at); setBox(e ? e.getBoundingClientRect() : null); };
    place();
    // panels slide in as a feature opens: look again once they've settled
    const later = window.setTimeout(place, 450);
    window.addEventListener('resize', place);
    return () => { window.clearTimeout(later); window.removeEventListener('resize', place); };
  }, [step]);

  useEffect(() => {
    if (!r) return;
    // the tour's keys come first (captured), so a quiz's Enter or a viewer's Escape doesn't act underneath it
    const k = (e: KeyboardEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      // Enter or Space on one of the tip's own buttons presses that button (and nothing underneath hears it)
      if ((e.key === 'Enter' || e.key === ' ') && t?.closest?.('.tour button')) { e.stopPropagation(); return; }
      const go = (d: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (!running) return;
        const n = running.step + d;
        if (n >= running.steps.length) set(null);
        else if (n >= 0) set({ ...running, step: n });
      };
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(null); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [r]);

  if (!r || !step) return null;
  const n = r.step, total = r.steps.length;
  const pad = 8;
  const hole = box && step.at ? { left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 } : null;
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
  const last = n === total - 1;
  const move = (d: number) => set(n + d >= total ? null : { ...r, step: n + d });
  return createPortal(
    <div className="tour" role="dialog" aria-label={`${TOURS[r.id].title}, tip ${n + 1} of ${total}: ${step.title}`} data-tour={r.id}>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-tip" style={{ ...tip, width: W }} key={`${r.id}-${n}`}>
        <div className="tour-count">{TOURS[r.id].title} · {n + 1} of {total}</div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {r.away && n === 0 && <p className="tour-away">Open {TOURS[r.id].where} to see where each of these is.</p>}
        <div className="tour-foot">
          <button className="link-btn" onClick={() => set(null)}>{last ? 'Close' : 'Skip tour'}</button>
          <span className="spacer" />
          {n > 0 && <button className="btn btn-sm" onClick={() => move(-1)}><Icon name="back" size={14} /> Back</button>}
          <button className="btn btn-sm btn-primary tour-next" autoFocus onClick={() => move(1)}>
            {last ? 'Finish' : 'Next'} {!last && <Icon name="next" size={14} />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
