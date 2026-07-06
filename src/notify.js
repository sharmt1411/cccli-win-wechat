// notify.js — 监听 hook 通知文件 → 推送微信
import { watch, readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { get as getConfig, resolveInboundDir } from './config.js';
import { normalizeInteraction, sanitizeScreenText, truncateText } from './interaction.js';
import { readScreen } from './terminal.js';
import { formatPresenceState, shouldOperateByPresence } from './presence.js';
import { isCliSession } from './session.js';

export class NotifyWatcher {
  /**
   * @param {import('./wechat.js').WeChatBot} wechat
   * @param {function(object):void} onNotify — 通知回调（用于更新 bridge 的 lastNotifiedPid）
   */
  constructor(wechat, onNotify) {
    this.wechat = wechat;
    this.onNotify = onNotify;
    const baseDir = (process.versions && process.versions.electron) ? (process.env.PORTABLE_EXECUTABLE_DIR || process.cwd()) : process.cwd();
    this.dir = resolve(baseDir, getConfig().notifyDir);
    this._watcher = null;
    this._processing = new Set();
  }

  start() {
    if (this._watcher) return; // 已在监听，避免重复 watch 泄漏句柄

    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    // 先处理遗留文件
    this._scanDir();

    // 监听新文件
    this._watcher = watch(this.dir, (eventType, filename) => {
      if (filename?.endsWith('.json')) {
        // 延迟一点确保文件写入完成
        setTimeout(() => this._processFile(join(this.dir, filename)), 200);
      }
    });

    console.log('👀 通知监听已启动:', this.dir);
  }

  stop() {
    this._watcher?.close();
    this._watcher = null;
  }

  _scanDir() {
    try {
      const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        this._processFile(join(this.dir, f));
      }
    } catch { /* 目录可能不存在 */ }
  }

  async _processFile(filePath) {
    if (this._processing.has(filePath)) return;
    this._processing.add(filePath);

    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      data.prompt = stripCcWechatContext(data.prompt);
      data.lastReply = stripCcWechatContext(data.lastReply);
      if (data.entrypoint && !isCliSession(data)) {
        console.log(`🚫 非 CLI 会话通知已忽略: ${data.event} [${data.project}] entrypoint=${data.entrypoint}`);
        return;
      }

      const gate = await shouldOperateByPresence();
      if (!gate.allowed) {
        console.log(`🔕 当前未锁屏/息屏，通知未推送: ${data.event} [${data.project}] state=${formatPresenceState(gate.state)}`);
        return;
      }

      await this._enrichScreen(data);
      const interaction = normalizeInteraction(data);
      if (isGenericWaitingNotification(data)) {
        console.log(`🔇 通用等待通知已忽略: ${data.event} [${data.project}]`);
        return;
      }

      const sendRequests = collectSendRequests(data);
      if (sendRequests.length) {
        data.lastReply = stripSendDirectives(data.lastReply);
      }

      // 格式化并推送微信。Bridge 可以选择暂缓推送，例如新 tab 正在启动时。
      const text = this._format(data, interaction);
      const routed = await this.onNotify?.(data, text);
      if (routed !== false) {
        await this.wechat.push(typeof routed === 'string' ? routed : text);
        if (sendRequests.length) {
          await this._sendRequestedFiles(data, sendRequests);
        }
      }

      console.log(`${routed === false ? '⏸️ 通知已暂缓' : '📤 通知已推送'}: ${data.event} [${data.project}]`);
    } catch (e) {
      console.error('处理通知文件出错:', e.message);
    } finally {
      // 无论成功与否都删除文件
      try { unlinkSync(filePath); } catch {}
      this._processing.delete(filePath);
    }
  }

  async _enrichScreen(data) {
    if (data.event !== 'Notification' || !data.pid) return;

    const interaction = normalizeInteraction(data);
    if (interaction?.type !== 'tool_permission' || interaction.promptStyle === 'numbered') return;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 250));
      try {
        const screen = await readScreen(data.pid);
        const refreshed = normalizeInteraction({ ...data, screenText: screen });
        if (refreshed?.type === 'tool_permission' && refreshed.promptStyle === 'numbered') {
          data.screenText = screen;
          return;
        }
      } catch {
        return;
      }
    }
  }

  async _sendRequestedFiles(data, requests) {
    if (!isSendFileCapabilityEnabled()) {
      await this.wechat.push('⚠️ Claude 请求发送文件，但“注入发送文件能力”未开启，已忽略。');
      return;
    }

    const results = [];
    for (const request of requests) {
      try {
        const file = validateSendFileRequest(data, request);
        await this.wechat.pushFile(file.path, { caption: file.caption });
        results.push(`✅ 已发送文件: ${file.name}`);
      } catch (e) {
        results.push(`❌ 文件发送失败: ${e.message}`);
      }
    }

    if (results.length) {
      await this.wechat.push(results.join('\n'));
    }
  }

  _format(d, normalizedInteraction = null) {
    const isNotif = d.event === 'Notification';
    const isFailure = d.event === 'StopFailure';
    const interaction = normalizedInteraction || normalizeInteraction(d);
    const lines = [];

    if (isNotif) {
      lines.push('🔔 Claude 需要处理');
    } else if (isFailure) {
      lines.push('❌ Claude 执行失败或超时');
    } else {
      lines.push('✅ Claude 执行完成');
    }

    lines.push(...formatSessionMeta(d));

    if (!interaction && shouldShowAction(d.action)) lines.push(`类型: ${d.action}`);
    if (d.title) lines.push(`标题: ${d.title}`);
    if (shouldShowPrompt(d.prompt, interaction)) lines.push(`提示: ${d.prompt}`);

    if (d.lastReply) {
      const cleanReply = stripLegacyInteraction(d.lastReply);
      if (cleanReply) {
        lines.push('');
        lines.push('Claude 最近回复:');
        // Stop（执行完成）的最终回复完整发送，由 wechat.send 的 splitText 自动分条；
        // 仅 Notification 场景做 600 字截断（界面信息为主）。
        lines.push(isNotif ? truncateText(cleanReply, 600) : cleanReply);
      }
    }

    if (interaction) {
      lines.push('');
      lines.push(...formatInteraction(interaction));
    }

    const shouldShowScreen = d.screenText
      && (!interaction || (interaction.type === 'tool_permission' && interaction.promptStyle === 'unknown'));
    if (shouldShowScreen) {
      lines.push('');
      lines.push('📺 当前终端界面');
      lines.push(sanitizeScreenText(d.screenText, { maxLen: 900 }));
    }

    return lines.join('\n');
  }
}

