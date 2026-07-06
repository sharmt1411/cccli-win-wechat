// bridge.js — 命令路由：解析微信命令 → 调度执行
import { SessionManager } from './session.js';
import { injectInput, newTab, injectKey, readScreen } from './terminal.js';
import { get as getConfig, save as saveConfig } from './config.js';
import { normalizeInteraction, resolveQuickReply, sanitizeScreenText } from './interaction.js';
import { formatPresenceState, getPresenceState, shouldOperateByPresence } from './presence.js';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

const NEW_DIR_PAGE_SIZE = 10;
const PENDING_WECHAT_FILES_TTL_MS = 60 * 60 * 1000;
const HIDDEN_OR_NOISY_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage']);

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
    this.capabilityInjectionState = new Map();
    this.pendingWechatFiles = [];
    // 本桥接开启、但 Claude 尚未注册会话文件（首轮对话后才注册）的新 tab。
    // 用控制台 pid 寻址，纳入 /ls、/to 与目标解析；注册后自动并入真实会话。
    this.pendingTabs = [];
    // 各 Map 的条目多为惰性清理，会话退出后可能永久残留；由 janitor 统一兜底淘汰
    this._janitorTimer = setInterval(() => this._runJanitor(), 60 * 1000);
    this._janitorTimer.unref?.();
  }

  /** 停止后台定时器（应用退出时调用） */
  stop() {
    if (this._janitorTimer) {
      clearInterval(this._janitorTimer);
      this._janitorTimer = null;
    }
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
    const inbound = await this._captureWechatFiles(msg);
    const text = (this.wechat.extractMessageText?.(msg) || msg.item_list?.[0]?.text_item?.text || '').trim();

    if (!text) {
      if (inbound.files.length) {
        this._queueWechatFiles(inbound.files);
        await this.wechat.reply(msg, this._formatWechatFilesReceived(inbound.files, inbound.errors, inbound.unhandled));
      } else if (inbound.errors.length) {
        await this.wechat.reply(msg, this._formatWechatFilesError(inbound.errors, inbound.unhandled));
      } else if (inbound.unhandled.length) {
        await this.wechat.reply(msg, this._formatWechatFilesUnhandled(inbound.unhandled));
      }
      return;
    }

    if (await this._pauseForPresenceMode(text, msg)) {
      this._queueWechatFiles(inbound.files);
      return;
    }

    const passthrough = parsePassthroughInput(text);
    if (passthrough !== null) {
      this._queueWechatFiles(inbound.files);
      await this._handleReply(passthrough, msg, {
        forcePlainInput: true,
        skipDisambiguation: true,
      });
      return;
    }

    if (this.pendingNewTabLaunch) {
      const handled = await this._handlePendingNewTabLaunch(text, msg, inbound.files);
      if (handled) return;
    }

    if (this.pendingNewTabTrust) {
      const handled = await this._handlePendingNewTabTrust(text, msg);
      if (handled) {
        this._queueWechatFiles(inbound.files);
        return;
      }
    }

    if (this.pendingTargetChoice) {
      const handled = await this._handlePendingTargetChoice(text, msg);
      if (handled) {
        this._queueWechatFiles(inbound.files);
        return;
      }
    }

    if (this.pendingNewDirGuide) {
      const handled = await this._handlePendingNewDirGuide(text, msg);
      if (handled) {
        this._queueWechatFiles(inbound.files);
        return;
      }
    }

    if (text.startsWith('/')) {
      this._queueWechatFiles(inbound.files);
      await this._handleCommand(text, msg);
    } else {
      const choiceLike = this._isChoiceLike(text);
      const filesForInput = choiceLike ? [] : this._consumeWechatFiles(inbound.files);
      if (choiceLike) this._queueWechatFiles(inbound.files);
      await this._handleReply(text, msg, {
        wechatFiles: filesForInput,
      });
    }
  }

  async _captureWechatFiles(msg) {
    if (typeof this.wechat.saveInboundMedia !== 'function') {
      return { files: [], errors: [], unhandled: [] };
    }

    try {
      const result = await this.wechat.saveInboundMedia(msg);
      return {
        files: Array.isArray(result?.files) ? result.files : [],
        errors: Array.isArray(result?.errors) ? result.errors : [],
        unhandled: Array.isArray(result?.unhandled) ? result.unhandled : [],
      };
    } catch (e) {
      return { files: [], errors: [e.message], unhandled: [] };
    }
  }

  _queueWechatFiles(files) {
    if (!Array.isArray(files) || !files.length) return;
    const now = Date.now();
    this._prunePendingWechatFiles(now);
    this.pendingWechatFiles.push(...files.map(file => ({
      ...file,
      addedAt: now,
      expiresAt: now + PENDING_WECHAT_FILES_TTL_MS,
    })));
    this.pendingWechatFiles = dedupeWechatFiles(this.pendingWechatFiles);
  }

  _consumeWechatFiles(currentFiles = []) {
    const now = Date.now();
    this._prunePendingWechatFiles(now);
    const all = [
      ...this.pendingWechatFiles,
      ...currentFiles.map(file => ({
        ...file,
        addedAt: now,
        expiresAt: now + PENDING_WECHAT_FILES_TTL_MS,
      })),
    ];
    this.pendingWechatFiles = [];
    return dedupeWechatFiles(all);
  }

  _prunePendingWechatFiles(now = Date.now()) {
    this.pendingWechatFiles = this.pendingWechatFiles.filter(file => file.expiresAt > now);
  }

  _formatWechatFilesReceived(files, errors = [], unhandled = []) {
    const lines = [
      `已收到 ${files.length} 个微信文件，已保存。`,
      '下一条普通文本会自动附带这些文件路径。',
      '',
      ...files.map(file => `- ${file.path}`),
    ];
    if (errors.length) {
      lines.push('', '部分文件处理失败:', ...errors.map(err => `- ${err}`));
    }
    if (unhandled.length) {
      lines.push('', '部分媒体未能识别下载参数:', ...formatUnhandledWechatItems(unhandled));
    }
    return lines.join('\n');
  }

  _formatWechatFilesError(errors, unhandled = []) {
    return [
      '微信文件处理失败。',
      ...errors.map(err => `- ${err}`),
      ...(unhandled.length ? ['', '未识别的媒体:', ...formatUnhandledWechatItems(unhandled)] : []),
    ].join('\n');
  }

  _formatWechatFilesUnhandled(unhandled) {
    return [
      '收到微信文件，但当前没有拿到可下载参数，未能保存。',
      '请查看控制台日志: WeChat inbound media skipped',
      '',
      ...formatUnhandledWechatItems(unhandled),
    ].join('\n');
  }

  // ── 普通文本 → 注入到目标 CC ──

  async _handleReply(text, msg, opts = {}) {
    let target;
    if (opts.targetPid) {
      target = this.sessions.findByPid(opts.targetPid);
      if (!target) {
        const t = this.pendingTabs.find(t => t.consolePid === opts.targetPid);
        if (t) target = this._pendingTabToSession(t);
      }
    } else {
      target = this._resolveTarget();
    }
    if (!target) {
      this._queueWechatFiles(opts.wechatFiles);
      await this.wechat.reply(msg, this._noActiveSessionMessage());
      return;
    }

    const wechatFiles = Array.isArray(opts.wechatFiles) ? opts.wechatFiles : [];
    const textWithWechatFiles = wechatFiles.length ? appendWechatFilesContext(text, wechatFiles) : text;

    if (!opts.skipDisambiguation && this._shouldAskTargetChoice(target.pid)) {
      await this._askTargetChoice(text, msg, wechatFiles);
      return;
    }

    let injected = false;
    try {
      const choiceLike = !opts.forcePlainInput && this._isChoiceLike(text);
      if (choiceLike) {
        await this._refreshPendingInteraction(target.pid);
      }

      let quickReply = opts.forcePlainInput ? null : this._resolveInteractionReply(text, target.pid);
      if (!quickReply && !opts.forcePlainInput) {
        quickReply = await this._resolvePermissionShortcutFromScreen(text, target.pid);
      }
      if (quickReply && wechatFiles.length) {
        this._queueWechatFiles(wechatFiles);
      }
      const payload = quickReply?.value || this._appendCapabilityContext(textWithWechatFiles, target, {
        choiceLike,
        forcePlainInput: opts.forcePlainInput,
      });

      if (quickReply?.mode === 'keys') {
        await this._injectKeySequence(target.pid, payload);
      } else if (quickReply?.mode === 'key') {
        await injectKey(target.pid, payload);
      } else {
        await injectInput(target.pid, payload);
      }
      injected = true;

      if (quickReply && quickReply.mode !== 'keys') {
        this.pendingInteractions.delete(target.pid);
      }
      this._markSessionAnswered(target.pid);

      if (!quickReply) {
        await this.wechat.reply(msg, [
          '✅ 已发送',
          this._formatTargetLines(target),
        ].join('\n'));
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
      await this.wechat.reply(msg, [
        `✅ ${action}`,
        this._formatTargetLines(target),
        suffix,
      ].filter(Boolean).join('\n'));
    } catch (e) {
      if (!injected) this._queueWechatFiles(wechatFiles);
      await this.wechat.reply(msg, `❌ 发送失败\n原因: ${e.message}`);
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
      case '/away':
      case '/lockmode':
        return this._cmdAwayMode(parts.slice(1), msg);
      default:
        await this.wechat.reply(msg, `❓ 未知命令: ${cmd}\n\n发送 /help 查看可用命令。`);
    }
  }

  /** /ls — 列出活跃会话 */
  async _cmdList(msg) {
    const list = this._targetableList();
    if (!list.length) {
      await this.wechat.reply(msg, this._noActiveSessionMessage());
      return;
    }

    const target = this._resolveTarget();
    const currentIndex = list.findIndex(s => s.pid === target?.pid) + 1;
    const currentLabel = currentIndex > 0 ? `[${currentIndex}] ${target.project || '未知项目'}` : '未选择';
    const lines = [
      `📋 Claude Code 会话（${list.length} 个）`,
      `当前: ${currentLabel}`,
      '',
    ];
    list.forEach((s, i) => {
      lines.push(...this._formatSessionListItem(s, i + 1, s.pid === target?.pid));
      if (i < list.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('切换: 发送 /to N，例如 /to 2。');
    lines.push('发送文本会进入“当前”会话。');
    if (list.some(s => s.isPending)) lines.push('注: 标“新建·待首条消息”的会话发首条后才会完整注册。');

    await this.wechat.reply(msg, lines.join('\n'));
  }

  /** /to N — 切换目标会话 */
  async _cmdTo(n, msg) {
    const idx = parseInt(n) - 1;
    const list = this._targetableList();
    if (isNaN(idx) || idx < 0 || idx >= list.length) {
      await this.wechat.reply(msg, `❌ 会话序号无效\n当前会话数: ${list.length}\n用法: /to N`);
      return;
    }
    this.currentTarget = list[idx].pid;
    // 同步 lastNotifiedPid，否则 _resolveTarget 会因其优先级更高而让本次 /to 失效。
    this.lastNotifiedPid = list[idx].pid;
    const s = list[idx];
    await this.wechat.reply(msg, [
      '✅ 已切换目标会话',
      this._formatTargetLines(s),
      `PID: ${s.pid}`,
    ].join('\n'));
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
      await this.wechat.reply(msg, [
        '❌ 目录不存在或不可访问',
        '下一步: 发送 /new 进入目录选择向导。',
        '也可以使用: /new .、/new N、/new <目录>',
      ].join('\n'));
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
      const tab = await newTab({
        cwd,
        taskDescription,
        claudeDir: cfg.claudeDirs[0],
      });
      launch.consolePid = tab?.pid || null;
      const desc = taskDescription ? ` 任务: ${taskDescription}` : '';
      const located = await this._waitForNewSessionOrTrust(cwd, beforePids, launch.consolePid);
      const session = located.session;

      if (!session) {
        if (located.trustPrompt && launch.consolePid) {
          if (autoTrust) {
            const trusted = await this._acceptNewTabTrust({
              pid: launch.consolePid,
              cwd,
              beforePids,
              taskDescription,
              queued: launch.queued,
              notifications: launch.notifications,
              expiresAt: Date.now() + 10 * 60 * 1000,
            }, msg, { silentEnter: true });
            drainQueued = trusted;
            launch.heldByTrust = true;
            return;
          }

          holdReason = '等待目录信任确认';
          await this._startPendingNewTabTrust({
            pid: launch.consolePid,
            cwd,
            beforePids,
            taskDescription,
            msg,
            screen: located.screen,
            launch,
          });
          return;
        }

        holdReason = '未能定位新会话';
        this._registerPendingTab({ consolePid: launch.consolePid, cwd, taskDescription });
        this.currentTarget = launch.consolePid;
        this.lastNotifiedPid = launch.consolePid;
        await this.wechat.reply(msg, [
          '🆕 新 tab 已就绪，并设为当前会话',
          `目录: ${cwd}`,
          taskDescription ? `任务: ${taskDescription}` : '',
          '直接发消息即可进入此会话。',
          '说明: 发首条消息后它才会完整出现在 /ls。',
        ].filter(Boolean).join('\n'));
        return;
      }

      this.currentTarget = session.pid;
      this.lastNotifiedPid = session.pid;
      launch.readyPid = session.pid;

      await new Promise(r => setTimeout(r, 500));
      const screen = located.screen || await readScreen(session.pid).catch(() => '');
      const trustPrompt = this._isTrustPrompt(screen);

      if (trustPrompt && autoTrust) {
        const trusted = await this._acceptNewTabTrust({
          pid: session.pid,
          cwd,
          beforePids,
          taskDescription,
          queued: launch.queued,
          notifications: launch.notifications,
          expiresAt: Date.now() + 10 * 60 * 1000,
        }, msg, { session, silentEnter: true });
        drainQueued = trusted;
        launch.heldByTrust = true;
        return;
      }

      if (trustPrompt) {
        holdReason = '等待信任确认';
        await this._startPendingNewTabTrust({
          pid: session.pid,
          cwd,
          beforePids,
          taskDescription,
          msg,
          screen,
          launch,
          session,
        });
        return;
      }

      drainQueued = true;
      await this.wechat.reply(msg, [
        '🆕 已打开新 tab',
        this._formatTargetLines(session),
        taskDescription ? `任务: ${taskDescription}` : '',
      ].filter(Boolean).join('\n'));
    } catch (e) {
      holdReason = `开新 tab 失败: ${e.message}`;
      await this.wechat.reply(msg, `❌ 打开新 tab 失败\n原因: ${e.message}`);
    } finally {
      if (this.pendingNewTabLaunch === launch) {
        this.pendingNewTabLaunch = null;
      }
      if (!launch.heldByTrust) {
        await this._flushNewTabLaunchNotifications(launch);
        await this._flushNewTabLaunchQueue(launch, { drain: drainQueued, reason: holdReason });
      }
    }
  }

  /** /last — 获取当前会话最后回复 */
  async _cmdLast(msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, this._noActiveSessionMessage());
      return;
    }

    const reply = this.sessions.getLastAssistantMessage(target);
    if (!reply) {
      await this.wechat.reply(msg, [
        '📭 没有找到 Claude 的最近回复',
        this._formatTargetLines(target),
      ].join('\n'));
      return;
    }

    const truncated = reply.length > 1500 ? reply.substring(0, 1500) + '\n...(截断)' : reply;
    await this.wechat.reply(msg, [
      '📄 最近回复',
      this._formatTargetLines(target),
      '',
      truncated,
    ].join('\n'));
  }

  /** 发送控制键（支持重复次数） */
  async _cmdPick(args, msg) {
    const target = this._resolveTarget();
    if (!target) {
      await this.wechat.reply(msg, this._noActiveSessionMessage());
      return;
    }

    const choice = args.join(' ').trim();
    await this._refreshPendingInteraction(target.pid);
    const quickReply = this._resolveInteractionReply(choice, target.pid);
    if (!quickReply || quickReply.mode !== 'keys') {
      await this.wechat.reply(msg, [
        '❌ 无法批量选择',
        this._formatTargetLines(target),
        '原因: 当前没有可批量选择的复选菜单，或选项编号无效。',
        '示例: /pick 1 3',
      ].join('\n'));
      return;
    }

    try {
      await this._injectKeySequence(target.pid, quickReply.value);

      await new Promise(r => setTimeout(r, 600));
      const screen = await readScreen(target.pid);
      this._refreshPendingInteractionFromScreen(target.pid, screen);
      const suffix = this._screenSuffix(screen);
      await this.wechat.reply(msg, [
        `✅ 已选择: ${quickReply.label}`,
        this._formatTargetLines(target),
        suffix,
      ].filter(Boolean).join('\n'));
    } catch (e) {
      await this.wechat.reply(msg, `❌ 批量选择失败\n原因: ${e.message}`);
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
      await this.wechat.reply(msg, this._noActiveSessionMessage());
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
      this._clearTrustHoldIfResolved(target.pid, screen, keyName);
      const suffix = this._screenSuffix(screen);
      
      const countMsg = count > 1 ? ` (${count}次)` : '';
      await this.wechat.reply(msg, [
        `✅ 已发送按键: ${keyName.toUpperCase()}${countMsg}`,
        this._formatTargetLines(target),
        suffix,
      ].filter(Boolean).join('\n'));
    } catch (e) {
      await this.wechat.reply(msg, `❌ 按键发送失败\n原因: ${e.message}`);
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
      await this.wechat.reply(msg, this._noActiveSessionMessage());
      return;
    }
    try {
      const screen = await readScreen(target.pid);
      if (!screen) {
        await this.wechat.reply(msg, [
          '📺 当前界面为空，或暂时无法读取',
          this._formatTargetLines(target),
        ].join('\n'));
      } else {
        this._refreshPendingInteractionFromScreen(target.pid, screen);
        await this.wechat.reply(msg, [
          '📺 当前终端界面',
          this._formatTargetLines(target),
          '',
          sanitizeScreenText(screen),
        ].join('\n'));
      }
    } catch(e) {
      await this.wechat.reply(msg, `❌ 获取终端界面失败\n原因: ${e.message}`);
    }
  }

  /** /help */
  async _cmdHelp(msg) {
    await this.wechat.reply(msg, [
      '📖 cc-wechat 帮助',
      '',
      '直接发文本',
      '发送到当前会话。',
      '透传: <内容> 原样发送到终端。',
      '当前目标看 /ls。',
      '',
      '会话',
      '查看: /ls',
      '切换: /to N',
      '向导: /new',
      '新建: /new 目录 任务',
      '信任: /new --trust',
      '回复: /last',
      '屏幕: /screen',
      '',
      '生效模式',
      '查看: /away',
      '仅离开: /away on',
      '始终: /away off',
      '',
      '提问/授权',
      '单分类: [1] 或 [1 3]',
      '多分类: [1 3][1][2]',
      '/pick 1 3 批量勾选',
      '',
      '按键',
      '上下: /up /down',
      '左右: /left /right',
      '勾选: /space',
      '确认: /enter',
      '切换: /tab',
      '取消: /esc',
      '权限: /perm',
      '帮助: /help',
    ].join('\n'));
  }

  async _cmdAwayMode(args, msg) {
    const cfg = getConfig();
    const current = {
      ...(cfg.lockScreenMode || {}),
      enabled: Boolean(cfg.lockScreenMode?.enabled),
    };
    const action = String(args[0] || 'status').toLowerCase();

    if (['on', '1', 'true', '开启', '打开', '启用'].includes(action)) {
      saveConfig({ lockScreenMode: { ...current, enabled: true } });
      const state = await getPresenceState(getConfig());
      await this.wechat.reply(msg, [
        '✅ 已开启离开生效模式',
        '仅锁屏/息屏时推送和桥接。',
        `当前电脑: ${formatPresenceState(state)}`,
        this._formatPresenceDetail(state),
      ].join('\n'));
      return;
    }

    if (['off', '0', 'false', '关闭', '停用'].includes(action)) {
      saveConfig({ lockScreenMode: { ...current, enabled: false } });
      const state = await getPresenceState(getConfig());
      await this.wechat.reply(msg, [
        '✅ 已关闭离开生效模式',
        '现在始终推送和桥接。',
        `当前电脑: ${formatPresenceState(state)}`,
        this._formatPresenceDetail(state),
      ].join('\n'));
      return;
    }

    const state = await getPresenceState(cfg);
    await this.wechat.reply(msg, [
      '🖥️ 离开生效模式',
      `模式: ${current.enabled ? '开启' : '关闭'}`,
      `当前电脑: ${formatPresenceState(state)}`,
      this._formatPresenceDetail(state),
      current.enabled
        ? '效果: 仅锁屏/息屏时工作。'
        : '效果: 始终工作。',
      '',
      '开启: /away on',
      '关闭: /away off',
    ].join('\n'));
  }

  async _handlePendingTargetChoice(text, msg) {
    const pending = this.pendingTargetChoice;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      this.pendingTargetChoice = null;
      this._queueWechatFiles(pending.wechatFiles);
      return false;
    }

    if (text === '/cancel' || text === '取消') {
      this.pendingTargetChoice = null;
      this._queueWechatFiles(pending.wechatFiles);
      await this.wechat.reply(msg, '✅ 已取消本次会话选择。');
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
      wechatFiles: pending.wechatFiles,
    });
    return true;
  }

  async _pauseForPresenceMode(text, msg) {
    const cmd = String(text || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (cmd === '/away' || cmd === '/lockmode' || cmd === '/help') return false;

    const gate = await shouldOperateByPresence();
    if (gate.allowed) return false;

    await this.wechat.reply(msg, [
      '⏸️ 当前未锁屏/息屏',
      '离开生效模式已开启。',
      '这条消息没有发送到 Claude。',
      `当前电脑: ${formatPresenceState(gate.state)}`,
      '',
      '关闭模式: /away off',
    ].join('\n'));
    return true;
  }

  async _handlePendingNewTabLaunch(text, msg, wechatFiles = []) {
    const pending = this.pendingNewTabLaunch;
    if (!pending) return false;

    if (text.startsWith('/')) {
      this._queueWechatFiles(wechatFiles);
      await this.wechat.reply(msg, [
        '⏳ 新 tab 正在启动',
        `目录: ${pending.cwd}`,
        '这条命令没有执行。请等启动完成后再发送。',
      ].join('\n'));
      return true;
    }

    if (pending.queued.length >= 10) {
      this._queueWechatFiles(wechatFiles);
      await this.wechat.reply(msg, [
        '⏳ 新 tab 仍在启动',
        '暂存消息已达到 10 条，这条没有排队。',
        '下一步: 稍后重发。',
      ].join('\n'));
      return true;
    }

    pending.queued.push({ text, msg, wechatFiles });
    if (!pending.notified) {
      pending.notified = true;
      await this.wechat.reply(msg, [
        '⏳ 新 tab 正在启动',
        `目录: ${pending.cwd}`,
        '已暂存这条消息。启动完成后会发送到新会话。',
      ].join('\n'));
    }
    return true;
  }

  async _handlePendingNewTabTrust(text, msg) {
    const pending = this.pendingNewTabTrust;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      await this._exitPendingNewTabTrust(pending, msg, '等待目录信任确认超时，已退出新 tab 创建流程。');
      return true;
    }

    // 信任界面已消失（信任已通过）：立刻解除等待，让消息正常发往会话，避免卡死在信任等待里。
    // 定位到会话就绑定会话 pid；定位不到则用新 tab 的控制台 pid 兜底（注入按 console 走，pid 取得到即可）。
    // screen 必须非空，否则读屏失败会被误判为"信任已过"。
    const screen = await readScreen(pending.pid).catch(() => '');
    if (screen && !this._isTrustPrompt(screen)) {
      const ready = this._findNewTabSession(pending);
      const targetPid = ready?.pid || pending.pid;
      this.pendingNewTabTrust = null;
      this.currentTarget = targetPid;
      this.lastNotifiedPid = targetPid;
      if (ready) {
        await this.wechat.reply(msg, [
          '✅ 新 tab 已就绪',
          this._formatTargetLines(ready),
          pending.taskDescription ? `任务: ${pending.taskDescription}` : '',
        ].filter(Boolean).join('\n'));
      } else {
        // 信任已过但会话还没注册：登记为待定 tab，用控制台 pid 接收后续输入
        this._registerPendingTab({ consolePid: pending.pid, cwd: pending.cwd, taskDescription: pending.taskDescription });
      }
      await this._flushNewTabLaunchNotifications(pending);
      await this._flushNewTabLaunchQueue({ queued: pending.queued, readyPid: targetPid }, { drain: true, reason: '' });
      return false;
    }

    const s = String(text || '').trim();
    if (/^(?:1|y|yes|信任|确认|同意|\/enter)$/i.test(s)) {
      await this._acceptNewTabTrust(pending, msg);
      return true;
    }

    if (/^(?:2|n|no|不信任|退出|取消|\/cancel|\/esc)$/i.test(s)) {
      await this._exitPendingNewTabTrust(pending, msg, '已退出新 tab 创建流程。');
      return true;
    }

    await this.wechat.reply(msg, [
      '⏸️ 新 tab 正在等待目录信任确认',
      '这条消息没有发送到 Claude。',
      '',
      this._formatNewTabTrustPrompt(pending),
    ].join('\n'));
    return true;
  }

  async _startPendingNewTabTrust({ pid, cwd, beforePids, taskDescription, msg, screen, launch, session = null }) {
    if (launch) launch.heldByTrust = true;
    const pending = {
      pid,
      cwd,
      beforePids,
      taskDescription,
      queued: launch?.queued || [],
      notifications: launch?.notifications || [],
      sessionPid: session?.pid || null,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    this.pendingNewTabTrust = pending;
    await this.wechat.reply(msg, [
      '🆕 已打开新 tab',
      session ? this._formatTargetLines(session) : `目录: ${cwd}`,
      taskDescription ? `任务: ${taskDescription}` : '',
      '',
      this._formatNewTabTrustPrompt(pending),
      this._screenSuffix(screen).trimStart(),
    ].filter(Boolean).join('\n'));
  }

  _formatNewTabTrustPrompt(pending) {
    return [
      '状态: Claude 正在等待目录信任确认',
      `目录: ${pending.cwd}`,
      '',
      '回复数字选择:',
      '1. 信任此目录并继续',
      '2. 不信任并退出',
      '',
      '快捷: y/yes/信任 表示 1；n/no/退出 表示 2。',
      '完成或退出前，其他微信消息不会发送到 Claude。',
    ].join('\n');
  }

  async _acceptNewTabTrust(pending, msg, { session = null, silentEnter = false } = {}) {
    try {
      await injectKey(pending.pid, 'enter');
      await new Promise(r => setTimeout(r, 900));
      session ||= await this._waitForNewSession(pending.cwd, pending.beforePids, 20000);
      if (!session) {
        const screen = await readScreen(pending.pid).catch(() => '');

        // 兜底：屏幕已不是信任界面（信任已通过、Claude 已在提示符），但仍扫描不到会话文件时，
        // 直接以新 tab 的控制台 PID 作为当前目标，保证后续输入能进终端，避免反复空按 Enter 的死循环。
        // 必须确认 screen 非空，否则读屏失败（空串）会被误判为"信任已过"。
        if (screen && !this._isTrustPrompt(screen)) {
          this.pendingNewTabTrust = null;
          this._registerPendingTab({ consolePid: pending.pid, cwd: pending.cwd, taskDescription: pending.taskDescription });
          this.currentTarget = pending.pid;
          this.lastNotifiedPid = pending.pid;
          await this.wechat.reply(msg, [
            silentEnter ? '🆕 已打开新 tab，目录信任已确认' : '✅ 已确认目录信任，新 tab 已就绪',
            `目录: ${pending.cwd}`,
            pending.taskDescription ? `任务: ${pending.taskDescription}` : '',
            '已设为当前会话，直接发消息即可（发首条后才进入 /ls）。',
            this._screenSuffix(screen),
          ].filter(Boolean).join('\n'));
          await this._flushNewTabLaunchNotifications(pending);
          await this._flushNewTabLaunchQueue({ queued: pending.queued, readyPid: pending.pid }, { drain: true, reason: '' });
          return true;
        }

        pending.expiresAt = Date.now() + 10 * 60 * 1000;
        this.pendingNewTabTrust = pending;
        await this.wechat.reply(msg, [
          silentEnter ? '⏸️ 已尝试自动确认目录信任' : '⏸️ 已确认目录信任',
          '但暂时还没有定位到新的 Claude 会话。',
          '',
          this._formatNewTabTrustPrompt(pending),
          this._screenSuffix(screen).trimStart(),
        ].filter(Boolean).join('\n'));
        return false;
      }

      this.pendingNewTabTrust = null;
      this.currentTarget = session.pid;
      this.lastNotifiedPid = session.pid;
      
      // 等待 Claude Code 完全初始化终端 UI，避免吞掉第一条（带有 context 的长文本）输入
      await new Promise(r => setTimeout(r, 2000));
      const screen = await readScreen(session.pid).catch(() => '');
      await this.wechat.reply(msg, [
        silentEnter ? '🆕 已打开新 tab，并已确认目录信任' : '✅ 已确认目录信任，新 tab 已就绪',
        this._formatTargetLines(session),
        pending.taskDescription ? `任务: ${pending.taskDescription}` : '',
        this._screenSuffix(screen),
      ].filter(Boolean).join('\n'));

      await this._flushNewTabLaunchNotifications(pending);
      await this._flushNewTabLaunchQueue({ queued: pending.queued, readyPid: session.pid }, { drain: true, reason: '' });
      return true;
    } catch (e) {
      this.pendingNewTabTrust = pending;
      await this.wechat.reply(msg, `❌ 确认目录信任失败\n原因: ${e.message}`);
      return false;
    }
  }

  async _exitPendingNewTabTrust(pending, msg, reason) {
    try {
      await injectKey(pending.pid, 'esc');
    } catch {}
    this.pendingNewTabTrust = null;
    await this._flushNewTabLaunchQueue({ queued: pending.queued }, { drain: false, reason });
    await this.wechat.reply(msg, [
      `✅ ${reason}`,
      `目录: ${pending.cwd}`,
      '现在可以继续其他操作。',
    ].join('\n'));
  }

  async _flushNewTabLaunchQueue(launch, { drain, reason }) {
    if (!launch?.queued?.length) return;

    if (!drain) {
      for (const item of launch.queued) {
        this._queueWechatFiles(item.wechatFiles);
      }
      const last = launch.queued[launch.queued.length - 1];
      await this.wechat.reply(last.msg, [
        '⏸️ 暂存消息未发送',
        `原因: ${reason || '新 tab 未就绪'}`,
        `数量: ${launch.queued.length} 条`,
        '下一步: 处理完成后请重发。',
      ].join('\n'));
      return;
    }

    for (const item of launch.queued) {
      await this._handleReply(item.text, item.msg, {
        targetPid: launch.readyPid,
        skipDisambiguation: true,
        wechatFiles: item.wechatFiles,
      });
    }
  }

  async _flushNewTabLaunchNotifications(launch) {
    if (!launch?.notifications?.length) return;

    for (const item of launch.notifications) {
      this._applyNotifyState(item.data);
      const text = [
        '🔕 启动期间收到一条 Claude 通知，已延后推送',
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

  async _askTargetChoice(text, msg, wechatFiles = []) {
    const candidates = this._getPendingNotificationCandidates();
    this.pendingTargetChoice = {
      originalText: text,
      wechatFiles,
      candidates,
      expiresAt: Date.now() + 30 * 1000,
    };
    await this.wechat.reply(msg, this._formatTargetChoicePrompt(candidates));
  }

  _formatTargetChoicePrompt(candidates, prefix = '多个会话都有未回复通知，请选择要发送到哪个会话：') {
    const lines = ['⚠️ 需要选择目标会话', prefix, ''];
    candidates.forEach((item, index) => {
      const age = Math.max(0, Math.round((Date.now() - item.notifiedAt) / 1000));
      lines.push(`[${index + 1}] ${item.project || '未知项目'} (${age}s 前)`);
      lines.push(`目录: ${item.cwd || '未知目录'}`);
      lines.push(`PID: ${item.pid}`);
      if (item.source && item.source !== '.claude') lines.push(`来源: ${item.source}`);
      if (index < candidates.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('回复序号后，会把刚才那条消息发送到所选会话。发送 /cancel 取消。');
    return lines.join('\n');
  }

  _recordNotification(data) {
    const now = Date.now();
    const item = {
      pid: data.pid,
      project: data.project || '',
      cwd: data.cwd || '',
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
        cwd: item.cwd || session.cwd,
      });
    }

    return candidates.sort((a, b) => (b.notifiedAt - a.notifiedAt) || (b.seq - a.seq));
  }

  _markSessionAnswered(pid) {
    this.pendingNotificationSessions.delete(pid);
  }

  _formatPresenceDetail(state) {
    if (!state) return '';
    const parts = [];
    if (state.wtsOk) parts.push(`WTS=${state.sessionFlags}`);
    if (state.desktopName) parts.push(`桌面=${state.desktopName}`);
    if (state.displayTimeoutSeconds) parts.push(`息屏=${state.displayTimeoutSeconds}s`);
    return parts.length ? `检测: ${parts.join(' ')}` : '';
  }

  _noActiveSessionMessage() {
    return [
      '⚠️ 当前没有活跃的 Claude Code 会话',
      '下一步: 发送 /new 创建新 tab，或先在本机启动 Claude Code。',
    ].join('\n');
  }

  _formatTargetLines(session) {
    return [
      `会话: ${session.project || '未知项目'}`,
      `目录: ${session.cwd || '未知目录'}`,
    ].join('\n');
  }

  _formatSessionListItem(session, index, isCurrent) {
    const updated = this._formatUpdatedAt(session.updatedAt);
    const lines = [
      `[${index}] ${session.project || '未知项目'}`,
      `目录: ${session.cwd || '未知目录'}`,
      `PID: ${session.pid}`,
      this._statusText(session.status),
    ];
    if (session.source && session.source !== '.claude') lines.push(`来源: ${session.source}`);
    if (updated) lines.push(`更新: ${updated}`);
    return lines;
  }

  _statusText(status = '') {
    const s = String(status).toLowerCase();
    if (s === 'idle') return '状态: 🟢 空闲';
    if (s === 'busy' || s === 'running') return '状态: 🟡 运行中';
    if (s === 'error') return '状态: 🔴 异常';
    if (s === 'pending') return '状态: 🆕 新建·待首条消息';
    return `状态: ⚪ ${status || '未知'}`;
  }

  _formatUpdatedAt(value) {
    const n = Number(value);
    if (!n) return '';
    const ms = n < 1e12 ? n * 1000 : n;
    try {
      return new Date(ms).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
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

    const candidate = this._resolvePathArg(value, baseCwd);
    if (this._isDirectory(candidate)) {
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
      await this.wechat.reply(msg, '✅ 已取消新 tab 目录选择。');
      return true;
    }

    if (pending.mode === 'create') {
      if (/^(?:1|y|yes|是|创建|确认)$/i.test(s)) {
        try {
          mkdirSync(pending.candidatePath, { recursive: true });
        } catch (e) {
          await this.wechat.reply(msg, `❌ 创建目录失败\n路径: ${pending.candidatePath}\n原因: ${e.message}`);
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
        await this.wechat.reply(msg, this._formatNewDirGuide('✅ 已返回目录选择。'));
        return true;
      }

      await this.wechat.reply(msg, this._formatCreateDirPrompt(pending, '⚠️ 请回复 1 创建，或 2 返回。'));
      return true;
    }

    pending.expiresAt = Date.now() + 3 * 60 * 1000;
    pending.page = pending.page || 0;

    const allChildren = this._listChildDirectories(pending.currentDir);
    const totalPages = Math.max(1, Math.ceil(allChildren.length / NEW_DIR_PAGE_SIZE));

    if (/^(?:n|next|下一页|下页)$/.test(s)) {
      if (pending.page >= totalPages - 1) {
        await this.wechat.reply(msg, this._formatNewDirGuide('ℹ️ 已经是最后一页。'));
        return true;
      }
      pending.page += 1;
      await this.wechat.reply(msg, this._formatNewDirGuide());
      return true;
    }

    if (/^(?:p|prev|previous|上一页|上页)$/.test(s)) {
      if (pending.page <= 0) {
        await this.wechat.reply(msg, this._formatNewDirGuide('ℹ️ 已经是第一页。'));
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

    await this.wechat.reply(msg, this._formatNewDirGuide('⚠️ 没有识别这条目录选择。请回复序号、0、..，或 c 名称 创建目录。'));
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
    lines.push(`.. 返回上一级: ${dirname(pending.currentDir)}`);
    children.forEach((child, index) => {
      lines.push(`${index + 1}. ${child.name}`);
    });
    lines.push('');
    lines.push('操作: 序号进入目录。');
    lines.push('回复 0 使用当前目录。');
    if (totalPages > 1) lines.push('翻页: 下一页 / 上一页。');
    lines.push('创建: c 名称。');
    lines.push('跳转: 直接发目录名或路径。');
    lines.push('取消: 发送 /cancel。');
    return lines.join('\n');
  }

  _formatCreateDirPrompt(pending, prefix = '') {
    return [
      prefix,
      '📁 目录不存在，是否创建？',
      `路径: ${pending.candidatePath}`,
      pending.taskDescription ? `任务: ${pending.taskDescription}` : '',
      '',
      '回复数字选择:',
      '1. 创建并新开 tab',
      '2. 返回目录选择',
      '',
      '取消: 发送 /cancel。',
    ].filter(Boolean).join('\n');
  }

  _listChildDirectories(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.'))
        .filter(entry => !HIDDEN_OR_NOISY_DIRS.has(entry.name))
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

  async _waitForNewSessionOrTrust(cwd, beforePids, consolePid, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let lastScreen = '';
    let nextScreenReadAt = 0;
    while (Date.now() < deadline) {
      const session = this._findNewSession(cwd, beforePids);
      if (session) return { session, screen: '' };

      if (consolePid && Date.now() >= nextScreenReadAt) {
        nextScreenReadAt = Date.now() + 700;
        lastScreen = await readScreen(consolePid).catch(() => '');
        if (this._isTrustPrompt(lastScreen)) {
          return { session: null, trustPrompt: true, screen: lastScreen };
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return { session: null, trustPrompt: this._isTrustPrompt(lastScreen), screen: lastScreen };
  }

  async _waitForNewSession(cwd, beforePids, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = this._findNewSession(cwd, beforePids);
      if (session) return session;
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }

  _findNewTabSession(pending) {
    if (pending?.sessionPid) {
      const session = this.sessions.findByPid(pending.sessionPid);
      if (session) return session;
    }
    return this._findNewSession(pending.cwd, pending.beforePids || new Set());
  }

  _findNewSession(cwd, beforePids) {
    const list = this.sessions.listActive();
    const fresh = list.find(s => !beforePids.has(s.pid) && this._samePath(s.cwd, cwd));
    if (fresh) return fresh;
    const byCwd = list.find(s => this._samePath(s.cwd, cwd));
    if (byCwd && !beforePids.has(byCwd.pid)) return byCwd;
    return null;
  }

  _samePath(a, b) {
    // 归一化所有斜杠（\ 与 / 混用）、去尾斜杠、忽略大小写，
    // 否则新会话的 cwd（如 D:/x）与待匹配的 cwd（如 D:\x）会比不相等，导致定位失败。
    const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
  }

  _isTrustPrompt(screen = '') {
    return /Quick safety check|I trust this folder|Accessing workspace|Claude Code'll be able to read/i.test(screen);
  }

  // ── 目标会话解析 ──

  _resolveTarget() {
    const list = this.sessions.listActive();
    this._reconcilePendingTabs(list);

    if (!list.length && !this.pendingTabs.length) return null;

    // 1. 最近推送过通知的（已注册会话优先，其次待定 tab）
    if (this.lastNotifiedPid) {
      const s = list.find(s => s.pid === this.lastNotifiedPid);
      if (s) return s;
      const t = this.pendingTabs.find(t => t.consolePid === this.lastNotifiedPid);
      if (t) return this._pendingTabToSession(t);
    }

    // 2. 手动选中的
    if (this.currentTarget) {
      const s = list.find(s => s.pid === this.currentTarget);
      if (s) return s;
      const t = this.pendingTabs.find(t => t.consolePid === this.currentTarget);
      if (t) return this._pendingTabToSession(t);
    }

    // 3. updatedAt 最近的已注册会话；都没有则用最近的待定 tab
    if (list.length) return list[0];
    return this._pendingTabToSession(this.pendingTabs[this.pendingTabs.length - 1]);
  }

  /** 已注册会话 + 尚未注册的待定 tab，构成可被 /ls、/to 选择的完整目标列表 */
  _targetableList() {
    const list = this.sessions.listActive();
    this._reconcilePendingTabs(list);
    return [...list, ...this.pendingTabs.map(t => this._pendingTabToSession(t))];
  }

  /** 记录一个本桥接开启、尚未注册的新 tab（按控制台 pid 去重） */
  _registerPendingTab({ consolePid, cwd, taskDescription }) {
    if (!consolePid) return;
    this.pendingTabs = this.pendingTabs.filter(t => t.consolePid !== consolePid);
    this.pendingTabs.push({
      consolePid,
      cwd: cwd || '',
      taskDescription: taskDescription || '',
      createdAt: Date.now(),
    });
  }

  /** 把待定 tab 包装成与会话同构的对象（pid 即控制台 pid，可直接注入） */
  _pendingTabToSession(t) {
    return {
      pid: t.consolePid,
      cwd: t.cwd,
      project: t.cwd ? t.cwd.split(/[/\\]/).filter(Boolean).pop() || '' : '',
      status: 'pending',
      source: '新建',
      kind: 'interactive',
      updatedAt: t.createdAt,
      isPending: true,
    };
  }

  /** 清理失效待定 tab：控制台进程已退出、超时、或对应 cwd 已出现真实会话（首轮后注册） */
  _reconcilePendingTabs(activeList) {
    if (!this.pendingTabs.length) return;
    const list = activeList || this.sessions.listActive();
    const TTL_MS = 30 * 60 * 1000;
    this.pendingTabs = this.pendingTabs.filter(t => {
      if (!this._isPidAlive(t.consolePid)) return false;
      if (Date.now() - t.createdAt > TTL_MS) return false;
      const real = list.find(s => this._samePath(s.cwd, t.cwd));
      if (real) {
        // 真实会话已注册：把指向控制台 pid 的目标升级为真实会话 pid
        if (this.currentTarget === t.consolePid) this.currentTarget = real.pid;
        if (this.lastNotifiedPid === t.consolePid) this.lastNotifiedPid = real.pid;
        return false;
      }
      return true;
    });
  }

  _isPidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  /** 清理已退出会话在各状态容器中的残留条目 */
  _runJanitor() {
    try {
      const now = Date.now();
      const list = this.sessions.listActive();
      this._reconcilePendingTabs(list);

      const alivePids = new Set([
        ...list.map(s => s.pid),
        ...this.pendingTabs.map(t => t.consolePid),
      ]);
      // capabilityInjectionState 的键是 sessionId || String(pid)（见 _appendCapabilityContext）
      const aliveKeys = new Set();
      for (const s of list) {
        if (s.sessionId) aliveKeys.add(s.sessionId);
        aliveKeys.add(String(s.pid));
      }
      for (const t of this.pendingTabs) aliveKeys.add(String(t.consolePid));

      for (const key of this.capabilityInjectionState.keys()) {
        if (!aliveKeys.has(key)) this.capabilityInjectionState.delete(key);
      }
      for (const [pid, pending] of this.pendingInteractions.entries()) {
        if (pending.expiresAt < now || !alivePids.has(pid)) this.pendingInteractions.delete(pid);
      }
      for (const pid of this.pendingNotificationSessions.keys()) {
        if (!alivePids.has(pid)) this.pendingNotificationSessions.delete(pid);
      }
      this._prunePendingWechatFiles(now);
    } catch (e) {
      console.error('状态清理失败:', e.message);
    }
  }

  _appendCapabilityContext(text, target, { choiceLike = false, forcePlainInput = false } = {}) {
    if (forcePlainInput || choiceLike) return text;

    const capabilitySet = getActiveCapabilitySet();
    if (!capabilitySet) return text;

    const sessionKey = target.sessionId || String(target.pid);
    const state = this.capabilityInjectionState.get(sessionKey) || {
      lastInjectedAt: 0,
      messagesSinceInject: 0,
      capabilitiesHash: '',
    };

    state.messagesSinceInject += 1;

    const now = Date.now();
    const minMessages = Math.max(1, Number(capabilitySet.config.minIntervalMessages || 6));
    const minMinutes = Math.max(1, Number(capabilitySet.config.minIntervalMinutes || 30));
    const intervalMs = minMinutes * 60 * 1000;
    const capabilitiesChanged = state.capabilitiesHash !== capabilitySet.hash;
    const firstInject = !state.lastInjectedAt;
    const intentInject = hasFileSendIntent(text) && (
      state.messagesSinceInject > 1 || now - state.lastInjectedAt > 60 * 1000
    );
    const periodicInject = state.messagesSinceInject >= minMessages
      || now - state.lastInjectedAt >= intervalMs;

    if (firstInject || capabilitiesChanged || intentInject || periodicInject) {
      state.lastInjectedAt = now;
      state.messagesSinceInject = 0;
      state.capabilitiesHash = capabilitySet.hash;
      this.capabilityInjectionState.set(sessionKey, state);
      return `${text}\n\n${buildCapabilityContext(capabilitySet.capabilities)}`;
    }

    this.capabilityInjectionState.set(sessionKey, state);
    return text;
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

  async _resolvePermissionShortcutFromScreen(text, pid) {
    if (!isPermissionShortcut(text)) return null;

    let screen = '';
    try {
      screen = await readScreen(pid);
    } catch {
      return null;
    }
    if (!isPermissionLikeScreen(screen)) return null;

    const interaction = normalizeInteraction({
      event: 'Notification',
      screenText: screen,
    });
    if (interaction?.type !== 'tool_permission') return null;

    this.pendingInteractions.set(pid, {
      interaction,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return resolveQuickReply(text, interaction);
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

function parsePassthroughInput(text) {
  const s = String(text || '').trim();
  if (s.length < 2 || !s.startsWith('<') || !s.endsWith('>')) return null;
  return s.slice(1, -1);
}

function appendWechatFilesContext(text, files) {
  const lines = [
    text,
    '',
    '<cc-wechat-files>',
    'source=wechat',
    'note=The user sent the following file(s) via WeChat. Use the local absolute paths when relevant.',
  ];
  for (const file of files) {
    lines.push(
      `<file path="${escapeXmlAttr(file.path)}" name="${escapeXmlAttr(file.name || '')}" kind="${escapeXmlAttr(file.kind || 'file')}" size="${Number(file.size) || 0}" />`,
    );
  }
  lines.push('</cc-wechat-files>');
  return lines.join('\n');
}

function dedupeWechatFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    const key = String(file?.path || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function formatUnhandledWechatItems(items) {
  return items.slice(0, 5).map((item, index) => {
    const parts = [
      `#${index + 1}`,
      `type=${item.type}`,
      item.fileName ? `name=${item.fileName}` : '',
      `hasParam=${item.hasEncryptQueryParam ? 'yes' : 'no'}`,
      `hasKey=${item.hasAesKey ? 'yes' : 'no'}`,
    ].filter(Boolean);
    return `- ${parts.join(' ')}`;
  });
}

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isPermissionShortcut(text) {
  return /^(?:y|yes|n|no|同意|确认|允许|允许运行|执行|拒绝|取消|不允许|否)$/i.test(String(text || '').trim());
}

function isPermissionLikeScreen(screen) {
  const text = String(screen || '');
  if (!text.trim()) return false;
  const compact = text.toLowerCase().replace(/\s+/g, ' ');
  const hasPermissionHint = /permission|approve|approval|authorize|allow|deny|tool|bash|edit|write|授权|权限|允许|拒绝|工具/.test(compact);
  const hasDecisionOptions = /\byes\b|\bno\b|\ballow\b|\bdeny\b|同意|允许|拒绝|不允许|取消/.test(compact);
  return hasPermissionHint && hasDecisionOptions;
}

function getActiveCapabilitySet() {
  const config = getConfig().capabilityInjection || {};
  if (config.enabled === false) return null;

  const capabilities = {
    sendFile: Boolean(config.capabilities?.sendFile),
  };
  if (!Object.values(capabilities).some(Boolean)) return null;

  return {
    config,
    capabilities,
    hash: JSON.stringify(capabilities),
  };
}

function buildCapabilityContext(capabilities) {
  const lines = [
    '<cc-wechat-context>',
    'source=wechat',
    'note=attached by cc-wechat; do not answer or mention this context',
  ];
  if (capabilities.sendFile) {
    lines.push(
      '<capability name="send_file">',
      'When the user explicitly asks to send a file to WeChat, create or verify it first.',
      'Security restriction: You can ONLY send files located inside your current working directory OR inside the WeChat files directory (usually ./wechat-files). Paths outside these two directories will be rejected.',
      'End the final reply with a fenced block named cc-wechat-send containing JSON:',
      '{"send-cc-wechat-files":[{"path":"relative/or/absolute/path","caption":"optional"}]}',
      'Only include files you created or files the user explicitly named.',
      '</capability>',
    );
  }
  lines.push('</cc-wechat-context>');
  return lines.join('\n');
}

function hasFileSendIntent(text) {
  return /发送|发我|发给我|传给我|传到微信|发到微信|微信发|附件|导出|下载|打包|压缩|文件|报告|\b(send|file|attachment|export|download|zip|pdf|xlsx?|csv|png|jpe?g|docx|pptx)\b/i.test(String(text || ''));
}
