/* What the app pet (components/Pet.tsx) is doing: one mood worked out from signals the app already has (the jobs
   list, paused models, model reachability, chat replies being written, the study timer, and recent finishes and
   failures). Pure, so it can be tested; Pet.tsx gathers the signals and draws the mood.

   Priority, highest first:
     error      a job or chat reply failed in the last ERROR_MS
     offline    the language model can't be reached (and isn't paused)
     paused     a model is paused from the jobs list
     timer      the study timer just finished (TIMER_MS)
     replying / thinking   a chat reply is being written (thinking: no text yet)
     reading / writing / checking   a background job is running (by its type)
     waiting    a job or reply is queued, or waiting for the model
     celebrate  a job just finished (DONE_MS)
     idle */
import { term } from './terms';

export type PetState = 'idle' | 'error' | 'offline' | 'paused' | 'timer' | 'replying' | 'thinking' | 'reading' | 'writing' | 'checking' | 'waiting' | 'celebrate';

export interface PetJob { id: number; type: string; status: string; message: string; filename: string | null; label?: string | null }
export interface PetEvent { name: string; type?: string; at: number }
export interface PetSignals {
  now: number;
  jobs: PetJob[];
  paused?: { llm: boolean; embed: boolean } | null;
  models?: { llm: { ok: boolean; paused: boolean }; embed: { ok: boolean; paused: boolean } } | null;
  /** Chat replies being written right now. */
  replies?: { status: string; text: string; reasoning: string }[];
  /** The latest failure (a job, or a chat reply). */
  failed?: PetEvent | null;
  /** The latest job that finished well. */
  finished?: PetEvent | null;
  /** When the study timer last finished. */
  timerAt?: number | null;
}
export interface PetMood {
  state: PetState;
  /** The bubble's words. */
  text: string;
}

export const ERROR_MS = 20_000;
export const TIMER_MS = 8_000;
export const DONE_MS = 5_000;

const ACTIVE = ['running', 'queued'];
/** Jobs whose finish is worth a little celebration (not every chat reply or index refresh). */
const CELEBRATE = ['ingest', 'vision', 'generate', 'mark', 'review'];
const READING = ['ingest', 'embed', 'vision', 'audit'];
const CHECKING = ['review', 'mark', 'quiz_review'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const q = (name: string | null | undefined) => (name ? ` ‘${name}’` : '');

/** What a running job is doing, in a few words ("Reading ‘Lecture 3.pdf’…"). */
export function jobWords(j: PetJob): string {
  const name = j.filename ?? j.label ?? null;
  switch (j.type) {
    case 'ingest': return `${cap(term('parsing'))}${q(name)}…`;
    case 'embed': return `${cap(term('embedding'))}${q(name)}…`;
    case 'vision': return `${term('visionRunning')}${q(name) || ' a file'}…`;
    case 'audit': return `${term('visionChecking')}${q(name) || ' a file'}…`;
    case 'generate': return name?.startsWith('Marking: ') ? `Marking${q(name.slice(9))}…` : `Making${q(name)}…`;
    case 'mark': return `Marking${q(name)}…`;
    case 'review': return `Giving feedback on${q(name)}…`;
    case 'questions': return 'Thinking of example questions…';
    case 'define': return `Looking up${q(name)}…`;
    case 'quiz_review': return 'Going over your quiz…';
    case 'chat': return 'Writing a reply…';
    default: return `${cap(term('running'))}…`;
  }
}

const jobState = (type: string): PetState => (READING.includes(type) ? 'reading' : CHECKING.includes(type) ? 'checking' : 'writing');
/** A job that is "running" but parked: waiting for a paused model or for its turn at the model. */
const parked = (j: PetJob) => /^(Paused|Waiting)/.test(j.message ?? '');

export function petMood(s: PetSignals): PetMood {
  const { now } = s;
  if (s.failed && now - s.failed.at < ERROR_MS) {
    return { state: 'error', text: s.failed.name ? `Couldn’t finish ‘${s.failed.name}’` : 'Something went wrong' };
  }
  if (s.models && !s.models.llm.ok && !s.models.llm.paused) return { state: 'offline', text: `Can’t reach ${term('llm')}` };
  const paused = (['llm', 'embed'] as const).filter((k) => s.paused?.[k] || s.models?.[k].paused);
  if (paused.length) {
    return { state: 'paused', text: `${cap(paused.map((k) => term(k === 'llm' ? 'llm' : 'embeddings')).join(' and '))} paused` };
  }
  if (s.timerAt != null && now - s.timerAt < TIMER_MS) return { state: 'timer', text: 'Time’s up! Take a break' };

  const replies = s.replies ?? [];
  const writing = replies.find((r) => !/^Waiting/.test(r.status));
  if (writing) {
    if (writing.text) return { state: 'replying', text: 'Writing a reply…' };
    if (writing.reasoning) return { state: 'thinking', text: `${cap(term('reasoning'))}…` };
    return { state: 'thinking', text: writing.status && !/^Sending/.test(writing.status) ? writing.status : 'Reading your question…' };
  }

  const running = s.jobs.filter((j) => j.status === 'running');
  // a chat reply's own job row is shown through `replies`; one from elsewhere still counts as writing
  const busy = running.find((j) => !parked(j));
  if (busy) return { state: jobState(busy.type), text: jobWords(busy) };

  const waitingReply = replies.find((r) => /^Waiting/.test(r.status));
  if (waitingReply) return { state: 'waiting', text: waitingReply.status };
  const held = running.find(parked);
  if (held) return { state: 'waiting', text: held.message };
  const queued = s.jobs.filter((j) => j.status === 'queued');
  if (queued.length) return { state: 'waiting', text: queued.length === 1 ? `Waiting to start${q(queued[0].filename ?? queued[0].label)}` : `${queued.length} things waiting their turn` };

  if (s.finished && now - s.finished.at < DONE_MS) return { state: 'celebrate', text: doneWords(s.finished) };
  return { state: 'idle', text: 'All caught up' };
}

function doneWords(e: PetEvent): string {
  if (e.type === 'generate') return e.name.startsWith('Marking: ') ? `‘${e.name.slice(9)}’ is marked` : `‘${e.name}’ is ready`;
  if (e.type === 'ingest') return `Added ‘${e.name}’`;
  return 'Done!';
}

/** Jobs that changed from queued/running to finished or failed since the last look (`prev`: job id → status, updated
 * in place). The first look only records statuses. */
export function jobTransitions(prev: Map<number, string>, jobs: PetJob[], now: number): { finished: PetEvent | null; failed: PetEvent | null } {
  let finished: PetEvent | null = null;
  let failed: PetEvent | null = null;
  for (const j of jobs) {
    const was = prev.get(j.id);
    prev.set(j.id, j.status);
    if (!was || !ACTIVE.includes(was) || ACTIVE.includes(j.status)) continue;
    const name = j.filename ?? j.label ?? '';
    if (j.status === 'failed') failed = { name, type: j.type, at: now };
    else if (j.status === 'done' && CELEBRATE.includes(j.type)) finished = { name, type: j.type, at: now };
  }
  return { finished, failed };
}
