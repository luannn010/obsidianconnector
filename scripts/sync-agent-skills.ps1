[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepositoryPath,
  [switch]$SkipUserProfile
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryPath) {
  $RepositoryPath = Split-Path -Parent $MyInvocation.MyCommand.Path
  $RepositoryPath = Split-Path -Parent $RepositoryPath
}
$RepositoryPath = (Resolve-Path -LiteralPath $RepositoryPath).Path
$source = Join-Path $RepositoryPath '.codex\skills\project-to-obsidian'
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md') -PathType Leaf)) {
  throw "Canonical skill is missing: $source"
}

$targets = @(Join-Path $RepositoryPath '.claude\skills\project-to-obsidian')
if (-not $SkipUserProfile) {
  $targets += Join-Path $HOME '.claude\skills\project-to-obsidian'
}

foreach ($target in $targets) {
  if ($PSCmdlet.ShouldProcess($target, 'Replace with canonical project-to-obsidian skill')) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
    Write-Output "Synchronized $target"
  }
}
