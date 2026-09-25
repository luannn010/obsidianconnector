param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryPath
)

$ErrorActionPreference = 'Stop'
$RepositoryPath = (Resolve-Path -LiteralPath $RepositoryPath).Path
$entrypoint = Join-Path $RepositoryPath 'dist\index.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "Build output is missing: $entrypoint"
}

function Get-ProjectKnowledgeEnvValue([string]$Name, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
      if ($matches[1] -eq $Name) {
        $value = $matches[2]
        if ($value.Length -ge 2) {
          if ($value[0] -eq '"' -and $value[-1] -eq '"') {
            return $value.Substring(1, $value.Length - 2)
          }
          if ($value[0] -eq "'" -and $value[-1] -eq "'") {
            return $value.Substring(1, $value.Length - 2)
          }
        }
        return $value
      }
    }
  }
  return $null
}

$node = (Get-Command node -ErrorAction Stop).Source
$projectKnowledgeEnvPath = Join-Path $HOME '.codex\project-knowledge.env'
if (-not $env:PROJECT_KNOWLEDGE_DATABASE_URL) {
  $env:PROJECT_KNOWLEDGE_DATABASE_URL = Get-ProjectKnowledgeEnvValue `
    -Name 'PROJECT_KNOWLEDGE_DATABASE_URL' `
    -Path $projectKnowledgeEnvPath
}

if (-not $env:OBSIDIAN_MCP_PROFILE) {
  $env:OBSIDIAN_MCP_PROFILE = 'standard'
}

if (
  $env:OBSIDIAN_MCP_PROFILE -eq 'standard' -and
  [string]::IsNullOrWhiteSpace($env:PROJECT_KNOWLEDGE_DATABASE_URL)
) {
  Write-Host "[obsidian-local] No PROJECT_KNOWLEDGE_DATABASE_URL found, falling back to admin profile."
  $env:OBSIDIAN_MCP_PROFILE = 'admin'
}

Set-Location -LiteralPath $RepositoryPath
& $node $entrypoint
