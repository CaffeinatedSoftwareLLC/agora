# Decision logic of the Windows installer (docs/agent-boxes.md section 12.2), as functions that the
# Pester tests in install/windows/tests drive with wsl.exe, Docker, downloads and prompts mocked.
# Every call that changes the machine goes through one small function here, so a test can see
# what would have happened.
#
# Rules this module keeps:
#   - One Docker engine: a WSL distro (other than Docker Desktop's) that has Docker Engine is
#     reused; a second engine distro is never created.
#   - No Microsoft Store, no change to Docker Desktop.
#   - WSL is installed, and the machine rebooted, only with the user's consent.

Set-StrictMode -Version 2.0

$script:StateDir = Join-Path $env:LOCALAPPDATA 'Agora'
$script:StateFile = Join-Path $script:StateDir 'installer.json'
$script:RunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$script:RunOnceName = 'AgoraInstallResume'
$script:DistroName = 'Agora'
$script:DistroMarker = '/etc/agora-installer-distro'
# Canonical's WSL images for Ubuntu 24.04 (noble): https://releases.ubuntu.com/noble/ lists
# ubuntu-24.04.N-wsl-amd64.wsl next to SHA256SUMS (checked 2026-11-04; 24.04.5 was the newest).
# cloud-images.ubuntu.com/wsl/noble/current/ no longer carries an image.
$script:UbuntuBase = 'https://releases.ubuntu.com/noble'
$script:TelemetryQuestion = @'
Send one anonymous report when this install finishes? It contains only:
  - whether the install succeeded, or the step it failed at
  - the Agora version
  - the operating system name and version

No names, addresses, IPs or IDs are kept. [y/N]
'@

# --- Thin wrappers (mocked in tests) ---

