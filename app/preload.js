// The only bridge between the page and the computer: load/save data and settings, download the calendar
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  fetchCalendar: url => ipcRenderer.invoke('calendar:fetch', url),
});
