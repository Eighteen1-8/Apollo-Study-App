/* The app's icons: one Lucide icon per meaning, so the same action always looks the same. Lucide is bundled (no
   network). Add a meaning here rather than importing a Lucide icon in a component, and never use a text symbol
   (▸ ⋯ ✦ …) as an icon. */
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, BookOpen, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleHelp, ClipboardCheck, Clock, Copy, Ellipsis, Eraser, Eye, FileImage, FileText, FolderOpen, FolderPlus, GraduationCap,
  Highlighter, History, Layers, Library, ListChecks, ListTodo, ListTree, LucideIcon, Maximize2, MessageSquare, Minus,
  MousePointer2, Network, NotebookPen, Orbit, Paperclip, Pause, PenLine, Pencil, Play, Plus, Scissors, ScrollText, Search,
  Reply, Sparkles, StickyNote, Type, Upload, X, GripVertical, SquareDashed,
} from 'lucide-react';
// marking the student's own work, choosing pages (Make content)
import { FileCheck, SlidersHorizontal } from 'lucide-react';
// the student's mind maps and drawings (views/notes)
import {
  Brush, Circle, Diamond, Download, Grid3x3, Hand, MoveUpRight, RectangleHorizontal, Redo2, Slash, Square, Trash2, Undo2,
  Wand2, Workflow, ZoomIn, ZoomOut,
} from 'lucide-react';
// tools: the calculator and the study timer
import { ArrowDownToLine, Calculator, ChartSpline, Delete, RotateCcw, Table2, Timer } from 'lucide-react';
// the app pet's on/off button
import { Cat } from 'lucide-react';
// the viewer's simplified-layout note, a marking's score change against the previous version
import { Info as InfoCircle, TrendingDown, TrendingUp } from 'lucide-react';
// groups (folders) in the chat history
import { Folder } from 'lucide-react';

export const ICONS = {
  add: Plus,
  ask: Sparkles,
  attach: Paperclip,
  brain: Brain,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  close: X,
  copy: Copy,
  create: Sparkles,
  edit: Pencil,
  file: FileText,
  fit: Maximize2,
  folderNew: FolderPlus,
  chatGroup: Folder,
  help: CircleHelp,
  image: FileImage,
  minus: Minus,
  more: Ellipsis,
  next: ArrowRight,
  note: StickyNote,
  pause: Pause,
  play: Play,
  send: ArrowUp,
  reply: Reply,
  swap: ArrowLeftRight,
  topic: FolderOpen,
  textbook: Library,
  chat: MessageSquare,
  upload: Upload,
  wrong: X,
  // generated content, one per type
  flashcards: Layers,
  quiz: ListChecks,
  exam: ClipboardCheck,
  notes: NotebookPen,
  cheatsheet: ScrollText,
  mindmap: Network,
  marking: FileCheck,
  book: BookOpen,
  // the subject page and the document toolbar
  back: ArrowLeft,
  map: Orbit,
  study: GraduationCap,
  todo: ListTodo,
  history: History,
  clock: Clock,
  search: Search,
  chapters: ListTree,
  select: MousePointer2,
  highlight: Highlighter,
  pen: PenLine,
  eraser: Eraser,
  textbox: Type,
  snip: Scissors,
  show: Eye,
  region: SquareDashed,
  grip: GripVertical,
  advanced: SlidersHorizontal,
  // the student's mind maps and drawings (views/notes)
  noteMap: Workflow,
  drawing: Brush,
  undo: Undo2,
  redo: Redo2,
  trash: Trash2,
  tidy: Wand2,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  download: Download,
  pan: Hand,
  paper: Grid3x3,
  line: Slash,
  arrow: MoveUpRight,
  shapeBox: Square,
  shapeRounded: RectangleHorizontal,
  shapeDiamond: Diamond,
  shapeCircle: Circle,
  // tools: the calculator and the study timer
  calculator: Calculator,
  graph: ChartSpline,
  insert: ArrowDownToLine,
  backspace: Delete,
  reset: RotateCcw,
  timer: Timer,
  table: Table2,
  pet: Cat,
  info: InfoCircle,
  better: TrendingUp,
  worse: TrendingDown,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export default function Icon({ name, size = 16, className, strokeWidth = 2 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={strokeWidth} className={`icon${className ? ` ${className}` : ''}`} aria-hidden focusable={false} />;
}
