[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  if ($PSCmdlet.ShouldProcess('project_knowledge schema', 'Apply idempotent migrations')) {
    & npm run knowledge:migrate
    if ($LASTEXITCODE -ne 0) { throw "Migration failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host 'Would apply pending project_knowledge migrations, including 0006_queue_worker_health.'
  }
} finally {
  Pop-Location
}