const MAX_SEND_FILE_BYTES = 20 * 1024 * 1024;
const SEND_FILES_KEY = 'send-cc-wechat-files';
const SEND_BLOCK_PATTERN = /```cc-wechat-send\s*([\s\S]*?)\s*```/gi;
const JSON_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
const CC_WECHAT_CONTEXT_PATTERN = /\s*<cc-wechat-context\b[^>]*>[\s\S]*?<\/cc-wechat-context>\s*/gi;

function collectSendRequests(data = {}) {
  if (data.event === 'Notification') return [];

  const blocks = [];
  const directives = Array.isArray(data.sendDirectives)
    ? data.sendDirectives
    : (data.sendDirectives ? [data.sendDirectives] : []);

  for (const directive of directives) {
    if (directive) blocks.push({ body: String(directive).trim(), strict: true });
  }

  const lastReply = stripCcWechatContext(data.lastReply || '');

  if (!blocks.length) {
    SEND_BLOCK_PATTERN.lastIndex = 0;
    for (const match of lastReply.matchAll(SEND_BLOCK_PATTERN)) {
      if (match[1]) blocks.push({ body: match[1].trim(), strict: true });
    }
  }

  if (!blocks.length) {
    JSON_BLOCK_PATTERN.lastIndex = 0;
    for (const match of lastReply.matchAll(JSON_BLOCK_PATTERN)) {
      if (match[1]) blocks.push({ body: match[1].trim(), strict: false });
    }
  }

  if (!blocks.length) {
    const rawJson = extractWholeJsonDirective(lastReply);
    if (rawJson) {
      blocks.push({ body: rawJson, strict: false });
    }
  }

  const requests = [];
  for (const block of blocks) {
    try {
      const value = JSON.parse(block.body);
      if (!looksLikeSendDirective(value, { allowLegacy: block.strict })) continue;
      requests.push(...normalizeSendDirective(value, { allowLegacy: block.strict }));
    } catch (e) {
      if (block.strict) {
      requests.push({ error: `cc-wechat-send JSON 解析失败: ${e.message}` });
      }
    }
  }
  return requests;
}

