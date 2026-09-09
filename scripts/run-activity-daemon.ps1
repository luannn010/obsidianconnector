param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath
)

$ErrorActionPreference = 'Stop'
$entrypoint = Join-Path $RepositoryPath 'dist\activity-server.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "Build output is missing: $entrypoint"
}
$node = (Get-Command node -ErrorAction Stop).Source
& $node $entrypoint
