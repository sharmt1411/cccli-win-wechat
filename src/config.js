// config.js — 配置管理
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import os from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let CONFIG_PATH = join(__dirname, '..', 'config.json');

// 如果是 Electron 打包后的环境
if (process.versions && process.versions.electron) {
  // electron-builder portable 会把用户启动时的所在目录注入到环境变量中
  // 如果没有，则兜底取当前工作目录或者可执行文件所在目录
  CONFIG_PATH = join(process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(), 'config.json');
}

const DEFAULTS = {
  claudeDirs: [],
  botAlias: 'Claude',
  terminalCommand: 'claude',
  notifyDir: './cc-wechat-notify',
  lockScreenMode: {
    enabled: false,
    idleGraceSeconds: 5,
  },
  capabilityInjection: {
    enabled: true,
    mode: 'smart',
    minIntervalMessages: 6,
    minIntervalMinutes: 30,
    capabilities: {
      sendFile: false,
    },
  },
  wechat: {
    botToken: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    inboundDir: './wechat-files',
    fileItemType: 4,
    getUpdatesBuf: '',
    syncBuf: '',
    ownerUserId: '',
    lastContextToken: '',
  },
};

let _config = null;

export function load() {
  if (!existsSync(CONFIG_PATH)) {
    _config = structuredClone(DEFAULTS);
    return _config;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    _config = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    _config = normalizeConfig(_config);
  } catch {
    _config = structuredClone(DEFAULTS);
  }
  return _config;
}

export function get() {
  return _config || load();
}

export function save(partial) {
  if (partial) Object.assign(_config, partial);
  _config = normalizeConfig(_config);
  writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2), 'utf-8');
}

export function saveWechat(partial) {
  Object.assign(_config.wechat, partial);
  save();
}

export function isConfigured() {
  const c = get();
  return c.claudeDirs.length > 0 && !!c.wechat.botToken;
}

// 解析微信接收文件目录（inbound）。保存端与发送校验端共用此唯一定义，避免分歧。
export function resolveInboundDir(dir) {
  const configured = String(dir || './wechat-files').trim() || './wechat-files';
  const baseDir = (process.versions && process.versions.electron) ? (process.env.PORTABLE_EXECUTABLE_DIR || process.cwd()) : process.cwd();
  return resolve(baseDir, configured);
}

function normalizeConfig(config) {
  const normalized = { ...structuredClone(DEFAULTS), ...(config || {}) };
  normalized.wechat = { ...DEFAULTS.wechat, ...(normalized.wechat || {}) };
  if (normalized.wechat.fileItemType === 3) normalized.wechat.fileItemType = DEFAULTS.wechat.fileItemType;
  normalized.lockScreenMode = { ...DEFAULTS.lockScreenMode, ...(normalized.lockScreenMode || {}) };
  normalized.capabilityInjection = {
    ...DEFAULTS.capabilityInjection,
    ...(normalized.capabilityInjection || {}),
    capabilities: {
      ...DEFAULTS.capabilityInjection.capabilities,
      ...(normalized.capabilityInjection?.capabilities || {}),
    },
  };
  return normalized;
}
