import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, AreaSource, DocRef, Quote, Subject, ToolName } from '../api';
import type { Route } from '../App';
import { usePoll } from '../hooks';
import EmbeddingCloud, { CloudFocus } from '../components/EmbeddingCloud';
import { FileDropOverlay, TopicAssignDialog } from '../components/FileDrop';
import { useOverlay } from '../components/overlay';
import { Empty } from '../components/ui';
import SideResizer, { SideLimits, SidePanel } from '../components/SideResizer';
import UploadDialog from '../components/UploadDialog';
import ChatView from './ChatView';
import DocumentView from './DocumentView';
import LibraryPanel from './LibraryPanel';
import ResourcePanel from './ResourcePanel';
import SourceView from './SourceView';
import ArtifactViewer, { ArtifactPage } from './ArtifactViewer';
import NoteEditor from './NoteEditor';
import ErrorBoundary from '../components/ErrorBoundary';
import { useAppearance } from '../theme';
import { getPref, setPref } from '../prefs';
import { isApplying, undoable } from '../undo';
import { currentView, registerWorkspace, showView, ViewSnap } from '../viewHistory';
import { SplitPane, snapOf, View, viewKey, viewReducer } from './subject/viewState';
import { useChatDock } from './subject/useChatDock';

type RouteSubject = Extract<Route, { name: 'subject' }>;
type Upload = { title: string; target: { topic_id?: number; subject_id?: number }; mode: 'auto' | 'all'; paths: string[] };
export type { SplitPane } from './subject/viewState';

export const CREATE_ITEMS: { tool: ToolName; label: string }[] = [
  { tool: 'create_flashcards', label: 'Flashcards' },
  { tool: 'create_quiz', label: 'Quiz' },
  { tool: 'create_exam', label: 'Exam (from a practice exam)' },
  { tool: 'create_notes', label: 'Full notes' },
  { tool: 'create_cheatsheet', label: 'Cheat sheet' },
  { tool: 'create_mindmap', label: 'Mind map' },
];

