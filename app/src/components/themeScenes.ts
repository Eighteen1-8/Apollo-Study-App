/* Theme scenes: an animated layer some themes bring with them, drawn by Ambient.tsx as a background effect, so it shares its frame cap, focus pausing and fading while content is open.
   Sodium: roses, blossoms and loose petals drifting down, bubbles rising, gold stars twinkling. Nitrogen: hydrangea
   florets tumbling down, whole hydrangea heads floating across, a few sage leaves. Every shape is drawn once into a
   small canvas (a sprite) and stamped with drawImage, so a frame is only a few dozen image draws.
   It is the 'theme' background effect (Settings → Appearance), offered only for these themes and picked automatically
   when one of them is chosen; Light / Medium / Heavy scale how much of it there is. */
import type { ThemeId } from '../theme';

export interface SceneFx { step(dt: number, t: number): void; draw(ctx: CanvasRenderingContext2D): void }

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  return [c, g];
}

/* ---------------------------------------------------------------- sprites */

/** A rose seen from above: three rings of petals, lighter at the edge, and a curled centre. */
function rose(outer: string, mid: string, deep: string, S = 128) {
  const [c, g] = canvas(S);
  const u = S / 128;
  const ring = (n: number, dist: number, rx: number, ry: number, turn: number, from: string, to: string) => {
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * TAU;
      g.save();
      g.rotate(a);
      g.translate(dist * u, 0);
      const grad = g.createRadialGradient(-rx * 0.6 * u, 0, 0, 0, 0, rx * u);
      grad.addColorStop(0, to);
      grad.addColorStop(1, from);
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(0, 0, rx * u, ry * u, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255, 255, 255, 0.55)'; g.lineWidth = 1.2 * u; g.stroke();
      g.restore();
    }
  };
  ring(5, 30, 27, 22, 0, outer, mid);
  ring(5, 19, 20, 16, 0.6, mid, outer);
  ring(4, 10, 14, 11, 1.3, mid, deep);
  // the curled heart
  g.strokeStyle = deep; g.lineWidth = 2.4 * u; g.lineCap = 'round';
  g.beginPath();
  for (let k = 0; k <= 40; k++) {
    const a = k * 0.32, r = (1 + k * 0.28) * u;
    if (k === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r); else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.stroke();
  return c;
}

/** A five-petal blossom (cherry, as in the photo of the street) with little stamens. */
function blossom(petal: string, edge: string, centre: string, S = 72) {
  const [c, g] = canvas(S);
  const u = S / 72;
  for (let i = 0; i < 5; i++) {
    g.save();
    g.rotate((i / 5) * TAU);
    g.translate(0, -15 * u);
    const grad = g.createLinearGradient(0, 14 * u, 0, -14 * u);
    grad.addColorStop(0, edge); grad.addColorStop(1, petal);
    g.fillStyle = grad;
    g.beginPath();
    // a rounded petal with a small notch at its tip
    g.moveTo(0, 13 * u);
    g.bezierCurveTo(-14 * u, 4 * u, -12 * u, -14 * u, -3 * u, -14 * u);
    g.lineTo(0, -10 * u);
    g.lineTo(3 * u, -14 * u);
    g.bezierCurveTo(12 * u, -14 * u, 14 * u, 4 * u, 0, 13 * u);
    g.fill();
    g.restore();
  }
  g.fillStyle = centre;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    g.beginPath(); g.arc(Math.cos(a) * 5 * u, Math.sin(a) * 5 * u, 1.4 * u, 0, TAU); g.fill();
  }
  g.beginPath(); g.arc(0, 0, 2.6 * u, 0, TAU); g.fill();
  return c;
}

/** One loose petal (the bath full of them). */
function petal(light: string, dark: string, S = 40) {
  const [c, g] = canvas(S);
  const grad = g.createLinearGradient(-S / 3, 0, S / 3, 0);
  grad.addColorStop(0, light); grad.addColorStop(1, dark);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(-S * 0.4, 0);
  g.bezierCurveTo(-S * 0.2, -S * 0.32, S * 0.3, -S * 0.26, S * 0.42, 0);
  g.bezierCurveTo(S * 0.3, S * 0.22, -S * 0.2, S * 0.3, -S * 0.4, 0);
  g.fill();
  return c;
}

