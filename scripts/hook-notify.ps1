# hook-notify.ps1 — CC hook -> write notify file
# Called via: powershell -Command "& ([scriptblock]::Create([IO.File]::ReadAllText(...))) -ClaudeDir ..."
param([string]$ClaudeDir = '')

$logFile = Join-Path $env:TEMP 'cc-wechat-hook.log'
function Log([string]$m) {
    try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch {}
}

$notifyDir = Join-Path $env:TEMP 'cc-wechat-notify'

try {
    # Read stdin - try multiple methods
    $raw = ''
    try {
        $stdin = [Console]::OpenStandardInput()
        $sr = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        $sr.Close()
    } catch {
        Log "stdin method 1 failed: $_"
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        # Fallback: try $input (pipeline)
        try { $raw = @($input) -join "`n" } catch {}
    }

    Log "raw_len=$($raw.Length)"
    if ([string]::IsNullOrWhiteSpace($raw)) { Log 'empty stdin'; exit 0 }

    $data = $raw | ConvertFrom-Json
    $evt = [string]$data.hook_event_name
    $cwd = [string]$data.cwd
    $project = if ($cwd) { Split-Path -Leaf $cwd } else { '' }
    $transcript = [string]$data.transcript_path

    $action = switch ($evt) {
        'Notification' { if ($data.message) { [string]$data.message } else { 'need_confirm' } }
        default { $evt = 'Stop'; 'done' }
    }

    # Extract info from transcript
    $lastPrompt = ''
    $lastReply = ''
    $title = ''
    $sessionId = ''

    if ($transcript -and (Test-Path -LiteralPath $transcript)) {
        $sessionId = [System.IO.Path]::GetFileNameWithoutExtension($transcript)
        $lines = [System.IO.File]::ReadAllLines($transcript, [System.Text.Encoding]::UTF8)

        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or $line -notmatch '"type"\s*:\s*"user"') { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -ne 'user' -or -not $obj.message -or $obj.message.role -ne 'user') { continue }
            $c = $obj.message.content
            if ($c -is [string] -and $c.Trim().Length -gt 0 -and $c.Trim()[0] -ne '<') {
                $lastPrompt = $c.Trim()
                break
            }
        }

        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or $line -notmatch '"type"\s*:\s*"assistant"') { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -eq 'assistant' -and $obj.message -and $obj.message.role -eq 'assistant') {
                $c = $obj.message.content
                if ($c -is [string]) { $lastReply = $c }
                elseif ($c -is [array]) {
                    # 1. 提取普通文本回复
                    $textArr = $c | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }
                    $lastReply = $textArr -join "`n"

                    # 2. 提取 Tool Use (AskUserQuestion 或 Permission)
                    $tools = $c | Where-Object { $_.type -eq 'tool_use' }
                    foreach ($tu in $tools) {
                        if ($tu.name -eq 'AskUserQuestion') {
                            $lastReply += "`n❓ 问题: " + $tu.input.question
                        } else {
                            $toolDesc = $tu.name
                            if ($tu.name -eq 'Bash' -and $tu.input.command) { 
                                $toolDesc += " (" + $tu.input.command + ")" 
                            } elseif ($tu.name -match 'File' -and $tu.input.target_file) { 
                                $toolDesc += " (" + $tu.input.target_file + ")" 
                            }
                            $lastReply += "`n🛡️ 请求授权工具: " + $toolDesc
                        }
                    }
                }
                break
            }
        }

        for ($i = $lines.Length - 1; $i -ge 0; $i--) {
            $line = $lines[$i]
            if (-not $line -or $line -notmatch '"type"\s*:\s*"summary"') { continue }
            try { $obj = $line | ConvertFrom-Json } catch { continue }
            if ($obj.type -eq 'summary' -and $obj.summary) { $title = [string]$obj.summary; break }
        }
    }

    if ($lastPrompt.Length -gt 200) { $lastPrompt = $lastPrompt.Substring(0, 200) + '...' }
    if ($lastReply.Length -gt 500) { $lastReply = $lastReply.Substring(0, 500) + '...' }
    if ($title.Length -gt 80) { $title = $title.Substring(0, 80) + '...' }

    # Find PID
    $procPid = 0
    if ($sessionId -and $ClaudeDir) {
        $sessDir = Join-Path $ClaudeDir 'sessions'
        if (Test-Path $sessDir) {
            Get-ChildItem $sessDir -Filter '*.json' | ForEach-Object {
                try {
                    $s = Get-Content $_.FullName -Raw | ConvertFrom-Json
                    if ($s.sessionId -eq $sessionId) { $procPid = [int]$s.pid }
                } catch {}
            }
        }
    }

    # 读取终端屏幕内容 (如果是需要用户操作的 Notification)
    $screenText = ""
    if ($evt -eq 'Notification' -and $procPid -gt 0) {
        try {
            $rsPath = Join-Path $PSScriptRoot 'read-screen.ps1'
            $screenText = powershell -NoProfile -ExecutionPolicy Bypass -File $rsPath -TargetPid $procPid
        } catch {}
    }

    $payload = [ordered]@{
        event     = $evt
        action    = $action
        project   = $project
        title     = $title
        prompt    = $lastPrompt
        lastReply = $lastReply
        screenText= $screenText
        pid       = $procPid
        sessionId = $sessionId
        claudeDir = $ClaudeDir
        timestamp = [long](Get-Date -UFormat %s) * 1000
    } | ConvertTo-Json -Compress

    if (-not (Test-Path $notifyDir)) { New-Item -ItemType Directory $notifyDir -Force | Out-Null }
    $outFile = Join-Path $notifyDir ([guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($outFile, $payload, (New-Object System.Text.UTF8Encoding($false)))

    Log "OK event=$evt project=$project file=$outFile"
} catch {
    Log "ERROR: $_"
}
