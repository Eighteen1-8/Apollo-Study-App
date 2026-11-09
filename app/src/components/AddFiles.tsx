/* "Add files": asks what the files are before picking them, so a student never has to know the difference between a
   topic, the textbook library and a one-off chat attachment up front. */
import { Subject, Topic } from '../api';
import { useTerms } from '../terms';
import { Modal } from './overlay';
import Icon from './Icon';

export default function AddFilesDialog({ subject, onTopic, onNewTopic, onReference, onChat, onClose }: {
  subject: Subject; onTopic: (t: Topic) => void; onNewTopic: () => void; onReference: () => void; onChat: () => void; onClose: () => void;
}) {
  const tr = useTerms();
  const topics = subject.topics;
  return (
    <Modal title="What are you adding?" onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Cancel</button>}>
      <div className="addf">
        <div className="addf-card">
          <div className="addf-icon" aria-hidden><Icon name="topic" size={24} /></div>
          <div className="addf-main">
            <div className="addf-title">Lecture slides, notes or handouts</div>
            <div className="addf-sub">Saved in a topic. Apollo uses them to answer questions and make study material for that topic.</div>
            <div className="addf-choices">
              {topics.map((t) => <button key={t.id} className="btn btn-sm" onClick={() => onTopic(t)}>Add to {t.name}</button>)}
              <button className={`btn btn-sm${topics.length ? '' : ' btn-primary'}`} onClick={onNewTopic}>+ New topic…</button>
            </div>
          </div>
        </div>
        <button className="addf-card addf-btn" onClick={onReference}>
          <div className="addf-icon" aria-hidden><Icon name="textbook" size={24} /></div>
          <div className="addf-main">
            <div className="addf-title">A textbook or reference</div>
            <div className="addf-sub">Saved in {tr('references')} for the whole subject. Apollo looks up the relevant pages for every question.</div>
          </div>
        </button>
        <button className="addf-card addf-btn" onClick={onChat}>
          <div className="addf-icon" aria-hidden><Icon name="chat" size={24} /></div>
          <div className="addf-main">
            <div className="addf-title">Just for one question</div>
            <div className="addf-sub">Attached to your next chat message only. Not saved to your library.</div>
          </div>
        </button>
      </div>
      <div className="muted small addf-tip">Tip: you can also drag files from File Explorer straight into the window.</div>
    </Modal>
  );
}
