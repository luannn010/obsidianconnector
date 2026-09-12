[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectKey,
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [switch]$Wait,
  [switch]$LocalEmbeddingFallback
)

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath).Path
$previousProjectKey = $env:PROJECT_KNOWLEDGE_PROJECT_KEY
$previousRepositoryPath = $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH
$previousEmbeddingMode = $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS
Push-Location $connectorRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
  $env:PROJECT_KNOWLEDGE_PROJECT_KEY = $ProjectKey
  $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH = $resolvedWorktree
  $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS = if ($LocalEmbeddingFallback) { 'true' } else { 'false' }
  $node = (Get-Command node -ErrorAction Stop).Source
  $entrypoint = Join-Path $connectorRoot 'dist\sync-project.js'
  if ($Wait) {
    & $node $entrypoint
    if ($LASTEXITCODE -ne 0) { throw "Project synchronization failed with exit code $LASTEXITCODE" }
  } else {
    Start-Process -FilePath $node -ArgumentList @($entrypoint) -WorkingDirectory $connectorRoot -WindowStyle Hidden
    Write-Host "Started project knowledge synchronization for $ProjectKey"
  }
} finally {
  $env:PROJECT_KNOWLEDGE_PROJECT_KEY = $previousProjectKey
  $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH = $previousRepositoryPath
  $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS = $previousEmbeddingMode
  Pop-Location
}
