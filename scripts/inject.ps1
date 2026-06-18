# inject.ps1 — AttachConsole + WriteConsoleInput 注入键盘事件到目标 CC 进程
# 用法：
#   echo "要注入的文本" | powershell -File inject.ps1 -TargetPid 12345
#   powershell -File inject.ps1 -TargetPid 12345 -Key shifttab
param(
    [Parameter(Mandatory)][int]$TargetPid,
    [string]$Key
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;

public class ConsoleInjector
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, int len, out int written);

    const uint GENERIC_READ  = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ  = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING = 3;

    const short KEY_EVENT = 1;
    const short VK_RETURN = 0x0D;
    const short VK_SHIFT  = 0x10;
    const short VK_CONTROL = 0x11;
    const short VK_TAB    = 0x09;
    const short VK_SPACE  = 0x20;
    const short VK_UP     = 0x26;
    const short VK_DOWN   = 0x28;
    const short VK_LEFT   = 0x25;
    const short VK_RIGHT  = 0x27;
    const short VK_ESCAPE = 0x1B;
    const int SHIFT_PRESSED = 0x0010;
    const int LEFT_CTRL_PRESSED = 0x0008;

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

    static bool WriteAllConsoleInput(IntPtr h, INPUT_RECORD[] records, out int totalWritten, out string error)
    {
        totalWritten = 0;
        error = "";
        int offset = 0;
        const int batchSize = 64;

        while (offset < records.Length)
        {
            int len = Math.Min(batchSize, records.Length - offset);
            var batch = new INPUT_RECORD[len];
            Array.Copy(records, offset, batch, 0, len);

            int written;
            bool ok = WriteConsoleInputW(h, batch, batch.Length, out written);
            if (!ok)
            {
                error = "Write failed, code=" + Marshal.GetLastWin32Error();
                return false;
            }
            if (written <= 0)
            {
                error = "Write accepted 0 input records";
                return false;
            }

            offset += written;
            totalWritten += written;
        }

        return true;
    }

    private static IntPtr OpenConIn()
    {
        return CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    }

    public static string InjectText(int pid, string text)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            return "ERR:AttachConsole failed, code=" + Marshal.GetLastWin32Error();

        IntPtr h = OpenConIn();
        if (h == IntPtr.Zero || h == new IntPtr(-1))
        { FreeConsole(); return "ERR:OpenConIn failed, code=" + Marshal.GetLastWin32Error(); }

        var ev = new List<INPUT_RECORD>();
        string[] lines = text.Replace("\r\n", "\n").Split('\n');

        for (int i = 0; i < lines.Length; i++)
        {
            if (i > 0) // Ctrl+Enter 换行 (Claude Code)
            {
                ev.Add(K(true,  VK_CONTROL, '\0', LEFT_CTRL_PRESSED));
                ev.Add(K(true,  VK_RETURN,  '\r', LEFT_CTRL_PRESSED));
                ev.Add(K(false, VK_RETURN,  '\r', LEFT_CTRL_PRESSED));
                ev.Add(K(false, VK_CONTROL, '\0', 0));
            }
            foreach (char c in lines[i])
            {
                ev.Add(K(true,  0, c, 0));
                ev.Add(K(false, 0, c, 0));
            }
        }

        var arr = ev.ToArray();
        int wText;
        string writeError;
        bool ok = WriteAllConsoleInput(h, arr, out wText, out writeError);
        if (!ok)
        {
            CloseHandle(h);
            FreeConsole();
            return "ERR:" + writeError;
        }

        Thread.Sleep(120);

        var submit = new INPUT_RECORD[] {
            K(true,  VK_RETURN, '\r', 0),
            K(false, VK_RETURN, '\r', 0)
        };
        int wSubmit;
        ok = WriteAllConsoleInput(h, submit, out wSubmit, out writeError);
        CloseHandle(h);
        FreeConsole();
        return ok ? "ok:" + (wText + wSubmit) : "ERR:" + writeError;
    }

    public static string InjectKey(int pid, string keyName)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            return "ERR:AttachConsole failed, code=" + Marshal.GetLastWin32Error();

        IntPtr h = OpenConIn();
        if (h == IntPtr.Zero || h == new IntPtr(-1))
        { FreeConsole(); return "ERR:OpenConIn failed, code=" + Marshal.GetLastWin32Error(); }

        List<INPUT_RECORD> ev = new List<INPUT_RECORD>();
        keyName = keyName.ToLower();

        if (keyName == "shifttab") {
            ev.Add(K(true,  VK_SHIFT, '\0', SHIFT_PRESSED));
            ev.Add(K(true,  VK_TAB,   '\t', SHIFT_PRESSED));
            ev.Add(K(false, VK_TAB,   '\t', SHIFT_PRESSED));
            ev.Add(K(false, VK_SHIFT, '\0', 0));
        } else {
            short vk = 0;
            char ch = '\0';
            switch (keyName) {
                case "up": vk = VK_UP; break;
                case "down": vk = VK_DOWN; break;
                case "left": vk = VK_LEFT; break;
                case "right": vk = VK_RIGHT; break;
                case "space": vk = VK_SPACE; ch = ' '; break;
                case "tab": vk = VK_TAB; ch = '\t'; break;
                case "enter": vk = VK_RETURN; ch = '\r'; break;
                case "esc": vk = VK_ESCAPE; break;
                default: return "ERR:Unknown key " + keyName;
            }
            ev.Add(K(true, vk, ch, 0));
            ev.Add(K(false, vk, ch, 0));
        }

        var arr = ev.ToArray();
        int w;
        string writeError;
        bool ok = WriteAllConsoleInput(h, arr, out w, out writeError);
        CloseHandle(h);
        FreeConsole();
        return ok ? "ok:" + w : "ERR:" + writeError;
    }
}
"@ -ReferencedAssemblies @()

if (-not [string]::IsNullOrEmpty($Key)) {
    $result = [ConsoleInjector]::InjectKey($TargetPid, $Key)
} else {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $text = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($text)) {
        Write-Output "ERR:empty input"
        exit 1
    }
    $result = [ConsoleInjector]::InjectText($TargetPid, $text)
}

Write-Output $result
if ($result.StartsWith("ERR:")) { exit 1 }
