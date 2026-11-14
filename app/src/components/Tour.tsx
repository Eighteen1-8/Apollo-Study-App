/* Tours: tips that each light up the part of the screen they're about.
   - `app`: the subject page, area by area. It starts after the setup steps (the `tourPending` pref) the first time a
     subject is open.
   - deeper tours of the subject page's panels: `files` (the right sidebar's files), `mynotes` (My notes), `library`
     (the left sidebar: chats and study material), `studysheet` (Start studying), `make` (Make content) and `minibar`
     (the bar on the far left).
   - one per feature (notes, mind maps, drawings, the file viewer, the chat, each kind of study material including
     marking, the calculator).
   `useFirstTime(id, ready)` in a feature's component starts its tour once, the first time that feature is on screen
   and `ready` (pref `tourSeen.<id>`), and its `<TourButton id>` (a ?) replays it. The help window lists every tour by
   group (`TourList`).
   A tour never starts by itself while the setup steps, a dialog, a menu or another tour is showing, within a few
   seconds of another tour closing, or under automation (navigator.webdriver: the end-to-end tests). Steps whose part of
   the screen isn't showing are skipped. Opened from the help window while the feature isn't on screen, it shows all its
   tips in the middle instead.

   Adding a tour: add an entry to TOURS (its id becomes a TourId), then put `useFirstTime('<id>', ready)` and
   `<TourButton id="<id>" />` in the feature. `at` is a CSS selector list; the first match that's showing is lit up.
   Words follow terms.ts's plain words (standard mode) and backend/studyapp/about.py. */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getPref, setPref } from '../prefs';
import Icon from './Icon';

export interface TourStep {
  /** What to light up (CSS selectors, first match that's showing wins). No `at`: the tip shows in the middle. */
  at?: string;
  title: string;
  body: string;
}
/** The help window's headings, in this order. */
export const TOUR_GROUPS = ['Getting around', 'Reading and asking', 'Study material', 'Your own notes', 'Tools'] as const;
type TourGroup = typeof TOUR_GROUPS[number];
interface TourDef {
  /** The name in the help window's list. */
  title: string;
  /** Where to go to see it on screen ("a note"), said when it's replayed from elsewhere. */
  where: string;
  group: TourGroup;
  /** It's about the subject page: the help window opens a subject first if none is showing. */
  onSubject?: boolean;
  steps: TourStep[];
}

