// session.js — Claude Code 会话管理
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { get as getConfig } from './config.js';

export class SessionManager {
  constructor() {
    this._dirs = getConfig().claudeDirs || [];
  }

  /** 扫描所有配置目录的活跃会话 */
  listActive() {
    const sessions = [];
    for (const dir of this._dirs) {
      const sessDir = join(dir, 'sessions');
      if (!existsSync(sessDir)) continue;
      const source = basename(dir); // ".claude" / ".claude-any"

      let files;
      try { files = readdirSync(sessDir); } catch { continue; }

      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = readFileSync(join(sessDir, f), 'utf-8');
          const data = JSON.parse(raw);
          // 检查进程是否还活着
          if (!isProcessAlive(data.pid)) continue;
          sessions.push({
            pid: data.pid,
            sessionId: data.sessionId,
            cwd: data.cwd || '',
            project: data.cwd ? basename(data.cwd) : '',
            status: data.status || 'unknown',
            updatedAt: data.updatedAt || 0,
            version: data.version || '',
            claudeDir: dir,
            source,
          });
        } catch { /* 跳过损坏文件 */ }
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 按 PID 查找会话 */
  findByPid(pid) {
    return this.listActive().find(s => s.pid === pid) || null;
  }

  /** 按 sessionId 查找会话 */
  findBySessionId(sessionId) {
    return this.listActive().find(s => s.sessionId === sessionId) || null;
  }

  /** 获取当前会话最后一条 assistant 回复 */
  getLastAssistantMessage(session) {
    const projectKey = cwdToProjectKey(session.cwd);
    const jsonlPath = join(session.claudeDir, 'projects', projectKey, `${session.sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return null;

    try {
      const content = readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');
      // 从后往前找最后一条 assistant 消息
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
            return extractAssistantText(obj.message.content);
          }
        } catch { continue; }
      }
    } catch { /* 文件读取失败 */ }
    return null;
  }
}

/** cwd 转 projectKey: D:\projects\cc-wechat → D--projects-cc-wechat */
function cwdToProjectKey(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[:/\\]/g, '-').replace(/^-/, '');
}

/** 提取 assistant 消息文本 */
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(content);
}

/** 检查进程是否存活 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
