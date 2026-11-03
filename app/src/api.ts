declare global {
  interface Window {
    studyApp?: {
      backendUrl: string;
      /** The backend's per-launch secret; every request carries it (backend api.require_token). */
      backendToken?: string;
      openFiles: (opts?: { multi?: boolean; filters?: { name: string; extensions: string[] }[] }) => Promise<string[]>;
      pathForFile: (file: File) => string;
      /** The grant for a path the student picked or dropped ('' if none): see grantHeader. */
      grantFor?: (path: string) => string;
      saveFile: (opts?: { defaultName?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      showItem: (path: string) => Promise<void>;
      /** Present when the window has no native title bar (the app draws it; see Titlebar). */
      titlebar?: boolean;
      setChrome?: (c: { color: string; symbol: string; bg: string; dark: boolean }) => void;
      /** Print the element marked #print-root to a PDF the student saves (exportDoc.ts). null: cancelled. */
      printPdf?: (opts: { defaultName: string }) => Promise<string | null>;
      /** A PNG (base64) of an area of the window, in CSS pixels. */
      capture?: (rect: { x: number; y: number; width: number; height: number }) => Promise<string>;
      /** Put a PNG (base64) on the clipboard. */
      copyImage?: (png: string) => Promise<void>;
    };
  }
}

// In Electron the preload provides the URL; a plain-browser dev preview can pass ?backend=PORT.
export const BASE = window.studyApp?.backendUrl
  ?? `http://127.0.0.1:${new URLSearchParams(location.search).get('backend') ?? '47615'}`;
export const inElectron = !!window.studyApp;
// A plain-browser preview passes the token too: ?backend=PORT&token=<contents of <data>/backend-token>.
const TOKEN = window.studyApp?.backendToken ?? new URLSearchParams(location.search).get('token') ?? '';
export const hasToken = !!TOKEN;
const AUTH: Record<string, string> = TOKEN ? { 'X-Apollo-Token': TOKEN } : {};
/** Grants for every file path in a request body that the student picked or dropped (backend grants.py): the backend
 * reads or writes a file outside its data folder only with one. Sent as base64url JSON {path: grant}. */
function grantHeader(body: unknown): Record<string, string> {
  const grantFor = window.studyApp?.grantFor;
  if (!grantFor || body === undefined) return {};
  const found: Record<string, string> = {};
  const walk = (v: unknown) => {
    if (typeof v === 'string') { const g = v.length < 1024 && grantFor(v); if (g) found[v] = g; }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body);
  if (!Object.keys(found).length) return {};
  const bytes = new TextEncoder().encode(JSON.stringify(found));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { 'X-Apollo-Grants': b64 };
}

/** A backend URL the browser loads by itself (<img>, pdf.js), which can't send headers: the token goes in the query. */
export function authUrl(url: string) {
  return TOKEN ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : url;
}

export type VisionMode = 'off' | 'auto' | 'all';

/** stale_docs: files embedded with a different embedding model than the current one (they need re-ingesting). */
export interface Topic { id: number; subject_id: number; name: string; description: string; doc_count?: number; stale_docs?: number }
export interface Subject {
  id: number; name: string; color: string; topics: Topic[]; reference_count: number; stale_docs?: number; stale_reference_docs?: number;
  icon_text: string | null; icon_emoji: string | null; icon_image: string | null;
}
export interface TopicDetail extends Topic {
  subject_name: string; subject_color: string; context_budget: number;
  stats: { docs: number; tokens: number; chunks: number; vision_done: number; vision_total: number };
}
export interface Doc {
  id: number; subject_id: number; topic_id: number | null; kind: 'topic' | 'reference';
  filename: string; ext: string; size: number; status: string; error: string | null; vision_mode: VisionMode;
  unit_count: number; token_count: number; chunk_count: number; duplicate_units: number; stripped_lines: number;
  vision_total: number; vision_done: number; created_at: number;
  annotated_at?: number | null; annotations_ingested?: number | null;
}
export interface Unit {
  id: number; idx: number; kind: string; label: string; text: string; duplicate_of: number | null;
  duplicate_label?: string; token_count: number; equations: number; images: string[]; needs_vision: number;
  vision_reasons: string[]; vision_status: 'none' | 'pending' | 'done' | 'failed' | 'skipped';
  vision_notes: string | null; vision_relevant: number | null; vision_image: string | null;
}
export interface DocDetail extends Doc {
  units: Unit[];
  chunks: { id: number; unit_start: number; unit_end: number; label: string; token_count: number; source: 'text' | 'vision'; embedded: number }[];
}

/** A subject, topic or single file for maintenance actions; a subject includes its reference library. */
export type MaintScope = { subject_id?: number; topic_id?: number; document_id?: number };
export interface MaintDoc {
  id: number; subject_id: number; topic_id: number | null; kind: 'topic' | 'reference'; filename: string; status: string;
  error: string | null; path: string; missing: boolean;
  size: { file: number; render: number; assets: number; index: number; total: number };
  units: number; text_chunks: number; vision_chunks: number; unembedded: number; stale: boolean;
  vision_total: number; vision_done: number; vision_failed: number; flags: number; reviewing: boolean;
  /** Read by an older version of the parser (it may be missing text a newer one finds). */
  old_parser: boolean;
}
export interface MaintOverview {
  data_dir: string; db_path: string; log_path: string; embed_model: string;
  disk: { database: number; files: number; renders: number; assets: number };
  orphans: Record<'files' | 'renders' | 'assets' | 'cache', { count: number; bytes: number }>;
  /** Database rows pointing at nothing (cached figures, screenshot records, older practice exam copies). */
  stale_rows: number;
  parser_version: string;
  subjects: { id: number; name: string; color: string }[];
  topics: { id: number; subject_id: number; name: string }[];
  documents: MaintDoc[];
}
export type FlagKind = 'malformed' | 'incomplete' | 'misleading' | 'failed';
export interface VisionFlag {
  id: number; document_id: number; kind: FlagKind; reason: string; source: 'rule' | 'model'; created_at: number; dismissed: number;
  unit: number; label: string; notes: string; notes_length: number; vision_status: string;
  filename: string; subject_id: number; topic_id: number | null; topic: string | null;
}
/** Paused models: background jobs that need one wait; chat reports it. `running`: job types still mid-request. */
export interface PauseState { llm: boolean; embed: boolean; running: string[] }

/** Settings → Share: study packs (embedded files in one zip, see backend packages.py). */
export interface PackScope { subject_id?: number; topic_id?: number; document_ids?: number[] }
export interface ExportPreview {
  label: string; subject: string; documents: number; skipped: string[]; size: number; embed_model: string;
  annotated: { id: number; filename: string; marks: number }[];
}
export interface ImportPreview {
  subject: string; scope: string | null; topics: string[]; documents: { filename: string; kind: string; notes: boolean }[];
  notes_included: boolean; embed_model: string | null; current_model: string; same_model: boolean; created_at: number | null;
}
export interface ImportResult { subject_id: number; imported: number; skipped: { filename: string; reason: string }[]; reembedding: number; same_model: boolean }

/** Whole-database copies in <data>/backups (backend db.backup); a restore takes effect at the next start. */
export interface Backup { name: string; kind: 'daily' | 'before-update' | 'before-restore' | 'manual'; size: number; created_at: number }
export interface Backups { backups: Backup[]; pending_restore: string | null; folder: string; keep: Record<string, number> }

/** chat / define / quiz_review: interactive model work, shown while it runs (backend jobs.track). */
export type JobType = 'ingest' | 'vision' | 'embed' | 'audit' | 'generate' | 'mark' | 'review' | 'chat' | 'define' | 'quiz_review';
export interface Job {
  id: number; type: JobType; document_id: number; filename: string | null; status: string;
  progress: number; message: string; error: string | null;
}
export interface SearchResult {
  chunk_id: number; document_id: number; filename: string; doc_kind: string; label: string; text: string;
  score: number; bm25_rank?: number; vector_rank?: number; similarity?: number;
  vision_notes: { label: string; vision_notes: string }[];
}
/** Chunk embeddings projected to 3D for the home page cloud. Points: [chunk id, document id, x, y, z, label]. */
/** Display-only folders inside topics, keyed by topic id: the folders and which folder each file (doc id) sits in. */
export type FolderMap = Record<string, { folders: { id: string; name: string }[]; files: Record<string, string> }>;

export interface EmbeddingMap {
  model: string; total: number;
  points: [number, number, number, number, number, string][];
  documents: Record<string, { filename: string; kind: string; subject_id: number; topic_id: number | null; topic: string | null }>;
  subjects: { id: number; name: string; color: string }[];
}
export type Settings = Record<string, string | number | boolean | string[]>;
export type Reasoning = 'off' | 'low' | 'medium' | 'xhigh';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { ...AUTH, ...grantHeader(body), 'Content-Type': 'application/json' } : AUTH,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).detail ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  health: () => req<{ ok: boolean; data_dir: string; auth: boolean }>('GET', '/health'),
  subjects: () => req<Subject[]>('GET', '/subjects'),
  createSubject: (name: string, color?: string) => req<Subject>('POST', '/subjects', { name, color }),
  renameSubject: (id: number, name: string) => req('PATCH', `/subjects/${id}`, { name }),
  deleteSubject: (id: number) => req('DELETE', `/subjects/${id}`),
  createTopic: (subjectId: number, name: string) => req<Topic>('POST', `/subjects/${subjectId}/topics`, { name }),
  topic: (id: number) => req<TopicDetail>('GET', `/topics/${id}`),
  renameTopic: (id: number, name: string) => req('PATCH', `/topics/${id}`, { name }),
  deleteTopic: (id: number) => req('DELETE', `/topics/${id}`),
  topicDocs: (id: number) => req<Doc[]>('GET', `/topics/${id}/documents`),
  referenceDocs: (subjectId: number) => req<Doc[]>('GET', `/subjects/${subjectId}/documents`),
  upload: (body: { paths: string[]; topic_id?: number; subject_id?: number; vision_mode?: VisionMode }) =>
    req<{ filename: string; status: string; message?: string }[]>('POST', '/documents', body),
  document: (id: number) => req<DocDetail>('GET', `/documents/${id}`),
  deleteDocument: (id: number) => req('DELETE', `/documents/${id}`),
  /** Move a file to a topic, or to the subject's reference library (topic_id null). */
  moveDocument: (id: number, topic_id: number | null) => req<Doc>('POST', `/documents/${id}/move`, { topic_id }),
  documentLayout: (id: number) => req<DocLayout>('GET', `/documents/${id}/layout`),
  fileUrl: (id: number) => authUrl(`${BASE}/documents/${id}/file`),
  exportUrl: (id: number) => authUrl(`${BASE}/documents/${id}/export`),
  thumbUrl: (id: number, page: number, w = 120) => authUrl(`${BASE}/documents/${id}/thumb/${page}?w=${w}`),
  outline: (id: number) => req<OutlineItem[]>('GET', `/documents/${id}/outline`),
  snapshot: (id: number, unit: number, rect: [number, number, number, number]) =>
    req<{ path: string; asset: string; name: string }>('POST', `/documents/${id}/snapshot`, { unit, rect }),
  annotations: (docId: number) => req<{ items: Annotation[]; needs_reingest: boolean; doc_status: string }>('GET', `/documents/${docId}/annotations`),
  createAnnotation: (docId: number, body: { unit: number; kind: AnnotationKind; anchor?: TextAnchor; data?: AnnotationData }) =>
    req<Annotation>('POST', `/documents/${docId}/annotations`, body),
  updateAnnotation: (id: number, body: { unit?: number; anchor?: TextAnchor; data?: AnnotationData }) => req<Annotation>('PATCH', `/annotations/${id}`, body),
  deleteAnnotation: (id: number) => req('DELETE', `/annotations/${id}`),
  reingestAnnotations: (docId: number) => req('POST', `/documents/${docId}/reingest-annotations`),
  define: (docId: number, body: { text: string; before: string; after: string; label: string }) =>
    req<{ definition: string }>('POST', `/documents/${docId}/define`, body),
  inspectChatFiles: (paths: string[]) => req<ChatFileCheck[]>('POST', '/chat-files/inspect', { paths }),
  defaultPrompt: () => req<{ prompt: string }>('GET', '/chat/default-prompt'),
  reingest: (id: number) => req('POST', `/documents/${id}/reingest`),
  vision: (id: number, mode?: VisionMode) => req<{ job_id: number | null }>('POST', `/documents/${id}/vision`, { mode }),
  maintenance: () => req<MaintOverview>('GET', '/maintenance/overview'),
  cleanup: (compact: boolean) => req<{ freed: number }>('POST', '/maintenance/cleanup', { compact }),
  reembed: (scope: MaintScope) => req<{ queued: number }>('POST', '/maintenance/reembed', scope),
  reparse: (scope: MaintScope) => req<{ queued: number }>('POST', '/maintenance/reparse', scope),
  /** The rules run now; with `review`, Apollo checks each page against its image in the background. */
  visionScan: (scope: MaintScope, review = true, recheck = false) =>
    req<{ rule_flags: number; queued: number; units: number }>('POST', '/maintenance/vision-scan', { ...scope, review, recheck }),
  visionFlags: (scope: MaintScope, dismissed = false) => req<VisionFlag[]>('GET', `/maintenance/vision-flags?${new URLSearchParams(
    Object.entries({ ...scope, dismissed }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  dismissFlags: (ids: number[], restore = false) => req('POST', '/maintenance/vision-flags/dismiss', { ids, restore }),
  rerunFlagged: (body: MaintScope & { flag_ids?: number[] }) => req<{ units: number; queued: number }>('POST', '/maintenance/vision-rerun', body),
  jobs: (active = false) => req<Job[]>('GET', `/jobs${active ? '?active=true' : ''}`),
  cancelJob: (id: number) => req('POST', `/jobs/${id}/cancel`),
  /** 'Run next': ahead of everything waiting in its lane. */
  prioritizeJob: (id: number) => req('POST', `/jobs/${id}/prioritize`),
  dismissJob: (id?: number) => req('POST', `/jobs/dismiss${id ? `?job_id=${id}` : ''}`),
  exportPreview: (s: PackScope) => req<ExportPreview>('POST', '/export/preview', s),
  exportPack: (s: PackScope & { include_notes: boolean; path: string }) =>
    req<{ path: string; documents: number; bytes: number }>('POST', '/export', s),
  /** Browser fallback (no save dialog): the pack comes back as a download. */
  exportPackBlob: async (s: PackScope & { include_notes: boolean }) => {
    const res = await fetch(BASE + '/export', { method: 'POST', headers: { ...AUTH, ...grantHeader(s), 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? String(res.status));
    const name = /filename="?([^"]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'study-pack.apollo.zip';
    return { blob: await res.blob(), name };
  },
  importPreview: (path: string) => req<ImportPreview>('POST', '/import/preview', { path }),
  importPack: (b: { path: string; subject_id?: number | null; subject_name?: string }) => req<ImportResult>('POST', '/import', b),
  backups: () => req<Backups>('GET', '/backups'),
  backupNow: () => req<Backup>('POST', '/backups'),
  restoreBackup: (name: string | null) => req<{ pending_restore: string | null }>('POST', '/backups/restore', { name }),
  deleteBackup: (name: string) => req('DELETE', `/backups/${encodeURIComponent(name)}`),
  clientLog: (b: { level: 'error' | 'warning'; where: string; message: string; stack: string }) => req('POST', '/client-log', b),
  pauseState: () => req<PauseState>('GET', '/jobs/pause'),
  setPause: (p: { llm?: boolean; embed?: boolean }) => req<PauseState>('POST', '/jobs/pause', p),
  search: (query: string, topic_id: number, include_reference: boolean) =>
    req<{ results: SearchResult[]; warning: string | null }>('POST', '/search', { query, topic_id, include_reference }),
  settings: () => req<Settings>('GET', '/settings'),
  saveSettings: (s: Settings) => req<Settings>('PUT', '/settings', s),
  testSettings: () => req<Record<string, { ok: boolean; online?: boolean; model?: string; error?: string; dim?: number; ms?: number; max_model_len?: number; models?: string[] }>>('POST', '/settings/test'),
  previewUrl: (docId: number, idx: number) => authUrl(`${BASE}/documents/${docId}/units/${idx}/preview`),
  assetUrl: (rel: string) => authUrl(`${BASE}/assets/${rel}`),
  embeddingMap: (subjectId?: number) => req<EmbeddingMap>('GET', `/embeddings/map${subjectId != null ? `?subject_id=${subjectId}` : ''}`),
  folders: (subjectId: number) => req<FolderMap>('GET', `/subjects/${subjectId}/folders`),
  saveFolders: (subjectId: number, f: FolderMap) => req<FolderMap>('PUT', `/subjects/${subjectId}/folders`, f),

  notes: (subjectId: number) => req<NoteSummary[]>('GET', `/subjects/${subjectId}/notes`),
  createNote: (subjectId: number, body: { title?: string; topic_id?: number | null; html?: string } = {}) =>
    req<Note>('POST', `/subjects/${subjectId}/notes`, body),
  note: (id: number) => req<Note>('GET', `/notes/${id}`),
  saveNote: (id: number, body: { title?: string; html?: string; topic_id?: number | null; set_topic?: boolean }) =>
    req<Note>('PATCH', `/notes/${id}`, body),
  deleteNote: (id: number) => req('DELETE', `/notes/${id}`),
  /** Apollo checks a note / generated notes (or a highlighted passage of one) against the material, or revises it. */
  startReview: (body: { target: ReviewTarget; target_id: number; mode: 'check' | 'revise'; quote?: string; section?: number | null; instruction?: string }) =>
    req<Review>('POST', '/reviews', body),
  reviews: (target: ReviewTarget, targetId: number) => req<Review[]>('GET', `/reviews?target=${target}&target_id=${targetId}`),
  review: (id: number) => req<Review>('GET', `/reviews/${id}`),
  applyReview: (id: number) => req<Review>('POST', `/reviews/${id}/apply`),
  undoReview: (id: number) => req<Review>('POST', `/reviews/${id}/undo`),
  dismissReview: (id: number) => req('POST', `/reviews/${id}/dismiss`),
  marks: (artifactId: number) => req<Mark[]>('GET', `/artifacts/${artifactId}/marks`),
  addMark: (artifactId: number, body: { section: number; start: number; end: number; text: string; color: string }) =>
    req<Mark>('POST', `/artifacts/${artifactId}/marks`, body),
  moveMark: (id: number, body: { start?: number; end?: number; color?: string }) => req<Mark>('PATCH', `/marks/${id}`, body),
  deleteMark: (id: number) => req('DELETE', `/marks/${id}`),
  /** Word export of HTML built by exportDoc.ts: saved at `path` (save dialog), or returned as a download. */
  exportDocx: (body: { title: string; html: string; path: string }) => req<{ path: string }>('POST', '/export/docx', body),
  exportDocxBlob: async (body: { title: string; html: string }) => {
    const res = await fetch(BASE + '/export/docx', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? String(res.status));
    return res.blob();
  },
  /** A screenshot taken in the app, kept as a file the chat can attach. */
  saveChatImage: (png: string, name: string) => req<{ path: string; name: string }>('POST', '/chat-files/image', { png, name }),

  chats: (subjectId: number) => req<Chat[]>('GET', `/subjects/${subjectId}/chats`),
  createChat: (subjectId: number, topic_id: number | null) => req<Chat>('POST', `/subjects/${subjectId}/chats`, { topic_id }),
  chat: (id: number) => req<Chat & { messages: Message[] }>('GET', `/chats/${id}`),
  setChatTopic: (id: number, topic_id: number | null) => req<Chat>('PATCH', `/chats/${id}`, { topic_id, set_topic: true }),
  renameChat: (id: number, title: string) => req<Chat>('PATCH', `/chats/${id}`, { title }),
  deleteChat: (id: number) => req('DELETE', `/chats/${id}`),
  openTool: (chatId: number, tool: ToolName, args: Record<string, unknown> = {}) => req<Message>('POST', `/chats/${chatId}/tool`, { tool, args }),
  submitTool: (messageId: number, args: Record<string, unknown>, topic_id: number | null) =>
    req<Message>('POST', `/messages/${messageId}/submit`, { args, topic_id }),
  dismissTool: (messageId: number) => req<Message>('POST', `/messages/${messageId}/dismiss`),
  artifact: (id: number) => req<Artifact>('GET', `/artifacts/${id}`),
  retryArtifact: (id: number) => req('POST', `/artifacts/${id}/retry`),
  cancelArtifact: (id: number) => req('POST', `/artifacts/${id}/cancel`),
  submitAttempt: (artifactId: number, answers: Record<string, string>) => req<Attempt>('POST', `/artifacts/${artifactId}/attempts`, { answers }),
  attempt: (id: number) => req<Attempt>('GET', `/attempts/${id}`),

  setIcon: (id: number, body: { color?: string; icon_text?: string; icon_emoji?: string; clear_image?: boolean; image_path?: string }) =>
    req('PATCH', `/subjects/${id}/icon`, body),
  allDocuments: (subjectId: number) => req<DocRef[]>('GET', `/subjects/${subjectId}/all-documents`),
  library: (subjectId: number) => req<LibraryItem[]>('GET', `/subjects/${subjectId}/library`),
  renameArtifact: (id: number, title: string) => req('PATCH', `/artifacts/${id}`, { title }),
  deleteArtifact: (id: number) => req('DELETE', `/artifacts/${id}`),
  deleteCards: (artifactId: number, indices: number[]) => req<{ ok: boolean; count: number }>('POST', `/artifacts/${artifactId}/cards/delete`, { indices }),
  rateCard: (artifactId: number, index: number, rating: 'confident' | 'struggling' | 'none') =>
    req('PUT', `/artifacts/${artifactId}/cards/${index}/rating`, { rating }),
  quizReview: (artifactId: number, answers: Record<string, number>) => req<QuizReview>('POST', `/artifacts/${artifactId}/quiz-review`, { answers }),
  todos: (subjectId: number) => req<Todo[]>('GET', `/subjects/${subjectId}/todos`),
  addTodo: (subjectId: number, body: { text: string; note?: string; topic_id?: number | null; source?: string }) =>
    req<Todo>('POST', `/subjects/${subjectId}/todos`, body),
  setTodo: (id: number, body: { text?: string; done?: boolean }) => req<Todo>('PATCH', `/todos/${id}`, body),
  deleteTodo: (id: number) => req('DELETE', `/todos/${id}`),

  ask: (chatId: number, content: string, reasoning: Reasoning, onEvent: (e: ChatEvent) => void,
    extra: { attachments?: number[]; files?: string[]; quote?: Quote | null } = {}) =>
    streamChat(`/chats/${chatId}/messages`, { content, reasoning, ...extra }, onEvent),
  /** Rewrite a question: it and everything after it are replaced, then Qwen answers again (streamed). */
  editMessage: (messageId: number, content: string, reasoning: Reasoning, onEvent: (e: ChatEvent) => void) =>
    streamChat(`/messages/${messageId}/edit`, { content, reasoning }, onEvent),
  /** A new answer in place of this reply (and anything after it). */
  regenerate: (messageId: number, reasoning: Reasoning, onEvent: (e: ChatEvent) => void) =>
    streamChat(`/messages/${messageId}/regenerate`, { reasoning }, onEvent),
  /** Remove this message and everything after it; returns the removed message. */
  rollback: (messageId: number) => req<Message>('POST', `/messages/${messageId}/rollback`),
  exportTo: (docId: number, path: string) => req<{ path: string }>('POST', `/documents/${docId}/export`, { path }),
  embeddingStatus: (model?: string) =>
    req<{ documents: number; current: string }>('GET', `/embedding-status${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  reingestStale: (subjectId: number, body: { topic_id?: number; reference?: boolean } = {}) =>
    req<{ queued: number }>('POST', `/subjects/${subjectId}/reingest-stale`, body),
};

/** Server-sent chat events: user | status | reasoning | delta | assistant | tool | error | end. */
async function streamChat(path: string, body: unknown, onEvent: (e: ChatEvent) => void) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { ...AUTH, ...grantHeader(body), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export type ToolName = 'add_todos' | 'review_content' | 'create_flashcards' | 'create_quiz' | 'create_exam' | 'create_notes'
  | 'create_cheatsheet' | 'create_mindmap';
export type ArtifactType = 'flashcards' | 'quiz' | 'exam' | 'notes' | 'cheatsheet' | 'mindmap';

/** The student's own note (rich text). Never ingested into the material. */
export interface NoteSummary { id: number; subject_id: number; topic_id: number | null; topic_name: string | null; title: string; created_at: number; updated_at: number; size: number }
export interface Note { id: number; subject_id: number; topic_id: number | null; title: string; html: string; created_at: number; updated_at: number }
export type ReviewTarget = 'note' | 'artifact';
export interface ReviewIssue { quote: string; problem: string; fix: string; source: string }
export interface Review {
  id: number; subject_id: number; target: ReviewTarget; target_id: number; section: number | null; quote: string; instruction: string;
  mode: 'check' | 'revise'; status: string; progress: number; message: string; error: string | null; applied: number;
  target_title?: string | null; created_at: number;
  result: null | {
    verdict?: 'correct' | 'mostly_correct' | 'incorrect' | 'unsure'; summary?: string; issues?: ReviewIssue[];
    comment?: string; sections?: { index: number; html?: string; markdown?: string; figures?: Record<string, FigureRef> }[];
  };
}
/** A highlight on generated notes: character offsets into a section's text. */
export interface Mark { id: number; artifact_id: number; section: number; start: number; end: number; text: string; color: string }
export interface MindNode { label: string; note: string; source: string; children: MindNode[] }

export interface Chat { id: number; subject_id: number; topic_id: number | null; title: string; updated_at: number }
export interface ArtifactSummary { id: number; type: ArtifactType; title: string; status: string; progress: number; message: string; error: string | null }
export interface Message {
  id: number; chat_id: number; role: 'user' | 'assistant' | 'tool'; content: string; created_at: number;
  meta: {
    reasoning?: string; reasoning_seconds?: number | null; reasoning_level?: Reasoning;
    tool?: ToolName; type?: ArtifactType; args?: Record<string, unknown>;
    status?: 'form' | 'submitted' | 'dismissed'; artifact_id?: number; topic_id?: number | null;
    attachments?: { id: number; filename: string }[]; quote?: Quote;
    files?: { name: string; kind: 'text' | 'image'; words?: number; asset?: string; source?: AreaSource }[]; todos?: string[];
    searched_other_topics?: string[]; figures?: Record<string, FigureRef>;
    /** review_content (Apollo checking or revising a note, asked in chat) */
    review_id?: number; mode?: 'check' | 'revise'; title?: string; target?: ReviewTarget; target_id?: number; instruction?: string; error?: string;
  };
  artifact?: ArtifactSummary | null;
}
export type ChatEvent =
  | { type: 'user' | 'assistant' | 'tool'; message: Message }
  | { type: 'status' | 'reasoning' | 'delta' | 'error'; text: string }
  | { type: 'end' };

export interface RubricPoint { point: string; marks: number }
export interface ExamQuestion {
  type: string; prompt: string; marks: number; options: string[]; answer_index: number | null; model_answer: string;
  rubric: RubricPoint[]; stimulus: string; source: string;
  subquestions: { prompt: string; marks: number; options?: string[]; answer_index?: number | null; model_answer: string; rubric: RubricPoint[] }[];
}
export interface ArtifactContent {
  cards?: { front: string; back: string; source: string }[];
  questions?: { question: string; options: string[]; answer_index: number; explanation: string; source: string }[];
  /** Notes / cheat sheets: `html` (component-based, newer) or `markdown` (older), plus resolved figure tags. */
  sections?: { title: string; topic?: string; markdown?: string; html?: string; figures?: Record<string, FigureRef> }[];
  parts?: { name: string; instructions: string; type: string; questions: ExamQuestion[] }[];
  total_marks?: number; time_minutes?: number | null; difficulty?: string; practice_exam?: string; warning?: string | null;
  blueprint?: { title: string; instructions: string; difficulty_profile: string };
  mindmap?: MindNode;
}
export interface Artifact extends ArtifactSummary {
  subject_id: number; topic_id: number | null; params: Record<string, unknown>; content: ArtifactContent | null;
  attempts: { id: number; kind: 'exam' | 'quiz'; status: string; score: number | null; total: number | null; created_at: number }[];
  ratings: Record<string, 'confident' | 'struggling'>;
}
/** A [[figure: …]] tag resolved to a crop of the student's material (or not found). */
export interface FigureRef { asset?: string; file: string; label: string; caption: string; doc_id?: number; unit?: number; page?: number; whole?: boolean; missing?: boolean }

/** Where a viewer screenshot came from: page/slide/section and the box on it (fractions). */
export interface AreaSource { document_id: number; unit: number; rect: [number, number, number, number] }
export interface ChatFileCheck { path: string; name: string; ok: boolean; kind?: 'text' | 'image'; words?: number; error?: string; source?: AreaSource | null }

export type AnnotationKind = 'highlight' | 'note' | 'ink' | 'textbox' | 'region';
/** Points are fractions of the unit box: [x0, y0, x1, y1, ...]; width is a fraction of the unit's width. */
export interface Stroke { color: string; width: number; points: number[] }
/** Text anchor: character offsets into the unit's rendered text, the text itself, and its boxes as unit fractions. */
export interface TextAnchor { start?: number; end?: number; text?: string; rects?: [number, number, number, number][] }
export interface AnnotationData {
  color?: string; text?: string; title?: string; definition?: boolean; pending?: boolean; hidden?: boolean;
  x?: number; y?: number; w?: number; h?: number; size?: number; strokes?: Stroke[];
  /** 'pdf': made on a Word file's exact PDF copy, so unit is a page (ingest maps it back to a section). */
  space?: 'pdf';
  /** A note about a boxed area of the page (anchor.rects[0]) rather than about text. */
  area?: boolean;
}
export interface Annotation {
  id: number; document_id: number; unit: number; kind: AnnotationKind; anchor: TextAnchor; data: AnnotationData;
  created_at: number; updated_at: number;
}

/** Text highlighted in a document (or in notes / generated content: no document_id), with the sentence before and
 * after it (what Qwen sees). */
export interface Quote { document_id: number | null; filename: string; label: string; text: string; before: string; after: string }

export interface SlideItem {
  x: number; y: number; w: number; h: number; rot: number;
  type: 'text' | 'image' | 'table';
  paras?: { text: string; size: number; bold: boolean; level: number; align: string; bullet: boolean }[];
  anchor?: 'top' | 'middle' | 'bottom';
  src?: string | null; crop?: [number, number, number, number] | null;
  rows?: string[][];
}
export interface DocxBlock {
  unit: number | null; type: 'heading' | 'para' | 'table'; text?: string; level?: number; list?: number;
  align?: string; images?: string[]; rows?: string[][];
}
export type DocLayout =
  | { kind: 'slides'; width: number; height: number; slides: { idx: number; items: SlideItem[] }[] }
  | { kind: 'docx'; blocks: DocxBlock[] }
  /** PDFs, and Office files shown from their exact PDF copy. unit_pos (Word): section idx → [page, y fraction]. */
  | { kind: 'pdf'; source: 'pdf' | 'pptx' | 'docx'; url: string; unit_pos?: Record<string, [number, number]> }
  | { kind: 'image' | 'text' };
export interface OutlineItem { level: number; title: string; unit: number; y: number }
export interface DocRef { id: number; filename: string; kind: 'topic' | 'reference'; topic_id: number | null; ext: string; topic_name: string | null }
export interface LibraryItem {
  id: number; topic_id: number | null; topic_name: string | null; chat_id: number | null; type: ArtifactType; title: string;
  status: string; progress: number; message: string; created_at: number;
}
export interface QuizReview {
  attempt_id: number; score: number; total: number; summary: string; strengths: string[];
  revise: { topic: string; reason: string; source: string }[];
}
export interface Todo {
  id: number; subject_id: number; topic_id: number | null; topic_name?: string | null; text: string; note: string;
  source: string; done: number; created_at: number;
}
export interface Attempt {
  id: number; artifact_id: number; status: string; answers: Record<string, string>; score: number | null; total: number | null;
  progress: number; message: string;
  result: Record<string, { label: string; marks_awarded: number; max: number; feedback: string; missing_points: string[]; correct?: boolean }> | null;
}
