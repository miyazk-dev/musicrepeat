const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  scanFolder: (dir, sort) => ipcRenderer.invoke('folder:scan', dir, sort),
  readAudio: (p) => ipcRenderer.invoke('file:read', p),
  transcode: (p) => ipcRenderer.invoke('audio:transcode', p),
  version: () => ipcRenderer.invoke('app:version'),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  toggleFullscreen: () => ipcRenderer.send('win:fullscreen'),
  setAlwaysOnTop: () => ipcRenderer.invoke('win:alwaysOnTop'),
  reveal: (p) => ipcRenderer.send('file:reveal', p),
  pickAudioFile: () => ipcRenderer.invoke('dialog:pickAudioFile'),
  openBluetooth: () => ipcRenderer.send('sys:bluetooth'),
  shutdown: () => ipcRenderer.send('sys:shutdown'),
  shutdownAbort: () => ipcRenderer.send('sys:shutdownAbort'),
  signageOpen: (data) => ipcRenderer.invoke('signage:open', data),
  signageClose: () => ipcRenderer.send('signage:close'),
  signageUpdate: (msg) => ipcRenderer.send('signage:update', msg),
  onSignageData: (cb) => ipcRenderer.on('signage:data', (_e, msg) => cb(msg)),
  remoteStart: (port, tls) => ipcRenderer.invoke('remote:start', port, tls),
  remoteStop: () => ipcRenderer.invoke('remote:stop'),
  sendRemoteState: (s) => ipcRenderer.send('remote:state', s),
  sendRemoteTracks: (t) => ipcRenderer.send('remote:tracks', t),
  onRemoteCommand: (cb) => ipcRenderer.on('remote:cmd', (_e, msg) => cb(msg)),
  addonsList: () => ipcRenderer.invoke('addons:list'),
  addonsInstallUrl: (url) => ipcRenderer.invoke('addons:installFromUrl', url),
  addonsInstallZip: () => ipcRenderer.invoke('addons:installFromZip'),
  addonsRemove: (id) => ipcRenderer.invoke('addons:remove', id),
  addonsOpenFolder: () => ipcRenderer.invoke('addons:openFolder'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onFullscreen: (cb) => ipcRenderer.on('fs-changed', (_e, v) => cb(v))
});
