"""What Apollo knows about itself: the `app_info` chat tool's answers. Nothing here is in the chat's context; the model
reads a section only when the student asks about Apollo or the app (what it is, what it can do, how to do something).

Keep each section in plain words for a student, and in step with the app: README.md "Using it",
`components/Shortcuts.tsx` (shortcuts and gestures) and `components/slashCommands.tsx` (the commands)."""

SECTIONS: dict[str, tuple[str, str]] = {
    # key: (one-line summary for the index, text)
    "overview": ("What Apollo is and why it exists", """\
Apollo is a private study app for students. You add your own course material (lecture slides, notes, PDFs, Word
documents, textbooks, pictures of pages) and Apollo, the tutor built into it, answers questions from that material,
cites the exact slide or page it used, and makes study material from it: flashcards, quizzes, practice exams, full
notes, cheat sheets and mind maps. It can also mark your own work (essays, assignments, handwritten answers).

Why Apollo:
- It is made for students, not by a big company adding AI to everything it sells.
- It is a normal study app first (files, notes, flashcards, quizzes, a to-do list) with the AI built around your own
  source material, rather than study material bolted onto a general chatbot. Answers come from your files and say
  where they came from, so you can check them.
- It is private and works offline by default: the models run on your own computer (or another computer you own), and
  your files never leave it unless you choose online models in Settings."""),

    "subjects": ("Subjects, topics, the reference library and adding files", """\
- A subject is a course (e.g. Physics). Make one with + on the left bar or New subject on the home screen; right-click
  it to rename it, change its colour or icon, or delete it.
- Topics group a subject's material (e.g. Electric circuits) and everything made from it. Folders inside topics are
  just for tidying the sidebar.
- The reference library (textbooks) holds whole textbooks and other material for the entire subject. Apollo treats
  textbooks as the most accurate source and searches them for every question.
- Add files by dragging them into the window (choose a topic, the textbooks, or just one chat message) or with
  + Add files on the right. PowerPoint, Word, PDF, text and image files work. Apollo reads each file into slides,
  pages or sections, removes exact duplicates, and indexes it so it can be searched.
- Pictures, diagrams and scanned pages get a second pass by the vision model, which writes a description of each one
  so they can be searched and explained too. This is slow; progress shows in the background jobs list on the left
  bar.
- Files can be moved between topics by dragging them (Shift/Ctrl-click selects several). Deleted files wait a week in
  the trash and Undo brings them back."""),

    "chat": ("Asking Apollo questions in the chat", """\
- Pick which material Apollo uses (one topic or All topics) and how much it thinks before answering (the reasoning
  level: Off is fastest, higher levels are slower but more careful), then ask.
- Apollo answers from your material and cites it like [[file · Slide 4]]; click a citation to open that slide or
  page. When your material doesn't cover something, it says so and answers from general knowledge.
- Ask about a specific file by dragging it from the sidebar onto the chat, or send any file from your computer with
  one message only (it isn't added to your library) with the paperclip button.
- Select text in a document, notes or generated content and press Ask to ask about that passage. Select part of one
  of Apollo's replies and press Reply to follow up on just that part.
- Right-drag over generated content to box an area and send it to the chat as a picture.
- A reply keeps writing in its own chat while you switch chats or subjects; a dot marks replies you haven't read.
  Stop (or Esc) keeps what was written so far. You can edit a question, regenerate a reply, or undo the chat back to
  an earlier message.
- The ring beside the chat box shows how full Apollo's memory of the conversation is; start a new chat when it fills.
- The chat floats in a corner when a file is open: drag its header to move it, drag its corner to resize, or use the
  header buttons to put it side by side with what's open or full screen.
- Apollo can make flashcards, quizzes and the like, add to-dos, read your notes (and its marking of your work), and
  check or revise your notes when you ask in the chat. When the material it was given doesn't answer a question, it
  searches your files further by itself.
- The Length setting (Settings → Chat tutor) goes from thorough to very concise."""),

    "studying": ("Start studying, the study panel and the knowledge map", """\
- Each subject opens to its knowledge map: a 3D cloud of everything in its files, where nearby points are about
  similar things. Press "Press to explore the map" to turn, zoom and click it (a point opens the passage it stands
  for); "Back to studying" locks it again.
- Start studying opens the study panel: a chat box (press Enter and the chat grows out of it to fill the screen; type
  / for commands; drag a file from the sidebar onto it to ask about that file), what to continue where you left off,
  your to-do list, and buttons to make content.
- The revision to-do list: Apollo can add to it when you ask it to plan your revision; tick items off as you go."""),

    "content": ("Making flashcards, quizzes, exams, notes, cheat sheets and mind maps", """\
- Make content from the study panel, a Create menu, the chat (ask, or use the buttons under the chat box), or a
  file's toolbar (make it from just that file). Pick the type, what material to use, and optionally add extra files or
  instructions for that one request. It's made in the background and appears on the left when it's ready.
- Flashcards: open full screen; mark each card ✓ or ✗. Cards marked ✗ tell Apollo in the chat what you're struggling
  with.
- Quizzes: multiple-choice questions (optionally some or all true/false) with explanations and the source of each
  answer. Under Advanced: the difficulty (easy, normal, hard) and the kinds of question.
- Exams: made from a practice exam you upload, with the same structure and new questions, spread over every file and
  section in proportion to its size. Apollo marks your written answers against a rubric and multiple choice against
  the key.
- Full notes and cheat sheets: structured notes made from every section of the material, with figures cropped from
  your files and graphs. Export them to Word or PDF.
- Mind maps: how the ideas in your material connect.
- Marking: Apollo marks your own work (see the marking section).
- Choose pages or slides: under Advanced in the last step, pick a file and the pages, slides or sections to use
  (type ranges like 3-7, 12, click thumbnails, Shift-click a range, or pick a chapter), e.g. a quiz on slides 10-20.
  In the chat, ask for it ("a quiz on slides 10-20 of Lecture 3"): the form shows the file and pages, and you can
  change them before it starts.
- If making something fails or is cancelled part way, Retry continues from the parts already finished (also after
  the app restarts). Regenerate on finished content starts over.
- Generated content can be highlighted, checked, revised by Apollo, renamed, reordered and deleted (Undo brings it
  back for a week)."""),

    "marking": ("Having Apollo mark your own work (essays, assignments, worked answers)", """\
- Make content → Marking. Add the work: one or more files (Word, PDF, PowerPoint, text, or photos of handwritten
  pages). Optionally add the rubric or marking guide, what it's marked out of, and instructions (e.g. "be strict about
  units"). Choose what to check it against: a topic, the whole subject, or nothing (only the rubric and general
  knowledge).
- Apollo reads the work's text and looks at every page, works out criteria from the task when there's no rubric, marks
  each question or criterion with feedback, corrections and the words it's about, then sums up your strengths and
  what to improve. It runs in the background like other content.
- The result shows your score, each question or criterion beside the pages, and buttons to ask Apollo about any
  piece of feedback. Regenerate marks it again; Export saves it as Word or PDF.
- Mark a new version: after improving your work, press Mark a new version and pick the new files. The rubric,
  instructions, marks and material stay the same unless you change them. The new marking shows what improved and
  what still needs work, the change in score overall and per question or criterion, and links to earlier versions.
- Your files are copied into Apollo's data folder for this marking only: they're never added to your study material.
  Up to 40 pages at a time.
- Marking isn't started from the chat (it needs your files); use Make content."""),

    "notes": ("Your own notes", """\
- My notes (bottom of the right sidebar) are your own rich-text notes: headings, lists, colours, highlights, tables
  (pick a size from the grid; Tab moves between cells; right-click a cell for rows and columns). Spell check works
  offline (Australian, British or US English, chosen in Settings).
- Your notes are never added to Apollo's material, since they may be wrong, but Apollo can read one when you ask it
  to.
- Ask Apollo to check a note (a short verdict and only the mistakes that matter, most important first, each in a
  sentence or two with its fix and a link to the slide or page it relies on) or revise it (it proposes new text you
  can apply, and undo). Suggestions appear in the Comments panel; click a source link to open that page.
- Export a note to Word or PDF.
- The + beside My notes also makes a mind map / flowchart or a drawing. Mind maps: double-click the canvas to add a
  box, drag a box's handle onto another box to link them, double-click a box or link to write on it; shapes and
  colours in the toolbar; Tab adds a linked box, Delete removes, Tidy lays the map out, Fit shows all of it; drag the
  background to pan, wheel to zoom, Shift-click boxes, or Shift-drag around them, to select several.
- Drawings: pen, highlighter, eraser, line, arrow, rectangle, ellipse, text and select (move, resize, delete), colours
  and widths, plain/grid/lined paper, zoom and pan, export as a PNG picture.
- Check with Apollo works on both: for a map it reads the boxes and links and highlights the wrong box or link when
  you click an issue; for a drawing it looks at the picture (this needs a model that can see pictures), with your
  one-line "what this shows". Apollo doesn't rewrite maps or drawings. Both export as a picture (Word or PDF)."""),

    "viewer": ("Reading and annotating documents", """\
- Click a file to open it in the viewer: slides and pages look like the original. Word and PowerPoint files are
  copied exactly with Microsoft Office or LibreOffice; when neither is there or the copy fails, a simpler layout is
  shown with a note saying why and a Try again button (Settings → Maintenance lists these files in advanced mode). The toolbar has Select (V),
  Highlight (H), Pen (P), Eraser (E), Text box (T), Note box (N) and Snip (S: box part of a page to send it to the
  chat or pin a note to it), colours, Chapters (jump to a section), Find, My notes (the list of your highlights and
  notes on the file), zoom, and "Make content from this file".
- Select text to Define it, Ask Apollo about it, highlight it in a colour, or add a note to it.
- Open two things side by side from their menu, and drag the divider between them.
- Ctrl+F finds text in the open file (every page of a PDF).
- The calculator button in the viewer's toolbar opens the calculator over the page (see the tools section)."""),

    "tools": ("The calculator, the study timer, tutorials and the pet", """\
- Calculator: the calculator button in a file's toolbar, or in a note's, mind map's or drawing's toolbar. Scientific
  mode takes typed calculations like 2sin(30) + 5! or the keys, with degrees or radians, functions, physics
  constants, a history (click one to use it again), ans for the last answer and the up arrow for the last
  calculation. Graphing mode draws several functions at once: drag to move, scroll to zoom, hover to read values,
  and show a table of values. With a note open, Insert puts a result or a graph into the note; with a chat open, Send
  to chat puts a result, or the graph's functions, in the chat box so you can ask about them (the chat's /calc and
  /graph do the reverse). Drag its top bar to move it; it stays open while you switch files and notes, and only its
  close button closes it.
- Study timer: the clock on the left bar. Click it, set the minutes with - and + (5 minutes a step, 1 with Shift),
  then start. The button shows the time left; Apollo tells you when the time is up (and flashes the taskbar if the
  window is behind others). It keeps counting if you close the app. Pick 25 / 5 or 50 / 10 in the timer for
  focus-and-break rounds: when a focus round ends its break starts by itself, and when the break ends the next focus
  round waits for Start (Custom is a single timer of any length). The timer and the study panel show today's focus
  sessions and minutes (back to zero at midnight).
- Tutorials: each part of Apollo (the subject page, notes, the file viewer, the chat, each kind of study material,
  marking, mind maps, drawings, the calculator) shows a few tips the first time you open it. The ? button on that
  part shows them again, and the help window (? on the left bar) lists them all.
- The pet: an optional small cat that shows what Apollo is doing (reading files, writing, marking, replying, waiting,
  paused, or that something went wrong). Turn it on or off with its button on the left bar or in Settings →
  Appearance."""),

    "commands": ("Slash commands in the chat box", """\
Type / in the chat box (or the study panel's box) to see them. They run in the app and are never sent to Apollo.
- /stats [chat | subject | all]: tokens, time spent and cost
- /effort off | low | medium | xhigh: how much Apollo thinks before answering
- /create flashcards | quiz | exam | notes | cheatsheet | mindmap [focus]: make study material
- /topic <topic name | all>: which material Apollo uses
- /context: how full the context window is
- /todo <text>: add a to-do
- /calc [calculation]: open the calculator, or work a calculation out in the chat (never sent to Apollo)
- /graph <function of x>: draw it in the calculator's graphing mode
- /new: start a new chat
- /rename [title]: rename this chat
- /title: let Apollo name this chat
- /stop: stop the reply being written
- /delete: delete this chat
- /shortcuts: keyboard shortcuts and mouse gestures
- /help: list the commands"""),

    "shortcuts": ("Keyboard shortcuts and mouse gestures", """\
Getting around:
- Ctrl+K: search everything (subjects, topics, files, chats, generated content, notes) and go anywhere
- Ctrl+Shift+F: search the subject's files (names and the text inside them)
- Ctrl+F: find in what you last clicked
- Ctrl+Z / Ctrl+Y: undo / redo outside text boxes (deletes, renames, moves and page changes)
- Ctrl + / Ctrl - / Ctrl 0: make everything bigger / smaller / back to normal size
Files and folders:
- Right-click or the ⋯ button: more options for any subject, topic, folder, file, chat or generated item
- Shift / Ctrl + click: select several files or chats, then move or delete them together
- Drag a file onto a topic or folder to move it, or onto the chat to ask about it
- Drag files from Explorer into the window to add them to a topic, the textbooks, or one chat message
- Delete: delete the selected files
Reading and studying:
- Select text → Ask: ask Apollo about a highlighted passage
- Select part of Apollo's reply → Reply: follow up on just that part
- Right-drag: box an area of generated content to send it to the chat as a picture
- Click a citation: open the slide or page Apollo quoted
Calculator and timer:
- Enter / Esc: work it out / clear the calculation; the up arrow in an empty box brings back the last calculation
- Drag / scroll on a graph: move around / zoom
- Shift + - or +: change the study timer by 1 minute instead of 5
- Send to chat (in the calculator): put a result, or the graph's functions, in the chat box to ask about them
Your mind maps and drawings:
- Double-click: a new box, or write on a box or arrow; drag a box's dot onto another box to link them
- Tab / Delete: a new linked box / remove what is selected
- Drawing tools: V select, H move the page, P pen, I highlighter, E eraser, L line, A arrow, R rectangle, O ellipse,
  T text
- Space + drag: move the drawing; mouse wheel: zoom
- Ctrl+D / arrows: duplicate / nudge what is selected
Chat:
- Enter / Shift+Enter: send / new line
- /: commands
- Esc: stop the reply being written
Knowledge map:
- Drag to turn, scroll to zoom, double-click to reset the view, click a point to open its passage
The ? button on the left bar shows this list."""),

    "settings": ("Settings, modes and appearance", """\
- Chat tutor: how Apollo answers. Assistive (how much it shows the method), Length (from thorough to very concise)
  and Interactive (from straight answers to Socratic questions). In advanced mode you can also edit its rules.
- Mode: Standard (plain words, guided steps) or Advanced (technical terms, token numbers, Maintenance, every tuning
  setting).
- Appearance: themes named after elements, accent colour, UI size (80-160%; Ctrl + and Ctrl - do the same),
  animation speed, a background effect (snow, meteors or fireflies, plus a theme-only one for Sodium (roses,
  bubbles and gold stars) and Nitrogen (hydrangeas), chosen automatically with those themes), the 3D knowledge map and its frame rate, and
  the pet (an optional small cat that shows what Apollo is doing).
- Models: where the models run (this computer or OpenRouter online), addresses, model names, and Test connections.
- Maintenance (advanced): disk use, clean-up, re-reading files, vision checks, the log and database backups.
- Share: export or import a subject, topic or files as a study pack to give to someone else.
- Help (the ? on the left bar) lists every shortcut, replays setup and shows any of the tutorials again."""),

    "privacy": ("Privacy and working offline", """\
- By default everything runs on your own computer: your files, notes, chats and generated content stay in the app's
  data folder, and the models run locally (or on another computer on your own network).
- The app blocks every connection to the internet; it never downloads anything by itself.
- Online models (OpenRouter) are optional and off by default. If you turn them on in Settings, what is sent to them
  (your questions and the material used to answer) leaves your computer and is handled by outside servers; the app
  asks first and shows a globe badge while they're on.
- Your own notes are never added to the material Apollo searches."""),
}


def index() -> str:
    return "\n".join(f"- {k}: {summary}" for k, (summary, _) in SECTIONS.items())


def info(topic: str | None = None) -> str:
    """The section(s) for `topic` (a key, or words matched against keys and summaries); everything when it's empty or
    "all"; the index when nothing matches."""
    t = (topic or "").strip().lower()
    if not t or t in ("all", "everything", "app", "apollo"):
        return "\n\n".join(f"## {summary}\n{text}" for summary, text in SECTIONS.values())
    if t in SECTIONS:
        summary, text = SECTIONS[t]
        return f"## {summary}\n{text}"
    words = [w for w in t.replace(",", " ").split() if len(w) > 2]
    scored = []
    for k, (summary, text) in SECTIONS.items():
        hay = f"{k} {summary}".lower()
        body = text.lower()
        score = sum(3 * (w in hay) + (w in body) for w in words)
        if score:
            scored.append((score, k))
    if not scored:
        return f"(No section about “{topic}”. The sections are:)\n{index()}"
    scored.sort(key=lambda s: -s[0])
    return "\n\n".join(f"## {SECTIONS[k][0]}\n{SECTIONS[k][1]}" for _, k in scored[:2])
