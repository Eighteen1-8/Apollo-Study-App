import { useEffect, useState } from 'react';
import { api, Settings } from '../api';
import { useOverlay } from '../components/overlay';
import { Button } from '../components/ui';
import { ACCENTS, THEMES, useAppearance } from '../theme';

type Field = {
  key: string; label: string; type: 'text' | 'password' | 'number' | 'bool' | 'select' | 'reasoning' | 'list';
  help?: string; options?: string[];
};

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Language model (the model behind Apollo, via ninfer)',
    fields: [
      { key: 'llm_base_url', label: 'Base URL', type: 'text' },
      { key: 'llm_model', label: 'Model id', type: 'text' },
      { key: 'llm_api_key', label: 'API key', type: 'password', help: 'Optional. Stored only on this computer.' },
      { key: 'llm_context', label: 'Context window (tokens)', type: 'number' },
      { key: 'llm_concurrency', label: 'Max simultaneous requests', type: 'number', help: 'Keep at 1 unless the server is started with higher concurrency.' },
    ],
  },
  {
    title: 'Reasoning (how much Apollo thinks)',
    fields: [
      { key: 'reasoning_levels', label: 'Reasoning levels the model supports', type: 'list',
        help: 'Comma-separated, lowest first. The current model supports low, medium, xhigh. Shown in the chat Reasoning menu.' },
      { key: 'chat_reasoning_default', label: 'Chat default', type: 'reasoning', help: 'The chat remembers what you last picked.' },
      { key: 'vision_reasoning', label: 'Vision (reading slides/pages)', type: 'reasoning' },
      { key: 'generation_reasoning', label: 'Generating flashcards, quizzes, exams, notes', type: 'reasoning' },
      { key: 'marking_reasoning', label: 'Marking exams', type: 'reasoning' },
      { key: 'review_reasoning', label: 'Quiz review', type: 'reasoning' },
    ],
  },
  {
    title: 'Embedding model (LM Studio)',
    fields: [
      { key: 'embed_base_url', label: 'Base URL', type: 'text' },
      { key: 'embed_model', label: 'Model id', type: 'text', help: 'Changing this requires re-ingesting documents.' },
      { key: 'embed_api_key', label: 'API key', type: 'password' },
      { key: 'embed_batch', label: 'Batch size', type: 'number' },
    ],
  },
  {
    title: 'Vision',
    fields: [
      { key: 'vision_default_topic', label: 'Default for topic material', type: 'select', options: ['auto', 'all', 'off'] },
      { key: 'vision_default_reference', label: 'Default for textbooks', type: 'select', options: ['all', 'auto', 'off'] },
      { key: 'vision_min_images', label: 'Slides: images needed to trigger vision', type: 'number' },
      { key: 'vision_big_image_area', label: 'Slides: single image area that triggers vision (0–1)', type: 'number' },
      { key: 'vision_low_text_words', label: 'Slides: "little text" threshold (words)', type: 'number' },
      { key: 'vision_pdf_figure_area', label: 'PDF: figure area that triggers vision (0–1)', type: 'number' },
      { key: 'vision_pdf_vector_paths', label: 'PDF: vector paths that count as a diagram', type: 'number' },
    ],
  },
  {
    title: 'Ingest',
    fields: [
      { key: 'dedupe_units', label: 'Skip exact duplicate slides/pages/sections (exact text match)', type: 'bool' },
      { key: 'strip_repeated_pdf_lines', label: 'Remove PDF lines repeated identically on ≥50% of pages (headers/footers)', type: 'bool' },
      { key: 'chunk_target_tokens', label: 'Chunk size (tokens)', type: 'number' },
      { key: 'chunk_max_slides', label: 'Max slides per chunk', type: 'number' },
    ],
  },
];

const DIALS: { key: string; label: string; levels: [string, string, string]; help: string }[] = [
  { key: 'chat_assistive', label: 'Assistive', levels: ['Answer only', 'Show the method', 'Teach every step'],
    help: 'How much Apollo shows how to solve a problem rather than just giving the result.' },
  { key: 'chat_concise', label: 'Length', levels: ['Detailed', 'Balanced', 'Concise'],
    help: 'How long and wordy answers are.' },
  { key: 'chat_interactive', label: 'Interactive', levels: ['Direct answers', 'Check understanding', 'Guide with questions'],
    help: 'At the top level Apollo breaks a problem into smaller questions for you to answer instead of giving the answer straight away.' },
];

