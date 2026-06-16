// bridge.js — 命令路由：解析微信命令 → 调度执行
import { SessionManager } from './session.js';
import { injectInput, newTab, injectKey, readScreen } from './terminal.js';
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
      
      // 等待终端重绘并抓取屏幕
      await new Promise(r => setTimeout(r, 600));
      const screen = await readScreen(target.pid);
      const suffix = screen ? `\n\n📺 界面更新：\n${screen}` : '';

      await this.wechat.reply(msg, `⌨️ 已注入 → [${target.project}]${suffix}`);
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
        return this._cmdKey('shifttab', msg);
      case '/up':
        return this._cmdKeyRepeated('up', parts[1], msg);
      case '/down':
        return this._cmdKeyRepeated('down', parts[1], msg);
      case '/space':
        return this._cmdKeyRepeated('space', parts[1], msg);
      case '/enter':
        return this._cmdKeyRepeated('enter', parts[1], msg);
      case '/tab':
        return this._cmdKeyRepeated('tab', parts[1], msg);
      case '/esc':
        return this._cmdKeyRepeated('esc', parts[1], msg);
      case '/screen':
        return this._cmdScreen(msg);
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

  /** 发送控制键（支持重复次数） */
  async _cmdKeyRepeated(keyName, countStr, msg) {
    let count = 1;
    if (countStr) {
      const parsed = parseInt(countStr, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
        count = parsed;
      }
    }

    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    try {
      for (let i = 0; i < count; i++) {
        await injectKey(target.pid, keyName);
        if (i < count - 1) {
          // 稍微延迟一下防止过快
          await new Promise(r => setTimeout(r, 100));
        }
      }
      
      // 等待终端重绘
      await new Promise(r => setTimeout(r, 400));
      const screen = await readScreen(target.pid);
      const suffix = screen ? `\n\n📺 界面更新：\n${screen}` : '';
      
      const countMsg = count > 1 ? ` (${count}次)` : '';
      await this.wechat.reply(msg, `⌨️ 发送 [${keyName.toUpperCase()}]${countMsg}${suffix}`);
    } catch (e) {
      await this.wechat.reply(msg, `❌ 键注入失败: ${e.message}`);
    }
  }

  /** 发送单次控制键 */
  async _cmdKey(keyName, msg) {
    return this._cmdKeyRepeated(keyName, '1', msg);
  }

  /** /screen — 获取当前屏幕截图 */
  async _cmdScreen(msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }
    try {
      const screen = await readScreen(target.pid);
      if (!screen) {
        await this.wechat.reply(msg, '📺 屏幕为空或获取失败');
      } else {
        await this.wechat.reply(msg, `📺 当前界面 [${target.project}]:\n\n${screen}`);
      }
    } catch(e) {
      await this.wechat.reply(msg, `❌ 获取屏幕失败: ${e.message}`);
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
      '/new [任务] → 新开 tab',
      '/last      → 查看最后回复',
      '-- 按键注入 --',
      '/up /down  → 上下选择',
      '/space     → 空格(多选勾选)',
      '/enter     → 回车确认',
      '/tab       → Tab 切换',
      '/perm      → 切换权限模式(Shift+Tab)',
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
