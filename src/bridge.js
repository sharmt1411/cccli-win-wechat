// bridge.js — 命令路由：解析微信命令 → 调度执行
import { SessionManager } from './session.js';
import { injectInput, newTab, injectKey, readScreen } from './terminal.js';
import { get as getConfig } from './config.js';
import { normalizeInteraction, resolveQuickReply, sanitizeScreenText } from './interaction.js';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

const NEW_DIR_PAGE_SIZE = 10;

export class Bridge {
  /**
   * @param {import('./wechat.js').WeChatBot} wechat
   */
  constructor(wechat) {
    this.wechat = wechat;
    this.sessions = new SessionManager();
    this.currentTarget = null;      // 当前手动选中的 PID
    this.lastNotifiedPid = null;    // 最近通知到微信的 PID
    this.pendingInteractions = new Map();
    this.pendingNotificationSessions = new Map();
    this.notificationHistory = [];
    this.pendingTargetChoice = null;
    this.pendingNewDirGuide = null;
    this.pendingNewTabLaunch = null;
    this.pendingNewTabTrust = null;
    this.notificationSeq = 0;
  }

  /** 由 NotifyWatcher 调用，更新最后通知的会话；返回 false 可暂缓推送 */
  onNotify(data, formattedText = '') {
    if (this.pendingNewTabLaunch) {
      this.pendingNewTabLaunch.notifications.push({ data, text: formattedText });
      return false;
    }
    this._applyNotifyState(data);
    return formattedText || undefined;
  }

