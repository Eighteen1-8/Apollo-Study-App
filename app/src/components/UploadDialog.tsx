import { useState } from 'react';
import { api, inElectron, VisionMode } from '../api';
import { Modal } from './overlay';

const MODE_HELP: Record<VisionMode, string> = {
  auto: 'Apollo reads slides/pages that look visual (2+ images, big figures, diagrams, scans).',
  all: 'Apollo reads every slide/page. Slowest, most thorough.',
  off: 'Text only. You can run vision later from the file view.',
};

export function droppedPaths(e: React.DragEvent): string[] {
  if (!window.studyApp) return [];
  return Array.from(e.dataTransfer.files).map((f) => window.studyApp!.pathForFile(f)).filter(Boolean);
}

/** Upload files to a topic (topic_id) or to the subject's reference library (subject_id). */
export default function UploadDialog({ title, target, defaultMode, initialPaths, onClose, onDone }: {
  title: string; target: { topic_id?: number; subject_id?: number }; defaultMode: VisionMode;
  initialPaths?: string[]; onClose: () => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<VisionMode>(defaultMode);
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
              <button className="x-btn" onClick={() => setPaths(paths.filter((x) => x !== p))}>×</button>
            </div>
          ))}
        </div>
      )}
      <label className="field">
        <span className="field-label">Vision</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as VisionMode)}>
          <option value="auto">Auto</option>
          <option value="all">Every page/slide</option>
          <option value="off">Skip vision</option>
        </select>
        <span className="field-help">{MODE_HELP[mode]}</span>
      </label>
      {messages.map((m, i) => (
        <div key={i} className={`small ${m.status === 'error' ? 'bad' : 'muted'}`}>
          {m.filename && <b>{m.filename}: </b>}{m.status === 'duplicate' ? `skipped (exact duplicate). ${m.message}` : m.message}
        </div>
      ))}
    </Modal>
  );
}
