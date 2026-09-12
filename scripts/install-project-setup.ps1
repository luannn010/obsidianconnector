[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$skillSource = Join-Path $repoRoot '.codex\skills\project-setup'
$skillTarget = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\project-setup'
$codex = (Get-Command codex -ErrorAction Stop).Source

if (-not $PSCmdlet.ShouldProcess($skillTarget, 'Install global project-setup skill and local plugin')) {
  [ordered]@{ action = 'what-if'; skill = $skillTarget; marketplace = $repoRoot } | ConvertTo-Json -Compress
  return
}

if (Test-Path -LiteralPath $skillTarget) {
  Remove-Item -LiteralPath $skillTarget -Recurse -Force
}
Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Recurse

$marketplaces = & $codex plugin marketplace list 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Could not list Codex plugin marketplaces' }
if (($marketplaces -join "`n") -notmatch '(?m)^project-setup\b') {
  & $codex plugin marketplace add $repoRoot --json
  if ($LASTEXITCODE -ne 0) { throw 'Could not add the local project-setup marketplace' }
}
$plugins = & $codex plugin list 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Could not list Codex plugins' }
if (($plugins -join "`n") -notmatch '(?m)^project-setup@project-setup\s+installed') {
  & $codex plugin add 'project-setup@project-setup'
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the project-setup plugin' }
}

[ordered]@{ action = 'installed'; skill = $skillTarget; marketplace = 'project-setup'; plugin = 'project-setup' } | ConvertTo-Json -Compress