/** Theme, accent, motion and the home cloud. Saved instantly on this computer (not with the Save button). */
function AppearanceSettings() {
  const [a, set] = useAppearance();
  return (
    <section className="section">
      <h2>Appearance</h2>
      <div className="form appearance">
        <div className="field field-wide">
          <span className="field-label">Theme</span>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} className={`theme-card${a.theme === t.id ? ' on' : ''}`} onClick={() => set({ theme: t.id })}>
                <span className="theme-preview" style={{ background: t.swatch[0] }}>
                  <span className="tp-bar" style={{ background: t.swatch[1] }} />
                  <span className="tp-panel" style={{ background: t.swatch[1] }}>
                    <span className="tp-line" style={{ background: a.accent ?? t.swatch[2] }} />
                    <span className="tp-line short" style={{ background: t.light ? '#0002' : '#fff2' }} />
                  </span>
                  <span className="tp-orb" style={{ background: a.accent ?? t.swatch[2], color: a.accent ?? t.swatch[2] }} />
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-blurb">{t.blurb}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field field-wide">
          <span className="field-label">Accent</span>
          <div className="accent-row">
            <button className={`accent-swatch accent-auto${a.accent === null ? ' on' : ''}`} onClick={() => set({ accent: null })} title="Theme default">Auto</button>
            {ACCENTS.map((c) => (
              <button key={c} className={`accent-swatch${a.accent === c ? ' on' : ''}`} style={{ background: c, color: c }} onClick={() => set({ accent: c })} title={c} />
            ))}
            <label className="accent-swatch accent-custom" title="Custom colour">
              <input type="color" value={a.accent ?? '#8b9bff'} onChange={(e) => set({ accent: e.target.value })} />+
            </label>
          </div>
        </div>
        <label className="field field-bool">
          <input type="checkbox" checked={a.motion === 'reduced'} onChange={(e) => set({ motion: e.target.checked ? 'reduced' : 'full' })} />
          <span>Reduce motion (turns off most animations; also follows the Windows setting)</span>
        </label>
        <label className="field field-bool">
          <input type="checkbox" checked={a.cloud} onChange={(e) => set({ cloud: e.target.checked })} />
          <span>Show the 3D knowledge cloud on the home page</span>
        </label>
      </div>
    </section>
  );
}

/** The tutor's rules (editable, {scope} = the subject/topic) and personality dials. */
function TutorSettings({ s, set }: { s: Settings; set: (k: string, v: string | number) => void }) {
  const [def, setDef] = useState('');
  useEffect(() => { api.defaultPrompt().then((r) => setDef(r.prompt)).catch(() => {}); }, []);
  const custom = String(s.chat_system_prompt ?? '');
  return (
    <section className="section">
      <h2>Chat tutor</h2>
      <div className="form">
        <div className="field">
          <span className="field-label">Personality</span>
          <div className="dials">
            {DIALS.map((d) => {
              const v = Math.max(0, Math.min(2, Number(s[d.key] ?? 1)));
              return (
                <div key={d.key} className="dial" title={d.help}>
                  <div className="dial-head"><span>{d.label}</span><b>{d.levels[v]}</b></div>
                  <input type="range" min={0} max={2} step={1} value={v} onChange={(e) => set(d.key, Number(e.target.value))} />
                  <div className="dial-ticks">{d.levels.map((l) => <span key={l}>{l}</span>)}</div>
                </div>
              );
            })}
          </div>
        </div>
        <label className="field">
          <span className="field-label">System prompt</span>
          <textarea className="input prompt-edit" rows={12} spellCheck={false} value={custom || def}
            onChange={(e) => set('chat_system_prompt', e.target.value === def ? '' : e.target.value)} />
          <span className="field-help">
            The tutor's rules. <code>{'{scope}'}</code> becomes the subject and topic. The personality settings above and the
            rules for creating content and to-dos are added after it automatically.{' '}
            {custom && <button className="link-btn" onClick={() => set('chat_system_prompt', '')}>Reset to default</button>}
          </span>
        </label>
        <label className="field">
          <span className="field-label">Word limit for files sent straight to the chat</span>
          <input className="input" type="number" value={String(s.chat_file_word_limit ?? 12000)}
            onChange={(e) => set('chat_file_word_limit', Number(e.target.value))} />
          <span className="field-help">Longer files must be added to a topic or the reference library (ingested) first.</span>
        </label>
      </div>
    </section>
  );
}

