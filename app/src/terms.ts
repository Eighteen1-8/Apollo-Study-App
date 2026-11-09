/* The words the interface uses for the app's machinery. Plain words by default; advanced mode (Settings → Appearance
   & mode) shows the technical terms. Add a word here rather than writing "ingest" or "embedding" into a component. */
import { isAdvanced, useAdvanced } from './theme';

const TECH = {
  reingest: 'Re-ingest',
  reingestVerb: 're-ingest',
  details: 'View ingested details',
  runVision: 'Run / resume vision',
  checkVision: 'Check vision notes',
  vision: 'Vision',
  visionIncomplete: 'Vision incomplete',
  visionAuto: 'Auto',
  visionAll: 'Every page/slide',
  visionOff: 'Skip vision',
  queued: 'queued',
  parsing: 'parsing',
  embedding: 'embedding',
  ready: 'ready',
  failed: 'failed',
  pending: 'pending',
  running: 'running',
  done: 'done',
  cancelled: 'cancelled',
  references: 'Reference library',
  ingestedRef: 'Textbooks and references. Ingested and searched for every question.',
  ingestedTopic: 'Ingested into this topic.',
  ingestedTopics: "Ingested into a topic. You'll pick the topic for each file.",
  notIngested: 'Read for your next message only. Not ingested or added to your library.',
  docData: 'Its extracted text, embeddings and vision notes are deleted from the app.',
  topicData: 'Its uploaded files, extracted text and embeddings are removed. Generated content stays.',
  reasoning: 'Reasoning',
  topicPill: 'Topic',
  chunks: 'chunks',
  loadingMap: 'Loading vectors…',
  emptyMapSubject: 'Nothing embedded in this subject yet. Upload files to a topic and they will appear here.',
  emptyMap: 'Nothing embedded yet. Upload material and it will appear here.',
  emptyFocus: 'No embedded chunks here yet.',
  llm: 'LLM',
  embeddings: 'embeddings',
  stale: '!',
} as const;

export type Term = keyof typeof TECH;

const PLAIN: Record<Term, string> = {
  reingest: 'Process again',
  reingestVerb: 'process again',
  details: 'See what Apollo extracted',
  runVision: 'Read pictures and diagrams',
  checkVision: 'Check picture notes',
  vision: 'Pictures and diagrams',
  visionIncomplete: 'Pictures not all read',
  visionAuto: 'Read pages that look visual (recommended)',
  visionAll: 'Read every page (slowest, most thorough)',
  visionOff: 'Text only (fastest)',
  queued: 'Waiting',
  parsing: 'Reading',
  embedding: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
  pending: 'Not finished',
  running: 'Working',
  done: 'Done',
  cancelled: 'Cancelled',
  references: 'Textbooks',
  ingestedRef: 'Textbooks and references. Apollo searches them for every question.',
  ingestedTopic: 'Added to this topic for Apollo to study.',
  ingestedTopics: "Added to a topic for Apollo to study. You'll pick the topic for each file.",
  notIngested: 'Used for your next message only. Not added to your library.',
  docData: 'Everything Apollo learned from it is deleted from the app.',
  topicData: 'Its files and everything Apollo learned from them are removed. Generated content stays.',
  reasoning: 'Thinking',
  topicPill: 'Using',
  chunks: 'passages',
  loadingMap: 'Loading the map…',
  emptyMapSubject: 'Nothing here yet. Add files to a topic and they will appear on this map.',
  emptyMap: 'Nothing here yet. Add your study material and it will appear on this map.',
  emptyFocus: 'Nothing from this is on the map yet.',
  llm: 'Apollo',
  embeddings: 'search',
  stale: 'Needs update',
};

/** A term for the current mode, outside React. */
export const term = (k: Term) => (isAdvanced() ? TECH : PLAIN)[k];

/** A term for the current mode; the component re-renders when the mode changes. */
export function useTerms() {
  const adv = useAdvanced();
  return (k: Term) => (adv ? TECH : PLAIN)[k];
}

/** A file or job status in the current mode's words. */
export const statusWord = (s: string) => (s in TECH ? term(s as Term) : s);

/** Chat reasoning levels: what the model calls them, and what a student is shown. */
const LEVEL_TECH: Record<string, string> = { off: 'Off', low: 'Low', medium: 'Medium', xhigh: 'XHigh' };
const LEVEL_PLAIN: Record<string, string> = { off: 'Instant', low: 'Quick', medium: 'Balanced', xhigh: 'Deep' };
const LEVEL_HINT: Record<string, string> = {
  off: 'answers straight away', low: 'a few seconds of thought', medium: 'thinks it through', xhigh: 'slowest, most careful',
};
export const levelLabel = (l: string) => (isAdvanced() ? LEVEL_TECH : LEVEL_PLAIN)[l] ?? l;
export const levelHint = (l: string) => LEVEL_HINT[l] ?? '';
