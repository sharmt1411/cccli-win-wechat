// session.js — Claude Code 会话管理
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { get as getConfig } from './config.js';

const ACTIVE_CACHE_TTL_MS = 500;

export class SessionManager {
  constructor() {
    this._dirs = getConfig().claudeDirs || [];
    this._cachedActive = null;
    this._cachedActiveAt = 0;
  }

  /** 扫描所有配置目录的活跃会话（500ms 缓存，降低高频调用开销） */
  listActive() {
    const now = Date.now();
    if (this._cachedActive && now - this._cachedActiveAt < ACTIVE_CACHE_TTL_MS) {
      return this._cachedActive;
    }

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
          if (!isCliSession(data)) continue;
          // 检查进程是否还活着
          if (!isProcessAlive(data.pid)) continue;
          sessions.push({
            pid: data.pid,
            sessionId: data.sessionId,
            cwd: data.cwd || '',
            project: data.cwd ? basename(data.cwd) : '',
            name: data.name || '',  // Claude Code tab 名称（用户命名的 session 标题）
            status: data.status || 'unknown',
            updatedAt: data.updatedAt || 0,
            version: data.version || '',
            kind: data.kind || '',
            entrypoint: data.entrypoint || '',
            claudeDir: dir,
            source,
          });
        } catch { /* 跳过损坏文件 */ }
      }
    }
    const result = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this._cachedActive = result;
    this._cachedActiveAt = Date.now();
    return result;
  }

  /** 主动清除缓存（在外部感知到会话变化时调用） */
  invalidateCache() {
    this._cachedActive = null;
    this._cachedActiveAt = 0;
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

  /** 获取当前会话最后一条用户消息（去除微信注入的 cc-wechat-context 信息） */
  getLastUserMessage(session) {
    if (!session.sessionId || !session.claudeDir) return null;
    const projectKey = cwdToProjectKey(session.cwd);
    const jsonlPath = join(session.claudeDir, 'projects', projectKey, `${session.sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return null;

    try {
      const content = readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');
      // 从后往前找最后一条 user 消息
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"user"')) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'user' && obj.message?.role === 'user') {
            const text = extractUserText(obj.message.content);
            if (text) return text;
          }
        } catch { continue; }
      }
    } catch { /* 文件读取失败 */ }
    return null;
  }
}

export function isCliSession(data) {
  return String(data?.entrypoint || '').toLowerCase() === 'cli';
}

// cwd to projectKey: D:\projects\cc-wechat -> D--projects-cc-wechat
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

/** 提取 user 消息文本并去除微信注入的 cc-wechat-context / cc-wechat-files 信息 */
function extractUserText(content) {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  } else {
    text = String(content || '');
  }
  // 去除微信渠道注入的上下文标签块（cc-wechat-context、cc-wechat-files）
  text = text
    .replace(/\s*<cc-wechat-context\b[^>]*>[\s\S]*?<\/cc-wechat-context>\s*/gi, '')
    .replace(/\s*<cc-wechat-files\b[^>]*>[\s\S]*?<\/cc-wechat-files>\s*/gi, '')
    .trim();
  return text || null;
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
