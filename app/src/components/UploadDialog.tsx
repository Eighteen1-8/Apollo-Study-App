import { useState } from 'react';
import { api, inElectron, VisionMode } from '../api';
import { Modal } from './overlay';
import { term, useTerms } from '../terms';
import { toast } from './toast';
import Icon from './Icon';
import ErrorText from './ErrorText';
import Info from './Info';

const MODE_HELP: Record<VisionMode, string> = {
  auto: 'Apollo reads slides/pages that look visual (2+ images, big figures, diagrams, scans).',
  all: 'Apollo reads every slide/page. Slowest, most thorough.',
  off: 'Text only. You can run vision later from the file view.',
};
const MODE_HELP_PLAIN: Record<VisionMode, string> = {
  auto: 'Apollo looks at the pictures, diagrams and scans on pages that need it. A few seconds per such page.',
  all: 'Apollo looks at every page. Best for scanned or very visual material, but takes much longer.',
  off: 'Only the text is used. Fastest; you can have Apollo read the pictures later from the file’s menu.',
};

/** The "read pictures" choice every way of adding files starts on (dialogs, drops onto topics/textbooks, the drop
 *  overlay). Files keep the mode they were added with (re-ingest and moves don't change it). */
export const DEFAULT_VISION: VisionMode = 'auto';

/** What a toast says once files are queued. */
export const addedNotice = (n: number) =>
  `Adding ${n} file${n === 1 ? '' : 's'}. Apollo reads ${n === 1 ? 'it' : 'them'} in the background: you can ask about ${n === 1 ? 'it' : 'them'} once the progress bar finishes.`;

/** The "read pictures" choice for an upload, with what each option means. */
export function VisionSelect({ mode, setMode }: { mode: VisionMode; setMode: (m: VisionMode) => void }) {
  const tr = useTerms();
  const help = tr('vision') === 'Vision' ? MODE_HELP : MODE_HELP_PLAIN;
  return (
    <label className="field">
      <span className="field-label">{tr('vision')} <Info text="Apollo can look at the pictures, diagrams and scanned pages in your files, not just their text. It's slower, so by default it only looks where the text alone isn't enough." /></span>
      <select value={mode} onChange={(e) => setMode(e.target.value as VisionMode)}>
        <option value="auto">{tr('visionAuto')}</option>
        <option value="all">{tr('visionAll')}</option>
        <option value="off">{tr('visionOff')}</option>
      </select>
      <span className="field-help">{help[mode]}</span>
    </label>
  );
}

export function droppedPaths(e: React.DragEvent): string[] {
  if (!window.studyApp) return [];
  return Array.from(e.dataTransfer.files).map((f) => window.studyApp!.pathForFile(f)).filter(Boolean);
}

/** Upload files to a topic (topic_id) or to the subject's reference library (subject_id). */
export default function UploadDialog({ title, target, defaultMode, initialPaths, onClose, onDone }: {
  title: string; target: { topic_id?: number; subject_id?: number }; defaultMode?: VisionMode;
  initialPaths?: string[]; onClose: () => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<VisionMode>(defaultMode ?? DEFAULT_VISION);
  const [paths, setPaths] = useState<string[]>(initialPaths ?? []);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<{ filename: string; status: string; message?: string }[]>([]);

  const add = (more: string[]) => setPaths((p) => [...p, ...more.filter((x) => !p.includes(x))]);
  const upload = async () => {
    setBusy(true);
    try {
      const res = await api.upload({ ...target, paths, vision_mode: mode });
      onDone();
      const problems = res.filter((r) => r.status !== 'queued');
      const added = res.length - problems.length;
      if (added) toast(addedNotice(added));
      if (problems.length) { setMessages(problems); setPaths([]); } else onClose();
    } catch (e) {
      setMessages([{ filename: '', status: 'error', message: String(e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>{messages.length ? 'Close' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={!paths.length || busy} onClick={upload}>
          {busy ? 'Adding…' : `Add ${paths.length || ''} file${paths.length === 1 ? '' : 's'}`}
        </button>
      </>}>
      <div className={`dropzone${drag ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(droppedPaths(e)); }}>
        <div className="dropzone-title">Drop files here</div>
        <div className="muted small">PDF, PowerPoint (.pptx), Word (.docx), images, text/markdown</div>
        <button className="btn" disabled={!inElectron} onClick={async () => add(await window.studyApp!.openFiles())}>Browse…</button>
        {!inElectron && <div className="small bad">Uploading needs the desktop app.</div>}
      </div>
      {paths.length > 0 && (
        <div className="pending-files">
          {paths.map((p) => (
            <div key={p} className="pending-file">
              <span title={p}>{p.split(/[\\/]/).pop()}</span>
              <button className="x-btn" title="Remove from the list" onClick={() => setPaths(paths.filter((x) => x !== p))}><Icon name="close" size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <VisionSelect mode={mode} setMode={setMode} />
      {messages.map((m, i) => (
        <div key={i} className={`small ${m.status === 'error' ? 'bad' : 'muted'}`}>
          {m.filename && <b>{m.filename}: </b>}{m.status === 'duplicate' ? `skipped (${term('vision') === 'Vision' ? 'exact duplicate' : 'already added'}). ${m.message}` : <ErrorText text={m.message} />}
        </div>
      ))}
    </Modal>
  );
}
