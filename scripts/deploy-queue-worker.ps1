[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$Release,
  [string]$Server = 'ptolemy@192.168.0.164',
  [string]$RemoteRoot = '/opt/project-knowledge/queue-worker'
)

$ErrorActionPreference = 'Stop'
if ($Image -notmatch '^192\.168\.0\.164:5000/project-knowledge-worker@sha256:[0-9a-f]{64}$') { throw 'Image must be the approved registry repository pinned by sha256 digest' }
if ($Release -notmatch '^[0-9a-f]{12,64}$') { throw 'Release must be a hexadecimal content hash' }
if ($Server -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$') { throw 'Invalid SSH server' }
if ($RemoteRoot -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'Invalid remote root' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$composeSource = Join-Path $repoRoot 'services\queue-worker\compose.yaml'
$temporary = Join-Path ([IO.Path]::GetTempPath()) "project-knowledge-debian-$Release"
[void][IO.Directory]::CreateDirectory($temporary)
$runtimeFile = Join-Path $temporary 'runtime.env'
$settings = @{}
foreach ($configPath in @((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\project-knowledge.env'), (Join-Path $repoRoot '.env'))) {
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
  foreach ($line in Get-Content -LiteralPath $configPath) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$matches[1]] = $matches[2].Trim('"', "'") }
  }
}
foreach ($required in @('PROJECT_KNOWLEDGE_DATABASE_URL', 'PROJECT_KNOWLEDGE_EMBEDDING_TOKEN')) {
  if (-not $settings[$required]) { throw "$required is missing from project knowledge configuration" }
}
Set-Content -LiteralPath $runtimeFile -Encoding utf8NoBOM -Value @(
  "PROJECT_KNOWLEDGE_DATABASE_URL=$($settings.PROJECT_KNOWLEDGE_DATABASE_URL)",
  'PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:8080',
  "PROJECT_KNOWLEDGE_EMBEDDING_TOKEN=$($settings.PROJECT_KNOWLEDGE_EMBEDDING_TOKEN)",
  "PROJECT_KNOWLEDGE_EMBEDDING_MODEL=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_MODEL) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_MODEL } else { 'BAAI/bge-small-en-v1.5' })",
  "PROJECT_KNOWLEDGE_EMBEDDING_REVISION=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_REVISION) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_REVISION } else { 'local' })",
  "PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS=$(if ($settings.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS) { $settings.PROJECT_KNOWLEDGE_EMBEDDING_DIMENSIONS } else { '384' })",
  'PROJECT_KNOWLEDGE_DB_POOL_MAX=4',
  'PROJECT_KNOWLEDGE_STATEMENT_TIMEOUT_MS=30000',
  'PROJECT_KNOWLEDGE_QUEUE_POLL_MS=1000',
  'PROJECT_KNOWLEDGE_SNAPSHOT_RETENTION_DAYS=7'
)
$remoteRelease = "$RemoteRoot/releases/$Release"
if (-not $PSCmdlet.ShouldProcess($Server, "Deploy shared worker $Image")) {
  [ordered]@{ server = $Server; release = $Release; image = $Image; action = 'what-if' } | ConvertTo-Json -Compress
  return
}
try {
  $previousImage = (& $ssh $Server "docker inspect project-knowledge-queue-queue-worker-1 --format '{{.Config.Image}}' 2>/dev/null || true").Trim()
  & $ssh $Server "set -eu; mkdir -p '$remoteRelease' '$RemoteRoot/releases'"
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare Debian release directory' }
  & $scp $composeSource "${Server}:/tmp/project-knowledge-compose-$Release.yaml"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload Debian Compose file' }
  & $scp $runtimeFile "${Server}:/tmp/project-knowledge-runtime-$Release.env"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload Debian runtime configuration' }
  $activate = "set -eu; install -m 644 '/tmp/project-knowledge-compose-$Release.yaml' '$remoteRelease/compose.yaml'; install -m 600 '/tmp/project-knowledge-runtime-$Release.env' '$RemoteRoot/runtime.env'; export PROJECT_KNOWLEDGE_WORKER_IMAGE='$Image'; export PROJECT_KNOWLEDGE_WORKER_RELEASE='$Release'; export PROJECT_KNOWLEDGE_QUEUE_ENV_FILE='$RemoteRoot/runtime.env'; docker compose -p project-knowledge-queue -f '$remoteRelease/compose.yaml' pull; docker compose -p project-knowledge-queue -f '$remoteRelease/compose.yaml' up -d"
  & $ssh $Server $activate
  if ($LASTEXITCODE -ne 0) { throw 'Debian shared worker deployment failed' }
  $env:PROJECT_KNOWLEDGE_EXPECTED_QUEUE_RELEASE = $Release
  $env:PROJECT_KNOWLEDGE_EXPECTED_HOST_KIND = 'debian'
  $healthy = $false
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    & node (Join-Path $repoRoot 'dist\queue-health.js') *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 5
  }
  if (-not $healthy) {
    if ($previousImage) {
      $rollback = "set -eu; export PROJECT_KNOWLEDGE_WORKER_IMAGE='$previousImage'; export PROJECT_KNOWLEDGE_WORKER_RELEASE='rollback'; export PROJECT_KNOWLEDGE_QUEUE_ENV_FILE='$RemoteRoot/runtime.env'; docker compose -p project-knowledge-queue -f '$remoteRelease/compose.yaml' up -d"
      & $ssh $Server $rollback
    }
    throw 'Debian heartbeat verification failed; the previous image was restored when available'
  }
  & $ssh $Server "set -eu; ln -sfn '$remoteRelease' '$RemoteRoot/current'; rm -f '/tmp/project-knowledge-compose-$Release.yaml' '/tmp/project-knowledge-runtime-$Release.env'"
  if ($LASTEXITCODE -ne 0) { throw 'Worker is healthy but the active release link could not be switched' }
  [ordered]@{ server = $Server; release = $Release; image = $Image; state = 'healthy' } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