function normalizeSendDirective(value, { allowLegacy = true } = {}) {
  const root = Array.isArray(value) ? { [SEND_FILES_KEY]: value } : value;
  if (!root || typeof root !== 'object') {
    return [{ error: 'cc-wechat-send 内容必须是 JSON 对象' }];
  }

  const files = Array.isArray(root[SEND_FILES_KEY])
    ? root[SEND_FILES_KEY]
    : (allowLegacy && Array.isArray(root.files)
        ? root.files
        : (allowLegacy && root.path ? [root] : []));
  if (!files.length) return [{ error: 'cc-wechat-send 缺少 files 数组' }];

  return files.map(item => {
    if (typeof item === 'string') return { path: item, caption: '' };
    if (!item || typeof item !== 'object') return { error: 'files 项必须是字符串或对象' };
    return {
      path: String(item.path || '').trim(),
      caption: String(item.caption || '').trim(),
    };
  });
}

function stripSendDirectives(text = '') {
  let output = stripCcWechatContext(text);
  SEND_BLOCK_PATTERN.lastIndex = 0;
  output = output.replace(SEND_BLOCK_PATTERN, '').trim();
  JSON_BLOCK_PATTERN.lastIndex = 0;
  output = output.replace(JSON_BLOCK_PATTERN, (full, body) => {
    try {
      return looksLikeSendDirective(JSON.parse(body)) ? '' : full;
    } catch {
      return full;
    }
  }).trim();

  const rawJson = extractWholeJsonDirective(output);
  if (rawJson) {
    try {
      if (looksLikeSendDirective(JSON.parse(rawJson))) return '';
    } catch {}
  }

  return output.trim();
}

function stripCcWechatContext(text = '') {
  CC_WECHAT_CONTEXT_PATTERN.lastIndex = 0;
  return String(text || '').replace(CC_WECHAT_CONTEXT_PATTERN, '').trim();
}

function extractWholeJsonDirective(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return '';
  return trimmed;
}

function looksLikeSendDirective(value, { allowLegacy = true } = {}) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value[SEND_FILES_KEY])) return true;
  if (!allowLegacy) return false;
  if (Array.isArray(value)) {
    return value.some(item => typeof item === 'string' || Boolean(item?.path));
  }
  return Array.isArray(value.files) || typeof value.path === 'string';
}

function validateSendFileRequest(data, request) {
  if (request.error) throw new Error(request.error);
  if (!request.path) throw new Error('缺少文件路径');

  const baseDir = data.cwd || process.cwd();
  const baseReal = realpathSync(baseDir);
  const candidate = isAbsolute(request.path)
    ? request.path
    : resolve(baseReal, request.path);
  const fileReal = realpathSync(candidate);

  let inboundReal = null;
  try {
    const dir = realpathSync(resolveInboundDir(getConfig().wechat?.inboundDir));
    // 安全：拒绝 inboundDir 配置过宽（解析到卷/文件系统根，如 "/" 或 "C:\"）。
    // 根目录会让放行范围失控，此时不启用 inbound 放行（仅允许会话目录）。
    if (parse(dir).root !== dir) inboundReal = dir;
  } catch {}

  const isInsideSession = isInsidePath(baseReal, fileReal);
  const isInsideInbound = inboundReal && isInsidePath(inboundReal, fileReal);

  if (!isInsideSession && !isInsideInbound) {
    throw new Error(`安全限制：请求发送的文件 (${request.path}) 既不在当前 Claude 工作区内，也不在微信接收文件目录内。`);
  }

  if (isBlockedSensitivePath(baseReal, fileReal)) {
    throw new Error(`安全策略阻止发送: ${request.path}`);
  }

  const stat = statSync(fileReal);
  if (!stat.isFile()) throw new Error(`不是文件: ${request.path}`);
  if (stat.size <= 0) throw new Error(`文件为空: ${request.path}`);
  if (stat.size > MAX_SEND_FILE_BYTES) {
    throw new Error(`文件过大: ${basename(fileReal)} (${formatBytes(stat.size)} > ${formatBytes(MAX_SEND_FILE_BYTES)})`);
  }

  return {
    path: fileReal,
    name: basename(fileReal),
    caption: request.caption.slice(0, 300),
  };
}

