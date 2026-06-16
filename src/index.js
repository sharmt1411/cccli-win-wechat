// index.js — 入口：安装 / 启动服务
import { isConfigured, load as loadConfig } from './config.js';
import { runSetup } from './setup.js';
import { WeChatBot } from './wechat.js';
import { Bridge } from './bridge.js';
import { NotifyWatcher } from './notify.js';

async function main() {
  const forceSetup = process.argv.includes('--setup');

  loadConfig();

  // 首次运行或 --setup 进入安装向导
  if (forceSetup || !isConfigured()) {
    const ok = await runSetup();
    if (!ok) process.exit(1);
    if (forceSetup) return; // --setup 只做安装
  }

  // 启动服务
  console.log('\n🚀 cc-wechat 启动中...\n');

  const bot = new WeChatBot();
  const bridge = new Bridge(bot);

  const notifier = new NotifyWatcher(bot, (data) => {
    bridge.onNotify(data);
  });

  notifier.start();

  // 开始轮询微信消息
  await bot.startPolling(async (msg) => {
    await bridge.handleMessage(msg);
  });
}

main().catch(e => {
  console.error('💥 致命错误:', e);
  process.exit(1);
});
