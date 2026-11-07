// The PDF viewer against real files (after a pdf.js upgrade): a page draws, its text layer lines up with the drawn
// text, text can be selected, and Ctrl+F finds a word on pages not drawn yet.
//   node tests/pdf/check.mjs "<ui url with ?backend=&token=>" "<file name>" "<word>"
// Opens the file through the Ctrl+K palette; changes nothing.
import { chromium } from '@playwright/test';

const [url, file, word] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().replace(/token=[^&]+/, 'token=…')}`); });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`); };
try {
  await page.goto(url);
  await page.waitForSelector('.mini-subject');
  await page.keyboard.press('Control+k');
  await page.keyboard.type(file);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pdf-page canvas', { timeout: 30_000 });
  await page.waitForSelector('.pdf-page .textLayer span', { timeout: 30_000 });
  check('a page draws', true);
  // spans sit over the drawn text: same order of size as the page, not 0-height or page-sized
  const geo = await page.evaluate(() => {
    const p = document.querySelector('.pdf-page');
    const spans = [...p.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 3).slice(0, 40);
    const pr = p.getBoundingClientRect();
    const hs = spans.map((s) => s.getBoundingClientRect().height);
    const inside = spans.filter((s) => { const r = s.getBoundingClientRect(); return r.left >= pr.left - 2 && r.right <= pr.right + 2 && r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2; }).length;
    return { n: spans.length, minH: Math.min(...hs), maxH: Math.max(...hs), inside, pageH: pr.height };
  });
  check('text layer is sized like the text', geo.n > 0 && geo.minH > 4 && geo.maxH < geo.pageH / 4 && geo.inside === geo.n,
    `${geo.n} spans, heights ${geo.minH.toFixed(1)}-${geo.maxH.toFixed(1)} px, ${geo.inside} inside the page`);
  const sel = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.pdf-page .textLayer span')].find((x) => x.textContent.trim().length > 8);
    const r = document.createRange(); r.selectNodeContents(s);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return getSelection().toString();
  });
  check('text can be selected', sel.trim().length > 8, JSON.stringify(sel.slice(0, 40)));
  await page.locator('.pdf-page').first().click();
  await page.keyboard.press('Control+f');
  await page.keyboard.type(word);
  await page.waitForFunction(() => /\d+\/\d+$/.test(document.querySelector('.find-count')?.textContent ?? ''), null, { timeout: 30_000 });
  const count = await page.locator('.find-count').textContent();
  check('find counts matches in the whole file', /^1\/\d+$/.test(count.trim()), count.trim());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check('the next match is shown and painted', await page.evaluate(() => CSS.highlights?.get('find-current')?.size === 1));
  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, String(e).split('\n')[0]);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }); // SHOT=file.png: what the page showed
}
await browser.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
