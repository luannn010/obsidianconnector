[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$Server = 'ptolemy@192.168.0.164',
  [string]$RemoteRoot = '/opt/project-knowledge/queue-worker',
  [string]$ProjectKey = 'MC-Platform'
)

$ErrorActionPreference = 'Stop'
if ($Server -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$') { throw 'Invalid SSH server' }
if ($RemoteRoot -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'Invalid remote root' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$tar = (Get-Command tar.exe -ErrorAction Stop).Source

$releaseFiles = @(
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  'src', 'services/queue-worker'
)
$hashFiles = foreach ($item in $releaseFiles) {
  $full = Join-Path $repoRoot $item
  if (Test-Path -LiteralPath $full -PathType Container) {
    Get-ChildItem -LiteralPath $full -File -Recurse
  } else { Get-Item -LiteralPath $full }
}
$manifest = $hashFiles | Sort-Object FullName | ForEach-Object {
  $relative = [IO.Path]::GetRelativePath($repoRoot, $_.FullName).Replace('\', '/')
  "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $release = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($manifest -join "`n"))))).Replace('-', '').ToLowerInvariant()
} finally { $sha.Dispose() }
$release = $release.Substring(0, 24)
$remoteRelease = "$RemoteRoot/releases/$release"
Write-Host "Queue worker release: $release"

$temporary = Join-Path ([IO.Path]::GetTempPath()) "queue-worker-$release"
[void][IO.Directory]::CreateDirectory($temporary)
$archive = Join-Path $temporary 'release.tar.gz'
$runtimeFile = Join-Path $temporary 'runtime.env'
try {
  & $tar -czf $archive -C $repoRoot @releaseFiles
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create deployment archive' }

  $settings = @{}
  $configPaths = @(
    (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\project-knowledge.env'),
    (Join-Path $repoRoot '.env')
  )
  foreach ($configPath in $configPaths) {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
    foreach ($line in Get-Content -LiteralPath $configPath) {
      if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
        $settings[$matches[1]] = $matches[2].Trim('"', "'")
      }
    }
  }
  foreach ($required in @('PROJECT_KNOWLEDGE_DATABASE_URL', 'PROJECT_KNOWLEDGE_EMBEDDING_TOKEN')) {
    if (-not $settings[$required]) { throw "$required is missing from project knowledge configuration" }
  }
  $runtimeLines = @(
    "PROJECT_KNOWLEDGE_DATABASE_URL=$($settings.PROJECT_KNOWLEDGE_DATABASE_URL)",
    'PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:8080',
    "PROJECT_KNOWLEDGE_EMBEDDING_TOKEN=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_TOKEN)",
    "PROJECT_KNOWLEDGE_EMBEDDING_MODEL=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_MODEL) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_MODEL } else { 'BAAI/bge-small-en-v1.5' })",
    "PROJECT_KNOWLEDGE_EMBEDDING_REVISION=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_REVISION) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_REVISION } else { 'local' })",
    "PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS } else { '384' })",
    "PROJECT_KNOWLEDGE_PROJECT_KEY=$ProjectKey",
    "PROJECT_KNOWLEDGE_QUEUE_RELEASE=$release",
    'PROJECT_KNOWLEDGE_DB_POOL_MAX=2',
    'PROJECT_KNOWLEDGE_STATEMENT_TIMEOUT_MS=30000',
    'PROJECT_KNOWLEDGE_QUEUE_BATCH_SIZE=50',
    'PROJECT_KNOWLEDGE_QUEUE_POLL_MS=1000',
    'PROJECT_KNOWLEDGE_SNAPSHOT_RETENTION_DAYS=7'
  )
  Set-Content -LiteralPath $runtimeFile -Value $runtimeLines -Encoding utf8NoBOM

  if (-not $PSCmdlet.ShouldProcess($Server, "Deploy queue worker release $release")) { return }
  $previous = (& $ssh $Server "readlink -f '$RemoteRoot/current' 2>/dev/null || true").Trim()
  & $ssh $Server "set -eu; mkdir -p '$RemoteRoot/releases'; rm -f '/tmp/queue-worker-$release.tar.gz' '/tmp/queue-worker-$release.env'"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare remote release directory' }
  & $scp $archive "${Server}:/tmp/queue-worker-$release.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload release archive' }
  & $scp $runtimeFile "${Server}:/tmp/queue-worker-$release.env"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload runtime configuration' }
  $activate = "set -eu; mkdir -p '$remoteRelease'; tar -xzf '/tmp/queue-worker-$release.tar.gz' -C '$remoteRelease'; install -m 600 '/tmp/queue-worker-$release.env' '$RemoteRoot/runtime.env'; export PROJECT_KNOWLEDGE_QUEUE_RELEASE='$release'; export PROJECT_KNOWLEDGE_QUEUE_ENV_FILE='$RemoteRoot/runtime.env'; docker compose -p project-knowledge-queue -f '$remoteRelease/services/queue-worker/compose.yaml' build; docker compose -p project-knowledge-queue -f '$remoteRelease/services/queue-worker/compose.yaml' up -d"
  & $ssh $Server $activate
  if ($LASTEXITCODE -ne 0) { throw 'Remote queue worker deployment failed' }

  $env:PROJECT_KNOWLEDGE_EXPECTED_QUEUE_RELEASE = $release
  $healthy = $false
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    & node (Join-Path $repoRoot 'dist\queue-health.js') *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 5
  }
  if (-not $healthy) {
    Write-Warning 'New release heartbeat failed; starting rollback.'
    if ($previous) {
      $rollback = "set -eu; export PROJECT_KNOWLEDGE_QUEUE_RELEASE='rollback'; export PROJECT_KNOWLEDGE_QUEUE_ENV_FILE='$RemoteRoot/runtime.env'; docker compose -p project-knowledge-queue -f '$previous/services/queue-worker/compose.yaml' up -d; ln -sfn '$previous' '$RemoteRoot/current'"
      & $ssh $Server $rollback
    }
    throw 'Queue worker heartbeat verification failed after rollback'
  }
  & $ssh $Server "set -eu; ln -sfn '$remoteRelease' '$RemoteRoot/current'; rm -f '/tmp/queue-worker-$release.tar.gz' '/tmp/queue-worker-$release.env'"
  if ($LASTEXITCODE -ne 0) { throw 'Worker is healthy but the current release link was not switched' }
  Write-Host "Queue worker release $release is healthy and active."
} finally {
  if (Test-Path -LiteralPath $temporary) {
    [IO.Directory]::Delete($temporary, $true)
  }
}