function Invoke-Wsl {
    # wsl.exe prints UTF-16 unless WSL_UTF8 is set; strip NULs in case an old WSL ignores it
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $env:WSL_UTF8 = '1'
    $out = & wsl.exe @Arguments 2>&1
    $code = $LASTEXITCODE
    $text = @($out | ForEach-Object { "$_" -replace "`0", '' })
    [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Read-Answer {
    param([string]$Prompt, [string]$Default = '')
    $a = Read-Host -Prompt $Prompt
    if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
    return $a.Trim()
}

function Write-Step { param([string]$Id, [string]$Text) Write-Host ''; Write-Host "[$Id] $Text" }
function Write-Ok { param([string]$Text) Write-Host "  ok  $Text" }

function Invoke-TelemetryPost {
    param([string]$Url, [string]$Json)
    # No user agent header beyond the default, no cookies; the collector keeps none of it
    Invoke-RestMethod -Method Post -Uri $Url -ContentType 'application/json' -Body $Json -TimeoutSec 10 -UseBasicParsing | Out-Null
}

function Get-SystemInfo {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = @(Get-CimInstance Win32_Processor)[0]
    [pscustomobject]@{
        Build = [int]$os.BuildNumber
        Caption = [string]$os.Caption
        Version = [string]$os.Version
        MemoryGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        # Either the firmware switch is on, or a hypervisor (Hyper-V/WSL) already runs
        Virtualization = [bool]($cpu.VirtualizationFirmwareEnabled -or $cs.HypervisorPresent)
        Arch = [string]$env:PROCESSOR_ARCHITECTURE
    }
}

function Test-DockerDesktopInstalled {
    (Test-Path (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')) -or
        (Test-Path 'HKLM:\SOFTWARE\Docker Inc.\Docker\1.0')
}

function Test-PortFree {
    param([int]$Port)
    $l = $null
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        $l.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($l) { $l.Stop() }
    }
}

function Start-WslInstall {
    # Asks for administrator rights once (UAC); no distribution, no Microsoft Store
    $p = Start-Process -FilePath 'wsl.exe' -ArgumentList @('--install', '--no-distribution') -Verb RunAs -Wait -PassThru
    return $p.ExitCode
}

function Register-ResumeAfterReboot {
    param([string]$Command)
    if (-not (Test-Path $script:RunOnceKey)) { New-Item -Path $script:RunOnceKey -Force | Out-Null }
    Set-ItemProperty -Path $script:RunOnceKey -Name $script:RunOnceName -Value $Command
}

function Unregister-ResumeAfterReboot {
    if (Test-Path $script:RunOnceKey) { Remove-ItemProperty -Path $script:RunOnceKey -Name $script:RunOnceName -ErrorAction SilentlyContinue }
}

function Restart-Machine { Restart-Computer -Force }

function Save-InstallerState {
    param([hashtable]$State)
    if (-not (Test-Path $script:StateDir)) { New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null }
    ($State | ConvertTo-Json -Depth 5) | Set-Content -Path $script:StateFile -Encoding UTF8
}

function Get-InstallerState {
    if (-not (Test-Path $script:StateFile)) { return @{} }
    $o = Get-Content -Raw -Path $script:StateFile | ConvertFrom-Json
    $h = @{}
    foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

function ConvertTo-ResponseText {
    # Windows PowerShell 5.1 returns Content as bytes when the server sends no text Content-Type
    # (Canonical's SHA256SUMS has none); decode those as UTF-8
    param($Content)
    if ($Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($Content) }
    return [string]$Content
}
function Get-RemoteText { param([string]$Url) ConvertTo-ResponseText (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60).Content }
function Save-RemoteFile {
    # Windows PowerShell 5.1's progress bar slows a large download many times over; hide it here only
    param([string]$Url, [string]$Path)
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -TimeoutSec 3600
}
function Get-FileSha256 { param([string]$Path) (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant() }

function Register-KeepAlive {
    # docs/getting-started.md, "Local stack on Windows", step 7, for this distro
    param([string]$Distro)
    $name = Get-KeepAliveTaskName -Distro $Distro
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless wsl.exe -d $Distro --exec sleep infinity"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $heal = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger @($trigger, $heal) -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $name
}

function Get-KeepAliveTaskName { param([string]$Distro) "WSL $Distro keep-alive (Agora stack)" }

function Open-Browser { param([string]$Url) Start-Process $Url }

# --- Decisions (pure, or only through the wrappers above) ---

function Test-Preflight {
    # Windows 10 2004 (build 19041) or later, virtualization on, 8 GB of memory
    param($Info)
    $problems = @()
    if ($Info.Build -lt 19041) { $problems += "Windows build $($Info.Build) is older than Windows 10 2004 (19041)" }
    if (-not $Info.Virtualization) { $problems += 'virtualization is off: turn on Intel VT-x / AMD-V (SVM) in the firmware settings' }
    if ($Info.MemoryGB -lt 8) { $problems += "$($Info.MemoryGB) GB of memory; Agora needs 8 GB" }
    if ($Info.Arch -ne 'AMD64') { $problems += "this installer supports x64 Windows only ($($Info.Arch)); Canonical publishes the Ubuntu 24.04 WSL image for amd64" }
    return , $problems
}

function Test-WslInstalled {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $false }
    $r = Invoke-Wsl '--status'
    return ($r.ExitCode -eq 0)
}

function ConvertFrom-WslText {
    # wsl.exe -l writes UTF-16 (WSL_UTF8 isn't honoured by every version): drop NULs, BOMs, blanks
    param([string[]]$Lines)
    $out = @()
    foreach ($l in $Lines) {
        $t = ("$l" -replace "`0", '' -replace [char]0xFEFF, '').Trim()
        if ($t) { $out += $t }
    }
    return , $out
}

function Get-WslDistroNames {
    # `wsl -l -q`: one name per line, the same in every Windows language. Non-zero without distros.
    $r = Invoke-Wsl '-l' '-q'
    if ($r.ExitCode -ne 0) { return , @() }
    return , (ConvertFrom-WslText $r.Output)
}

function Get-WslRunningNames {
    # `wsl -l --running -q`; non-zero (and a localized message) when none runs
    $r = Invoke-Wsl '-l' '--running' '-q'
    if ($r.ExitCode -ne 0) { return , @() }
    return , (ConvertFrom-WslText $r.Output)
}

function Get-RegValue($Item, [string]$Name) {
    # Strict mode throws on a missing property; a fresh WSL has an Lxss key without DefaultDistribution
    if ($null -eq $Item -or -not ($Item.PSObject.Properties.Name -contains $Name)) { return $null }
    return $Item.$Name
}

function Get-LxssDistros {
    # Versions and the default distro from the registry, which (unlike `wsl -l -v`) isn't localized
    param([string]$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss')
    $list = @()
    if (-not (Test-Path $Key)) { return , $list }
    $default = Get-RegValue (Get-ItemProperty -Path $Key -ErrorAction SilentlyContinue) 'DefaultDistribution'
    foreach ($k in Get-ChildItem -Path $Key -ErrorAction SilentlyContinue) {
        $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
        if (-not (Get-RegValue $p 'DistributionName')) { continue }
        $v = 2
        if ($null -ne (Get-RegValue $p 'Version')) { $v = [int]$p.Version }
        $list += [pscustomobject]@{ Name = [string]$p.DistributionName; Version = $v; Default = ($k.PSChildName -eq $default) }
    }
    return , $list
}

function Get-WslDistros {
    # Names from `wsl -l -q`, running ones from `wsl -l --running -q`, version and default from the registry
    $names = Get-WslDistroNames
    $running = Get-WslRunningNames
    $reg = Get-LxssDistros
    $list = @()
    foreach ($n in $names) {
        $r = @($reg | Where-Object { $_.Name -eq $n }) | Select-Object -First 1
        $list += [pscustomobject]@{
            Name = $n
            State = $(if ($running -contains $n) { 'Running' } else { 'Stopped' })
            Version = $(if ($r) { $r.Version } else { 2 })
            Default = $(if ($r) { [bool]$r.Default } else { $false })
        }
    }
    return , $list
}

function Test-IsDockerDesktopDistro { param([string]$Name) $Name -like 'docker-desktop*' }

function Get-DistroEngineState {
    # 'running' (dockerd runs in it), 'installed' (Docker Engine is there but stopped) or 'none'.
    # Docker Desktop's WSL integration adds only the CLI and a socket, so neither counts.
    # Runs a command in the distro: for a stopped distro that boots it, so only call it on a
    # stopped one when no running distro has an engine. No double quotes in the script: Windows
    # PowerShell 5.1 doesn't escape them for native programs.
    param([string]$Distro)
    $script = 'if command -v dockerd >/dev/null 2>&1; then if pidof dockerd >/dev/null 2>&1 || systemctl is-active --quiet docker 2>/dev/null; then echo agora-engine-running; else echo agora-engine-installed; fi; else echo agora-engine-none; fi'
    $r = Invoke-Wsl '-d' $Distro '--exec' 'sh' '-c' $script
    $o = ConvertFrom-WslText $r.Output
    if ($o -contains 'agora-engine-running') { return 'running' }
    if ($o -contains 'agora-engine-installed') { return 'installed' }
    return 'none'
}

function Find-EngineDistro {
    # The one Docker engine rule. Running distros are asked first; one with a running engine wins
    # and no stopped distro is booted (its own dockerd would start beside it). Only when no
    # running distro has a running engine: a running one with Docker Engine installed, then the
    # stopped ones (booting one starts no second engine, as none runs). The installer's own
    # distro first, then the default.
    param($Distros)
    $candidates = @($Distros | Where-Object { -not (Test-IsDockerDesktopDistro $_.Name) -and $_.Version -eq 2 })
    $order = { param($list) @($list | Sort-Object @{ Expression = { $_.Name -ne $script:DistroName } }, @{ Expression = { -not $_.Default } }, Name) }
    $running = & $order @($candidates | Where-Object { $_.State -eq 'Running' })
    $stopped = & $order @($candidates | Where-Object { $_.State -ne 'Running' })
    $installed = $null
    foreach ($d in $running) {
        $s = Get-DistroEngineState -Distro $d.Name
        if ($s -eq 'running') { return $d.Name }
        if ($s -eq 'installed' -and -not $installed) { $installed = $d.Name }
    }
    if ($installed) { return $installed }
    foreach ($d in $stopped) {
        if ((Get-DistroEngineState -Distro $d.Name) -ne 'none') { return $d.Name }
    }
    return $null
}

function Find-AgoraInstalls {
    # The folder of every Agora install in the distro, from install/lib/find-installs.sh (a script
    # in the release, so no quoting passes through wsl.exe)
    param([string]$Distro, [string]$ScriptWindowsPath, [bool]$AsRoot = $false)
    $sh = ConvertTo-WslPath -Distro $Distro -WindowsPath $ScriptWindowsPath
    $a = @('-d', $Distro)
    if ($AsRoot) { $a += @('-u', 'root') }
    $all = $a + @('--exec', 'sh', $sh)
    $r = Invoke-Wsl @all
    return , @((ConvertFrom-WslText $r.Output) | Where-Object { $_ -match '^/' })
}

function Select-UbuntuWslImage {
    # The newest ubuntu-24.04[.N]-wsl-<arch>.wsl in Canonical's SHA256SUMS, with its checksum
    param([string]$Sha256Sums, [string]$Arch = 'amd64')
    $best = $null
    foreach ($line in ($Sha256Sums -split "`r?`n")) {
        $m = [regex]::Match($line, '^([0-9a-f]{64}) \*?(ubuntu-24\.04(?:\.(\d+))?-wsl-' + [regex]::Escape($Arch) + '\.wsl)\s*$')
        if (-not $m.Success) { continue }
        $point = if ($m.Groups[3].Success) { [int]$m.Groups[3].Value } else { 0 }
        if ($null -eq $best -or $point -gt $best.Point) {
            $best = [pscustomobject]@{ FileName = $m.Groups[2].Value; Sha256 = $m.Groups[1].Value; Point = $point }
        }
    }
    return $best
}

function Get-UbuntuWslImage {
    # Downloads the image from Canonical and checks it against Canonical's SHA256SUMS.
    # (SHA256SUMS.gpg is not checked: stock Windows has no gpg; both come over HTTPS from Canonical.)
    param([string]$Dir)
    $sums = Get-RemoteText "$script:UbuntuBase/SHA256SUMS"
    $img = Select-UbuntuWslImage -Sha256Sums $sums -Arch 'amd64'
    if ($null -eq $img) { throw "no Ubuntu 24.04 WSL image listed in $script:UbuntuBase/SHA256SUMS" }
    if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
    $path = Join-Path $Dir $img.FileName
    if (-not ((Test-Path $path) -and ((Get-FileSha256 $path) -eq $img.Sha256))) {
        Save-RemoteFile "$script:UbuntuBase/$($img.FileName)" $path
    }
    $got = Get-FileSha256 $path
    if ($got -ne $img.Sha256) {
        Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
        throw "the downloaded $($img.FileName) doesn't match Canonical's SHA-256 ($got, expected $($img.Sha256)); not importing it"
    }
    return $path
}

function Import-AgoraDistro {
    # A distro named Agora from Canonical's image, with systemd on and root as its user
    param([string]$ImagePath, [string]$InstallRoot)
    $r = Invoke-Wsl '--import' $script:DistroName $InstallRoot $ImagePath '--version' '2'
    if ($r.ExitCode -ne 0) { throw "wsl --import failed: $($r.Output -join ' ')" }
    # printf, not a here-string: the text reaches sh as one argument with \n escapes
    $setup = "printf '[boot]\nsystemd=true\n[user]\ndefault=root\n' > /etc/wsl.conf && date -u +%Y-%m-%dT%H:%M:%SZ > $($script:DistroMarker)"
    $r = Invoke-Wsl '-d' $script:DistroName '-u' 'root' '--exec' 'sh' '-c' $setup
    if ($r.ExitCode -ne 0) { throw "could not configure the Agora distro: $($r.Output -join ' ')" }
    # systemd starts on the next boot of the distro
    Invoke-Wsl '--terminate' $script:DistroName | Out-Null
    $r = Invoke-Wsl '-d' $script:DistroName '-u' 'root' '--exec' 'sh' '-c' 'for i in 1 2 3 4 5 6 7 8 9 10; do [ -d /run/systemd/system ] && exit 0; sleep 1; done; exit 1'
    if ($r.ExitCode -ne 0) { throw 'systemd did not start in the Agora distro' }
}

function ConvertTo-WslPath {
    param([string]$Distro, [string]$WindowsPath)
    $r = Invoke-Wsl '-d' $Distro '--exec' 'wslpath' '-a' $WindowsPath
    if ($r.ExitCode -ne 0) { throw "wslpath failed for $WindowsPath" }
    return ($r.Output | Select-Object -Last 1).Trim()
}

function Get-FreePorts {
    # Windows-side ports: WSL forwards localhost, so a port Windows already uses can't be the stack's
    $taken = @()
    $pick = {
        param($start, $step)
        $p = $start
        for ($i = 0; $i -lt 50; $i++) {
            if (($taken -notcontains $p) -and (Test-PortFree -Port $p)) { return $p }
            $p += $step
        }
        throw "no free port from $start"
    }
    $http = & $pick 80 8000; $taken += $http
    $https = & $pick 443 8000; $taken += $https
    $api = & $pick 3000 1
    [pscustomobject]@{ Http = $http; Https = $https; Api = $api }
}

function Get-LinuxInstallerArgs {
    param([hashtable]$Options, $Ports, [string]$SourceWsl)
    $a = @('--wsl', '--source', $SourceWsl, '--http-port', "$($Ports.Http)", '--https-port', "$($Ports.Https)", '--api-port', "$($Ports.Api)", '--telemetry', $Options.Telemetry)
    foreach ($k in 'Instance', 'Agent', 'AdminUser', 'Existing') {
        if ($Options.ContainsKey($k) -and $Options[$k]) {
            $flag = switch ($k) { 'Instance' { '--instance' } 'Agent' { '--agent' } 'AdminUser' { '--admin-user' } 'Existing' { '--existing' } }
            $a += @($flag, [string]$Options[$k])
        }
    }
    if ($Options.ContainsKey('NonInteractive') -and $Options.NonInteractive) { $a += '--non-interactive' }
    return , $a
}

function Invoke-LinuxInstaller {
    # Runs in this console, so its questions reach the user
    param([string]$Distro, [bool]$AsRoot, [string[]]$Arguments, [string]$SourceWsl)
    $wslArgs = @('-d', $Distro)
    if ($AsRoot) { $wslArgs += @('-u', 'root') }
    $wslArgs += @('--exec', 'bash', "$SourceWsl/install/linux/install.sh") + $Arguments
    $env:WSL_UTF8 = '1'
    & wsl.exe @wslArgs
    return $LASTEXITCODE
}

function Send-InstallReport {
    # One POST when telemetry is on (docs/telemetry.md); nothing at all when it is off
    param([hashtable]$Options, [string]$Result, [string]$Step, $Info)
    if ($Options.Telemetry -ne 'on') { return $false }
    $body = [ordered]@{
        result = $Result
        step = if ($Step) { $Step } else { $null }
        version = [string]$Options.Version
        os = 'windows'
        osVersion = [string]$Info.Version
    }
    $url = if ($Options.ContainsKey('TelemetryUrl') -and $Options.TelemetryUrl) { $Options.TelemetryUrl } else { 'https://push.agora.host' }
    try {
        Invoke-TelemetryPost -Url "$url/telemetry/v1/install" -Json ($body | ConvertTo-Json -Compress)
    } catch {
        # A report that can't be sent changes nothing about the install
    }
    return $true
}

function Get-InstalledUrl {
    # The URL the Linux installer wrote: inside WSL it may have taken other ports than suggested
    param([string]$Distro, [bool]$AsRoot, $Ports)
    $a = @('-d', $Distro)
    if ($AsRoot) { $a += @('-u', 'root') }
    $all = $a + @('--exec', 'sh', '-c', 'cat $HOME/.agora/last-install-url')
    $r = Invoke-Wsl @all
    $u = @((ConvertFrom-WslText $r.Output) | Where-Object { $_ -match '^https://[A-Za-z0-9.-]+(:\d+)?$' }) | Select-Object -Last 1
    if ($r.ExitCode -eq 0 -and $u) { return $u }
    if ($Ports.Https -eq 443) { return 'https://localhost' }
    return "https://localhost:$($Ports.Https)"
}

function Get-ResumeCommand {
    param([string]$ScriptPath, [hashtable]$Options)
    # Every answer the first run was given, so the resumed run asks and does the same
    $parts = @('powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"", '-Resume')
    foreach ($k in 'Telemetry', 'Agent', 'Instance', 'AdminUser', 'Existing') {
        if ($Options.ContainsKey($k) -and $Options[$k]) { $parts += @("-$k", "`"$($Options[$k])`"") }
    }
    foreach ($k in 'NonInteractive', 'AllowWslInstall') {
        if ($Options.ContainsKey($k) -and $Options[$k]) { $parts += "-$k" }
    }
    if ($Options.ContainsKey('SourceDir') -and $Options.SourceDir) { $parts += @('-SourceDir', "`"$($Options.SourceDir)`"") }
    return ($parts -join ' ')
}

# --- The flow ---

function Invoke-AgoraInstall {
    <#
    Options: Telemetry (on|off|''), NonInteractive, Resume, Agent, Instance, AdminUser, Existing,
    ScriptPath (install.ps1), SourceDir (the Agora checkout or unpacked release), Version.
    Returns a result object: Status (done|rebooting|needs-reboot|stopped|failed), Step, Distro, Url.
    #>
    param([hashtable]$Options)
    $step = 'win.preflight'
    $info = $null
    $linuxRan = $false
    $state = Get-InstallerState
    try {
        Write-Step $step 'Checking Windows'
        $info = Get-SystemInfo
        $problems = Test-Preflight -Info $info
        if ($problems.Count -gt 0) { throw ($problems -join '; ') }
        Write-Ok "$($info.Caption) build $($info.Build), $($info.MemoryGB) GB"

        if ($Options.Resume) {
            Unregister-ResumeAfterReboot
            if (-not $Options.Telemetry -and $state.ContainsKey('Telemetry')) { $Options.Telemetry = $state.Telemetry }
        }

        $step = 'win.telemetry'
        if (-not $Options.Telemetry) {
            if ($Options.NonInteractive) { $Options.Telemetry = 'off' }
            else {
                Write-Host ''
                Write-Host $script:TelemetryQuestion
                $a = Read-Answer -Prompt '>' -Default 'n'
                $Options.Telemetry = if ($a -match '^(y|yes)$') { 'on' } else { 'off' }
            }
        }
        Write-Ok "telemetry $($Options.Telemetry)"

        $step = 'win.wsl'
        Write-Step $step 'WSL'
        if (-not (Test-WslInstalled)) {
            if ($Options.Resume) { throw 'WSL is still not available after the reboot; run wsl --install --no-distribution yourself, then this installer again' }
            $consent = $Options.NonInteractive -and $Options.ContainsKey('AllowWslInstall') -and $Options.AllowWslInstall
            if (-not $consent -and -not $Options.NonInteractive) {
                $consent = (Read-Answer -Prompt 'WSL is not installed. Install it now (needs administrator rights once, then a restart)? [y/N]' -Default 'n') -match '^(y|yes)$'
            }
            if (-not $consent) {
                Write-Host '  Not installing WSL. To install it yourself: wsl --install --no-distribution (as administrator), restart, then run this installer again.'
                return [pscustomobject]@{ Status = 'stopped'; Step = $step; Distro = $null; Url = $null }
            }
            $code = Start-WslInstall
            if ($code -ne 0) { throw "wsl --install --no-distribution exited with $code" }
            $step = 'win.reboot'
            Save-InstallerState @{ Telemetry = $Options.Telemetry; Phase = 'after-wsl'; Distro = $null; CreatedDistro = $false }
            Register-ResumeAfterReboot -Command (Get-ResumeCommand -ScriptPath $Options.ScriptPath -Options $Options)
            $reboot = $false
            if (-not $Options.NonInteractive) {
                $reboot = (Read-Answer -Prompt 'WSL is installed and needs a restart. The installer continues after you log in again. Restart now? [y/N]' -Default 'n') -match '^(y|yes)$'
            }
            if ($reboot) {
                Restart-Machine
                return [pscustomobject]@{ Status = 'rebooting'; Step = $step; Distro = $null; Url = $null }
            }
            Write-Host '  Restart Windows when you are ready; the installer continues after you log in.'
            return [pscustomobject]@{ Status = 'needs-reboot'; Step = $step; Distro = $null; Url = $null }
        }
        Write-Ok 'WSL is installed'

        $step = 'win.distro'
        Write-Step $step 'One Docker engine: looking for a WSL distro that already has one'
        if (Test-DockerDesktopInstalled) { Write-Host '  Docker Desktop is installed. It is not used or changed. If its WSL integration is on for the distro below, turn it off there (Settings > Resources > WSL integration).' }
        $distros = Get-WslDistros
        $engine = Find-EngineDistro -Distros $distros
        $asRoot = $false
        $created = $false
        if ($engine) {
            $use = $true
            if ($engine -ne $script:DistroName -and -not $Options.NonInteractive) {
                $use = (Read-Answer -Prompt "The WSL distro '$engine' already runs Docker Engine. Install Agora into it (no second engine is started)? [Y/n]" -Default 'y') -match '^(y|yes)$'
            }
            if (-not $use) {
                Write-Host "  Stopped: a second Docker engine in another distro would fight '$engine' (ports, the docker socket). Uninstall it from '$engine' or install there."
                return [pscustomobject]@{ Status = 'stopped'; Step = $step; Distro = $engine; Url = $null }
            }
            $distro = $engine
            $asRoot = ($engine -eq $script:DistroName)
            $created = ($engine -eq $script:DistroName) -and $state.ContainsKey('CreatedDistro') -and [bool]$state.CreatedDistro
            Write-Ok "using '$distro'"
        } elseif (@($distros | Where-Object { $_.Name -eq $script:DistroName }).Count -gt 0) {
            # A distro an earlier run imported, before Docker was in it
            $distro = $script:DistroName
            $asRoot = $true
            $created = $state.ContainsKey('CreatedDistro') -and [bool]$state.CreatedDistro
            Write-Ok "using the existing '$distro' distro"
        } else {
            $step = 'win.import'
            Write-Step $step "Importing a distro '$($script:DistroName)' from Canonical's Ubuntu 24.04 WSL image"
            $image = Get-UbuntuWslImage -Dir (Join-Path $script:StateDir 'images')
            Import-AgoraDistro -ImagePath $image -InstallRoot (Join-Path $script:StateDir 'wsl')
            $distro = $script:DistroName
            $asRoot = $true
            $created = $true
            Save-InstallerState @{ Telemetry = $Options.Telemetry; Phase = 'distro'; Distro = $distro; CreatedDistro = $true }
            Write-Ok "imported '$distro' with systemd on"
        }

        $step = 'win.linux'
        Write-Step $step "Running the Linux installer inside '$distro'"
        $ports = Get-FreePorts
        $src = ConvertTo-WslPath -Distro $distro -WindowsPath $Options.SourceDir
        $linuxArgs = Get-LinuxInstallerArgs -Options $Options -Ports $ports -SourceWsl $src
        $linuxRan = $true
        $code = Invoke-LinuxInstaller -Distro $distro -AsRoot $asRoot -Arguments $linuxArgs -SourceWsl $src
        if ($code -ne 0) { throw "the Linux installer failed (exit $code); its message above names the step" }
        Save-InstallerState @{ Telemetry = $Options.Telemetry; Phase = 'installed'; Distro = $distro; CreatedDistro = $created }

        $step = 'win.keepalive'
        Write-Step $step 'Keeping the distro running (scheduled task, no administrator rights)'
        Register-KeepAlive -Distro $distro
        Write-Ok (Get-KeepAliveTaskName -Distro $distro)

        $url = Get-InstalledUrl -Distro $distro -AsRoot $asRoot -Ports $ports
        $step = 'win.browser'
        Open-Browser -Url $url
        Write-Host ''
        Write-Host "Agora is running at $url. Press Log in on your agent's box in Settings > Agents."
        return [pscustomobject]@{ Status = 'done'; Step = $null; Distro = $distro; Url = $url }
    } catch {
        Write-Host ''
        Write-Host "Failed at step ${step}: $($_.Exception.Message)" -ForegroundColor Red
        # The Linux installer reports its own failures; don't send a second report for them
        if (-not ($linuxRan -and $step -eq 'win.linux') -and $info) {
            Send-InstallReport -Options $Options -Result 'failed' -Step $step -Info $info | Out-Null
        }
        return [pscustomobject]@{ Status = 'failed'; Step = $step; Distro = $null; Url = $null; Error = $_.Exception.Message }
    }
}

Export-ModuleMember -Function *
