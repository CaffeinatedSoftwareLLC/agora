# Pester 5+ tests for the Windows installer's decisions (docs/agent-boxes.md section 12.3).
# wsl.exe, Docker, downloads, the registry, prompts and the network are all mocked: nothing
# here touches WSL or Docker on the machine that runs them.
#
#   Invoke-Pester install/windows/tests

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot '..\lib\AgoraInstall.psm1'
    Import-Module $modulePath -Force

    # The fake machine: WSL present or not, its distros, which of them have Docker Engine
    # (Engines: dockerd installed and started by systemd, so running once the distro runs;
    # Stopped: installed but its service off), and every wsl.exe call made. Running a command in
    # a stopped distro boots it, which is recorded in Booted.
    function New-Fake {
        param([bool]$Wsl = $true, [object[]]$Distros = @(), [string[]]$Engines = @(), [string[]]$Answers = @(), [string[]]$EngineOff = @())
        $global:AgoraFake = @{
            Wsl = $Wsl
            Distros = [System.Collections.ArrayList]@($Distros)
            Engines = $Engines
            EngineOff = $EngineOff
            Booted = [System.Collections.ArrayList]@()
            Utf16 = $false
            Calls = [System.Collections.ArrayList]@()
            Answers = [System.Collections.Queue]::new()
            Prompts = [System.Collections.ArrayList]@()
            Telemetry = [System.Collections.ArrayList]@()
            LinuxArgs = $null
            State = @{}
        }
        foreach ($a in $Answers) { $global:AgoraFake.Answers.Enqueue($a) }
    }
    function D { param($Name, $State = 'Stopped', $Version = 2, [switch]$Default) [pscustomobject]@{ Name = $Name; State = $State; Version = $Version; Default = [bool]$Default } }

    function Set-Mocks {
        Mock -ModuleName AgoraInstall Write-Host { }
        Mock -ModuleName AgoraInstall Get-SystemInfo { [pscustomobject]@{ Build = 22631; Caption = 'Windows 11 Pro'; Version = '10.0.22631'; MemoryGB = 32; Virtualization = $true; Arch = 'AMD64' } }
        Mock -ModuleName AgoraInstall Get-InstallerState { $global:AgoraFake.State }
        Mock -ModuleName AgoraInstall Save-InstallerState { $global:AgoraFake.State = $State }
        Mock -ModuleName AgoraInstall Test-DockerDesktopInstalled { $false }
        Mock -ModuleName AgoraInstall Read-Answer {
            [void]$global:AgoraFake.Prompts.Add($Prompt)
            if ($global:AgoraFake.Answers.Count -gt 0) { return $global:AgoraFake.Answers.Dequeue() }
            return $Default
        }
        Mock -ModuleName AgoraInstall Invoke-Wsl {
            $f = $global:AgoraFake
            [void]$f.Calls.Add(($Arguments -join ' '))
            $first = $Arguments[0]
            if ($first -eq '--status') { return [pscustomobject]@{ ExitCode = $(if ($f.Wsl) { 0 } else { 1 }); Output = @() } }
            if ($first -eq '-l') {
                # Names only, as `wsl -l -q` and `wsl -l --running -q` print them; optionally the raw
                # UTF-16 bytes an older wsl.exe gives, and a localized message when there are none
                $names = if ($Arguments -contains '--running') { @($f.Distros | Where-Object { $_.State -eq 'Running' } | ForEach-Object { $_.Name }) } else { @($f.Distros | ForEach-Object { $_.Name }) }
                if ($names.Count -eq 0) { return [pscustomobject]@{ ExitCode = -1; Output = @('Es werden keine Distributionen ausgef' + [char]0xFC + 'hrt.') } }
                if ($f.Utf16) { $names = @($names | ForEach-Object { ([char]0xFEFF) + (($_.ToCharArray() | ForEach-Object { "$_`0" }) -join '') }) }
                return [pscustomobject]@{ ExitCode = 0; Output = $names }
            }
            if ($first -eq '--import') { [void]$f.Distros.Add((D $Arguments[1])); return [pscustomobject]@{ ExitCode = 0; Output = @() } }
            if ($first -eq '--terminate') { return [pscustomobject]@{ ExitCode = 0; Output = @() } }
            if ($first -eq '-d') {
                $name = $Arguments[1]
                $script = $Arguments[-1]
                $d = @($f.Distros | Where-Object { $_.Name -eq $name }) | Select-Object -First 1
                if ($d -and $d.State -ne 'Running') { [void]$f.Booted.Add($name); $d.State = 'Running' }
                if ($Arguments -contains 'wslpath') { return [pscustomobject]@{ ExitCode = 0; Output = @('/mnt/c/agora') } }
                if ($script -like '*command -v dockerd*') {
                    $state = if ($f.EngineOff -contains $name) { 'agora-engine-installed' } elseif ($f.Engines -contains $name) { 'agora-engine-running' } else { 'agora-engine-none' }
                    return [pscustomobject]@{ ExitCode = 0; Output = @($state) }
                }
                if ($script -like '*last-install-url*') { return [pscustomobject]@{ ExitCode = 0; Output = @($(if ($f.ContainsKey('Url')) { $f.Url } else { '' })) } }
                return [pscustomobject]@{ ExitCode = 0; Output = @() }
            }
            return [pscustomobject]@{ ExitCode = 1; Output = @("unexpected wsl call: $($Arguments -join ' ')") }
        }
        Mock -ModuleName AgoraInstall Get-LxssDistros { @($global:AgoraFake.Distros | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Version = $_.Version; Default = $_.Default } }) }
        Mock -ModuleName AgoraInstall Start-WslInstall { 0 }
        Mock -ModuleName AgoraInstall Register-ResumeAfterReboot { }
        Mock -ModuleName AgoraInstall Unregister-ResumeAfterReboot { }
        Mock -ModuleName AgoraInstall Restart-Machine { }
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { 'C:\fake\ubuntu-24.04.5-wsl-amd64.wsl' }
        Mock -ModuleName AgoraInstall Test-PortFree { $true }
        Mock -ModuleName AgoraInstall Invoke-LinuxInstaller { $global:AgoraFake.LinuxArgs = $Arguments; $global:AgoraFake.LinuxDistro = $Distro; $global:AgoraFake.LinuxRoot = $AsRoot; 0 }
        Mock -ModuleName AgoraInstall Register-KeepAlive { }
        Mock -ModuleName AgoraInstall Open-Browser { }
        Mock -ModuleName AgoraInstall Invoke-TelemetryPost { [void]$global:AgoraFake.Telemetry.Add(@{ Url = $Url; Json = $Json }) }
    }

    function Opt { param([hashtable]$Over = @{})
        $o = @{ NonInteractive = $true; Resume = $false; AllowWslInstall = $false; Telemetry = 'off'; Agent = 'claude'; Instance = ''; AdminUser = '';
                Existing = ''; ScriptPath = 'C:\agora\install\windows\install.ps1'; SourceDir = 'C:\agora'; Version = '0.9.0' }
        foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
        return $o
    }
    function Imported { @($global:AgoraFake.Calls | Where-Object { $_ -like '--import *' }) }
    function Probed { param($Name) @($global:AgoraFake.Calls | Where-Object { $_ -like "-d $Name --exec sh -c *dockerd*" }) }
    function DockerDesktopTouched { @($global:AgoraFake.Calls | Where-Object { $_ -match '(^| )-d docker-desktop' }) }
}

