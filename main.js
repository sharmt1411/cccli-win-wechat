import { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, nativeImage, dialog } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 导入原有的核心业务
import { isConfigured, load as loadConfig, get as getConfig, save as saveConfig } from './src/config.js';
import { runSetup, ensureHooks, uninstallHook } from './src/setup.js';
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
let instanceLockPath = null;

// 允许多开（不同文件夹各一个实例）；但同一文件夹只允许一个实例，
// 因为 config.json / notifyDir 都按启动文件夹寻址，多开同文件夹会互相覆盖。
function instanceBaseDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
}

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但无权限发信号，仍视为存活；ESRCH = 不存在
    return e.code === 'EPERM';
  }
}

/**
 * 尝试获取「当前文件夹」的单实例锁。
 * 成功返回 { ok: true }；若同文件夹已有存活实例返回 { ok: false, pid }。
 */
function acquireInstanceLock() {
  const lockPath = path.join(instanceBaseDir(), 'cc-wechat.lock');
  if (existsSync(lockPath)) {
    try {
      const prevPid = parseInt(String(readFileSync(lockPath, 'utf-8')).trim(), 10);
      if (isPidAlive(prevPid)) {
        return { ok: false, pid: prevPid };
      }
    } catch { /* 锁文件损坏，按可重建处理 */ }
  }
  try {
    writeFileSync(lockPath, String(process.pid), 'utf-8');
    instanceLockPath = lockPath;
  } catch (e) {
    console.error('写入实例锁失败:', e.message);
  }
  return { ok: true };
}

function releaseInstanceLock() {
  if (!instanceLockPath) return;
  try {
    // 仅当锁仍属于本进程时才删除，避免误删后来者的锁
    const pid = parseInt(String(readFileSync(instanceLockPath, 'utf-8')).trim(), 10);
    if (pid === process.pid) unlinkSync(instanceLockPath);
  } catch { /* ignore */ }
  instanceLockPath = null;
}

function getLoginItemPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getLoginItemArgs() {
  const args = [];
  if (process.defaultApp && process.argv[1]) {
    args.push(path.resolve(process.argv[1]));
  }
  args.push('--hidden');
  return args;
}

function getLoginItemQueryOptions() {
  return {
    path: getLoginItemPath(),
    args: getLoginItemArgs(),
  };
}

function getLoginItemOptions(openAtLogin) {
  return {
    ...getLoginItemQueryOptions(),
    openAtLogin,
    openAsHidden: true,
  };
}

function setAutoStart(enable) {
  // Portable builds can otherwise register Electron's temp unpacked exe.
  app.setLoginItemSettings({ openAtLogin: false });
  app.setLoginItemSettings(getLoginItemOptions(Boolean(enable)));
}

function repairAutoStartPath() {
  const current = app.getLoginItemSettings();
  const desired = app.getLoginItemSettings(getLoginItemQueryOptions());
  if (!current.openAtLogin && !desired.openAtLogin) return;
  setAutoStart(true);
  console.log(`🔧 已校正开机自启路径: ${getLoginItemPath()}`);
}

function shouldStartHidden() {
  return process.argv.includes('--hidden') || app.commandLine.hasSwitch('hidden');
}

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

  ensureHooks();

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
  // 同文件夹单实例守卫：拒绝在已有实例的文件夹里二次启动
  const lock = acquireInstanceLock();
  if (!lock.ok) {
    dialog.showErrorBox(
      'cc-wechat 已在此文件夹运行',
      `检测到同一文件夹内已有 cc-wechat 实例在运行（PID ${lock.pid}）。\n\n` +
      `同一文件夹的多个实例会共用并互相覆盖配置（config.json / 通知目录），因此已阻止本次启动。\n\n` +
      `如需多开，请把本程序复制到另一个文件夹后再启动。`
    );
    app.isQuiting = true;
    app.quit();
    return;
  }

  await createWindow();
  createTray(); 
  if (!shouldStartHidden()) {
    mainWindow.show(); // 开发阶段默认显示
  }
  
  // 拦截 console.log 到前端
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    if (mainWindow) mainWindow.webContents.send('log', args.join(' '));
  }

  startWeChatService();
  repairAutoStartPath();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  releaseInstanceLock();
});

// IPC 通信：前端触发特定操作
ipcMain.handle('app:close', () => mainWindow.hide());
ipcMain.handle('app:quit', () => app.quit());

// 配置管理相关的 IPC
ipcMain.handle('config:get', () => {
  return getConfig();
});

ipcMain.handle('config:save', (event, newConfig) => {
  const normDir = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const oldDirs = (getConfig().claudeDirs || []).slice();
  saveConfig(newConfig);
  const newDirs = getConfig().claudeDirs || [];

  // 卸载从列表中被移除的目录里的（本实例）hook
  const newSet = new Set(newDirs.map(normDir));
  const removed = oldDirs.filter(d => !newSet.has(normDir(d)));
  for (const dir of removed) {
    try {
      uninstallHook(dir);
    } catch (e) {
      console.error(`卸载 hook 失败 (${dir}):`, e.message);
    }
  }

  // 按新的 claudeDirs 重新注入 hook，使目录改动当场生效；
  // 冲突目录会在此处被跳过并把告警打到面板日志，无需重启。
  try {
    ensureHooks();
  } catch (e) {
    console.error('保存后注入 hook 失败:', e.message);
  }
});

ipcMain.handle('config:getAutoStart', () => {
  return app.getLoginItemSettings(getLoginItemQueryOptions()).openAtLogin;
});

ipcMain.handle('config:setAutoStart', (event, enable) => {
  setAutoStart(enable);
});

ipcMain.handle('config:clearToken', () => {
  saveConfig({ wechat: { botToken: '', baseUrl: '', getUpdatesBuf: '', syncBuf: '', ownerUserId: '', lastContextToken: '' } });
  app.relaunch();
  app.quit();
});
