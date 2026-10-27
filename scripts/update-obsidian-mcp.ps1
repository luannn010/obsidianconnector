[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectKey,
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [string]$VaultPath,
  [switch]$RepairFailedJobs,
  [switch]$LocalEmbeddingFallback,
  [switch]$Publish,
  [string]$PreviewHash,
  [switch]$DeployQueueWorker
)

$ErrorActionPreference = 'Stop'
$connectorRoot = Split-Path -Parent $PSScriptRoot
Set-Location $connectorRoot

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')" }
}

function Get-GitValue([string[]]$Arguments) {
  $value = (& git -C $WorktreePath @Arguments | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Git command failed: $($Arguments -join ' ')" }
  return $value
}

$branch = Get-GitValue @('branch', '--show-current')
$dirty = Get-GitValue @('status', '--porcelain=v1', '--untracked-files=all')
if ($branch -ne 'master') { throw "Canonical synchronization requires master; found '$branch'." }
if ($dirty) { throw 'Canonical synchronization requires a clean worktree.' }
if ($Publish -and -not $PreviewHash) { throw 'Publish requires the exact preview hash returned by preview_project_views.' }

Invoke-Checked 'npm' @('run', 'typecheck')
Invoke-Checked 'npm' @('test', '--', '--run', 'tests/unit/domain-sync.test.ts', 'tests/integration/knowledge-server.integration.test.ts')
Invoke-Checked 'npm' @('run', 'build')

$toolList = node scripts/invoke-obsidian-mcp.mjs list | ConvertFrom-Json
$toolNames = @($toolList.tools | ForEach-Object { $_.name })
if ('sync_project_on_demand' -notin $toolNames) { throw 'Built MCP server did not expose sync_project_on_demand.' }
if ('run_project_sync_action' -notin $toolNames) { throw 'Built MCP server did not expose run_project_sync_action.' }

$syncInput = @{
  projectKey = $ProjectKey
  worktreePath = (Resolve-Path $WorktreePath).Path
  repairFailedJobs = [bool]$RepairFailedJobs
  localEmbeddingFallback = [bool]$LocalEmbeddingFallback
  timeoutSeconds = 900
  pollSeconds = 5
  publish = [bool]$Publish
}
if ($VaultPath) { $syncInput.vaultPath = (Resolve-Path $VaultPath).Path }
if ($PreviewHash) { $syncInput.previewHash = $PreviewHash }
$receipt = node scripts/invoke-obsidian-mcp.mjs sync_project_on_demand ($syncInput | ConvertTo-Json -Compress) | ConvertFrom-Json
$receipt | ConvertTo-Json -Depth 20
if ($receipt.isError -eq $true) { throw 'MCP synchronization returned an error.' }
if ($receipt.structuredContent.state -eq 'blocked') { throw "MCP synchronization is blocked: $($receipt.structuredContent.reason)" }

if ($DeployQueueWorker) {
  & "$connectorRoot\scripts\deploy-queue-worker.ps1" -ProjectKey $ProjectKey
  if ($LASTEXITCODE -ne 0) { throw 'Queue worker deployment failed or rolled back.' }
}

$statusInput = @{ projectKey = $ProjectKey; compact = $true; changedOnly = $false; issueLimit = 10; actionLimit = 10 } | ConvertTo-Json -Compress
$finalStatus = node scripts/invoke-obsidian-mcp.mjs get_project_sync_status $statusInput | ConvertFrom-Json
$finalStatus | ConvertTo-Json -Depth 20
if ($finalStatus.isError -eq $true) { throw 'Final MCP status read failed.' }
if ($finalStatus.structuredContent.summary.failedJobs -gt 0) { throw 'Final status still reports failed queue jobs.' }
if ($finalStatus.structuredContent.domainSync.unmappedChanges.Count -gt 0) { throw 'Final status still reports unmapped changes.' }
