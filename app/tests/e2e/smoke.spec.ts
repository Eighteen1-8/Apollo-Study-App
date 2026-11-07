import { expect, test, APIRequestContext } from '@playwright/test';
import { E2E } from './ports.mjs';

/* One pass through the things that broke or changed most: open a subject, chat with a (fake) model, delete the chat
   and undo it, reorder to-dos and undo it, and the command palette. */

const API = `http://127.0.0.1:${E2E.backend}`;
const H = { 'X-Apollo-Token': E2E.token };
const post = (r: APIRequestContext, path: string, data: unknown) => r.post(API + path, { headers: H, data }).then((x) => x.json());
const get = (r: APIRequestContext, path: string) => r.get(API + path, { headers: H }).then((x) => x.json());

test('subject, chat, delete + undo, to-do reorder + undo, palette', async ({ page, request }) => {
  const name = `E2E Physics ${Date.now() % 100000}`;
  const subject = await post(request, '/subjects', { name });
  await post(request, `/subjects/${subject.id}/todos`, { text: 'Revise vectors' });
  await post(request, `/subjects/${subject.id}/todos`, { text: 'Past paper 2023' });

  await page.goto('');
  await page.locator(`.mini-subject[data-tip="${name}"]`).click();

  // chat: the reply streams into this chat and is saved
  const box = page.locator('.composer textarea');
  await box.fill('What is projectile motion?');
  await box.press('Enter');
  await expect(page.locator('.msg-assistant').last()).toContainText('Hello from the fake model', { timeout: 20_000 });
  await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await get(request, `/subjects/${subject.id}/chats`))[0]?.title).toBe('Fake title');
  const chats = await get(request, `/subjects/${subject.id}/chats`);
  expect(chats.length).toBe(1);

  // slash commands run in the app: Enter on a suggestion runs it, /stats shows the reply's real usage
  await box.fill('/sta');
  await expect(page.locator('.slash-item').first()).toContainText('/stats');
  await box.press('Enter');
  await expect(page.locator('.msg-local').last()).toContainText('138'); // 120 prompt + 18 completion tokens
  await box.fill('/help');
  await box.press('Enter');
  await expect(page.locator('.cmd-card-title').last()).toHaveText('Commands');

  // delete from the sidebar (asks first), then Ctrl+Z brings it back
  const item = page.locator('.ch-item').first();
  await item.hover();
  await item.locator('.ch-del').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const title = chats[0].title as string;
  await expect(page.locator('.ch-item', { hasText: title })).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 450 } }); // out of any text field
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ch-item', { hasText: title })).toHaveCount(1);

  // to-dos: drag the second above the first; Ctrl+Z puts them back
  const todos = page.locator('.todo .todo-text');
  const first = await todos.nth(0).textContent();
  const second = await todos.nth(1).textContent();
  // (the list can re-render under a drag that starts while it reloads, so the drag is retried until it lands)
  await expect(async () => {
    await page.locator('.todo').nth(1).dragTo(page.locator('.todo').nth(0), { targetPosition: { x: 20, y: 3 } });
    await expect(todos.nth(0)).toHaveText(second!, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.locator('body').click({ position: { x: 5, y: 450 } });
  await page.keyboard.press('Control+z');
  await expect(todos.nth(0)).toHaveText(first!);

  // Ctrl+K finds the subject's chat and opens it
  await page.keyboard.press('Control+k');
  await page.keyboard.type(name.split(' ')[0]);
  await expect(page.locator('.palette')).toContainText(name);
  await page.keyboard.press('Escape');
});