  _applyNotifyState(data) {
    if (data.pid) {
      this.lastNotifiedPid = data.pid;
      const interaction = normalizeInteraction(data);
      if (data.event === 'Notification') {
        this._recordNotification(data);
        if (interaction) {
          this.pendingInteractions.set(data.pid, {
            interaction,
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
        } else {
          this.pendingInteractions.delete(data.pid);
        }
      } else {
        this.pendingInteractions.delete(data.pid);
        this.pendingNotificationSessions.delete(data.pid);
      }
    }
  }

  /** 处理微信消息 */
  async handleMessage(msg) {
    const text = msg.item_list?.[0]?.text_item?.text?.trim();
    if (!text) return;

    if (this.pendingNewTabLaunch) {
      const handled = await this._handlePendingNewTabLaunch(text, msg);
      if (handled) return;
    }

    if (this.pendingNewTabTrust) {
      const handled = await this._handlePendingNewTabTrust(text, msg);
      if (handled) return;
    }

    if (this.pendingTargetChoice) {
      const handled = await this._handlePendingTargetChoice(text, msg);
      if (handled) return;
    }

    if (this.pendingNewDirGuide) {
      const handled = await this._handlePendingNewDirGuide(text, msg);
      if (handled) return;
    }

    if (text.startsWith('/')) {
      await this._handleCommand(text, msg);
    } else {
      await this._handleReply(text, msg);
    }
  }

  // ── 普通文本 → 注入到目标 CC ──

  async _handleReply(text, msg, opts = {}) {
    const target = opts.targetPid ? this.sessions.findByPid(opts.targetPid) : this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    if (!opts.skipDisambiguation && this._shouldAskTargetChoice(target.pid)) {
      await this._askTargetChoice(text, msg);
      return;
    }

    try {
      if (this._isChoiceLike(text)) {
        await this._refreshPendingInteraction(target.pid);
      }

      const quickReply = this._resolveInteractionReply(text, target.pid);
      const payload = quickReply?.value || text;

      if (quickReply?.mode === 'keys') {
        await this._injectKeySequence(target.pid, payload);
      } else if (quickReply?.mode === 'key') {
        await injectKey(target.pid, payload);
      } else {
        await injectInput(target.pid, payload);
      }

      if (quickReply && quickReply.mode !== 'keys') {
        this.pendingInteractions.delete(target.pid);
      }
      this._markSessionAnswered(target.pid);

      if (!quickReply) {
        await this.wechat.reply(msg, `⌨️ 已发送 → [${target.project}]`);
        return;
      }
      
      // 等待终端重绘并抓取屏幕
      await new Promise(r => setTimeout(r, 600));
      const screen = await readScreen(target.pid);
      if (quickReply?.mode === 'keys') {
        this._refreshPendingInteractionFromScreen(target.pid, screen);
      }
      const suffix = this._screenSuffix(screen);

      const action = quickReply ? `已选择 ${quickReply.label}` : '已注入';
      await this.wechat.reply(msg, `⌨️ ${action} → [${target.project}]${suffix}`);
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
      case '/pick':
        return this._cmdPick(parts.slice(1), msg);
      case '/up':
        return this._cmdKeyRepeated('up', parts[1], msg);
      case '/down':
        return this._cmdKeyRepeated('down', parts[1], msg);
      case '/left':
        return this._cmdKeyRepeated('left', parts[1], msg);
      case '/right':
        return this._cmdKeyRepeated('right', parts[1], msg);
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
    const beforePids = new Set(this.sessions.listActive().map(s => s.pid));
    const parsed = this._parseNewArgs(args);
    const { cwd, taskDescription, autoTrust } = parsed;

    if (parsed.needsGuide) {
      await this._startNewDirGuide(msg, { taskDescription, autoTrust });
      return;
    }

    if (!cwd) {
      if (parsed.missingDir) {
        await this._askCreateMissingDir(msg, {
          candidatePath: parsed.missingDir,
          currentDir: this._nearestExistingDir(dirname(parsed.missingDir)),
          taskDescription,
          autoTrust,
        });
        return;
      }
      await this.wechat.reply(msg, '❌ 目录不存在或不可访问。可用 /new 进入目录向导，或用 /new .、/new N、/new <目录>。');
      return;
    }

    await this._openNewTab({ cwd, taskDescription, autoTrust, beforePids, cfg, msg });
  }

  async _openNewTab({ cwd, taskDescription, autoTrust, beforePids, cfg, msg }) {
    cfg ||= getConfig();
    beforePids ||= new Set(this.sessions.listActive().map(s => s.pid));
    const launch = {
      cwd,
      queued: [],
      notifications: [],
      notified: false,
      startedAt: Date.now(),
    };
    this.pendingNewTabLaunch = launch;
    let drainQueued = false;
    let holdReason = '';

    try {
      await newTab({
        cwd,
        taskDescription,
        claudeDir: cfg.claudeDirs[0],
      });
      const desc = taskDescription ? ` 任务: ${taskDescription}` : '';
      const session = await this._waitForNewSession(cwd, beforePids);

      if (!session) {
        holdReason = '未能定位新会话';
        await this.wechat.reply(msg, `🆕 已开新 tab: ${cwd}${desc}\n未能立即定位新会话，稍后可用 /ls 查看。`);
        return;
      }

      this.currentTarget = session.pid;
      this.lastNotifiedPid = session.pid;
      launch.readyPid = session.pid;

      await new Promise(r => setTimeout(r, 500));
      const screen = await readScreen(session.pid).catch(() => '');
      const trustPrompt = this._isTrustPrompt(screen);

      if (trustPrompt && autoTrust) {
        await injectKey(session.pid, 'enter');
        await new Promise(r => setTimeout(r, 700));
        const nextScreen = await readScreen(session.pid).catch(() => '');
        drainQueued = true;
        await this.wechat.reply(msg, `🆕 已开新 tab 并确认信任: ${cwd}${desc}\n已切换目标到 [${session.project}]${this._screenSuffix(nextScreen)}`);
        return;
      }

      if (trustPrompt) {
        holdReason = '等待信任确认';
        this.pendingNewTabTrust = {
          pid: session.pid,
          cwd,
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        await this.wechat.reply(msg, [
          `🆕 已开新 tab: ${cwd}${desc}`,
          `已切换目标到 [${session.project}]，但 Claude 需要确认是否信任该目录。`,
          '确认信任请发 /enter；不信任可发 /down 后 /enter，或 /esc。',
          this._screenSuffix(screen).trimStart(),
        ].filter(Boolean).join('\n'));
        return;
      }

      drainQueued = true;
      await this.wechat.reply(msg, `🆕 已开新 tab: ${cwd}${desc}\n已切换目标到 [${session.project}]`);
    } catch (e) {
      holdReason = `开新 tab 失败: ${e.message}`;
      await this.wechat.reply(msg, `❌ 开新 tab 失败: ${e.message}`);
    } finally {
      if (this.pendingNewTabLaunch === launch) {
        this.pendingNewTabLaunch = null;
      }
      await this._flushNewTabLaunchNotifications(launch);
      await this._flushNewTabLaunchQueue(launch, { drain: drainQueued, reason: holdReason });
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
  async _cmdPick(args, msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, '❌ 没有活跃的 CC 会话');
      return;
    }

    const choice = args.join(' ').trim();
    await this._refreshPendingInteraction(target.pid);
    const quickReply = this._resolveInteractionReply(choice, target.pid);
    if (!quickReply || quickReply.mode !== 'keys') {
      await this.wechat.reply(msg, '❌ 当前没有可批量选择的复选菜单，或选项编号无效');
      return;
    }

    try {
      await this._injectKeySequence(target.pid, quickReply.value);

      await new Promise(r => setTimeout(r, 600));
      const screen = await readScreen(target.pid);
      this._refreshPendingInteractionFromScreen(target.pid, screen);
      this._clearTrustHoldIfResolved(target.pid, screen, keyName);
      const suffix = this._screenSuffix(screen);
      await this.wechat.reply(msg, `⌨️ 已选择 ${quickReply.label} → [${target.project}]${suffix}`);
    } catch (e) {
      await this.wechat.reply(msg, `❌ 批量选择失败: ${e.message}`);
    }
  }

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
      this._refreshPendingInteractionFromScreen(target.pid, screen);
      const suffix = this._screenSuffix(screen);
      
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
        this._refreshPendingInteractionFromScreen(target.pid, screen);
        await this.wechat.reply(msg, `📺 当前界面 [${target.project}]:\n\n${sanitizeScreenText(screen)}`);
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
      '',
      '-- 会话 --',
      '/ls        → 列出活跃会话',
      '/to N      → 切换到第 N 个会话',
      '/new [.,N,目录] [任务] → 新开 tab',
      '/new       → 进入目录选择向导，可逐级选择或创建目录',
      '/new --trust ... → 新目录信任提示自动确认',
      '/last      → 查看最后回复',
      '/screen    → 查看当前终端界面',
      '',
      '-- 提问/授权回复 --',
      '收到提问/授权通知时，优先直接回复数字选择',
      '多分类问题可回复 [1 3][1][2] 一次提交',
      '单分类问题也用 [1] 或 [1 3]；/pick 1 3 可手动批量选择',
      '',
      '-- 按键注入 --',
      '/up /down  → 上下选择',
      '/left /right → 左右选择',
      '/space     → 空格(多选勾选)',
      '/enter     → 回车确认',
      '/tab       → Tab 切换',
      '/perm      → 切换权限模式(Shift+Tab)',
      '/help      → 本帮助',
    ].join('\n'));
  }

  async _handlePendingTargetChoice(text, msg) {
    const pending = this.pendingTargetChoice;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      this.pendingTargetChoice = null;
      return false;
    }

    if (text === '/cancel' || text === '取消') {
      this.pendingTargetChoice = null;
      await this.wechat.reply(msg, '已取消本次会话选择');
      return true;
    }

    const idx = parseInt(text, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= pending.candidates.length) {
      await this.wechat.reply(msg, this._formatTargetChoicePrompt(pending.candidates, '请回复有效序号，或发送 /cancel 取消。'));
      return true;
    }

    const selected = pending.candidates[idx];
    const originalText = pending.originalText;
    this.pendingTargetChoice = null;
    await this._handleReply(originalText, msg, {
      targetPid: selected.pid,
      skipDisambiguation: true,
    });
    return true;
  }

