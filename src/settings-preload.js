const { contextBridge, ipcRenderer } = require('electron');

// The settings page gets these calls and nothing else.
contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  act: (name) => ipcRenderer.invoke('settings:act', name),
  onSnapshot: (fn) => ipcRenderer.on('settings:snapshot', (_e, snapshot) => fn(snapshot)),
  onTheme: (fn) => ipcRenderer.on('theme', (_e, theme) => fn(theme)),
});
