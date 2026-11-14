/* One place to change how a subject looks: colour (swatches or any colour) and its art (twenty subjects × five
   Fluent emoji, the group matching the subject's name first), with a live preview that plays the art's animation.
   Letters and an uploaded image stay available as alternatives. */
import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { api, Subject } from '../api';
import { Modal, useOverlay } from './overlay';
import ImageCrop from './ImageCrop';
import SubjectIcon, { PALETTE } from './SubjectIcon';
import { matchGroup, SUBJECT_ICON_GROUPS, SubjectArt, subjectArt } from './subjectIcons';
import { reducedMotion } from '../theme';

let plays = 0;

/** One choice in the grid: plays its animation while hovered or focused, so you see it before picking. */
function PickButton({ art, on, onPick }: { art: SubjectArt; on: boolean; onPick: () => void }) {
  const [play, setPlay] = useState(0);
  const start = () => { if (art.anim && !reducedMotion()) setPlay(++plays); };
  const stop = () => setPlay(0);
  return (
    <button className={`icon-pick-btn${on ? ' on' : ''}`} title={art.label} aria-label={art.label} aria-pressed={on}
      onClick={onPick} onPointerEnter={start} onPointerLeave={stop} onFocus={start} onBlur={stop}>
      <img src={play ? `${art.anim}?play=${play}` : art.still} alt="" draggable={false} />
    </button>
  );
}

export default function SubjectLook({ subject, onClose, onChange }: { subject: Subject; onClose: () => void; onChange: () => void }) {
  const ov = useOverlay();
  const [color, setColor] = useState(subject.color);
  const [art, setArt] = useState<string | null>(subjectArt(subject.icon_name)?.key ?? null);
  const [q, setQ] = useState('');
  const matched = useMemo(() => matchGroup(subject.name), [subject.name]);

  const groups = useMemo(() => {
    const ordered = matched ? [matched, ...SUBJECT_ICON_GROUPS.filter((g) => g !== matched)] : SUBJECT_ICON_GROUPS;
    const t = q.trim().toLowerCase();
    if (!t) return ordered;
    return ordered.map((g) => g.subject.toLowerCase().includes(t) || g.words.some((w) => w.startsWith(t)) ? g
      : { ...g, icons: g.icons.filter((a) => a.label.toLowerCase().includes(t)) }).filter((g) => g.icons.length);
  }, [q, matched]);

  // what the preview shows: the chosen art replaces letters/emoji/image, as saving would
  const preview: Subject = art !== (subjectArt(subject.icon_name)?.key ?? null)
    ? { ...subject, color, icon_name: art, icon_image: null, icon_emoji: null }
    : { ...subject, color };

  const save = async () => {
    const body: Parameters<typeof api.setIcon>[1] = {};
    if (color !== subject.color) body.color = color;
    if (art && art !== subject.icon_name) body.icon_name = art;
    if (Object.keys(body).length) { await api.setIcon(subject.id, body); onChange(); }
    onClose();
  };
  const letters = async () => {
    const t = await ov.prompt({ title: 'Icon letters', label: 'Up to 3 characters', initial: subject.icon_text ?? '', placeholder: 'PH' });
    if (!t) return;
    await api.setIcon(subject.id, { icon_text: t, ...(color !== subject.color ? { color } : {}) });
    onChange(); onClose();
  };
  // an uploaded picture is cropped and scaled to a 256 px square first (ImageCrop)
  const [crop, setCrop] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (crop) URL.revokeObjectURL(crop); }, [crop]);
  const picked = (f: File | undefined) => { if (f) setCrop(URL.createObjectURL(f)); };
  const saveCropped = async (png: string) => {
    await api.setIcon(subject.id, { image_png: png, ...(color !== subject.color ? { color } : {}) });
    onChange(); onClose();
  };
  const reset = async () => {
    await api.setIcon(subject.id, { icon_text: '', icon_emoji: '', icon_name: '', clear_image: true });
    onChange(); onClose();
  };

  if (crop) return <ImageCrop src={crop} title={`Icon for ${subject.name}`} onCancel={() => setCrop(null)} onDone={saveCropped} />;

  return (
    <Modal title={`Icon for ${subject.name}`} wide onClose={onClose}
      footer={<>
        <button className="btn" onClick={reset}>Reset</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <div className="look">
        <div className="look-preview">
          <SubjectIcon s={preview} size={96} playing />
          <div className="look-preview-name">{subject.name}</div>
          <div className="look-side">
            <button className="btn btn-sm" onClick={letters}>Use letters…</button>
            <button className="btn btn-sm" onClick={() => picker.current?.click()}>Upload an image…</button>
            <input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              onChange={(e) => { picked(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        </div>
        <div className="look-main">
          <section>
            <h4>Colour</h4>
            <div className="swatches">
              {PALETTE.map((p) => (
                <button key={p} className={`swatch${p === color ? ' active' : ''}`} style={{ background: p }} aria-label={`Colour ${p}`} onClick={() => setColor(p)} />
              ))}
              <label className="swatch swatch-custom" title="Any colour">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />+
              </label>
            </div>
          </section>
          <section>
            <h4>Icon</h4>
            <input className="input icon-pick-search" placeholder="Search (e.g. chemistry, rocket)" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="icon-pick" style={{ '--tile': color } as CSSProperties}>
              {groups.map((g) => (
                <section key={g.subject} className={`icon-pick-group${g === matched ? ' matched' : ''}`}>
                  <h4>{g.subject}{g === matched ? ' · suggested' : ''}</h4>
                  <div className="icon-pick-row">
                    {g.icons.map((a) => (
                      <PickButton key={a.key} art={a} on={art === a.key} onPick={() => setArt(a.key)} />
                    ))}
                  </div>
                </section>
              ))}
              {!groups.length && <p className="muted">No icons match.</p>}
            </div>
          </section>
        </div>
      </div>
    </Modal>
  );
}
