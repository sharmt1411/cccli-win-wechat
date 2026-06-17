// terminal.js — Windows 终端操作
import { execFile, exec } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const INJECT_SCRIPT = join(__dirname, '..', 'scripts', 'inject.ps1');

/**
 * 向目标 CC 会话注入文本输入
 * @param {number} pid - 目标进程 PID
 * @param {string} text - 要注入的文本（支持多行，行间用 Shift+Enter）
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
  const command = [
    claudeDir && !claudeDir.endsWith('.claude')
      ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(claudeDir)}`
      : '',
    taskDescription
      ? `claude ${psQuote(taskDescription)}`
      : 'claude',
  ].filter(Boolean).join('; ');

  args.push(
    'powershell.exe',
    '-NoExit',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  );

  await execFileAsync('wt.exe', args, { timeout: 10000 });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, '..', 'scripts', 'inject.ps1'), '-TargetPid', pid.toString(), '-Key', keyName],
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
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, '..', 'scripts', 'read-screen.ps1'), '-TargetPid', pid.toString()],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}
