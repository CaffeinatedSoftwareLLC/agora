# Pester 5+ tests for the Windows installer's decisions (docs/agent-boxes.md section 12.3).
# wsl.exe, Docker, downloads, the registry, prompts and the network are all mocked: nothing
# here touches WSL or Docker on the machine that runs them.
#
#   Invoke-Pester install/windows/tests

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot '..\lib\AgoraInstall.psm1'
    Import-Module $modulePath -Force

    # The fake machine: WSL present or not, its distros, which of them have Docker Engine,
    # and every wsl.exe call made
    function New-Fake {
        param([bool]$Wsl = $true, [object[]]$Distros = @(), [string[]]$Engines = @(), [string[]]$Answers = @())
        $global:AgoraFake = @{
            Wsl = $Wsl
            Distros = [System.Collections.ArrayList]@($Distros)
            Engines = $Engines
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
                $lines = @('  NAME            STATE           VERSION')
                foreach ($d in $f.Distros) { $lines += ('{0} {1,-15} {2,-15} {3}' -f $(if ($d.Default) { '*' } else { ' ' }), $d.Name, $d.State, $d.Version) }
                return [pscustomobject]@{ ExitCode = 0; Output = $lines }
            }
            if ($first -eq '--import') { [void]$f.Distros.Add((D $Arguments[1])); return [pscustomobject]@{ ExitCode = 0; Output = @() } }
            if ($first -eq '--terminate') { return [pscustomobject]@{ ExitCode = 0; Output = @() } }
            if ($first -eq '-d') {
                $name = $Arguments[1]
                $script = $Arguments[-1]
                if ($Arguments -contains 'wslpath') { return [pscustomobject]@{ ExitCode = 0; Output = @('/mnt/c/agora') } }
                if ($script -like '*command -v dockerd*') {
                    $has = $f.Engines -contains $name
                    return [pscustomobject]@{ ExitCode = 0; Output = @($(if ($has) { 'agora-engine-yes' } else { 'agora-engine-no' })) }
                }
                return [pscustomobject]@{ ExitCode = 0; Output = @() }
            }
            return [pscustomobject]@{ ExitCode = 1; Output = @("unexpected wsl call: $($Arguments -join ' ')") }
        }
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
        Should -Invoke -ModuleName AgoraInstall Register-ResumeAfterReboot -Times 1 -Exactly -ParameterFilter { $Command -like '*install.ps1*-Resume*-Telemetry off*' }
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

    It 'prefers the installer''s own Agora distro when it already has an engine' {
        New-Fake -Wsl $true -Distros @((D 'Ubuntu' 'Running' -Default), (D 'Agora')) -Engines @('Ubuntu', 'Agora')
        $global:AgoraFake.State = @{ CreatedDistro = $true }
        $r = Invoke-AgoraInstall -Options (Opt)
        $r.Distro | Should -Be 'Agora'
        $global:AgoraFake.LinuxRoot | Should -BeTrue
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
    It 'parses wsl -l -v, default marker included' {
        Mock -ModuleName AgoraInstall Invoke-Wsl { [pscustomobject]@{ ExitCode = 0; Output = @('  NAME                   STATE           VERSION', '* Ubuntu                 Running         2', '  docker-desktop         Stopped         2', '  Legacy                 Stopped         1') } }
        $d = Get-WslDistros
        $d.Count | Should -Be 3
        $d[0].Name | Should -Be 'Ubuntu'
        $d[0].Default | Should -BeTrue
        $d[2].Version | Should -Be 1
    }
}
