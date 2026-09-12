[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$ProjectPath,
  [string]$VaultPath,
  [string]$ProjectKey,
  [string]$Name,
  [string]$ProjectsRoot,
  [string]$VaultRoot,
  [string]$DatabaseUrl,
  [string]$MigrationDatabaseUrl,
  [string]$Image = $env:PROJECT_KNOWLEDGE_WORKER_IMAGE,
  [string]$ConfigPath,
  [switch]$SaveConnection,
  [switch]$Wait,
  [int]$TimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$userEnvironment = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\project-knowledge.env'

function Read-EnvironmentFile([string]$Path) {
  $values = [ordered]@{}
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $Path) {
      if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
        $values[$matches[1]] = $matches[2].Trim('"', "'")
      }
    }
  }
  return $values
}

function Save-EnvironmentValue([string]$Path, [string]$Key, [string]$Value) {
  $values = Read-EnvironmentFile $Path
  $values[$Key] = $Value
  $directory = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $lines = foreach ($entry in $values.GetEnumerator()) { "$($entry.Key)=$($entry.Value)" }
  Set-Content -LiteralPath $temporary -Encoding utf8NoBOM -Value $lines
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function ConvertFrom-SecureValue([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# This is deliberately the first interactive question.
if (-not $VaultPath) { $VaultPath = Read-Host 'Obsidian vault path' }
if (-not $VaultPath) { throw 'Obsidian vault path is required' }
if (-not $ProjectPath) { $ProjectPath = (Get-Location).Path }
$resolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$resolvedVault = [IO.Path]::GetFullPath($VaultPath)
if (-not $ProjectKey) { $ProjectKey = Split-Path -Leaf $resolvedVault }
if (-not $Name) { $Name = $ProjectKey }
if (-not $ProjectsRoot) { $ProjectsRoot = Split-Path -Parent $resolvedProject }
if (-not $VaultRoot) { $VaultRoot = if ($env:OBSIDIAN_VAULT_ROOT) { $env:OBSIDIAN_VAULT_ROOT } else { 'G:\My Drive\.obsidian' } }
if (-not $ConfigPath) {
  if ($env:OBSIDIAN_MCP_CONFIG) {
    $ConfigPath = $env:OBSIDIAN_MCP_CONFIG
  } else {
    $commonGitDirectory = (& git.exe -C $repoRoot rev-parse --path-format=absolute --git-common-dir 2>$null)
    $connectorCheckout = if ($LASTEXITCODE -eq 0) { Split-Path -Parent $commonGitDirectory.Trim() } else { $repoRoot }
    $ConfigPath = Join-Path $connectorCheckout 'config\vaults.json'
  }
}

$settings = Read-EnvironmentFile $userEnvironment
$repoSettings = Read-EnvironmentFile (Join-Path $repoRoot '.env')
foreach ($entry in $repoSettings.GetEnumerator()) {
  if (-not $settings.Contains($entry.Key)) { $settings[$entry.Key] = $entry.Value }
}
if (-not $DatabaseUrl) { $DatabaseUrl = $env:PROJECT_KNOWLEDGE_DATABASE_URL }
if (-not $DatabaseUrl) { $DatabaseUrl = $settings.PROJECT_KNOWLEDGE_DATABASE_URL }
$connectionWasPrompted = $false
if (-not $DatabaseUrl) {
  $secureConnection = Read-Host -AsSecureString 'PostgreSQL project-knowledge connection URL'
  $DatabaseUrl = ConvertFrom-SecureValue $secureConnection
  $connectionWasPrompted = $true
}
if (-not $DatabaseUrl) { throw 'PROJECT_KNOWLEDGE_DATABASE_URL is required' }
if (-not $MigrationDatabaseUrl) { $MigrationDatabaseUrl = $env:PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL }
if (-not $MigrationDatabaseUrl) { $MigrationDatabaseUrl = $settings.PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL }
if (-not $MigrationDatabaseUrl) { $MigrationDatabaseUrl = $DatabaseUrl }

$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location $repoRoot
try {
  & npm run build *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Connector build failed' }
} finally { Pop-Location }

$arguments = @(
  (Join-Path $repoRoot 'dist\setup-project.js'),
  '--project-path', $resolvedProject,
  '--vault-path', $resolvedVault,
  '--projects-root', ([IO.Path]::GetFullPath($ProjectsRoot)),
  '--vault-root', ([IO.Path]::GetFullPath($VaultRoot)),
  '--project-key', $ProjectKey,
  '--name', $Name,
  '--config-path', ([IO.Path]::GetFullPath($ConfigPath))
)
$previousDatabaseUrl = $env:PROJECT_KNOWLEDGE_DATABASE_URL
$previousMigrationUrl = $env:PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL
$env:PROJECT_KNOWLEDGE_DATABASE_URL = $DatabaseUrl
$env:PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL = $MigrationDatabaseUrl
try {
  if ($WhatIfPreference) {
    & $node @arguments --what-if
    if ($LASTEXITCODE -ne 0) { throw 'Project setup preview failed' }
    return
  }
  if (-not $Image) { throw 'Set PROJECT_KNOWLEDGE_WORKER_IMAGE to the deployed image@sha256 digest' }
  if (-not $PSCmdlet.ShouldProcess($resolvedProject, "Register project $ProjectKey and queue its initial snapshot")) { return }
  if ($connectionWasPrompted -or $SaveConnection) {
    Save-EnvironmentValue $userEnvironment 'PROJECT_KNOWLEDGE_DATABASE_URL' $DatabaseUrl
  }
  $setupJson = & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Project registration failed' }
  $setup = $setupJson | ConvertFrom-Json

  $runtimeFile = Join-Path ([IO.Path]::GetTempPath()) "project-setup-$([guid]::NewGuid().ToString('N')).env"
  try {
    Set-Content -LiteralPath $runtimeFile -Encoding utf8NoBOM -Value @(
      "PROJECT_KNOWLEDGE_DATABASE_URL=$DatabaseUrl",
      'PROJECT_KNOWLEDGE_DB_POOL_MAX=2',
      'PROJECT_KNOWLEDGE_STATEMENT_TIMEOUT_MS=30000'
    )
    $safeKey = ($ProjectKey.ToLowerInvariant() -replace '[^a-z0-9_-]', '-')
    $env:PROJECT_KNOWLEDGE_WORKER_IMAGE = $Image
    $env:PROJECT_KNOWLEDGE_WORKER_RELEASE = ($Image -split '@')[-1]
    $env:PROJECT_KNOWLEDGE_QUEUE_ENV_FILE = $runtimeFile
    $env:PROJECT_KNOWLEDGE_PROJECTS_HOST_ROOT = [IO.Path]::GetFullPath($ProjectsRoot)
    $env:OBSIDIAN_VAULT_ROOT = [IO.Path]::GetFullPath($VaultRoot)
    $env:PROJECT_KNOWLEDGE_WINDOWS_CAPABILITIES = 'source-sync,publish'
    $env:PROJECT_KNOWLEDGE_SOURCE_WORKTREE_ID = $setup.worktreeId
    $composeOutput = & docker.exe compose -p "project-knowledge-$safeKey" -f (Join-Path $repoRoot 'services\queue-worker\compose.windows.yaml') up -d 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Windows source worker did not start' }
    foreach ($line in $composeOutput) { Write-Verbose $line }
    if (-not $Wait) {
      [ordered]@{ state = 'queued'; setup = $setup; jobId = $setup.jobId } | ConvertTo-Json -Depth 8 -Compress
      return
    }
    $receiptJson = & $node (Join-Path $repoRoot 'dist\request-source-sync.js') --wait $setup.jobId --timeout-seconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw 'Initial source synchronization did not complete' }
    $receipt = $receiptJson | ConvertFrom-Json
    [ordered]@{ state = 'completed'; setup = $setup; receipt = $receipt } | ConvertTo-Json -Depth 10 -Compress
  } finally {
    if ($runtimeFile) { Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue }
  }
} finally {
  $env:PROJECT_KNOWLEDGE_DATABASE_URL = $previousDatabaseUrl
  $env:PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL = $previousMigrationUrl
}
