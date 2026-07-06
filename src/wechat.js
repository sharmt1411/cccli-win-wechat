// wechat.js — iLink Bot API 协议封装
import { saveWechat, get as getConfig, resolveInboundDir } from './config.js';

import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '1.0.2';
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_VOICE = 3;
const MESSAGE_ITEM_FILE = 4;
const MESSAGE_ITEM_VIDEO = 5;
const UPLOAD_MEDIA_FILE = 3;
const CDN_UPLOAD_MAX_RETRIES = 3;

function randomUin() {
  const n = (Math.random() * 0xFFFFFFFF) >>> 0;
  return Buffer.from(String(n)).toString('base64');
}

function formatCursorForLog(value) {
  const s = String(value || '');
  return s ? `${s.substring(0, 16)}.../${s.length}` : '空';
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
    this.syncBuf = cfg.syncBuf || '';
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
    if (this._polling) return; // 已有轮询循环在跑，重复启动会导致游标互踩、消息重复
    this._polling = true;
    console.log('📡 开始微信消息轮询...');

    let pollCount = 0;
    while (this._polling) {
      try {
        pollCount++;
        console.log(`📡 轮询 #${pollCount} 发送中... (buf=${formatCursorForLog(this.buf)} sync=${formatCursorForLog(this.syncBuf)})`);
        const data = await this._fetch('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: this.buf,
            sync_buf: this.syncBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          }),
        });
        console.log(`📡 轮询 #${pollCount} 返回: ret=${data.ret} msgs=${data.msgs?.length || 0} nextBuf=${formatCursorForLog(data.get_updates_buf)} nextSync=${formatCursorForLog(data.sync_buf)}`);

        // 首次轮询打印完整响应
        if (pollCount === 1) {
          console.log('首次响应:', JSON.stringify(data, null, 2).substring(0, 1000));
        }

        if (data.get_updates_buf) {
          this.buf = data.get_updates_buf;
          saveWechat({ getUpdatesBuf: this.buf });
        }
        if (data.sync_buf) {
          this.syncBuf = data.sync_buf;
          saveWechat({ syncBuf: this.syncBuf });
        }

        if (data.msgs?.length) {
          console.log(`📨 收到 ${data.msgs.length} 条消息`);
          for (const msg of data.msgs) {
            const text = this.extractMessageText(msg) || '';
            const itemSummary = summarizeMessageItems(msg.item_list);
            console.log(`  ├ type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id?.substring(0,20)}... text="${text.substring(0,50)}"`);
            if (itemSummary.length && (!text || itemSummary.some(item => item.mediaLike))) {
              console.log(`    items=${JSON.stringify(itemSummary).substring(0, 1200)}`);
            }
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
    let resultText = String(text);
    const alias = getConfig().botAlias || 'Claude';
    if (alias && alias.toLowerCase() !== 'claude') {
      resultText = resultText.replace(/Claude Code|Claude/gi, alias);
    }
    const chunks = splitText(resultText, 2000);
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

  extractMessageText(msg) {
    return bodyFromItemList(msg?.item_list || []);
  }

  async saveInboundMedia(msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
    const files = [];
    const errors = [];
    const unhandled = [];
    const seen = new Set();

    for (const item of items) {
      try {
        const media = await this._downloadInboundItem(item, seen);
        if (media?.skipped) continue;
        if (!media) {
          if (isPotentialInboundMediaItem(item)) {
            unhandled.push(describeInboundItem(item));
          }
          continue;
        }
        files.push(this._saveInboundFile(media.data, media.name, media.kind));
      } catch (e) {
        errors.push(e.message);
        console.warn('WeChat inbound media failed:', e.message, JSON.stringify(describeInboundItem(item)).substring(0, 1200));
      }
    }

    if (unhandled.length) {
      console.warn('WeChat inbound media skipped:', JSON.stringify(unhandled).substring(0, 2000));
    }
    return { files, errors, unhandled };
  }

  async _downloadInboundItem(item, seen) {
    const type = Number(item?.type || 0);

    if (type === MESSAGE_ITEM_FILE) {
      const file = item.file_item;
      const media = pickCdnMedia(file) || pickCdnMedia(item);
      const { enc, key } = cdnMaterial(media);
      if (!enc || !key) return null;
      if (seen.has(enc)) return { skipped: true };
      seen.add(enc);
      return {
        kind: 'file',
        name: sanitizeFileName(file?.file_name || findInboundFileName(item), 'attachment.bin'),
        data: await this._downloadAndDecryptCDN(enc, key, 'weixin inbound file'),
      };
    }

    if (type === MESSAGE_ITEM_IMAGE) {
      const image = item.image_item;
      const media = pickCdnMedia(image);
      const { enc } = cdnMaterial(media);
      if (!enc) return null;
      if (seen.has(enc)) return { skipped: true };
      seen.add(enc);
      const key = inboundImageAesKey(image);
      const data = key
        ? await this._downloadAndDecryptCDN(enc, key, 'weixin inbound image')
        : await this._downloadPlainCDN(enc, 'weixin inbound image');
      return {
        kind: 'image',
        name: `image${extensionFromMime(detectImageMime(data))}`,
        data,
      };
    }

    if (type === MESSAGE_ITEM_VIDEO) {
      const video = item.video_item;
      const media = pickCdnMedia(video) || pickCdnMedia(item);
      const { enc, key } = cdnMaterial(media);
      if (!enc || !key) return null;
      if (seen.has(enc)) return { skipped: true };
      seen.add(enc);
      return {
        kind: 'video',
        name: 'video.mp4',
        data: await this._downloadAndDecryptCDN(enc, key, 'weixin inbound video'),
      };
    }

    if (type === MESSAGE_ITEM_VOICE) {
      const voice = item.voice_item;
      if (String(voice?.text || '').trim()) return null;
      const media = pickCdnMedia(voice) || pickCdnMedia(item);
      const { enc, key } = cdnMaterial(media);
      if (!enc || !key) return null;
      if (seen.has(enc)) return { skipped: true };
      seen.add(enc);
      return {
        kind: 'voice',
        name: 'voice.silk',
        data: await this._downloadAndDecryptCDN(enc, key, 'weixin inbound voice'),
      };
    }

    if (type !== MESSAGE_ITEM_TEXT) {
      const media = pickCdnMedia(item);
      const { enc, key } = cdnMaterial(media);
      if (enc && key) {
        if (seen.has(enc)) return { skipped: true };
        seen.add(enc);
        return {
          kind: mediaKindFromType(type),
          name: sanitizeFileName(findInboundFileName(item), defaultInboundFileName(type)),
          data: await this._downloadAndDecryptCDN(enc, key, `weixin inbound item type ${type}`),
        };
      }
    }

    return null;
  }

  async _downloadAndDecryptCDN(encryptedQueryParam, aesKeyBase64, label) {
    const encrypted = await this._downloadPlainCDN(encryptedQueryParam, label);
    return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64, label));
  }

  async _downloadPlainCDN(encryptedQueryParam, label) {
    const url = buildCdnDownloadURL(
      getConfig().wechat?.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
      encryptedQueryParam,
    );
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${label}: CDN HTTP ${res.status} ${body.substring(0, 200)}`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      const maxBytes = Number(getConfig().wechat?.maxInboundMediaBytes || DEFAULT_MAX_INBOUND_MEDIA_BYTES);
      if (data.length > maxBytes) {
        throw new Error(`${label}: inbound media too large ${data.length} > ${maxBytes}`);
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  _saveInboundFile(data, fileName, kind) {
    const dir = resolveInboundDir(getConfig().wechat?.inboundDir);
    const datedDir = join(dir, dateStamp());
    mkdirSync(datedDir, { recursive: true });

    const safeName = normalizeInboundFileName(data, sanitizeFileName(fileName, `${kind || 'attachment'}.bin`));
    const filePath = uniqueFilePath(datedDir, safeName);
    writeFileSync(filePath, data);
    return {
      path: filePath,
      name: basename(filePath),
      size: data.length,
      kind: kind || 'file',
    };
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

function decryptAesEcb(buf, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

function parseAesKey(aesKeyBase64, label) {
  const raw = String(aesKeyBase64 || '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('utf8'))) {
    return Buffer.from(decoded.toString('utf8'), 'hex');
  }
  throw new Error(`${label}: invalid aes_key length ${decoded.length}`);
}

function buildCdnUploadURL(cdnBase, uploadParam, filekey) {
  const base = String(cdnBase || DEFAULT_CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildCdnDownloadURL(cdnBase, encryptedQueryParam) {
  const base = String(cdnBase || DEFAULT_CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
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

function inboundImageAesKey(image) {
  const hexKey = String(image?.aeskey || '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(hexKey)) {
    return Buffer.from(hexKey, 'hex').toString('base64');
  }
  return cdnMaterial(pickCdnMedia(image)).key;
}

function pickCdnMedia(value, { allowThumb = false, depth = 0 } = {}) {
  if (!value || typeof value !== 'object' || depth > 6) return null;

  for (const key of ['media', 'cdn_media', 'file_media']) {
    if (looksLikeCdnMedia(value[key])) return value[key];
  }
  if (allowThumb && looksLikeCdnMedia(value.thumb_media)) {
    return value.thumb_media;
  }
  if (looksLikeCdnMedia(value)) return value;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'ref_msg' || key === 'ref_message' || key === 'quoted_msg') continue;
    if (!allowThumb && key === 'thumb_media') continue;
    const found = pickCdnMedia(child, { allowThumb, depth: depth + 1 });
    if (found) return found;
  }
  return null;
}

function looksLikeCdnMedia(value) {
  if (!value || typeof value !== 'object') return false;
  const { enc, key } = cdnMaterial(value);
  return Boolean(enc || key || value.encrypt_type);
}

function cdnMaterial(media) {
  return {
    enc: String(media?.encrypt_query_param || media?.encrypted_query_param || '').trim(),
    key: String(media?.aes_key || media?.aeskey || media?.aesKey || '').trim(),
  };
}

function isPotentialInboundMediaItem(item) {
  const type = Number(item?.type || 0);
  return [MESSAGE_ITEM_IMAGE, MESSAGE_ITEM_VOICE, MESSAGE_ITEM_FILE, MESSAGE_ITEM_VIDEO].includes(type)
    || Boolean(item?.file_item || item?.image_item || item?.voice_item || item?.video_item)
    || Boolean(pickCdnMedia(item))
    || Boolean(findInboundFileName(item));
}

function describeInboundItem(item) {
  const media = pickCdnMedia(item, { allowThumb: true });
  const { enc, key } = cdnMaterial(media);
  return {
    type: Number(item?.type || 0),
    mediaLike: isPotentialInboundMediaItem(item),
    keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 12) : [],
    fileName: findInboundFileName(item),
    len: findFirstStringByKey(item, ['len', 'size', 'file_size']),
    hasEncryptQueryParam: Boolean(enc),
    hasAesKey: Boolean(key),
    mediaKeys: media && typeof media === 'object' ? Object.keys(media).slice(0, 12) : [],
  };
}

function summarizeMessageItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    const summary = describeInboundItem(item);
    if (Number(item?.type) === MESSAGE_ITEM_TEXT) {
      summary.textLength = String(item?.text_item?.text || '').length;
    }
    if (Number(item?.type) === MESSAGE_ITEM_VOICE) {
      summary.voiceTextLength = String(item?.voice_item?.text || '').length;
    }
    return summary;
  });
}

function findInboundFileName(value) {
  return findFirstStringByKey(value, ['file_name', 'filename', 'name', 'title']);
}

function findFirstStringByKey(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return '';
  for (const key of keys) {
    const found = value[key];
    if (typeof found === 'string' && found.trim()) return found.trim();
    if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'ref_msg' || key === 'ref_message' || key === 'quoted_msg') continue;
    const found = findFirstStringByKey(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function mediaKindFromType(type) {
  switch (Number(type)) {
    case MESSAGE_ITEM_IMAGE: return 'image';
    case MESSAGE_ITEM_VOICE: return 'voice';
    case MESSAGE_ITEM_VIDEO: return 'video';
    case MESSAGE_ITEM_FILE: return 'file';
    default: return 'file';
  }
}

function defaultInboundFileName(type) {
  switch (Number(type)) {
    case MESSAGE_ITEM_IMAGE: return 'image.bin';
    case MESSAGE_ITEM_VOICE: return 'voice.silk';
    case MESSAGE_ITEM_VIDEO: return 'video.mp4';
    default: return 'attachment.bin';
  }
}

function bodyFromItemList(items) {
  if (!Array.isArray(items)) return '';
  for (const item of items) {
    if (Number(item?.type) === MESSAGE_ITEM_TEXT) {
      const text = String(item?.text_item?.text || '').trim();
      if (text) return text;
    }
    if (Number(item?.type) === MESSAGE_ITEM_VOICE) {
      const text = String(item?.voice_item?.text || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function dateStamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sanitizeFileName(name, fallback) {
  const raw = basename(String(name || fallback || 'attachment.bin')).trim() || fallback || 'attachment.bin';
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '_');
  return cleaned.slice(0, 160) || fallback || 'attachment.bin';
}

function normalizeInboundFileName(data, name) {
  if (!isEpubArchive(data)) return name;
  const ext = extname(name).toLowerCase();
  if (ext === '.epub') return name;
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem || 'attachment'}.epub`;
}

function isEpubArchive(data) {
  if (!Buffer.isBuffer(data) || data.length < 64) return false;
  if (data[0] !== 0x50 || data[1] !== 0x4b) return false;
  const head = data.subarray(0, Math.min(data.length, 1024 * 1024)).toString('latin1');
  return head.includes('application/epub+zip') || head.includes('META-INF/container.xml');
}

function uniqueFilePath(dir, name) {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  for (let i = 1; existsSync(candidate); i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

function detectImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString() === 'GIF87a' || buf.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function extensionFromMime(mime) {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return '.bin';
  }
}

function splitText(text, maxLen) {
  // 按 Unicode 码点切分，避免在 emoji/代理对中间截断产生乱码。
  const chars = Array.from(String(text));
  if (chars.length <= maxLen) return [String(text)];
  const chunks = [];
  for (let i = 0; i < chars.length; i += maxLen) {
    chunks.push(chars.slice(i, i + maxLen).join(''));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
