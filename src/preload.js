const { contextBridge, ipcRenderer } = require('electron');

// The page gets these calls and nothing else.
contextBridge.exposeInMainWorld('pet', {
  onRows: (fn) => ipcRenderer.on('rows', (_e, rows) => fn(rows)),
  onCollapsed: (fn) => ipcRenderer.on('collapsed', (_e, v) => fn(v)),
  onListMax: (fn) => ipcRenderer.on('list-max', (_e, px) => fn(px)),
  onHoverCheck: (fn) => ipcRenderer.on('hover-check', (_e, point) => fn(point)),
  onHoverReset: (fn) => ipcRenderer.on('hover-reset', () => fn()),
  onAvatar: (fn) => ipcRenderer.on('avatar', (_e, dataUrl) => fn(dataUrl)),
  onTheme: (fn) => ipcRenderer.on('theme', (_e, theme) => fn(theme)),
  // { dnd, watch, families }: do not disturb, the session being watched, whether side sessions nest.
  onMode: (fn) => ipcRenderer.on('mode', (_e, mode) => fn(mode)),
  ready: () => ipcRenderer.send('ready'),
  resize: (height) => ipcRenderer.send('resize', height),
  hover: (over) => ipcRenderer.send('hover', over),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  open: (sessionId) => ipcRenderer.send('open', sessionId),
  toggle: () => ipcRenderer.send('toggle'),
  menu: () => ipcRenderer.send('menu'),
  rowMenu: (sessionId) => ipcRenderer.send('row-menu', sessionId),
  // Where the page has content (CSS px), for a platform that can't track the pointer over a click-through window.
  shape: (rects) => ipcRenderer.send('shape', { rects }),
});