  async _handlePendingNewTabLaunch(text, msg) {
    const pending = this.pendingNewTabLaunch;
    if (!pending) return false;

    if (text.startsWith('/')) {
      await this.wechat.reply(msg, '⏳ 正在创建新 tab，命令不会排队。请等启动完成后再发送。');
      return true;
    }

    if (pending.queued.length >= 10) {
      await this.wechat.reply(msg, '⏳ 新 tab 仍在启动，暂存消息已达到 10 条；这条没有排队，请稍后重发。');
      return true;
    }

    pending.queued.push({ text, msg });
    if (!pending.notified) {
      pending.notified = true;
      await this.wechat.reply(msg, `⏳ 正在创建新 tab，已暂存消息。启动完成后会发送到新会话: ${pending.cwd}`);
    }
    return true;
  }

  async _handlePendingNewTabTrust(text, msg) {
    const pending = this.pendingNewTabTrust;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt || !this.sessions.findByPid(pending.pid)) {
      this.pendingNewTabTrust = null;
      return false;
    }

    if (text.startsWith('/')) {
      return false;
    }

    const s = String(text || '').trim();
    if (/^(?:1|y|yes|信任|确认|同意)$/i.test(s)) {
      try {
        await injectKey(pending.pid, 'enter');
        await new Promise(r => setTimeout(r, 700));
        const screen = await readScreen(pending.pid).catch(() => '');
        this._clearTrustHoldIfResolved(pending.pid, screen, 'enter');
        await this.wechat.reply(msg, `✅ 已确认信任目录${this._screenSuffix(screen)}`);
      } catch (e) {
        await this.wechat.reply(msg, `❌ 确认信任失败: ${e.message}`);
      }
      return true;
    }

