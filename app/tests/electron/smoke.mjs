// Electron smoke run: the built app (dist/) in real Electron, on a throwaway profile and data folder, with the fake
// model server (tests/e2e/fake_llm.py). Checks the window opens and talks to its own backend, the offline lock,
// bundled spell-check dictionaries, and printing to PDF. `npm run build` first. Never touches the student's data.
//   node tests/electron/smoke.mjs
import { _electron as electron } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const backend = resolve(app, '../backend');
const python = join(backend, '.venv/Scripts/python.exe');
const tmp = mkdtempSync(join(tmpdir(), 'apollo-electron-'));
const FAKE = 47693;
const fake = spawn(python, [join(app, 'tests/e2e/fake_llm.py'), String(FAKE)], { stdio: 'inherit' });
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`); };

let eapp;
try {
  eapp = await electron.launch({
    args: ['.'], cwd: app, timeout: 60_000,
    env: {
      ...process.env, APOLLO_USER_DATA: join(tmp, 'profile'), APOLLO_DATA_DIR: join(tmp, 'data'),
      STUDY_ENV_FILE: join(tmp, 'none.env'), APOLLO_SETUP_DONE: '1', LLM_BASE_URL: `http://127.0.0.1:${FAKE}/v1`, LLM_MODEL: 'fake-chat',
      EMBED_BASE_URL: `http://127.0.0.1:${FAKE}/v1`, EMBED_MODEL: 'fake-embed',
    },
  });
  check('Electron version', true, await eapp.evaluate(() => process.versions.electron));
  const win = await eapp.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForSelector('.minibar', { timeout: 45_000 });
  check('window opens and reaches its backend', await win.locator('.home, .page, .app').count() > 0);
  const offline = await win.evaluate(async () => { try { await fetch('https://example.com', { mode: 'no-cors' }); return false; } catch { return true; } });
  check('requests off this computer are blocked', offline);
  const spell = await eapp.evaluate(({ session }) => ({ langs: session.defaultSession.getSpellCheckerLanguages(), on: session.defaultSession.isSpellCheckerEnabled() }));
  check('spell check uses the bundled dictionaries', spell.on && spell.langs.includes('en-AU'), spell.langs.join(', '));
  const misspelt = await eapp.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.webContents.session.listWordsInSpellCheckerDictionary ? 'available' : 'missing';
  });
  check('spell-check dictionary API present', misspelt === 'available');
  const pdf = await eapp.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: true, pageSize: 'A4' })).length);
  check('print to PDF works', pdf > 1000, `${pdf} bytes`);
  // Chromium flags a misspelling and suggests the Australian spelling (what the note editor's menu shows)
  await eapp.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__spell = null;
    wc.once('context-menu', (_e, p) => { globalThis.__spell = { word: p.misspelledWord, suggestions: p.dictionarySuggestions }; });
  });
  // typed, like a student would (spell check runs on edited text), in an editable div so the word can be located
  await win.evaluate(() => {
    const t = Object.assign(document.createElement('div'), { id: 'spell-probe', contentEditable: 'true', spellcheck: true });
    Object.assign(t.style, { position: 'fixed', left: '300px', top: '300px', width: '400px', height: '60px', zIndex: '99999',
      font: '20px sans-serif', background: '#fff', color: '#000' });
    document.body.appendChild(t);
    t.focus();
  });
  await win.keyboard.type('the color of the sky ', { delay: 30 });
  await win.waitForTimeout(2000); // spell check runs shortly after typing stops
  const at = await win.evaluate(() => {
    const node = document.getElementById('spell-probe').firstChild;
    const r = document.createRange();
    const i = node.data.indexOf('color');
    r.setStart(node, i); r.setEnd(node, i + 5);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await win.mouse.click(at.x, at.y, { button: 'right' });
  await win.waitForTimeout(800);
  await win.keyboard.press('Escape');
  const sp = await eapp.evaluate(() => globalThis.__spell);
  check('misspellings get suggestions', sp?.word === 'color' && sp.suggestions.includes('colour'), JSON.stringify(sp));
  await win.evaluate(() => document.getElementById('spell-probe')?.remove());
  await win.locator('.mini-add').click(); // the new-subject dialog: overlays and prompts work
  check('dialogs open', await win.locator('.modal, .modal-backdrop').count() > 0);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  // The background service dies (killed here): the app starts it again on the same address with the same token,
  // so the open window carries on without a restart.
  const backendPids = () => execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*studyapp.main*' -and $_.CommandLine -like '*${join(tmp, 'data')}*' } | ForEach-Object { $_.ProcessId }`,
  ]).toString().split(/\s+/).filter(Boolean);
  const before = backendPids();
  for (const pid of before) { try { execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' }); } catch { /* went with its parent */ } }
  let back = false;
  for (let i = 0; i < 60 && !back; i++) {
    await win.waitForTimeout(500);
    back = await win.evaluate(async () => {
      try {
        const r = await fetch(`${window.studyApp.backendUrl}/subjects`, { headers: { 'X-Apollo-Token': window.studyApp.backendToken } });
        return r.ok;
      } catch { return false; }
    }) && backendPids().some((p) => !before.includes(p));
  }
  check('the background service is started again after a crash', before.length > 0 && back, `was pid ${before.join(', ')}`);
} catch (e) {
  check('launch', false, String(e).split('\n')[0]);
} finally {
  await eapp?.close().catch(() => {});
  fake.kill();
  setTimeout(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* still locked */ } }, 1500);
}
console.log(checks.every(Boolean) ? '\nElectron smoke run passed.' : '\nElectron smoke run FAILED.');
process.exitCode = checks.every(Boolean) ? 0 : 1;
