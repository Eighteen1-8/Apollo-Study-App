/* The app's icons: one Lucide icon per meaning, so the same action always looks the same. Lucide is bundled (no
   network). Add a meaning here rather than importing a Lucide icon in a component, and never use a text symbol
   (▸ ⋯ ✦ …) as an icon. */
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, BookOpen, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleHelp, ClipboardCheck, Clock, Copy, Ellipsis, Eraser, Eye, FileImage, FileText, FolderOpen, FolderPlus, GraduationCap,
  Highlighter, History, Layers, Library, ListChecks, ListTodo, ListTree, LucideIcon, Maximize2, MessageSquare, Minus,
  MousePointer2, Network, NotebookPen, Orbit, Paperclip, Pause, PenLine, Pencil, Play, Plus, Scissors, ScrollText, Search,
  Sparkles, StickyNote, Type, Upload, X,
} from 'lucide-react';

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
  help: CircleHelp,
  image: FileImage,
  minus: Minus,
  more: Ellipsis,
  next: ArrowRight,
  note: StickyNote,
  pause: Pause,
  play: Play,
  send: ArrowUp,
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
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export default function Icon({ name, size = 16, className, strokeWidth = 2 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={strokeWidth} className={`icon${className ? ` ${className}` : ''}`} aria-hidden focusable={false} />;
}
