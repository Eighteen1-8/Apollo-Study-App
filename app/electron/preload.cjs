// Runs sandboxed: only contextBridge, ipcRenderer and webUtils are available here.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const backend = ipcRenderer.sendSync('backend:info');
// Grants for the files the student picked or dropped (see backend grants.py). Kept here, out of the page's reach,
// except to read back the grant of a path that already has one.
const grants = new Map();
const keep = (picked) => { grants.set(picked.path, picked.grant); return picked.path; };

contextBridge.exposeInMainWorld('studyApp', {
  backendUrl: backend.url,
  backendToken: backend.token,
  openFiles: async (opts) => (await ipcRenderer.invoke('dialog:openFiles', opts)).map(keep),
  saveFile: async (opts) => { const r = await ipcRenderer.invoke('dialog:saveFile', opts); return r ? keep(r) : null; },
  pathForFile: (file) => {
    const p = webUtils.getPathForFile(file);
    if (p) grants.set(p, ipcRenderer.sendSync('grant:dropped', p));
    return p;
  },
  grantFor: (p) => grants.get(p) || '',
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  setChrome: (c) => ipcRenderer.send('window:chrome', c),
  setZoom: (f) => ipcRenderer.send('window:zoom', f),
  printPdf: (opts) => ipcRenderer.invoke('print:pdf', opts),
  capture: (rect) => ipcRenderer.invoke('capture:rect', rect),
  copyImage: (png) => ipcRenderer.invoke('clipboard:image', png),
  // spell check. The note editor shows its own right-click menu; Chromium's spelling result for the word under the
  // pointer comes back through menuParams (call it from the contextmenu handler, without cancelling the event).
  spell: {
    menuParams: () => new Promise((resolve) => {
      const on = (_e, p) => { clearTimeout(t); resolve(p); };
      const t = setTimeout(() => { ipcRenderer.removeListener('menu:params', on); resolve(null); }, 600);
      ipcRenderer.once('menu:params', on);
      ipcRenderer.sendSync('menu:claim');
    }),
    replace: (word) => ipcRenderer.invoke('spell:replace', String(word)),
    add: (word) => ipcRenderer.invoke('spell:add', String(word)),
    info: () => ipcRenderer.invoke('spell:info'),
    set: (languages) => ipcRenderer.invoke('spell:set', languages),
  },
  titlebar: true,
});
