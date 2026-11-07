import { expect, test, APIRequestContext, Page } from '@playwright/test';
import { E2E } from './ports.mjs';

/* Cloud frame rate, the folding to-do list, the chat's layout buttons, tables in notes, and the find bar. */

const API = `http://127.0.0.1:${E2E.backend}`;
const H = { 'X-Apollo-Token': E2E.token };
const post = (r: APIRequestContext, path: string, data: unknown) => r.post(API + path, { headers: H, data }).then((x) => x.json());

async function openSubject(page: Page, request: APIRequestContext, prefix: string) {
  const name = `${prefix} ${Date.now() % 100000}`;
  const subject = await post(request, '/subjects', { name });
  await page.goto('');
  await page.locator(`.mini-subject[data-tip="${name}"]`).click();
  await page.waitForSelector('.todos-section');
  return subject;
}

/** Frames the cloud draws per second (counted at the canvas's clearRect, once per frame). */
async function cloudFps(page: Page, fps: number) {
  await page.addInitScript((f) => {
    localStorage.setItem('apollo.appearance', JSON.stringify({ theme: 'midnight', accent: null, motion: 'full', cloud: true, cloudDrift: true, cloudFps: f }));
    (window as unknown as { __frames: number }).__frames = 0;
    const cr = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...a) { (window as unknown as { __frames: number }).__frames++; return cr.apply(this, a); };
  }, fps);
  await page.goto('');
  await page.waitForSelector('.cloud-canvas');
  await page.waitForTimeout(3000);
  const a = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  await page.waitForTimeout(2000);
  const b = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  return (b - a) / 2;
}

test('the cloud keeps to the chosen frame rate', async ({ browser }) => {
  const at30 = await cloudFps(await browser.newPage(), 30);
  const at60 = await cloudFps(await browser.newPage(), 60);
  expect(at30).toBeGreaterThan(22);
  expect(at30).toBeLessThan(34);
  expect(at60).toBeGreaterThan(at30 * 1.5); // (headless can't always reach a full 60)
});

test('the to-do list folds and stays folded', async ({ page, request }) => {
  await openSubject(page, request, 'Fold');
  await expect(page.locator('.todo-add')).toBeVisible();
  await page.locator('.todos-section .my-notes-title').click();
  await expect(page.locator('.todo-add')).toHaveCount(0);
  await page.reload();
  await page.locator('.mini-subject').last().click();
  await expect(page.locator('.todos-section.folded')).toBeVisible();
  await page.locator('.todos-section .my-notes-title').click();
  await expect(page.locator('.todo-add')).toBeVisible();
});

test('the chat has separate side-by-side and full-screen buttons', async ({ page, request }) => {
  await openSubject(page, request, 'Layout');
  const shell = page.locator('.chat-shell');
  if (await shell.evaluate((el) => el.classList.contains('collapsed'))) await page.locator('.chat-head').click();
  const split = page.locator('.chat-head [data-tip^="Side by side"]');
  const full = page.locator('.chat-head [data-tip="Full screen"]');
  await split.click();
  await expect(shell).toHaveClass(/halves/);
  await full.click();
  await expect(shell).toHaveClass(/full/);
  await expect(page.locator('.chat-head [data-tip^="Side by side"], .chat-head [data-tip^="Back to a floating"]')).toHaveCount(0);
  await page.locator('.chat-head [data-tip="Exit full screen"]').click();
  await expect(shell).toHaveClass(/halves/); // back to side by side, where it was
  await page.locator('.chat-head [data-tip="Back to a floating chat"]').click();
  await expect(shell).not.toHaveClass(/halves|full/);
});

test('tables in notes: insert, Tab between cells, add and delete rows and columns', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Tables');
  const note = await post(request, `/subjects/${subject.id}/notes`, { title: 'Table note' });
  await page.locator('.my-notes-list > *', { hasText: 'Table note' }).click();
  const ed = page.locator('.ne-page');
  await ed.click();
  await page.keyboard.type('Units');
  await page.keyboard.press('Enter');
  await page.locator('[aria-label="Insert a table"]').dispatchEvent('mousedown');
  await page.locator('.table-pick-cell[aria-label="3 by 2"]').click();
  await expect(ed.locator('table tr')).toHaveCount(3);
  await page.keyboard.type('Quantity');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Unit');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Force');
  await expect(ed.locator('th').first()).toHaveText('Quantity');
  await expect(ed.locator('td').first()).toHaveText('Force');
  // Tab from the last cell adds a row
  await ed.locator('tr').last().locator('td').last().click();
  await page.keyboard.press('Tab');
  await expect(ed.locator('table tr')).toHaveCount(4);
  // right-click → Table → Insert column right, then Delete row
  await ed.locator('td', { hasText: 'Force' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Table' }).hover();
  await page.locator('.ctx-item', { hasText: 'Insert column right' }).click();
  await expect(ed.locator('tr').first().locator('th')).toHaveCount(3);
  await ed.locator('td', { hasText: 'Force' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Table' }).hover();
  await page.locator('.ctx-item', { hasText: 'Delete row' }).click();
  await expect(ed.locator('td', { hasText: 'Force' })).toHaveCount(0);
  await expect(ed.locator('table tr')).toHaveCount(3);
  // saved with the note
  await expect.poll(async () => (await (await request.get(`${API}/notes/${note.id}`, { headers: H })).json()).html, { timeout: 5000 })
    .toContain('<th>Quantity</th>');
});

test('the find bar can be dragged, and goes when the note it searches is switched', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Find');
  await post(request, `/subjects/${subject.id}/notes`, { title: 'First', html: '<p>alpha beta alpha</p>' });
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Second', html: '<p>gamma</p>' });
  await page.locator('.my-notes-list > *', { hasText: 'First' }).click();
  await page.locator('.ne-page').click();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('alpha');
  await expect(page.locator('.find-count')).toHaveText('1/2');
  const bar = page.locator('.find-bar');
  const before = (await bar.boundingBox())!;
  const grip = (await page.locator('.find-grip').boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 5);
  await page.mouse.down();
  await page.mouse.move(grip.x - 200, grip.y + 120, { steps: 6 });
  await page.mouse.up();
  const after = (await bar.boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 150);
  expect(after.y).toBeGreaterThan(before.y + 90);
  await page.locator('.my-notes-list > *', { hasText: 'Second' }).click();
  await expect(bar).toHaveCount(0, { timeout: 2000 });
});
