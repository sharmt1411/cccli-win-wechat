# cc-wechat

通过**个人微信**远程控制 Windows 上的 **Claude Code CLI**。

电脑锁屏 / 息屏或人不在时,把 Claude 的「完成回复」和「需要审批 / 需要输入」推送到微信;你在微信里直接回复就能把内容注入回终端里的会话,或新开一个终端窗口跑一个临时任务。**所有操作都留在本机终端**,微信只是远程的输入桥接——回到电脑前可以无缝在终端继续。

> 设计原则:精简、克制、仅必须功能。仅支持 Windows。

---

## 与其他 cc 远控项目的核心区别

大多数「微信 / Telegram 控制 Claude」类项目,本质是**另起一个独立会话**:手机那端跑的是一个 API 或无头(headless)进程,和你电脑上正在用的终端是**两套上下文**。你在手机上做的事,电脑这边看不到;想接着干,得"交接"或"导出"。

**cc-wechat 不开新会话——它直接操作你本机正在用的那个终端。**

- **双线操作同一个终端,而非独立会话**
  微信下发的内容,是通过 `AttachConsole(pid) + WriteConsoleInput` 把**真实键盘事件**塞进你眼前那个 Claude 进程。键盘和微信是**同一个会话的两个输入源**,不是两个会话。

- **双端自由同步,无需交接**
  在电脑上开个任务 → 锁屏走开 → 用微信继续回复 / 点审批 → 回到电脑 → **直接在终端接着敲**。全程同一个进程、同一份上下文、同一份历史日志,没有"接管 / 导出 / 同步"这一步,因为根本就是同一个会话。

- **状态天然一致**
  推送和回显都读自 Claude 的本地会话记录(`.claude/projects/<project>/<id>.jsonl`)与会话文件。微信里看到的就是终端里真实发生的;反之你在终端里的操作,微信侧的视图也一致。

- **一切留在本机**
  计算、文件、权限、密钥都在你电脑上,微信只是**远程输入桥**,不会把代码 / 上下文搬到第三方会话里。

- **既能续用、也能新开**
  默认是"接管现有终端";需要时也可 `/new` 用 `wt new-tab` 新开一个标签跑临时任务——但即便新开,它依然是你本机的真实终端会话,回到电脑前照样能直接继续。

一句话:**别的项目是"手机里多了个 Claude",cc-wechat 是"你电脑上那个 Claude,多了个微信遥控器"。一个终端,两个遥控器,随时换手。**

---

## 工作原理

```
┌─────────┐   hook 通知文件    ┌──────────────┐   推送    ┌────────┐
│ Claude  │ ─── Stop/Notif ──▶ │  cc-wechat   │ ────────▶ │  微信   │
│ Code CLI│                    │ (Electron/   │           │ (本人) │
│ (终端)  │ ◀── 键盘注入 ───── │   Node 服务) │ ◀──────── │        │
└─────────┘  AttachConsole+    └──────────────┘   回复     └────────┘
             WriteConsoleInput
```

- **通知**:在每个 Claude 配置目录的 `settings.json` 注入 `Stop` / `Notification` 两个 hook。hook(PowerShell)读取会话记录,把最后回复 / 待审批信息写成 JSON 通知文件;服务监听该目录并推送微信。
- **回复 / 操作**:微信消息经 iLink 协议拉取后,通过 `AttachConsole(pid) + WriteConsoleInput` 把键盘事件塞进目标 Claude 会话所在的终端。
- **新建会话**:`wt new-tab` 新开 Windows Terminal 标签运行 `claude`,可指定 `CLAUDE_CONFIG_DIR`。
- **读屏**:必要时读取终端屏幕缓冲,辅助识别审批界面。
- **生效模式**:可设为仅在锁屏 / 息屏时推送和桥接(基于 WTS 会话状态 + 输入桌面 + 空闲时长检测)。

