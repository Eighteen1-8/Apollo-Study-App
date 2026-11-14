// Electron main process: starts the Python sidecar, locks the app to localhost, opens the window.
const { app, BrowserWindow, clipboard, ipcMain, dialog, Menu, nativeImage, nativeTheme, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const isDev = process.argv.includes('--dev');
const DEV_PORT = 47615; // fixed in dev so the UI can also be opened in a plain browser
// Testing an unpackaged build without touching the student's data (never in the packaged app):
// APOLLO_USER_DATA = a throwaway Electron profile (window state, spelling, local storage), APOLLO_DATA_DIR (below) =
// a throwaway data folder for the backend.
if (!app.isPackaged && process.env.APOLLO_USER_DATA) app.setPath('userData', path.resolve(process.env.APOLLO_USER_DATA));
let backend = null;
let backendPort = null;
// Every request to the backend carries this per-launch secret (backend api.require_token), so web pages open in a
// browser on this computer can't use the local API. It reaches the backend in its environment and the renderer
// through the preload (ipc 'backend:token'), never on a command line.
let backendToken = crypto.randomBytes(32).toString('base64url');
// Path grants (backend grants.py): the backend only touches a file outside its data folder if this process signed
// its path, which happens only for files the student picks in a dialog or drops in. The key never reaches the page.
const grantKey = crypto.randomBytes(32).toString('base64url');
function grant(mode, p) {
  // must match backend grants.normalise: absolute, and only A-Z lowercased on Windows
  const norm = process.platform === 'win32' ? path.resolve(p).replace(/[A-Z]/g, (c) => c.toLowerCase()) : path.resolve(p);
  return crypto.createHmac('sha256', grantKey).update(`${mode}
${norm}`).digest('hex');
}

// Window chrome: the native title bar is replaced by the app's own strip; the min/max/close buttons are drawn by
// Windows on top of it in the theme's colours. The renderer reports the colours on every theme change and the last
// ones are kept so the next launch opens in them.
const TITLEBAR_H = 34;
const chromeFile = () => path.join(app.getPath('userData'), 'window-chrome.json');
function loadChrome() {
  try { return { color: '#080a10', symbol: '#9ca4ba', bg: '#0b0d14', dark: true, ...JSON.parse(fs.readFileSync(chromeFile(), 'utf8')) }; }
  catch { return { color: '#080a10', symbol: '#9ca4ba', bg: '#0b0d14', dark: true }; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function healthy(port, pathname = '/health', headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers, timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(port, ms = 30000, gone = () => false) {
  const end = Date.now() + ms;
  while (Date.now() < end && !gone()) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function backendCommand(port, dataDir) {
  const common = ['--port', String(port), '--data-dir', dataDir, '--parent-pid', String(process.pid)];
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'backend', 'studyapp-backend.exe');
    return { cmd: exe, args: common, cwd: path.dirname(exe) };
  }
  const root = path.resolve(__dirname, '..', '..', 'backend');
  return {
    cmd: path.join(root, '.venv', 'Scripts', 'python.exe'),
    args: ['-m', 'studyapp.main', ...common],
    cwd: root,
  };
}

// The backend is this app's own child process (not one reused in dev), so a crash is ours to recover from.
let quitting = false;
let restarts = [];

async function startBackend() {
  // APOLLO_DATA_DIR (unpackaged only) runs against another data folder, e.g. a throwaway one for testing.
  const dataDir = (!app.isPackaged && process.env.APOLLO_DATA_DIR) || path.join(app.getPath('userData'), 'data');
  if (isDev && (await healthy(DEV_PORT))) {
    // Reuse a backend started by hand on this data: it wrote its token beside the database.
    try { backendToken = fs.readFileSync(path.join(dataDir, 'backend-token'), 'utf8').trim(); } catch { /* none */ }
    if (await healthy(DEV_PORT, '/jobs/pause', { 'X-Apollo-Token': backendToken })) return DEV_PORT;
    throw new Error(`Another backend is already running on port ${DEV_PORT} with a different data folder or token. Close it and start again.`);
  }
  return spawnBackend(isDev ? DEV_PORT : await freePort(), dataDir);
}

/** The backend stopped by itself while the app is open. It is started again on the same port with the same token,
 * so the open window just carries on (its panels reload when the change stream reconnects; unfinished jobs go back
 * in the queue, as after any restart). Three crashes within five minutes is not something a restart fixes: then the
 * student is told, with the log's place. */
async function backendDied(port, dataDir, code) {
  if (quitting) return;
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 5 * 60 * 1000);
  const log = path.join(dataDir, 'logs', 'backend.log');
  if (restarts.length >= 3) {
    dialog.showErrorBox('Apollo Study', `Apollo's background service keeps stopping (exit code ${code}), so the app can't carry on. `
      + `Close the app and open it again. [APO-APP-001]\n\nThe log is at ${log}.`);
    return;
  }
  restarts.push(now);
  console.warn(`[backend] stopped unexpectedly (exit code ${code}); starting it again`);
  try {
    await spawnBackend(port, dataDir);
  } catch (e) {
    if (!quitting) dialog.showErrorBox('Apollo Study', `Apollo's background service stopped and couldn't be started again.\n\n${e.message}`);
  }
}

async function spawnBackend(port, dataDir) {
  const { cmd, args, cwd } = backendCommand(port, dataDir);
  // The portable exe unpacks to a temp folder; a .env next to the exe itself can seed endpoints and keys.
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const env = { ...process.env, APOLLO_TOKEN: backendToken, APOLLO_GRANT_KEY: grantKey, ...(app.isPackaged ? { STUDY_ENV_FILE: path.join(exeDir, '.env') } : {}) };
  const child = spawn(cmd, args, { cwd, windowsHide: true, env });
  backend = child;
  let startupError = '';
  let stderrTail = '';
  let exited = false;
  let exitCode = null;
  let started = false;
  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => {
    process.stderr.write(`[backend] ${d}`);
    stderrTail = (stderrTail + String(d)).slice(-1500);
    const m = /STUDYAPP_ERROR (.*)/.exec(String(d));
    if (m) startupError = m[1].trim();
  });
  child.on('error', (e) => { startupError = startupError || `The background service couldn't be started (${e.message}). [APO-APP-003]`; exited = true; });
  child.on('exit', (code) => {
    console.log(`[backend] exited ${code}`);
    if (backend === child) backend = null;
    exited = true;
    exitCode = code;
    if (started) backendDied(port, dataDir, code);
  });
  if (!(await waitHealthy(port, 30000, () => exited))) {
    if (!exited) child.kill(); // too slow: don't leave it running behind the error message
    // the backend's own explanation when it gave one; otherwise the end of what it printed, so the cause is visible
    const last = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    const log = path.join(dataDir, 'logs', 'backend.log');
    throw new Error(startupError
      || (exited ? `The background service stopped while starting (exit code ${exitCode}). [APO-APP-003]${last ? `\n\n${last}` : ''}`
        : 'The background service took longer than 30 seconds to start. Your computer may be busy; try again. [APO-APP-003]')
      + `\n\nThe log is at ${log}. The code is explained in docs/ERRORS.md.`);
  }
  started = true;
  return port;
}

function lockToLocalhost() {
  // Fully offline: the renderer may only talk to local files and the local backend.
  const allowedProtocols = new Set(['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:']);
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    let ok = false;
    try {
      const u = new URL(details.url);
      ok = allowedProtocols.has(u.protocol) || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    } catch { ok = false; }
    if (!ok) console.warn('[blocked]', details.url);
    cb({ cancel: !ok });
  });
}

