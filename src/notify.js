// notify.js — 监听 hook 通知文件 → 推送微信
import { watch, readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get as getConfig } from './config.js';
import { normalizeInteraction, sanitizeScreenText, truncateText } from './interaction.js';
import { readScreen } from './terminal.js';

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
      await this._enrichScreen(data);

      // 格式化并推送微信。Bridge 可以选择暂缓推送，例如新 tab 正在启动时。
      const text = this._format(data);
      const routed = this.onNotify?.(data, text);
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

  _format(d) {
    const isNotif = d.event === 'Notification';
    const interaction = normalizeInteraction(d);
    const lines = [];

    if (isNotif) {
      lines.push(`🔔 [${d.project || '未知项目'}] 需要你的操作`);
      if (!interaction && d.action) lines.push(`❓ ${d.action}`);
    } else {
      lines.push(`✅ [${d.project || '未知项目'}] 执行完毕`);
    }

    if (d.title) lines.push(`📋 ${d.title}`);
    if (d.prompt) lines.push(`💬 提示: ${d.prompt}`);

    if (d.lastReply) {
      const cleanReply = stripLegacyInteraction(d.lastReply);
      if (cleanReply) lines.push(`📄 Claude: ${truncateText(cleanReply, 600)}`);
    }

    if (interaction) {
      lines.push('');
      lines.push(...formatInteraction(interaction));
    }

    const shouldShowScreen = d.screenText
      && (!interaction || (interaction.type === 'tool_permission' && interaction.promptStyle === 'unknown'));
    if (shouldShowScreen) {
      lines.push(`\n📺 当前终端界面：\n${sanitizeScreenText(d.screenText, { maxLen: 900 })}`);
    }

    if (d.source || d.claudeDir) {
      const src = d.source || d.claudeDir?.split(/[/\\]/).pop() || '';
      if (src && src !== '.claude') lines.push(`📁 来源: ${src}`);
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

    if (interaction.header) lines.push(`分类：${interaction.header}`);
    if (interaction.question) lines.push(`问题：${interaction.question}`);

    const options = interaction.options.length ? interaction.options : interaction.screenOptions;
    if (options.length) {
      lines.push('可选回复：');
      for (const option of options) {
        lines.push(formatOptionLine(option, interaction.selectionMode));
        if (option.description) lines.push(`   ${option.description}`);
      }
      if (interaction.selectionMode === 'multi') {
        lines.push('复选：回复 [1 3] 可批量勾选。');
        lines.push('勾选后按界面需要发送 /enter，或用 /right /enter 切到 Submit 提交。');
        lines.push('也可以用 /pick 1 3 或方向键命令手动操作。');
      } else {
        lines.push(interaction.options.length
          ? '回复 [1] 即可选择，也可以直接回复自定义文本。'
          : '回复 [1] 即可选择。也可以用 /up、/down、/enter 操作菜单。');
      }
    } else {
      lines.push('直接回复文本即可回答。');
    }

    return lines;
  }

  const lines = ['🛡️ 工具授权'];
  const tool = formatToolLabel(interaction);
  if (tool) lines.push(`工具：${tool}`);

  const options = interaction.promptStyle === 'numbered'
    ? interaction.screenOptions
    : [
        { number: '1', label: 'Yes' },
        { number: '2', label: 'Yes, allow during this session/project' },
        { number: '3', label: 'No' },
      ];

  lines.push('回复数字选择：');
  for (const option of options) {
    lines.push(formatOptionLine(option, interaction.selectionMode));
    if (option.description) lines.push(`   ${option.description}`);
  }

  if (interaction.promptStyle === 'numbered') {
    lines.push('可直接回复数字。兼容 y/yes 选择 Yes，n/no 选择 No。');
    lines.push('也可以继续使用 /up、/down、/enter 操作终端菜单。');
  } else {
    lines.push('未读到完整菜单时按 Claude 常见 3 项审批展示；n/no 会按 3. No 处理。');
    lines.push('需要切换权限模式可发 /perm，或用 /screen 查看当前菜单。');
  }

  return lines;
}

function formatQuestionGroups(interaction) {
  const lines = ['一次选择多个分类：'];
  interaction.questions.forEach((question, index) => {
    const mode = question.multiSelect ? 'multi' : 'single';
    const title = question.header || `问题 ${index + 1}`;
    lines.push('');
    lines.push(`[${index + 1}] ${title}${question.multiSelect ? '（可多选）' : '（单选）'}`);
    if (question.question) lines.push(question.question);
    for (const option of question.options || []) {
      lines.push(formatOptionLine(option, mode));
      if (option.description) lines.push(`   ${option.description}`);
    }
  });
  lines.push('');
  lines.push('回复格式：每个分类用一组 []，例如 [1 3][1][2]。单分类也用 [1] 或 [1 3]。');
  lines.push('发送后会依次选择各分类并切到 Submit 提交。');
  return lines;
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
  if (selectionMode !== 'multi' || option.checkbox === false) return `${option.number}. ${option.label}`;
  const mark = option.checked ? '[x]' : '[ ]';
  const cursor = option.cursor ? '>' : ' ';
  return `${cursor} ${mark} ${option.number}. ${option.label}`;
}
