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
  titlebar: true,
});
