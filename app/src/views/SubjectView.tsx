import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, AreaSource, DocRef, Quote, Subject, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import EmbeddingCloud, { CloudFocus } from '../components/EmbeddingCloud';
import { FileDropOverlay, TopicAssignDialog } from '../components/FileDrop';
import { useOverlay } from '../components/overlay';
import { Empty } from '../components/ui';
import UploadDialog from '../components/UploadDialog';
import ChatView from './ChatView';
import DocumentView from './DocumentView';
import LibraryPanel from './LibraryPanel';
import ResourcePanel from './ResourcePanel';
import SourceView from './SourceView';
import ArtifactViewer, { ArtifactPage } from './ArtifactViewer';
import { useAppearance } from '../theme';

type RouteSubject = Extract<Route, { name: 'subject' }>;
type Side = 'left' | 'right';
type Upload = { title: string; target: { topic_id?: number; subject_id?: number }; mode: 'auto' | 'all'; paths: string[] };

export const CREATE_ITEMS: { tool: ToolName; label: string }[] = [
  { tool: 'create_flashcards', label: 'Flashcards' },
  { tool: 'create_quiz', label: 'Quiz' },
  { tool: 'create_exam', label: 'Exam (from a practice exam)' },
  { tool: 'create_notes', label: 'Full notes' },
  { tool: 'create_cheatsheet', label: 'Cheat sheet' },
];

/** Normalise filenames for citation matching (Qwen sometimes drops the extension or changes case). */
const norm = (s: string) => s.toLowerCase().replace(/\.(pdf|pptx|docx|txt|md|png|jpe?g)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

const MARGIN = 18;
const MIN_W = 320;
const MIN_H = 240;

function loadPref<T>(key: string, parse: (v: string) => T, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : parse(v); } catch { return fallback; }
}
function savePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* storage unavailable */ }
}

/**
 * Subject workspace: generated-content library (left) · the subject's knowledge cloud, an open document, or the
 * chat (centre) · resources (right). The cloud is the default centre: sidebar clicks narrow it to a topic, folder or
 * file (see ResourcePanel). With the cloud or a document showing, the chat floats in a bottom corner (drag the header to switch corners, drag its inner top
 * corner to resize) and can be minimised to a pill or made full screen. The shell's box is set in pixels so every
 * change animates. Files dragged in from Explorer get a drop overlay: reference library, topic, or this chat.
 */
