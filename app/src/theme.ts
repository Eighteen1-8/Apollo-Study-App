/* Appearance: colour theme, accent and motion. Stored per machine in localStorage and applied as attributes on
   <html> (styles/4-themes.css defines the themes), so it is in place before the first render. */
import { useEffect, useState } from 'react';

export type ThemeId = 'midnight' | 'aurora' | 'nebula' | 'graphite' | 'daylight' | 'helium' | 'fluorine' | 'sodium' | 'nitrogen';
/** Animation speed: 'off' is the reduced-motion style (nothing moves); the others scale every animation's speed. */
export type Motion = 'off' | 'fast' | 'normal' | 'gentle';
export const MOTIONS: { id: Motion; label: string; rate: number }[] = [
  { id: 'off', label: 'Off', rate: 1 }, { id: 'fast', label: 'Fast', rate: 1.6 }, { id: 'normal', label: 'Normal', rate: 1 }, { id: 'gentle', label: 'Gentle', rate: 0.65 },
];

/** UI size: how big everything is drawn, in percent (the window's zoom). Settings → Appearance and Ctrl +/-/0 both
 * change it (Electron routes the shortcuts here, `zoom:step`), so it is always saved. Electron accepts 80–160%. */
export const UI_SCALE = { min: 80, max: 160, step: 5, normal: 100 } as const;
export const clampScale = (v: number) => Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, Math.round(Number.isFinite(v) ? v : 100)));
/** The UI size one step up (1) or down (-1) from `v`, on the 5% grid; 0 resets to 100%. */
export function scaleStep(v: number, dir: -1 | 0 | 1) {
  if (!dir) return UI_SCALE.normal;
  const grid = dir > 0 ? Math.floor(v / UI_SCALE.step) + 1 : Math.ceil(v / UI_SCALE.step) - 1;
  return clampScale(grid * UI_SCALE.step);
}
/** The sizes the older three-step text size setting used. */
const OLD_TEXT_SIZES: Record<string, number> = { normal: 100, large: 112, xl: 125 };
/** A light animated layer over the whole app (components/Ambient.tsx); it fades almost away while content is open. */
/** 'theme': the theme's own scene (components/themeScenes.ts), offered only for a theme with one (THEMES[].scene). */
export type Effect = 'none' | 'snow' | 'meteors' | 'fireflies' | 'theme';
export type EffectAmount = 'light' | 'medium' | 'heavy';
export const EFFECTS: { id: Effect; label: string; help: string }[] = [
  { id: 'none', label: 'None', help: 'No background effect.' },
  { id: 'snow', label: 'Snow', help: 'Small flakes drifting slowly down.' },
  { id: 'meteors', label: 'Meteors', help: 'Shooting stars: now and then when light, a steady stream with showers when heavy.' },
  { id: 'fireflies', label: 'Fireflies', help: 'Soft glowing specks wandering and pulsing.' },
  { id: 'theme', label: 'Theme', help: "The theme's own scene." },
];
export const EFFECT_AMOUNTS: { id: EffectAmount; label: string }[] = [
  { id: 'light', label: 'Light' }, { id: 'medium', label: 'Medium' }, { id: 'heavy', label: 'Heavy' },
];
/** `advanced`: advanced mode (technical terms, every power-user control and setting); off by default, so a new
 * student sees plain words and guided steps. `uiScale`: the UI size in percent (UI_SCALE). `version`: which one-time
 * migrations of saved settings have run (`load`). `pet`: the small cat that shows what Apollo is doing
 * (components/Pet.tsx); off unless turned on. */
export interface Appearance { theme: ThemeId; accent: string | null; motion: Motion; cloud: boolean; cloudDrift: boolean; cloudFps: number; advanced: boolean; uiScale: number; effect: Effect; effectAmount: EffectAmount; pet: boolean; version: number }

