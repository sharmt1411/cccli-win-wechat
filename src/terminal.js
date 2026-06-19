// terminal.js — Windows 终端操作
import { execFile, exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { get as getConfig } from './config.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pathHash = createHash('md5').update(__dirname).digest('hex').slice(0, 8);

// Extract scripts from ASAR to TEMP so PowerShell can read them
const extractScript = (scriptName) => {
  const asarPath = join(__dirname, '..', 'scripts', scriptName);
  const destPath = join(tmpdir(), `cc-wechat-${pathHash}-${scriptName}`);
  try {
    const content = readFileSync(asarPath, 'utf8');
    writeFileSync(destPath, content, 'utf8');
  } catch (e) {
    console.error(`Failed to extract ${scriptName} to ${destPath}:`, e.message);
  }
  return destPath;
};

const INJECT_SCRIPT = extractScript('inject.ps1');
const READ_SCREEN_SCRIPT = extractScript('read-screen.ps1');

/**
 * 向目标 CC 会话注入文本输入
 * @param {number} pid - 目标进程 PID
 * @param {string} text - 要注入的文本（支持多行，行间用 Ctrl+Enter）
 */
export async function injectInput(pid, text) {
  // 通过 stdin 传递文本，避免 shell 转义问题
  return new Promise((resolve, reject) => {
    const ps = execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', INJECT_SCRIPT,
      '-TargetPid', String(pid),
    ], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`inject failed: ${stderr || err.message}`));
      const out = stdout.trim();
      if (out.startsWith('ok:')) return resolve(out);
      reject(new Error(`inject error: ${out}`));
    });
    ps.stdin.on('error', (e) => reject(new Error(`inject stdin failed: ${e.message}`)));
    ps.stdin.write(text);
    ps.stdin.end();
  });
}

/**
 * 新开 Windows Terminal tab 运行 Claude Code
 * @param {object} opts
 * @param {string} opts.cwd - 工作目录
 * @param {string} [opts.taskDescription] - 任务描述（可选）
 * @param {string} [opts.claudeDir] - Claude 配置目录（影响 CLAUDE_CONFIG_DIR 环境变量）
 */
export async function newTab({ cwd, taskDescription, claudeDir }) {
  const args = ['new-tab', '-d', cwd];
  const pidFile = join(tmpdir(), `cc-wechat-newtab-${Date.now()}-${randomUUID()}.pid`);
  const command = [
    `$PID | Set-Content -LiteralPath ${psQuote(pidFile)} -Encoding ascii`,
    // 清掉从 cc-wechat 进程继承来的 Claude 子会话标记（CLAUDE_CODE_CHILD_SESSION/SESSION_ID/CLAUDECODE 等）。
    // 否则新开的 claude 会以为自己是"子会话"，进入不落盘模式：不写 transcript、不写 sessions 注册文件，
    // 导致回复无法经 hook 推送、/ls 也扫不到。保留 CLAUDE_CONFIG_DIR（下面按需另行设置）。
    `Get-ChildItem Env: | Where-Object { $_.Name -like 'CLAUDE_CODE_*' -or $_.Name -eq 'CLAUDECODE' -or $_.Name -eq 'CLAUDE_EFFORT' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) -ErrorAction SilentlyContinue }`,
    claudeDir && !claudeDir.endsWith('.claude')
      ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(claudeDir)}`
      : '',
    taskDescription
      ? `${getConfig().terminalCommand || 'claude'} ${psQuote(taskDescription)}`
      : (getConfig().terminalCommand || 'claude'),
  ].filter(Boolean).join('; ');

  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');

  args.push(
    'powershell.exe',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  );

  await execFileAsync('wt.exe', args, { timeout: 10000 });
  return { pid: await waitForPidFile(pidFile) };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function waitForPidFile(pidFile) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (existsSync(pidFile)) {
        const raw = readFileSync(pidFile, 'utf8').trim();
        try { unlinkSync(pidFile); } catch {}
        const pid = parseInt(raw, 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    } catch {
      // Try again until the short deadline. The tab may still be starting.
    }
    await new Promise(r => setTimeout(r, 100));
  }
  try { unlinkSync(pidFile); } catch {}
  return null;
}

/**
 * 注入按键
 * @param {number} pid - 目标进程 PID
 * @param {string} keyName - 按键名称
 */
export async function injectKey(pid, keyName) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INJECT_SCRIPT, '-TargetPid', pid.toString(), '-Key', keyName],
      { encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

/**
 * 捕获终端可见屏幕内容
 * @param {number} pid - 目标进程 PID
 */
export async function readScreen(pid) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', READ_SCREEN_SCRIPT, '-TargetPid', pid.toString()],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}