// Spell check (text fields, the note editor): Hunspell dictionaries bundled in assets/dictionaries are copied to
// where Chromium looks for them, and it is never allowed to download any (the app stays offline): a language without a
// bundled dictionary just isn't available. The chosen languages are kept per machine in spelling.json (default en-AU).
const DICT_SRC = path.join(__dirname, '..', 'assets', 'dictionaries');
const spellFile = () => path.join(app.getPath('userData'), 'spelling.json');
const bundledDicts = () => { try { return fs.readdirSync(DICT_SRC).filter((f) => f.endsWith('.bdic')); } catch { return []; } };
/** Languages with a bundled dictionary: "en-AU-10-1.bdic" → "en-AU". */
const spellLanguages = () => [...new Set(bundledDicts().map((f) => f.replace(/-\d+-\d+\.bdic$/, '')))];
function loadSpelling() {
  try { const v = JSON.parse(fs.readFileSync(spellFile(), 'utf8')); return Array.isArray(v.languages) ? v.languages : ['en-AU']; }
  catch { return ['en-AU']; }
}
function applySpelling(languages) {
  const s = session.defaultSession;
  const usable = languages.filter((l) => spellLanguages().includes(l));
  s.setSpellCheckerEnabled(usable.length > 0);
  if (usable.length) s.setSpellCheckerLanguages(usable);
  return usable;
}
function setupSpelling() {
  const dir = path.join(app.getPath('userData'), 'Dictionaries');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of bundledDicts()) {
      const to = path.join(dir, f);
      if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(path.join(DICT_SRC, f)).size) fs.copyFileSync(path.join(DICT_SRC, f), to);
    }
  } catch (e) { console.warn('[spelling]', e.message); }
  // anything missing would otherwise be fetched from Google: point the download at a closed local port instead
  session.defaultSession.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
  applySpelling(loadSpelling());
}
ipcMain.handle('spell:info', () => ({ languages: loadSpelling(), available: spellLanguages() }));
ipcMain.handle('spell:set', (_e, languages) => {
  const langs = Array.isArray(languages) ? languages.filter((l) => typeof l === 'string').slice(0, 3) : [];
  try { fs.writeFileSync(spellFile(), JSON.stringify({ languages: langs })); } catch { /* not saved */ }
  return applySpelling(langs);
});
ipcMain.handle('spell:add', (_e, word) => { if (typeof word === 'string' && word.length < 100) session.defaultSession.addWordToSpellCheckerDictionary(word); });
ipcMain.handle('spell:replace', (e, word) => { if (typeof word === 'string' && word.length < 100) e.sender.replaceMisspelling(word); });
// Chromium only reports the misspelled word under the pointer with its own context menu, which a page cancelling the
// right-click suppresses. So a page that wants it doesn't cancel: it claims the next menu first (synchronously, so
// the claim is in before Chromium's menu request), and gets the spelling result back instead of a native menu.
const menuClaims = new Set();
ipcMain.on('menu:claim', (e) => { menuClaims.add(e.sender.id); setTimeout(() => menuClaims.delete(e.sender.id), 1000); e.returnValue = true; });

