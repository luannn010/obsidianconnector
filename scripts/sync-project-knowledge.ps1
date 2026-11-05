[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectKey,
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [switch]$Wait,
  [switch]$LocalEmbeddingFallback,
  [int]$TimeoutSeconds = 1800,
  [string]$Image = $env:PROJECT_KNOWLEDGE_WORKER_IMAGE
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath).Path
$projectsRoot = if ($env:PROJECT_KNOWLEDGE_PROJECTS_HOST_ROOT) { (Resolve-Path -LiteralPath $env:PROJECT_KNOWLEDGE_PROJECTS_HOST_ROOT).Path } else { (Resolve-Path -LiteralPath 'C:\Users\luann\Documents').Path }
$vaultRoot = if ($env:OBSIDIAN_VAULT_ROOT) { $env:OBSIDIAN_VAULT_ROOT } else { 'G:\My Drive\.obsidian' }
if (-not $Image) { throw 'Set PROJECT_KNOWLEDGE_WORKER_IMAGE to the deployed image@sha256 digest' }
$docker = (Get-Command docker.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runtimeFile = Join-Path ([IO.Path]::GetTempPath()) "project-knowledge-windows-worker-$([guid]::NewGuid().ToString('N')).env"
$settings = @{}
foreach ($configPath in @((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\project-knowledge.env'), (Join-Path $repoRoot '.env'))) {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
  foreach ($line in Get-Content -LiteralPath $configPath) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$matches[1]] = $matches[2].Trim('"', "'") }
  }
}
if (-not $settings.PROJECT_KNOWLEDGE_DATABASE_URL) { throw 'PROJECT_KNOWLEDGE_DATABASE_URL is missing' }
$runtimeLines = @(
  "PROJECT_KNOWLEDGE_DATABASE_URL=$($settings.PROJECT_KNOWLEDGE_DATABASE_URL)",
  'PROJECT_KNOWLEDGE_DB_POOL_MAX=2',
  'PROJECT_KNOWLEDGE_STATEMENT_TIMEOUT_MS=30000',
  "PROJECT_KNOWLEDGE_EMBEDDING_MODEL=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_MODEL)",
  "PROJECT_KNOWLEDGE_EMBEDDING_REVISION=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_REVISION)",
  "PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS)"
)
if ($LocalEmbeddingFallback) {
  foreach ($required in @('PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL', 'PROJECT_KNOWLEDGE_EMBEDDING_TOKEN')) {
    if (-not $settings[$required]) { throw "$required is required for local embedding fallback" }
  }
  $runtimeLines += "PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL)"
  $runtimeLines += "PROJECT_KNOWLEDGE_EMBEDDING_TOKEN=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_TOKEN)"
}
Set-Content -LiteralPath $runtimeFile -Encoding utf8NoBOM -Value $runtimeLines
Push-Location $repoRoot
try {
  & npm run build *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Connector build failed' }
  $requestJson = & $node (Join-Path $repoRoot 'dist\request-source-sync.js') --enqueue --project-key $ProjectKey --worktree-path $resolvedWorktree
  if ($LASTEXITCODE -ne 0) { throw 'Could not enqueue source synchronization' }
  $request = $requestJson | ConvertFrom-Json
  if (-not $request.worktreeId) { throw 'Source synchronization did not resolve a worktree' }
  $env:PROJECT_KNOWLEDGE_SOURCE_WORKTREE_ID = $request.worktreeId
  $env:PROJECT_KNOWLEDGE_WORKER_IMAGE = $Image
  $env:PROJECT_KNOWLEDGE_WORKER_RELEASE = ($Image -split '@')[-1]
  $env:PROJECT_KNOWLEDGE_QUEUE_ENV_FILE = $runtimeFile
  $env:PROJECT_KNOWLEDGE_PROJECTS_HOST_ROOT = $projectsRoot
  $env:OBSIDIAN_VAULT_ROOT = $vaultRoot
  $env:PROJECT_KNOWLEDGE_WINDOWS_CAPABILITIES = if ($LocalEmbeddingFallback) { 'source-sync,publish,embedding' } else { 'source-sync,publish' }
  $composeOutput = & $docker compose -p project-knowledge-windows -f (Join-Path $repoRoot 'services\queue-worker\compose.windows.yaml') up -d 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Windows source worker did not start' }
  foreach ($line in $composeOutput) { Write-Verbose $line }
  if (-not $Wait) {
    [ordered]@{ jobId = $request.jobId; created = $request.created; state = 'queued' } | ConvertTo-Json -Compress
    return
  }
  & $node (Join-Path $repoRoot 'dist\request-source-sync.js') --wait $request.jobId --timeout-seconds $TimeoutSeconds
  if ($LASTEXITCODE -ne 0) { throw 'Source synchronization did not complete' }
} finally {
  Pop-Location
  Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
}
