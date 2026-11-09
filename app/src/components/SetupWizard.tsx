/* First launch: where Apollo's models run (this computer or OpenRouter), their addresses or key, a connection check,
   how the app looks (theme, animations; saved at once), how Apollo teaches (the tutor's dials), then the first subject. Model names and tuning sit behind "Advanced setup" on both paths. Shows until finished or
   skipped (the `setup_done` setting); "Run setup again" in the help window opens it again. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, Settings } from '../api';
import { ONLINE_WARNING, OpenRouterModelField, PersonalityDials } from '../views/SettingsView';
import { MotionSeg, ThemeGrid } from './AppearancePickers';
import { setPref } from '../prefs';
import { logError } from '../log';
import Icon from './Icon';
import { errorText } from '../errors';
import ErrorText from './ErrorText';

type Step = 'where' | 'online' | 'local' | 'check' | 'look' | 'tutor' | 'subject';
type Test = Awaited<ReturnType<typeof api.testSettings>>;

let forced = false;
const listeners = new Set<() => void>();
/** Open the setup steps again (help window). */
export function openSetup() { forced = true; listeners.forEach((f) => f()); }
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** "127.0.0.1:8080" → "http://127.0.0.1:8080/v1": an address the way people write it, as the server's API URL. */
export function apiUrl(v: string) {
  let s = v.trim().replace(/\/+$/, '');
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.pathname === '/' || u.pathname === '') s = `${u.origin}/v1`;
  } catch { /* leave it as typed: the check will say it can't be reached */ }
  return s;
}

/** A connection error in plain words. */
function plain(err?: string | null) {
  const e = (err ?? '').toLowerCase();
  if (!e) return 'Something went wrong.';
  if (/refused|connect|unreachable|timed out|timeout|resolve|getaddrinfo|10061|max retries/.test(e)) return 'Couldn’t reach it. Is the model server running, and is the address right?';
  if (/401|403|unauthori[sz]ed|invalid api key|forbidden|no auth/.test(e)) return 'It answered, but turned the key down. Check the key.';
  if (/not found on server|isn.t offered/.test(e)) return 'It answered, but doesn’t have the model Apollo asked for. Pick one of its models below.';
  if (/paused/.test(e)) return 'Paused in the Activity list, so it wasn’t tested.';
  return err!.replace(/^Error: /, '');
}