// Size, position and maximised state come back on the next launch (if that spot is still on a screen).
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const b = st.bounds;
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80);
    return visible ? st : { bounds: { width: b.width, height: b.height }, maximized: st.maximized };
  } catch { return { bounds: { width: 1400, height: 900 }, maximized: false }; }
}
function trackBounds(win) {
  const save = () => {
    try { fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })); }
    catch { /* not persisted */ }
  };
  win.on('close', save);
}

async function createWindow() {
  const chrome = loadChrome();
  const state = loadBounds();
  nativeTheme.themeSource = chrome.dark ? 'dark' : 'light'; // the 1px window border and native menus
  const win = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 640,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: chrome.bg,
    title: 'Apollo Study',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbol, height: TITLEBAR_H },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // the preload only uses contextBridge/ipcRenderer/webUtils; it gets the backend over ipc
    },
  });
  if (state.maximized) win.maximize();
  trackBounds(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron shows no context menu of its own: text fields and selected text the page doesn't handle itself get the
  // usual Cut / Copy / Paste / Select all (the page's own menus call preventDefault, so this never doubles up).
  win.webContents.on('context-menu', (_e, p) => {
    // a page menu that wants Chromium's spelling result (the note editor) claimed this one: hand it the result instead
    if (menuClaims.delete(win.webContents.id)) {
      win.webContents.send('menu:params', { misspelledWord: p.misspelledWord, suggestions: p.dictionarySuggestions.slice(0, 6) });
      return;
    }
    if (!p.isEditable && !p.selectionText.trim()) return;
    const f = p.editFlags;
    // a misspelled word: suggestions first (the chat box and other text fields; the note editor has its own menu)
    const spelling = p.isEditable && p.misspelledWord ? [
      ...p.dictionarySuggestions.slice(0, 5).map((w) => ({ label: w, click: () => win.webContents.replaceMisspelling(w) })),
      ...(p.dictionarySuggestions.length ? [] : [{ label: 'No suggestions', enabled: false }]),
      { label: 'Add to dictionary', click: () => session.defaultSession.addWordToSpellCheckerDictionary(p.misspelledWord) },
      { type: 'separator' },
    ] : [];
    const items = p.isEditable
      ? [...spelling, { role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
        { type: 'separator' }, { role: 'selectAll', enabled: f.canSelectAll }]
      : [{ role: 'copy', enabled: f.canCopy }];
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  // The page's process died (out of memory, a GPU or driver fault): load it again instead of leaving a blank
  // window. Everything is saved as it's made, so nothing but the open view is lost. At most 3 times a minute.
  let reloads = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[renderer] gone:', details.reason, details.exitCode);
    if (quitting || details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    reloads = reloads.filter((t) => now - t < 60000);
    if (reloads.length >= 3) {
      dialog.showErrorBox('Apollo Study', `The app's window keeps crashing (${details.reason}). Close the app and open it again.`);
      return;
    }
    reloads.push(now);
    win.webContents.reload();
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) e.preventDefault();
  });
  if (isDev) await win.loadURL('http://localhost:5173');
  else await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('dialog:openFiles', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog({
    properties: opts.multi === false ? ['openFile'] : ['openFile', 'multiSelections'],
    // the formats backend parsers.SUPPORTED reads
    filters: opts.filters || [
      { name: 'Study material', extensions: ['pdf', 'pptx', 'docx', 'txt', 'md', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'rtf', 'tex',
        'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths.map((p) => ({ path: p, grant: grant('read', p) }));
});

ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), opts.defaultName || 'export.pdf'),
    filters: opts.filters || [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? null : { path: res.filePath, grant: grant('write', res.filePath) };
});

// A file dropped on the window: the preload resolved its path from a real File object, which page script can't forge.
ipcMain.on('grant:dropped', (e, p) => { e.returnValue = typeof p === 'string' && p ? grant('read', p) : ''; });

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });

// Export to PDF: the page puts what to print in #print-root and its print styles hide everything else.
ipcMain.handle('print:pdf', async (e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const name = String(opts.defaultName || 'export').replace(/[<>:"/\\|?*]+/g, ' ').trim() || 'export';
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${name}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const data = await e.sender.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  fs.writeFileSync(res.filePath, data);
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});

// A screenshot of part of the window (CSS pixels), for the chat or the clipboard.
ipcMain.handle('capture:rect', async (e, r) => {
  const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
  const img = await e.sender.capturePage(rect);
  return img.toPNG().toString('base64');
});
ipcMain.handle('clipboard:image', (_e, png) => { clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(String(png), 'base64'))); });

// The study timer finished (StudyTimer.tsx): flash the taskbar button until the window is looked at.
ipcMain.on('window:flash', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  win.once('focus', () => { if (!win.isDestroyed()) win.flashFrame(false); });
});

