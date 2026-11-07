// Computed-style snapshot of the app's main screens, to prove a CSS reorganisation changes nothing visible.
//   node tests/css/capture.mjs <ui url with ?backend=&token=> <out.json>
//   node tests/css/capture.mjs --diff before.json after.json
// Each element (keyed by its path of tag.classes:nth-child) gets a hash of every computed property, plus the values
// of the properties that matter most, so a difference can be shown. Run against a copy of real data (it clicks
// around but changes nothing: it opens screens and menus, never saves).
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const KEY_PROPS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'padding',
  'color', 'background-color', 'background-image', 'border', 'border-radius', 'font-family', 'font-size', 'font-weight',
  'line-height', 'opacity', 'transform', 'z-index', 'overflow', 'visibility', 'box-shadow', 'gap', 'flex', 'grid-template-columns',
  'align-items', 'justify-content', 'text-align', 'white-space', 'cursor', 'outline', 'pointer-events', 'filter', 'inset'];

if (process.argv[2] === '--diff') {
  const [a, b] = [process.argv[3], process.argv[4]].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  let diffs = 0;
  for (const scene of Object.keys(a)) {
    const A = a[scene], B = b[scene] ?? {};
    const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
    for (const k of keys) {
      if (A[k]?.h === B[k]?.h) continue;
      diffs++;
      if (diffs > 40) continue;
      const pa = A[k]?.f ?? A[k]?.p ?? {}, pb = B[k]?.f ?? B[k]?.p ?? {};
      const props = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((p) => pa[p] !== pb[p]).map((p) => `${p}: ${pa[p]} → ${pb[p]}`);
      console.log(`[${scene}] ${k}\n    ${!A[k] ? 'only after' : !B[k] ? 'only before' : props.join('\n    ') || '(a property outside the key list)'}`);
    }
  }
  console.log(diffs ? `${diffs} element(s) differ` : 'No computed-style differences.');
  process.exit(diffs ? 1 : 0);
}

const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, reducedMotion: 'reduce' });
if (process.env.FULL) await page.addInitScript((n) => { window.__FULL = n; }, Number(process.env.FULL));
const snap = {};
const settle = () => page.waitForTimeout(1200);
async function capture(name) {
  await page.mouse.move(1, 1);
  await settle();
  snap[name] = await page.evaluate((KEY) => {
    const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
    const keyOf = (el) => {
      const parts = [];
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const i = e.parentElement ? [...e.parentElement.children].indexOf(e) : 0;
        parts.unshift(`${e.tagName.toLowerCase()}${e.classList.length ? '.' + [...e.classList].sort().join('.') : ''}:${i}`);
      }
      return parts.join('>');
    };
    const res = {};
    const full = (window.__FULL ?? 0);
    let n = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(el);
      // sorted: the browser lists custom properties in stylesheet order, which a reorganisation changes harmlessly
      let all = '';
      for (const name of [...cs].sort()) all += name + ':' + cs.getPropertyValue(name) + ';';
      res[keyOf(el)] = { h: hash(all), p: Object.fromEntries(KEY.map((p) => [p, cs.getPropertyValue(p)])) };
      // FULL=n in the environment: every property of the first n elements (to find what differs)
      if (n++ < full) res[keyOf(el)].f = Object.fromEntries([...cs].map((p) => [p, cs.getPropertyValue(p)]));
    }
    return res;
  }, KEY_PROPS);
  console.log(`${name}: ${Object.keys(snap[name]).length} elements`);
}

await page.goto(url);
await page.waitForSelector('.mini-subject');
await capture('home');
await page.locator('.mini-subject[data-tip="Computing"]').click();
await page.waitForSelector('.topic-row');
await capture('subject');
// a chat with replies, opened from the sidebar's history
await page.locator('.ch-item').first().click();
await page.waitForSelector('.msg-assistant');
await capture('chat');
// the note editor (toolbar, comments)
await page.locator('.my-notes-list > *').first().click();
await page.waitForSelector('.ne-toolbar, .note-editor', { timeout: 15000 });
await capture('note');
// a context menu on a file, and the command palette
await page.locator('.topic-row').first().click();
await page.waitForTimeout(500);
const file = page.locator('.file-row, .file-item, [data-pick^="d:"]').first();
if (await file.count()) { await file.click({ button: 'right' }); await capture('menu'); await page.keyboard.press('Escape'); }
await page.keyboard.press('Control+k');
await page.keyboard.type('exam');
await capture('palette');
await page.keyboard.press('Escape');
// settings
await page.locator('.mini-bottom button').last().click();
await page.waitForSelector('.settings');
await capture('settings');
writeFileSync(out, JSON.stringify(snap));
await browser.close();
