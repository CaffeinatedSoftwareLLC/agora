<#
.SYNOPSIS
    Remove Agora from Windows (docs/agent-boxes.md section 9.5).

.DESCRIPTION
    Runs install/uninstall.sh inside the distro (containers and networks; volumes too with
    -Purge, after you type the install name), removes the keep-alive task, and removes the WSL
    distro only if the installer created it and you confirm. A distro you had before (one with
    your own Docker Engine) is never removed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install\windows\uninstall.ps1 [-Purge] [-Distro Agora]
#>
[CmdletBinding()]
param([string]$Distro = '', [switch]$Purge)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\AgoraInstall.psm1') -Force

$state = Get-InstallerState
if (-not $Distro) { $Distro = if ($state.ContainsKey('Distro') -and $state.Distro) { $state.Distro } else { '' } }
if (-not $Distro) { throw 'No Agora distro recorded; pass -Distro <name>' }
$created = $state.ContainsKey('CreatedDistro') -and [bool]$state.CreatedDistro -and ($Distro -eq 'Agora')
$asRoot = $Distro -eq 'Agora'

$find = 'docker ps -a --filter label=com.docker.compose.service=api --format "{{.Label \"com.docker.compose.project.working_dir\"}}" 2>/dev/null | sort -u'
$dirs = @((Invoke-Wsl '-d' $Distro '--exec' 'sh' '-c' $find).Output | Where-Object { $_ -match '^/' })
foreach ($dir in $dirs) {
    Write-Host "Removing the install in $Distro`:$dir"
    $wslArgs = @('-d', $Distro)
    if ($asRoot) { $wslArgs += @('-u', 'root') }
    $wslArgs += @('--exec', 'bash', "$dir/install/uninstall.sh", '--dir', $dir)
    if ($Purge) { $wslArgs += '--purge' }
    $env:WSL_UTF8 = '1'
    & wsl.exe @wslArgs
    if ($LASTEXITCODE -ne 0) { throw "uninstall.sh failed in $Distro ($dir)" }
}

$task = Get-KeepAliveTaskName -Distro $Distro
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Write-Host "Removed the scheduled task '$task'"
}

if ($created) {
    $marker = Invoke-Wsl '-d' $Distro '-u' 'root' '--exec' 'test' '-f' '/etc/agora-installer-distro'
    if ($marker.ExitCode -eq 0) {
        Write-Host ''
        Write-Host "The installer created the WSL distro '$Distro'. Removing it deletes everything inside it, including any volumes still there."
        $a = Read-Host "Type the distro name ($Distro) to remove it, or press Enter to keep it"
        if ($a -eq $Distro) {
            $r = Invoke-Wsl '--unregister' $Distro
            if ($r.ExitCode -ne 0) { throw "wsl --unregister failed: $($r.Output -join ' ')" }
            Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Agora\installer.json') -ErrorAction SilentlyContinue
            Write-Host "Removed the distro '$Distro'."
        } else {
            Write-Host "Kept the distro '$Distro'."
        }
    }
} else {
    Write-Host "The distro '$Distro' was there before Agora; it is kept."
}
