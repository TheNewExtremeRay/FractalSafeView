'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('safeview', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  startVm: (filePath) => ipcRenderer.invoke('vm:start', filePath),
  stopVm: () => ipcRenderer.invoke('vm:stop'),
  status: () => ipcRenderer.invoke('vm:status'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
});