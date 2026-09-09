param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath
)

$ErrorActionPreference = 'Stop'
$RepositoryPath = (Resolve-Path -LiteralPath $RepositoryPath).Path
$entrypoint = Join-Path $RepositoryPath 'dist\worker.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "Build output is missing: $entrypoint"
}
Set-Location -LiteralPath $RepositoryPath
$node = (Get-Command node -ErrorAction Stop).Source
& $node $entrypoint