AfterAll {
    Remove-Variable -Name AgoraFake -Scope Global -ErrorAction SilentlyContinue
    Remove-Module AgoraInstall -ErrorAction SilentlyContinue
}

Describe 'fresh machine (WSL installed, no distro)' {
    BeforeEach { New-Fake -Wsl $true; Set-Mocks }

    It 'imports the Agora distro from the checked Ubuntu image and runs the Linux installer in it as root' {
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'done'
        $r.Distro | Should -Be 'Agora'
        Should -Invoke -ModuleName AgoraInstall Get-UbuntuWslImage -Times 1 -Exactly
        @(Imported).Count | Should -Be 1
        @(Imported)[0] | Should -BeLike '--import Agora * C:\fake\ubuntu-24.04.5-wsl-amd64.wsl --version 2'
        @($global:AgoraFake.Calls | Where-Object { $_ -like '*systemd=true*' }).Count | Should -Be 1
        $global:AgoraFake.LinuxDistro | Should -Be 'Agora'
        $global:AgoraFake.LinuxRoot | Should -BeTrue
        $global:AgoraFake.LinuxArgs | Should -Contain '--wsl'
        ($global:AgoraFake.LinuxArgs -join ' ') | Should -BeLike '*--source /mnt/c/agora*--telemetry off*--agent claude*--non-interactive*'
        $global:AgoraFake.State.CreatedDistro | Should -BeTrue
        Should -Invoke -ModuleName AgoraInstall Register-KeepAlive -Times 1 -Exactly -ParameterFilter { $Distro -eq 'Agora' }
        Should -Invoke -ModuleName AgoraInstall Open-Browser -Times 1 -Exactly -ParameterFilter { $Url -eq 'https://localhost' }
    }

    It 'passes the ports Windows has free (WSL forwards localhost)' {
        Mock -ModuleName AgoraInstall Test-PortFree { $Port -notin @(80, 443, 3000) }
        $r = Invoke-AgoraInstall -Options (Opt)
        ($global:AgoraFake.LinuxArgs -join ' ') | Should -BeLike '*--http-port 8080 --https-port 8443 --api-port 3001*'
        $r.Url | Should -Be 'https://localhost:8443'
    }

    It 'stops before importing when the image fails its checksum' {
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { throw "the downloaded file doesn't match Canonical's SHA-256" }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'failed'
        $r.Step | Should -Be 'win.import'
        @(Imported).Count | Should -Be 0
        Should -Invoke -ModuleName AgoraInstall Invoke-LinuxInstaller -Times 0
    }

    It 'refuses a machine below the minimums' {
        Mock -ModuleName AgoraInstall Get-SystemInfo { [pscustomobject]@{ Build = 18363; Caption = 'Windows 10'; Version = '10.0.18363'; MemoryGB = 4; Virtualization = $false; Arch = 'AMD64' } }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'failed'
        $r.Step | Should -Be 'win.preflight'
        $r.Error | Should -Match '19041'
        $r.Error | Should -Match 'virtualization'
        $r.Error | Should -Match '8 GB'
        @($global:AgoraFake.Calls).Count | Should -Be 0
    }
}

