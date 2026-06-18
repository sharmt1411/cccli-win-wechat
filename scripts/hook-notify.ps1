# hook-notify.ps1 — CC hook -> write notify file
# Called via: powershell -Command "& ([scriptblock]::Create([IO.File]::ReadAllText(...))) -ClaudeDir ..."
param([string]$ClaudeDir = '')

$logFile = Join-Path $env:TEMP 'cc-wechat-hook.log'
function Log([string]$m) {
    try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch {}
}

function HasMenuOptions([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    return $text -match '(?m)^\s*(?:[>❯]\s*)?(?:[☐☑☒□■✓✔]|\[[ xX✓✔]\])?\s*\d{1,2}(?:[.)、:：])\s*(?:[☐☑☒□■✓✔]|\[[ xX✓✔]\])?'
}

function GetProp($obj, [string]$name, $default = $null) {
    if ($null -eq $obj) { return $default }
    if ($obj.PSObject.Properties.Name -contains $name) { return $obj.$name }
    return $default
}

function ConvertOption($opt) {
    if ($null -eq $opt) { return $null }
    if ($opt -is [string]) {
        return [ordered]@{ label = [string]$opt; description = ''; value = [string]$opt }
    }

    $label = [string](GetProp $opt 'label' (GetProp $opt 'text' (GetProp $opt 'name' (GetProp $opt 'value' ''))))
    $description = [string](GetProp $opt 'description' (GetProp $opt 'desc' ''))
    $value = [string](GetProp $opt 'value' $label)
    if ([string]::IsNullOrWhiteSpace($label) -and [string]::IsNullOrWhiteSpace($value)) { return $null }

    return [ordered]@{
        label       = $label
        description = $description
        value       = $value
    }
}

function ConvertQuestion($q) {
    if ($null -eq $q) { return $null }
    $opts = @()
    $rawOptions = GetProp $q 'options' (GetProp $q 'choices' (GetProp $q 'suggestions' @()))
    foreach ($opt in @($rawOptions)) {
        $converted = ConvertOption $opt
        if ($null -ne $converted) { $opts += $converted }
    }

    return [ordered]@{
        question    = [string](GetProp $q 'question' (GetProp $q 'prompt' ''))
        header      = [string](GetProp $q 'header' (GetProp $q 'title' ''))
        multiSelect = [bool](GetProp $q 'multiSelect' (GetProp $q 'multiselect' $false))
        options     = $opts
    }
}

function DescribeToolUse($tu) {
    $name = [string]$tu.name
    $input = $tu.input
    if ($null -eq $input) { return $name }

    if ($name -eq 'Bash') {
        $command = [string](GetProp $input 'command' '')
        $description = [string](GetProp $input 'description' '')
        if ($command -and $description) { return "$name ($command) - $description" }
        if ($command) { return "$name ($command)" }
        return $name
    }

    foreach ($prop in @('file_path', 'target_file', 'path', 'notebook_path')) {
        $value = [string](GetProp $input $prop '')
        if ($value) { return "$name ($value)" }
    }

    return $name
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
    $interaction = $null

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
                            $question = ''
                            if ($tu.input -and $tu.input.question) { $question = [string]$tu.input.question }

                            $questions = @()
                            if ($tu.input -and $tu.input.PSObject.Properties.Name -contains 'questions') {
                                foreach ($q in @($tu.input.questions)) {
                                    $convertedQuestion = ConvertQuestion $q
                                    if ($null -ne $convertedQuestion) { $questions += $convertedQuestion }
                                }
                            }

                            $options = @()
                            $header = ''
                            $multiSelect = $false
                            if ($questions.Count -gt 0) {
                                $question = [string]$questions[0]['question']
                                $header = [string]$questions[0]['header']
                                $multiSelect = [bool]$questions[0]['multiSelect']
                                $options = $questions[0]['options']
                            } else {
                                foreach ($prop in @('options', 'choices', 'suggestions')) {
                                    if ($tu.input -and $tu.input.PSObject.Properties.Name -contains $prop) {
                                        $rawOptions = $tu.input.$prop
                                        foreach ($opt in @($rawOptions)) {
                                            $convertedOption = ConvertOption $opt
                                            if ($null -ne $convertedOption) { $options += $convertedOption }
                                        }
                                        break
                                    }
                                }
                                $header = [string](GetProp $tu.input 'header' '')
                                $multiSelect = [bool](GetProp $tu.input 'multiSelect' (GetProp $tu.input 'multiselect' $false))
                            }

                            $interaction = [ordered]@{
                                type        = 'ask_user_question'
                                toolName    = [string]$tu.name
                                question    = $question
                                header      = $header
                                multiSelect = $multiSelect
                                options     = $options
                                questions   = $questions
                            }
                        } elseif (-not $interaction) {
                            $toolDesc = DescribeToolUse $tu
                            $interaction = [ordered]@{
                                type     = 'tool_permission'
                                toolName = [string]$tu.name
                                detail   = [string]$toolDesc
                                options  = @()
                            }
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
    $matchedSession = $false
    $sessionEntryPoint = ''
    $sessionKind = ''
    if ($sessionId -and $ClaudeDir) {
        $sessDir = Join-Path $ClaudeDir 'sessions'
        if (Test-Path $sessDir) {
            Get-ChildItem $sessDir -Filter '*.json' | ForEach-Object {
                try {
                    $s = Get-Content $_.FullName -Raw | ConvertFrom-Json
                    if ($s.sessionId -eq $sessionId) {
                        $matchedSession = $true
                        $procPid = [int]$s.pid
                        $sessionEntryPoint = [string](GetProp $s 'entrypoint' '')
                        $sessionKind = [string](GetProp $s 'kind' '')
                    }
                } catch {}
            }
        }
    }

    if ($matchedSession -and $sessionEntryPoint -ne 'cli') {
        Log "skip non-cli session sessionId=$sessionId entrypoint=$sessionEntryPoint kind=$sessionKind"
        exit 0
    }

    # 读取终端屏幕内容 (如果是需要用户操作的 Notification)
    $screenText = ""
    if ($evt -eq 'Notification' -and $procPid -gt 0) {
        try {
            $rsPath = Join-Path $PSScriptRoot 'read-screen.ps1'
            for ($attempt = 0; $attempt -lt 4; $attempt++) {
                if ($attempt -gt 0) { Start-Sleep -Milliseconds 300 }
                $screenText = powershell -NoProfile -ExecutionPolicy Bypass -File $rsPath -TargetPid $procPid
                if (HasMenuOptions $screenText) { break }
            }
        } catch {}
    }

    $payload = [ordered]@{
        event     = $evt
        action    = $action
        project   = $project
        cwd       = $cwd
        title     = $title
        prompt    = $lastPrompt
        lastReply = $lastReply
        interaction = $interaction
        screenText= $screenText
        pid       = $procPid
        sessionId = $sessionId
        entrypoint= $sessionEntryPoint
        kind      = $sessionKind
        claudeDir = $ClaudeDir
        timestamp = [long](Get-Date -UFormat %s) * 1000
    } | ConvertTo-Json -Compress -Depth 6

    if (-not (Test-Path $notifyDir)) { New-Item -ItemType Directory $notifyDir -Force | Out-Null }
    $outFile = Join-Path $notifyDir ([guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($outFile, $payload, (New-Object System.Text.UTF8Encoding($false)))

    Log "OK event=$evt project=$project file=$outFile"
} catch {
    Log "ERROR: $_"
}
