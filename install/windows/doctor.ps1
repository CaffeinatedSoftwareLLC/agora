<#
.SYNOPSIS
    Agora doctor for Windows (docs/agent-boxes.md section 12.5).

.DESCRIPTION
    Checks Windows, WSL, the distro Agora runs in, its keep-alive task and the Windows-side
    ports, then runs install/doctor.sh inside the distro for Docker, gVisor, the stack and
    every box. Plain lines, no secrets. -Report shows the whole result and sends it to
    push.agora.host only if you answer yes.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install\windows\doctor.ps1 [-Distro Agora] [-Report]
#>
[CmdletBinding()]
param([string]$Distro = '', [switch]$Report)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\AgoraInstall.psm1') -Force

$lines = New-Object System.Collections.Generic.List[string]
$fails = 0
function Add-Line { param([string]$Text) $lines.Add((Protect-Text $Text)) }
function Pass { param([string]$Text) Add-Line "ok    $Text" }
function Fail { param([string]$Text) $script:fails++; Add-Line "FAIL  $Text" }
function Note { param([string]$Text) Add-Line "      $Text" }

function Protect-Text {
    # The same rules as src/lib/doctor.ts and install/doctor.sh
    param([string]$Text)
    $t = $Text
    $t = $t -replace '([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@', '$1<redacted>@'
    $t = $t -replace 'Bearer\s+\S+', 'Bearer <redacted>'
    $t = $t -replace '\b(ah|bot|sk|sk-ant|ghp|gho|ghs|ghu|github_pat)[_-][A-Za-z0-9._-]{8,}', '<redacted-token>'
    $t = $t -replace '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', '<redacted-jwt>'
    $t = $t -replace '\b[0-9a-fA-F]{32,}\b', '<redacted-hex>'
    $t = $t -replace '[A-Za-z0-9+_]{40,}={0,2}', '<redacted>'
    $t = $t -replace '\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*)=\S+', '$1=<redacted>'
    return $t
}

$lines.Add('# Agora doctor (Windows)')
Add-Line "generated: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"

$lines.Add(''); $lines.Add('## Windows')
$info = Get-SystemInfo
Add-Line "windows: $($info.Caption) build $($info.Build) ($($info.Arch)), memory $($info.MemoryGB) GB"
foreach ($p in (Test-Preflight -Info $info)) { Fail $p }
if (Test-DockerDesktopInstalled) { Note 'Docker Desktop is installed (not used by Agora; its WSL integration must be off for the Agora distro)' }
foreach ($port in 80, 443, 3000) {
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($l.Count -gt 0) {
        $owner = (Get-Process -Id $l[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Note "port ${port}: in use by $owner"
    } else { Note "port ${port}: free on Windows" }
}

$lines.Add(''); $lines.Add('## WSL')
if (-not (Test-WslInstalled)) {
    Fail 'WSL is not installed (wsl --install --no-distribution)'
} else {
    $v = Invoke-Wsl '--version'
    Add-Line (($v.Output | Select-Object -First 2) -join '; ')
    $distros = Get-WslDistros
    foreach ($d in $distros) { Add-Line "distro $($d.Name): $($d.State), WSL $($d.Version)$(if ($d.Default) { ', default' })" }
    $state = Get-InstallerState
    if (-not $Distro) { $Distro = if ($state.ContainsKey('Distro') -and $state.Distro) { $state.Distro } else { Find-EngineDistro -Distros $distros } }
    if (-not $Distro) {
        Fail 'no WSL distro with Docker Engine was found'
    } else {
        Add-Line "Agora distro: $Distro$(if ($state.ContainsKey('CreatedDistro') -and $state.CreatedDistro) { ' (created by the installer)' })"
        $sd = Invoke-Wsl '-d' $Distro '--exec' 'sh' '-c' '[ -d /run/systemd/system ] && echo on || echo off'
        if ($sd.Output -contains 'on') { Pass 'systemd on' } else { Fail 'systemd is off in the distro ([boot] systemd=true in /etc/wsl.conf)' }
        $task = Get-ScheduledTask -TaskName (Get-KeepAliveTaskName -Distro $Distro) -ErrorAction SilentlyContinue
        if ($task) { if ($task.State -eq 'Running') { Pass "keep-alive task running" } else { Fail "keep-alive task is $($task.State)" } }
        else { Fail "no keep-alive task '$(Get-KeepAliveTaskName -Distro $Distro)' (the distro stops a minute after its last window closes)" }

        $asRoot = $Distro -eq 'Agora'
        $dirs = Find-AgoraInstalls -Distro $Distro -ScriptWindowsPath (Join-Path $PSScriptRoot '..\lib\find-installs.sh') -AsRoot $asRoot
        if ($dirs.Count -eq 0) { Fail 'no Agora install found in the distro (no api container)' }
        foreach ($dir in $dirs) {
            $lines.Add(''); $lines.Add("## Inside $Distro ($dir)")
            $r = Invoke-Wsl '-d' $Distro '--exec' 'bash' "$dir/install/doctor.sh" '--dir' $dir
            foreach ($l in $r.Output) { $lines.Add((Protect-Text $l)) }
            if ($r.ExitCode -ne 0) { $fails++ }
        }
    }
}

$lines.Add('')
$lines.Add($(if ($fails -eq 0) { 'result: every check passed' } else { "result: $fails check(s) FAILED" }))
$text = $lines -join "`n"
Write-Host $text

if ($Report) {
    $a = Read-Host 'Send the report above to https://push.agora.host? [y/N]'
    if ($a -match '^(y|yes)$') {
        $version = 'unknown'
        try { $version = (Get-Content -Raw (Join-Path $PSScriptRoot '..\..\package.json') | ConvertFrom-Json).version } catch { }
        $body = @{ report = $text; version = [string]$version; os = 'windows' } | ConvertTo-Json -Compress
        try {
            $res = Invoke-RestMethod -Method Post -Uri 'https://push.agora.host/telemetry/v1/problem' -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 -UseBasicParsing
            Write-Host "Sent. Report id: $($res.reportId) (quote it in an issue)"
        } catch {
            Write-Host 'Could not send it. Paste the report above into an issue instead.'
        }
    }
}
if ($fails -eq 0) { exit 0 } else { exit 1 }