Describe 'WSL missing' {
    BeforeEach { New-Fake -Wsl $false; Set-Mocks }

    It 'does nothing without consent' {
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'stopped'
        Should -Invoke -ModuleName AgoraInstall Start-WslInstall -Times 0
        Should -Invoke -ModuleName AgoraInstall Register-ResumeAfterReboot -Times 0
        Should -Invoke -ModuleName AgoraInstall Restart-Machine -Times 0
    }

    It 'asks, installs WSL, registers the resume and reboots only when the user says yes to both' {
        New-Fake -Wsl $false -Answers @('n', 'y', 'y')   # telemetry no, install WSL yes, restart yes
        $r = Invoke-AgoraInstall -Options (Opt @{ NonInteractive = $false; Telemetry = '' })
        $r.Status | Should -Be 'rebooting'
        Should -Invoke -ModuleName AgoraInstall Start-WslInstall -Times 1 -Exactly
        Should -Invoke -ModuleName AgoraInstall Register-ResumeAfterReboot -Times 1 -Exactly -ParameterFilter { $Command -like '*install.ps1*-Resume*-Telemetry "off"*' }
        Should -Invoke -ModuleName AgoraInstall Restart-Machine -Times 1 -Exactly
        $global:AgoraFake.State.Phase | Should -Be 'after-wsl'
        @(Imported).Count | Should -Be 0
    }

    It 'installs but leaves the restart to the user when they say no to it' {
        New-Fake -Wsl $false -Answers @('n', 'y', 'n')
        $r = Invoke-AgoraInstall -Options (Opt @{ NonInteractive = $false; Telemetry = '' })
        $r.Status | Should -Be 'needs-reboot'
        Should -Invoke -ModuleName AgoraInstall Register-ResumeAfterReboot -Times 1 -Exactly
        Should -Invoke -ModuleName AgoraInstall Restart-Machine -Times 0
    }

    It 'with -NonInteractive -AllowWslInstall installs WSL but never restarts by itself' {
        $r = Invoke-AgoraInstall -Options (Opt @{ AllowWslInstall = $true })
        $r.Status | Should -Be 'needs-reboot'
        Should -Invoke -ModuleName AgoraInstall Start-WslInstall -Times 1 -Exactly
        Should -Invoke -ModuleName AgoraInstall Restart-Machine -Times 0
    }
}

