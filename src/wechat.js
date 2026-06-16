// wechat.js — iLink Bot API 协议封装
import { saveWechat, get as getConfig } from './config.js';

function randomUin() {
  const n = (Math.random() * 0xFFFFFFFF) >>> 0;
  return Buffer.from(String(n)).toString('base64');
}

function headers(token) {
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export class WeChatBot {
  constructor() {
    const cfg = getConfig().wechat;
    this.baseUrl = cfg.baseUrl || 'https://ilinkai.weixin.qq.com';
    this.token = cfg.botToken || '';
    this.buf = cfg.getUpdatesBuf || '';
    this.ownerUserId = cfg.ownerUserId || '';
    this.lastContextToken = cfg.lastContextToken || '';
    this._polling = false;
  }

  async _fetch(path, opts = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: headers(this.token),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  // ── 登录 ──

  async getQrCode() {
    return this._fetch('/ilink/bot/get_bot_qrcode?bot_type=3');
  }

  async getQrCodeStatus(qrcode) {
    return this._fetch(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
  }

  async login() {
    const qr = await this.getQrCode();
    // 动态 import qrcode-terminal（仅登录时用）
    const qrt = await import('qrcode-terminal');

    // 尝试多种可能的 URL 字段
    const qrUrl = qr.url || qr.qrcode_url || qr.qrcode_img_url;
    if (qrUrl) {
      qrt.default.generate(qrUrl, { small: true });
    } else if (qr.qrcode_img_content) {
      // 如果是 base64 图片，提示用户手动扫码
      console.log('请用微信扫描以下二维码（base64 图片，保存后扫码）：');
      console.log(qr.qrcode_img_content.substring(0, 200) + '...');
    } else {
      console.log('二维码数据：', JSON.stringify(qr, null, 2));
    }

    console.log('\n等待微信扫码...');
    const qrId = qr.qrcode;

    while (true) {
      await sleep(1500);
      try {
        const status = await this.getQrCodeStatus(qrId);
        if (status.status === 'confirmed' || status.bot_token) {
          this.token = status.bot_token;
          if (status.baseurl) this.baseUrl = status.baseurl;
          saveWechat({
            botToken: this.token,
            baseUrl: this.baseUrl,
          });
          console.log('✅ 登录成功');
          return;
        }
        if (status.status === 'expired') {
          throw new Error('二维码已过期，请重新运行');
        }
      } catch (e) {
        if (e.message.includes('过期')) throw e;
        // 网络错误继续重试
      }
    }
  }

  // ── 长轮询收消息 ──

  async startPolling(onMessage) {
    this._polling = true;
    console.log('📡 开始微信消息轮询...');

    while (this._polling) {
      try {
        const data = await this._fetch('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: this.buf,
            base_info: { channel_version: '1.0.2' },
          }),
        });

        if (data.get_updates_buf) {
          this.buf = data.get_updates_buf;
          saveWechat({ getUpdatesBuf: this.buf });
        }

        if (data.msgs?.length) {
          for (const msg of data.msgs) {
            // 只处理用户发来的消息 (message_type=1)
            if (msg.message_type !== 1) continue;

            // 锁定 owner
            if (!this.ownerUserId) {
              this.ownerUserId = msg.from_user_id;
              saveWechat({ ownerUserId: this.ownerUserId });
              console.log('🔒 绑定用户:', this.ownerUserId);
            }

            // 只响应 owner
            if (msg.from_user_id !== this.ownerUserId) continue;

            // 缓存 context_token
            if (msg.context_token) {
              this.lastContextToken = msg.context_token;
              saveWechat({ lastContextToken: msg.context_token });
            }

            try {
              await onMessage(msg);
            } catch (e) {
              console.error('处理消息出错:', e.message);
            }
          }
        }
      } catch (e) {
        console.error('轮询出错:', e.message);
        await sleep(3000);
      }
    }
  }

  stopPolling() {
    this._polling = false;
  }

  // ── 发送消息 ──

  async send(toUserId, contextToken, text) {
    // 长文本分段（微信单条消息限制）
    const chunks = splitText(text, 2000);
    for (const chunk of chunks) {
      await this._fetch('/ilink/bot/sendmessage', {
        method: 'POST',
        body: JSON.stringify({
          msg: {
            to_user_id: toUserId,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
        }),
      });
    }
  }

  /** 主动推送（用缓存的 context_token） */
  async push(text) {
    if (!this.ownerUserId) {
      console.warn('⚠️ 尚未绑定用户，无法推送');
      return;
    }
    await this.send(this.ownerUserId, this.lastContextToken || '', text);
  }

  /** 回复用户消息 */
  async reply(msg, text) {
    await this.send(msg.from_user_id, msg.context_token || this.lastContextToken || '', text);
  }
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.substring(i, i + maxLen));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
