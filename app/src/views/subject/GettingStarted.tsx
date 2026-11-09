/* The centre of a subject with no files yet (outside advanced mode): three steps, each with its button, ticked off
   as they're done. It gives way to the knowledge map once the first file is added. */
import { Subject } from '../../api';
import Icon from '../../components/Icon';

export default function GettingStarted({ subject, onNewTopic, onAddFiles, onOpenChat }: {
  subject: Subject; onNewTopic: () => void; onAddFiles: () => void; onOpenChat: () => void;
}) {
  const hasTopic = subject.topics.length > 0;
  const steps = [
    {
      done: hasTopic, title: 'Make a topic',
      body: 'Topics split a subject into parts, like chapters or weeks (e.g. “Motion” in Physics).',
      action: <button className={`btn btn-sm${hasTopic ? '' : ' btn-primary'}`} onClick={onNewTopic}>{hasTopic ? 'Add another topic' : 'New topic'}</button>,
    },
    {
      done: false, title: 'Add your material',
      body: 'Lecture slides, notes, handouts and textbooks: PDF, PowerPoint, Word, images or text. Apollo reads them in the background.',
      action: <button className={`btn btn-sm${hasTopic ? ' btn-primary' : ''}`} onClick={onAddFiles}>Add files</button>,
    },
    {
      done: false, title: 'Study with Apollo',
      body: 'Ask questions about your material, or have Apollo make flashcards, quizzes, practice exams, notes, cheat sheets and mind maps.',
      action: <button className="btn btn-sm" onClick={onOpenChat}>Open the chat</button>,
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <div className="getting-started">
      <div className="gs-card">
        <div className="gs-kicker">Getting started</div>
        <h2 className="gs-title">Set up {subject.name}</h2>
        <ol className="gs-steps">
          {steps.map((s, i) => (
            <li key={s.title} className={`gs-step${s.done ? ' done' : ''}${i === next ? ' next' : ''}`}>
              <span className="gs-num" aria-hidden>{s.done ? <Icon name="check" size={15} strokeWidth={2.6} /> : i + 1}</span>
              <div className="gs-main">
                <div className="gs-step-title">{s.title}</div>
                <div className="gs-body">{s.body}</div>
                {!s.done && <div className="gs-action">{s.action}</div>}
              </div>
            </li>
          ))}
        </ol>
        <div className="muted small gs-foot">Drag files from File Explorer into this window at any time. The <b>?</b> button in the left bar lists every shortcut.</div>
      </div>
    </div>
  );
}