export default function SettingsView({ onSaved }: { onSaved: () => void }) {
  const ov = useOverlay();
  const [s, setS] = useState<Settings | null>(null);
  const [savedModel, setSavedModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.testSettings>> | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { api.settings().then((x) => { setS(x); setSavedModel(String(x.embed_model)); }); }, []);

  /** Changing the embedding model makes every stored vector unusable for search until files are re-ingested. */
  const save = async () => {
    if (!s) return;
    if (savedModel !== null && String(s.embed_model) !== savedModel) {
      const { documents } = await api.embeddingStatus(String(s.embed_model));
      if (documents > 0 && !(await ov.confirm({
        title: 'Change the embedding model?', confirmText: 'Change model', danger: true,
        body: <>All {documents} ingested file{documents === 1 ? '' : 's'} will need to be re-ingested before search can use them with
          “{String(s.embed_model)}”. Subjects and topics with files to re-ingest get a red <b>!</b> mark; click it to re-ingest.
          The marks go away after re-ingesting, or if you change the model back to “{savedModel}”.</>,
      }))) return;
    }
    const next = await api.saveSettings(s);
    setS(next);
    setSavedModel(String(next.embed_model));
    setSaved(true);
    onSaved();
  };
  if (!s) return <div className="page" />;

  const set = (k: string, v: string | number | boolean | string[]) => { setS({ ...s, [k]: v }); setSaved(false); };
  const levels = Array.isArray(s.reasoning_levels) ? (s.reasoning_levels as string[]) : ['low', 'medium', 'xhigh'];

  return (
    <div className="page settings">
      <header className="page-head">
        <div><h1>Settings</h1><p className="muted">All endpoints are local. Nothing leaves this computer.</p></div>
        <div className="head-actions">
          <Button onClick={async () => { setTesting(true); try { setTest(await api.testSettings()); } finally { setTesting(false); } }}>
            {testing ? 'Testing…' : 'Test connections'}
          </Button>
          <Button kind="primary" onClick={save}>{saved ? 'Saved ✓' : 'Save'}</Button>
        </div>
      </header>

      {test && (
        <div className="test-results">
          {Object.entries(test).map(([k, r]) => (
            <div key={k} className={`banner ${r.ok ? 'banner-ok' : 'banner-bad'}`}>
              <b>{k === 'llm' ? 'Apollo (language model)' : 'Embeddings'}:</b>{' '}
              {r.ok ? (k === 'llm' ? `connected · context ${r.max_model_len?.toLocaleString()} · ${r.ms} ms` : `connected · ${r.dim}-dim vectors · ${r.ms} ms`) : r.error}
            </div>
          ))}
        </div>
      )}

      <AppearanceSettings />
      <TutorSettings s={s} set={set} />

      {GROUPS.map((g) => (
        <section key={g.title} className="section">
          <h2>{g.title}</h2>
          <div className="form">
            {g.fields.map((f) => (
              <label key={f.key} className={`field${f.type === 'bool' ? ' field-bool' : ''}`}>
                {f.type === 'bool' ? (
                  <>
                    <input type="checkbox" checked={!!s[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
                    <span>{f.label}</span>
                  </>
                ) : (
                  <>
                    <span className="field-label">{f.label}</span>
                    {f.type === 'select' ? (
                      <select value={String(s[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                        {f.options!.map((o) => <option key={o} value={o}>{o === 'all' ? 'Every page/slide' : o === 'auto' ? 'Auto' : 'Off'}</option>)}
                      </select>
                    ) : f.type === 'reasoning' ? (
                      <select value={String(s[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                        {['off', ...levels].map((o) => <option key={o} value={o}>{o === 'off' ? 'Off (no thinking)' : o}</option>)}
                      </select>
                    ) : f.type === 'list' ? (
                      <input className="input" defaultValue={levels.join(', ')}
                        onBlur={(e) => set(f.key, e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
                    ) : (
                      <input className="input" type={f.type === 'number' ? 'number' : f.type} step="any" value={String(s[f.key] ?? '')}
                        onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} />
                    )}
                  </>
                )}
                {f.help && <span className="field-help">{f.help}</span>}
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