微信对接基于 iLink 机器人协议(参考 [weixin-bot-api](https://github.com/hao-ji-xing/cc-weixin/blob/main/weixin-bot-api.md))。

---

## 环境要求

- Windows 10/11
- [Windows Terminal](https://aka.ms/terminal)(`wt.exe`,用于新开会话)
- PowerShell(系统自带)
- Node.js 18+(开发 / CLI 模式)
- 已安装并使用过的 Claude Code CLI(存在 `~/.claude` 等配置目录)
- 一个用于扫码登录机器人的个人微信

---

## 安装与运行

### 方式一:桌面应用(推荐)

```bash
npm install
npm run app      # 开发态启动 Electron
npm run build    # 打包便携版 → dist/cc-wechat <版本>.exe
```

便携版是单文件 exe,放到任意目录双击运行,托盘常驻。首次运行扫码登录微信、选择要管理的 Claude 目录。

### 方式二:命令行

```bash
npm install
npm run setup    # 安装向导:扫描目录、注入 hook、扫码登录
npm start        # 启动服务
```

---

## 配置(`config.json`)

config.json 位于**程序所在目录**(便携版为 exe 同级目录;CLI 模式为项目根目录)。

```jsonc
{
  "claudeDirs": [                       // 要管理的 Claude 配置目录(注入 hook)
    "C:/Users/xxx/.claude",
    "C:/Users/xxx/.claude-anyrouter"
  ],
  "botAlias": "Claude",                 // 推送时把 "Claude" 替换成的别名
  "terminalCommand": "claude",          // 新开标签运行的命令
  "notifyDir": "./cc-wechat-notify",    // hook 通知文件目录(相对程序目录)
  "lockScreenMode": {
    "enabled": false,                   // 仅锁屏/息屏时推送和桥接
    "idleGraceSeconds": 5               // 息屏判定的额外宽限秒数
  },
  "capabilityInjection": {              // 向 Claude 提示注入"能力说明"
    "enabled": true,
    "mode": "smart",
    "minIntervalMessages": 6,
    "minIntervalMinutes": 30,
    "capabilities": { "sendFile": true } // 启用"发文件到微信"能力
  },
  "wechat": {
    "botToken": "",                     // 扫码登录后自动写入
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
    "inboundDir": "./wechat-files",     // 微信发来的文件保存目录
    "ownerUserId": "",                  // 首条消息自动绑定为机主
    "getUpdatesBuf": "", "syncBuf": "", "lastContextToken": ""  // 收发游标,自动维护
  },
  "ui": { "enabled": true, "port": 8787, "autoOpen": true, "tray": true }
}
```

---

## 微信命令

直接发**文本** = 发送到当前会话(自动以 Enter 提交)。其余命令:

| 命令 | 作用 |
|---|---|
| `/ls` | 列出所有活跃会话(带序号) |
| `/to N` | 切换当前操作的会话 |
| `/new` | 新建会话向导 |
| `/new <目录> <任务>` | 在指定目录新开终端跑 Claude 并下发任务 |
| `/new --trust` | 新标签里选择"信任目录" |
| `/last` | 拉取当前会话最近一条回复 |
| `/screen` | 截取当前终端界面文本 |
| `/perm` | 切换权限模式(Shift+Tab) |
| `/away` · `/away on` · `/away off` | 查看 / 仅离开时生效 / 始终生效 |
| `/up /down /left /right` `/space /enter /tab /esc` | 方向 / 功能键(可带次数,如 `/down 3`) |
| `/help` | 帮助 |

**提问 / 授权快捷回复**(对应 `AskUserQuestion` / 权限弹窗):
- 单选:`[1]` 或多选 `[1 3]`
- 多分类:`[1 3][1][2]`(每个 `[]` 对应一个分类)
- `/pick 1 3` 批量勾选

**透传**:以 `透传: <内容>` 开头,内容原样送入终端(不做命令解析 / 消歧)。

---

## 收发文件

- **微信 → 电脑**:在微信发送文件 / 图片,自动下载到 `wechat.inboundDir`(默认 `./wechat-files`)。
- **电脑 → 微信**:启用 `capabilities.sendFile` 后,服务会在合适时机往 Claude 提示里注入一段能力说明。Claude 在回复末尾输出:

  ````
  ```cc-wechat-send
  {"send-cc-wechat-files":[{"path":"相对或绝对路径","caption":"可选说明"}]}
  ```
  ````

  服务据此把文件发回微信。**安全限制**:只允许发送会话工作目录或微信文件目录内的文件,目录外路径会被拒绝。

---

## 多实例运行

支持在不同文件夹各放一份便携版多开,但有约束:

- **同一文件夹只能跑一个实例**:启动时写 `cc-wechat.lock`(含 PID),同目录二开会弹窗提示并退出——因为 config.json / 通知目录都按文件夹寻址,多开会互相覆盖。多开请复制到**不同文件夹**。
- **每个实例应管理不同的 Claude 配置目录**:hook 写在各目录的 `settings.json` 里,若两个实例都管同一目录会互抢通知。注入时会检测目录是否已被**其他实例**(指向不同通知目录)接管,若是则**告警并跳过,不覆盖**。
- 在设置里增删 `claudeDirs` 会即时生效:移除的目录会**卸载本实例的 hook**(保留其他实例的),新增的目录立即注入。
- 不要把已配置好的文件夹整个复制去多开(会共用同一个微信 botToken 导致重复消费);多开请各自重新扫码登录不同机器人。

---

## 项目结构

```
main.js                 Electron 主进程:窗口/托盘/单实例锁/IPC
preload.js              渲染进程桥接
ui/index.html           托盘面板(配置、二维码、日志)
src/
  index.js              CLI 入口(setup / 启动服务)
  config.js             配置读写、路径解析
  setup.js              安装向导、hook 注入/卸载/冲突检测
  wechat.js             iLink 协议:扫码登录、轮询收消息、发消息/文件
  bridge.js             微信命令路由、会话调度、能力注入
  session.js            扫描 Claude 活跃会话、读取历史回复
  notify.js             监听 hook 通知文件 → 推送微信
  interaction.js        提问/授权交互的解析与格式化
  presence.js           锁屏/息屏检测(WTS + 桌面 + 空闲)
  terminal.js           终端注入(键盘事件)、新开标签、读屏
scripts/
  hook-notify.ps1       Claude hook:写通知文件
  inject.ps1            AttachConsole + WriteConsoleInput 注入
  read-screen.ps1       读取终端屏幕缓冲
```

---

## 安全说明

- 仅推送 / 控制本机的 Claude 会话,机主身份由首条微信消息绑定(`ownerUserId`),非机主消息忽略。
- 发文件受工作目录 / 微信文件目录范围限制。
- `config.json`(含 `botToken`)、`wechat-files/`、`cc-wechat-notify/`、`cc-wechat.lock` 均已在 `.gitignore` 中,不会进版本库。
