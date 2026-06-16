// bridge.js — 命令路由：解析微信命令 → 调度执行
import { SessionManager } from './session.js';
import { injectInput, newTab, togglePermission } from './terminal.js';
import { get as getConfig } from './config.js';

export class Bridge {
  /**
   * @param {import('./wechat.js').WeChatBot} wechat
   */
  constructor(wechat) {
    this.wechat = wechat;
    this.sessions = new SessionManager();
    this.currentTarget = null;      // 当前手动选中的 PID
    this.lastNotifiedPid = null;    // 最近通知到微信的 PID
  }

  /** 由 NotifyWatcher 调用，更新最后通知的会话 */
  onNotify(data) {
    if (data.pid) {
      this.lastNotifiedPid = data.pid;
    }
  }

  /** 处理微信消息 */
  async handleMessage(msg) {
    const text = msg.item_list?.[0]?.text_item?.text?.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      await this._handleCommand(text, msg);
    } else {
      await this._handleReply(text, msg);
    }
  }

  // ── 普通文本 → 注入到目标 CC ──

  async _handleReply(text, msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    try {
      await injectInput(target.pid, text);
      await this.wechat.reply(msg, `⌨️ 已注入 → [${target.project}] (PID:${target.pid})`);
    } catch (e) {
      await this.wechat.reply(msg, `❌ 注入失败: ${e.message}`);
    }
  }

  // ── 命令处理 ──

  async _handleCommand(text, msg) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/ls':
        return this._cmdList(msg);
      case '/to':
        return this._cmdTo(parts[1], msg);
      case '/new':
        return this._cmdNew(parts.slice(1), msg);
      case '/last':
        return this._cmdLast(msg);
      case '/perm':
        return this._cmdPerm(parts[1], msg);
      case '/help':
        return this._cmdHelp(msg);
      default:
        await this.wechat.reply(msg, `❓ 未知命令: ${cmd}\n输入 /help 查看帮助`);
    }
  }

  /** /ls — 列出活跃会话 */
  async _cmdList(msg) {
    const list = this.sessions.listActive();
    if (!list.length) {
      await this.wechat.reply(msg, '📭 没有活跃的 CC 会话');
      return;
    }

    const target = this._resolveTarget();
    const lines = ['📋 活跃会话：', ''];
    list.forEach((s, i) => {
      const marker = s.pid === target?.pid ? ' 👈' : '';
      const status = s.status === 'idle' ? '💤' : '⚡';
      const src = s.source !== '.claude' ? ` [${s.source}]` : '';
      lines.push(`${i + 1}. ${status} ${s.project}${src} (PID:${s.pid})${marker}`);
    });

    await this.wechat.reply(msg, lines.join('\n'));
  }

  /** /to N — 切换目标会话 */
  async _cmdTo(n, msg) {
    const idx = parseInt(n) - 1;
    const list = this.sessions.listActive();
    if (isNaN(idx) || idx < 0 || idx >= list.length) {
      await this.wechat.reply(msg, `❌ 无效序号，当前 ${list.length} 个会话`);
      return;
    }
    this.currentTarget = list[idx].pid;
    const s = list[idx];
    await this.wechat.reply(msg, `✅ 切换到: ${s.project} (PID:${s.pid})`);
  }

  /** /new [目录] [任务] — 新开 tab */
  async _cmdNew(args, msg) {
    const cfg = getConfig();
    let cwd = args[0] || process.cwd();
    let taskDescription = args.slice(1).join(' ') || undefined;

    // 如果第一个参数不像路径，整个当作任务描述
    if (args[0] && !args[0].includes('/') && !args[0].includes('\\') && !args[0].includes(':')) {
      cwd = process.cwd();
      taskDescription = args.join(' ') || undefined;
    }

    try {
      await newTab({
        cwd,
        taskDescription,
        claudeDir: cfg.claudeDirs[0],
      });
      const desc = taskDescription ? ` 任务: ${taskDescription}` : '';
      await this.wechat.reply(msg, `🆕 已开新 tab: ${cwd}${desc}`);
    } catch (e) {
      await this.wechat.reply(msg, `❌ 开新 tab 失败: ${e.message}`);
    }
  }

  /** /last — 获取当前会话最后回复 */
  async _cmdLast(msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    const reply = this.sessions.getLastAssistantMessage(target);
    if (!reply) {
      await this.wechat.reply(msg, '📭 无回复记录');
      return;
    }

    const truncated = reply.length > 1500 ? reply.substring(0, 1500) + '\n...(截断)' : reply;
    await this.wechat.reply(msg, `📄 [${target.project}] 最后回复:\n\n${truncated}`);
  }

  /** /perm [N] — 切换权限模式 */
  async _cmdPerm(n, msg) {
    let target;
    if (n) {
      const idx = parseInt(n) - 1;
      const list = this.sessions.listActive();
      if (isNaN(idx) || idx < 0 || idx >= list.length) {
        await this.wechat.reply(msg, '❌ 无效序号');
        return;
      }
      target = list[idx];
    } else {
      target = this._resolveTarget();
    }

    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    try {
      await togglePermission(target.pid);
      await this.wechat.reply(msg, `🔄 已切换权限: ${target.project} (PID:${target.pid})`);
    } catch (e) {
      await this.wechat.reply(msg, `❌ 切换失败: ${e.message}`);
    }
  }

  /** /help */
  async _cmdHelp(msg) {
    await this.wechat.reply(msg, [
      '📖 cc-wechat 命令：',
      '',
      '直接发文本 → 注入到当前 CC 会话',
      '/ls        → 列出活跃会话',
      '/to N      → 切换到第 N 个会话',
      '/new [目录] [任务] → 新开 tab',
      '/last      → 查看最后回复',
      '/perm [N]  → 切换权限模式',
      '/help      → 本帮助',
    ].join('\n'));
  }

  // ── 目标会话解析 ──

  _resolveTarget() {
    const list = this.sessions.listActive();
    if (!list.length) return null;

    // 1. 最近推送过通知的（如果仍活跃）
    if (this.lastNotifiedPid) {
      const s = list.find(s => s.pid === this.lastNotifiedPid);
      if (s) return s;
    }

    // 2. 手动选中的（如果仍活跃）
    if (this.currentTarget) {
      const s = list.find(s => s.pid === this.currentTarget);
      if (s) return s;
    }

    // 3. updatedAt 最近的
    return list[0];
  }
}
