'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const { VmManager } = require('./vm-manager');
const { parseArgs } = require('./cli');

let mainWindow = null;
let tray = null;
const vmManager = new VmManager();

function createWindow(filePath) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    if (filePath) mainWindow.webContents.send('open-file', filePath);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 480,
    minHeight: 320,
    title: 'SafeView',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (filePath) mainWindow.webContents.send('open-file', filePath);
  });

  mainWindow.on('closed', async () => {
    await vmManager.teardown();
    mainWindow = null;
  });

  // Build minimal menu
  const menu = Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Fractal SafeView',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Fractal SafeView',
              message: 'SafeView',
              detail: 'SafeView 1.0.0\nPlays untrusted .mp4 files inside an isolated Linux micro-VM.\nInternal build name: Fractal SafeView.',
            });
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  const { file } = parseArgs(process.argv);
  createWindow(file);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // OS "Open With"
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) mainWindow.webContents.send('open-file', filePath);
    else createWindow(filePath);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('pick-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open video in SafeView',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('vm:start', async (_e, filePath) => {
  try {
    return await vmManager.start(filePath);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('vm:stop', async () => {
  await vmManager.teardown();
  return { ok: true };
});

ipcMain.handle('vm:status', async () => vmManager.status());
