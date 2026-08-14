<#
.SYNOPSIS
  Mirrors the working tree into the public GitHub clone.

.DESCRIPTION
  The working tree is the source of truth; the clone at -Destination is a
  publish target. This is a robocopy /MIR, so anything in the destination that
  is not in the source is DELETED — which is the point (a file removed here has
  to disappear there), and also why the exclusion list below is load-bearing
  rather than an optimisation.

  Excluded, and why:
    .git          mirroring over it would destroy the repository itself
    node_modules  restored by npm install, and enormous
    dist,
    dist-electron,
    dist-smoke,
    release       build output; already in .gitignore
    .claude       local tool configuration, not part of the project

  Internal documentation (ARCHITECTURE, BUILD, MIGRATIONS, SECURITY, TESTING)
  is deliberately NOT excluded here: it is listed in the mirror's .gitignore
  instead, so it lands in the working directory but is never committed. Keeping
  that rule in one place means git is the single authority on what is public.

  Nothing is committed — this only moves files. Review `git status` in the
  destination afterwards and commit there.

.EXAMPLE
  pwsh tools/sync-public-mirror.ps1 -WhatIf
  pwsh tools/sync-public-mirror.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$Source,
  [string]$Destination = 'C:\Users\ptc-v\Documents\GitHub\SmartcomRevisited'
)

$ErrorActionPreference = 'Stop'

# Resolved here rather than as a parameter default: $PSScriptRoot is not
# reliably populated while the param block is being bound under Windows
# PowerShell 5.1, which left Source empty and Join-Path throwing.
if (-not $Source) {
  $Source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

if (-not (Test-Path $Destination)) {
  throw "Destination does not exist: $Destination"
}
if (-not (Test-Path (Join-Path $Destination '.git'))) {
  # Without this check a mistyped path would mirror the project over an
  # unrelated folder and delete everything already in it.
  throw "Destination is not a git repository, refusing to mirror: $Destination"
}

$excludedDirs = @(
  (Join-Path $Source '.git'),
  (Join-Path $Source 'node_modules'),
  (Join-Path $Source 'dist'),
  (Join-Path $Source 'dist-electron'),
  (Join-Path $Source 'dist-smoke'),
  (Join-Path $Source 'release'),
  (Join-Path $Source '.claude')
)

# /XD is matched against both sides, so the destination's own copies have to be
# named as well. Missing .git would take the branch, the history and the remote
# with it; missing release/ would delete the packaged installers already built
# there, which are hundreds of megabytes and not reproducible in a hurry.
$excludedDirs += (Join-Path $Destination '.git')
$excludedDirs += (Join-Path $Destination 'node_modules')
$excludedDirs += (Join-Path $Destination 'dist')
$excludedDirs += (Join-Path $Destination 'dist-electron')
$excludedDirs += (Join-Path $Destination 'dist-smoke')
$excludedDirs += (Join-Path $Destination 'release')

Write-Host "Source:      $Source"
Write-Host "Destination: $Destination"

if (-not $PSCmdlet.ShouldProcess($Destination, 'robocopy /MIR from the working tree')) {
  $robocopyArgs = @($Source, $Destination, '/MIR', '/L', '/NJH', '/NJS', '/NDL', '/NP')
} else {
  $robocopyArgs = @($Source, $Destination, '/MIR', '/NJH', '/NJS', '/NDL', '/NP')
}
$robocopyArgs += '/XD'
$robocopyArgs += $excludedDirs

& robocopy.exe @robocopyArgs | Out-Host

# Robocopy uses exit codes as a bit field: 0-7 are success (0 = nothing to do,
# 1 = files copied, 2 = extras removed, 4 = mismatches). 8 and above are real
# failures, so treating any non-zero code as an error would fail every run.
$code = $LASTEXITCODE
if ($code -ge 8) {
  throw "robocopy failed with exit code $code"
}

Write-Host ""
Write-Host "Mirror updated (robocopy code $code). Review and commit in the destination:"
Write-Host "  cd `"$Destination`"; git status"
