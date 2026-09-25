[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectKey,
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [string]$VaultPath,
  [switch]$Wait,
  [switch]$LocalEmbeddingFallback,
  [int]$TimeoutSeconds = 300,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath).Path
$previousProjectKey = $env:PROJECT_KNOWLEDGE_PROJECT_KEY
$previousRepositoryPath = $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH
$previousVaultPath = $env:PROJECT_KNOWLEDGE_VAULT_PATH
$previousEmbeddingMode = $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS
Push-Location $connectorRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

  $env:PROJECT_KNOWLEDGE_PROJECT_KEY = $ProjectKey
  $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH = $resolvedWorktree
  $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS = if ($LocalEmbeddingFallback) { 'true' } else { 'false' }
  if (-not [string]::IsNullOrWhiteSpace($VaultPath)) {
    $env:PROJECT_KNOWLEDGE_VAULT_PATH = (Resolve-Path -LiteralPath $VaultPath).Path
  }

  $node = (Get-Command node -ErrorAction Stop).Source
  $entrypoint = Join-Path $connectorRoot 'dist\finalize-projection.js'
  $arguments = @(
    $entrypoint,
    '--project-key', $ProjectKey,
    '--worktree-path', $resolvedWorktree,
    '--timeout-seconds', $TimeoutSeconds.ToString(),
    '--poll-seconds', $PollSeconds.ToString()
  )
  if (-not [string]::IsNullOrWhiteSpace($env:PROJECT_KNOWLEDGE_VAULT_PATH)) {
    $arguments += @('--vault-path', $env:PROJECT_KNOWLEDGE_VAULT_PATH)
  }
  if ($LocalEmbeddingFallback) {
    $arguments += '--local-embedding-fallback'
  }

  if ($Wait) {
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Projection finalization failed with exit code $LASTEXITCODE" }
  } else {
    Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $connectorRoot -WindowStyle Hidden
    Write-Host "Started project knowledge projection finalization for $ProjectKey"
  }
} finally {
  $env:PROJECT_KNOWLEDGE_PROJECT_KEY = $previousProjectKey
  $env:PROJECT_KNOWLEDGE_REPOSITORY_PATH = $previousRepositoryPath
  $env:PROJECT_KNOWLEDGE_VAULT_PATH = $previousVaultPath
  $env:PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS = $previousEmbeddingMode
  Pop-Location
}
