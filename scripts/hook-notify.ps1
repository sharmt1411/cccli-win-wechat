# hook-notify.ps1 — 独立 Hook 脚本：从 CC hook stdin 读取事件 → 写通知文件
# 由 Claude Code 的 Stop/Notification hook 触发，不阻塞 CC
# 参数 -ClaudeDir 标识触发来源的 Claude 配置目录
param(
    [string]$ClaudeDir = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$notifyDir = Join-Path $env:TEMP 'cc-wechat-notify'

try {
    # 读取 hook stdin
    $stdin = [Console]::OpenStandardInput()
    $sr = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
    $raw = $sr.ReadToEnd()
    $sr.Close()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

    $data = $raw | ConvertFrom-Json
    $evt = [string]$data.hook_event_name
    $cwd = [string]$data.cwd
    $project = if ($cwd) { Split-Path -Leaf $cwd } else { '' }
    $transcript = [string]$data.transcript_path

    if ($evt -eq 'Notification') {
        $action = if ($data.message) { [string]$data.message } else { '需要你的确认' }
    } else {
        $evt = 'Stop'
        $action = '执行完毕，等待指令'
    }

    # 从 transcript 提取信息
    $lastPrompt = ''
    $lastReply = ''
    $title = ''
    $sessionId = ''

    if ($transcript -and (Test-Path -LiteralPath $transcript)) {
        # 从文件名提取 sessionId
        $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($transcript)

        $lines = [System.IO.File]::ReadAllLines($transcript, [System.Text.Encoding]::UTF8)

        # 最后一条用户消息
        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or ($line -notmatch '"type"\s*:\s*"user"')) { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -ne 'user' -or -not $obj.message -or $obj.message.role -ne 'user') { continue }
            $c = $obj.message.content
            if ($c -is [string]) {
                $t = $c.Trim()
                if ($t.Length -gt 0 -and $t[0] -ne '<' -and -not $t.StartsWith('Caveat:')) {
                    $lastPrompt = $t
                    break
                }
            }
        }

        # 最后一条 assistant 回复
        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or ($line -notmatch '"type"\s*:\s*"assistant"')) { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -eq 'assistant' -and $obj.message -and $obj.message.role -eq 'assistant') {
                $c = $obj.message.content
                if ($c -is [string]) { $lastReply = $c }
                elseif ($c -is [array]) {
                    $lastReply = ($c | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
                }
                break
            }
        }

        # 会话标题
        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or ($line -notmatch '"type"\s*:\s*"summary"')) { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -eq 'summary' -and $obj.summary) { $title = [string]$obj.summary; break }
        }
    }

    # 截断
    if ($lastPrompt.Length -gt 200) { $lastPrompt = $lastPrompt.Substring(0, 200) + '...' }
    if ($lastReply.Length -gt 500) { $lastReply = $lastReply.Substring(0, 500) + '...' }
    if ($title.Length -gt 80) { $title = $title.Substring(0, 80) + '...' }

    # 查找 PID
    $pid = 0
    if ($sessionId -and $ClaudeDir) {
        $sessDir = Join-Path $ClaudeDir 'sessions'
        if (Test-Path $sessDir) {
            Get-ChildItem $sessDir -Filter '*.json' | ForEach-Object {
                try {
                    $s = Get-Content $_.FullName -Raw | ConvertFrom-Json
                    if ($s.sessionId -eq $sessionId) { $pid = [int]$s.pid }
                } catch {}
            }
        }
    }

    $payload = [ordered]@{
        event     = $evt
        action    = $action
        project   = $project
        title     = $title
        prompt    = $lastPrompt
        lastReply = $lastReply
        pid       = $pid
        sessionId = $sessionId
        claudeDir = $ClaudeDir
        timestamp = [long](Get-Date -UFormat %s) * 1000
    } | ConvertTo-Json -Compress

    # 写入通知目录
    if (-not (Test-Path $notifyDir)) { New-Item -ItemType Directory $notifyDir -Force | Out-Null }
    $outFile = Join-Path $notifyDir ([guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($outFile, $payload, (New-Object System.Text.UTF8Encoding($false)))

} catch {
    # Hook 不应阻塞 CC，静默失败
}