Describe 'reboot resume' {
    It 'removes the resume entry, keeps the earlier telemetry answer and carries on to the distro' {
        New-Fake -Wsl $true
        Set-Mocks
        $global:AgoraFake.State = @{ Telemetry = 'on'; Phase = 'after-wsl'; Distro = $null; CreatedDistro = $false }
        $o = Opt @{ Resume = $true; Telemetry = '' }
        $r = Invoke-AgoraInstall -Options $o
        $r.Status | Should -Be 'done'
        Should -Invoke -ModuleName AgoraInstall Unregister-ResumeAfterReboot -Times 1 -Exactly
        Should -Invoke -ModuleName AgoraInstall Start-WslInstall -Times 0
        $global:AgoraFake.LinuxArgs | Should -Contain 'on'
        @(Imported).Count | Should -Be 1
    }

    It 'stops with instructions when WSL still is not there after the reboot' {
        New-Fake -Wsl $false
        Set-Mocks
        $r = Invoke-AgoraInstall -Options (Opt @{ Resume = $true })
        $r.Status | Should -Be 'failed'
        $r.Step | Should -Be 'win.wsl'
        Should -Invoke -ModuleName AgoraInstall Start-WslInstall -Times 0
    }
}

Describe 'existing Docker Engine distro (one engine rule)' {
    BeforeEach {
        New-Fake -Wsl $true -Distros @((D 'Ubuntu' 'Running' -Default), (D 'Debian')) -Engines @('Ubuntu')
        Set-Mocks
    }

    It 'installs into it and never imports a second distro' {
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'done'
        $r.Distro | Should -Be 'Ubuntu'
        @(Imported).Count | Should -Be 0
        Should -Invoke -ModuleName AgoraInstall Get-UbuntuWslImage -Times 0
        $global:AgoraFake.LinuxDistro | Should -Be 'Ubuntu'
        $global:AgoraFake.LinuxRoot | Should -BeFalse
        $global:AgoraFake.State.CreatedDistro | Should -BeFalse
        Should -Invoke -ModuleName AgoraInstall Register-KeepAlive -ParameterFilter { $Distro -eq 'Ubuntu' }
    }

    It 'stops, still without importing, when the user declines to use it' {
        New-Fake -Wsl $true -Distros @((D 'Ubuntu' 'Running' -Default)) -Engines @('Ubuntu') -Answers @('n', 'n')
        $r = Invoke-AgoraInstall -Options (Opt @{ NonInteractive = $false; Telemetry = '' })
        $r.Status | Should -Be 'stopped'
        @(Imported).Count | Should -Be 0
        Should -Invoke -ModuleName AgoraInstall Invoke-LinuxInstaller -Times 0
    }

    It 'prefers the installer''s own Agora distro when both run an engine' {
        New-Fake -Wsl $true -Distros @((D 'Ubuntu' 'Running' -Default), (D 'Agora' 'Running')) -Engines @('Ubuntu', 'Agora')
        $global:AgoraFake.State = @{ CreatedDistro = $true }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Distro | Should -Be 'Agora'
        $global:AgoraFake.LinuxRoot | Should -BeTrue
        @(Imported).Count | Should -Be 0
    }

    It 'does not boot its own stopped Agora distro while another distro runs an engine' {
        New-Fake -Wsl $true -Distros @((D 'Ubuntu' 'Running' -Default), (D 'Agora')) -Engines @('Ubuntu', 'Agora')
        $global:AgoraFake.State = @{ CreatedDistro = $true }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Distro | Should -Be 'Ubuntu'
        @($global:AgoraFake.Booted) | Should -Not -Contain 'Agora'
        @(Imported).Count | Should -Be 0
    }

    It 'skips WSL 1 distros' {
        New-Fake -Wsl $true -Distros @((D 'Old' 'Stopped' 1)) -Engines @('Old')
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Distro | Should -Be 'Agora'
        @(Imported).Count | Should -Be 1
    }
}

Describe 'Docker Desktop present' {
    It 'ignores its distros, never runs anything in them, and imports Agora' {
        New-Fake -Wsl $true -Distros @((D 'docker-desktop' 'Running'), (D 'docker-desktop-data' 'Running'), (D 'Ubuntu' -Default)) -Engines @('docker-desktop')
        Set-Mocks
        Mock -ModuleName AgoraInstall Test-DockerDesktopInstalled { $true }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Status | Should -Be 'done'
        $r.Distro | Should -Be 'Agora'
        @(DockerDesktopTouched).Count | Should -Be 0
        @(Imported).Count | Should -Be 1
    }
}

