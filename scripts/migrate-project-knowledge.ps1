[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  if ($PSCmdlet.ShouldProcess('project_knowledge schema', 'Apply idempotent migrations')) {
    & npm run knowledge:migrate
    if ($LASTEXITCODE -ne 0) { throw "Migration failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host 'Would apply pending project_knowledge migrations, including 0007_shared_worker_queue.'
  }
} finally {
  Pop-Location
}
