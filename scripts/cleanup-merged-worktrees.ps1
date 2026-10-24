<#
.SYNOPSIS
  Removes git worktrees (and their branches) whose branch is fully merged into main.

.DESCRIPTION
  Agent jobs each get a worktree under .worktrees/ or .claude/worktrees/. Without cleanup they
  pile up. A worktree's node_modules is usually a junction to a shared folder, and a forced
  `git worktree remove` can follow it and wipe the shared target. This script unlinks every
  junction/symlink inside the worktree first (the link only, never the target), confirms none are
  left, then removes the worktree WITHOUT --force and deletes its branch.

  Skipped, never touched:
    - the main checkout, worktrees outside this repo's .worktrees/ and .claude/worktrees/
    - detached HEADs, locked worktrees
    - branches not fully merged into the base (default origin/main)
    - worktrees with uncommitted or untracked changes (git status not clean)

  Dry run by default. Pass -Apply to remove.

.EXAMPLE
  powershell -File scripts/cleanup-merged-worktrees.ps1            # show what would go
  powershell -File scripts/cleanup-merged-worktrees.ps1 -Apply     # remove it
#>
param(
    [switch]$Apply,
    [string]$Base = 'origin/main'
)
$ErrorActionPreference = 'Stop'

$repo = (git rev-parse --show-toplevel).Trim()
$mainCheckout = (Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir).Trim()) -replace '\\', '/'
$roots = @("$mainCheckout/.worktrees/", "$mainCheckout/.claude/worktrees/") | ForEach-Object { $_.ToLower() }

git fetch --quiet --prune origin

# Parse `git worktree list --porcelain` into objects.
$worktrees = @()
$cur = $null
foreach ($line in (git worktree list --porcelain)) {
    if ($line -like 'worktree *') { if ($cur) { $worktrees += $cur }; $cur = [ordered]@{ Path = $line.Substring(9); Branch = $null; Locked = $false; Detached = $false } }
    elseif ($line -like 'branch refs/heads/*') { $cur.Branch = $line.Substring(18) }
    elseif ($line -like 'locked*') { $cur.Locked = $true }
    elseif ($line -eq 'detached') { $cur.Detached = $true }
}
if ($cur) { $worktrees += $cur }

function Get-Links([string]$dir) {
    # Junctions/symlinks up to 3 levels deep, without descending into them.
    $found = @()
    $queue = @(@{ P = $dir; D = 0 })
    while ($queue.Count) {
        $item = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
        foreach ($child in (Get-ChildItem -LiteralPath $item.P -Directory -Force -ErrorAction SilentlyContinue)) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { $found += $child.FullName }
            elseif ($item.D -lt 3 -and $child.Name -ne '.git') { $queue += @{ P = $child.FullName; D = $item.D + 1 } }
        }
    }
    return $found
}

# Folders other worktrees link to (shared node_modules): a worktree that contains one must stay,
# or removing it would delete the real folder behind everyone else's junction.
$linkTargets = @()
foreach ($w in $worktrees) {
    $wp = $w.Path -replace '/', '\'
    $spots = @(Join-Path $wp 'node_modules') + @(Get-ChildItem -LiteralPath $wp -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'node_modules' })
    foreach ($s in $spots) {
        $item = Get-Item -LiteralPath $s -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Target) {
            $linkTargets += (@($item.Target)[0] -replace '\\', '/').ToLower().TrimEnd('/')
        }
    }
}
$linkTargets = $linkTargets | Sort-Object -Unique

$candidates = @(); $skipped = @()
foreach ($w in $worktrees) {
    $p = ($w.Path -replace '\\', '/')
    $inRoots = $roots | Where-Object { $p.ToLower().StartsWith($_) }
    if (-not $inRoots) { continue }                                   # main checkout or outside the repo
    if ($w.Detached -or -not $w.Branch) { $skipped += "$p  (detached HEAD)"; continue }
    if ($w.Locked) { $skipped += "$p  (locked)"; continue }
    git merge-base --is-ancestor $w.Branch $Base 2>$null
    if ($LASTEXITCODE -ne 0) { $skipped += "$p  ($($w.Branch): not merged into $Base)"; continue }
    if (-not (Test-Path -LiteralPath $p)) { $candidates += [pscustomobject]@{ Path = $p; Branch = $w.Branch; Missing = $true }; continue }
    $dirty = git -C $p status --porcelain 2>$null
    if ($dirty) { $skipped += "$p  ($($w.Branch): uncommitted or untracked changes)"; continue }
    $shared = $linkTargets | Where-Object { $_.StartsWith($p.ToLower().TrimEnd('/') + '/') }
    if ($shared) { $skipped += "$p  ($($w.Branch): other worktrees link into it: $($shared -join ', '))"; continue }
    $candidates += [pscustomobject]@{ Path = $p; Branch = $w.Branch; Missing = $false }
}

Write-Host "Merged and clean, to remove: $($candidates.Count)"
$candidates | ForEach-Object { Write-Host "  $($_.Branch)  ->  $($_.Path)$(if ($_.Missing) { '  (folder already gone)' })" }
Write-Host "Skipped: $($skipped.Count)"
$skipped | ForEach-Object { Write-Host "  $_" }
if (-not $Apply) { Write-Host "`nDry run. Re-run with -Apply to remove."; exit 0 }

$removed = 0; $failed = @()
foreach ($c in $candidates) {
    if (-not $c.Missing) {
        foreach ($link in (Get-Links $c.Path)) {
            cmd /c rmdir "$link" | Out-Null                               # removes the link, never its target
        }
        $left = Get-Links $c.Path
        if ($left) { $failed += "$($c.Path)  (links still present: $($left -join ', '))"; continue }
        git worktree remove $c.Path 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $failed += "$($c.Path)  (git worktree remove refused)"; continue }
    }
    git branch -D $c.Branch 2>&1 | Out-Null
    $removed++
}
git worktree prune
Write-Host "`nRemoved: $removed"
if ($failed) { Write-Host "Failed: $($failed.Count)"; $failed | ForEach-Object { Write-Host "  $_" } }