Describe 'telemetry' {
    BeforeEach { New-Fake -Wsl $true; Set-Mocks }

    It 'off: a failed install sends nothing' {
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { throw 'network down' }
        $r = Invoke-AgoraInstall -Options (Opt @{ Telemetry = 'off' })
        $r.Status | Should -Be 'failed'
        Should -Invoke -ModuleName AgoraInstall Invoke-TelemetryPost -Times 0
    }

    It 'off by default without a terminal, and nothing is sent' {
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { throw 'network down' }
        $r = Invoke-AgoraInstall -Options (Opt @{ Telemetry = '' })
        $global:AgoraFake.Prompts.Count | Should -Be 0
        Should -Invoke -ModuleName AgoraInstall Invoke-TelemetryPost -Times 0
    }

    It 'asks with default no' {
        New-Fake -Wsl $true -Answers @('')
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { throw 'network down' }
        Invoke-AgoraInstall -Options (Opt @{ NonInteractive = $false; Telemetry = '' }) | Out-Null
        Should -Invoke -ModuleName AgoraInstall Invoke-TelemetryPost -Times 0
        Should -Invoke -ModuleName AgoraInstall Write-Host -ParameterFilter { "$Object" -like 'Send one anonymous report when this install finishes?*No names, addresses, IPs or IDs are kept. `[y/N`]*' }
    }

    It 'on: one report with exactly the five fields for a Windows-side failure' {
        Mock -ModuleName AgoraInstall Get-UbuntuWslImage { throw 'network down' }
        Invoke-AgoraInstall -Options (Opt @{ Telemetry = 'on' }) | Out-Null
        Should -Invoke -ModuleName AgoraInstall Invoke-TelemetryPost -Times 1 -Exactly
        $sent = $global:AgoraFake.Telemetry[0]
        $sent.Url | Should -Be 'https://push.agora.host/telemetry/v1/install'
        $body = $sent.Json | ConvertFrom-Json
        @($body.PSObject.Properties.Name) | Should -Be @('result', 'step', 'version', 'os', 'osVersion')
        $body.result | Should -Be 'failed'
        $body.step | Should -Be 'win.import'
        $body.os | Should -Be 'windows'
    }

    It 'on: no second report when the Linux installer failed (it reports its own)' {
        Mock -ModuleName AgoraInstall Invoke-LinuxInstaller { 1 }
        $r = Invoke-AgoraInstall -Options (Opt @{ Telemetry = 'on' })
        $r.Step | Should -Be 'win.linux'
        Should -Invoke -ModuleName AgoraInstall Invoke-TelemetryPost -Times 0
    }
}

