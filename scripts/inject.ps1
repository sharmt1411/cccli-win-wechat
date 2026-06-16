# inject.ps1 — AttachConsole + WriteConsoleInput 注入键盘事件到目标 CC 进程
# 用法：
#   echo "要注入的文本" | powershell -File inject.ps1 -TargetPid 12345
#   powershell -File inject.ps1 -TargetPid 12345 -ShiftTab
param(
    [Parameter(Mandatory)][int]$TargetPid,
    [switch]$ShiftTab   # 仅发送 Shift+Tab（权限切换）
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ConsoleInjector
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, int len, out int written);

    const int STD_INPUT_HANDLE = -10;
    const short KEY_EVENT = 1;
    const short VK_RETURN = 0x0D;
    const short VK_SHIFT  = 0x10;
    const short VK_TAB    = 0x09;
    const int SHIFT_PRESSED = 0x0010;

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD
    {
        [FieldOffset(0)]  public short EventType;
        [FieldOffset(4)]  public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD
    {
        [FieldOffset(0)]  public int bKeyDown;
        [FieldOffset(4)]  public short wRepeatCount;
        [FieldOffset(6)]  public short wVirtualKeyCode;
        [FieldOffset(8)]  public short wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public int dwControlKeyState;
    }

    static INPUT_RECORD K(bool down, short vk, char ch, int ctrl = 0)
    {
        var r = new INPUT_RECORD();
        r.EventType = KEY_EVENT;
        r.KeyEvent.bKeyDown = down ? 1 : 0;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.wVirtualKeyCode = vk;
        r.KeyEvent.UnicodeChar = ch;
        r.KeyEvent.dwControlKeyState = ctrl;
        return r;
    }

    public static string InjectText(int pid, string text)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            return "ERR:AttachConsole failed, code=" + Marshal.GetLastWin32Error();

        IntPtr h = GetStdHandle(STD_INPUT_HANDLE);
        if (h == IntPtr.Zero || h == new IntPtr(-1))
        { FreeConsole(); return "ERR:GetStdHandle failed"; }

        var ev = new List<INPUT_RECORD>();
        string[] lines = text.Replace("\r\n", "\n").Split('\n');

        for (int i = 0; i < lines.Length; i++)
        {
            if (i > 0) // Shift+Enter 换行
            {
                ev.Add(K(true,  VK_SHIFT,  '\0', SHIFT_PRESSED));
                ev.Add(K(true,  VK_RETURN, '\r', SHIFT_PRESSED));
                ev.Add(K(false, VK_RETURN, '\r', SHIFT_PRESSED));
                ev.Add(K(false, VK_SHIFT,  '\0', 0));
            }
            foreach (char c in lines[i])
            {
                ev.Add(K(true,  0, c, 0));
                ev.Add(K(false, 0, c, 0));
            }
        }

        // Enter 提交
        ev.Add(K(true,  VK_RETURN, '\r', 0));
        ev.Add(K(false, VK_RETURN, '\r', 0));

        var arr = ev.ToArray();
        int w;
        bool ok = WriteConsoleInputW(h, arr, arr.Length, out w);
        FreeConsole();
        return ok ? "ok:" + w : "ERR:Write failed, code=" + Marshal.GetLastWin32Error();
    }

    public static string InjectShiftTab(int pid)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            return "ERR:AttachConsole failed, code=" + Marshal.GetLastWin32Error();

        IntPtr h = GetStdHandle(STD_INPUT_HANDLE);
        if (h == IntPtr.Zero || h == new IntPtr(-1))
        { FreeConsole(); return "ERR:GetStdHandle failed"; }

        var ev = new INPUT_RECORD[] {
            K(true,  VK_SHIFT, '\0', SHIFT_PRESSED),
            K(true,  VK_TAB,   '\t', SHIFT_PRESSED),
            K(false, VK_TAB,   '\t', SHIFT_PRESSED),
            K(false, VK_SHIFT, '\0', 0),
        };

        int w;
        bool ok = WriteConsoleInputW(h, ev, ev.Length, out w);
        FreeConsole();
        return ok ? "ok:" + w : "ERR:Write failed, code=" + Marshal.GetLastWin32Error();
    }
}
"@ -ReferencedAssemblies @()

if ($ShiftTab) {
    $result = [ConsoleInjector]::InjectShiftTab($TargetPid)
} else {
    $text = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($text)) {
        Write-Output "ERR:empty input"
        exit 1
    }
    $result = [ConsoleInjector]::InjectText($TargetPid, $text)
}

Write-Output $result
if ($result.StartsWith("ERR:")) { exit 1 }