function isSendFileCapabilityEnabled() {
  const cfg = getConfig().capabilityInjection;
  return Boolean(cfg?.enabled !== false && cfg?.capabilities?.sendFile);
}

function isInsidePath(base, target) {
  const rel = relative(base, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function isBlockedSensitivePath(base, target) {
  const segments = relative(base, target).split(/[\\/]+/).map(s => s.toLowerCase());
  if (segments.some(s => ['.git', '.ssh', '.claude', '.codex'].includes(s))) return true;

  const name = basename(target).toLowerCase();
  return name === 'config.json'
    || name === '.env'
    || name.startsWith('.env.')
    || name === 'id_rsa'
    || name === 'id_ed25519'
    || /\.(pem|key|p12|pfx|kdbx)$/i.test(name);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatInteraction(interaction) {
  if (interaction.type === 'ask_user_question') {
    const lines = ['🙋 需要回答'];
    if (interaction.questions?.length > 1) {
      lines.push(...formatQuestionGroups(interaction));
      return lines;
    }

    if (interaction.header) lines.push(`分类: ${interaction.header}`);
    if (interaction.question) lines.push(`问题: ${interaction.question}`);

    const options = interaction.options.length ? interaction.options : interaction.screenOptions;
    if (options.length) {
      lines.push('');
      lines.push('可选回复:');
      for (const option of options) {
        lines.push(formatOptionLine(option, interaction.selectionMode));
        if (option.description) lines.push(`说明: ${option.description}`);
      }
      if (interaction.selectionMode === 'multi') {
        lines.push('');
        lines.push('回复格式: [1 3]');
        lines.push('说明: 可批量勾选。');
        lines.push('提交: /enter');
        lines.push('或 /right 后 /enter。');
        lines.push('手动: /pick 1 3');
        lines.push('也可用 /up /down /space。');
      } else {
        lines.push('');
        lines.push(interaction.options.length
          ? '回复格式: [1]\n也可直接回复文本。'
          : '回复格式: [1]\n也可用 /up /down /enter。');
      }
    } else {
      lines.push('');
      lines.push('回复方式: 直接回复文本即可回答。');
    }

    return lines;
  }

  const lines = ['🛡️ 需要工具授权'];
  const tool = formatToolLabel(interaction);
  if (tool) lines.push(`工具: ${tool}`);

  const options = interaction.promptStyle === 'numbered'
    ? interaction.screenOptions
    : [
        { number: '1', label: 'Yes / 允许' },
        { number: '2', label: 'Yes / 本会话允许' },
        { number: '3', label: 'No / 拒绝' },
      ];

  lines.push('');
  lines.push('回复数字选择:');
  for (const option of options) {
    lines.push(formatOptionLine(option, interaction.selectionMode, { bracketNumber: false }));
    if (option.description) lines.push(`说明: ${option.description}`);
  }

  lines.push('');
  if (interaction.promptStyle === 'numbered') {
    lines.push('快捷: 直接回复数字。');
    lines.push('y/yes 表示 Yes。');
    lines.push('n/no 表示 No。');
    lines.push('手动: /up /down /enter。');
  } else {
    lines.push('说明: 未读到完整菜单。');
    lines.push('按常见 3 项审批展示。');
    lines.push('n/no 会选择 No。');
    lines.push('/screen 查看终端菜单。');
    lines.push('/perm 切换权限模式。');
  }

  return lines;
}

function formatQuestionGroups(interaction) {
  const lines = ['', '一次选择多个分类:'];
  interaction.questions.forEach((question, index) => {
    const mode = question.multiSelect ? 'multi' : 'single';
    const title = question.header || `问题 ${index + 1}`;
    lines.push('');
    lines.push(`[${index + 1}] ${title}${question.multiSelect ? '（可多选）' : '（单选）'}`);
    if (question.question) lines.push(question.question);
    for (const option of question.options || []) {
      lines.push(formatOptionLine(option, mode));
      if (option.description) lines.push(`说明: ${option.description}`);
    }
  });
  lines.push('');
  lines.push('回复格式: 每类一组 []。');
  lines.push('例如: [1 3][1][2]');
  lines.push('单分类也用 [1] 或 [1 3]。');
  lines.push('发送后会切到 Submit 提交。');
  return lines;
}

function formatSessionMeta(d) {
  const lines = [];
  lines.push(`会话: ${d.project || '未知项目'}`);
  if (d.cwd) lines.push(`目录: ${d.cwd}`);
  if (d.pid) lines.push(`PID: ${d.pid}`);
  const src = d.source || d.claudeDir?.split(/[/\\]/).pop() || '';
  if (src && src !== '.claude') lines.push(`来源: ${src}`);
  return lines;
}

function isGenericWaitingNotification(data) {
  if (data.event !== 'Notification') return false;
  if (!isGenericWaitingAction(data.action || data.message || data.prompt)) return false;
  // “等待输入”是无实质内容的 idle 提示。只有来自 transcript 的可靠交互(data.interaction，
  // 如 AskUserQuestion / 权限请求)才保留通知；屏幕推断的交互(inferScreenInteraction 可能把
  // 终端历史里的数字/Y-N 误判为菜单)不应让它绕过过滤。
  return !data.interaction;
}

function shouldShowAction(action) {
  const text = normalizeForCompare(action);
  if (!text) return false;
  if (text === 'done' || text === 'needconfirm' || text === 'failed') return false;
  if (isGenericWaitingAction(action)) return false;
  return true;
}

function isGenericWaitingAction(value) {
  const text = normalizeForCompare(value);
  if (!text) return false;
  // 用 includes 而非全等：别名替换（如 Claude→cola）或 "Claude Code is waiting…" 等前缀
  // 变体不应导致漏判。归一化后含 "waitingforyourinput" 子串即判为通用等待提示。
  return text.includes('waitingforyourinput')
    || text.includes('等待输入');
}

function shouldShowPrompt(prompt, interaction) {
  const text = normalizeForCompare(prompt);
  if (!text) return false;
  if (!interaction) return true;

  if (interaction.type === 'tool_permission' && /claudeneedsyourpermission|permission|授权/.test(text)) {
    return false;
  }

  const pieces = [];
  if (interaction.question) pieces.push(interaction.question);
  if (interaction.header) pieces.push(interaction.header);
  if (interaction.detail) pieces.push(interaction.detail);
  if (interaction.toolName) pieces.push(interaction.toolName);

  for (const question of interaction.questions || []) {
    pieces.push(question.question, question.header);
    for (const option of question.options || []) {
      pieces.push(option.label, option.description);
    }
  }

  for (const option of [...(interaction.options || []), ...(interaction.screenOptions || [])]) {
    pieces.push(option.label, option.description);
  }

  return !pieces.some(piece => {
    const other = normalizeForCompare(piece);
    return other && (text.includes(other) || other.includes(text));
  });
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、:：；;,.!?()[\]【】"'“”‘’]/g, '');
}

function stripLegacyInteraction(text) {
  return String(text)
    .replace(/\n?❓\s*问题:\s*[\s\S]*$/u, '')
    .replace(/\n?🛡️\s*请求授权工具:\s*[^\n]+/gu, '')
    .trim();
}

function formatToolLabel(interaction) {
  const name = interaction.toolName || '';
  const detail = interaction.detail || '';
  if (!name) return detail;
  if (!detail || detail === name) return name;
  if (detail.startsWith(`${name} `) || detail.startsWith(`${name}(`)) return detail;
  return `${name} ${detail}`;
}

function formatOptionLine(option, selectionMode, { bracketNumber = true } = {}) {
  const label = shortenOptionLabel(option.label);
  const number = bracketNumber ? `[${option.number}]` : `${option.number}.`;
  if (selectionMode !== 'multi' || option.checkbox === false) return `${number} ${label}`;
  const mark = option.checked ? '[x]' : '[ ]';
  const cursor = option.cursor ? '> ' : '';
  return `${cursor}${number} ${mark} ${label}`;
}

function shortenOptionLabel(label) {
  const text = String(label || '').trim();
  const normalized = text.toLowerCase();
  if (normalized === 'yes') return 'Yes / 允许';
  if (normalized === 'no') return 'No / 拒绝';
  if (/^yes,\s*allow all edits during this session/.test(normalized)) return 'Yes / 本会话允许编辑';
  if (/^yes,\s*allow.*session/.test(normalized)) return 'Yes / 本会话允许';
  if (text.length <= 28) return text;
  return `${text.slice(0, 26)}...`;
}