export default function SubjectView({ route, subjects, go, onChange }: {
  route: RouteSubject; subjects: Subject[]; go: (r: Route) => void; onChange: () => void;
}) {
  const ov = useOverlay();
  const subject = subjects.find((s) => s.id === route.id);
  const [doc, setDoc] = useState<{ id: number; focus?: string; nonce: number; details: boolean; pulse?: AreaSource } | null>(null);
  const [look] = useAppearance();
  const [focus, setFocus] = useState<CloudFocus>(null);
  // the cloud is what a subject opens to, so the chat starts as a pill unless a create form is waiting in it
  const [chatCollapsed, setChatCollapsed] = useState(() => look.cloud && !route.launch);
  const [chatFull, setChatFull] = useState(false);
  const [side, setSide] = useState<Side>(() => loadPref('chatSide', (v) => (v === 'left' ? 'left' : 'right'), 'right'));
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => loadPref('chatSize', JSON.parse, null));
  const [quote, setQuote] = useState<(Quote & { nonce: number }) | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [page, setPage] = useState<number | null>(null); // notes / cheat sheet shown in the centre
  const [launch, setLaunch] = useState(route.launch);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [assign, setAssign] = useState<string[] | null>(null);
  const [incoming, setIncoming] = useState<{ paths: string[]; nonce: number } | null>(null);
  const center = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const docs = usePoll(() => api.allDocuments(route.id), 10000, [route.id]);

  useEffect(() => { if (route.launch) setLaunch(route.launch); }, [route.launch]);

  useLayoutEffect(() => {
    const el = center.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Follow window resizes instantly; only state changes animate.
      shell.current?.classList.add('instant');
      setBox({ w: el.clientWidth, h: el.clientHeight });
      setTimeout(() => shell.current?.classList.remove('instant'), 60);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!subject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Files dragged in from Explorer: show the drop overlay until they're dropped or leave the window.
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (isFiles(e)) { depth++; setFileDrag(true); } };
    const leave = (e: DragEvent) => { if (isFiles(e) && --depth <= 0) { depth = 0; setFileDrag(false); } };
    const over = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); }; // never let Electron navigate to the file
    const drop = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); depth = 0; setFileDrag(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Opening a document (from a citation or the file list) keeps the chat open; it just moves into its corner.
  const openDoc = useCallback((id: number, focus?: string, details = false) => {
    setDoc({ id, focus: focus || undefined, nonce: Date.now(), details });
    setPage(null);
    setChatFull(false);
  }, []);

  /** Notes and cheat sheets open in the centre like a document; flashcards, quizzes and exams stay full screen. */
  const openArtifact = useCallback(async (id: number) => {
    const a = await api.artifact(id);
    if (a.type === 'notes' || a.type === 'cheatsheet') {
      setDoc(null);
      setPage(id);
      setChatFull(false);
    } else setViewing(id);
  }, []);

  /** A screenshot in the chat: open its document at the area it came from and outline it briefly. */
  const showArea = useCallback((s: AreaSource) => {
    setDoc({ id: s.document_id, nonce: Date.now(), details: false, pulse: s });
    setPage(null);
    setChatFull(false);
  }, []);

  const openCitation = useCallback((file: string, label: string) => {
    const list: DocRef[] = docs.data ?? [];
    const f = norm(file);
    const d = list.find((x) => norm(x.filename) === f) ?? list.find((x) => norm(x.filename).startsWith(f) || f.startsWith(norm(x.filename)));
    if (d) openDoc(d.id, label);
  }, [docs.data, openDoc]);

  const askAbout = useCallback((q: Quote) => {
    setQuote({ ...q, nonce: Date.now() });
    setChatCollapsed(false);
  }, []);

  if (!subject) return <div className="page"><Empty title="Subject not found" /></div>;

  const create = (tool: ToolName, topicId: number | null) => {
    setLaunch({ tool, topicId, nonce: Date.now() });
    setChatCollapsed(false);
  };

  const dropToTopic = async (paths: string[]) => {
    if (!paths.length) return;
    let topics = subject.topics;
    if (!topics.length) {
      const name = await ov.prompt({ title: 'Name a topic for these files', placeholder: 'e.g. Electric circuits', confirmText: 'Create topic' });
      if (!name) return;
      topics = [await api.createTopic(subject.id, name)];
      onChange();
    }
    if (topics.length === 1) setUpload({ title: `Add files to ${topics[0].name}`, target: { topic_id: topics[0].id }, mode: 'auto', paths });
    else setAssign(paths);
  };

  const showCloud = look.cloud && !doc && page === null;
  const floating = !!doc || page !== null || showCloud;
  const collapsed = floating && chatCollapsed;
  const full = floating && chatFull && !collapsed;
  const maxW = box.w - 2 * MARGIN;
  const maxH = box.h - 2 * MARGIN;
  let geo: { left: number; top: number; width: number; height: number };
  if (!floating || full) geo = { left: 0, top: 0, width: box.w, height: box.h };
  else {
    const width = Math.max(collapsed ? Math.min(300, maxW) : Math.min(Math.max(size?.w ?? 460, MIN_W), maxW), 0);
    const height = Math.max(collapsed ? 48 : Math.min(Math.max(size?.h ?? Math.min(Math.round(box.h * 0.7), 680), MIN_H), maxH), 0);
    geo = { width, height, top: box.h - height - MARGIN, left: side === 'right' ? box.w - width - MARGIN : MARGIN };
  }

  /** Drag the floating chat by its header; on release it docks to the nearer bottom corner. A plain click on the
   * pill's header opens it. */
  const startDrag = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!floating || full || e.button !== 0 || !t.closest('.chat-head') || t.closest('button, select, input, textarea')) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      setDrag({ dx, dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        if (collapsed) setChatCollapsed(false);
        return;
      }
      const r = shell.current!.getBoundingClientRect();
      const c = center.current!.getBoundingClientRect();
      const next: Side = r.left + r.width / 2 < c.left + c.width / 2 ? 'left' : 'right';
      setSide(next);
      savePref('chatSide', next);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Resize from the inner top corner/edges. `sx`: +1 when the handle is on the right edge, -1 on the left, 0 none;
   * `sy`: -1 for the top edge (the chat stays anchored to the bottom). */
  const startResize = (sx: number, sy: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = geo.width;
    const h0 = geo.height;
    let last = { w: w0, h: h0 };
    setResizing(true);
    const move = (ev: PointerEvent) => {
      last = {
        w: Math.round(Math.min(Math.max(w0 + sx * (ev.clientX - x0), MIN_W), maxW)),
        h: Math.round(Math.min(Math.max(h0 + sy * (ev.clientY - y0), MIN_H), maxH)),
      };
      setSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      savePref('chatSize', JSON.stringify(last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const inner = side === 'right' ? -1 : 1; // the inner side faces the middle of the screen

  const closeDoc = () => { setDoc(null); setPage(null); setChatFull(false); if (!look.cloud) setChatCollapsed(false); };
  const docsChanged = () => { docs.reload(); onChange(); };

  return (
    <div className="workspace">
      <LibraryPanel subject={subject} onOpen={openArtifact} />

      <section ref={center} className={`center${floating ? ' has-doc' : ''}`}>
        {showCloud && (
          <EmbeddingCloud className="cloud-pane" subjectId={subject.id} topics={subject.topics} title={`${subject.name} · knowledge map`}
            focus={focus} onFocus={setFocus} onOpenDoc={(id, label) => openDoc(id, label)} />
        )}
        {page !== null && !doc && (
          <div className="doc-pane"><ArtifactPage key={page} id={page} onClose={closeDoc} onCite={openCitation} /></div>
        )}
        {doc && (
          <div className="doc-pane">
            {doc.details ? (
              <DocumentView key={`details-${doc.nonce}`} id={doc.id} focus={doc.focus} onClose={closeDoc}
                onBack={() => setDoc({ ...doc, details: false, nonce: Date.now() })} />
            ) : (
              <SourceView key={doc.nonce} id={doc.id} focus={doc.focus} onClose={closeDoc}
                pulse={doc.pulse ? { unit: doc.pulse.unit, rect: doc.pulse.rect } : undefined}
                onDetails={() => setDoc({ ...doc, details: true })} onAsk={askAbout}
                onAttach={(paths) => { setIncoming({ paths, nonce: Date.now() }); setChatCollapsed(false); }} />
            )}
          </div>
        )}
        <div ref={shell} onPointerDown={startDrag}
          className={`chat-shell${floating ? ' floating' : ''}${collapsed ? ' collapsed' : ''}${full ? ' full' : ''}${drag ? ' dragging' : ''}${resizing ? ' resizing' : ''}`}
          style={{ ...geo, transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined, visibility: box.w ? undefined : 'hidden' }}>
          {floating && !collapsed && !full && (
            <>
              <div className="rz rz-top" onPointerDown={startResize(0, -1)} />
              <div className={`rz rz-side rz-${inner < 0 ? 'left' : 'right'}`} onPointerDown={startResize(inner, 0)} />
              <div className={`rz rz-corner rz-top-${inner < 0 ? 'left' : 'right'}`} title="Drag to resize" onPointerDown={startResize(inner, -1)} />
            </>
          )}
          <ChatView subject={subject} launch={launch} floating={floating} collapsed={collapsed} full={full}
            onToggleCollapse={() => setChatCollapsed(!chatCollapsed)} onToggleFull={() => setChatFull(!chatFull)}
            onCite={openCitation} onOpenArtifact={openArtifact} onOpenDoc={(id) => openDoc(id)} onShowArea={showArea}
            quote={quote} onClearQuote={() => setQuote(null)} incoming={incoming} />
        </div>
      </section>

      <ResourcePanel subject={subject} go={go} onChange={onChange} onOpenDoc={openDoc} onCreate={create}
        onDocsChanged={docs.reload} sel={{ focus, onFocus: setFocus, cloudVisible: showCloud, openId: doc?.id ?? null }} />

      {viewing !== null && <ArtifactViewer id={viewing} subject={subject} onClose={() => setViewing(null)} />}

      {fileDrag && (
        <FileDropOverlay topicCount={subject.topics.length} singleTopic={subject.topics.length === 1 ? subject.topics[0].name : undefined}
          onReference={(paths) => paths.length && setUpload({ title: `Add to the ${subject.name} reference library`, target: { subject_id: subject.id }, mode: 'all', paths })}
          onTopic={dropToTopic}
          onChat={(paths) => { if (paths.length) { setIncoming({ paths, nonce: Date.now() }); setChatCollapsed(false); } }} />
      )}
      {upload && (
        <UploadDialog title={upload.title} target={upload.target} defaultMode={upload.mode} initialPaths={upload.paths}
          onClose={() => setUpload(null)} onDone={docsChanged} />
      )}
      {assign && (
        <TopicAssignDialog subject={subject} paths={assign} onClose={() => setAssign(null)} onDone={docsChanged}
          defaultTopic={docs.data?.find((d) => d.kind === 'topic')?.topic_id ?? subject.topics[0].id} />
      )}
    </div>
  );
}