Describe 'Select-UbuntuWslImage' {
    It 'picks the newest 24.04 point release for the architecture' {
        $sums = @'
c74833a55e525b1e99e1541509c566bb3e32bdb53bf27ea3347174364a57f47c *ubuntu-24.04.3-wsl-amd64.wsl
9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5 *ubuntu-24.04.4-wsl-amd64.wsl
97f3d7ffb032c3eb3b23d2c8be9cc76e60c2c1f2c0146ba5ba9fe01cafae0fd8 *ubuntu-24.04.5-live-server-amd64.iso
bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e *ubuntu-24.04.5-wsl-amd64.wsl
'@
        $img = Select-UbuntuWslImage -Sha256Sums $sums -Arch 'amd64'
        $img.FileName | Should -Be 'ubuntu-24.04.5-wsl-amd64.wsl'
        $img.Sha256 | Should -Be 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
        Select-UbuntuWslImage -Sha256Sums $sums -Arch 'arm64' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertTo-ResponseText' {
    # Canonical serves SHA256SUMS with no Content-Type, so Windows PowerShell 5.1 hands back bytes
    It 'decodes byte content as UTF-8 so the image list still matches' {
        $line = 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e *ubuntu-24.04.5-wsl-amd64.wsl'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$line`n")
        $text = & (Get-Module AgoraInstall) { param($c) ConvertTo-ResponseText $c } $bytes
        $text | Should -BeOfType [string]
        (Select-UbuntuWslImage -Sha256Sums $text -Arch 'amd64').FileName | Should -Be 'ubuntu-24.04.5-wsl-amd64.wsl'
    }

    It 'leaves string content as it is' {
        & (Get-Module AgoraInstall) { ConvertTo-ResponseText 'plain text' } | Should -Be 'plain text'
    }
}

Describe 'Get-UbuntuWslImage' {
    It 'deletes a download whose SHA-256 differs and refuses it' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("agora-pester-" + [guid]::NewGuid())
        Mock -ModuleName AgoraInstall Get-RemoteText { 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e *ubuntu-24.04.5-wsl-amd64.wsl' }
        Mock -ModuleName AgoraInstall Save-RemoteFile { Set-Content -Path $Path -Value 'not the image' }
        try {
            { Get-UbuntuWslImage -Dir $dir } | Should -Throw "*doesn't match Canonical's SHA-256*"
            Test-Path (Join-Path $dir 'ubuntu-24.04.5-wsl-amd64.wsl') | Should -BeFalse
            Should -Invoke -ModuleName AgoraInstall Save-RemoteFile -Times 1 -Exactly -ParameterFilter { $Url -eq 'https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl' }
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Get-WslDistros' {
    It 'takes names from wsl -l -q, running ones from --running, versions from the registry' {
        New-Fake -Distros @((D 'Ubuntu' 'Running' -Default), (D 'docker-desktop' 'Running'), (D 'Legacy' 'Stopped' 1))
        Set-Mocks
        $d = Get-WslDistros
        $d.Count | Should -Be 3
        ($d | Where-Object Name -eq 'Ubuntu').State | Should -Be 'Running'
        ($d | Where-Object Name -eq 'Ubuntu').Default | Should -BeTrue
        ($d | Where-Object Name -eq 'Legacy').State | Should -Be 'Stopped'
        ($d | Where-Object Name -eq 'Legacy').Version | Should -Be 1
        @($global:AgoraFake.Calls | Where-Object { $_ -like '-l -v*' }).Count | Should -Be 0
    }

    It 'reads UTF-16 output and a localized "none running" message' {
        New-Fake -Distros @((D 'Ubuntu' 'Stopped'), (D 'Agora' 'Stopped'))
        Set-Mocks
        $global:AgoraFake.Utf16 = $true
        $d = Get-WslDistros
        @($d | ForEach-Object Name) | Should -Be @('Ubuntu', 'Agora')
        @($d | Where-Object State -eq 'Running').Count | Should -Be 0
    }
}

Describe 'Get-LxssDistros (real registry, a temporary key)' {
    # A fresh WSL leaves an Lxss key with no DefaultDistribution; strict mode must not throw
    BeforeEach {
        $script:lxss = "HKCU:\Software\AgoraInstallTests\Lxss-$([guid]::NewGuid().ToString('N'))"
        New-Item -Path $script:lxss -Force | Out-Null
    }
    AfterEach { Remove-Item -Path (Split-Path $script:lxss) -Recurse -Force -ErrorAction SilentlyContinue }

    It 'an Lxss key with no DefaultDistribution and no distros gives an empty list' {
        $d = & (Get-Module AgoraInstall) { param($k) Get-LxssDistros -Key $k } $script:lxss
        @($d).Count | Should -Be 0
    }

    It 'skips a subkey without DistributionName and reads one without Version as WSL 2' {
        New-Item -Path "$script:lxss\{a}" -Force | Out-Null
        $b = New-Item -Path "$script:lxss\{b}" -Force
        New-ItemProperty -Path $b.PSPath -Name DistributionName -Value 'Ubuntu' | Out-Null
        $d = & (Get-Module AgoraInstall) { param($k) Get-LxssDistros -Key $k } $script:lxss
        @($d).Count | Should -Be 1
        $d[0].Name | Should -Be 'Ubuntu'
        $d[0].Version | Should -Be 2
        $d[0].Default | Should -BeFalse
    }

    It 'marks the default distro when DefaultDistribution is set' {
        $b = New-Item -Path "$script:lxss\{b}" -Force
        New-ItemProperty -Path $b.PSPath -Name DistributionName -Value 'Ubuntu' | Out-Null
        New-ItemProperty -Path $b.PSPath -Name Version -Value 1 -PropertyType DWord | Out-Null
        New-ItemProperty -Path $script:lxss -Name DefaultDistribution -Value '{b}' | Out-Null
        $d = & (Get-Module AgoraInstall) { param($k) Get-LxssDistros -Key $k } $script:lxss
        $d[0].Default | Should -BeTrue
        $d[0].Version | Should -Be 1
    }
}

Describe 'one Docker engine: probing distros' {
    It 'a running engine wins and no stopped distro is booted' {
        New-Fake -Distros @((D 'Work' 'Running'), (D 'Ubuntu' 'Stopped' -Default), (D 'Agora' 'Stopped')) -Engines @('Work', 'Ubuntu', 'Agora')
        Set-Mocks
        Find-EngineDistro -Distros (Get-WslDistros) | Should -Be 'Work'
        $global:AgoraFake.Booted.Count | Should -Be 0
        @(Probed 'Ubuntu').Count | Should -Be 0
        @(Probed 'Agora').Count | Should -Be 0
    }

    It 'a running distro with Docker Engine installed but stopped is used before booting another' {
        New-Fake -Distros @((D 'Work' 'Running'), (D 'Ubuntu' 'Stopped' -Default)) -Engines @('Ubuntu') -EngineOff @('Work')
        Set-Mocks
        Find-EngineDistro -Distros (Get-WslDistros) | Should -Be 'Work'
        $global:AgoraFake.Booted.Count | Should -Be 0
    }

    It 'with no running engine, a stopped distro with Docker Engine is used (no import)' {
        New-Fake -Distros @((D 'Plain' 'Running'), (D 'Ubuntu' 'Stopped' -Default)) -Engines @('Ubuntu')
        Set-Mocks
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Distro | Should -Be 'Ubuntu'
        @(Imported).Count | Should -Be 0
        @($global:AgoraFake.Booted) | Should -Be @('Ubuntu')
    }

    It 'a distro with only the docker CLI (Docker Desktop integration) is not an engine' {
        New-Fake -Distros @((D 'Ubuntu' 'Running' -Default)) -Engines @()
        Set-Mocks
        Find-EngineDistro -Distros (Get-WslDistros) | Should -BeNullOrEmpty
    }

    It 'the probe and the install finder pass no double quotes through wsl.exe' {
        New-Fake -Distros @((D 'Ubuntu' 'Running' -Default)) -Engines @('Ubuntu')
        Set-Mocks
        Find-EngineDistro -Distros (Get-WslDistros) | Out-Null
        Find-AgoraInstalls -Distro 'Ubuntu' -ScriptWindowsPath 'C:\agora\install\lib\find-installs.sh' | Out-Null
        @($global:AgoraFake.Calls | Where-Object { $_ -like '-d *' }).Count | Should -BeGreaterThan 1
        @($global:AgoraFake.Calls | Where-Object { $_ -like '*"*' }).Count | Should -Be 0
        @($global:AgoraFake.Calls | Where-Object { $_ -like '-d Ubuntu --exec sh /mnt/c/agora' }).Count | Should -Be 1
    }
}

Describe 'after the Linux installer' {
    It 'opens the URL the Linux installer wrote (its ports may differ)' {
        New-Fake -Distros @((D 'Ubuntu' 'Running' -Default)) -Engines @('Ubuntu')
        Set-Mocks
        $global:AgoraFake.Url = 'https://localhost:16443'
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Url | Should -Be 'https://localhost:16443'
        Should -Invoke -ModuleName AgoraInstall Open-Browser -ParameterFilter { $Url -eq 'https://localhost:16443' }
    }
}

Describe 'Get-ResumeCommand' {
    It 'carries every answer to the run after the reboot' {
        $c = Get-ResumeCommand -ScriptPath 'C:\Program Files\Agora\install.ps1' -Options (Opt @{ Telemetry = 'on'; Agent = 'codex'; Instance = 'agora2'; AdminUser = 'eryk'; Existing = 'alongside'; AllowWslInstall = $true; SourceDir = 'C:\Agora src' })
        $c | Should -BeLike '*-File "C:\Program Files\Agora\install.ps1" -Resume*'
        foreach ($part in '-Telemetry "on"', '-Agent "codex"', '-Instance "agora2"', '-AdminUser "eryk"', '-Existing "alongside"', '-NonInteractive', '-AllowWslInstall', '-SourceDir "C:\Agora src"') {
            $c | Should -BeLike "*$part*"
        }
    }
}
