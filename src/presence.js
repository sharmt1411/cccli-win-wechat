// presence.js — Windows 锁屏/息屏状态检测
import { execFile } from 'node:child_process';
import { get as getConfig } from './config.js';

const CACHE_TTL_MS = 8000;
let cachedState = null;
let cachedAt = 0;

export function isLockScreenModeEnabled(cfg = getConfig()) {
  return Boolean(cfg.lockScreenMode?.enabled);
}

export async function shouldOperateByPresence() {
  const cfg = getConfig();
  if (!isLockScreenModeEnabled(cfg)) {
    return { allowed: true, modeEnabled: false, state: null };
  }

  const state = await getPresenceState(cfg);
  return {
    allowed: Boolean(state.isAway),
    modeEnabled: true,
    state,
  };
}

export async function getPresenceState(cfg = getConfig()) {
  const now = Date.now();
  if (cachedState && now - cachedAt < CACHE_TTL_MS) return cachedState;

  const graceSeconds = Number(cfg.lockScreenMode?.idleGraceSeconds ?? 5);
  if (process.platform !== 'win32') {
    cachedState = {
      isAway: false,
      locked: false,
      screenOffLikely: false,
      reason: 'unsupported_platform',
      detail: '当前仅支持 Windows 锁屏/息屏检测',
    };
    cachedAt = now;
    return cachedState;
  }

  try {
    const raw = await runPresenceProbe(graceSeconds);
    const data = JSON.parse(raw);
    cachedState = {
      isAway: Boolean(data.away),
      locked: Boolean(data.locked),
      screenOffLikely: Boolean(data.screenOffLikely),
      wtsOk: Boolean(data.wtsOk),
      sessionFlags: Number(data.sessionFlags ?? -1),
      desktopName: String(data.desktopName || ''),
      canSwitchDesktop: Boolean(data.canSwitchDesktop),
      logonUi: Boolean(data.logonUi),
      idleMs: Number(data.idleMs || 0),
      displayTimeoutSeconds: Number(data.displayTimeoutSeconds || 0),
      reason: data.locked ? 'locked' : (data.screenOffLikely ? 'screen_off' : 'active'),
    };
  } catch (e) {
    cachedState = {
      isAway: false,
      locked: false,
      screenOffLikely: false,
      reason: 'detect_failed',
      detail: e.message,
    };
  }

  cachedAt = now;
  return cachedState;
}

export function formatPresenceState(state) {
  if (!state) return '未知';
  if (state.locked) return '锁屏';
  if (state.screenOffLikely) return '息屏';
  if (state.reason === 'detect_failed') return '检测失败';
  if (state.reason === 'unsupported_platform') return '不支持';
  return '使用中';
}

