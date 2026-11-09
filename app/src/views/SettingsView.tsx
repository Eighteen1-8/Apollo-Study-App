import { useEffect, useState } from 'react';
import ErrorText from '../components/ErrorText';
import { api, OpenRouterModel, ServerProfile, Settings } from '../api';
import type { SettingsTab } from '../App';
import MaintenanceView from './MaintenanceView';
import ShareView from './ShareView';
import { useOverlay } from '../components/overlay';
import { Button } from '../components/ui';
import { ACCENTS, CLOUD_FPS, TEXT_SIZES, useAdvanced, useAppearance } from '../theme';
import { MotionSeg, ThemeGrid } from '../components/AppearancePickers';
import { logError } from '../log';

type Field = {
  key: string; label: string; type: 'text' | 'password' | 'number' | 'bool' | 'select' | 'reasoning' | 'list';
  help?: string; options?: string[];
};

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Local language model (the model behind Apollo, via ninfer)',
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
      { key: 'audit_reasoning', label: 'Checking vision notes (Maintenance)', type: 'reasoning' },
    ],
  },
  {
    title: 'Local embedding model (LM Studio)',
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

/** The tutor's personality dials (Settings → Chat tutor, and the first-run setup). */
export function PersonalityDials({ s, set, help }: { s: Settings; set: (k: string, v: number) => void; help?: boolean }) {
  return (
    <div className="dials">
      {DIALS.map((d) => {
        const v = Math.max(0, Math.min(2, Number(s[d.key] ?? 1)));
        return (
          <div key={d.key} className="dial" title={d.help}>
            <div className="dial-head"><span>{d.label}</span><b>{d.levels[v]}</b></div>
            <input type="range" min={0} max={2} step={1} value={v} aria-label={d.label} onChange={(e) => set(d.key, Number(e.target.value))} />
            <div className="dial-ticks">{d.levels.map((l) => <span key={l}>{l}</span>)}</div>
            {help && <small className="dial-help">{d.help}</small>}
          </div>
        );
      })}
    </div>
  );
}

export const ONLINE_WARNING = <>
  Your messages, uploaded material, page images and generated content will be sent to <b>OpenRouter</b> and the
  model provider behind it. They will be <b>logged on external servers</b> and <b>may be used for training or other
  purposes</b>, especially with free models. Nothing is private once it is sent. Choose <b>Local</b> to keep everything on
  this computer.
</>;

const ONLINE_FIELDS: Field[] = [
  { key: 'openrouter_api_key', label: 'OpenRouter API key', type: 'password', help: 'Stored only on this computer.' },
  { key: 'openrouter_base_url', label: 'Base URL', type: 'text' },
  { key: 'openrouter_model', label: 'Chat model id', type: 'text', help: 'e.g. google/gemma-4-26b-a4b-it:free' },
  { key: 'openrouter_embed_model', label: 'Embedding model id', type: 'text', help: 'Changing embeddings requires re-ingesting documents.' },
  { key: 'openrouter_context', label: 'Context window (tokens)', type: 'number' },
  { key: 'openrouter_concurrency', label: 'Max simultaneous requests', type: 'number', help: 'Free models are rate limited; keep this low.' },
];

/** What the probe found, in words. */
const profileText = (p: ServerProfile) => [
  p.reasoning_levels.length ? `reasoning ${p.reasoning_levels.join(' / ')}` : 'no reasoning levels',
  p.thinking_switch === 'template' ? 'thinking on/off' : 'no thinking switch',
  p.tools ? 'tool calls' : 'no tool calls',
  p.stream_usage ? 'token counts' : 'no token counts',
  p.json_schema ? 'JSON schemas' : 'no JSON schemas (the schema goes in the prompt)',
].join(', ');

/** OpenRouter's current chat models as suggestions for the model field (free ones first), loaded on request. */
export function OpenRouterModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true); setError(null);
    try { setModels(await api.openrouterModels()); } catch (e) { setError(String(e).replace(/^Error: /, '')); } finally { setLoading(false); }
  };
  const known = models?.find((m) => m.id === value);
  return (
    <label className="field">
      <span className="field-label">Chat model id</span>
      <div className="row-inline">
        <input className="input" list="openrouter-models" value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. google/gemma-4-26b-a4b-it:free" />
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>{loading ? 'Loading…' : models ? 'Reload list' : 'Choose from list'}</button>
      </div>
      <datalist id="openrouter-models">
        {models?.map((m) => <option key={m.id} value={m.id}>{`${m.name}${m.free ? ' · free' : ''}${m.context ? ` · ${Math.round(m.context / 1000)}k` : ''}${m.vision ? ' · images' : ''}`}</option>)}
      </datalist>
      <span className="field-help">
        {error ?? (models ? (known ? `${known.name}${known.free ? ' (free)' : ''}, context ${known.context?.toLocaleString() ?? '?'} tokens${known.vision ? ', reads images' : ''}.`
          : value ? 'Not in OpenRouter’s current list: it may have been retired. Pick another.' : `${models.length} models; free ones first.`)
          : 'Free models come and go; choose from OpenRouter’s current list.')}
      </span>
    </label>
  );
}

