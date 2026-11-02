// Electron main process: starts the Python sidecar, locks the app to localhost, opens the window.
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, screen, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

const isDev = process.argv.includes('--dev');
const DEV_PORT = 47615; // fixed in dev so the UI can also be opened in a plain browser
let backend = null;
let backendPort = null;

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

function healthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(port, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
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

async function startBackend() {
  if (isDev && (await healthy(DEV_PORT))) return DEV_PORT; // reuse a backend started by hand
  const port = isDev ? DEV_PORT : await freePort();
  const dataDir = path.join(app.getPath('userData'), 'data');
  const { cmd, args, cwd } = backendCommand(port, dataDir);
  // The portable exe unpacks to a temp folder; a .env next to the exe itself can seed endpoints and keys.
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const env = app.isPackaged ? { ...process.env, STUDY_ENV_FILE: path.join(exeDir, '.env') } : process.env;
  backend = spawn(cmd, args, { cwd, windowsHide: true, env });
  backend.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backend.on('exit', (code) => { console.log(`[backend] exited ${code}`); backend = null; });
  if (!(await waitHealthy(port))) throw new Error('Backend did not start');
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
      sandbox: false,
      additionalArguments: [`--backend-port=${backendPort}`],
    },
  });
  if (state.maximized) win.maximize();
  trackBounds(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) e.preventDefault();
  });
  if (isDev) await win.loadURL('http://localhost:5173');
  else await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('dialog:openFiles', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog({
    properties: opts.multi === false ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [
      { name: 'Study material', extensions: ['pdf', 'pptx', 'docx', 'txt', 'md', 'csv', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), opts.defaultName || 'export.pdf'),
    filters: opts.filters || [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });

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

app.whenReady().then(async () => {
  app.setAppUserModelId('com.apollo.study'); // needed for Windows notifications later
  lockToLocalhost();
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
app.on('before-quit', () => { if (backend) backend.kill(); });
