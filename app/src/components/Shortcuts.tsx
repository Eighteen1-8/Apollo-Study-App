/* Every keyboard shortcut and mouse gesture in one list: shown by the side bar's "?" button and the /shortcuts command. */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Getting around',
    rows: [
      ['Ctrl+K', 'Search everything and go anywhere'],
      ['Ctrl+Shift+F', "Search the subject's files"],
      ['Ctrl+F', 'Find in what you last clicked'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (outside text boxes): deletes, renames, moves and page changes'],
    ],
  },
  {
    title: 'Files and folders',
    rows: [
      ['Right-click or ⋯', 'More options for any subject, topic, folder, file, chat or generated item'],
      ['Shift / Ctrl + click', 'Select several files or chats, then move or delete them together'],
      ['Drag a file', 'Onto a topic or folder to move it, or onto the chat to ask about it'],
      ['Drag files from Explorer', 'Into the window to add them to a topic, the textbooks, or one chat message'],
      ['Delete', 'Delete the selected files'],
    ],
  },
  {
    title: 'Reading and studying',
    rows: [
      ['Select text → Ask', 'Ask Apollo about a highlighted passage'],
      ['Right-drag', 'Box an area of generated content to send it to the chat as a picture'],
      ['Click a [[citation]]', 'Open the slide or page Apollo quoted'],
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