ipcMain.on('backend:info', (e) => { e.returnValue = { url: `http://127.0.0.1:${backendPort}`, token: backendToken }; });

// Settings → Appearance → UI size: the page's zoom (Chromium's own, so pointer maths and pdf.js stay right).
ipcMain.on('window:zoom', (e, f) => {
  const z = Number(f);
  if (Number.isFinite(z) && z >= 0.8 && z <= 1.6) e.sender.setZoomFactor(z);
});

// Ctrl + / Ctrl - / Ctrl 0 go to the page (theme.ts), which changes the saved UI size and zooms through window:zoom,
// so the shortcuts and the Settings slider always agree. Both Ctrl+= and Ctrl+Plus (and the numpad keys) count.
function zoomItems() {
  const step = (dir) => (_item, win) => { if (win) win.webContents.send('zoom:step', dir); };
  return [
    { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: step(0) },
    { label: 'Bigger', accelerator: 'CmdOrCtrl+=', click: step(1) },
    { label: 'Smaller', accelerator: 'CmdOrCtrl+-', click: step(-1) },
    { label: 'Bigger', accelerator: 'CmdOrCtrl+Plus', click: step(1), visible: false },
    { label: 'Bigger', accelerator: 'CmdOrCtrl+numadd', click: step(1), visible: false },
    { label: 'Smaller', accelerator: 'CmdOrCtrl+numsub', click: step(-1), visible: false },
    { label: 'Actual size', accelerator: 'CmdOrCtrl+num0', click: step(0), visible: false },
  ];
}

ipcMain.on('window:chrome', (e, c) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !c || typeof c.color !== 'string') return;
  try {
    win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbol, height: TITLEBAR_H });
    win.setBackgroundColor(c.bg);
    nativeTheme.themeSource = c.dark ? 'dark' : 'light';
    fs.writeFileSync(chromeFile(), JSON.stringify({ color: c.color, symbol: c.symbol, bg: c.bg, dark: !!c.dark }));
  } catch (err) { console.warn('[chrome]', err.message); }
});

// One running copy per profile: a second launch (a double click on the icon while it's still starting) would start a
// second backend on the same data. It hands over to the first, which comes to the front. The backend guards its data
// folder too (APO-APP-004), for copies this lock can't see.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (!firstInstance) return;
  app.setAppUserModelId('com.apollo.study'); // needed for Windows notifications later
  // The menu bar is hidden; this keeps its shortcuts. Select all and Find are left to the page, which limits them to
  // the document, notes or chat being read instead of the whole window.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, ...zoomItems()] },
  ]));
  lockToLocalhost();
  setupSpelling();
  try {
    backendPort = await startBackend();
  } catch (e) {
    dialog.showErrorBox('Apollo Study', `Could not start the local backend.\n\n${e.message}`);
    app.quit();
    return;
  }
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (backend) backend.kill(); });