/** A soap bubble: clear middle, a pink-blue-gold sheen on the rim and a window highlight. */
function bubble(S = 96) {
  const [c, g] = canvas(S);
  const r = S / 2 - 3;
  const body = g.createRadialGradient(0, 0, 0, 0, 0, r);
  body.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
  body.addColorStop(0.75, 'rgba(210, 215, 255, 0.10)');
  body.addColorStop(0.95, 'rgba(255, 255, 255, 0.45)');
  body.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = body;
  g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
  const sheen = g.createLinearGradient(-r, -r, r, r);
  sheen.addColorStop(0, 'rgba(255, 150, 190, 0.75)');
  sheen.addColorStop(0.45, 'rgba(150, 175, 255, 0.7)');
  sheen.addColorStop(0.8, 'rgba(240, 200, 120, 0.7)');
  sheen.addColorStop(1, 'rgba(255, 150, 190, 0.75)');
  g.strokeStyle = sheen; g.lineWidth = 1.6;
  g.beginPath(); g.arc(0, 0, r - 1, 0, TAU); g.stroke();
  g.fillStyle = 'rgba(255, 255, 255, 0.85)';
  g.beginPath(); g.ellipse(-r * 0.42, -r * 0.45, r * 0.2, r * 0.11, -0.7, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.5)';
  g.beginPath(); g.arc(r * 0.45, r * 0.4, r * 0.06, 0, TAU); g.fill();
  return c;
}

/** A four-point gold star with a soft glow. */
function star(S = 64) {
  const [c, g] = canvas(S);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  glow.addColorStop(0, 'rgba(255, 225, 150, 0.55)');
  glow.addColorStop(0.35, 'rgba(240, 195, 100, 0.18)');
  glow.addColorStop(1, 'rgba(240, 195, 100, 0)');
  g.fillStyle = glow;
  g.fillRect(-S / 2, -S / 2, S, S);
  const R = S * 0.42, r = S * 0.07;
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, R);
  grad.addColorStop(0, '#fffaf0'); grad.addColorStop(0.3, '#f6d98e'); grad.addColorStop(1, '#c8952e');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - Math.PI / 2, d = i % 2 ? r : R;
    if (i === 0) g.moveTo(Math.cos(a) * d, Math.sin(a) * d); else g.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  g.closePath(); g.fill();
  return c;
}

/** A hydrangea floret: four rounded petals, paler at the heart, with a deep blue eye. */
function floretOn(g: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, color: string, eye: string) {
  g.save();
  g.translate(x, y); g.rotate(rot);
  for (let i = 0; i < 4; i++) {
    g.save();
    g.rotate((i / 4) * TAU);
    g.translate(0, -s * 0.27);
    const grad = g.createRadialGradient(0, s * 0.2, 0, 0, 0, s * 0.3);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    grad.addColorStop(0.45, color);
    grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(0, 0, s * 0.21, s * 0.27, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.5)'; g.lineWidth = Math.max(0.6, s * 0.02); g.stroke();
    g.restore();
  }
  g.fillStyle = eye;
  g.beginPath(); g.arc(0, 0, s * 0.07, 0, TAU); g.fill();
  g.restore();
}
function floret(color: string, S = 56) {
  const [c, g] = canvas(S);
  floretOn(g, 0, 0, S * 0.95, 0, color, '#4a64c8');
  return c;
}

const HYDRANGEA = ['#86a8f4', '#9db8f7', '#b3c8fb', '#7f9bef', '#9aa6f2', '#5f84e8', '#c9dafd', '#6f8fea'];

