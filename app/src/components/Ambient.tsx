/* The background effect (Settings → Appearance): snow, meteors or fireflies drawn on one canvas over the whole app,
   under dialogs and menus, never taking a click. While content is open (a file, notes, flashcards… — SubjectView sets
   <html data-studying>) the layer fades to 10% so it never gets in the way of reading. Frames are drawn only while
   the window is focused and visible, capped at the knowledge cloud's frame rate; nothing runs when animations are off. */
import { useEffect, useRef } from 'react';
import { cloudFps, Effect, EffectAmount, reducedMotion, useAppearance } from '../theme';

const AMOUNT: Record<EffectAmount, number> = { light: 0.5, medium: 1, heavy: 1.8 };

interface Fx { step(dt: number, t: number): void; draw(ctx: CanvasRenderingContext2D): void }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A soft round dot drawn once and stamped with drawImage (much cheaper than a gradient per particle per frame). */
function sprite(color: string, size: number, core = 0.25) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(core, color);
  grad.addColorStop(1, 'transparent');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function snow(w: number, h: number, amount: number, light: boolean): Fx {
  const img = sprite(light ? 'rgba(120, 140, 175, 1)' : 'rgba(255, 255, 255, 1)', 32, 0.35);
  const n = Math.round(70 * amount * Math.max(0.4, (w * h) / (1280 * 800)));
  const flakes = Array.from({ length: n }, () => {
    const depth = Math.random(); // 0 far … 1 near: nearer flakes are bigger, faster and brighter
    return { x: rand(0, w), y: rand(-h, h), r: 1.2 + depth * 2.6, vy: 14 + depth * 34, sway: rand(6, 22), phase: rand(0, 6.3), freq: rand(0.3, 0.8), a: 0.25 + depth * 0.45 };
  });
  return {
    step(dt) {
      for (const f of flakes) {
        f.y += f.vy * dt;
        f.phase += f.freq * dt;
        if (f.y > h + 10) { f.y = -10; f.x = rand(0, w); }
      }
    },
    draw(ctx) {
      for (const f of flakes) {
        const x = (f.x + Math.sin(f.phase) * f.sway + w) % w, s = f.r * 4;
        ctx.globalAlpha = f.a;
        ctx.drawImage(img, x - s / 2, f.y - s / 2, s, s);
      }
    },
  };
}

export function meteors(w: number, h: number, amount: number, light: boolean, accent: string): Fx {
  type M = { x: number; y: number; vx: number; vy: number; len: number; life: number; age: number };
  const live: M[] = [];
  const gap = () => rand(5, 13) / amount; // seconds until the next one
  let next = rand(1, 4);
  const head = light ? accent : '#ffffff';
  return {
    step(dt) {
      next -= dt;
      if (next <= 0) {
        next = gap();
        const angle = rand(0.45, 0.75); // radians below horizontal, travelling down-left
        const speed = rand(650, 1050);
        live.push({ x: rand(w * 0.25, w * 1.1), y: rand(-60, h * 0.35), vx: -Math.cos(angle) * speed, vy: Math.sin(angle) * speed, len: rand(110, 220), life: rand(0.7, 1.2), age: 0 });
      }
      for (const m of live) { m.age += dt; m.x += m.vx * dt; m.y += m.vy * dt; }
      for (let i = live.length - 1; i >= 0; i--) if (live[i].age > live[i].life) live.splice(i, 1);
    },
    draw(ctx) {
      ctx.lineCap = 'round';
      for (const m of live) {
        const k = m.age / m.life, fade = Math.min(1, k * 5) * Math.min(1, (1 - k) * 3); // quick in, gentle out
        const sp = Math.hypot(m.vx, m.vy), tx = m.x - (m.vx / sp) * m.len, ty = m.y - (m.vy / sp) * m.len;
        const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
        g.addColorStop(0, head);
        g.addColorStop(0.15, accent);
        g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 0.7 * fade;
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.globalAlpha = 0.5 * fade;
        ctx.fillStyle = head;
        ctx.beginPath(); ctx.arc(m.x, m.y, 1.6, 0, 6.3); ctx.fill();
      }
    },
  };
}

function fireflies(w: number, h: number, amount: number, light: boolean, accent: string): Fx {
  const img = sprite(light ? accent : 'rgba(255, 221, 120, 1)', 48, 0.12);
  const n = Math.round(26 * amount * Math.max(0.5, (w * h) / (1280 * 800)));
  const flies = Array.from({ length: n }, () => ({
    x: rand(0, w), y: rand(0, h), dir: rand(0, 6.3), speed: rand(6, 18), turn: rand(0.2, 0.7), size: rand(10, 20),
    pulse: rand(0, 6.3), rate: rand(0.6, 1.4),
  }));
  return {
    step(dt, t) {
      for (const f of flies) {
        f.dir += Math.sin(t * f.turn + f.pulse) * dt; // a slow, meandering path
        f.x += Math.cos(f.dir) * f.speed * dt;
        f.y += Math.sin(f.dir) * f.speed * dt - 2 * dt; // a slight upward lift
        f.pulse += f.rate * dt;
        if (f.x < -20) f.x = w + 20; else if (f.x > w + 20) f.x = -20;
        if (f.y < -20) f.y = h + 20; else if (f.y > h + 20) f.y = -20;
      }
    },
    draw(ctx) {
      for (const f of flies) {
        ctx.globalAlpha = 0.12 + 0.55 * Math.pow((Math.sin(f.pulse) + 1) / 2, 2);
        ctx.drawImage(img, f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
      }
    },
  };
}

function make(effect: Effect, w: number, h: number, amount: number): Fx | null {
  const root = document.documentElement;
  const light = root.dataset.tone === 'light';
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#8b9bff';
  if (effect === 'snow') return snow(w, h, amount, light);
  if (effect === 'meteors') return meteors(w, h, amount, light, accent);
  if (effect === 'fireflies') return fireflies(w, h, amount, light, accent);
  return null;
}

export default function Ambient() {
  const [a] = useAppearance();
  const ref = useRef<HTMLCanvasElement>(null);
  const off = a.effect === 'none' || a.motion === 'off';

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || off) return;
    const ctx = canvas.getContext('2d')!;
    let fx: Fx | null = null, w = 0, h = 0;
    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fx = make(a.effect, w, h, AMOUNT[a.effectAmount]);
    };
    size();

    let raf = 0, last = 0, drawn = 0, t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const fps = cloudFps();
      if (fps && now - drawn < 1000 / fps - 2) return;
      drawn = now;
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0); // a long gap (window hidden) doesn't jump
      last = now; t += dt;
      if (!fx || reducedMotion()) { ctx.clearRect(0, 0, w, h); return; }
      fx.step(dt, t);
      ctx.clearRect(0, 0, w, h);
      fx.draw(ctx);
      ctx.globalAlpha = 1;
    };
    const run = () => { if (!raf && document.hasFocus() && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVis = () => (document.hidden ? stop() : run());
    // the theme's accent or tone can change while it runs (Settings): rebuild so colours follow
    const rebuild = new MutationObserver(size);
    rebuild.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    window.addEventListener('resize', size);
    window.addEventListener('focus', run);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', onVis);
    run();
    return () => {
      stop();
      rebuild.disconnect();
      window.removeEventListener('resize', size);
      window.removeEventListener('focus', run);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', onVis);
      ctx.clearRect(0, 0, w, h);
    };
  }, [a.effect, a.effectAmount, off]);

  if (off) return null;
  return <canvas ref={ref} className="ambient" aria-hidden />;
}