export default function SetupWizard({ subjectsCount, onFinished }: {
  subjectsCount: number;
  /** Setup is over (`subjectId`: the subject just made, to open). */
  onFinished: (subjectId?: number) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState(false);
  const again = useSyncExternalStore(subscribe, () => forced);
  const [step, setStep] = useState<Step>('where');
  const [s, setS] = useState<Settings>({});
  const [advanced, setAdvanced] = useState(false);
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');

  useEffect(() => {
    api.settings().then((v) => { setSettings(v); setS(v); if (!v.setup_done) setOpen(true); }).catch((e) => logError('setup', e, 'warning'));
  }, []);
  useEffect(() => {
    if (!again) return;
    forced = false;
    api.settings().then((v) => { setSettings(v); setS(v); setStep('where'); setTest(null); setOpen(true); }).catch((e) => logError('setup', e, 'warning'));
  }, [again]);
  if (!open || !settings) return null;

  const online = step === 'online' || (step === 'check' && s.llm_provider === 'openrouter');
  const set = (k: string, v: string | number) => setS((x) => ({ ...x, [k]: v }));
  const str = (k: string) => String(s[k] ?? '');
  const finish = async (subjectId?: number) => {
    await api.saveSettings({ setup_done: true }).catch((e) => logError('setup', e));
    setPref('tourPending', '1');
    setOpen(false);
    onFinished(subjectId);
  };
  /** Save what was chosen, then try both models. */
  const check = async () => {
    setBusy(true); setErr(null); setTest(null);
    try {
      const keys = online
        ? ['openrouter_api_key', 'openrouter_base_url', 'openrouter_model', 'openrouter_embed_model', 'openrouter_context', 'openrouter_concurrency']
        : ['llm_base_url', 'llm_api_key', 'llm_model', 'llm_context', 'llm_concurrency', 'embed_base_url', 'embed_api_key', 'embed_model', 'embed_batch'];
      const body: Settings = Object.fromEntries(keys.map((k) => [k, k.endsWith('_base_url') ? apiUrl(str(k)) : s[k]]));
      const provider = online ? 'openrouter' : 'local';
      const saved = await api.saveSettings({ ...body, llm_provider: provider, embed_provider: provider });
      setS(saved);
      setStep('check');
      setTest(await api.testSettings());
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const makeSubject = async () => {
    const name = subject.trim();
    if (!name) return;
    setBusy(true); setErr(null);
    try {
      const sub = await api.createSubject(name);
      if (topic.trim()) await api.createTopic(sub.id, topic.trim());
      await finish(sub.id);
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const allOk = !!test?.llm?.ok && !!test?.embed?.ok;
  const field = (k: string, label: string, opts: { placeholder?: string; help?: string; secret?: boolean; number?: boolean } = {}) => (
    <label className="setup-field">
      <span>{label}</span>
      <input className="input" type={opts.secret ? 'password' : opts.number ? 'number' : 'text'} value={str(k)} placeholder={opts.placeholder}
        spellCheck={false} autoComplete="off"
        onChange={(e) => set(k, opts.number ? Number(e.target.value) : e.target.value)} />
      {opts.help && <small>{opts.help}</small>}
    </label>
  );
  const dots: Step[] = ['where', online ? 'online' : 'local', 'check', 'look', 'tutor', ...(subjectsCount ? [] : ['subject' as Step])];
  const at = step === 'online' || step === 'local' ? 1 : dots.indexOf(step);
  /** The tutor's dials are saved when leaving their page (onward or back). */
  const saveTutor = () => api.saveSettings({ chat_assistive: s.chat_assistive ?? 1, chat_concise: s.chat_concise ?? 1, chat_interactive: s.chat_interactive ?? 1 })
    .catch((e) => logError('setup', e));

  return createPortal(
    <div className="setup" role="dialog" aria-modal aria-labelledby="setup-title">
      <div className="setup-stars" aria-hidden />
      <div className="setup-card" key={step}>
        <div className="setup-progress" aria-hidden>{dots.map((d, i) => <span key={i} className={i < at ? 'done' : i === at ? 'now' : ''} />)}</div>

        {step === 'where' && (
          <>
            <div className="setup-orb" aria-hidden><Icon name="ask" size={30} /></div>
            <h1 id="setup-title">Welcome to Apollo</h1>
            <p className="setup-lead">Apollo needs two AI models: one that reads, explains and writes, and one that helps it search your files. Where should they run?</p>
            <div className="setup-choices">
              <button className="setup-choice" onClick={() => { setAdvanced(false); setStep('local'); }}>
                <span className="setup-choice-icon local"><Icon name="brain" size={24} /></span>
                <b>On this computer</b>
                <span>Private: nothing leaves your computer. You need model servers running (for example LM Studio or llama.cpp).</span>
              </button>
              <button className="setup-choice" onClick={() => { setAdvanced(false); setStep('online'); }}>
                <span className="setup-choice-icon online"><Icon name="map" size={24} /></span>
                <b>Online, with OpenRouter</b>
                <span>The easiest start: just paste a key. Your material is sent to online servers to be read.</span>
              </button>
            </div>
            <button className="link-btn setup-skip" onClick={() => finish()}>Skip for now (you can set this up later in Settings)</button>
          </>
        )}

        {step === 'online' && (
          <>
            <h1 id="setup-title">Connect to OpenRouter</h1>
            <p className="setup-lead">Make a free account at <b>openrouter.ai</b>, create a key under <b>Keys</b>, and paste it here.</p>
            {field('openrouter_api_key', 'OpenRouter key', { placeholder: 'sk-or-…', secret: true, help: 'Kept only on this computer, encrypted.' })}
            <div className="setup-warn"><Icon name="help" size={16} /><span>{ONLINE_WARNING}</span></div>
            <button className={`setup-adv${advanced ? ' open' : ''}`} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <Icon name="chevronRight" size={14} /> Advanced setup
            </button>
            {advanced && (
              <div className="setup-adv-body">
                <OpenRouterModelField value={str('openrouter_model')} onChange={(v) => set('openrouter_model', v)} />
                {field('openrouter_embed_model', 'Search (embedding) model', { help: 'Changing it later means your files are read again.' })}
                {field('openrouter_base_url', 'Address')}
                <div className="setup-row">
                  {field('openrouter_context', 'Context window (tokens)', { number: true })}
                  {field('openrouter_concurrency', 'Requests at once', { number: true, help: 'Free models are rate limited: keep 1.' })}
                </div>
              </div>
            )}
          </>
        )}

        {step === 'local' && (
          <>
            <h1 id="setup-title">Where are your models?</h1>
            <p className="setup-lead">Type the address each model server shows when it starts, like <b>127.0.0.1:8080</b>. Leave a key empty if the server doesn’t ask for one.</p>
            <div className="setup-model">
              <div className="setup-model-head"><span className="setup-model-icon"><Icon name="brain" size={18} /></span><b>Language model</b><small>reads, explains and writes</small></div>
              <div className="setup-row">
                {field('llm_base_url', 'Address', { placeholder: '127.0.0.1:8080' })}
                {field('llm_api_key', 'Key (optional)', { secret: true })}
              </div>
            </div>
            <div className="setup-model">
              <div className="setup-model-head"><span className="setup-model-icon search"><Icon name="search" size={18} /></span><b>Embedding model</b><small>helps Apollo search your files</small></div>
              <div className="setup-row">
                {field('embed_base_url', 'Address', { placeholder: '127.0.0.1:1234' })}
                {field('embed_api_key', 'Key (optional)', { secret: true })}
              </div>
            </div>
            <button className={`setup-adv${advanced ? ' open' : ''}`} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              <Icon name="chevronRight" size={14} /> Advanced setup
            </button>
            {advanced && (
              <div className="setup-adv-body">
                <div className="setup-row">
                  {field('llm_model', 'Language model name', { help: 'As the server lists it. The check offers the server’s models if this one isn’t there.' })}
                  {field('embed_model', 'Embedding model name', { help: 'Changing it later means your files are read again.' })}
                </div>
                <div className="setup-row">
                  {field('llm_context', 'Context window (tokens)', { number: true })}
                  {field('llm_concurrency', 'Requests at once', { number: true, help: 'Keep 1 unless the server runs several.' })}
                  {field('embed_batch', 'Embedding batch size', { number: true })}
                </div>
              </div>
            )}
          </>
        )}

        {step === 'check' && (
          <>
            <h1 id="setup-title">{busy ? 'Checking the connection…' : allOk ? 'All connected' : 'Almost there'}</h1>
            <p className="setup-lead">{busy ? 'Apollo is saying hello to each model.' : allOk
              ? 'Both models answered. Next, make your first subject.'
              : 'Fix what’s marked below and check again, or carry on and fix it later in Settings.'}</p>
            {(['llm', 'embed'] as const).map((k) => {
              const r = test?.[k];
              const models = k === 'llm' && r && !r.ok ? r.models ?? [] : [];
              return (
                <div key={k} className={`setup-result${busy ? ' is-busy' : r?.ok ? ' is-ok' : r ? ' is-bad' : ''}`}>
                  <span className="setup-result-icon">{busy || !r ? <span className="setup-spin" /> : <Icon name={r.ok ? 'check' : 'close'} size={16} strokeWidth={3} />}</span>
                  <div className="setup-result-main">
                    <b>{k === 'llm' ? 'Language model' : 'Embedding model'}</b>
                    <small>{busy || !r ? 'Checking…' : r.ok ? `Ready${r.model ? `: ${r.model}` : ''}${r.ms ? ` · answered in ${r.ms} ms` : ''}` : (r.error && /APO-/.test(r.error) ? <ErrorText text={r.error} /> : plain(r.error))}</small>
                    {models.length > 0 && !online && (
                      <label className="setup-pick">
                        <span>This server has:</span>
                        <select className="input" value="" onChange={(e) => { if (e.target.value) { set('llm_model', e.target.value); setAdvanced(true); } }}>
                          <option value="">Pick a model…</option>
                          {models.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {step === 'look' && (
          <>
            <h1 id="setup-title">Make it yours</h1>
            <p className="setup-lead">Pick a theme and how lively the app feels. Both change straight away, and you can change them later in Settings.</p>
            <div className="setup-field setup-themes"><span>Theme</span><ThemeGrid /></div>
            <div className="setup-field setup-motion"><span>Animations</span><MotionSeg /></div>
          </>
        )}

        {step === 'tutor' && (
          <>
            <div className="setup-orb" aria-hidden><Icon name="ask" size={30} /></div>
            <h1 id="setup-title">How should Apollo teach?</h1>
            <p className="setup-lead">Set how Apollo answers you in the chat. The middle is a good start; change it any time in Settings → Chat tutor.</p>
            <div className="setup-dials"><PersonalityDials s={s} set={set} help /></div>
          </>
        )}

        {step === 'subject' && (
          <>
            <div className="setup-orb" aria-hidden><Icon name="study" size={30} /></div>
            <h1 id="setup-title">Make your first subject</h1>
            <p className="setup-lead">A subject is a course you’re studying. Inside it, topics split it into parts, like chapters or weeks.</p>
            <label className="setup-field">
              <span>Subject</span>
              <input className="input" autoFocus value={subject} placeholder="e.g. Physics" onChange={(e) => setSubject(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && makeSubject()} />
            </label>
            <label className="setup-field">
              <span>First topic <span className="muted">(optional)</span></span>
              <input className="input" value={topic} placeholder="e.g. Motion" onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && makeSubject()} />
            </label>
            <p className="setup-note">Next you’ll add your slides, notes and textbooks to it. Apollo reads them in the background.</p>
            <button className="setup-example" disabled={busy} onClick={async () => {
              setBusy(true); setErr(null);
              try { const r = await api.makeExample(); await finish(r.id); }
              catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
            }}>
              <span className="setup-example-icon"><Icon name="study" size={18} /></span>
              <span><b>Or look around an example first</b><small>A small Physics course with flashcards, a quiz, notes and a chat already made.</small></span>
              <Icon name="next" size={16} />
            </button>
          </>
        )}

        {err && <div className="banner banner-bad"><ErrorText text={err} /></div>}

        {step !== 'where' && (
          <div className="setup-foot">
            <button className="btn btn-ghost" disabled={busy} onClick={() => {
              setErr(null);
              if (step === 'tutor') saveTutor();
              setStep(step === 'check' ? (s.llm_provider === 'openrouter' ? 'online' : 'local') : step === 'look' ? 'check'
                : step === 'tutor' ? 'look' : step === 'subject' ? 'tutor' : 'where');
            }}><Icon name="back" size={15} /> Back</button>
            <span className="spacer" />
            {(step === 'online' || step === 'local') && (
              <button className="btn btn-primary" disabled={busy || (step === 'online' && !str('openrouter_api_key'))} onClick={check}>
                {busy ? 'Saving…' : 'Check connection'} <Icon name="next" size={15} />
              </button>
            )}
            {step === 'check' && !busy && (
              <>
                {!allOk && <button className="btn" onClick={check}>Check again</button>}
                <button className={`btn${allOk ? ' btn-primary' : ''}`} onClick={() => setStep('look')}>
                  {allOk ? 'Continue' : 'Continue anyway'} <Icon name="next" size={15} />
                </button>
              </>
            )}
            {step === 'look' && <button className="btn btn-primary" onClick={() => setStep('tutor')}>Continue <Icon name="next" size={15} /></button>}
            {step === 'tutor' && (
              <button className="btn btn-primary" onClick={async () => { await saveTutor(); if (subjectsCount) await finish(); else setStep('subject'); }}>
                {subjectsCount ? 'Finish' : 'Continue'} <Icon name="next" size={15} />
              </button>
            )}
            {step === 'subject' && (
              <>
                <button className="btn btn-ghost" disabled={busy} onClick={() => finish()}>Later</button>
                <button className="btn btn-primary" disabled={busy || !subject.trim()} onClick={makeSubject}>Create subject <Icon name="next" size={15} /></button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