/** A whole hydrangea head: a dome of florets, shaded darker at the bottom, with two leaves behind it. */
function hydrangeaHead(S = 220) {
  const [c, g] = canvas(S);
  const R = S * 0.33;
  // leaves first, peeking out below
  for (const [a, k] of [[2.2, 1], [0.95, -1]] as const) {
    g.save();
    g.rotate(a);
    g.translate(R * 1.05, 0);
    const lg = g.createLinearGradient(-R * 0.5, 0, R * 0.5, 0);
    lg.addColorStop(0, '#6f9a82'); lg.addColorStop(1, '#9fc2ad');
    g.fillStyle = lg;
    g.beginPath();
    g.moveTo(-R * 0.5, 0);
    g.quadraticCurveTo(0, -R * 0.36 * k, R * 0.55, 0);
    g.quadraticCurveTo(0, R * 0.36 * k, -R * 0.5, 0);
    g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.45)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-R * 0.45, 0); g.lineTo(R * 0.5, 0); g.stroke();
    g.restore();
  }
  // florets, back to front, darker and smaller towards the bottom edge
  const pts = Array.from({ length: 64 }, () => {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * R;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.88 };
  }).sort((p, q) => p.y - q.y);
  for (const p of pts) {
    const edge = Math.hypot(p.x, p.y) / R;
    floretOn(g, p.x, p.y, S * rand(0.12, 0.16) * (1 - edge * 0.25), rand(0, TAU), pick(HYDRANGEA), '#4a64c8');
  }
  // a little light from above-left and shade below
  const shade = g.createRadialGradient(-R * 0.4, -R * 0.5, R * 0.1, 0, 0, R * 1.15);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  shade.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
  shade.addColorStop(1, 'rgba(40, 60, 140, 0.18)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade;
  g.fillRect(-S / 2, -S / 2, S, S);
  return c;
}

/** A sage leaf with its midrib. */
function leaf(S = 56) {
  const [c, g] = canvas(S);
  const lg = g.createLinearGradient(-S * 0.4, 0, S * 0.4, 0);
  lg.addColorStop(0, '#7fa592'); lg.addColorStop(1, '#a9c9b5');
  g.fillStyle = lg;
  g.beginPath();
  g.moveTo(-S * 0.44, 0);
  g.quadraticCurveTo(0, -S * 0.3, S * 0.44, 0);
  g.quadraticCurveTo(0, S * 0.3, -S * 0.44, 0);
  g.fill();
  g.strokeStyle = 'rgba(255, 255, 255, 0.55)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(-S * 0.4, 0); g.lineTo(S * 0.4, 0); g.stroke();
  return c;
}

/** A soft round glow (out-of-focus light). */
function bokeh(color: string, S = 64) {
  const [c, g] = canvas(S);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  grad.addColorStop(0, color); grad.addColorStop(0.5, color); grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(-S / 2, -S / 2, S, S);
  return c;
}

/* ---------------------------------------------------------------- movers */

/** Something falling (or rising, with negative vy): swaying, turning, and flipping (a squashed width) if `flip`. */
interface Drifter {
  img: HTMLCanvasElement; x: number; y: number; size: number; vy: number; vx: number; sway: number; phase: number; freq: number;
  rot: number; vr: number; flip: number; alpha: number;
}

function drifters(n: number, w: number, h: number, make: (depth: number) => Omit<Drifter, 'x' | 'y' | 'phase'>): Drifter[] {
  return Array.from({ length: n }, () => ({ ...make(Math.random()), x: rand(0, w), y: rand(-h * 0.2, h), phase: rand(0, TAU) }));
}

function stepDrifters(ds: Drifter[], dt: number, w: number, h: number) {
  for (const d of ds) {
    d.y += d.vy * dt;
    d.x += d.vx * dt;
    d.phase += d.freq * dt;
    d.rot += d.vr * dt;
    const m = d.size;
    if (d.vy > 0 && d.y > h + m) { d.y = -m; d.x = rand(-m, w + m); }
    if (d.vy < 0 && d.y < -m) { d.y = h + m; d.x = rand(-m, w + m); }
    if (d.x < -m * 2) d.x = w + m; else if (d.x > w + m * 2) d.x = -m;
  }
}

function drawDrifters(ctx: CanvasRenderingContext2D, ds: Drifter[]) {
  const base = ctx.getTransform(); // the canvas's own (dpr) scale, which Ambient set
  for (const d of ds) {
    const x = d.x + Math.sin(d.phase) * d.sway;
    ctx.globalAlpha = d.alpha;
    ctx.setTransform(base);
    ctx.translate(x, d.y);
    ctx.rotate(d.rot);
    if (d.flip) ctx.scale(0.35 + 0.65 * Math.abs(Math.cos(d.phase * d.flip)), 1);
    ctx.drawImage(d.img, -d.size / 2, -d.size / 2, d.size, d.size);
  }
}

