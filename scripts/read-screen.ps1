param([int]$TargetPid, [int]$LinesToRead = 20)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ConsoleReader
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, 
        IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(
        IntPtr hConsoleOutput, [Out] StringBuilder lpCharacter, uint nLength, COORD dwReadCoord, out uint lpNumberOfCharsRead);

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CONSOLE_SCREEN_BUFFER_INFO {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public ushort wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING = 3;

    public static string ReadScreen(int pid)
    {
        FreeConsole();
        if (!AttachConsole(pid)) return "ERR:AttachConsole failed";

        IntPtr h = CreateFileW("CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) { FreeConsole(); return "ERR:OpenConOut failed"; }

        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(h, out info)) { CloseHandle(h); FreeConsole(); return "ERR:GetBufferInfo failed"; }

        int width = info.dwSize.X;
        short top = info.srWindow.Top;
        short bottom = info.srWindow.Bottom;
        short cursorY = info.dwCursorPosition.Y;
        
        StringBuilder sb = new StringBuilder(width);
        List<string> lines = new List<string>();

        for (short y = top; y <= bottom; y++) {
            COORD coord = new COORD { X = 0, Y = y };
            uint read;
            sb.Clear();
            sb.Append(' ', width);
            if (ReadConsoleOutputCharacterW(h, sb, (uint)width, coord, out read)) {
                string line = sb.ToString(0, (int)read).TrimEnd(' ', '\0');
                lines.Add(line);
            }
        }

        CloseHandle(h);
        FreeConsole();
        
        // Remove trailing empty lines
        while (lines.Count > 0 && string.IsNullOrEmpty(lines[lines.Count - 1])) {
            lines.RemoveAt(lines.Count - 1);
        }
        
        // Return bottom 25 lines max to avoid huge message
        int maxRet = 25;
        int startIdx = lines.Count > maxRet ? lines.Count - maxRet : 0;
        
        StringBuilder result = new StringBuilder();
        for (int i = startIdx; i < lines.Count; i++) {
            result.AppendLine(lines[i]);
        }
        return result.ToString().TrimEnd();
    }
}
"@ -ReferencedAssemblies @()

$res = [ConsoleReader]::ReadScreen($TargetPid)
Write-Output $res
