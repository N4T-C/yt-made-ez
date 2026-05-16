const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
});
