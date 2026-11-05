param([string]$SkillPath = (Join-Path $HOME '.codex/skills/project-knowledge-server'))
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('knowledge-preview-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
$scratch = Join-Path $fixture 'scratch'
[void][IO.Directory]::CreateDirectory($scratch)
try {
  $canary = 'preview_canary_' + [guid]::NewGuid().ToString('N')
  $envFile = Join-Path $fixture 'fixture.env'
  [IO.File]::WriteAllLines($envFile, @(
    "PROJECT_KNOWLEDGE_MIGRATION_DATABASE_URL=postgres://owner:${canary}@127.0.0.1/test",
    "PROJECT_KNOWLEDGE_DATABASE_URL=postgres://runtime:${canary}@127.0.0.1/test",
    'PROJECT_KNOWLEDGE_MODEL_BASE_URL=http://127.0.0.1:8080',
    "PROJECT_KNOWLEDGE_MODEL_API_TOKEN=$canary",
    "PROJECT_KNOWLEDGE_ACTIVITY_TOKEN=$canary",
    'PROJECT_KNOWLEDGE_SSH_TARGET=preview@127.0.0.1',
    'PROJECT_KNOWLEDGE_REMOTE_ROOT=/tmp/knowledge-preview'
  ))
  foreach ($name in @('common.ps1', 'deploy-models.ps1', 'migrate.ps1', 'provision.ps1')) {
    $source = [IO.File]::ReadAllText((Join-Path $SkillPath "scripts/$name"))
    if ($name -eq 'common.ps1') {
      $source = $source.Replace("'C:\Users\luann\.codex\project-knowledge.env'", "'$($envFile.Replace("'", "''"))'")
    }
    [IO.File]::WriteAllText((Join-Path $fixture $name), $source)
  }
  foreach ($name in @('deploy-models.ps1', 'migrate.ps1', 'provision.ps1')) {
    $start = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-File', (Join-Path $fixture $name), '-WhatIf', '-Verbose')) { [void]$start.ArgumentList.Add($arg) }
    if ($name -ne 'provision.ps1') {
      [void]$start.ArgumentList.Add('-RepositoryPath')
      [void]$start.ArgumentList.Add($repository)
    }
    $start.Environment['TEMP'] = $scratch
    $start.Environment['TMP'] = $scratch
    foreach ($key in @($start.Environment.Keys)) {
      if ($key.StartsWith('PROJECT_KNOWLEDGE_')) { [void]$start.Environment.Remove($key) }
    }
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'Preview did not finish without external work' }
    $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
    if ($output.Contains($canary)) { throw "Credential output detected in $name preview (values withheld)" }
    if ($process.ExitCode -ne 0) { throw "$name preview failed (output withheld)" }
    if ($output -notmatch 'What if:') { throw "$name did not report its preview action" }
    if (@(Get-ChildItem -LiteralPath $scratch -Force).Count -ne 0) { throw "$name preview created temporary files" }
  }
  [ordered]@{ previews = 3; credentialLeaks = 0; temporaryArtifacts = 0; result = 'passed' } | ConvertTo-Json -Compress
} finally {
  $resolved = [IO.Path]::GetFullPath($fixture)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^knowledge-preview-test-[0-9a-f]{32}$') { throw 'Unexpected preview fixture cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