/** Normalise filenames for citation matching (Qwen sometimes drops the extension or changes case). */
const norm = (s: string) => s.toLowerCase().replace(/\.(pdf|pptx|docx|txt|md|png|jpe?g)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

const LEFT: SideLimits = { def: 250, min: 190, max: 460 };
const RIGHT: SideLimits = { def: 300, min: 230, max: 540 };
const CENTER_MIN = 380;
type Sides = { left: SidePanel; right: SidePanel };
const DEFAULT_SIDES: Sides = { left: { width: LEFT.def, open: true }, right: { width: RIGHT.def, open: true } };


/**
 * Subject workspace: generated-content library (left) · the subject's knowledge cloud, an open document, or the
 * chat (centre) · resources (right). The cloud is the default centre: sidebar clicks narrow it to a topic, folder or
 * file (see ResourcePanel). What the centre shows is one reducer (subject/viewState.ts); where the chat sits and
 * how it moves is subject/useChatDock.ts. Files dragged in from Explorer get a drop overlay: reference library,
 * topic, or this chat.
 */
export default function SubjectView({ route, subjects, go, onChange }: {
  route: RouteSubject; subjects: Subject[]; go: (r: Route) => void; onChange: () => void;
}) {
  const ov = useOverlay();
  const subject = subjects.find((s) => s.id === route.id);
  const [look] = useAppearance();
  // what the centre shows (document / page / second pane / chat full screen): one value, see subject/viewState.ts
  const [view, dispatch] = useReducer(viewReducer, route, (r): View => ({
    doc: r.view?.doc ? { ...r.view.doc, nonce: Date.now(), details: false } : null,
    page: r.view?.page ?? null, split: r.view?.split ?? null, chatFull: false,
  }));
  const { doc, page, split } = view;
  const [focus, setFocus] = useState<CloudFocus>(null);
  const [quote, setQuote] = useState<(Quote & { nonce: number }) | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [chatReq, setChatReq] = useState<{ id: number | null; nonce: number } | null>(null);
  const [activeChat, setActiveChat] = useState<number | null>(null);
  const [launch, setLaunch] = useState(route.launch);
  const [fileDrag, setFileDrag] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [assign, setAssign] = useState<string[] | null>(null);
  const [incoming, setIncoming] = useState<{ paths: string[]; nonce: number } | null>(null);
  const [sides, setSides] = useState<Sides>(() => getPref<Sides>('sides', DEFAULT_SIDES, (v) => ({ ...DEFAULT_SIDES, ...JSON.parse(v) })));
  const [sizing, setSizing] = useState(false);
  // split view: `splitFrac` = the first pane's share of the width
  const [splitFrac, setSplitFrac] = useState(() => getPref('splitFrac', 0.5, (v) => Math.min(0.8, Math.max(0.2, Number(v) || 0.5))));
  const [splitting, setSplitting] = useState(false);
  const panes = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const center = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const docs = usePoll(() => api.allDocuments(route.id), 2000, [route.id], ['documents']);

  const showCloud = look.cloud && !doc && page === null;
  const floating = !!doc || page !== null || showCloud;
  const setChatFull = useCallback((on: boolean) => dispatch({ type: 'chatFull', on }), []);
  // the cloud is what a subject opens to, so the chat starts as a pill unless a create form is waiting in it
  const dock = useChatDock({ center, shell, ready: !!subject, floating, chatFull: view.chatFull, setChatFull,
    startCollapsed: () => look.cloud && !route.launch && !route.open });
  const { chatCollapsed, setChatCollapsed, collapsed, full, halves, mode, geo, side, inner, box, drag, resizing, chatSizing,
    overReviews, dragOverReviews, startDrag, startResize, setMode, startChatSplitDrag } = dock;

  useEffect(() => { if (route.launch) setLaunch(route.launch); }, [route.launch]);

  // ---- what's showing, for undo/redo: every change of document / page / split pane is one step back
  const restoreView = useCallback((snap: ViewSnap) => dispatch({ type: 'restore', snap }), []);
  useEffect(() => registerWorkspace(route.id, restoreView), [route.id, restoreView]);
  const key = viewKey(view);
  const lastView = useRef<{ key: string; snap: ViewSnap } | null>(null);
  useEffect(() => {
    const snap = snapOf(view);
    currentView.set(route.id, snap);
    const prev = lastView.current;
    lastView.current = { key, snap };
    if (!prev || prev.key === key || isApplying()) return;
    const sid = route.id;
    undoable({ kind: 'nav', label: describeView(snap, prev.snap, docs.data ?? []), undo: () => showView(sid, prev.snap), redo: () => showView(sid, snap) });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const openDoc = useCallback((id: number, focus?: string, details = false) => dispatch({ type: 'doc', id, focus, details }), []);

  /** Notes, cheat sheets and mind maps open in the centre like a document; flashcards, quizzes and exams stay full screen. */
  const openArtifact = useCallback(async (id: number) => {
    const a = await api.artifact(id);
    if (a.type === 'notes' || a.type === 'cheatsheet' || a.type === 'mindmap') dispatch({ type: 'page', kind: 'artifact', id });
    else setViewing(id);
  }, []);

  /** The student's own notes open in the centre, in the editor. */
  const openNote = useCallback((id: number) => dispatch({ type: 'page', kind: 'note', id }), []);

  /** A chat picked in the left sidebar (null: a new one) opens in the chat panel. */
  const openChat = useCallback((id: number | null) => {
    setChatReq({ id, nonce: Date.now() });
    setChatCollapsed(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const attach = useCallback((paths: string[]) => { setIncoming({ paths, nonce: Date.now() }); setChatCollapsed(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** A screenshot in the chat: open its document at the area it came from and outline it briefly. */
  const showArea = useCallback((s: AreaSource) => dispatch({ type: 'doc', id: s.document_id, pulse: s }), []);

  const openCitation = useCallback((file: string, label: string) => {
    const list: DocRef[] = docs.data ?? [];
    const f = norm(file);
    const d = list.find((x) => norm(x.filename) === f) ?? list.find((x) => norm(x.filename).startsWith(f) || f.startsWith(norm(x.filename)));
    if (d) openDoc(d.id, label);
  }, [docs.data, openDoc]);

  const askAbout = useCallback((q: Quote) => {
    setQuote({ ...q, nonce: Date.now() });
    setChatCollapsed(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Something picked in the Ctrl+K palette (or a route that names what to open).
  const handledOpen = useRef<number | null>(null);
  useEffect(() => {
    const o = route.open;
    if (!o || handledOpen.current === o.nonce || !subject) return;
    handledOpen.current = o.nonce;
    if (o.kind === 'doc') openDoc(o.id);
    else if (o.kind === 'artifact') openArtifact(o.id);
    else if (o.kind === 'note') openNote(o.id);
    else if (o.kind === 'chat') openChat(o.id < 0 ? null : o.id); // -1: a new chat
    else if (o.kind === 'topic') {
      const t = subject.topics.find((x) => x.id === o.id);
      if (t) { dispatch({ type: 'clear' }); setFocus({ kind: 'topic', id: t.id, name: t.name }); }
    }
  }, [route.open?.nonce, !!subject]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** Sidebar widths are shared by every subject. */
  const sideProps = (which: 'left' | 'right') => {
    const other = which === 'left' ? sides.right : sides.left;
    return {
      side: which, panel: sides[which], limits: which === 'left' ? LEFT : RIGHT, onSizing: setSizing,
      room: () => (workspace.current?.clientWidth ?? 1600) - (other.open ? other.width : 0) - CENTER_MIN,
      onChange: (p: SidePanel) => setSides((s) => ({ ...s, [which]: p })),
      onCommit: (p: SidePanel) => setSides((s) => { const n = { ...s, [which]: p }; setPref('sides', JSON.stringify(n)); return n; }),
    };
  };

  /** Show something beside what's open. With nothing open it just opens; flashcards, quizzes and exams (full
   * screen) can't go in a pane. */
  const openSplit = async (kind: SplitPane['kind'], id: number) => {
    if (kind === 'artifact') {
      const a = await api.artifact(id);
      if (a.type !== 'notes' && a.type !== 'cheatsheet' && a.type !== 'mindmap') return setViewing(id);
    }
    const primary = !!doc || page !== null;
    if (!primary) return kind === 'doc' ? openDoc(id) : kind === 'note' ? openNote(id) : openArtifact(id);
    dispatch({ type: 'split', pane: { kind, id } });
  };
  const swapPanes = () => dispatch({ type: 'swap' });
  const closeSplit = () => dispatch({ type: 'closeSplit' });
  /** Closing the first pane while split: the second takes its place. */
  const closeDoc = () => {
    dispatch({ type: 'closePrimary' });
    if (!split && !look.cloud) setChatCollapsed(false);
  };
  const startSplitDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    const box = panes.current?.getBoundingClientRect();
    if (!box) return;
    let last = splitFrac;
    setSplitting(true);
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => {
      last = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width));
      setSplitFrac(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
      setSplitting(false);
      setPref('splitFrac', String(last));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const docsChanged = () => { docs.reload(); onChange(); };

  return (
    <div ref={workspace} className={`workspace${sizing ? ' sizing' : ''}${sides.left.open ? '' : ' left-folded'}${sides.right.open ? '' : ' right-folded'}`}
      style={{ '--left-w': `${sides.left.open ? sides.left.width : 0}px`, '--right-w': `${sides.right.open ? sides.right.width : 0}px` } as React.CSSProperties}>
      <ErrorBoundary name="Generated content" compact><LibraryPanel subject={subject} onOpen={openArtifact}
        onOpenSplit={(id) => openSplit('artifact', id)}
        chats={{ activeId: activeChat, onOpen: openChat, onNew: () => openChat(null) }} /></ErrorBoundary>
      <SideResizer {...sideProps('left')} />
      <SideResizer {...sideProps('right')} />

      <section ref={center} style={halves ? { '--chat-w': `${geo.width}px` } as React.CSSProperties : undefined}
        className={`center${floating ? ' has-doc' : ''}${halves ? ` chat-halves chat-halves-${side}` : ''}${chatSizing ? ' chat-sizing' : ''}${dragOverReviews ? ' chat-drop-reviews' : ''}`}>
        {showCloud && (
          <EmbeddingCloud className="cloud-pane" subjectId={subject.id} topics={subject.topics} title={`${subject.name} · knowledge map`}
            focus={focus} onFocus={setFocus} onOpenDoc={(id, label) => openDoc(id, label)} />
        )}
        {(doc || page !== null) && (
          <div ref={panes} className={`center-panes${split ? ' is-split' : ''}${splitting ? ' splitting' : ''}`}>
            <div className="pane-slot" style={split ? { flexBasis: `${splitFrac * 100}%` } : undefined}>
              {page !== null && !doc && (
                <div className="doc-pane">
                  <ErrorBoundary name="These notes" resetKey={`${page.kind}${page.id}`} onClose={closeDoc}>
                    {page.kind === 'note'
                      ? <NoteEditor key={`n${page.id}`} id={page.id} subject={subject} onClose={closeDoc} onAsk={askAbout} onAttach={attach} />
                      : <ArtifactPage key={`a${page.id}`} id={page.id} onClose={closeDoc} onCite={openCitation} onAsk={askAbout} onAttach={attach} />}
                  </ErrorBoundary>
                </div>
              )}
              {doc && (
                <div className="doc-pane"><ErrorBoundary name="The document viewer" resetKey={doc.nonce} onClose={closeDoc}>
                  {doc.details ? (
                    <DocumentView key={`details-${doc.nonce}`} id={doc.id} focus={doc.focus} onClose={closeDoc}
                      onBack={() => dispatch({ type: 'details', on: false })} />
                  ) : (
                    <SourceView key={doc.nonce} id={doc.id} focus={doc.focus} onClose={closeDoc}
                      pulse={doc.pulse ? { unit: doc.pulse.unit, rect: doc.pulse.rect } : undefined}
                      onDetails={() => dispatch({ type: 'details', on: true })} onAsk={askAbout}
                      onAttach={attach} />
                  )}
                </ErrorBoundary></div>
              )}
            </div>
            {split && (
              <>
                <div className="pane-divider" role="separator" aria-orientation="vertical" aria-label="Resize split view"
                  onPointerDown={startSplitDrag}
                  onDoubleClick={() => { setSplitFrac(0.5); setPref('splitFrac', '0.5'); }}
                  data-tip="Drag to resize · double-click for half and half">
                  <button className="pane-swap" data-tip="Swap sides" onClick={swapPanes}>⇄</button>
                </div>
                <div className="pane-slot pane-second">
                  <div className="doc-pane">
                    <ErrorBoundary name="This pane" resetKey={split.nonce} onClose={closeSplit}>
                      {split.kind === 'note'
                        ? <NoteEditor key={`sn${split.id}`} id={split.id} subject={subject} onClose={closeSplit} onAsk={askAbout} onAttach={attach} />
                        : split.kind === 'artifact'
                          ? <ArtifactPage key={`sa${split.id}`} id={split.id} onClose={closeSplit} onCite={openCitation} onAsk={askAbout} onAttach={attach} />
                          : <SourceView key={split.nonce} id={split.id} onClose={closeSplit} onAsk={askAbout} onAttach={attach}
                            onDetails={() => openDoc(split.id, undefined, true)} />}
                    </ErrorBoundary>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {halves && (
          <div className="chat-split-divider" role="separator" aria-orientation="vertical" aria-label="Resize the chat"
            style={{ left: side === 'right' ? geo.left - 5 : geo.width - 5 }} onPointerDown={startChatSplitDrag}
            onDoubleClick={dock.halfAndHalf} data-tip="Drag to resize · double-click for half and half" />
        )}
        <div ref={shell} onPointerDown={startDrag}
          className={`chat-shell dock-${side}${floating ? ' floating' : ''}${halves ? ' halves' : ''}${collapsed ? ' collapsed' : ''}${full ? ' full' : ''}${drag ? ' dragging' : ''}${resizing || chatSizing ? ' resizing' : ''}${overReviews ? ' over-reviews' : ''}`}
          style={{ ...geo, transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined, visibility: box.w ? undefined : 'hidden' }}>
          {floating && !collapsed && !full && !halves && (
            <>
              <div className="rz rz-top" onPointerDown={startResize(0, -1)} />
              <div className={`rz rz-side rz-${inner < 0 ? 'left' : 'right'}`} onPointerDown={startResize(inner, 0)} />
              <div className={`rz rz-corner rz-top-${inner < 0 ? 'left' : 'right'}`} title="Drag to resize" onPointerDown={startResize(inner, -1)} />
            </>
          )}
          <ErrorBoundary name="The chat" compact><ChatView subject={subject} launch={launch} floating={floating} collapsed={collapsed} mode={mode} onMode={setMode} sideBySide={dock.chatSplit}
            onToggleCollapse={() => setChatCollapsed(!chatCollapsed)}
            onCite={openCitation} onOpenArtifact={openArtifact} onOpenDoc={(id) => openDoc(id)} onShowArea={showArea} onOpenNote={openNote}
            quote={quote} onClearQuote={() => setQuote(null)} incoming={incoming} openRequest={chatReq} onActiveChat={setActiveChat} /></ErrorBoundary>
        </div>
      </section>

      <ErrorBoundary name="Resources" compact><ResourcePanel subject={subject} go={go} onChange={onChange} onOpenDoc={openDoc} onCreate={create}
        onDocsChanged={docs.reload} sel={{ focus, onFocus: setFocus, cloudVisible: showCloud, openId: doc?.id ?? null }}
        notes={{ openId: page?.kind === 'note' && !doc ? page.id : null, onOpen: openNote }}
        onOpenSplit={openSplit} /></ErrorBoundary>

      {viewing !== null && (
        <ErrorBoundary name="This study set" resetKey={viewing} onClose={() => setViewing(null)}><ArtifactViewer id={viewing} subject={subject} onClose={() => setViewing(null)} /></ErrorBoundary>
      )}

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

/** "open ‘Lecture 3.pdf’" / "close a note": what a change of view did, for the undo button's tooltip. */
function describeView(now: ViewSnap, before: ViewSnap, docs: DocRef[]) {
  const fileName = (id: number) => docs.find((d) => d.id === id)?.filename;
  const name = (v: ViewSnap) => (v.doc ? (fileName(v.doc.id) ? `‘${fileName(v.doc.id)}’` : 'a file')
    : v.page ? (v.page.kind === 'note' ? 'a note' : 'generated content') : null);
  if (now.split && (!before.split || before.split.id !== now.split.id)) return 'open side by side';
  if (!now.split && before.split && name(now) === name(before)) return 'close side by side';
  const n = name(now);
  return n ? `open ${n}` : `close ${name(before) ?? 'the view'}`;
}
