<#
.SYNOPSIS
    Agora installer for Windows 10 2004+ and 11 (docs/agent-boxes.md section 12.2, docs/installing.md).

.DESCRIPTION
    Installs WSL if it is missing (with your consent, once as administrator, then a restart
    after which it continues by itself), finds the WSL distro that already runs Docker Engine
    or imports one named "Agora" from Canonical's Ubuntu 24.04 WSL image, runs the Linux
    installer inside it, keeps the distro running with a scheduled task and opens Agora in
    your browser. It never uses the Microsoft Store and never changes Docker Desktop.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install\windows\install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install\windows\install.ps1 -NonInteractive -AllowWslInstall -Agent claude -Telemetry off
#>
[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$Resume,
    [switch]$AllowWslInstall,
    [ValidateSet('', 'on', 'off')][string]$Telemetry = '',
    [ValidateSet('', 'claude', 'codex', 'none')][string]$Agent = '',
    [ValidatePattern('^$|^[a-z][a-z0-9-]{0,30}$')][string]$Instance = '',
    [string]$AdminUser = '',
    [ValidateSet('', 'upgrade', 'alongside', 'stop')][string]$Existing = '',
    # The Agora checkout or unpacked release to install (default: the one this script is in)
    [string]$SourceDir = ''
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\AgoraInstall.psm1') -Force

if (-not $SourceDir) { $SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not (Test-Path (Join-Path $SourceDir 'docker-compose.prod.yml'))) { throw "$SourceDir is not an Agora checkout" }
$version = 'unknown'
try { $version = (Get-Content -Raw (Join-Path $SourceDir 'package.json') | ConvertFrom-Json).version } catch { }

Write-Host "Agora $version installer for Windows"

$options = @{
    NonInteractive = [bool]$NonInteractive
    Resume = [bool]$Resume
    AllowWslInstall = [bool]$AllowWslInstall
    Telemetry = $Telemetry
    Agent = $Agent
    Instance = $Instance
    AdminUser = $AdminUser
    Existing = $Existing
    ScriptPath = $PSCommandPath
    SourceDir = $SourceDir
    Version = $version
}
$result = Invoke-AgoraInstall -Options $options
switch ($result.Status) {
    'done' { exit 0 }
    'rebooting' { exit 0 }
    'needs-reboot' { exit 0 }
    'stopped' { exit 0 }
    default {
        Write-Host ''
        Write-Host 'To see what is wrong: powershell -ExecutionPolicy Bypass -File install\windows\doctor.ps1'
        Write-Host 'To report it (you see the report before anything is sent): ... doctor.ps1 -Report'
        exit 1
    }
}