/** Where the models run: local servers (default) or OpenRouter, chosen separately for chat and embeddings. */
function ProviderSettings({ s, set }: { s: Settings; set: (k: string, v: string | number) => void }) {
  const ov = useOverlay();
  const online = s.llm_provider === 'openrouter' || s.embed_provider === 'openrouter';
  const choose = async (key: 'llm_provider' | 'embed_provider', v: string) => {
    if (v === 'openrouter' && s[key] !== 'openrouter' && !(await ov.confirm({
      title: 'Use an online model?', confirmText: 'I understand, use OpenRouter', danger: true, body: ONLINE_WARNING,
    }))) return;
    set(key, v);
  };
  const row = (key: 'llm_provider' | 'embed_provider', label: string, help: string) => (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="seg provider-seg">
        <button className={s[key] !== 'openrouter' ? 'active' : ''} onClick={() => choose(key, 'local')}>Local (private)</button>
        <button className={s[key] === 'openrouter' ? 'active online' : ''} onClick={() => choose(key, 'openrouter')}>OpenRouter (online)</button>
      </div>
      <span className="field-help">{help}</span>
    </div>
  );
  return (
    <section className="section">
      <h2>Model provider</h2>
      {online && <div className="banner banner-warn online-banner"><b>Online models are on.</b> {ONLINE_WARNING}</div>}
      <div className="form">
        {row('llm_provider', 'Chat, generation, vision and marking', 'Local uses the language model settings below.')}
        {row('embed_provider', 'Embeddings (search)', 'Files embedded with the other model must be re-ingested before search uses them.')}
        {online && ONLINE_FIELDS.map((f) => f.key === 'openrouter_model' ? (
          <OpenRouterModelField key={f.key} value={String(s[f.key] ?? '')} onChange={(v) => set(f.key, v)} />
        ) : (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}</span>
            <input className="input" type={f.type === 'number' ? 'number' : f.type} value={String(s[f.key] ?? '')}
              onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} />
            {f.help && <span className="field-help">{f.help}</span>}
          </label>
        ))}
      </div>
    </section>
  );
}

/** Children shown as they are in advanced mode, and folded behind a summary otherwise. */
function Expert({ open, summary, children }: { open: boolean; summary: string; children: React.ReactNode }) {
  if (open) return <>{children}</>;
  return <details className="expert"><summary>{summary}</summary><div className="form">{children}</div></details>;
}

/** Advanced mode: technical terms and every power-user control. Saved instantly on this computer. */
function ModeSettings() {
  const [a, set] = useAppearance();
  return (
    <section className="section mode-section">
      <h2>Mode</h2>
      <div className="seg mode-seg">
        <button className={a.advanced ? '' : 'active'} onClick={() => set({ advanced: false })}>Standard</button>
        <button className={a.advanced ? 'active' : ''} onClick={() => set({ advanced: true })}>Advanced</button>
      </div>
      <p className="field-help mode-help">{a.advanced
        ? 'Advanced mode shows technical terms (ingest, embeddings, vision, tokens), the context meter, Maintenance, vision checks, every model and tuning setting, and the map-first subject layout where a click narrows the map and a double-click opens a file.'
        : 'Standard mode uses plain words, guides you through setting up each subject and keeps the technical settings folded away. Switch to Advanced for the full set of power-user tools.'}</p>
    </section>
  );
}

