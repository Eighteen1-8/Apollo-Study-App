/* A small note over the document viewer when a Word or PowerPoint file is shown in the simplified layout because no
   exact PDF copy could be made (render.py: Office or LibreOffice missing or failing), with the reason and Try again.
   Nothing shows for PDFs, images or Office files that have their copy. */
import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import ErrorText from './ErrorText';
import Icon from './Icon';

export default function RenderNote({ id, onRendered }: { id: number; onRendered: () => void }) {
  const state = usePoll(() => api.renderState(id), 0, [id], ['documents']);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reason = err ?? state.data?.render_error;
  if (hidden || !state.data?.office || state.data.pdf || !reason) return null;

  const retry = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.retryRender(id);
      if (r.ok) onRendered();
      else setErr(r.render_error);
      state.reload();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="render-note" role="status">
      <Icon name="info" size={15} />
      <span className="render-note-text">Showing a simplified layout. <ErrorText text={reason} /></span>
      <button className="btn btn-sm" disabled={busy} onClick={retry}>{busy ? 'Trying… (can take a minute)' : 'Try again'}</button>
      <button className="x-btn" aria-label="Hide this note" title="Hide" onClick={() => setHidden(true)}><Icon name="close" size={13} /></button>
    </div>
  );
}
