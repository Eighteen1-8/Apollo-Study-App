import { useEffect, useRef, useState } from 'react';
import { api, Subject } from '../api';
import { reducedMotion } from '../theme';
import { subjectArt } from './subjectIcons';

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

let plays = 0;

/** Rounded, slightly see-through glow tile for a subject: uploaded image, Fluent emoji art (animated while the
 * pointer is over the tile or the row/button holding it), an emoji (older subjects), or initials. */
export default function SubjectIcon({ s, size = 42, playing }: { s: Subject; size?: number; playing?: boolean }) {
  const art = s.icon_image ? null : subjectArt(s.icon_name);
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  // a fresh URL per hover restarts the animation from its first frame (an animated image's timeline is shared)
  const [play, setPlay] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || !art?.anim || playing !== undefined) return;
    const host = el.closest<HTMLElement>('button, a, [role="button"], .subj-row') ?? el;
    const on = () => { if (!reducedMotion()) { setPlay(++plays); setHover(true); } };
    const off = () => setHover(false);
    host.addEventListener('pointerenter', on);
    host.addEventListener('pointerleave', off);
    return () => { host.removeEventListener('pointerenter', on); host.removeEventListener('pointerleave', off); };
  }, [art?.anim, playing]);

  useEffect(() => { if (playing) setPlay(++plays); }, [playing]);

  const animate = !!art?.anim && (playing ?? hover) && !reducedMotion();
  // the glow gradient, slightly see-through so the tile picks up what's behind it
  const glass = (c: string, a: number) => `color-mix(in srgb, ${c} ${a}%, transparent)`;
  const style = {
    width: size, height: size,
    background: `linear-gradient(140deg, ${glass(`color-mix(in srgb, ${s.color} 45%, white)`, 80)} 0%, ${glass(s.color, 78)} 55%, ${glass(`color-mix(in srgb, ${s.color} 70%, black)`, 86)} 100%)`,
    fontSize: s.icon_emoji ? size * 0.5 : size * 0.36,
  };
  return (
    <span ref={ref} className={`subject-icon${art ? ' has-art' : ''}`} style={style}>
      {s.icon_image ? <img src={api.assetUrl(s.icon_image)} alt="" />
        : art ? <img className="subject-icon-art" alt="" draggable={false} width={Math.round(size * 0.56)} height={Math.round(size * 0.56)}
          src={animate ? `${art.anim}?play=${play}` : art.still} />
        : s.icon_emoji ? <span className="subject-icon-emoji">{s.icon_emoji}</span>
        : <span className="subject-icon-text">{s.icon_text || initials(s.name)}</span>}
    </span>
  );
}

export const PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa',
  '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#94a3b8', '#7c8cff',
];
