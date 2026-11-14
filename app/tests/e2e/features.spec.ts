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
    localStorage.setItem('apollo.appearance', JSON.stringify({ theme: 'midnight', accent: null, motion: 'full', cloud: true, cloudDrift: true, cloudFps: f, version: 1 }));
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

test('note colours, table submenu and arrow keys: palettes stay open, submenus show, Down keeps the column', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Menus');
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Menu note',
    html: '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr><tr><td>e</td><td>f</td></tr></tbody></table><p>after</p>' });
  await page.locator('.my-notes-list > *', { hasText: 'Menu note' }).click();
  const ed = page.locator('.ne-page');
  await expect(ed.locator('table')).toBeVisible();

  // a left click on a colour caret opens its palette, which stays open (it used to close on the same click)
  await page.locator('[aria-label="More text colours"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('.ctx-menu .ctx-swatch-row')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await page.locator('[aria-label="Highlight colours"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('.ctx-menu .ctx-swatch-row')).toBeVisible();
  await page.locator('.ne-title').click(); // a click anywhere else closes it
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  // Down from a header cell goes to the same column of each row below, then out of the table
  await ed.locator('th', { hasText: 'b' }).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('1');
  await expect(ed.locator('tbody tr').first().locator('td').nth(1)).toHaveText(/1/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('2');
  await expect(ed.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText(/2/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('3');
  await expect(ed.locator('p', { hasText: 'after' })).toHaveText(/3/);

  // the Table submenu is drawn beside its row, on top (not clipped by the menu), and works with the mouse...
  await ed.locator('td', { hasText: 'c' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Table' }).hover();
  const sub = page.locator('.ctx-sub');
  await expect(sub).toBeVisible();
  const item = sub.locator('.ctx-item', { hasText: 'Insert row below' });
  const r = (await item.boundingBox())!;
  const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.ctx-sub'), [r.x + r.width / 2, r.y + r.height / 2]);
  expect(onTop).toBe(true);
  await item.click();
  await expect(ed.locator('table tr')).toHaveCount(4);
  // ...and with the keyboard: Down to the row, Right into the submenu, Enter
  await ed.locator('td', { hasText: 'c' }).click({ button: 'right' });
  for (let i = 0; i < 12; i++) {
    if (await page.evaluate(() => document.activeElement?.textContent?.includes('Table') ?? false)) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('ArrowRight');
  await expect(sub).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Insert row above → Insert row below
  await page.keyboard.press('Enter');
  await expect(ed.locator('table tr')).toHaveCount(5);
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
});

test('the study bar: slash commands, send only with text, and Make content minimises the chat', async ({ page, request }) => {
  // advanced mode shows the map (and Start studying) for a subject with no files; no motion skips the intro line
  await page.addInitScript(() => localStorage.setItem('apollo.appearance', JSON.stringify(
    { theme: 'midnight', accent: null, motion: 'off', cloud: true, cloudDrift: false, cloudFps: 30, advanced: true, version: 1 })));
  const name = `Study bar ${Date.now() % 100000}`;
  await post(request, '/subjects', { name });
  await page.goto('');
  await page.locator(`.mini-subject[data-tip="${name}"]`).click();
  await page.locator('.start-btn').click();
  const box = page.locator('.study-ask-row textarea');
  await expect(box).toBeVisible();
  const send = page.locator('.study-ask-row .send-btn');
  await expect(send).toBeDisabled();
  await box.fill('/st');
  await expect(page.locator('.study-ask .slash-menu .slash-item')).toHaveCount(2); // stats, stop
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(page.locator('.study-ask .slash-menu')).toHaveCount(0);
  // the send button sits inside the box
  const b = (await box.boundingBox())!, s = (await send.boundingBox())!;
  expect(s.x + s.width).toBeLessThanOrEqual(b.x + b.width);
  expect(s.y + s.height).toBeLessThanOrEqual(b.y + b.height);
  // with the chat open, Make content minimises it (the steps sit under the chat otherwise)
  await box.fill('/new');
  await box.press('Enter');
  await expect(page.locator('.chat-shell')).toHaveClass(/full/);
  await page.locator('.study-maker').first().dispatchEvent('click'); // as a Create menu would, with the chat on top
  await expect(page.locator('.make, .make-content, .sheet-scroll').first()).toBeVisible();
  await expect(page.locator('.chat-shell')).toHaveClass(/collapsed/);
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

// Tours start by themselves only once per feature and never under automation (navigator.webdriver), so the tests
// above aren't interrupted; the ? next to a feature replays its tour on demand.
test('a feature tour runs from its ? button and lights up each part', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Tour');
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Toured', html: '<p>hello</p>' });
  await page.locator('.my-notes-list > *', { hasText: 'Toured' }).click();
  await expect(page.locator('.ne-page')).toBeVisible();
  await expect(page.locator('.tour')).toHaveCount(0); // no first-time tour under automation
  await page.locator('.note-editor .tour-btn').click();
  const tour = page.locator('.tour[data-tour="notes"]');
  await expect(tour).toBeVisible();
  await expect(page.locator('.tour-count')).toContainText('1 of');
  await expect(page.locator('.tour-hole')).toBeVisible();
  const total = Number((await page.locator('.tour-count').textContent())!.match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThan(3);
  for (let n = 1; n < total; n++) {
    await page.locator('.tour-next').click();
    await expect(page.locator('.tour-count')).toContainText(`${n + 1} of ${total}`);
  }
  await page.locator('.tour-next').click(); // Finish
  await expect(tour).toHaveCount(0);
  // the help window lists every tour; one for a feature that isn't open shows its tips in the middle
  await page.locator('.mini-help').click();
  await page.locator('.tour-list-item', { hasText: 'Quizzes' }).click();
  await expect(page.locator('.tour[data-tour="quiz"] .tour-away')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour')).toHaveCount(0);
});

test('the calculator works things out, stays open across notes, and inserts into the note', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Calc');
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Sums', html: '<p>start</p>' });
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Other', html: '<p>other</p>' });
  await page.locator('.my-notes-list > *', { hasText: 'Sums' }).click();
  await page.locator('.ne-page').click();
  await page.keyboard.press('End');
  await page.locator('.note-editor .tool-calc').click();
  const calc = page.locator('.calc');
  await expect(calc).toBeVisible();
  await calc.locator('.calc-input').fill('2^10 + 5!');
  await expect(calc.locator('.calc-preview')).toHaveText('= 1144');
  await calc.locator('.calc-input').press('Enter');
  await expect(calc.locator('.calc-entry-val').last()).toHaveText('= 1144');
  await calc.locator('.calc-input').fill('(1+2');
  await calc.locator('.calc-input').press('Enter');
  await expect(calc.locator('.calc-error')).toContainText('bracket');
  await calc.locator('.calc-insert').last().click();
  await expect(page.locator('.ne-page')).toContainText('2^10 + 5! = 1144');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ne-page')).not.toContainText('= 1144');
  await page.locator('.my-notes-list > *', { hasText: 'Other' }).click();
  await expect(calc).toBeVisible(); // only its close button closes it
  await calc.locator('.calc-modes button', { hasText: 'Graphing' }).click();
  await expect(calc.locator('.calc-plot svg.plot-svg path').first()).toBeVisible();
  await calc.locator('[aria-label="Close the calculator"]').click();
  await expect(calc).toHaveCount(0);
});

test('/calc and /graph in the chat, and the calculator sends to the chat box', async ({ page, request }) => {
  await openSubject(page, request, 'CalcChat');
  const shell = page.locator('.chat-shell');
  if (await shell.evaluate((el) => el.classList.contains('collapsed'))) await page.locator('.chat-head').click();
  const box = shell.locator('textarea').first();
  // with arguments typed there's no suggestion list, so Enter runs the command (in the app, never sent to Apollo)
  await box.fill('/calc 2^10 + 5!');
  await box.press('Enter');
  await expect(page.locator('.cmd-calc')).toContainText('1144');
  await box.fill('/calc (1+2');
  await box.press('Enter');
  await expect(page.locator('.msg-note', { hasText: 'bracket' })).toBeVisible();
  await box.fill('/graph y = x^2');
  await box.press('Enter');
  const calc = page.locator('.calc');
  await expect(calc).toBeVisible();
  await expect(calc.locator('.calc-modes button.on')).toHaveText('Graphing');
  expect(await calc.locator('.calc-fn-input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toContain('x^2');
  await calc.locator('.calc-to-chat').click();
  await expect(box).toHaveValue(/```plot[\s\S]*x\^2[\s\S]*```/);
  await calc.locator('[aria-label="Close the calculator"]').click();
});

test('the timer offers focus-and-break presets', async ({ page }) => {
  await page.goto('');
  await page.locator('.mini-timer').click();
  const pill = page.locator('.timer-pill');
  await pill.locator('.timer-preset', { hasText: '50 / 10' }).click();
  await expect(pill.locator('.timer-clock')).toHaveText('50:00');
  await expect(pill.locator('.timer-phase')).toHaveText('Focus');
  await pill.locator('.timer-preset', { hasText: 'Custom' }).click();
  await expect(pill.locator('.timer-phase')).toHaveCount(0);
  await page.mouse.click(5, 400); // outside: the pill shrinks back
  await expect(pill).toHaveCount(0);
});

test('the cat comes and goes from the left bar, can be dragged, and stays where it was put', async ({ page }) => {
  await page.goto('');
  const button = page.locator('.mini-tools .mini-pet');
  const cat = page.locator('.pet-sprite');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(cat).toHaveCount(0);
  await button.click();
  await expect(cat).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const a = (await cat.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 200, a.y + a.height / 2 - 150, { steps: 8 });
  await page.mouse.up();
  const b = (await cat.boundingBox())!;
  expect(b.x).toBeGreaterThan(a.x + 150);
  expect(b.y).toBeLessThan(a.y - 100);
  await expect(page.locator('.jobs-popover')).toHaveCount(0); // a drag isn't a click
  await page.reload();
  await expect(cat).toBeVisible();
  const c = (await cat.boundingBox())!;
  expect(Math.abs(c.y - b.y)).toBeLessThan(4);
  await page.locator('.mini-tools .mini-pet').click();
  await expect(cat).toHaveCount(0);
});

test('a note dragged from the sidebar into the centre opens there, then side by side', async ({ page, request }) => {
  const subject = await openSubject(page, request, 'Drop');
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Left note', html: '<p>left</p>' });
  await post(request, `/subjects/${subject.id}/notes`, { title: 'Right note', html: '<p>right</p>' });
  /** Drag a sidebar row over the centre (the drop zones show) and let go on `zone`. */
  const dragInto = async (title: string, zone: string) => {
    await page.locator('.my-notes-list > *', { hasText: title }).hover();
    await page.mouse.down();
    const c = (await page.locator('.center').boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 8 });
    const z = page.locator(`.pane-drop-zone.z-${zone}`);
    await expect(z).toBeVisible();
    const b = (await z.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.pane-drop')).toHaveCount(0);
  };
  await dragInto('Left note', 'open'); // over the map: just opens
  await expect(page.locator('.ne-page')).toContainText('left');
  await dragInto('Right note', 'right');
  await expect(page.locator('.center-panes.is-split')).toBeVisible();
  await expect(page.locator('.pane-second .ne-page')).toContainText('right');
  await expect(page.locator('.center-panes > .pane-slot').first().locator('.ne-page')).toContainText('left');
});
