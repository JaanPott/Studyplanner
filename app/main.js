/**
 * Study Planner – Electron main process.
 *
 * Data lives in the user's app-data folder (%APPDATA%\Study Planner):
 *   planner.json         tests, study plan, dismissed calendar tests
 *   settings.json        iCal link + test keywords
 *   calendar-cache.json  last downloaded calendar, shown when offline
 *
 * The calendar is downloaded here rather than in the page, because Google's iCal feed
 * can't be fetched from a web page (no CORS headers).
 */
const { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = { icalUrl: '', keyword: 'test' };

const file = name => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return fallback; }
}

// Write to a temp file and rename, so a crash mid-write can't leave a half-written file
function writeJson(name, value) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

ipcMain.handle('data:load', () => readJson('planner.json', null));
ipcMain.handle('data:save', (e, data) => writeJson('planner.json', data));
ipcMain.handle('settings:load', () => ({ ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) }));
ipcMain.handle('settings:save', (e, settings) => writeJson('settings.json', settings));

ipcMain.handle('calendar:fetch', async (e, rawUrl) => {
  const url = String(rawUrl || '').trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(url)) return { error: 'The calendar link must start with https://' };
  const cache = readJson('calendar-cache.json', null);
  const cached = cache && cache.url === url ? cache : null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      throw new Error(res.status === 404
        ? 'Calendar not found – check the iCal link in Settings'
        : `The calendar server answered with error ${res.status}`);
    }
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link is not an iCal calendar – check Settings');
    const fetchedAt = Date.now();
    writeJson('calendar-cache.json', { url, text, fetchedAt });
    return { text, fetchedAt };
  } catch (err) {
    const error = err.name === 'TimeoutError' ? 'The calendar took too long to answer'
      : err.name === 'TypeError' ? 'Could not reach the calendar – are you online?'
      : err.message;
    return cached ? { text: cached.text, fetchedAt: cached.fetchedAt, error } : { error };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 500,
    title: 'Study Planner',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0a09' : '#fafaf9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Links open in the normal browser, never inside the app
  const openOutside = url => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) { e.preventDefault(); openOutside(url); }
  });
  return win;
}

// One window only, so two copies never overwrite each other's data
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(() => { win = createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
