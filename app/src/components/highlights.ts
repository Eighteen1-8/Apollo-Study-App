/* Highlight colours shared by the student's notes (applied as a background colour in the note's HTML) and the
   highlights on generated content (artifact_marks, painted with CSS Custom Highlights). Both right-click menus offer
   the same row of colour dots plus a custom colour. */
import type { MenuItem } from './overlay';
import { SWATCH_CSS } from './overlay';

export const HIGHLIGHTS: { name: string; label: string }[] = [
  { name: 'yellow', label: 'Yellow' }, { name: 'green', label: 'Green' }, { name: 'blue', label: 'Blue' },
  { name: 'pink', label: 'Pink' }, { name: 'orange', label: 'Orange' }, { name: 'purple', label: 'Purple' },
];

/** The CSS colour of a highlight (a named one, or a custom #rrggbb). */
export const highlightCss = (c: string) => SWATCH_CSS[c] ?? c;

/** Colour-dot row for a menu: the presets, a custom colour and (optionally) none. */
export function highlightRow({ label = 'Highlight', current, onPick, onCustom, onRemove }: {
  label?: string; current?: string; onPick: (color: string) => void; onCustom: () => void; onRemove?: () => void;
}): MenuItem {
  return {
    label,
    swatches: [
      ...HIGHLIGHTS.map((h) => ({ color: h.name, label: h.label, active: h.name === current, onClick: () => onPick(h.name) })),
      ...(current && !SWATCH_CSS[current] ? [{ color: current, label: 'Current custom colour', active: true, onClick: () => onPick(current) }] : []),
      { color: '', label: 'Custom colour…', kind: 'custom' as const, onClick: onCustom },
      ...(onRemove ? [{ color: '', label: 'No highlight', kind: 'none' as const, onClick: onRemove }] : []),
    ],
  };
}

const PRESET_RULES = new Set(['yellow', 'green', 'blue', 'pink']); // styled in 5-features.css
const made = new Set<string>();

/** The CSS highlight name generated content uses for a mark colour, adding its style the first time. */
export function markHighlight(color: string): string {
  const name = /^#[0-9a-f]{6}$/i.test(color) ? `mark-c-${color.slice(1).toLowerCase()}` : `mark-${color.replace(/[^a-z]/gi, '')}`;
  if (!PRESET_RULES.has(color) && !made.has(name)) {
    made.add(name);
    const css = highlightCss(color);
    const el = document.getElementById('mark-colours') ?? Object.assign(document.head.appendChild(document.createElement('style')), { id: 'mark-colours' });
    el.textContent += `::highlight(${name}) { background-color: color-mix(in srgb, ${css} 55%, transparent); }\n`;
  }
  return name;
}
