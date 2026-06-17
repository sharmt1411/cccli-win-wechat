const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow: () => ipcRenderer.invoke('app:close'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  
  onQrcode: (callback) => ipcRenderer.on('wechat:qrcode', (_event, value) => callback(value)),
  onStatus: (callback) => ipcRenderer.on('wechat:status', (_event, value) => callback(value)),
  onLoginSuccess: (callback) => ipcRenderer.on('wechat:login-success', () => callback()),
  onLog: (callback) => ipcRenderer.on('log', (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on('wechat:error', (_event, value) => callback(value)),

  // 配置接口
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  getAutoStart: () => ipcRenderer.invoke('config:getAutoStart'),
  setAutoStart: (enable) => ipcRenderer.invoke('config:setAutoStart', enable),
  clearToken: () => ipcRenderer.invoke('config:clearToken'),
});
