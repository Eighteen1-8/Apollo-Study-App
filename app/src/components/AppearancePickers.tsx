/* The theme cards and the animation-speed buttons: Settings → Appearance and the first-run setup use the same ones.
   Both apply at once (theme.ts saves them on this computer). */
import { useEffect, useState } from 'react';
import { EFFECT_AMOUNTS, EFFECTS, MOTIONS, THEMES, UI_SCALE, clampScale, scaleStep, useAppearance } from '../theme';
import Icon from './Icon';

/** The UI size (theme.ts `uiScale`): a slider with − / + and Reset. The slider shows its value while dragged and
 * applies it on release, so the window doesn't rescale under the pointer. Ctrl + / - / 0 change the same setting. */
export function UiScaleControl() {
  const [a, set] = useAppearance();
  const [v, setV] = useState(a.uiScale);
  useEffect(() => setV(a.uiScale), [a.uiScale]);
  const commit = (n: number) => { const c = clampScale(n); setV(c); if (c !== a.uiScale) set({ uiScale: c }); };
  return (
    <>
      <div className="ui-scale">
        <button className="icon-btn" aria-label="Smaller" title="Smaller (Ctrl -)" disabled={a.uiScale <= UI_SCALE.min}
          onClick={() => commit(scaleStep(a.uiScale, -1))}><Icon name="minus" /></button>
        <input type="range" min={UI_SCALE.min} max={UI_SCALE.max} step={UI_SCALE.step} value={v} aria-label="UI size"
          onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => commit(v)} onKeyUp={() => commit(v)} onBlur={() => commit(v)} />
        <button className="icon-btn" aria-label="Bigger" title="Bigger (Ctrl +)" disabled={a.uiScale >= UI_SCALE.max}
          onClick={() => commit(scaleStep(a.uiScale, 1))}><Icon name="add" /></button>
        <span className="ui-scale-val" aria-live="polite">{v}%</span>
        <button className="btn btn-sm" disabled={a.uiScale === UI_SCALE.normal} onClick={() => commit(UI_SCALE.normal)}>Reset</button>
      </div>
      <span className="field-help">Makes everything in the window bigger or smaller. Ctrl + and Ctrl − do the same, Ctrl 0 resets it.</span>
    </>
  );
}

/** The background effect (components/Ambient.tsx) and how much of it. */
export function EffectSeg() {
  const [a, set] = useAppearance();
  const help = EFFECTS.find((e) => e.id === a.effect)?.help;
  return (
    <>
      <div className="seg" role="radiogroup" aria-label="Background effect">
        {EFFECTS.map((e) => (
          <button key={e.id} role="radio" aria-checked={a.effect === e.id} className={a.effect === e.id ? 'active' : ''}
            onClick={() => set({ effect: e.id })}>{e.label}</button>
        ))}
      </div>
      {a.effect !== 'none' && (
        <div className="seg effect-amount" role="radiogroup" aria-label="How much">
          {EFFECT_AMOUNTS.map((m) => (
            <button key={m.id} role="radio" aria-checked={a.effectAmount === m.id} className={a.effectAmount === m.id ? 'active' : ''}
              onClick={() => set({ effectAmount: m.id })}>{m.label}</button>
          ))}
        </div>
      )}
      <span className="field-help">
        {a.motion === 'off' ? 'Animations are off, so no effect is shown.'
          : `${help}${a.effect === 'none' ? '' : ' It fades almost away while a file, notes or other content is open, so it never gets in the way.'}`}
      </span>
    </>
  );
}

export function ThemeGrid() {
  const [a, set] = useAppearance();
  return (
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
  );
}

const MOTION_HELP: Record<string, string> = {
  off: 'Nothing moves: panels and menus appear at once. (Windows’ own reduce-motion setting also turns animations off.)',
  fast: 'Quick, snappy transitions.',
  normal: 'The standard pace.',
  gentle: 'Slower, softer transitions.',
};

export function MotionSeg() {
  const [a, set] = useAppearance();
  return (
    <>
      <div className="seg motion-seg" role="radiogroup" aria-label="Animation speed">
        {MOTIONS.map((m) => (
          <button key={m.id} role="radio" aria-checked={a.motion === m.id} className={a.motion === m.id ? 'active' : ''}
            onClick={() => set({ motion: m.id })}>{m.label}</button>
        ))}
      </div>
      <span className="field-help">{MOTION_HELP[a.motion]}</span>
    </>
  );
}
