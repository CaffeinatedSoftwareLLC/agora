<#
.SYNOPSIS
    One-file Agora installer for Windows: downloads a release, checks it, runs its installer.

.DESCRIPTION
    Published as install.ps1 on every app release (and on the fixed agora-latest release) by
    .github/workflows/agora-release.yml. It downloads agora.tar.gz and agora.tar.gz.sha256 from
    that release, refuses to go on unless the SHA-256 matches, unpacks it under
    %LOCALAPPDATA%\Agora\src-<version> with the tar.exe Windows includes, and runs
    install\windows\install.ps1 from it with the same arguments (docs/installing.md).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Ref v0.4.0 -Agent claude -Telemetry off
#>
[CmdletBinding()]
param(
    # A release tag (v<version>), or latest
    [ValidatePattern('^(latest|v\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?)$')][string]$Ref = 'latest',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallerArgs = @()
)

$ErrorActionPreference = 'Stop'
$base = 'https://github.com/CaffeinatedSoftwareLLC/agora/releases/download'
$release = if ($Ref -eq 'latest') { "$base/agora-latest" } else { "$base/$Ref" }

$root = Join-Path $env:LOCALAPPDATA 'Agora'
$work = Join-Path $root ("download-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    Write-Host "Downloading Agora ($Ref)..."
    $tar = Join-Path $work 'agora.tar.gz'
    Invoke-WebRequest -Uri "$release/agora.tar.gz" -OutFile $tar -UseBasicParsing -TimeoutSec 3600
    $sums = (Invoke-WebRequest -Uri "$release/agora.tar.gz.sha256" -UseBasicParsing -TimeoutSec 60).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $expected = ($sums -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tar).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $expected -ne $actual) { throw 'The download does not match its SHA-256; nothing was installed.' }

    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tarExe)) { throw 'This Windows has no tar.exe (Windows 10 1803 or later has it).' }
    & $tarExe -xzf $tar -C $work
    if ($LASTEXITCODE -ne 0) { throw 'Unpacking the release failed.' }
    $unpacked = Join-Path $work 'agora'
    $version = (Get-Content -Raw (Join-Path $unpacked 'package.json') | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+') { throw 'The release has no version.' }

    $src = Join-Path $root "src-$version"
    if (Test-Path $src) { Remove-Item -Recurse -Force $src }
    Move-Item $unpacked $src
    Write-Host "Agora $version is in $src"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

& (Join-Path $src 'install\windows\install.ps1') -SourceDir $src @InstallerArgs
exit $LASTEXITCODE
