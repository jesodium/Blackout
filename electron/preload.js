const { contextBridge, ipcRenderer } = require("electron");

const sub = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("blackout", {
  desktop: true,
  platform: process.platform,
  onBleDevices: sub("ble:devices"),
  onBleClosed: sub("ble:closed"),
  selectBleDevice: (deviceId) => ipcRenderer.send("ble:select", deviceId ?? ""),
  saveFile: (opts) => ipcRenderer.invoke("dialog:save", opts),
  openFile: (opts) => ipcRenderer.invoke("dialog:open", opts),
  onSettingsOpen: sub("settings:open"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (values) => ipcRenderer.invoke("settings:save", values),
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
});
