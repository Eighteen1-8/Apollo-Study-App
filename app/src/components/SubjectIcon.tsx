import { api, Subject } from '../api';

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

/** Rounded gradient tile for a subject: uploaded image, emoji, or initials (custom or derived from the name). */
export default function SubjectIcon({ s, size = 42 }: { s: Subject; size?: number }) {
  const style = {
    width: size, height: size,
    background: `linear-gradient(140deg, color-mix(in srgb, ${s.color} 45%, white) 0%, ${s.color} 55%, color-mix(in srgb, ${s.color} 70%, black) 100%)`,
    fontSize: s.icon_emoji ? size * 0.5 : size * 0.36,
  };
  return (
    <span className="subject-icon" style={style}>
      {s.icon_image ? <img src={api.assetUrl(s.icon_image)} alt="" />
        : s.icon_emoji ? <span className="subject-icon-emoji">{s.icon_emoji}</span>
        : <span className="subject-icon-text">{s.icon_text || initials(s.name)}</span>}
    </span>
  );
}

export const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa',
  '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#94a3b8', '#7c8cff',
];
