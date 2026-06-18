import { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 导入原有的核心业务
import { isConfigured, load as loadConfig, get as getConfig, save as saveConfig } from './src/config.js';
import { runSetup } from './src/setup.js';
import { WeChatBot } from './src/wechat.js';
import { Bridge } from './src/bridge.js';
import { NotifyWatcher } from './src/notify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tray = null;
let mainWindow = null;
let bot = null;
let bridge = null;
let notifier = null;

// 允许多开：不再使用 requestSingleInstanceLock

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 560,
    show: false, // 默认隐藏
    frame: false, // 无边框窗口
    resizable: false, // 固定大小
    maximizable: false,
    transparent: true, // 允许圆角透明
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // 当窗口失去焦点时，可以选择隐藏（像微信托盘一样）
  mainWindow.on('blur', () => {
    // mainWindow.hide(); 
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示面板', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '退出', click: () => {
      app.isQuiting = true;
      app.quit();
    }}
  ]);

  tray.setToolTip('cc-wechat');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    toggleWindow();
  });
}

function toggleWindow() {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    // 获取托盘位置并在其上方/下方显示
    // 简单起见，直接居中显示
    mainWindow.show();
    mainWindow.focus();
  }
}

import qrcodeLib from 'qrcode';

async function startWeChatService() {
  loadConfig();

  bot = new WeChatBot();
  bridge = new Bridge(bot);

  // 暴露事件给前端
  bot.on('qrcode', async (qr) => {
    if (!mainWindow) return;
    
    try {
      let qrUrl = qr.url || qr.qrcode_url || qr.qrcode_img_url;
      // 兼容某些情况下 URL 藏在 qrcode_img_content 字段里
      if (!qrUrl && qr.qrcode_img_content && qr.qrcode_img_content.startsWith('http')) {
        qrUrl = qr.qrcode_img_content;
      }

      if (qrUrl) {
        // 使用本地 qrcode 库将文本转化为 base64 图片
        const dataUrl = await qrcodeLib.toDataURL(qrUrl, { margin: 1, width: 200 });
        mainWindow.webContents.send('wechat:qrcode', { ...qr, local_base64: dataUrl });
      } else {
        mainWindow.webContents.send('wechat:qrcode', qr);
      }
    } catch (err) {
      console.error('生成二维码失败:', err);
    }
  });
  
  bot.on('qrcode-status', (status) => {
    if (mainWindow) mainWindow.webContents.send('wechat:status', status);
  });

  bot.on('login', () => {
    if (mainWindow) mainWindow.webContents.send('wechat:login-success');
    
    // 登录成功后开始工作
    notifier = new NotifyWatcher(bot, (data) => {
      bridge.onNotify(data);
    });
    notifier.start();

    bot.startPolling(async (msg) => {
      await bridge.handleMessage(msg);
    });
  });

  if (!isConfigured()) {
    // 没配置的话，尝试启动登录
    bot.login().catch(err => {
      if (mainWindow) mainWindow.webContents.send('wechat:error', err.message);
    });
  } else {
    // 已配置，直接当做登录成功启动
    bot.emit('login');
  }
}

app.whenReady().then(async () => {
  await createWindow();
  createTray(); 
  mainWindow.show(); // 开发阶段默认显示
  
  // 拦截 console.log 到前端
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    if (mainWindow) mainWindow.webContents.send('log', args.join(' '));
  }

  startWeChatService();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC 通信：前端触发特定操作
ipcMain.handle('app:close', () => mainWindow.hide());
ipcMain.handle('app:quit', () => app.quit());

// 配置管理相关的 IPC
ipcMain.handle('config:get', () => {
  return getConfig();
});

ipcMain.handle('config:save', (event, newConfig) => {
  saveConfig(newConfig);
});

ipcMain.handle('config:getAutoStart', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('config:setAutoStart', (event, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true, // 启动时隐藏到托盘
  });
});

ipcMain.handle('config:clearToken', () => {
  saveConfig({ wechat: { botToken: '', baseUrl: '', getUpdatesBuf: '', ownerUserId: '', lastContextToken: '' } });
  app.relaunch();
  app.quit();
});
