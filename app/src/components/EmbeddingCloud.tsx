/* The knowledge cloud: embedded chunks projected to 3D (PCA on the backend), drawn as glowing nodes on a canvas.
   On the home page it is the whole library, coloured by subject, behind the page's widgets. In a subject it is
   that subject's own projection, coloured by topic, and `focus` narrows it to one topic, the textbooks or one
   file: everything else fades out and the camera glides to frame what is left. Chunks of one file are threaded in
   reading order; ambient dust around each node and a far star shell give depth. Drag to orbit, scroll to zoom,
   double-click to reset, click a node to open its subject (home) or its file at that chunk (subject).
   Display only: nothing here feeds retrieval. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, EmbeddingMap } from '../api';
import { REF_COLOR, reducedMotion, topicColor } from '../theme';

type RGB = [number, number, number];

/** What a subject's cloud is narrowed to: a topic, one file, a sidebar folder's files, or the textbooks. */
export type CloudFocus =
  | { kind: 'topic' | 'doc'; id: number; name: string }
  | { kind: 'folder'; id: string; docs: number[]; name: string }
  | { kind: 'ref'; name: string }
  | null;

const hexRgb = (h: string): RGB => {
  let v = h.replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  const n = parseInt(v.padEnd(6, '0').slice(0, 6), 16);
  return Number.isNaN(n) ? [140, 155, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Deterministic PRNG so the dust and demo galaxy look the same every visit. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());

// group sentinels: a point's group is its subject id (home) or topic id (subject view)
const STAR = -2; // background stars (neutral colour, never highlighted or filtered)
const REF = -3; // textbooks in a subject view

interface Scene {
  n: number; real: number; // entries [0, real) are actual chunks; the rest are dust and stars
  pos: Float32Array; phase: Float32Array; size: Float32Array; alpha: Float32Array;
  colorIdx: Int32Array; colors: RGB[]; grp: Int32Array; doc: Int32Array;
  labels: string[]; threads: [number, number][]; demo: boolean;
}

type Topics = { id: number; name: string }[];

function buildScene(map: EmbeddingMap | null, topics: Topics | undefined): Scene {
  const r = rng(7);
  const P: { x: number; y: number; z: number; size: number; alpha: number; color: number; grp: number; doc: number; phase: number }[] = [];
  const colors: RGB[] = [[150, 160, 190]]; // 0 = stars, recoloured from the theme
  const colorKey = new Map<string, number>();
  const colorOf = (c: RGB) => {
    const k = c.map(Math.round).join(',');
    if (!colorKey.has(k)) { colorKey.set(k, colors.length); colors.push(c); }
    return colorKey.get(k)!;
  };
  const labels: string[] = [];
  const threads: [number, number][] = [];
  const pts = map?.points ?? [];
  const demo = pts.length === 0;

  if (!demo) {
    const subjColor = new Map(map!.subjects.map((s) => [s.id, hexRgb(s.color)]));
    const docOrder = new Map<number, number>();
    const lastOfDoc = new Map<number, number>();
    pts.forEach(([, docId, x, y, z, label], i) => {
      const d = map!.documents[String(docId)];
      let g: number, base: RGB;
      if (topics) {
        g = d?.kind === 'reference' ? REF : d?.topic_id ?? -1;
        base = hexRgb(g === REF ? REF_COLOR : topicColor(topics, g));
      } else {
        g = d?.subject_id ?? -1;
        base = subjColor.get(g) ?? [140, 155, 255];
      }
      if (!docOrder.has(docId)) docOrder.set(docId, docOrder.size);
      // files of one group share its colour, each nudged lighter or darker so neighbouring files read apart
      const k = docOrder.get(docId)! % 5;
      const c = k % 2 ? mix(base, [255, 255, 255], 0.1 * k) : mix(base, [0, 0, 0], 0.06 * k);
      P.push({ x, y, z, size: 1, alpha: 1, color: colorOf(c), grp: g, doc: docId, phase: r() * 6.28 });
      labels.push(label);
      if (lastOfDoc.has(docId)) threads.push([lastOfDoc.get(docId)!, i]);
      lastOfDoc.set(docId, i);
    });
    const real = P.length;
    const per = Math.max(4, Math.min(40, Math.round(1400 / real)));
    for (let i = 0; i < real; i++) {
      const p = P[i];
      for (let j = 0; j < per; j++) {
        const s = 0.05 + r() * 0.09;
        P.push({ x: p.x + gauss(r) * s, y: p.y + gauss(r) * s, z: p.z + gauss(r) * s, size: 0.25 + r() * 0.35,
          alpha: 0.25 + r() * 0.35, color: p.color, grp: p.grp, doc: p.doc, phase: r() * 6.28 });
      }
    }
  } else {
    // No embeddings yet: a placeholder spiral galaxy in the accent palette.
    const arms = [[139, 155, 255], [62, 230, 184], [213, 139, 255], [255, 143, 163]] as RGB[];
    for (let i = 0; i < 1300; i++) {
      const arm = i % arms.length;
      const t = r() ** 0.7;
      const ang = t * 5.2 + (arm / arms.length) * Math.PI * 2;
      const rad = 0.08 + t * 1.05;
      const spread = 0.04 + t * 0.12;
      P.push({ x: Math.cos(ang) * rad + gauss(r) * spread, y: gauss(r) * (0.05 + (1 - t) * 0.08), z: Math.sin(ang) * rad + gauss(r) * spread,
        size: r() < 0.06 ? 0.9 : 0.25 + r() * 0.35, alpha: 0.3 + r() * 0.5, color: colorOf(mix(arms[arm], [255, 255, 255], (1 - t) * 0.4)),
        grp: -1, doc: -1, phase: r() * 6.28 });
    }
  }
  const real = demo ? 0 : labels.length;
  for (let i = 0; i < 380; i++) { // far star shell for parallax
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 2.4 + r() * 1.4, q = Math.sqrt(1 - u * u);
    P.push({ x: q * Math.cos(th) * rad, y: u * rad, z: q * Math.sin(th) * rad, size: 0.18 + r() * 0.22, alpha: 0.2 + r() * 0.5,
      color: 0, grp: STAR, doc: -1, phase: r() * 6.28 });
  }

  const n = P.length;
  const s: Scene = {
    n, real, pos: new Float32Array(n * 3), phase: new Float32Array(n), size: new Float32Array(n), alpha: new Float32Array(n),
    colorIdx: new Int32Array(n), colors, grp: new Int32Array(n), doc: new Int32Array(n), labels, threads, demo,
  };
  P.forEach((p, i) => {
    s.pos[i * 3] = p.x; s.pos[i * 3 + 1] = p.y; s.pos[i * 3 + 2] = p.z;
    s.phase[i] = p.phase; s.size[i] = p.size; s.alpha[i] = p.alpha; s.colorIdx[i] = p.color; s.grp[i] = p.grp; s.doc[i] = p.doc;
  });
  return s;
}

/** Which points a focus keeps; null keeps everything. */
function focusTest(f: CloudFocus, grp: Int32Array, doc: Int32Array): ((i: number) => boolean) | null {
  if (!f) return null;
  if (f.kind === 'doc') return (i) => doc[i] === f.id;
  if (f.kind === 'topic') return (i) => grp[i] === f.id;
  if (f.kind === 'folder') { const ids = new Set(f.docs); return (i) => ids.has(doc[i]); }
  return (i) => grp[i] === REF;
}

/** A soft round glow per colour: white-hot core on dark themes, solid ink dot on light ones. */
function makeSprite([r, g, b]: RGB, light: boolean) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  if (light) {
    grad.addColorStop(0, `rgba(${r * 0.75},${g * 0.75},${b * 0.75},1)`);
    grad.addColorStop(0.28, `rgba(${r},${g},${b},0.85)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},0.18)`);
  } else {
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.16, `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)},0.95)`);
    grad.addColorStop(0.4, `rgba(${r},${g},${b},0.35)`);
  }
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.fillRect(0, 0, 64, 64);
  return c;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const VIEW = { yaw: -0.6, pitch: 0.32 };