    await this.wechat.reply(msg, [
      '⏸️ 新 tab 正在等待 Claude 目录信任确认，这条消息没有发送。',
      `目录: ${pending.cwd}`,
      '信任请发 1、信任 或 /enter；不信任可发 /down 后 /enter，或 /esc。',
    ].join('\n'));
    return true;
  }

  async _flushNewTabLaunchQueue(launch, { drain, reason }) {
    if (!launch?.queued?.length) return;

    if (!drain) {
      const last = launch.queued[launch.queued.length - 1];
      await this.wechat.reply(last.msg, `⏸️ 新 tab 未进入可直接输入状态（${reason || '未就绪'}），${launch.queued.length} 条暂存消息未发送。请确认后重发。`);
      return;
    }

    for (const item of launch.queued) {
      await this._handleReply(item.text, item.msg, {
        targetPid: launch.readyPid,
        skipDisambiguation: true,
      });
    }
  }

  async _flushNewTabLaunchNotifications(launch) {
    if (!launch?.notifications?.length) return;

    for (const item of launch.notifications) {
      this._applyNotifyState(item.data);
      const text = [
        '🔕 新 tab 启动期间收到通知，已延后推送：',
        '',
        item.text,
      ].filter(Boolean).join('\n');
      await this.wechat.push(text);
    }
  }

  _clearTrustHoldIfResolved(pid, screen, keyName) {
    if (this.pendingNewTabTrust?.pid !== pid) return;
    const key = String(keyName || '').toLowerCase();
    if ((key === 'enter' || key === 'esc') && !this._isTrustPrompt(screen)) {
      this.pendingNewTabTrust = null;
    }
  }

  async _askTargetChoice(text, msg) {
    const candidates = this._getPendingNotificationCandidates();
    this.pendingTargetChoice = {
      originalText: text,
      candidates,
      expiresAt: Date.now() + 30 * 1000,
    };
    await this.wechat.reply(msg, this._formatTargetChoicePrompt(candidates));
  }

  _formatTargetChoicePrompt(candidates, prefix = '多个会话都有未回复通知，请选择要发送到哪个会话：') {
    const lines = [`⚠️ ${prefix}`, ''];
    candidates.forEach((item, index) => {
      const age = Math.max(0, Math.round((Date.now() - item.notifiedAt) / 1000));
      const source = item.source && item.source !== '.claude' ? ` [${item.source}]` : '';
      lines.push(`${index + 1}. ${item.project || '未知项目'}${source} (PID:${item.pid}, ${age}s前)`);
    });
    lines.push('');
    lines.push('回复序号后，我会把刚才那条消息发送过去。');
    return lines.join('\n');
  }

  _recordNotification(data) {
    const now = Date.now();
    const item = {
      pid: data.pid,
      project: data.project || '',
      source: data.source || data.claudeDir?.split(/[/\\]/).pop() || '',
      notifiedAt: now,
      seq: ++this.notificationSeq,
    };

    this.pendingNotificationSessions.set(data.pid, item);
    this.notificationHistory.push(item);
    if (this.notificationHistory.length > 20) {
      this.notificationHistory = this.notificationHistory.slice(-20);
    }
  }

  _shouldAskTargetChoice(defaultPid) {
    const candidates = this._getPendingNotificationCandidates();
    if (candidates.length < 2) return false;

    const latest = this.notificationHistory[this.notificationHistory.length - 1];
    if (!latest || latest.pid !== defaultPid) return false;
    if (Date.now() - latest.notifiedAt > 3000) return false;

    const recent3 = this.notificationHistory.slice(-3);
    if (recent3.length === 3 && recent3.every(item => item.pid === latest.pid)) {
      return false;
    }

    return true;
  }

  _getPendingNotificationCandidates() {
    const active = new Map(this.sessions.listActive().map(s => [s.pid, s]));
    const candidates = [];

    for (const [pid, item] of this.pendingNotificationSessions.entries()) {
      const session = active.get(pid);
      if (!session) {
        this.pendingNotificationSessions.delete(pid);
        continue;
      }
      candidates.push({
        ...session,
        ...item,
      });
    }

    return candidates.sort((a, b) => (b.notifiedAt - a.notifiedAt) || (b.seq - a.seq));
  }

  _markSessionAnswered(pid) {
    this.pendingNotificationSessions.delete(pid);
  }

  _parseNewArgs(rawArgs) {
    const args = [...rawArgs];
    const autoTrustIndex = args.findIndex(arg => arg === '--trust' || arg === '-y');
    const autoTrust = autoTrustIndex >= 0;
    if (autoTrust) args.splice(autoTrustIndex, 1);

    const baseSession = this._resolveTarget();
    const baseCwd = baseSession?.cwd || process.cwd();
    let cwd = baseCwd;
    let taskArgs = args;
    let missingDir = null;

    if (!args.length) {
      return {
        cwd: null,
        taskDescription: undefined,
        autoTrust,
        needsGuide: true,
      };
    }

    if (['?', '？', 'choose', 'guide', '选择'].includes(String(args[0] || '').toLowerCase())) {
      return {
        cwd: null,
        taskDescription: args.slice(1).join(' ') || undefined,
        autoTrust,
        needsGuide: true,
      };
    }

    if (args.length) {
      const first = args[0];
      const sessionCwd = this._cwdFromSessionIndex(first);
      const resolvedDir = sessionCwd || this._resolveDirectoryArg(first, baseCwd);

      if (resolvedDir) {
        cwd = resolvedDir;
        taskArgs = args.slice(1);
      } else if (this._looksLikeDirectoryArg(first)) {
        cwd = null;
        missingDir = this._resolvePathArg(first, baseCwd);
        taskArgs = args.slice(1);
      }
    }

    return {
      cwd,
      taskDescription: taskArgs.join(' ') || undefined,
      autoTrust,
      missingDir,
    };
  }

  _cwdFromSessionIndex(value) {
    if (!/^\d+$/.test(String(value || ''))) return null;
    const idx = parseInt(value, 10) - 1;
    const list = this.sessions.listActive();
    return list[idx]?.cwd || null;
  }

  _resolveDirectoryArg(value, baseCwd) {
    if (!value) return null;
    if (value === '.') return baseCwd;
    if (value === '~') return homedir();

    const looksLikePath = this._looksLikeDirectoryArg(value);
    const candidate = this._resolvePathArg(value, baseCwd);
    if ((looksLikePath || this._isDirectory(candidate)) && this._isDirectory(candidate)) {
      return candidate;
    }
    return null;
  }

  _resolvePathArg(value, baseCwd) {
    if (value === '~') return homedir();
    if (String(value || '').startsWith('~/') || String(value || '').startsWith('~\\')) {
      return resolve(homedir(), String(value).slice(2));
    }
    return isAbsolute(value) ? value : resolve(baseCwd, value);
  }

  _isDirectory(path) {
    try {
      return existsSync(path) && statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  _nearestExistingDir(path, fallback = process.cwd()) {
    let current = path;
    while (current && current !== dirname(current)) {
      if (this._isDirectory(current)) return current;
      current = dirname(current);
    }
    if (current && this._isDirectory(current)) return current;
    return fallback;
  }

  _looksLikeDirectoryArg(value) {
    return String(value || '').includes('/')
      || String(value || '').includes('\\')
      || String(value || '').includes(':')
      || String(value || '').startsWith('.');
  }

  async _startNewDirGuide(msg, { taskDescription, autoTrust } = {}) {
    const baseSession = this._resolveTarget();
    const currentDir = baseSession?.cwd || process.cwd();
    this.pendingNewDirGuide = {
      currentDir,
      taskDescription,
      autoTrust: !!autoTrust,
      page: 0,
      expiresAt: Date.now() + 3 * 60 * 1000,
    };
    await this.wechat.reply(msg, this._formatNewDirGuide());
  }

  async _handlePendingNewDirGuide(text, msg) {
    const pending = this.pendingNewDirGuide;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      this.pendingNewDirGuide = null;
      return false;
    }

    const s = String(text || '').trim();
    if (s === '/cancel' || s === '取消') {
      this.pendingNewDirGuide = null;
      await this.wechat.reply(msg, '已取消新建 tab 目录选择');
      return true;
    }

    if (pending.mode === 'create') {
      if (/^(?:1|y|yes|是|创建|确认)$/i.test(s)) {
        try {
          mkdirSync(pending.candidatePath, { recursive: true });
        } catch (e) {
          await this.wechat.reply(msg, `❌ 创建目录失败: ${e.message}`);
          return true;
        }

        const cwd = pending.candidatePath;
        const { taskDescription, autoTrust } = pending;
        this.pendingNewDirGuide = null;
        await this._openNewTab({ cwd, taskDescription, autoTrust, msg });
        return true;
      }

      if (/^(?:2|n|no|否|不创建|返回)$/i.test(s)) {
        this.pendingNewDirGuide = {
          currentDir: pending.currentDir,
          taskDescription: pending.taskDescription,
          autoTrust: pending.autoTrust,
          page: pending.page || 0,
          expiresAt: Date.now() + 3 * 60 * 1000,
        };
        await this.wechat.reply(msg, this._formatNewDirGuide('已返回目录选择。'));
        return true;
      }

      await this.wechat.reply(msg, this._formatCreateDirPrompt(pending, '请回复 1 创建，或 2 返回。'));
      return true;
    }

    pending.expiresAt = Date.now() + 3 * 60 * 1000;
    pending.page = pending.page || 0;

    const allChildren = this._listChildDirectories(pending.currentDir);
    const totalPages = Math.max(1, Math.ceil(allChildren.length / NEW_DIR_PAGE_SIZE));

    if (/^(?:n|next|下一页|下页)$/.test(s)) {
      if (pending.page >= totalPages - 1) {
        await this.wechat.reply(msg, this._formatNewDirGuide('已经是最后一页。'));
        return true;
      }
      pending.page += 1;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    if (/^(?:p|prev|previous|上一页|上页)$/.test(s)) {
      if (pending.page <= 0) {
        await this.wechat.reply(msg, this._formatNewDirGuide('已经是第一页。'));
        return true;
      }
      pending.page -= 1;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    if (s === '0' || s === '.' || s === '使用' || s === '当前') {
      const cwd = pending.currentDir;
      const { taskDescription, autoTrust } = pending;
      this.pendingNewDirGuide = null;
      await this._openNewTab({ cwd, taskDescription, autoTrust, msg });
      return true;
    }

    if (s === '..' || s === '上级' || s === '返回') {
      pending.currentDir = dirname(pending.currentDir);
      pending.page = 0;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    const children = this._pagedDirectories(pending.currentDir, pending.page);
    const idx = parseInt(s, 10) - 1;
    if (!Number.isNaN(idx) && idx >= 0 && idx < children.length) {
      pending.currentDir = children[idx].path;
      pending.page = 0;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    const createMatch = s.match(/^(?:c|create|\+|新建|创建)\s+(.+)$/i);
    if (createMatch) {
      await this._askCreateMissingDir(msg, {
        candidatePath: this._resolvePathArg(createMatch[1].trim(), pending.currentDir),
        currentDir: pending.currentDir,
        taskDescription: pending.taskDescription,
        autoTrust: pending.autoTrust,
      });
      return true;
    }

    const gotoMatch = s.match(/^(?:p|path|cd|进入)\s+(.+)$/i);
    const rawPath = gotoMatch ? gotoMatch[1].trim() : s;
    const candidate = this._resolvePathArg(rawPath, pending.currentDir);
    if (this._isDirectory(candidate)) {
      pending.currentDir = candidate;
      pending.page = 0;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    if (rawPath && !rawPath.startsWith('/')) {
      await this._askCreateMissingDir(msg, {
        candidatePath: candidate,
        currentDir: pending.currentDir,
        taskDescription: pending.taskDescription,
        autoTrust: pending.autoTrust,
      });
      return true;
    }

    await this.wechat.reply(msg, this._formatNewDirGuide('请回复序号、0、..，或 c 名称 创建目录。'));
    return true;
  }

  async _askCreateMissingDir(msg, { candidatePath, currentDir, taskDescription, autoTrust }) {
    this.pendingNewDirGuide = {
      mode: 'create',
      candidatePath,
      currentDir: this._nearestExistingDir(currentDir || dirname(candidatePath)),
      taskDescription,
      autoTrust: !!autoTrust,
      page: 0,
      expiresAt: Date.now() + 3 * 60 * 1000,
    };
    await this.wechat.reply(msg, this._formatCreateDirPrompt(this.pendingNewDirGuide));
  }

  _formatNewDirGuide(prefix = '') {
    const pending = this.pendingNewDirGuide;
    const allChildren = this._listChildDirectories(pending.currentDir);
    const totalPages = Math.max(1, Math.ceil(allChildren.length / NEW_DIR_PAGE_SIZE));
    const page = Math.min(Math.max(pending.page || 0, 0), totalPages - 1);
    pending.page = page;
    const children = allChildren.slice(page * NEW_DIR_PAGE_SIZE, (page + 1) * NEW_DIR_PAGE_SIZE);
    const lines = [];
    if (prefix) lines.push(prefix, '');
    lines.push('🧭 选择新 tab 工作目录');
    lines.push(`当前: ${pending.currentDir}`);
    if (pending.taskDescription) lines.push(`任务: ${pending.taskDescription}`);
    if (pending.autoTrust) lines.push('信任: 启动后自动确认');
    if (totalPages > 1) lines.push(`页码: ${page + 1}/${totalPages}`);
    lines.push('');
    lines.push('0. 使用当前目录');
    lines.push(`.. 上一级: ${dirname(pending.currentDir)}`);
    children.forEach((child, index) => {
      lines.push(`${index + 1}. ${child.name}`);
    });
    lines.push('');
    lines.push('回复序号进入子目录；回复 0 使用当前目录。');
    if (totalPages > 1) lines.push('回复 下一页/上一页 翻页。');
    lines.push('回复 c 名称 创建子目录，或直接发目录名/路径跳转。');
    lines.push('发送 /cancel 取消。');
    return lines.join('\n');
  }

  _formatCreateDirPrompt(pending, prefix = '') {
    return [
      prefix,
      '📁 目录不存在，是否创建？',
      `路径: ${pending.candidatePath}`,
      pending.taskDescription ? `任务: ${pending.taskDescription}` : '',
      '',
      '1. 创建并新开 tab',
      '2. 返回目录选择',
      '',
      '发送 /cancel 取消。',
    ].filter(Boolean).join('\n');
  }

  _listChildDirectories(dir) {
    const hiddenOrNoisy = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage']);
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.'))
        .filter(entry => !hiddenOrNoisy.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .map(entry => ({
          name: entry.name,
          path: resolve(dir, entry.name),
        }));
    } catch {
      return [];
    }
  }

  _pagedDirectories(dir, page = 0) {
    const start = Math.max(0, page) * NEW_DIR_PAGE_SIZE;
    return this._listChildDirectories(dir).slice(start, start + NEW_DIR_PAGE_SIZE);
  }

  async _waitForNewSession(cwd, beforePids) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const list = this.sessions.listActive();
      const fresh = list.find(s => !beforePids.has(s.pid) && this._samePath(s.cwd, cwd));
      if (fresh) return fresh;
      const byCwd = list.find(s => this._samePath(s.cwd, cwd));
      if (byCwd && !beforePids.has(byCwd.pid)) return byCwd;
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }

  _samePath(a, b) {
    return String(a || '').replace(/[\\/]+$/, '').toLowerCase()
      === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  _isTrustPrompt(screen = '') {
    return /Quick safety check|I trust this folder|Accessing workspace|Claude Code'll be able to read/i.test(screen);
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

  _resolveInteractionReply(text, pid) {
    const pending = this.pendingInteractions.get(pid);
    if (!pending) return null;

    if (pending.expiresAt < Date.now()) {
      this.pendingInteractions.delete(pid);
      return null;
    }

    return resolveQuickReply(text, pending.interaction);
  }

  async _injectKeySequence(pid, keys) {
    for (const key of keys) {
      await injectKey(pid, key);
      await new Promise(r => setTimeout(r, 120));
    }
  }

  async _refreshPendingInteraction(pid) {
    const pending = this.pendingInteractions.get(pid);
    if (!pending) return null;

    if (pending.expiresAt < Date.now()) {
      this.pendingInteractions.delete(pid);
      return null;
    }

    try {
      const screen = await readScreen(pid);
      this._refreshPendingInteractionFromScreen(pid, screen);
      return screen;
    } catch {
      return null;
    }
  }

  _refreshPendingInteractionFromScreen(pid, screenText) {
    const pending = this.pendingInteractions.get(pid);
    if (!pending || !screenText) return;

    const interaction = normalizeInteraction({
      event: 'Notification',
      interaction: {
        type: pending.interaction.type,
        question: pending.interaction.question,
        header: pending.interaction.header,
        multiSelect: pending.interaction.multiSelect,
        questions: pending.interaction.questions,
        toolName: pending.interaction.toolName,
        detail: pending.interaction.detail,
        options: pending.interaction.options,
      },
      screenText,
    });

    if (interaction?.screenOptions?.length) {
      this.pendingInteractions.set(pid, {
        interaction,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    }
  }

  _isChoiceLike(text) {
    const s = String(text).trim();
    if (/^(?:\[[\d\s,，、]+\]\s*)+$/.test(s)) return true;

    const target = this._resolveTarget();
    const pending = target ? this.pendingInteractions.get(target.pid) : null;
    if (pending?.interaction?.type !== 'ask_user_question' && /^(?:y|yes|n|no|同意|允许|拒绝|取消)$/i.test(s)) {
      return true;
    }
    return pending?.interaction?.type !== 'ask_user_question'
      && /^\d{1,2}(?:\s*[,，、\s]\s*\d{1,2})*$/.test(s);
  }

  _screenSuffix(screen) {
    return screen ? `\n\n📺 界面更新：\n${sanitizeScreenText(screen)}` : '';
  }
}