const TOURS_DEF = {
  /* ---------------------------------------------------------------- the subject page and its panels */
  app: {
    title: 'The subject page', where: 'a subject', group: 'Getting around', onSubject: true,
    steps: [
      { title: 'Welcome to your subject', body: 'This is where you study one subject. On the left is everything you and Apollo have made, in the middle is where you study, and on the right are your files and your own notes. Use Next or the arrow keys to go through these tips; Esc closes them.' },
      { at: '.side-right .side-head', title: 'Your subject', body: 'The subject’s name. The ⋯ button (or a right-click) adds topics, files or textbooks, shares the subject as a study pack, or renames it.' },
      { at: '.side-right .file-search', title: 'Search your files', body: 'Finds files by name and passages inside them. Ctrl+Shift+F jumps here from anywhere.' },
      { at: '.side-right .side-add-btn, .side-right .res-books', title: 'Add your material', body: 'Add files asks what you’re adding: lecture slides and notes go into a topic, a textbook goes into Textbooks for the whole subject, or a file can go with just one question. You can also drag files from File Explorer into the window.' },
      { at: '.side-right .topics-section, .side-right .res-books', title: 'Textbooks and topics', body: 'Textbooks are for the whole subject: Apollo looks things up in them for every question. Topics hold one part of the subject, like a chapter or a week. Click a topic to show its files, and click a file to open it.' },
      { at: '.side-right .my-notes', title: 'My notes', body: 'Your own notes, mind maps and drawings. Apollo never treats them as study material, but it can check them against your files. The ? on My notes shows every option.' },
      { at: '.side-left .chat-history', title: 'Your chats', body: 'Every conversation with Apollo in this subject, newest first. + starts a new one, and a dot marks a reply you haven’t read yet.' },
      { at: '.side-left .side-head-sub, .side-left .lib-scroll', title: 'Your study material', body: 'Flashcards, quizzes, practice exams, study notes, cheat sheets, mind maps and markings Apollo made for you, grouped by kind. Make starts something new.' },
      { at: '.getting-started .gs-card', title: 'Getting started', body: 'Three steps to set up the subject: make a topic, add your material, then study with Apollo. This gives way to the knowledge map once your first file is in.' },
      { at: '.start-studying .start-btn', title: 'Start studying', body: 'Opens the study panel: ask Apollo a question, pick up where you left off, keep a to-do list, and make flashcards, quizzes, exams, notes and more.' },
      { at: '.center .map-unlock, .center .cloud-pane', title: 'The knowledge map', body: 'Every dot is a passage from your files, and similar ideas sit close together. Press to explore the map to turn and zoom it and click a dot to open that passage. Clicking a topic or file on the right narrows the map to it.' },
      { at: '.chat-shell:not(.tucked)', title: 'The chat', body: 'Apollo’s chat. It floats over whatever is open; drag its top bar to move it, or put it side by side with what’s open or full screen.' },
      { at: '.minibar .mini-bottom', title: 'Tools on the left bar', body: 'Search everything (Ctrl+K), undo and redo, the study timer, the cat, a light that shows whether Apollo’s models are ready, what Apollo is working on in the background, help and Settings.' },
      { at: '.mini-help', title: 'Help is always here', body: 'The ? lists every shortcut and every tour. Each panel also has its own ? with a closer look: your files, My notes, the study panel, the chat and more.' },
    ],
  },
  files: {
    title: 'Your files', where: 'a subject (the right sidebar)', group: 'Getting around', onSubject: true,
    steps: [
      { at: '.side-right .side-head', title: 'Subject options', body: 'The ⋯ button or a right-click: new topic, add files, add a textbook, export or share the subject as a study pack, rename it or delete it.' },
      { at: '.side-right .file-search', title: 'Search your files', body: 'Type to find files by name, then passages inside them. Click a result to open the file at that spot with the words found. Esc clears the search.' },
      { at: '.side-right .side-add-btn', title: 'Add files', body: 'Asks what you’re adding: lecture slides, notes or handouts go into a topic; a textbook goes into Textbooks; “Just for one question” goes with your next chat message and isn’t saved. PDF, PowerPoint, Word, pictures and text files all work.' },
      { at: '.side-right .res-books', title: 'Textbooks', body: 'Whole textbooks and references for the entire subject. Apollo looks up the relevant pages for every question and trusts them most. + adds one; click the row to show or hide them.' },
      { at: '.side-right .topics-section', title: 'Topics', body: 'A topic holds the material for one part of the subject, like a chapter or a week, and what Apollo makes from it. + makes a new topic, and you can drag topics to put them in order.' },
      { at: '.side-right .topic .topic-actions', title: 'A topic’s buttons', body: 'Add puts files into this topic, and Create makes study material from just this topic. ⋯ (or right-clicking the topic) also has New folder, Rename and Delete topic.' },
      { at: '.side-right .folder-row', title: 'Folders', body: 'Folders keep a topic’s list tidy, like “Week 1 lectures”. Drag files onto a folder to file them. They only sort the sidebar; Apollo reads the topic the same either way.' },
      { at: '.side-right .file', title: 'Your files', body: 'Click a file to open it. A progress bar means Apollo is still reading it. Drag a file onto the chat to ask about it, onto another topic to move it, or into the middle to open it beside what’s showing.' },
      { at: '.side-right .file .file-more', title: 'File options', body: 'The ⋯ button or a right-click: open it side by side, see what Apollo extracted, read its pictures and diagrams, process it again, move it into a folder, or remove it.' },
      { at: '.side-right .topics-section', title: 'Several at once', body: 'Shift-click or Ctrl-click files and folders to select several. Drag them together, or use the bar that appears to move or delete them. Esc clears the selection.' },
      { at: '.side-right .file .file-x', title: 'Removing is safe', body: 'A removed file waits in the trash for a week: Undo (in the message that appears, or Ctrl+Z) brings it back without reading it again. Deleting a whole topic or subject is permanent, so Apollo asks first.' },
    ],
  },
  mynotes: {
    title: 'My notes', where: 'a subject (bottom of the right sidebar)', group: 'Your own notes', onSubject: true,
    steps: [
      { at: '.side-right .my-notes', title: 'Your own notes', body: 'Notes you write for this subject. They’re yours: Apollo never adds them to the material it answers from (they might have mistakes in them), but it reads one when you ask it to and can check it against your files.' },
      { at: '.side-right .my-notes-new', title: 'Three kinds', body: '+ makes a Note (a document with headings, colours, highlights, tables and pictures), a Mind map / flowchart (boxes joined by arrows), or a Drawing (pen, shapes and text on plain, grid or lined paper).' },
      { at: '.side-right .note-item, .side-right .my-notes-empty, .side-right .my-notes', title: 'Open one', body: 'Click a note to open it in the middle. Its icon shows the kind, and below its name is when it last changed and its topic. Everything saves as you go.' },
      { at: '.side-right .note-item, .side-right .my-notes', title: 'Beside your files', body: 'Drag a note into the middle to put it next to a file, or right-click it and choose Open side by side, so you can write while you read.' },
      { at: '.side-right .note-item, .side-right .my-notes', title: 'Check with Apollo', body: 'Right-click → Check with Apollo: it compares the note with your files and gives a short verdict and only the mistakes that matter, each with a fix and a link to the page it relies on. Its comments open beside the note.' },
      { at: '.side-right .note-item, .side-right .my-notes', title: 'Ask Apollo to change it', body: 'For a written note, right-click → Ask Apollo to change it and say what you want, like “add the missing definitions”. Apollo suggests new text in Comments; nothing changes until you apply it, and Undo takes it back. Mind maps and drawings can be checked but not rewritten.' },
      { at: '.side-right .note-item, .side-right .my-notes', title: 'Export, rename, delete', body: 'The right-click menu also exports to Word or PDF (mind maps and drawings as a picture too), renames, and deletes. A deleted note comes back with Undo for a week.' },
      { at: '.side-right .my-notes-title', title: 'Fold it away', body: 'Click My notes to fold the list. Drag the line above it to give your notes more or less room.' },
      { title: 'Add to a note from anywhere', body: 'Select text in a file and choose Add to notes, use Add to my notes on part of Apollo’s answer, or Insert in the calculator. It goes into the open note where your cursor was, or you pick one of your notes (or a new one).' },
    ],
  },
  library: {
    title: 'Chats and study material', where: 'a subject (the left sidebar)', group: 'Getting around', onSubject: true,
    steps: [
      { at: '.side-left .chat-history', title: 'Your chats', body: 'Every conversation with Apollo in this subject, grouped by when you last used it. Click one to open it; each chat remembers its own topic and history.' },
      { at: '.side-left .chat-history [data-tip="New chat"]', title: 'New chat', body: 'Starts a fresh conversation. When a chat gets long, a new one keeps Apollo’s answers sharp.' },
      { at: '.side-left .chat-group-add', title: 'Chat groups', body: 'Make a group to keep related chats together, like everything for one assignment. Drag a chat onto a group, or right-click it and choose Move to group.' },
      { at: '.side-left .chat-group-head, .side-left .chat-group', title: 'A group', body: 'Click a group’s heading to fold or open it. Right-click it to rename it or delete it; deleting a group keeps its chats.' },
      { at: '.side-left .ch-item', title: 'Chat options', body: 'Right-click a chat to rename it, let Apollo name it, move it to a group, or delete it. A spinner means Apollo is replying there; a dot means a reply you haven’t read. Ctrl-click or Shift-click to select several.' },
      { at: '.side-left .ch-search', title: 'Search chats', body: 'Finds a chat by its name.' },
      { at: '.side-left .lib-create', title: 'Make something', body: 'Opens the steps to make flashcards, a quiz, a practice exam, study notes, a cheat sheet or a mind map, or to have Apollo mark your own work.' },
      { at: '.side-left .lib-starters', title: 'Nothing here yet', body: 'Pick a kind to start. What Apollo makes is kept here, grouped by kind.' },
      { at: '.side-left .lib-making', title: 'Being made', body: 'Apollo makes one thing at a time, in order, with a progress bar. Keep studying meanwhile: each one moves into its group when it’s ready.' },
      { at: '.side-left .lib-kind', title: 'Grouped by kind', body: 'One card per kind; click its heading to fold it. Flashcards, quizzes and exams open full screen; notes, cheat sheets, mind maps and markings open in the middle, so you can drag them there beside a file.' },
      { at: '.side-left .lib-item-wrap .lib-more, .side-left .lib-kind', title: 'Options', body: 'The ⋯ button or a right-click: open side by side, export notes, cheat sheets, exams (with or without answers) and markings to Word or PDF, Regenerate, rename or delete. Undo brings deleted content back for a week.' },
      { at: '.side-left .lib-failed', title: 'If something fails', body: 'Try again carries on from the parts already finished, so nothing is made twice.' },
    ],
  },
  studysheet: {
    title: 'The study panel', where: 'Start studying on a subject', group: 'Getting around', onSubject: true,
    steps: [
      { at: '.study-sheet.open .study-ask', title: 'Ask Apollo', body: 'Type a question and press Enter: the chat grows out of this box and Apollo answers from your files. The grey text cycles through example questions written for this subject.' },
      { at: '.study-sheet.open .study-ask-row', title: 'Commands and files', body: 'Type / for commands, like /todo to add a to-do or /calc for the calculator. Drag a file from the right sidebar onto this box to ask about just that file.' },
      { at: '.study-sheet.open .study-ideas', title: 'Quick starts', body: 'One click sends a ready-made request, like a quick quiz or what to revise first.' },
      { at: '.study-sheet.open .study-continue', title: 'Continue where you left off', body: 'Your latest study material and your last chat, one click away.' },
      { at: '.study-sheet.open .study-todos', title: 'Revision to-do list', body: 'Type a to-do and press Enter, tick it off when it’s done (ticked ones fold under Completed), drag to reorder, and right-click to edit. Ask Apollo to plan your revision and it adds to-dos here too.' },
      { at: '.study-sheet.open .study-makers', title: 'Make content', body: 'Pick a kind and Apollo makes it from your files in the background. It appears on the left when it’s ready.' },
      { at: '.study-sheet.open .sheet-handle', title: 'Back to the map', body: 'The arrow (or Esc) hides this panel and shows the knowledge map again.' },
    ],
  },
  make: {
    title: 'Making study material', where: 'Make content (the Make button on the left)', group: 'Study material', onSubject: true,
    steps: [
      { at: '.study-sheet.open .make-steps', title: 'Three steps', body: 'What to make, which material to make it from, then a few choices. Back returns to the step before; nothing starts until the last one.' },
      { at: '.study-sheet.open .make-types, .study-sheet.open .make-body', title: 'What to make', body: 'Flashcards, a quiz, a practice exam (copying the layout of one you were given), study notes, a cheat sheet, a mind map, or Marking, where Apollo marks your own work.' },
      { at: '.study-sheet.open .make-body', title: 'Which material', body: 'Everything in the subject, one topic, or just the file you started from. Extra files added here are used for this one request only, and the instructions box tells Apollo anything else, like “focus on worked examples”.' },
      { at: '.study-sheet.open .make-body', title: 'The choices', body: 'How many cards or questions, and anything to focus on. Advanced lets you pick exact pages or slides (say, slides 10 to 20) and, for a quiz, the difficulty and kinds of question.' },
      { at: '.study-sheet.open .make-foot', title: 'Off it goes', body: 'Apollo works in the background, so you can keep studying. It shows under Being made on the left, then moves into its group when it’s ready.' },
    ],
  },
  minibar: {
    title: 'The left bar', where: 'the bar on the far left', group: 'Tools',
    steps: [
      { at: '.minibar .mini-home', title: 'All subjects', body: 'The home page, with every subject and the knowledge map of all your files.' },
      { at: '.minibar .mini-subjects', title: 'Your subjects', body: 'One tile per subject: click to open it, drag to reorder, and right-click for New topic, Export / share, Rename, Icon and colour, or Delete. + makes a new subject.' },
      { at: '.minibar .mini-search', title: 'Go anywhere', body: 'Searches subjects, topics, files, chats, study material and notes, and opens what you pick. Ctrl+K does the same.' },
      { at: '.minibar .mini-history', title: 'Undo and redo', body: 'Deletes, renames, moves and what you opened can be undone (Ctrl+Z) or redone (Ctrl+Y). Hover to see what the next undo will do.' },
      { at: '.minibar .mini-timer', title: 'Study timer', body: 'Click it, set the minutes with − and + (Shift for one minute), then start. 25 / 5 and 50 / 10 run focus and break rounds. It keeps counting when Apollo is closed, and adds up today’s focus sessions.' },
      { at: '.minibar .mini-pet', title: 'The cat', body: 'An optional cat that shows what Apollo is doing: reading files, writing, replying, paused, or that something went wrong. Click it to see what’s happening; right-click to reset or hide it.' },
      { at: '.minibar .mini-online', title: 'Online models', body: 'This globe shows while online models are on: what they use leaves your computer. Click it to open Settings.' },
      { at: '.minibar .mini-light', title: 'Ready light', body: 'Green when Apollo and search are ready, amber while one is paused, red when one can’t be reached. Click it to open Settings and test the connections.' },
      { at: '.minibar .jobs-v', title: 'Activity', body: 'Everything Apollo is doing in the background: reading files, making study material, marking. Open it to see progress, cancel something, run it next, or pause Apollo or search for a while.' },
      { at: '.minibar .mini-help', title: 'Help', body: 'Every shortcut and mouse gesture, every tour, setting up the models again, and what the error codes mean.' },
      { at: '.minibar .mini-settings', title: 'Settings', body: 'How Apollo answers (Chat tutor), Standard or Advanced mode, themes and how Apollo looks, the models it uses, and sharing study packs.' },
    ],
  },

  /* ---------------------------------------------------------------- reading and asking */
  viewer: {
    title: 'Reading a file', where: 'one of your files', group: 'Reading and asking',
    steps: [
      { at: '.doc-pane .source-scroll, .source .source-scroll', title: 'Your file', body: 'It looks just like the original. Scroll through it; Ctrl+F finds words anywhere in the file.' },
      { at: '.source-head .page-box', title: 'Jump to a page', body: 'Type a page or slide number and press Enter.' },
      { at: '.doc-pane .source-scroll, .source .source-scroll', title: 'Select some text', body: 'A small box appears: Define this, Ask Apollo about this, Add to notes (or drag its grip into a note), a highlight colour, or a note on that text. Right-click shows the same and more.' },
      { at: '.source-tools .tools', title: 'Mark it up', body: 'Highlight, draw, write text or stick notes right on the page. Each tool has a key: V select, H highlight, P pen, E eraser, T text, N note. Your marks are yours: Apollo never reads them as material.' },
      { at: '.source-tools [data-tip^="Snip"]', title: 'Snip', body: 'Drag a box over part of a page to send it to the chat as a picture, or to pin a note to it. Right-dragging does the same with any tool.' },
      { at: '.source-tools [data-tip^="Find words"]', title: 'Find', body: 'Finds words on every page of the file (Ctrl+F). Chapters, when the file has them, jumps to a section.' },
      { at: '.source-tools .rail-toggle', title: 'Your highlights and notes', body: 'Everything you’ve marked on this file is listed here. Click one to jump to it; a PDF can also be exported with your marks on it.' },
      { at: '.source .minimap, .source .mm-open', title: 'Minimap', body: 'A small map of the whole file at the side shows where you are and where your marks are. Click or drag on it to move around.' },
      { at: '.source-tools .zoom', title: 'Zoom', body: 'Make the pages bigger or smaller; click the percentage to go back to normal.' },
      { at: '.source-tools .tool-calc', title: 'Calculator', body: 'A calculator and graphing tool that floats over the page. It stays open when you switch files.' },
      { at: '.source-head .source-make', title: 'Study from this file', body: 'Make flashcards, a quiz, notes and more from just this file.' },
    ],
  },
  chat: {
    title: 'Chatting with Apollo', where: 'the chat', group: 'Reading and asking',
    steps: [
      { at: '.chat .composer-input, .chat .composer', title: 'Ask Apollo', body: 'Ask anything about your material: Enter sends, Shift+Enter starts a new line. Apollo answers from your files and says where each point came from; click a source to open that page.' },
      { at: '.chat .composer-bar', title: 'What Apollo uses', body: '“Using” picks which topic Apollo answers from, or all of them. Apollo searches further through your files by itself when it needs to.' },
      { at: '.chat .reasoning-btn', title: 'Thinking', body: 'How long Apollo thinks before it answers. Off is fastest; higher levels are slower but better for hard questions.' },
      { at: '.chat .attach-btn', title: 'Attach a file', body: 'Sends a file with one message without adding it to your library. To ask about one of your own files, drag it from the sidebar onto the chat.' },
      { at: '.chat .composer-bar', title: 'Make from the chat', body: 'Create (or the buttons under the box) makes flashcards, a quiz, an exam, notes, a cheat sheet or a mind map. Or just ask, like “a quiz on slides 10 to 20 of Lecture 3”: Apollo shows a short form to check first, then a card follows its progress.' },
      { at: '.chat .chat-scroll', title: 'Reply to part of an answer', body: 'Select part of one of Apollo’s answers to reply to just that part, have it explained, or add it to your notes. You can also edit a question, regenerate an answer, or go back to an earlier message.' },
      { at: '.chat .ctx-meter', title: 'Chat memory', body: 'This ring fills as the chat gets longer. When it’s nearly full, start a new chat so Apollo keeps up with what you’re asking.' },
      { at: '.chat .send-btn', title: 'Stop', body: 'While Apollo writes, this button becomes Stop (Esc does the same); what’s written so far is kept. Replies keep going if you switch to another chat.' },
      { at: '.chat .chat-title-btn', title: 'Your chats', body: 'Switch to an earlier chat here. The + next to it starts a new one, and every chat is also in the left sidebar.' },
      { at: '.chat .chat-head .head-tool, .chat .chat-head', title: 'More room', body: 'Put the chat side by side with what’s open, or make it full screen. Drag the top bar to move a floating chat, and its corner to resize it.' },
      { at: '.chat .composer-input, .chat .composer', title: 'Commands', body: 'Type / for commands that run straight away, like /todo, /calc, /graph, /new or /rename. They’re never sent to Apollo.' },
    ],
  },

  /* ---------------------------------------------------------------- study material */
  flashcards: {
    title: 'Flashcards', where: 'a set of flashcards', group: 'Study material',
    steps: [
      { at: '.fullscreen .flashcard', title: 'Flip the card', body: 'Try to answer, then click the card or press Space to see the back.' },
      { at: '.fullscreen .fc-rate', title: 'Be honest', body: 'Got it (key 1) or Practise again (key 2). Apollo keeps the cards you find hard in mind when you chat with it.' },
      { at: '.fullscreen .viewer-nav', title: 'Through the deck', body: 'Next and Previous, or the arrow keys. At the end of a round you can go over just the cards you missed.' },
      { at: '.fullscreen .fc-bar', title: 'Your deck', body: 'Shuffle, study only the cards to practise, delete a card you don’t need, or see the whole deck as a list.' },
    ],
  },
  quiz: {
    title: 'Quizzes', where: 'a quiz', group: 'Study material',
    steps: [
      { at: '.fullscreen .options', title: 'Pick an answer', body: 'Click an option, or press its letter.' },
      { at: '.fullscreen .quiz-actions', title: 'Check, then move on', body: 'Check answer (or Enter) shows whether you were right, why, and where it comes from in your files. Enter again goes to the next question.' },
      { at: '.fullscreen .quiz-steps', title: 'How you’re going', body: 'One mark per question, green or red once it’s checked.' },
      { title: 'At the end', body: 'You get your score and can retry just the ones you missed. Apollo can also review your answers and add what to revise to your to-do list.' },
    ],
  },
  exam: {
    title: 'Practice exams', where: 'a practice exam', group: 'Study material',
    steps: [
      { at: '.fullscreen .exam-meta', title: 'Like the real thing', body: 'This exam follows your practice exam’s parts, marks and time. Tick Show answers to see model answers as you go.' },
      { at: '.fullscreen .exam-q', title: 'Answer the questions', body: 'Pick options or type your answers. They’re kept as you type, even if you close the exam.' },
      { at: '.fullscreen .exam-submit', title: 'Submit for marking', body: 'Apollo marks multiple choice exactly and written answers against the marking scheme, and tells you what was missing.' },
      { at: '.fullscreen .exam-meta select', title: 'Your attempts', body: 'Every submission is kept. Pick one to look back at its marks, or start a new attempt.' },
      { at: '.fullscreen .fs-top .btn-sm', title: 'Print it', body: 'Export saves the exam as Word or PDF, with or without the answers.' },
    ],
  },
  studynotes: {
    title: 'Study notes', where: 'a set of study notes', group: 'Study material',
    steps: [
      { at: '.artifact-page .notes-toc', title: 'Contents', body: 'Jump straight to any section.' },
      { at: '.artifact-page .artifact-scroll', title: 'Read, ask and highlight', body: 'Select text and right-click to ask Apollo about it, have it checked or rewritten, or highlight it. Source links open the exact page in your files.' },
      { at: '.artifact-page .artifact-scroll', title: 'Snip an area', body: 'Right-drag over the notes to box an area, then send it to the chat as a picture or add it to one of your notes.' },
      { at: '.artifact-page .source-head', title: 'Check, comment, export', body: 'Check with Apollo looks for mistakes against your files, and its comments sit beside the page. Regenerate writes the notes again; Export saves Word or PDF.' },
    ],
  },
  cheatsheet: {
    title: 'Cheat sheets', where: 'a cheat sheet', group: 'Study material',
    steps: [
      { at: '.artifact-page .artifact-scroll', title: 'Everything on one page', body: 'The key facts, formulas and definitions, short enough to revise from. Select text and right-click to ask Apollo about it or highlight it.' },
      { at: '.artifact-page .source-head', title: 'Check and export', body: 'Check with Apollo looks for mistakes against your files. Export saves it as Word or a PDF to print.' },
    ],
  },
  mindmap: {
    title: 'Mind maps', where: 'a mind map', group: 'Study material',
    steps: [
      { at: '.artifact-page .mindmap', title: 'Explore the map', body: 'Drag to move around and scroll to zoom. Click an idea to see its detail and where it comes from.' },
      { at: '.artifact-page .mm-fold', title: 'Fold branches', body: 'The dot at the end of an idea folds or unfolds its branch.' },
      { at: '.artifact-page .mm-tools', title: 'Find your way', body: 'Fit the map to the screen, zoom, show only the main branches, or unfold everything.' },
      { at: '.artifact-page .mm-detail', title: 'Ask about an idea', body: 'Ask Apollo about this sends the idea you clicked to the chat.' },
    ],
  },
  marking: {
    title: 'Marking your work', where: 'a marking', group: 'Study material',
    steps: [
      { at: '.marking .marking-score', title: 'Your mark', body: 'Your total, out of what the work is marked out of. The bar turns green, amber or red with how you did.' },
      { at: '.marking .marking-summary', title: 'The overall picture', body: 'What Apollo thought of the work as a whole: what you did well and what to work on next.' },
      { at: '.marking .marking-criteria', title: 'Question by question', body: 'Each question or criterion with its marks, the words of yours it is about, and corrections. Click one to show the pages it is about.' },
      { at: '.marking .marking-ask', title: 'Ask about the feedback', body: 'Not sure why you lost a mark? Ask Apollo about this sends that feedback to the chat.' },
      { at: '.marking .marking-pages', title: 'Your pages', body: 'Your work as Apollo read it. A page link in the feedback scrolls here.' },
      { at: '.artifact-page .source-head', title: 'Mark it again', body: 'Improved your work? Mark a new version marks the new files with the same rubric and shows what changed. Regenerate marks the same work again from scratch, and Export saves the feedback as Word or PDF.' },
    ],
  },

  /* ---------------------------------------------------------------- the student's own notes */
  notes: {
    title: 'Writing a note', where: 'one of your notes', group: 'Your own notes',
    steps: [
      { at: '.note-editor .ne-page', title: 'Write your notes', body: 'Type here like any document. It saves as you go. These notes are yours: Apollo never adds them to the material it answers from.' },
      { at: '.note-editor .ne-title', title: 'Name it', body: 'Click the title to rename the note.' },
      { at: '.note-editor .ne-topic', title: 'Its topic', body: 'Which topic the note is about. When Apollo checks the note, it checks it against that topic’s material.' },
      { at: '.note-editor .ne-toolbar', title: 'Format', body: 'Headings, fonts, colours, highlights, lists and tables (pick a size from the grid; Tab moves between cells; right-click a cell for rows and columns). Ctrl+B, I and U work too.' },
      { at: '.note-editor .ne-page', title: 'Right-click for more', body: 'Select some text and right-click to ask Apollo about it, have just that part checked or rewritten, or highlight it. Right-drag across the page to send a screenshot of an area to the chat. Spelling is checked as you type.' },
      { at: '.note-editor .ne-check', title: 'Check with Apollo', body: 'Apollo compares your note with your files and gives a short verdict and the mistakes that matter, each with a fix and a link to the page it relies on.' },
      { at: '.note-editor .ne-comments', title: 'Comments', body: 'What Apollo said about this note, beside the page. Apply a suggested fix with one click (Undo takes it back), or click a source link to open that page.' },
      { at: '.note-editor .tool-calc', title: 'Calculator', body: 'A calculator and graphing tool you can move anywhere. It can put a result or a graph straight into this note.' },
      { at: '.note-editor .ne-export', title: 'Export', body: 'Saves the note as a Word document or a PDF.' },
    ],
  },
  map: {
    title: 'Your mind maps', where: 'one of your mind maps', group: 'Your own notes',
    steps: [
      { at: '.map-editor .map-canvas', title: 'Build the map', body: 'Double-click the canvas for a new box, and double-click a box or an arrow to write on it. Drag a box’s dot onto another box to link them, or onto empty space for a new linked box.' },
      { at: '.map-editor .map-canvas', title: 'Move around', body: 'Drag the background to move, scroll to zoom, and Shift-drag to select several boxes. With a box selected, Tab adds a linked box and Delete removes it.' },
      { at: '.map-editor .map-toolbar', title: 'Shapes and colours', body: 'Pick a shape and colour for new or selected boxes. Use a diamond for a decision in a flowchart. Tidy lays the map out neatly.' },
      { at: '.map-editor .map-check', title: 'Check with Apollo', body: 'Apollo reads your boxes and links and points out any that don’t match your files. Click an issue in Comments to see the box it means.' },
      { at: '.map-editor .map-export', title: 'Save a copy', body: 'Export the map as a picture, a Word document or a PDF. The map itself saves as you go.' },
    ],
  },
  drawing: {
    title: 'Your drawings', where: 'one of your drawings', group: 'Your own notes',
    steps: [
      { at: '.drawing-editor .dr-canvas', title: 'Draw', body: 'Draw with a mouse or a pen (it feels how hard you press). The mouse wheel zooms; hold Space and drag to move the page.' },
      { at: '.drawing-editor .dr-toolbar', title: 'Tools', body: 'Pen, highlighter, eraser, lines, arrows, shapes and text. Each has a key: P pen, E eraser, T text, V select (then drag to move or resize).' },
      { at: '.drawing-editor .dr-colours', title: 'Colour and thickness', body: 'Pick a colour and a line thickness. With something selected, they change it too.' },
      { at: '.drawing-editor .dr-paper', title: 'Paper', body: 'Plain, grid or lined paper.' },
      { at: '.drawing-editor .dr-desc', title: 'Say what it shows', body: 'One line, like “forces on a block on a slope”, helps Apollo understand your drawing when it checks it.' },
      { at: '.drawing-editor .dr-check', title: 'Check with Apollo', body: 'Apollo looks at a picture of your drawing and compares it with your files. Its comments appear beside the page.' },
    ],
  },

  /* ---------------------------------------------------------------- tools */
  calculator: {
    title: 'The calculator', where: 'the calculator', group: 'Tools',
    steps: [
      { at: '.calc .calc-input', title: 'Type or tap', body: 'Type a calculation like 2sin(30) + 5! or use the keys. Enter works it out; ans is the last answer, and ↑ brings back the last calculation.' },
      { at: '.calc .calc-angle', title: 'Degrees or radians', body: 'Choose how sin, cos and tan read angles.' },
      { at: '.calc .calc-history', title: 'History', body: 'Your answers stay here. Click one to use it again.' },
      { at: '.calc .calc-modes', title: 'Graphs', body: 'Graphing draws several functions at once. Drag to move, scroll to zoom, hover to read values, and show a table of values.' },
      { at: '.calc .calc-grip', title: 'Move it anywhere', body: 'Drag the top bar. It stays open while you switch files and notes; only the × closes it. Insert puts a result or a graph into the open note, and Send to chat puts it in the chat box to ask about.' },
    ],
  },
} satisfies Record<string, TourDef>;

