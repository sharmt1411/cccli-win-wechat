// wechat.js — iLink Bot API 协议封装
import { saveWechat, get as getConfig } from './config.js';

import { EventEmitter } from 'node:events';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '1.0.2';
const MESSAGE_ITEM_FILE = 4;
const UPLOAD_MEDIA_FILE = 3;
const CDN_UPLOAD_MAX_RETRIES = 3;

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

export class WeChatBot extends EventEmitter {
  constructor() {
    super();
    const cfg = getConfig().wechat;
    this.baseUrl = cfg.baseUrl || 'https://ilinkai.weixin.qq.com';
    this.token = cfg.botToken || '';
    this.buf = cfg.getUpdatesBuf || '';
    this.ownerUserId = cfg.ownerUserId || '';
    this.lastContextToken = cfg.lastContextToken || '';
    this._polling = false;
  }

  async _fetch(path, opts = {}, timeoutMs = 45000) {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts,
        headers: headers(this.token),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${url} body=${body.substring(0, 200)}`);
      }
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
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

    // 触发 qrcode 事件，交由外部（GUI 或 CLI）处理
    this.emit('qrcode', qr);

    const qrId = qr.qrcode;

    while (true) {
      await sleep(1500);
      try {
        const status = await this.getQrCodeStatus(qrId);
        this.emit('qrcode-status', status);

        if (status.status === 'confirmed' || status.bot_token) {
          this.token = status.bot_token;
          if (status.baseurl) this.baseUrl = status.baseurl;
          saveWechat({
            botToken: this.token,
            baseUrl: this.baseUrl,
          });
          this.emit('login');
          return;
        }
        if (status.status === 'expired') {
          this.emit('qrcode-expired');
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

    let pollCount = 0;
    while (this._polling) {
      try {
        pollCount++;
        console.log(`📡 轮询 #${pollCount} 发送中... (buf=${this.buf ? this.buf.substring(0,20)+'...' : '空'})`);
        const data = await this._fetch('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: this.buf,
            base_info: { channel_version: CHANNEL_VERSION },
          }),
        });
        console.log(`📡 轮询 #${pollCount} 返回: ret=${data.ret} msgs=${data.msgs?.length || 0}`);

        // 首次轮询打印完整响应
        if (pollCount === 1) {
          console.log('首次响应:', JSON.stringify(data, null, 2).substring(0, 1000));
        }

        if (data.get_updates_buf) {
          this.buf = data.get_updates_buf;
          saveWechat({ getUpdatesBuf: this.buf });
        }

        if (data.msgs?.length) {
          console.log(`📨 收到 ${data.msgs.length} 条消息`);
          for (const msg of data.msgs) {
            const text = msg.item_list?.[0]?.text_item?.text || '';
            console.log(`  ├ type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id?.substring(0,20)}... text="${text.substring(0,50)}"`);
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

  async _sendMessageItems(toUserId, contextToken, itemList, { logLabel = '消息' } = {}) {
    const clientId = `cc-wechat:${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const result = await this._fetch('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: itemList,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    });
    if (typeof result?.ret === 'number' && result.ret !== 0) {
      throw new Error(`sendmessage ret=${result.ret} errcode=${result.errcode ?? ''} errmsg=${result.errmsg ?? ''}`);
    }
    console.log(`📤 ${logLabel}发送结果:`, JSON.stringify(result).substring(0, 200));
    return result;
  }

  async send(toUserId, contextToken, text) {
    const chunks = splitText(text, 2000);
    for (const chunk of chunks) {
      console.log(`📤 发送中... to=${toUserId?.substring(0,20)}... ctx=${contextToken ? '有' : '无'} len=${chunk.length}`);
      try {
        await this._sendMessageItems(
          toUserId,
          contextToken,
          [{ type: 1, text_item: { text: chunk } }],
        );
      } catch (e) {
        console.error(`📤 发送失败:`, e.message);
        throw e;
      }
    }
  }

  async _getUploadURL(toUserId, fileData, mediaType, aesKey, filekey) {
    const rawSize = fileData.length;
    const result = await this._fetch('/ilink/bot/getuploadurl', {
      method: 'POST',
      body: JSON.stringify({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: md5Hex(fileData),
        filesize: aesEcbPaddedSize(rawSize),
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    });
    if (typeof result?.ret === 'number' && result.ret !== 0) {
      throw new Error(`getuploadurl ret=${result.ret} errcode=${result.errcode ?? ''} errmsg=${result.errmsg ?? ''}`);
    }
    if (!String(result?.upload_param || '').trim() && !String(result?.upload_full_url || '').trim()) {
      throw new Error(`getuploadurl missing upload URL: ${JSON.stringify(result).substring(0, 200)}`);
    }
    return result;
  }

  async _uploadToWeixinCDN(toUserId, fileData, mediaType, label) {
    if (!fileData?.length) throw new Error(`${label}: empty file`);

    const aesKey = randomBytes(16);
    const filekey = randomHex(16);
    const upload = await this._getUploadURL(toUserId, fileData, mediaType, aesKey, filekey);
    const uploadUrl = upload.upload_full_url
      || buildCdnUploadURL(getConfig().wechat?.cdnBaseUrl || DEFAULT_CDN_BASE_URL, upload.upload_param, filekey);
    const downloadParam = await this._uploadBufferToCDN(uploadUrl, fileData, aesKey, label);

    return {
      downloadParam,
      aesKey,
      cipherSize: aesEcbPaddedSize(fileData.length),
      rawSize: fileData.length,
    };
  }

  async _uploadBufferToCDN(uploadUrl, fileData, aesKey, label) {
    const ciphertext = encryptAesEcb(fileData, aesKey);
    let lastError = null;

    for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60000);
      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ciphertext,
          signal: ac.signal,
        });
        clearTimeout(timer);

        if (res.status >= 400 && res.status < 500) {
          const msg = res.headers.get('x-error-message') || await res.text().catch(() => res.statusText);
          throw new Error(`${label}: CDN upload client error ${res.status}: ${msg}`);
        }
        if (res.status !== 200) {
          const msg = res.headers.get('x-error-message') || res.statusText || `status ${res.status}`;
          lastError = new Error(`${label}: CDN upload server error: ${msg}`);
          continue;
        }

        const encryptedParam = res.headers.get('x-encrypted-param');
        if (!encryptedParam) {
          lastError = new Error(`${label}: CDN response missing x-encrypted-param`);
          continue;
        }
        return encryptedParam;
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        if (!String(e.message || '').includes('server error')) break;
      }
    }

    throw lastError || new Error(`${label}: CDN upload failed`);
  }

  async sendFile(toUserId, contextToken, filePath, { caption = '' } = {}) {
    const stat = statSync(filePath);
    const maxBytes = Number(getConfig().wechat?.maxFileBytes || DEFAULT_MAX_FILE_BYTES);
    if (stat.size > maxBytes) {
      throw new Error(`file too large: ${stat.size} > ${maxBytes}`);
    }

    const fileName = basename(filePath);
    const fileData = readFileSync(filePath);
    const fileItemType = Number(getConfig().wechat?.fileItemType || MESSAGE_ITEM_FILE);
    const ref = await this._uploadToWeixinCDN(toUserId, fileData, UPLOAD_MEDIA_FILE, 'SendFile');

    if (caption) {
      await this.send(toUserId, contextToken, `📎 ${caption}`);
    }

    console.log(`📎 发送文件中... to=${toUserId?.substring(0,20)}... name=${fileName} size=${stat.size}`);
    try {
      await this._sendMessageItems(
        toUserId,
        contextToken,
        [{
          type: fileItemType,
          file_item: {
            media: mediaFromUploadRef(ref),
            file_name: fileName,
            len: String(ref.rawSize),
          },
        }],
        { logLabel: '文件' },
      );
    } catch (e) {
      console.error(`📎 文件发送失败:`, e.message);
      throw e;
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

  async pushFile(filePath, opts = {}) {
    if (!this.ownerUserId) {
      console.warn('⚠️ 尚未绑定用户，无法推送文件');
      return;
    }
    await this.sendFile(this.ownerUserId, this.lastContextToken || '', filePath, opts);
  }

  /** 回复用户消息 */
  async reply(msg, text) {
    await this.send(msg.from_user_id, msg.context_token || this.lastContextToken || '', text);
  }
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function md5Hex(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function aesEcbPaddedSize(len) {
  return Math.ceil((len + 1) / 16) * 16;
}

function encryptAesEcb(buf, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

function buildCdnUploadURL(cdnBase, uploadParam, filekey) {
  const base = String(cdnBase || DEFAULT_CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function formatAesKeyForAPI(key) {
  return Buffer.from(key.toString('hex')).toString('base64');
}

function mediaFromUploadRef(ref) {
  return {
    encrypt_query_param: ref.downloadParam,
    aes_key: formatAesKeyForAPI(ref.aesKey),
    encrypt_type: 1,
  };
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
