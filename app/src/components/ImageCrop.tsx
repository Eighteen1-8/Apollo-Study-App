/* Crop and scale a picture to a square (the subject icon upload): drag to move it in the frame, wheel or the slider to
   zoom, arrow keys and +/- too. Previews show it at the sizes the icon is drawn. The result is a PNG of `size` pixels. */
import { CSSProperties, KeyboardEvent, PointerEvent, useEffect, useRef, useState, WheelEvent } from 'react';
import { Modal } from './overlay';

const FRAME = 280; // the crop frame on screen, CSS pixels
const MAX_ZOOM = 6;
const PREVIEWS = [96, 42, 28];

type View = { z: number; x: number; y: number }; // zoom over "just covers the frame"; image top-left inside the frame

/** Keep the image covering the whole frame. */
export function clampView(v: View, w: number, h: number, frame = FRAME): View {
  const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
  const s = (frame / Math.min(w, h)) * z;
  return { z, x: Math.min(0, Math.max(frame - w * s, v.x)), y: Math.min(0, Math.max(frame - h * s, v.y)) };
}

/** Zoom to `z` keeping the image point under (px, py) (frame coordinates) where it is. */
export function zoomAt(v: View, z: number, px: number, py: number, w: number, h: number, frame = FRAME): View {
  const base = frame / Math.min(w, h);
  const s0 = base * v.z;
  const nz = Math.min(MAX_ZOOM, Math.max(1, z));
  const s1 = base * nz;
  return clampView({ z: nz, x: px - ((px - v.x) / s0) * s1, y: py - ((py - v.y) / s0) * s1 }, w, h, frame);
}

/** The source rectangle [sx, sy, side] of the image that the frame shows. */
export function cropRect(v: View, w: number, h: number, frame = FRAME): [number, number, number] {
  const s = (frame / Math.min(w, h)) * v.z;
  return [(0 - v.x) / s, (0 - v.y) / s, frame / s];
}

export default function ImageCrop({ src, title = 'Crop the picture', size = 256, onCancel, onDone }: {
  src: string; title?: string; size?: number; onCancel: () => void;
  /** The cropped picture as base64 PNG (no data: prefix). */
  onDone: (pngBase64: string) => void | Promise<void>;
}) {
  const img = useRef<HTMLImageElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!w || !h) { setError("This picture is empty."); return; }
      img.current = im;
      setDims({ w, h });
      const s = FRAME / Math.min(w, h);
      setView({ z: 1, x: (FRAME - w * s) / 2, y: (FRAME - h * s) / 2 }); // centred
      frame.current?.focus();
    };
    im.onerror = () => setError("Couldn't open this picture. Use a PNG, JPG, WEBP, GIF or BMP image.");
    im.src = src;
  }, [src]);

  const set = (v: View) => dims && setView(clampView(v, dims.w, dims.h));
  const zoomTo = (z: number, px = FRAME / 2, py = FRAME / 2) => dims && setView(zoomAt(view, z, px, py, dims.w, dims.h));

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    set({ ...view, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
  };
  const up = (e: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === e.pointerId) drag.current = null; };
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    zoomTo(view.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 8;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); set({ ...view, x: view.x + moves[e.key][0], y: view.y + moves[e.key][1] }); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(view.z * 1.15); }
    else if (e.key === '-') { e.preventDefault(); zoomTo(view.z / 1.15); }
  };

  const done = async () => {
    if (!img.current || !dims) return;
    const [sx, sy, side] = cropRect(view, dims.w, dims.h);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (!g) return;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.current, sx, sy, side, side, 0, 0, size, size);
    setBusy(true);
    try { await onDone(c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')); }
    catch (e) { setError(String(e).replace(/^Error: /, '')); }
    finally { setBusy(false); }
  };

  const s = dims ? (FRAME / Math.min(dims.w, dims.h)) * view.z : 1;
  const placed = (scale: number): CSSProperties => (dims ? {
    width: dims.w * s * scale, height: dims.h * s * scale, transform: `translate(${view.x * scale}px, ${view.y * scale}px)`,
  } : {});

  return (
    <Modal title={title} onClose={onCancel}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={!dims || busy} onClick={done}>{busy ? 'Saving…' : 'Use this'}</button>
      </>}>
      {error && <div className="banner banner-bad">{error}</div>}
      <div className="crop">
        <div ref={frame} className="crop-frame" style={{ width: FRAME, height: FRAME }} tabIndex={0}
          role="application" aria-label="Picture to crop: drag or use the arrow keys to move it, + and - to zoom"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onKeyDown={key}>
          {dims && <img src={src} alt="" draggable={false} style={placed(1)} />}
        </div>
        <div className="crop-side">
          <label className="crop-zoom">
            <span>Zoom</span>
            <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={view.z} disabled={!dims}
              onChange={(e) => zoomTo(Number(e.target.value))} aria-label="Zoom" />
          </label>
          <div className="crop-previews" aria-label="Preview">
            {PREVIEWS.map((p) => (
              <span key={p} className="crop-preview" style={{ width: p, height: p }}>
                {dims && <img src={src} alt="" draggable={false} style={placed(p / FRAME)} />}
              </span>
            ))}
          </div>
          <p className="muted small">Drag to move, scroll to zoom. The square is what your icon shows.</p>
        </div>
      </div>
    </Modal>
  );
}
