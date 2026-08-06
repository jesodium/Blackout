// The whole desktop surface the dashboard sees. Browser tabs have no
// window.blackout — every renderer use is feature-detected on it.
const { contextBridge, ipcRenderer } = require("electron");

const sub = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("blackout", {
  desktop: true,
  platform: process.platform, // "darwin" hides a hiddenInset window's traffic lights over the topbar's left edge
  onBleDevices: sub("ble:devices"), // cb([{deviceId, deviceName}]) — grows as devices appear
  onBleClosed: sub("ble:closed"),
  selectBleDevice: (deviceId) => ipcRenderer.send("ble:select", deviceId ?? ""), // "" cancels
  saveFile: (opts) => ipcRenderer.invoke("dialog:save", opts), // {defaultName, data, filters} -> bool
  openFile: (opts) => ipcRenderer.invoke("dialog:open", opts), // {filters} -> {name, text} | null
  onSettingsOpen: sub("settings:open"), // menu → Settings / API Keys… (Cmd+,)
  getSettings: () => ipcRenderer.invoke("settings:get"), // -> {CEREBRAS_API_KEY, DEEPGRAM_API_KEY, CEREBRAS_MODEL, TTS_VOICE}
  saveSettings: (values) => ipcRenderer.invoke("settings:save", values), // -> true
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
});
