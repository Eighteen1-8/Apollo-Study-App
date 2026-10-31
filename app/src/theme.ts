/* Appearance: colour theme, accent and motion. Stored per machine in localStorage and applied as attributes on
   <html> (styles-v4.css defines the themes), so it is in place before the first render. */
import { useEffect, useState } from 'react';

export type ThemeId = 'midnight' | 'aurora' | 'nebula' | 'graphite' | 'daylight';
export type Motion = 'full' | 'reduced';

export interface Appearance { theme: ThemeId; accent: string | null; motion: Motion; cloud: boolean }

export const THEMES: { id: ThemeId; name: string; blurb: string; swatch: [string, string, string]; light?: boolean }[] = [
  { id: 'midnight', name: 'Midnight', blurb: 'Deep blue-black with indigo light', swatch: ['#0b0d14', '#161a26', '#8b9bff'] },
  { id: 'aurora', name: 'Aurora', blurb: 'Polar teal over dark spruce', swatch: ['#06110f', '#0f1f1c', '#3ee6b8'] },
  { id: 'nebula', name: 'Nebula', blurb: 'Violet dusk with magenta glow', swatch: ['#0e0914', '#1b1226', '#d58bff'] },
  { id: 'graphite', name: 'Graphite', blurb: 'Neutral and quiet, true black', swatch: ['#0a0a0b', '#18181b', '#e4e4e7'] },
  { id: 'daylight', name: 'Daylight', blurb: 'Bright paper with ink accents', swatch: ['#f6f7fb', '#ffffff', '#4f5bd5'], light: true },
];

export const ACCENTS = ['#8b9bff', '#3ee6b8', '#d58bff', '#ff8fa3', '#ffb454', '#5cc8ff', '#a3e635', '#f472b6'];

const KEY = 'apollo.appearance';
const DEFAULT: Appearance = { theme: 'midnight', accent: null, motion: 'full', cloud: true };

function load(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
  } catch { /* storage unavailable: defaults */ }
  return { ...DEFAULT };
}

let current = load();
const listeners = new Set<(a: Appearance) => void>();

export function applyAppearance(a: Appearance = current) {
  const root = document.documentElement;
  const theme = THEMES.find((t) => t.id === a.theme) ?? THEMES[0];
  root.dataset.theme = theme.id;
  root.dataset.motion = a.motion;
  root.style.colorScheme = theme.light ? 'light' : 'dark';
  if (a.accent) root.style.setProperty('--accent', a.accent);
  else root.style.removeProperty('--accent');
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
  return current.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