/** Keeps the canvas's dpr scale (Ambient sets it with setTransform) across the drifters' own transforms. */
function withBase(ctx: CanvasRenderingContext2D, draw: () => void) {
  const base = ctx.getTransform();
  draw();
  ctx.setTransform(base);
}

const areaScale = (w: number, h: number) => Math.min(1.8, Math.max(0.5, (w * h) / (1440 * 900)));

/* ---------------------------------------------------------------- scenes */

function sodium(w: number, h: number, amount: number): SceneFx {
  const k = areaScale(w, h) * amount;
  const roses = [rose('#f9cfdb', '#ef9fb6', '#c9607e'), rose('#fcdccb', '#f4b39b', '#d27c66'), rose('#f3c8e4', '#dc9fca', '#a9628f')];
  const blossoms = [blossom('#fff1f5', '#f6b9cb', '#d8728f'), blossom('#fff5ee', '#f7c6b2', '#d98b6f')];
  const petals = [petal('#fde3ea', '#ef9fb4'), petal('#fdeadf', '#f2b097'), petal('#efe6fb', '#c7b6ee')];
  const bub = bubble(), st = star();

  const flowers = drifters(Math.round(6 * k), w, h, (d) => ({
    img: pick(roses), size: 16 + d * 14, vy: 9 + d * 14, vx: rand(-4, 4), sway: rand(14, 34), freq: rand(0.25, 0.5),
    rot: rand(0, TAU), vr: rand(-0.25, 0.25), flip: 0, alpha: 0.3 + d * 0.2,
  }));
  const blooms = drifters(Math.round(9 * k), w, h, (d) => ({
    img: pick(blossoms), size: 9 + d * 7, vy: 12 + d * 16, vx: rand(-6, 6), sway: rand(16, 36), freq: rand(0.35, 0.7),
    rot: rand(0, TAU), vr: rand(-0.6, 0.6), flip: 0.5, alpha: 0.3 + d * 0.2,
  }));
  const loose = drifters(Math.round(16 * k), w, h, (d) => ({
    img: pick(petals), size: 5 + d * 5, vy: 16 + d * 20, vx: rand(-10, 10), sway: rand(18, 42), freq: rand(0.5, 1),
    rot: rand(0, TAU), vr: rand(-1.2, 1.2), flip: 1.3, alpha: 0.3 + d * 0.2,
  }));
  const bubbles = drifters(Math.round(12 * k), w, h, (d) => ({
    img: bub, size: 7 + d * 14, vy: -(10 + d * 18), vx: rand(-3, 3), sway: rand(10, 26), freq: rand(0.3, 0.7),
    rot: 0, vr: 0, flip: 0, alpha: 0.3 + d * 0.25,
  }));
  const stars = Array.from({ length: Math.round(26 * k) }, () => ({
    x: rand(0, w), y: rand(0, h), size: rand(4, 10), tw: rand(0, TAU), rate: rand(0.6, 1.6), vx: rand(-3, 3), vy: rand(-2, 2), rot: rand(0, 0.8),
  }));

  return {
    step(dt) {
      stepDrifters(flowers, dt, w, h); stepDrifters(blooms, dt, w, h); stepDrifters(loose, dt, w, h); stepDrifters(bubbles, dt, w, h);
      for (const s of stars) {
        s.tw += s.rate * dt; s.x += s.vx * dt; s.y += s.vy * dt;
        if (s.x < -20) s.x = w + 20; else if (s.x > w + 20) s.x = -20;
        if (s.y < -20) s.y = h + 20; else if (s.y > h + 20) s.y = -20;
      }
    },
    draw(ctx) {
      withBase(ctx, () => {
        for (const s of stars) {
          const tw = (Math.sin(s.tw) + 1) / 2, sz = s.size * (0.7 + 0.45 * tw);
          ctx.globalAlpha = 0.12 + 0.4 * tw * tw;
          ctx.drawImage(st, s.x - sz / 2, s.y - sz / 2, sz, sz);
        }
        // a bubble breathes a little as it rises
        for (const b of bubbles) {
          const x = b.x + Math.sin(b.phase) * b.sway, sx = b.size * (1 + Math.sin(b.phase * 2.3) * 0.04), sy = b.size * (1 - Math.sin(b.phase * 2.3) * 0.04);
          ctx.globalAlpha = b.alpha;
          ctx.drawImage(b.img, x - sx / 2, b.y - sy / 2, sx, sy);
        }
      });
      withBase(ctx, () => drawDrifters(ctx, loose));
      withBase(ctx, () => drawDrifters(ctx, blooms));
      withBase(ctx, () => drawDrifters(ctx, flowers));
    },
  };
}