function runPresenceProbe(graceSeconds) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CcWechatPresenceNative {
  public const int WTSSessionInfoEx = 25;
  public const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;

  [DllImport("wtsapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WTSQuerySessionInformationW(IntPtr hServer, uint sessionId, int wtsInfoClass, out IntPtr ppBuffer, out uint pBytesReturned);
  [DllImport("wtsapi32.dll")]
  public static extern void WTSFreeMemory(IntPtr pMemory);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct WTSINFOEX_LEVEL1_W {
    public uint SessionId;
    public int SessionState;
    public int SessionFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=33)]
    public string WinStationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=21)]
    public string UserName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=18)]
    public string DomainName;
    public long LogonTime;
    public long ConnectTime;
    public long DisconnectTime;
    public long LastInputTime;
    public long CurrentTime;
    public uint IncomingBytes;
    public uint OutgoingBytes;
    public uint IncomingFrames;
    public uint OutgoingFrames;
    public uint IncomingCompressedBytes;
    public uint OutgoingCompressedBytes;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct WTSINFOEX_DATA {
    [FieldOffset(0)]
    public WTSINFOEX_LEVEL1_W Level1;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WTSINFOEXW {
    public uint Level;
    public WTSINFOEX_DATA Data;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SwitchDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@

$sessionFlags = -1
$wtsLocked = $false
$wtsOk = $false
$wtsBuf = [IntPtr]::Zero
$wtsBytes = 0
if ([CcWechatPresenceNative]::WTSQuerySessionInformationW([IntPtr]::Zero, [CcWechatPresenceNative]::WTS_CURRENT_SESSION, [CcWechatPresenceNative]::WTSSessionInfoEx, [ref]$wtsBuf, [ref]$wtsBytes) -and $wtsBuf -ne [IntPtr]::Zero) {
  try {
    $wts = [Runtime.InteropServices.Marshal]::PtrToStructure($wtsBuf, [type][CcWechatPresenceNative+WTSINFOEXW])
    $sessionFlags = [int]$wts.Data.Level1.SessionFlags
    $wtsOk = $true
    $wtsLocked = $sessionFlags -eq 0
  } finally {
    [CcWechatPresenceNative]::WTSFreeMemory($wtsBuf)
  }
}

$desk = [CcWechatPresenceNative]::OpenInputDesktop(0, $false, 0x0101)
$locked = $true
$desktopName = ''
$canSwitchDesktop = $false
if ($desk -ne [IntPtr]::Zero) {
  $needed = 0
  $sb = New-Object System.Text.StringBuilder 256
  if ([CcWechatPresenceNative]::GetUserObjectInformationW($desk, 2, $sb, $sb.Capacity, [ref]$needed)) {
    $desktopName = $sb.ToString()
  }
  $canSwitchDesktop = [CcWechatPresenceNative]::SwitchDesktop($desk)
  $locked = (-not $canSwitchDesktop) -or ($desktopName -and $desktopName -ne 'Default')
  [CcWechatPresenceNative]::CloseDesktop($desk) | Out-Null
}

$currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$logonUi = $false
try {
  $logonUi = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $currentSessionId }).Count -gt 0
} catch {}
$locked = if ($wtsOk) { $wtsLocked } else { $locked -or $logonUi }

$li = New-Object CcWechatPresenceNative+LASTINPUTINFO
$li.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CcWechatPresenceNative+LASTINPUTINFO])
[CcWechatPresenceNative]::GetLastInputInfo([ref]$li) | Out-Null
$idleMs = [int64]([Environment]::TickCount - [int]$li.dwTime)
if ($idleMs -lt 0) { $idleMs += 4294967296 }

$timeoutSeconds = 0
try {
  $powerText = (powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 2>$null) -join "\`n"
  $onBattery = $false
  try {
    $bats = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
    if ($bats.Count -gt 0) {
      $onBattery = @($bats | Where-Object { $_.BatteryStatus -in 1, 4, 5 }).Count -gt 0
    }
  } catch {}
  $kind = if ($onBattery) { 'DC' } else { 'AC' }
  $label = if ($kind -eq 'AC') {
    '(?:Current AC Power Setting Index|当前交流电源设置索引)'
  } else {
    '(?:Current DC Power Setting Index|当前直流电源设置索引)'
  }
  $match = [regex]::Match($powerText, "$label\\s*:\\s*0x([0-9a-fA-F]+)")
  if (-not $match.Success) {
    $match = [regex]::Match($powerText, "(?:Current (?:AC|DC) Power Setting Index|当前(?:交流|直流)电源设置索引)\\s*:\\s*0x([0-9a-fA-F]+)")
  }
  if ($match.Success) {
    $timeoutSeconds = [Convert]::ToInt32($match.Groups[1].Value, 16)
  }
} catch {}

$graceMs = ${Number.isFinite(graceSeconds) ? Math.max(0, Math.floor(graceSeconds)) : 5} * 1000
$screenOffLikely = ($timeoutSeconds -gt 0) -and ($idleMs -ge (($timeoutSeconds * 1000) + $graceMs))
$away = $locked -or $screenOffLikely
[pscustomobject]@{
  locked = $locked
  wtsOk = $wtsOk
  sessionFlags = $sessionFlags
  desktopName = $desktopName
  canSwitchDesktop = $canSwitchDesktop
  logonUi = $logonUi
  idleMs = $idleMs
  displayTimeoutSeconds = $timeoutSeconds
  screenOffLikely = $screenOffLikely
  away = $away
} | ConvertTo-Json -Compress
`;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 6000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      },
    );
  });
}
