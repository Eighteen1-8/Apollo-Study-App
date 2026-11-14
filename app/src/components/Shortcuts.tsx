/* Every keyboard shortcut and mouse gesture in one list: shown by the side bar's "?" button and the /shortcuts command. */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Getting around',
    rows: [
      ['Ctrl+K', 'Search everything and go anywhere'],
      ['Ctrl+Shift+F', "Search the subject's files"],
      ['Ctrl+F', 'Find in what you last clicked'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (outside text boxes): deletes, renames, moves and page changes'],
      ['Ctrl + / Ctrl − / Ctrl 0', 'Make everything bigger / smaller / back to normal size'],
    ],
  },
  {
    title: 'Files and folders',
    rows: [
      ['Right-click or ⋯', 'More options for any subject, topic, folder, file, chat or generated item'],
      ['Shift / Ctrl + click', 'Select several files or chats, then move or delete them together'],
      ['Drag a file', 'Onto a topic or folder to move it, or onto the chat to ask about it'],
      ['Drag a file, note or generated notes into the middle', 'Open it there, or on the left or right half to see it side by side'],
      ['Drag selected text into a note', 'From a file beside the note: quoted with its file and page'],
      ['Drag files from Explorer', 'Into the window to add them to a topic, the textbooks, or one chat message'],
      ['Delete', 'Delete the selected files'],
    ],
  },
  {
    title: 'Reading and studying',
    rows: [
      ['Select text → Ask', 'Ask Apollo about a highlighted passage'],
      ['Select part of a reply → Reply', "Follow up on just that part of Apollo's answer"],
      ['Right-drag', 'Box an area of generated content to send it to the chat as a picture'],
      ['Click a [[citation]]', 'Open the slide or page Apollo quoted'],
    ],
  },
  {
    title: 'Calculator and timer',
    rows: [
      ['Enter / Esc', 'Work it out / clear the calculation'],
      ['↑ in an empty box', 'Bring back the last calculation (ans is the last answer)'],
      ['Drag / scroll on a graph', 'Move around / zoom in and out'],
      ['Send to chat', 'Put a result, or the graph’s functions, in the chat box to ask about them'],
      ['/calc 2sin(30) · /graph x^2', 'In the chat: work it out there, or draw it in the calculator'],
      ['Shift + − or +', 'Change the study timer by 1 minute instead of 5'],
    ],
  },
  {
    title: 'Your mind maps and drawings',
    rows: [
      ['Double-click', 'Mind map: a new box, or write on a box or arrow'],
      ["Drag a box's dot", 'Link it to another box (or drop on empty space for a new linked box)'],
      ['Tab / Delete', 'Mind map: a new linked box / remove what is selected'],
      ['V H P I E L A R O T', 'Drawing: select, move the page, pen, highlighter, eraser, line, arrow, rectangle, ellipse, text'],
      ['Space + drag · wheel', 'Drawing: move the page · zoom'],
      ['Ctrl+D · arrows', 'Duplicate · nudge what is selected (Shift: further)'],
    ],
  },
  {
    title: 'Chat',
    rows: [
      ['Enter / Shift+Enter', 'Send / new line'],
      ['/', 'Commands (e.g. /create flashcards, /topic, /help)'],
      ['Esc', 'Stop the reply being written'],
    ],
  },
  {
    title: 'Knowledge map',
    rows: [
      ['Drag · scroll', 'Turn the map · zoom'],
      ['Double-click', 'Reset the view'],
      ['Click a point', 'Open the passage it stands for'],
    ],
  },
];

export default function ShortcutsList() {
  return (
    <div className="shortcuts">
      {GROUPS.map((g) => (
        <section key={g.title} className="shortcuts-group">
          <div className="shortcuts-title">{g.title}</div>
          <table className="cmd-table"><tbody>
            {g.rows.map(([k, v]) => <tr key={k}><td className="shortcuts-key"><kbd>{k}</kbd></td><td>{v}</td></tr>)}
          </tbody></table>
        </section>
      ))}
    </div>
  );
}
