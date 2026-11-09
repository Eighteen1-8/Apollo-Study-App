/* Choose a subject's icon: ~100 Lucide icons grouped by subject, with a search over icon and subject names. */
import { useMemo, useState } from 'react';
import { Subject } from '../api';
import { Modal } from './overlay';
import { SUBJECT_ICON_GROUPS } from './subjectIcons';

export default function IconPicker({ subject, onPick, onClose }: {
  subject: Subject; onPick: (key: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return SUBJECT_ICON_GROUPS;
    return SUBJECT_ICON_GROUPS.map((g) => g.subject.toLowerCase().includes(t) ? g
      : { ...g, icons: g.icons.filter(([k]) => k.includes(t)) }).filter((g) => g.icons.length);
  }, [q]);
  return (
    <Modal title={`Icon for ${subject.name}`} wide onClose={onClose}>
      <input className="input icon-pick-search" autoFocus placeholder="Search (e.g. chemistry, atom)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="icon-pick">
        {groups.map((g) => (
          <section key={g.subject} className="icon-pick-group">
            <h4>{g.subject}</h4>
            <div className="icon-pick-row">
              {g.icons.map(([key, I]) => (
                <button key={key} className={`icon-pick-btn${subject.icon_name === key ? ' on' : ''}`} title={key.replace(/-/g, ' ')}
                  aria-label={key.replace(/-/g, ' ')} style={{ background: subject.color }}
                  onClick={() => { onPick(key); onClose(); }}>
                  <I size={20} strokeWidth={2} />
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="muted">No icons match.</p>}
      </div>
    </Modal>
  );
}