export type TourId = keyof typeof TOURS_DEF;
export const TOURS: Record<TourId, TourDef> = TOURS_DEF;

const seenKey = (id: string) => `tourSeen.${id}`;
const seen = (id: string) => getPref<string>(seenKey(id), '') === '1';

/** On screen: it takes up room, isn't `visibility: hidden`, and isn't inside something put away (a panel that's
 * aria-hidden while closed, the chat tucked out of sight). */
const showing = (el: Element) => {
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
  return !el.closest('[aria-hidden="true"], .tucked');
};
/** The first match of the first selector in `sel` (a comma-separated list) that's showing. */
const anchor = (sel?: string) => {
  if (!sel) return null;
  for (const s of sel.split(/,\s*/)) {
    const el = [...document.querySelectorAll(s)].find(showing);
    if (el) return el;
  }
  return null;
};

interface Running { id: TourId; steps: TourStep[]; step: number; away: boolean }
let running: Running | null = null;
/** When the last tour closed: tours that start by themselves wait a little after one, so they never come back to back. */
let lastClosed = 0;
const QUIET_MS = 8000;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const set = (r: Running | null) => { if (!r && running) lastClosed = Date.now(); running = r; emit(); };

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

/** Something else has the student's attention: setup, the app tour waiting to start, a dialog, a menu, or a tour (now
 * or a moment ago). */
function busy() {
  return running !== null || getPref<string>('tourPending', '') === '1' || Date.now() - lastClosed < QUIET_MS
    || !!document.querySelector('.setup, .modal-backdrop, .ctx-menu');
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

/** Every tour, for the help window, under its group's heading. `onPick` runs before the tour starts (e.g. to close the
 * window). */
export function TourList({ onPick }: { onPick: (id: TourId) => void }) {
  const ids = Object.keys(TOURS) as TourId[];
  return (
    <div className="tour-groups">
      {TOUR_GROUPS.map((g) => {
        const mine = ids.filter((id) => TOURS[id].group === g);
        return mine.length > 0 && (
          <div key={g} className="tour-group">
            <div className="tour-group-title">{g}</div>
            <div className="tour-list" role="list" aria-label={g}>
              {mine.map((id) => (
                <button key={id} className="tour-list-item" role="listitem" onClick={() => onPick(id)}>
                  <Icon name="play" size={12} /> {TOURS[id].title}
                </button>
              ))}
            </div>
          </div>
        );
      })}
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