/** Theme, accent, motion and the home cloud. Saved instantly on this computer (not with the Save button). */
function AppearanceSettings() {
  const [a, set] = useAppearance();
  return (
    <section className="section">
      <h2>Appearance</h2>
      <div className="form appearance">
        <div className="field field-wide">
          <span className="field-label">Text size</span>
          <div className="seg text-size-seg">
            {TEXT_SIZES.map((t) => (
              <button key={t.id} className={a.textSize === t.id ? 'active' : ''} onClick={() => set({ textSize: t.id })}
                style={{ fontSize: `${Math.round(13 * t.zoom)}px` }}>{t.label}</button>
            ))}
          </div>
          <span className="field-help">Makes everything in the window bigger. Applies straight away.</span>
        </div>
        <div className="field field-wide">
          <span className="field-label">Theme</span>
          <ThemeGrid />
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
        <div className="field field-wide">
          <span className="field-label">Animations</span>
          <MotionSeg />
        </div>
        <label className="field field-bool">
          <input type="checkbox" checked={a.cloud} onChange={(e) => set({ cloud: e.target.checked })} />
          <span>Show the 3D knowledge cloud (home page background, and each subject's map)</span>
        </label>
        <label className="field field-bool">
          <input type="checkbox" checked={a.cloudDrift} disabled={!a.cloud || a.motion === 'off'} onChange={(e) => set({ cloudDrift: e.target.checked })} />
          <span>Let the cloud drift and twinkle while idle (off: it only redraws while you move it, which saves power)</span>
        </label>
        <label className="field">
          <span className="field-label">Knowledge cloud frame rate</span>
          <select className="input" value={a.cloudFps} disabled={!a.cloud} onChange={(e) => set({ cloudFps: Number(e.target.value) })}>
            {CLOUD_FPS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <span className="field-help">Higher is smoother on a fast computer; 30 is easier on a laptop. Applies straight away.</span>
        </label>
      </div>
    </section>
  );
}

const SPELL_NAMES: Record<string, string> = { 'en-AU': 'English (Australia)', 'en-GB': 'English (UK)', 'en-US': 'English (US)', 'en-CA': 'English (Canada)' };

/** The spell-check language (notes, the chat box, every text field). Kept on this computer, applied at once. */
function SpellingSettings() {
  const spell = window.studyApp?.spell;
  const [info, setInfo] = useState<{ languages: string[]; available: string[] } | null>(null);
  useEffect(() => { spell?.info().then(setInfo).catch((e) => logError('spelling', e, 'warning')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = async (lang: string) => {
    if (!spell) return;
    await spell.set(lang ? [lang] : []);
    setInfo(await spell.info());
  };
  const current = info?.languages[0] ?? '';
  const missing = !!info && !!current && !info.available.includes(current);
  return (
    <section className="section">
      <h2>Spelling</h2>
      <div className="form">
        <label className="field">
          <span className="field-label">Spell-check language</span>
          <select value={current} disabled={!spell || !info} onChange={(e) => choose(e.target.value)}>
            {['en-AU', 'en-GB', 'en-US', ...(info?.available ?? []).filter((l) => !['en-AU', 'en-GB', 'en-US'].includes(l))].map((l) => (
              <option key={l} value={l} disabled={!!info && !info.available.includes(l)}>
                {SPELL_NAMES[l] ?? l}{info && !info.available.includes(l) ? ' (dictionary not installed)' : ''}
              </option>
            ))}
            <option value="">Off</option>
          </select>
          <span className="field-help">
            {!spell ? 'Spell check works in the desktop app.'
              : missing ? 'The dictionary for this language isn’t installed, so nothing is checked. Dictionaries are bundled with the app (app/assets/dictionaries) and never downloaded.'
              : 'Misspelled words are underlined in your notes, the chat box and other text fields. Right-click one for suggestions.'}
          </span>
        </label>
      </div>
    </section>
  );
}

/** The tutor's rules (editable, {scope} = the subject/topic) and personality dials. */
function TutorSettings({ s, set }: { s: Settings; set: (k: string, v: string | number | boolean) => void }) {
  const [def, setDef] = useState('');
  useEffect(() => { api.defaultPrompt().then((r) => setDef(r.prompt)).catch((e) => logError('default prompt', e, 'warning')); }, []);
  const custom = String(s.chat_system_prompt ?? '');
  const adv = useAdvanced();
  return (
    <section className="section">
      <h2>Chat tutor</h2>
      <div className="form">
        <div className="field">
          <span className="field-label">Personality</span>
          <PersonalityDials s={s} set={set} />
        </div>
        <Expert open={adv} summary="More tutor options (the tutor's rules, file size limit)">
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
        <label className="field field-bool">
          <input type="checkbox" checked={s.chat_auto_title !== false} onChange={(e) => set('chat_auto_title', e.target.checked)} />
          <span>Name new chats automatically after Apollo's first reply (a renamed chat keeps your name)</span>
        </label>
        <label className="field">
          <span className="field-label">Word limit for files sent straight to the chat</span>
          <input className="input" type="number" value={String(s.chat_file_word_limit ?? 12000)}
            onChange={(e) => set('chat_file_word_limit', Number(e.target.value))} />
          <span className="field-help">Longer files must be added to a topic or the reference library (ingested) first.</span>
        </label>
        </Expert>
      </div>
    </section>
  );
}

/** The embedding model new vectors are made with, given the provider choice (mirrors llm.embed_model()). */
const effectiveEmbedModel = (s: Settings) => String(s.embed_provider === 'openrouter' ? s.openrouter_embed_model : s.embed_model);

export default function SettingsView({ onSaved, tab: initialTab, subjectId }: { onSaved: () => void; tab?: SettingsTab; subjectId?: number }) {
  const ov = useOverlay();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const advanced = useAdvanced();
  const [dirty, setDirty] = useState(false);
  const [s, setS] = useState<Settings | null>(null);
  const [savedModel, setSavedModel] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.testSettings>> | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { api.settings().then((x) => { setS(x); setSavedModel(effectiveEmbedModel(x)); }); }, []);

  /** Changing the embedding model makes every stored vector unusable for search until files are re-ingested. */
  const save = async () => {
    if (!s) return;
    const model = effectiveEmbedModel(s);
    if (savedModel !== null && model !== savedModel) {
      const { documents } = await api.embeddingStatus(model);
      if (documents > 0 && !(await ov.confirm({
        title: 'Change the embedding model?', confirmText: 'Change model', danger: true,
        body: <>All {documents} ingested file{documents === 1 ? '' : 's'} will need to be re-ingested before search can use them with
          “{model}”. Subjects and topics with files to re-ingest get a red <b>!</b> mark; click it to re-ingest.
          The marks go away after re-ingesting, or if you change the model back to “{savedModel}”.</>,
      }))) return;
    }
    const next = await api.saveSettings(s);
    setS(next);
    setSavedModel(effectiveEmbedModel(next));
    setSaved(true);
    setDirty(false);
    onSaved();
  };
  const tabs = (
    <div className="seg settings-tabs">
      <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>General</button>
      {(advanced || tab === 'maintenance') && <button className={tab === 'maintenance' ? 'active' : ''} onClick={() => setTab('maintenance')}>Maintenance</button>}
      <button className={tab === 'share' ? 'active' : ''} onClick={() => setTab('share')}>Share</button>
    </div>
  );
  if (tab === 'share') return (
    <div className="page settings">
      <header className="page-head">
        <div><h1>Settings</h1><p className="muted">Share embedded files with classmates, or import theirs.</p></div>
        <div className="head-actions">{tabs}</div>
      </header>
      <ShareView subjectId={subjectId} onChanged={onSaved} />
    </div>
  );
  if (tab === 'maintenance') return (
    <div className="page settings">
      <header className="page-head">
        <div><h1>Settings</h1><p className="muted">Storage, the search index and vision notes for every subject, topic and file.</p></div>
        <div className="head-actions">{tabs}</div>
      </header>
      <MaintenanceView subjectId={subjectId} />
    </div>
  );
  if (!s) return <div className="page" />;

  const set = (k: string, v: string | number | boolean | string[]) => { setS({ ...s, [k]: v }); setSaved(false); setDirty(true); };
  const levels = Array.isArray(s.reasoning_levels) ? (s.reasoning_levels as string[]) : ['low', 'medium', 'xhigh'];
  const groups = <SettingsGroups s={s} set={set} levels={levels} />;

  return (
    <div className="page settings">
      <header className="page-head">
        <div><h1>Settings</h1><p className="muted">{s.llm_provider === 'openrouter' || s.embed_provider === 'openrouter'
          ? 'Some models run online through OpenRouter. See Model provider below.'
          : advanced ? 'All endpoints are local. Nothing leaves this computer.' : 'Everything runs on this computer. Nothing is sent anywhere.'}</p></div>
        <div className="head-actions">
          {tabs}
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
              <b>{k === 'llm' ? 'Apollo (language model)' : advanced ? 'Embeddings' : 'Search model'}{r.online ? ' · OpenRouter' : ''}:</b>{' '}
              {r.ok ? (!advanced ? 'working.' : k === 'llm' ? `connected · context ${r.max_model_len?.toLocaleString()} · ${r.ms} ms` : `connected · ${r.dim}-dim vectors · ${r.ms} ms`)
                : <ErrorText text={r.error} />}
              {advanced && r.profile && <div className="small test-profile">Server accepts: {profileText(r.profile)}. Saved, so requests follow it.</div>}
            </div>
          ))}
        </div>
      )}

      {dirty && (
        <div className="banner banner-warn unsaved-bar">
          <span>You have unsaved changes.</span>
          <Button kind="primary" small onClick={save}>Save</Button>
        </div>
      )}

      <ModeSettings />
      <AppearanceSettings />
      <TutorSettings s={s} set={set} />
      <SpellingSettings />
      <ProviderSettings s={s} set={set} />

      {advanced ? groups : (
        <details className="section expert expert-section">
          <summary><h2>Advanced: model connections and tuning</h2>
            <span className="muted small">Server addresses, how much Apollo thinks for each task, when it reads pictures, and how files are split up. The defaults work; change these only if you know you need to.</span></summary>
          {groups}
        </details>
      )}
    </div>
  );
}

function SettingsGroups({ s, set, levels }: { s: Settings; set: (k: string, v: string | number | boolean | string[]) => void; levels: string[] }) {
  return (
    <>
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
    </>
  );
}
