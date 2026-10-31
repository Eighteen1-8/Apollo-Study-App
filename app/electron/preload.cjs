const { contextBridge, ipcRenderer, webUtils } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--backend-port='));
const port = arg ? arg.split('=')[1] : '47615';

contextBridge.exposeInMainWorld('studyApp', {
  backendUrl: `http://127.0.0.1:${port}`,
  openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
});