/** Named after elements (the ids are the older names, kept so a saved choice still applies). */
export const THEMES: { id: ThemeId; name: string; blurb: string; swatch: [string, string, string]; light?: boolean; scene?: { label: string; help: string } }[] = [
  { id: 'midnight', name: 'Hydrogen', blurb: 'Deep blue-black with indigo light', swatch: ['#0b0d14', '#161a26', '#8b9bff'] },
  { id: 'aurora', name: 'Lithium', blurb: 'Polar teal over dark spruce', swatch: ['#06110f', '#0f1f1c', '#3ee6b8'] },
  { id: 'nebula', name: 'Iodine', blurb: 'Violet dusk with magenta glow', swatch: ['#0e0914', '#1b1226', '#d58bff'] },
  { id: 'graphite', name: 'Carbon', blurb: 'Neutral and quiet, true black', swatch: ['#0a0a0b', '#18181b', '#e4e4e7'] },
  { id: 'daylight', name: 'Oxygen', blurb: 'Bright paper with ink accents', swatch: ['#f6f7fb', '#ffffff', '#4f5bd5'], light: true },
  { id: 'helium', name: 'Helium', blurb: 'Pink all through, with raspberry accents', swatch: ['#f5d3e2', '#fae4ee', '#c2185b'], light: true },
  { id: 'fluorine', name: 'Fluorine', blurb: 'Green all through, with forest accents', swatch: ['#cdebd5', '#e2f4e7', '#15803d'], light: true },
  { id: 'sodium', name: 'Sodium', blurb: 'Rose-to-periwinkle dusk, trimmed in gold', swatch: ['#f3d6e4', '#fbf1f5', '#c8952e'], light: true,
    scene: { label: 'Roses & bubbles', help: 'Sodium only: roses, blossoms and petals drifting down, bubbles rising and gold stars twinkling.' } },
  { id: 'nitrogen', name: 'Nitrogen', blurb: 'Hydrangea blues, all through', swatch: ['#c2d3f3', '#edf3fe', '#3f66e0'], light: true,
    scene: { label: 'Hydrangeas', help: 'Nitrogen only: hydrangea florets tumbling down, whole hydrangeas floating by and a few leaves.' } },
];
/** Whether a theme brings its own animated scene (components/themeScenes.ts): the 'theme' background effect. */
export const hasScene = (id: ThemeId) => !!THEMES.find((t) => t.id === id)?.scene;
/** The background effects a theme offers: the common ones, plus 'theme' named after its scene if it has one. */
export function effectsFor(id: ThemeId) {
  const scene = THEMES.find((t) => t.id === id)?.scene;
  return EFFECTS.flatMap((e) => (e.id !== 'theme' ? [e] : scene ? [{ ...e, label: scene.label, help: scene.help }] : []));
}

export const ACCENTS = ['#8b9bff', '#3ee6b8', '#d58bff', '#ff8fa3', '#ffb454', '#5cc8ff', '#a3e635', '#f472b6'];

/** A topic's colour in its subject's knowledge cloud and sidebar: the accent palette in topic creation order. */
export function topicColor(topics: { id: number }[], id: number) {
  const ids = topics.map((t) => t.id).sort((a, b) => a - b);
  const i = ids.indexOf(id);
  return i < 0 ? '#9aa1b2' : ACCENTS[i % ACCENTS.length];
}
/** Textbooks (the reference library) in a subject's cloud. */
export const REF_COLOR = '#d9c9a3';

const KEY = 'apollo.appearance';
const VERSION = 1;
const DEFAULT: Appearance = { theme: 'midnight', accent: null, motion: 'normal', cloud: true, cloudDrift: true, cloudFps: 0, advanced: false, uiScale: 100, effect: 'none', effectAmount: 'light', pet: false, version: VERSION };

/** Saved settings brought up to date (exported for tests). */
export function migrateAppearance(saved: Record<string, unknown>): Appearance {
  const a = { ...DEFAULT, ...saved } as Appearance & { textSize?: string };
  if (!(Number(saved.version) >= 1)) {
    // version 1: the frame rate's default became the display's own; 60 was the old default, not a choice
    if (a.cloudFps === 60) a.cloudFps = 0;
  }
  // the three-step text size became a percentage
  if (saved.uiScale === undefined && typeof a.textSize === 'string') a.uiScale = OLD_TEXT_SIZES[a.textSize] ?? 100;
  delete a.textSize;
  a.uiScale = clampScale(Number(a.uiScale));
  a.version = VERSION;
  return a;
}

function load(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const a = migrateAppearance(JSON.parse(raw));
      // before the animation speeds: 'full' and 'reduced'
      if ((a.motion as string) === 'full') a.motion = 'normal';
      if ((a.motion as string) === 'reduced') a.motion = 'off';
      if (!MOTIONS.some((m) => m.id === a.motion)) a.motion = 'normal';
      if (!EFFECTS.some((e) => e.id === a.effect)) a.effect = 'none';
      if (!EFFECT_AMOUNTS.some((e) => e.id === a.effectAmount)) a.effectAmount = 'light';
      a.pet = a.pet === true;
      if (a.effect === 'theme' && !hasScene(a.theme)) a.effect = 'none';
      delete (a as { themeScene?: boolean }).themeScene; // briefly a separate switch before it became an effect
      localStorage.setItem(KEY, JSON.stringify(a)); // the migrations run once
      return a;
    }
  } catch { /* storage unavailable: defaults */ }
  return { ...DEFAULT };
}

