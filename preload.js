'use strict';
/* What the screens may ask the desktop program to do (printing, the old program's data, folders, updates). */
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  version: call('rm:version'),
  print: call('rm:print'),
  printers: call('rm:printers'),
  findOldData: call('rm:find-old'),
  readOldData: call('rm:read-old'),
  chooseFolder: call('rm:choose-folder'),
  openPath: call('rm:open-path'),
  openExternal: call('rm:open-external'),
  relaunch: call('rm:relaunch'),
  checkUpdates: call('rm:check-updates'),
});
