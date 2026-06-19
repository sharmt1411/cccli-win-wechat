// setup.js — 安装向导：扫描 Claude 目录、注入 hook、iLink 扫码登录
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { load as loadConfig, save as saveConfig } from './config.js';
import { WeChatBot } from './wechat.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const HOOK_SCRIPT = resolve(__dirname, '..', 'scripts', 'hook-notify.ps1');

export async function runSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log('\n🔧 cc-wechat 安装向导\n');

  const cfg = loadConfig();

  // ── 1. 扫描 Claude 目录 ──
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [];
  try {
    for (const name of readdirSync(home)) {
      // 匹配 .claude 和 .claude-xxx（排除 .claude.bak 等带第二个点的）
      if (/^\.claude(-[^.]+)?$/.test(name)) {
        const full = join(home, name);
        if (existsSync(join(full, 'settings.json'))) {
          candidates.push(full);
        }
      }
    }
  } catch {}

  if (!candidates.length) {
    console.log('❌ 未找到 Claude Code 配置目录');
    rl.close();
    return false;
  }

  console.log('发现以下 Claude 配置目录：');
  candidates.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));

  const selected = await ask(`\n选择要管理的目录（序号，逗号分隔，回车全选）: `);
  let dirs;
  if (!selected.trim()) {
    dirs = [...candidates];
  } else {
    const indices = selected.split(',').map(s => parseInt(s.trim()) - 1);
    dirs = indices.filter(i => i >= 0 && i < candidates.length).map(i => candidates[i]);
  }

  if (!dirs.length) {
    console.log('❌ 未选择任何目录');
    rl.close();
    return false;
  }

  cfg.claudeDirs = dirs.map(d => d.replace(/\\/g, '/'));

  const awayMode = await ask('\n是否仅在锁屏/息屏时推送和桥接？(y/N): ');
  cfg.lockScreenMode = {
    ...(cfg.lockScreenMode || {}),
    enabled: /^(?:y(?:es)?|是|开启|启用)$/i.test(awayMode.trim()),
  };

  // ── 2. 注入 Hook ──
  console.log('\n📌 注入 Hook...');
  for (const dir of dirs) {
    injectHook(dir);
  }

  // ── 3. 微信扫码登录 ──
  console.log('\n📱 微信登录：');
  saveConfig();

  const bot = new WeChatBot();
  bot.on('qrcode', async (qr) => {
    const qrt = await import('qrcode-terminal');
    const qrUrl = qr.url || qr.qrcode_url || qr.qrcode_img_url;
    if (qrUrl) {
      qrt.default.generate(qrUrl, { small: true });
    } else if (qr.qrcode_img_content) {
      console.log('请用微信扫描以下二维码（base64 图片，保存后扫码）：');
      console.log(qr.qrcode_img_content.substring(0, 200) + '...');
    } else {
      console.log('二维码数据：', JSON.stringify(qr, null, 2));
    }
    console.log('\n等待微信扫码...');
  });
  
  bot.on('login', () => {
    console.log('✅ 登录成功');
  });

  await bot.login();

  saveConfig();
  console.log('\n✅ 安装完成！运行 npm start 启动服务。\n');
  rl.close();
  return true;
}

/** 向目标 Claude 目录的 settings.json 注入 hook */
export function injectHook(claudeDir) {
  const cfg = loadConfig();
  const settingsPath = join(claudeDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {}

  if (!settings.hooks) settings.hooks = {};

  const claudeDirNorm = claudeDir.replace(/\\/g, '/');

  const baseDir = (process.versions && process.versions.electron) ? (process.env.PORTABLE_EXECUTABLE_DIR || process.cwd()) : process.cwd();
  const absNotifyDir = resolve(baseDir, cfg.notifyDir).replace(/\\/g, '/');

  // ── 冲突检测：此目录是否已被「另一个 cc-wechat 实例」接管 ──
  // 判据：settings 里已存在 cc-wechat hook，但其 NotifyDir 与本实例不同。
  // 此时不再直接覆盖（会导致两个实例互相抢夺通知），而是告警并跳过，保留对方的 hook。
  const foreignNotifyDir = detectForeignHook(settings, absNotifyDir);
  if (foreignNotifyDir) {
    console.log(`  ⚠️ 跳过注入：${claudeDir} 已被另一个 cc-wechat 实例接管 (NotifyDir=${foreignNotifyDir})`);
    console.log(`     如需本实例接管该目录，请先在原实例中移除它，或手动清理其 settings.json 内的 cc-wechat hook 后重试。`);
    return { skipped: true, reason: 'foreign-instance', foreignNotifyDir };
  }

  // Extract hook script to physical disk because PowerShell cannot read inside app.asar
  const hooksDir = join(claudeDir, 'hooks');
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }
  const destScriptPath = join(hooksDir, 'cc-wechat-notify.ps1').replace(/\\/g, '/');
  const scriptContent = readFileSync(HOOK_SCRIPT, 'utf-8');
  writeFileSync(destScriptPath, scriptContent, 'utf-8');

  const hookCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('${destScriptPath}',[Text.Encoding]::UTF8))) -ClaudeDir '${claudeDirNorm}' -NotifyDir '${absNotifyDir}'"`;

  const hookEntry = {
    type: 'command',
    command: hookCommand,
    timeout: 10,
  };

  let modified = false;

  for (const event of ['Stop', 'Notification']) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    let list = settings.hooks[event];

    const newList = list.filter(item => {
      const isOldHook = JSON.stringify(item).includes('hook-notify.ps1') || JSON.stringify(item).includes('cc-wechat-notify.ps1');
      return !isOldHook;
    });

    newList.push({ hooks: [hookEntry] });

    if (JSON.stringify(list) !== JSON.stringify(newList)) {
      settings.hooks[event] = newList;
      modified = true;
      console.log(`  ✅ ${event} hook 已更新 → ${claudeDir}`);
    } else {
      console.log(`  ⏭️  ${event} hook 无需更新 → ${claudeDir}`);
    }
  }

  if (modified) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }
  return { skipped: false, modified };
}