let current = load();
let rate = 1; // the animation speed's playback rate (applyAppearance)
const listeners = new Set<(a: Appearance) => void>();

export function applyAppearance(a: Appearance = current) {
  const root = document.documentElement;
  const theme = THEMES.find((t) => t.id === a.theme) ?? THEMES[0];
  root.dataset.theme = theme.id;
  root.dataset.tone = theme.light ? 'light' : 'dark'; // the light themes share their overrides (4-themes.css)
  // 'reduced' keeps the reduced-motion CSS (4-themes.css); the speeds are applied to each animation as it starts
  root.dataset.motion = a.motion === 'off' ? 'reduced' : a.motion;
  rate = MOTIONS.find((m) => m.id === a.motion)?.rate ?? 1;
  root.style.setProperty('--motion-scale', String(1 / rate));
  root.dataset.mode = a.advanced ? 'advanced' : 'standard';
  const zoom = clampScale(a.uiScale) / 100;
  // Electron zooms the page itself; a plain browser (the dev UI) gets CSS zoom instead
  if (window.studyApp?.setZoom) window.studyApp.setZoom(zoom);
  else root.style.zoom = zoom === 1 ? '' : String(zoom);
  root.style.colorScheme = theme.light ? 'light' : 'dark';
  if (a.accent) root.style.setProperty('--accent', a.accent);
  else root.style.removeProperty('--accent');
  // the window's own buttons (drawn by Windows over the app's title strip) take the theme's colours
  if (window.studyApp?.setChrome) {
    const css = getComputedStyle(root);
    const v = (name: string) => css.getPropertyValue(name).trim();
    window.studyApp.setChrome({ color: v('--minibar-bg'), symbol: v('--text-dim'), bg: v('--bg'), dark: !theme.light });
  }
}

export function setAppearance(patch: Partial<Appearance>) {
  // a theme with its own scene starts with it as the background effect; leaving it drops that effect
  if (patch.theme && patch.theme !== current.theme && patch.effect === undefined) {
    if (hasScene(patch.theme)) patch = { ...patch, effect: 'theme' };
    else if (current.effect === 'theme') patch = { ...patch, effect: 'none' };
  }
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* not persisted */ }
  // Cross-fade colours while the theme switches, then drop the transition so it never slows normal UI.
  const root = document.documentElement;
  root.classList.add('theme-switching');
  applyAppearance(current);
  window.setTimeout(() => root.classList.remove('theme-switching'), 450);
  listeners.forEach((l) => l(current));
}

export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const [a, setA] = useState(current);
  useEffect(() => {
    listeners.add(setA);
    return () => { listeners.delete(setA); };
  }, []);
  return [a, setAppearance];
}

// Ctrl + / Ctrl - / Ctrl 0 (Electron's View menu sends them here, so the size is saved and Settings shows it)
if (typeof window !== 'undefined') window.studyApp?.onZoomStep?.((dir) => setAppearance({ uiScale: scaleStep(current.uiScale, dir) }));

/** True when animations should be minimal (the setting, or the OS preference). */
export function reducedMotion() {
  return current.motion === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** How long a JS-timed animation step should take at the chosen speed (0 when animations are off). */
export function motionMs(ms: number) {
  return reducedMotion() ? 0 : Math.round(ms / rate);
}

// The speed setting: CSS has no global animation speed, so every CSS animation and transition gets the playback
// rate as it starts (animationstart / transitionrun reach the window for pseudo-elements too). Delays aren't scaled.
function speedUp(e: Event) {
  if (rate === 1) return;
  const el = e.target as Element;
  if (!el?.getAnimations) return;
  for (const a of el.getAnimations({ subtree: true })) {
    if ((a.effect as KeyframeEffect | null)?.target === el && a.playbackRate !== rate) a.playbackRate = rate;
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('animationstart', speedUp, true);
  window.addEventListener('transitionrun', speedUp, true);
}

/** The knowledge cloud's idle drift and twinkle (while the window is focused). */
export const cloudDrift = () => current.cloudDrift;
/** The knowledge cloud's frame rate cap; 0 = as fast as the display refreshes. Read every frame, so a change applies at once. */
export const cloudFps = () => current.cloudFps;
export const CLOUD_FPS: { value: number; label: string }[] = [
  { value: 30, label: '30 fps (laptops, saves battery)' }, { value: 60, label: '60 fps' },
  { value: 120, label: '120 fps' }, { value: 0, label: 'Match the display (smoothest)' },
];

/** Advanced mode, outside React (for code that isn't a component). Components use `useAdvanced` so they re-render. */
export const isAdvanced = () => current.advanced;
export function useAdvanced() { return useAppearance()[0].advanced; }
