param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath,
  [string]$ProjectPath = 'C:\Users\luann\Documents\MC-Platform',
  [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
$RepositoryPath = (Resolve-Path -LiteralPath $RepositoryPath).Path
$hookEntrypoint = Join-Path $RepositoryPath 'dist\activity-hook.js'
$daemonScript = Join-Path $RepositoryPath 'scripts\run-activity-daemon.ps1'
$workerScript = Join-Path $RepositoryPath 'scripts\run-knowledge-worker.ps1'
if (-not (Test-Path -LiteralPath $hookEntrypoint -PathType Leaf)) {
  throw "Run npm run build before installing hooks: $hookEntrypoint"
}

$envPath = Join-Path $HOME '.codex\project-knowledge.env'
$envDirectory = Split-Path -Parent $envPath
New-Item -ItemType Directory -Path $envDirectory -Force | Out-Null
$environment = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $environment.Add([string]$line)
  }
}
function Set-EnvironmentValue([string]$Name, [string]$Value) {
  $prefix = "$Name="
  for ($index = 0; $index -lt $environment.Count; $index++) {
    if ($environment[$index].StartsWith($prefix, [StringComparison]::Ordinal)) {
      $environment[$index] = "$prefix$Value"
      return
    }
  }
  $environment.Add("$prefix$Value")
}
$activityTokenLine = $environment | Where-Object { $_.StartsWith('PROJECT_KNOWLEDGE_ACTIVITY_TOKEN=', [StringComparison]::Ordinal) } | Select-Object -First 1
if (-not $activityTokenLine) {
  $tokenBytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
  Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_TOKEN' ([Convert]::ToBase64String($tokenBytes))
}
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_ENABLED' 'true'
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_HOST' '127.0.0.1'
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_PORT' '8765'
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_BASE_URL' 'http://127.0.0.1:8765'
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_ACTIVITY_SPOOL' (Join-Path $HOME '.codex\project-knowledge\activity-spool.ndjson')
Set-EnvironmentValue 'PROJECT_KNOWLEDGE_REPOSITORY_PATH' $ProjectPath
[IO.File]::WriteAllLines($envPath, $environment, [Text.UTF8Encoding]::new($false))
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$windowsRoot = if ($env:WINDIR) { $env:WINDIR } else { 'C:\Windows' }
$icacls = Join-Path $windowsRoot 'System32\icacls.exe'
$aclOutput = & $icacls $envPath '/inheritance:r' '/grant:r' "$currentUser`:(F)" 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Could not restrict the project-knowledge environment file: $($aclOutput -join ' ')"
}

function Read-JsonMap([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{} }
  $text = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($text)) { return @{} }
  return ConvertFrom-Json $text -AsHashtable
}
function Add-CommandHook(
  [hashtable]$Configuration,
  [string]$Event,
  [string]$Command,
  [bool]$Async,
  [string]$Matcher = ''
) {
  if (-not $Configuration.ContainsKey('hooks')) { $Configuration.hooks = @{} }
  if (-not $Configuration.hooks.ContainsKey($Event)) { $Configuration.hooks[$Event] = @() }
  $exists = $Configuration.hooks[$Event] | Where-Object {
    $_.hooks | Where-Object { $_.command -eq $Command -or $_.commandWindows -eq $Command }
  }
  if ($exists) { return }
  $handler = @{ type = 'command'; command = $Command; commandWindows = $Command; timeout = 3 }
  if ($Async) { $handler.async = $true }
  $group = @{ hooks = @($handler) }
  if ($Matcher) { $group.matcher = $Matcher }
  $Configuration.hooks[$Event] = @($Configuration.hooks[$Event]) + @($group)
}

$node = (Get-Command node -ErrorAction Stop).Source
$hookBase = '"{0}" "{1}" --agent' -f $node, $hookEntrypoint
$codexPath = Join-Path $ProjectPath '.codex\hooks.json'
$codex = Read-JsonMap $codexPath
foreach ($event in @('SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd')) {
  Add-CommandHook $codex $event "$hookBase codex" ($event -in @('UserPromptSubmit', 'PostToolUse'))
}
New-Item -ItemType Directory -Path (Split-Path -Parent $codexPath) -Force | Out-Null
$codex | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $codexPath -Encoding utf8NoBOM

$claudePath = Join-Path $ProjectPath '.claude\settings.local.json'
$claude = Read-JsonMap $claudePath
foreach ($event in @('SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd')) {
  Add-CommandHook $claude $event "$hookBase claude" $false
}
Add-CommandHook $claude 'PostToolUse' "$hookBase claude" $true 'Read|Write|Edit|Bash|Grep|Glob'
New-Item -ItemType Directory -Path (Split-Path -Parent $claudePath) -Force | Out-Null
$claude | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $claudePath -Encoding utf8NoBOM

if (-not $SkipScheduledTask) {
  $powershell = (Get-Command pwsh -ErrorAction Stop).Source
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -File `"$daemonScript`" -RepositoryPath `"$RepositoryPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'ObsidianProjectKnowledgeActivity' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  $workerAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -File `"$workerScript`" -RepositoryPath `"$RepositoryPath`""
  Register-ScheduledTask -TaskName 'ObsidianProjectKnowledgeWorker' -Action $workerAction -Trigger $trigger -Settings $settings -Force | Out-Null
}

[pscustomobject]@{
  activityEndpoint = 'http://127.0.0.1:8765'
  codexHooks = $codexPath
  claudeHooks = $claudePath
  scheduledTask = if ($SkipScheduledTask) { 'skipped' } else { 'ObsidianProjectKnowledgeActivity, ObsidianProjectKnowledgeWorker' }
  token = '<stored securely>'
}
