// notify.js — 监听 hook 通知文件 → 推送微信
import { watch, readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { get as getConfig } from './config.js';

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

      // 格式化并推送微信
      const text = this._format(data);
      await this.wechat.push(text);

      // 通知 bridge 更新 lastNotifiedPid
      this.onNotify?.(data);

      console.log(`📤 通知已推送: ${data.event} [${data.project}]`);
    } catch (e) {
      console.error('处理通知文件出错:', e.message);
    } finally {
      // 无论成功与否都删除文件
      try { unlinkSync(filePath); } catch {}
      this._processing.delete(filePath);
    }
  }

  _format(d) {
    const isNotif = d.event === 'Notification';
    const lines = [];

    if (isNotif) {
      lines.push(`🔔 [${d.project || '未知项目'}] 需要你的操作`);
      lines.push(`❓ ${d.action}`);
    } else {
      lines.push(`✅ [${d.project || '未知项目'}] 执行完毕`);
    }

    if (d.title) lines.push(`📋 ${d.title}`);
    if (d.prompt) lines.push(`💬 提示: ${d.prompt}`);

    if (d.lastReply) {
      lines.push(`📄 回复: ${d.lastReply}`);
      
      // 增加友好的操作指引
      if (d.lastReply.includes('❓ 问题:')) {
        lines.push(`\n💡 提示：直接回复文本即可回答问题。如果是 TUI 菜单，请使用 /up, /down 等指令交互。`);
      } else if (d.lastReply.includes('🛡️ 请求授权工具:')) {
        lines.push(`\n💡 提示：回复 y 同意执行，回复 n 拒绝，或使用 /perm 切换焦点`);
      }
    }

    if (d.screenText) {
      lines.push(`\n📺 当前终端界面：\n${d.screenText}`);
    }

    if (d.source || d.claudeDir) {
      const src = d.source || d.claudeDir?.split(/[/\\]/).pop() || '';
      if (src && src !== '.claude') lines.push(`📁 来源: ${src}`);
    }

    return lines.join('\n');
  }
}