function nitrogen(w: number, h: number, amount: number): SceneFx {
  const k = areaScale(w, h) * amount;
  const florets = HYDRANGEA.map((c) => floret(c));
  const white = floret('#eef4ff');
  const heads = [hydrangeaHead(), hydrangeaHead(), hydrangeaHead()];
  const leafImg = leaf();
  const glows = [bokeh('rgba(120, 160, 250, 0.5)'), bokeh('rgba(170, 160, 245, 0.45)'), bokeh('rgba(200, 220, 255, 0.6)')];

  const falling = drifters(Math.round(28 * k), w, h, (d) => ({
    img: Math.random() < 0.15 ? white : pick(florets), size: 7 + d * 8, vy: 12 + d * 18, vx: rand(-8, 8), sway: rand(16, 40),
    freq: rand(0.35, 0.8), rot: rand(0, TAU), vr: rand(-0.9, 0.9), flip: rand(0.6, 1.2), alpha: 0.3 + d * 0.22,
  }));
  const big = drifters(Math.max(2, Math.round(3 * k)), w, h, (d) => ({
    img: pick(heads), size: 38 + d * 26, vy: rand(-3, 3), vx: (Math.random() < 0.5 ? -1 : 1) * rand(5, 10), sway: rand(8, 16), freq: rand(0.1, 0.2),
    rot: rand(-0.3, 0.3), vr: rand(-0.04, 0.04), flip: 0, alpha: 0.2 + d * 0.15,
  }));
  const leaves = drifters(Math.round(4 * k), w, h, (d) => ({
    img: leafImg, size: 9 + d * 7, vy: 14 + d * 12, vx: rand(-6, 6), sway: rand(20, 40), freq: rand(0.3, 0.6),
    rot: rand(0, TAU), vr: rand(-0.7, 0.7), flip: 0.9, alpha: 0.28 + d * 0.18,
  }));
  const lights = drifters(Math.round(10 * k), w, h, (d) => ({
    img: pick(glows), size: 30 + d * 50, vy: rand(-5, -1), vx: rand(-4, 4), sway: rand(10, 30), freq: rand(0.08, 0.2),
    rot: 0, vr: 0, flip: 0, alpha: 0.12 + d * 0.12,
  }));
  // a head drifts very slowly, and only vertically within the window: keep it from leaving by the top or bottom
  for (const b of big) b.y = rand(h * 0.15, h * 0.85);

  return {
    step(dt) {
      stepDrifters(lights, dt, w, h); stepDrifters(big, dt, w, h); stepDrifters(falling, dt, w, h); stepDrifters(leaves, dt, w, h);
      for (const b of big) if (b.y < h * 0.1 || b.y > h * 0.9) b.vy = -b.vy;
    },
    draw(ctx) {
      withBase(ctx, () => drawDrifters(ctx, lights));
      withBase(ctx, () => drawDrifters(ctx, big));
      withBase(ctx, () => drawDrifters(ctx, leaves));
      withBase(ctx, () => drawDrifters(ctx, falling));
    },
  };
}

const SCENES: Partial<Record<ThemeId, (w: number, h: number, amount: number) => SceneFx>> = { sodium, nitrogen };

/** The theme's scene, sized to the window (`amount` scales how many of everything), or null for a theme without one. */
export function themeScene(theme: ThemeId, w: number, h: number, amount = 1): SceneFx | null {
  return SCENES[theme]?.(w, h, amount) ?? null;
}
