/* The subject's revision to-do list. */
import { useRef, useState } from 'react';
import { api, Subject, Todo } from '../../api';
import { usePoll } from '../../hooks';
import { useOverlay } from '../../components/overlay';
import { useReorder } from '../../components/reorder';
import { undoable, undoEntry } from '../../undo';
import { toast } from '../../components/toast';
import { getPref, setPref } from '../../prefs';
import Icon from '../../components/Icon';


export function Todos({ subject }: { subject: Subject }) {
  const ov = useOverlay();
  const todos = usePoll(() => api.todos(subject.id), 500, [subject.id], ['todos']);
  const [adding, setAdding] = useState('');
  // folded: just the heading (and how many are left), remembered on this computer
  const [folded, setFolded] = useState(() => getPref('todosFolded', false, (v) => v === '1'));
  const list = todos.data ?? [];
  const pending = list.filter((t) => !t.done).length;
  const dragDone = useRef<number | null>(null);
  const reorder = useReorder(`todos:${subject.id}`, list.map((t) => t.id),
    async (ids) => { await api.orderTodos(subject.id, ids); todos.reload(); }, 'reorder to-dos');
  const ordered = reorder.order.map((id) => list.find((t) => t.id === id)!).filter(Boolean);
  const open = ordered.filter((t) => !t.done);
  const done = ordered.filter((t) => t.done);
  // ticked to-dos sit in a small fold under the open ones, closed unless the student opened it (remembered)
  const [showDone, setShowDone] = useState(() => getPref('todosDoneOpen', false, (v) => v === '1'));

  /** Re-adding a deleted to-do makes a new row: later undo/redo steps follow it through `box`. */
  const remove = async (t: Todo) => {
    await api.deleteTodo(t.id); // at once: Undo in the toast (or Ctrl+Z) adds it back
    todos.reload();
    const box = { id: t.id };
    const entry = undoable({
      label: `delete to-do “${t.text.slice(0, 40)}”`,
      undo: async () => {
        const n = await api.addTodo(subject.id, { text: t.text, note: t.note, topic_id: t.topic_id, source: t.source });
        if (t.done) await api.setTodo(n.id, { done: true });
        box.id = n.id;
      },
      redo: () => api.deleteTodo(box.id),
    });
    toast('To-do deleted', { label: 'Undo', run: () => undoEntry(entry) });
  };
  const setDone = async (t: Todo, done: boolean) => {
    await api.setTodo(t.id, { done });
    todos.reload();
    undoable({ label: `${done ? 'tick' : 'untick'} “${t.text.slice(0, 40)}”`, undo: () => api.setTodo(t.id, { done: !done }), redo: () => api.setTodo(t.id, { done }) });
  };
  const edit = async (t: Todo) => {
    const text = await ov.prompt({ title: 'Edit to-do', initial: t.text });
    if (!text) return;
    await api.setTodo(t.id, { text });
    todos.reload();
    undoable({ label: 'edit a to-do', undo: () => api.setTodo(t.id, { text: t.text }), redo: () => api.setTodo(t.id, { text }) });
  };
  const add = async () => {
    const text = adding.trim();
    if (!text) return;
    const n = await api.addTodo(subject.id, { text });
    setAdding('');
    todos.reload();
    const box = { id: n.id };
    undoable({ label: `add to-do “${text.slice(0, 40)}”`, undo: () => api.deleteTodo(box.id),
      redo: async () => { box.id = (await api.addTodo(subject.id, { text })).id; } });
  };
  const row = (t: Todo) => {
    const r = reorder.item(t.id);
    const same = () => dragDone.current === t.done;
    return (
      <div key={t.id} className={`todo${t.done ? ' done' : ''}`} title={t.note || undefined}
        draggable data-drop={r['data-drop']}
        onDragStart={(e) => { dragDone.current = t.done; r.onDragStart(e); }}
        onDragEnd={() => { dragDone.current = null; r.onDragEnd(); }}
        onDragOver={(e) => { if (same()) r.onDragOver(e); }}
        onDragLeave={(e) => { r.onDragLeave(e); }}
        onDrop={(e) => { if (same()) r.onDrop(e); }}
        onContextMenu={(e) => ov.menu(e, [
          { label: 'Edit…', onClick: () => edit(t) },
          { label: 'Delete…', danger: true, onClick: () => remove(t) },
        ])}>
        <span className="drag-grip" aria-hidden>⋮⋮</span>
        <input type="checkbox" checked={!!t.done} onChange={(e) => setDone(t, e.target.checked)} />
        <span className="todo-text">{t.text}{t.topic_name && <span className="todo-topic">{t.topic_name}</span>}</span>
        <button className="x-btn todo-x" title="Delete" onClick={() => remove(t)}><Icon name="close" size={14} /></button>
      </div>
    );
  };
  return (
    <section className={`side-section todos-section${folded ? ' folded' : ''}`}>
      <div className="side-section-head">
        <button className="my-notes-title" aria-expanded={!folded} title={folded ? 'Show the to-do list' : 'Hide the to-do list'}
          onClick={() => { setFolded(!folded); setPref('todosFolded', folded ? '0' : '1'); }}>
          <span className="lib-caret"><Icon name="chevronDown" size={13} /></span> Revision to-do {pending > 0 && <span className="count-badge">{pending}</span>}
        </button>
      </div>
      {!folded && <div className="todos">
        {open.map(row)}
        <input className="todo-add" placeholder="+ Add a to-do" value={adding} onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        {done.length > 0 && <>
          <button className={`todos-done-tab${showDone ? ' open' : ''}`} aria-expanded={showDone}
            onClick={() => { setShowDone(!showDone); setPref('todosDoneOpen', showDone ? '0' : '1'); }}>
            <span className="lib-caret"><Icon name="chevronDown" size={12} /></span> Completed <span className="todos-done-count">{done.length}</span>
          </button>
          {showDone && <div className="todos-done">{done.map(row)}</div>}
        </>}
      </div>}
    </section>
  );
}

/** The sidebar's file search: file names across the subject (textbooks, every topic and folder), then passages
 * inside the files (the same search Apollo uses; keyword-only while embeddings are paused). */
