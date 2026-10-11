'use strict';

// Seed Code Mail — first-run configuration preload.
//
// The setup window has a strictly smaller bridge than the application window: it
// can read the pre-filled (public) values and save the configuration. It cannot
// reach the worker, the filesystem, or any Electron module.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seedmailSetup', {
  load: () => ipcRenderer.invoke('seedmail:setup:load'),
  save: (input) => ipcRenderer.invoke('seedmail:setup:save', input),
  cancel: () => ipcRenderer.invoke('seedmail:setup:cancel'),
});
