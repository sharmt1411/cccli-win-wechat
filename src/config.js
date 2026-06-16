// config.js — 配置管理
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

const DEFAULTS = {
  claudeDirs: [],
  notifyDir: join(process.env.TEMP || '', 'cc-wechat-notify'),
  wechat: {
    botToken: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    getUpdatesBuf: '',
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
    _config.wechat = { ...DEFAULTS.wechat, ...(_config.wechat || {}) };
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