/** Points the cloud's signature changes with; a poll only rebuilds the scene when it differs. */
const sigOf = (m: EmbeddingMap) => `${m.model}|${m.total}|${m.points.length}|${m.points[m.points.length - 1]?.[0] ?? 0}`;

export default function EmbeddingCloud({ subjectId, topics, focus = null, onFocus, onOpenSubject, onOpenDoc, highlight = null, title, className = '' }: {
  /** Set for a subject's own cloud (coloured by `topics`); omitted for the whole library. */
  subjectId?: number; topics?: Topics; focus?: CloudFocus; onFocus?: (f: CloudFocus) => void;
  onOpenSubject?: (subjectId: number) => void; onOpenDoc?: (docId: number, label: string) => void;
  /** A group (subject or topic id) to light up from outside, e.g. while its card is hovered. */
  highlight?: number | null; title?: string; className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [map, setMap] = useState<EmbeddingMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [hoverGroup, setHoverGroup] = useState<number | null>(null);
  const groupRef = useRef<number | null>(null);
  groupRef.current = hoverGroup ?? highlight;
  const focusRef = useRef<CloudFocus>(focus);
  focusRef.current = focus;
  const hoverRef = useRef<number>(-1);
  const cb = useRef({ onOpenSubject, onOpenDoc });
  cb.current = { onOpenSubject, onOpenDoc };
  const subjectMode = subjectId != null;
  const topicKey = topics?.map((t) => t.id).join(',');

  // Load, then poll quietly so new uploads appear (the endpoint is cached server-side until chunks change).
  useEffect(() => {
    let alive = true, sig = '';
    setMap(null); setLoaded(false);
    const load = () => api.embeddingMap(subjectId).then((m) => {
      if (!alive || sigOf(m) === sig) return;
      sig = sigOf(m);
      setMap(m);
    }).catch(() => {}).finally(() => alive && setLoaded(true));
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [subjectId]);

  const scene = useMemo(() => (loaded ? buildScene(map, topics) : null), [map, loaded, topicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!scene) return;
    const cv = canvas.current!, el = wrap.current!;
    const ctx = cv.getContext('2d')!;
    const { n, real, pos, phase, size, alpha, colorIdx, grp, doc } = scene;
    const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), sc = new Float32Array(n);
    const vis = new Float32Array(n).fill(1); // eased per-point visibility under the focus filter
    const want = new Float32Array(n).fill(1);
    const order = new Uint32Array(n).map((_, i) => i);
    let sprites: HTMLCanvasElement[] = [];
    let light = false, ring = 'rgba(255,255,255,0.08)', thread = [255, 255, 255];

    const readTheme = () => {
      const cs = getComputedStyle(document.documentElement);
      light = cs.getPropertyValue('--cloud-mode').trim() === 'light';
      scene.colors[0] = hexRgb(cs.getPropertyValue('--cloud-star').trim() || '#9aa1b2');
      ring = cs.getPropertyValue('--cloud-ring').trim() || ring;
      thread = hexRgb(cs.getPropertyValue('--accent').trim() || '#8b9bff');
      sprites = scene.colors.map((c) => makeSprite(c, light));
    };
    readTheme();
    const themeObs = new MutationObserver(readTheme);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      const r = el.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width; h = r.height;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const still = reducedMotion();
    // dense libraries would saturate to white under additive blending: dim dust most, nodes a little
    const dens = Math.min(1, Math.sqrt(350 / Math.max(1, real)));
    // c*/zoom/rad chase their t* targets, so a focus change glides the camera onto the files it keeps
    const cam = { ...VIEW, vy: 0, vp: 0, idle: 0, cx: 0, cy: 0, cz: 0, zoom: 1, rad: 1, tx: 0, ty: 0, tz: 0, tzoom: 1, trad: 1, fit: 1 };
    let shownFocus: CloudFocus | undefined; // last focus the targets were computed for
    const t0 = performance.now();
    let last = t0, raf = 0, visible = true, dragging = false, moved = 0, px = 0, py = 0;

    /** Frame the kept points: centroid, and the radius holding 90% of them. */
    const retarget = (f: CloudFocus) => {
      shownFocus = f;
      const test = focusTest(f, grp, doc);
      let cnt = 0, mx = 0, my = 0, mz = 0;
      for (let i = 0; i < n; i++) {
        want[i] = grp[i] === STAR || !test || test(i) ? 1 : 0;
        if (i < real && want[i]) { cnt++; mx += pos[i * 3]; my += pos[i * 3 + 1]; mz += pos[i * 3 + 2]; }
      }
      if (!test || !cnt) { cam.tx = cam.ty = cam.tz = 0; cam.trad = 1; }
      else {
        mx /= cnt; my /= cnt; mz /= cnt;
        const d: number[] = [];
        for (let i = 0; i < real; i++) if (want[i]) d.push(Math.hypot(pos[i * 3] - mx, pos[i * 3 + 1] - my, pos[i * 3 + 2] - mz));
        d.sort((a, b) => a - b);
        cam.tx = mx; cam.ty = my; cam.tz = mz;
        cam.trad = Math.max(0.18, Math.min(1, (d[Math.floor(d.length * 0.9)] ?? 0) + 0.08));
      }
      cam.fit = Math.min(3, 1 / cam.trad);
      cam.tzoom = cam.fit;
    };
    retarget(focusRef.current);
    if (still || focusRef.current) { // start already framed
      vis.set(want);
      Object.assign(cam, { cx: cam.tx, cy: cam.ty, cz: cam.tz, zoom: cam.tzoom, rad: cam.trad });
    }

    const project = (t: number) => {
      const intro = still ? 1 : easeOut(Math.min(1, (t - t0) / 1900));
      const cy = Math.cos(cam.yaw), sy_ = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const dist = 3.1 / cam.zoom, f = Math.min(w, h) * 1.15, ox = w / 2, oy = h / 2;
      const breathe = still ? 0 : t / 1000;
      for (let i = 0; i < n; i++) {
        // nodes stream out from the core with a slight per-point delay; stars are already in place
        const star = grp[i] === STAR;
        const k = star ? 1 : easeOut(Math.max(0, Math.min(1, intro * 1.25 - (phase[i] / 6.28) * 0.25)));
        const wob = 0.012 * Math.sin(breathe * 0.7 + phase[i]);
        // stars stay centred on the camera so the backdrop doesn't swing away when it re-frames
        const x = pos[i * 3] * k + wob - (star ? 0 : cam.cx), y = pos[i * 3 + 1] * k + wob * 0.6 - (star ? 0 : cam.cy),
          z = pos[i * 3 + 2] * k - (star ? 0 : cam.cz);
        const x1 = x * cy - z * sy_, z1 = x * sy_ + z * cy;
        const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
        const zc = z2 + dist;
        const s = zc > 0.1 ? f / zc : 0;
        sx[i] = ox + x1 * s; sy[i] = oy - y2 * s; sz[i] = zc; sc[i] = s;
      }
      return intro;
    };

    const drawRing = (s: number, axis: 'x' | 'y' | 'z') => {
      const cy = Math.cos(cam.yaw), sy_ = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const dist = 3.1 / cam.zoom, f = Math.min(w, h) * 1.15;
      ctx.beginPath();
      for (let j = 0; j <= 96; j++) {
        const a = (j / 96) * Math.PI * 2, c = Math.cos(a) * 1.18 * s * cam.rad, d = Math.sin(a) * 1.18 * s * cam.rad;
        const [x, y, z] = axis === 'y' ? [c, 0, d] : axis === 'x' ? [0, c, d] : [c, d, 0];
        const x1 = x * cy - z * sy_, z1 = x * sy_ + z * cy, y2 = y * cp - z1 * sp, zc = y * sp + z1 * cp + dist;
        const X = w / 2 + (x1 * f) / zc, Y = h / 2 - (y2 * f) / zc;
        if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.stroke();
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || !w) return;
      const dt = Math.min(50, t - last); last = t;
      if (focusRef.current !== shownFocus) retarget(focusRef.current);
      if (!dragging) {
        cam.idle += dt;
        cam.yaw += cam.vy; cam.pitch += cam.vp;
        cam.vy *= 0.94; cam.vp *= 0.94;
        if (!still && cam.idle > 1200 && hoverRef.current < 0) cam.yaw += dt * 0.00009; // slow drift when untouched
      }
      cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch));
      const ease = still ? 1 : Math.min(1, dt / 260);
      cam.cx += (cam.tx - cam.cx) * ease; cam.cy += (cam.ty - cam.cy) * ease; cam.cz += (cam.tz - cam.cz) * ease;
      cam.zoom += (cam.tzoom - cam.zoom) * ease; cam.rad += (cam.trad - cam.rad) * ease;
      const fade = still ? 1 : Math.min(1, dt / 160);
      for (let i = 0; i < n; i++) vis[i] += (want[i] - vis[i]) * fade;
      const intro = project(t);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // glow size stops growing past a ~560px canvas, so a full-page cloud spreads out instead of blooming white
      const spriteK = Math.min(1, 560 / Math.max(1, Math.min(w, h))) * Math.min(1.6, cam.zoom ** 0.35);

      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1;
      ctx.strokeStyle = ring;
      ctx.globalAlpha = intro;
      drawRing(1, 'y'); drawRing(0.66, 'y'); drawRing(1, 'x');

      // transient highlight (hovered node's file, or a hovered legend chip) on top of the focus filter
      const hov = hoverRef.current, hg = groupRef.current;
      const hovDoc = hov >= 0 ? doc[hov] : null;
      const dim = hovDoc !== null || hg !== null;
      const lit = (i: number) => (hovDoc !== null ? doc[i] === hovDoc : hg !== null ? grp[i] === hg : true);

      // threads: consecutive chunks of the same file
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgb(${thread[0]},${thread[1]},${thread[2]})`;
      const focused = !!focusRef.current;
      for (const [a, b] of scene.threads) {
        if (!sc[a] || !sc[b] || vis[a] < 0.05 || vis[b] < 0.05) continue;
        const on = lit(a);
        ctx.globalAlpha = intro * vis[a] * (dim ? (on ? 0.55 : 0.04) : focused ? 0.3 : 0.16);
        ctx.beginPath(); ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); ctx.stroke();
      }

      order.sort((a, b) => sz[b] - sz[a]); // far to near
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      for (let k = 0; k < n; k++) {
        const i = order[k];
        if (!sc[i]) continue;
        const isReal = i < real;
        if (grp[i] !== STAR && vis[i] < 0.03 && !isReal) continue; // filtered-out dust is gone; nodes keep a faint trace
        const v = 0.05 + 0.95 * vis[i];
        const px_ = size[i] * sc[i] * (isReal ? 0.12 : 0.1) * (0.6 + 0.4 * vis[i]) * spriteK;
        const fog = Math.max(0.15, Math.min(1, 1.35 - (sz[i] - 2) * 0.35));
        const near = Math.min(1, Math.max(0, (sz[i] - 0.3) / 0.5)); // fade what passes the camera
        let a = alpha[i] * fog * near * (grp[i] === STAR ? 1 : intro * v * (isReal ? 0.45 + 0.55 * dens : dens));
        if (dim && grp[i] !== STAR) a *= lit(i) ? 1.15 : 0.12;
        if (grp[i] !== STAR && !still) a *= 0.85 + 0.15 * Math.sin(t / 900 + phase[i] * 3); // twinkle
        ctx.globalAlpha = Math.min(1, a);
        const sp = sprites[colorIdx[i]];
        const d = Math.min(64, i === hov ? px_ * 1.8 : px_);
        ctx.drawImage(sp, sx[i] - d / 2, sy[i] - d / 2, d, d);
      }

      if (hov >= 0 && sc[hov]) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = `rgb(${thread[0]},${thread[1]},${thread[2]})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx[hov], sy[hov], 9 + 2 * Math.sin(t / 220), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting && !document.hidden; });
    io.observe(el);
    const onVis = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    const pick = (cx: number, cy: number) => {
      let best = -1, bd = 16 * 16;
      for (let i = 0; i < real; i++) {
        if (!sc[i] || want[i] < 1) continue;
        const dx = sx[i] - cx, dy = sy[i] - cy, d = dx * dx + dy * dy;
        if (d < bd || (d === bd && best >= 0 && sz[i] < sz[best])) { bd = d; best = i; }
      }
      return best;
    };
    const local = (e: PointerEvent | MouseEvent) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true; moved = 0; px = e.clientX; py = e.clientY; cam.vy = cam.vp = 0;
      cv.setPointerCapture(e.pointerId);
      el.classList.add('grabbing');
    };
    const move = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - px, dy = e.clientY - py;
        px = e.clientX; py = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        cam.yaw += dx * 0.006; cam.pitch += dy * 0.006;
        cam.vy = dx * 0.006; cam.vp = dy * 0.006; cam.idle = 0;
        if (hoverRef.current >= 0) { hoverRef.current = -1; setHover(null); }
        return;
      }
      const [x, y] = local(e);
      const i = pick(x, y);
      if (i !== hoverRef.current) {
        hoverRef.current = i;
        setHover(i >= 0 ? { i, x: sx[i], y: sy[i] } : null);
      }
      cv.style.cursor = i >= 0 ? 'pointer' : '';
    };
    const up = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false; cam.idle = 0;
      el.classList.remove('grabbing');
      if (moved < 4) {
        const [x, y] = local(e);
        const i = pick(x, y);
        if (i >= 0 && cb.current.onOpenDoc) cb.current.onOpenDoc(doc[i], scene.labels[i]);
        else if (i >= 0 && grp[i] >= 0) cb.current.onOpenSubject?.(grp[i]);
      }
    };
    const leave = () => { if (!dragging && hoverRef.current >= 0) { hoverRef.current = -1; setHover(null); } };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.tzoom = Math.max(0.55, Math.min(cam.fit * 3.2, cam.tzoom * Math.exp(-e.deltaY * 0.0012)));
      cam.zoom = cam.tzoom; // wheel zoom is direct, not eased
      cam.idle = 0;
    };
    const reset = () => { Object.assign(cam, VIEW, { vy: 0, vp: 0, tzoom: cam.fit }); };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave);
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('dblclick', reset);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect(); themeObs.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('pointerleave', leave);
      cv.removeEventListener('wheel', wheel);
      cv.removeEventListener('dblclick', reset);
    };
  }, [scene]);

  /** Legend: subjects on the home page, topics (and textbooks) in a subject, with chunk counts. */
  const legend = useMemo(() => {
    if (!map) return [];
    const counts = new Map<number, number>();
    map.points.forEach(([, d]) => {
      const m = map.documents[String(d)];
      const g = subjectMode ? (m?.kind === 'reference' ? REF : m?.topic_id) : m?.subject_id;
      if (g != null) counts.set(g, (counts.get(g) ?? 0) + 1);
    });
    if (!subjectMode) return map.subjects.filter((s) => counts.has(s.id)).map((s) => ({ id: s.id, name: s.name, color: s.color, count: counts.get(s.id)! }));
    const rows = (topics ?? []).filter((t) => counts.has(t.id)).map((t) => ({ id: t.id, name: t.name, color: topicColor(topics!, t.id), count: counts.get(t.id)! }));
    if (counts.has(REF)) rows.push({ id: REF, name: 'Textbooks', color: REF_COLOR, count: counts.get(REF)! });
    return rows;
  }, [map, subjectMode, topicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileCount = map ? Object.keys(map.documents).length : 0;
  const kept = useMemo(() => {
    if (!map || !focus) return null;
    let chunks = 0;
    const files = new Set<number>();
    for (const [, d] of map.points) {
      const m = map.documents[String(d)];
      const ok = focus.kind === 'doc' ? d === focus.id : focus.kind === 'folder' ? focus.docs.includes(d)
        : focus.kind === 'topic' ? m?.topic_id === focus.id && m.kind !== 'reference' : m?.kind === 'reference';
      if (ok) { chunks++; files.add(d); }
    }
    return { chunks, files: files.size };
  }, [map, focus]);
  const chipOn = (id: number) => focus && (id === REF ? focus.kind === 'ref' : focus.kind === 'topic' && focus.id === id);

  const tip = hover && map && scene && !scene.demo ? (() => {
    const [, docId] = map.points[hover.i];
    const d = map.documents[String(docId)];
    const s = map.subjects.find((x) => x.id === d?.subject_id);
    const where = subjectMode ? (d?.kind === 'reference' ? 'Textbook' : d?.topic) : [s?.name, d?.kind === 'reference' ? 'Textbook' : d?.topic].filter(Boolean).join(' · ');
    const color = subjectMode ? (d?.kind === 'reference' ? REF_COLOR : topicColor(topics ?? [], d?.topic_id ?? -1)) : s?.color;
    return { label: scene.labels[hover.i], file: d?.filename ?? '', where, color };
  })() : null;

  return (
    <div className={`cloud ${className}`} ref={wrap}>
      <canvas ref={canvas} className="cloud-canvas" />
      <div className="cloud-hud cloud-hud-top">
        <div className="cloud-kicker"><span className="cloud-live" />{title ?? 'Knowledge cloud'}</div>
        <div className="cloud-meta">
          {!loaded ? 'Loading vectors…'
            : scene?.demo ? (subjectMode ? 'Nothing embedded in this subject yet. Upload files to a topic and they will appear here.'
              : 'Nothing embedded yet. Upload material and it will appear here.')
            : kept ? (kept.chunks ? <>{kept.chunks.toLocaleString()} of {map!.points.length.toLocaleString()} chunks
              {focus?.kind !== 'doc' && <> · {kept.files} file{kept.files === 1 ? '' : 's'}</>}</> : 'No embedded chunks here yet.')
            : <>{map!.points.length.toLocaleString()} chunks · {fileCount} file{fileCount === 1 ? '' : 's'} · PCA → 3D</>}
        </div>
        {focus && (
          <button className="cloud-focus" onClick={() => onFocus?.(null)} title="Show the whole subject">
            <span className="cloud-focus-kind">{({ doc: 'File', folder: 'Folder', ref: 'Library', topic: 'Topic' } as const)[focus.kind]}</span>
            <span className="cloud-focus-name">{focus.name}</span>
            {onFocus && <span className="cloud-focus-x" aria-hidden>×</span>}
          </button>
        )}
        {legend.length > 0 && (
          <div className="cloud-legend">
            {legend.map((s) => (
              <button key={s.id} className={`cloud-chip${hoverGroup === s.id || highlight === s.id || chipOn(s.id) ? ' on' : ''}`}
                onMouseEnter={() => setHoverGroup(s.id)} onMouseLeave={() => setHoverGroup(null)}
                onClick={() => {
                  if (!subjectMode) onOpenSubject?.(s.id);
                  else if (chipOn(s.id)) onFocus?.(null);
                  else onFocus?.(s.id === REF ? { kind: 'ref', name: s.name } : { kind: 'topic', id: s.id, name: s.name });
                }}>
                <span className="cloud-chip-dot" style={{ background: s.color, color: s.color }} />{s.name}<span className="cloud-chip-n">{s.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="cloud-hint">Drag to orbit · Scroll to zoom · Double-click to reset{subjectMode ? ' · Click a point to open it' : ''}</div>
      {tip && hover && (
        <div className="cloud-tip" style={{ left: hover.x, top: hover.y }}>
          <div className="cloud-tip-label">{tip.label}</div>
          <div className="cloud-tip-file">{tip.file}</div>
          {tip.where && <div className="cloud-tip-where"><span className="cloud-chip-dot" style={{ background: tip.color }} />{tip.where}</div>}
        </div>
      )}
    </div>
  );
}
