import { describe, expect, it } from 'vitest';
import { DONE_MS, ERROR_MS, jobTransitions, petMood, PetJob, PetSignals, TIMER_MS } from '../../src/petStatus';

const NOW = 1_000_000;
const job = (id: number, type: string, status: string, extra: Partial<PetJob> = {}): PetJob =>
  ({ id, type, status, message: '', filename: `file${id}.pdf`, ...extra });
const ok = { ok: true, paused: false };
const mood = (s: Partial<PetSignals>) => petMood({ now: NOW, jobs: [], ...s });

describe('the app pet’s mood', () => {
  it('is idle with nothing going on', () => {
    expect(mood({}).state).toBe('idle');
  });

  it('follows the priority: error > offline > paused > timer > reply > job > waiting > celebrate > idle', () => {
    const all: Partial<PetSignals> = {
      failed: { name: 'Lecture 3.pdf', type: 'ingest', at: NOW - 1000 },
      models: { llm: { ok: false, paused: false }, embed: ok },
      paused: { llm: false, embed: true },
      timerAt: NOW - 1000,
      replies: [{ status: '', text: 'Hello', reasoning: '' }],
      jobs: [job(1, 'generate', 'running'), job(2, 'ingest', 'queued')],
      finished: { name: 'Cards', type: 'generate', at: NOW - 1000 },
    };
    const order = ['error', 'offline', 'paused', 'timer', 'replying', 'writing', 'waiting', 'celebrate', 'idle'];
    const s = { ...all };
    for (const want of order) {
      expect(mood(s).state).toBe(want);
      // take away the signal behind this mood and look again
      if (want === 'error') delete s.failed;
      if (want === 'offline') s.models = { llm: ok, embed: ok };
      if (want === 'paused') s.paused = null;
      if (want === 'timer') delete s.timerAt;
      if (want === 'replying') s.replies = [];
      if (want === 'writing') s.jobs = s.jobs!.filter((j) => j.status !== 'running');
      if (want === 'waiting') s.jobs = [];
      if (want === 'celebrate') delete s.finished;
    }
  });

  it('lets brief moods run out', () => {
    expect(mood({ failed: { name: 'x', at: NOW - ERROR_MS - 1 } }).state).toBe('idle');
    expect(mood({ timerAt: NOW - TIMER_MS - 1 }).state).toBe('idle');
    expect(mood({ finished: { name: 'x', type: 'generate', at: NOW - DONE_MS - 1 } }).state).toBe('idle');
    expect(mood({ finished: { name: 'Cards', type: 'generate', at: NOW } }).text).toBe('‘Cards’ is ready');
  });

  it('says what each kind of job is doing, in plain words', () => {
    expect(mood({ jobs: [job(1, 'ingest', 'running', { filename: 'Lecture 3.pdf' })] })).toEqual({ state: 'reading', text: 'Reading ‘Lecture 3.pdf’…' });
    expect(mood({ jobs: [job(1, 'vision', 'running', { filename: 'L.pdf' })] }).text).toBe('Reading the pictures in ‘L.pdf’…');
    expect(mood({ jobs: [job(1, 'generate', 'running', { filename: 'Motion flashcards' })] })).toEqual({ state: 'writing', text: 'Making ‘Motion flashcards’…' });
    expect(mood({ jobs: [job(1, 'generate', 'running', { filename: 'Marking: essay' })] }).text).toBe('Marking ‘essay’…');
    expect(mood({ jobs: [job(1, 'review', 'running')] }).state).toBe('checking');
  });

  it('treats a job held by a paused or busy model as waiting', () => {
    const held = job(1, 'vision', 'running', { message: 'Waiting for the model' });
    expect(mood({ jobs: [held] })).toEqual({ state: 'waiting', text: 'Waiting for the model' });
    // another job actually working wins
    expect(mood({ jobs: [held, job(2, 'embed', 'running')] }).state).toBe('reading');
    expect(mood({ jobs: [job(1, 'ingest', 'queued'), job(2, 'ingest', 'queued')] }).text).toBe('2 things waiting their turn');
  });

  it('shows a chat reply thinking, writing, or waiting its turn', () => {
    expect(mood({ replies: [{ status: '', text: '', reasoning: 'hmm' }] }).state).toBe('thinking');
    expect(mood({ replies: [{ status: 'Sending…', text: '', reasoning: '' }] }).state).toBe('thinking');
    expect(mood({ replies: [{ status: 'Waiting for Apollo to finish another reply', text: '', reasoning: '' }] }))
      .toEqual({ state: 'waiting', text: 'Waiting for Apollo to finish another reply' });
  });

  it('names what is paused', () => {
    expect(mood({ paused: { llm: true, embed: false } }).text).toBe('Apollo paused');
    expect(mood({ paused: { llm: true, embed: true } }).text).toBe('Apollo and search paused');
    // a paused model isn't "unreachable"
    expect(mood({ models: { llm: { ok: false, paused: true }, embed: ok } }).state).toBe('paused');
  });
});

describe('job transitions', () => {
  it('reports jobs that just finished or failed, but not on the first look or after a cancel', () => {
    const seen = new Map<number, string>();
    expect(jobTransitions(seen, [job(1, 'ingest', 'done'), job(2, 'generate', 'running'), job(3, 'vision', 'running')], NOW))
      .toEqual({ finished: null, failed: null });
    const t = jobTransitions(seen, [job(1, 'ingest', 'done'), job(2, 'generate', 'done', { filename: 'Cards' }), job(3, 'vision', 'failed')], NOW);
    expect(t.finished).toEqual({ name: 'Cards', type: 'generate', at: NOW });
    expect(t.failed?.type).toBe('vision');
    jobTransitions(seen, [job(4, 'ingest', 'running')], NOW);
    expect(jobTransitions(seen, [job(4, 'ingest', 'cancelled')], NOW)).toEqual({ finished: null, failed: null });
    // a chat reply finishing is nothing to celebrate
    jobTransitions(seen, [job(5, 'chat', 'running')], NOW);
    expect(jobTransitions(seen, [job(5, 'chat', 'done')], NOW).finished).toBeNull();
  });
});
