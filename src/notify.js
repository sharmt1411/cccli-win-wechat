// notify.js — 监听 hook 通知文件 → 推送微信
import { watch, readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get as getConfig } from './config.js';
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
    this.dir = getConfig().notifyDir;
    this._watcher = null;
    this._processing = new Set();
  }

  start() {
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
      if (isGenericWaitingNotification(data, interaction)) {
        console.log(`🔇 通用等待通知已忽略: ${data.event} [${data.project}]`);
        return;
      }

      // 格式化并推送微信。Bridge 可以选择暂缓推送，例如新 tab 正在启动时。
      const text = this._format(data, interaction);
      const routed = await this.onNotify?.(data, text);
      if (routed !== false) {
        await this.wechat.push(typeof routed === 'string' ? routed : text);
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

  _format(d, normalizedInteraction = null) {
    const isNotif = d.event === 'Notification';
    const interaction = normalizedInteraction || normalizeInteraction(d);
    const lines = [];

    if (isNotif) {
      lines.push('🔔 Claude 需要处理');
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
        lines.push(truncateText(cleanReply, 600));
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
    lines.push(formatOptionLine(option, interaction.selectionMode));
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

function isGenericWaitingNotification(data, interaction) {
  if (data.event !== 'Notification' || interaction) return false;
  return isGenericWaitingAction(data.action || data.message || data.prompt);
}

function shouldShowAction(action) {
  const text = normalizeForCompare(action);
  if (!text) return false;
  if (text === 'done' || text === 'needconfirm') return false;
  if (isGenericWaitingAction(action)) return false;
  return true;
}

function isGenericWaitingAction(value) {
  const text = normalizeForCompare(value);
  return text === 'claudeiswaitingforyourinput'
    || text === 'waitingforyourinput'
    || text === '等待输入'
    || text === '正在等待输入';
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

function formatOptionLine(option, selectionMode) {
  const label = shortenOptionLabel(option.label);
  if (selectionMode !== 'multi' || option.checkbox === false) return `[${option.number}] ${label}`;
  const mark = option.checked ? '[x]' : '[ ]';
  const cursor = option.cursor ? '> ' : '';
  return `${cursor}[${option.number}] ${mark} ${label}`;
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
