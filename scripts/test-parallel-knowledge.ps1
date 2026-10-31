param(
  [string]$Image = 'paradedb/paradedb@sha256:533732a54d011c4e9c239cba2d4555c9e2ae5a3f51bcbcfd09252848e4815423'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$containerName = 'obsidian-parallel-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$previousDatabaseUrl = $env:OBSIDIAN_ISOLATED_TEST_DATABASE_URL
$previousLegacyDatabaseUrl = $env:PROJECT_KNOWLEDGE_TEST_DATABASE_URL
$previousSeedFixture = $env:OBSIDIAN_TEST_SEED_LEGACY_FIXTURE
$created = $false
$testExitCode = 1
Push-Location $repoRoot
try {
  # A fresh database and loopback-only random port keep this separate from live services.
  $null = & docker run --detach --rm --name $containerName `
    --label codex.task=obsidian-parallel-tests --publish '127.0.0.1::5432' `
    --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=obsidian_test_parallel `
    --shm-size=256m $Image
  if ($LASTEXITCODE -ne 0) { throw 'Could not start isolated PostgreSQL. Ensure Docker Desktop is running.' }
  $created = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $null = & docker exec $containerName pg_isready -U postgres -d obsidian_test_parallel 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Isolated PostgreSQL did not become ready.' }
  $binding = (& docker port $containerName 5432/tcp).Trim()
  if ($binding -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected database port binding.' }
  $env:OBSIDIAN_ISOLATED_TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:$($Matches[1])/obsidian_test_parallel"
  $env:PROJECT_KNOWLEDGE_TEST_DATABASE_URL = $env:OBSIDIAN_ISOLATED_TEST_DATABASE_URL
  $env:OBSIDIAN_TEST_SEED_LEGACY_FIXTURE = '1'
  & npx vitest run tests/integration/parallel-knowledge.integration.test.ts tests/integration/pg-knowledge.integration.test.ts --fileParallelism=false
  $testExitCode = $LASTEXITCODE
}
finally {
  $env:OBSIDIAN_ISOLATED_TEST_DATABASE_URL = $previousDatabaseUrl
  $env:PROJECT_KNOWLEDGE_TEST_DATABASE_URL = $previousLegacyDatabaseUrl
  $env:OBSIDIAN_TEST_SEED_LEGACY_FIXTURE = $previousSeedFixture
  if ($created) {
    # The unique container name was created by this invocation; no volumes or host files are removed.
    $null = & docker stop $containerName
  }
  Pop-Location
}
exit $testExitCode