/** 从 hook command 中解析出 -NotifyDir 参数值（单引号内） */
function extractNotifyDir(command) {
  const m = /-NotifyDir\s+'([^']*)'/.exec(String(command || ''));
  return m ? m[1] : '';
}

/** 路径归一化用于比较：统一正斜杠、去尾斜杠、Windows 下大小写不敏感 */
function normalizeDirForCompare(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 检测 settings 中是否存在指向「其他 NotifyDir」的 cc-wechat hook（即另一个实例注入的）。
 * 命中则返回该外部 NotifyDir（用于告警），否则返回 null。
 * 解析不出 NotifyDir 的旧 hook 视为本实例可升级对象，不算外部实例。
 */
function detectForeignHook(settings, ownNotifyDir) {
  const own = normalizeDirForCompare(ownNotifyDir);
  const events = settings?.hooks || {};
  for (const event of Object.keys(events)) {
    for (const group of (events[event] || [])) {
      for (const h of (group?.hooks || [])) {
        const cmd = String(h?.command || '');
        if (!cmd.includes('cc-wechat-notify.ps1') && !cmd.includes('hook-notify.ps1')) continue;
        const nd = extractNotifyDir(cmd);
        if (nd && normalizeDirForCompare(nd) !== own) return nd;
      }
    }
  }
  return null;
}

/** 计算本实例的 NotifyDir 绝对路径（与 injectHook 内的算法保持一致） */
function ownNotifyDir() {
  const cfg = loadConfig();
  const baseDir = (process.versions && process.versions.electron) ? (process.env.PORTABLE_EXECUTABLE_DIR || process.cwd()) : process.cwd();
  return resolve(baseDir, cfg.notifyDir).replace(/\\/g, '/');
}

/** 该 hook 是否属于本实例的 cc-wechat hook（NotifyDir 匹配，或旧 hook 解析不出 NotifyDir 时视为本实例） */
function isOwnCcHook(h, ownDir) {
  const cmd = String(h?.command || '');
  if (!cmd.includes('cc-wechat-notify.ps1') && !cmd.includes('hook-notify.ps1')) return false;
  const nd = extractNotifyDir(cmd);
  return !nd || normalizeDirForCompare(nd) === normalizeDirForCompare(ownDir);
}

/** 是否仍存在任意 cc-wechat hook（含外部实例），用于决定是否删除共享脚本副本 */
function hasAnyCcHook(settings) {
  const events = settings?.hooks || {};
  for (const event of Object.keys(events)) {
    for (const group of (events[event] || [])) {
      for (const h of (group?.hooks || [])) {
        const cmd = String(h?.command || '');
        if (cmd.includes('cc-wechat-notify.ps1') || cmd.includes('hook-notify.ps1')) return true;
      }
    }
  }
  return false;
}

/**
 * 从目标目录卸载「本实例」的 cc-wechat hook（NotifyDir 匹配的才删，保留外部实例的）。
 * 当目标目录已无任何 cc-wechat hook 残留时，一并删除共享的脚本副本。
 */
export function uninstallHook(claudeDir) {
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { removed: false };
  }
  if (!settings.hooks) return { removed: false };

  const ownDir = ownNotifyDir();
  let modified = false;

  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const newList = [];
    for (const group of list) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      const kept = hooks.filter(h => !isOwnCcHook(h, ownDir));
      if (kept.length === hooks.length) {
        newList.push(group);               // 未变
      } else if (kept.length > 0) {
        newList.push({ ...group, hooks: kept }); // 组内保留了别的 hook
        modified = true;
      } else {
        modified = true;                   // 整组只剩本实例 hook，丢弃空组
      }
    }
    if (newList.length !== list.length || modified) settings.hooks[event] = newList;
  }

  if (modified) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    console.log(`  🧹 已卸载 hook → ${claudeDir}`);
  }

  // 仅当没有任何 cc-wechat hook（含外部实例）再引用脚本副本时才删除，避免破坏外部实例
  if (!hasAnyCcHook(settings)) {
    try {
      const destScriptPath = join(claudeDir, 'hooks', 'cc-wechat-notify.ps1');
      if (existsSync(destScriptPath)) unlinkSync(destScriptPath);
    } catch { /* ignore */ }
  }

  return { removed: modified };
}

export function ensureHooks() {
  const cfg = loadConfig();
  if (!cfg.claudeDirs) return;
  for (const dir of cfg.claudeDirs) {
    try {
      injectHook(dir);
    } catch(e) {
      console.error(`自动更新 hook 失败 (${dir}):`, e.message);
    }
  }
}
