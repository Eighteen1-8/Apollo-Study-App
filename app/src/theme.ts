/* Appearance: colour theme, accent and motion. Stored per machine in localStorage and applied as attributes on
   <html> (styles/4-themes.css defines the themes), so it is in place before the first render. */
import { useEffect, useState } from 'react';

export type ThemeId = 'midnight' | 'aurora' | 'nebula' | 'graphite' | 'daylight' | 'helium' | 'fluorine';
/** Animation speed: 'off' is the reduced-motion style (nothing moves); the others scale every animation's speed. */
export type Motion = 'off' | 'fast' | 'normal' | 'gentle';
export const MOTIONS: { id: Motion; label: string; rate: number }[] = [
  { id: 'off', label: 'Off', rate: 1 }, { id: 'fast', label: 'Fast', rate: 1.6 }, { id: 'normal', label: 'Normal', rate: 1 }, { id: 'gentle', label: 'Gentle', rate: 0.65 },
];

/** `advanced`: advanced mode (technical terms, every power-user control and setting); off by default, so a new
 * student sees plain words and guided steps. */
export type TextSize = 'normal' | 'large' | 'xl';
/** How much bigger everything is drawn at each text size (the window's zoom). */
export const TEXT_SIZES: { id: TextSize; label: string; zoom: number }[] = [
  { id: 'normal', label: 'Normal', zoom: 1 }, { id: 'large', label: 'Large', zoom: 1.12 }, { id: 'xl', label: 'Extra large', zoom: 1.25 },
];
export interface Appearance { theme: ThemeId; accent: string | null; motion: Motion; cloud: boolean; cloudDrift: boolean; cloudFps: number; advanced: boolean; textSize: TextSize }

/** Named after elements (the ids are the older names, kept so a saved choice still applies). */
export const THEMES: { id: ThemeId; name: string; blurb: string; swatch: [string, string, string]; light?: boolean }[] = [
  { id: 'midnight', name: 'Hydrogen', blurb: 'Deep blue-black with indigo light', swatch: ['#0b0d14', '#161a26', '#8b9bff'] },
  { id: 'aurora', name: 'Lithium', blurb: 'Polar teal over dark spruce', swatch: ['#06110f', '#0f1f1c', '#3ee6b8'] },
  { id: 'nebula', name: 'Iodine', blurb: 'Violet dusk with magenta glow', swatch: ['#0e0914', '#1b1226', '#d58bff'] },
  { id: 'graphite', name: 'Carbon', blurb: 'Neutral and quiet, true black', swatch: ['#0a0a0b', '#18181b', '#e4e4e7'] },
  { id: 'daylight', name: 'Oxygen', blurb: 'Bright paper with ink accents', swatch: ['#f6f7fb', '#ffffff', '#4f5bd5'], light: true },
  { id: 'helium', name: 'Helium', blurb: 'Pink all through, with raspberry accents', swatch: ['#f5d3e2', '#fae4ee', '#c2185b'], light: true },
  { id: 'fluorine', name: 'Fluorine', blurb: 'Green all through, with forest accents', swatch: ['#cdebd5', '#e2f4e7', '#15803d'], light: true },
];

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
const DEFAULT: Appearance = { theme: 'midnight', accent: null, motion: 'normal', cloud: true, cloudDrift: true, cloudFps: 60, advanced: false, textSize: 'normal' };

function load(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const a = { ...DEFAULT, ...JSON.parse(raw) };
      // before the animation speeds: 'full' and 'reduced'
      if ((a.motion as string) === 'full') a.motion = 'normal';
      if ((a.motion as string) === 'reduced') a.motion = 'off';
      if (!MOTIONS.some((m) => m.id === a.motion)) a.motion = 'normal';
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
  const zoom = TEXT_SIZES.find((t) => t.id === a.textSize)?.zoom ?? 1;
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
