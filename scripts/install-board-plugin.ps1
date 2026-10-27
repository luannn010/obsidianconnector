[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepositoryPath,
  [string]$RegistryPath,
  [string[]]$Vault,
  [switch]$SkipBuild
)

# Builds obsidian-plugin/ and installs it as the `project-board` community plugin
# into every vault registered in config/vaults.json (or only the -Vault names given).

$ErrorActionPreference = 'Stop'
if (-not $RepositoryPath) {
  $RepositoryPath = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$RepositoryPath = (Resolve-Path -LiteralPath $RepositoryPath).Path
if (-not $RegistryPath) {
  $RegistryPath = Join-Path $RepositoryPath 'config\vaults.json'
}
$pluginSource = Join-Path $RepositoryPath 'obsidian-plugin'
$pluginId = 'project-board'
$artifacts = @('main.js', 'manifest.json', 'styles.css')

if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
  throw "Vault registry not found: $RegistryPath"
}
$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$targets = @()
foreach ($property in $registry.vaults.PSObject.Properties) {
  if ($Vault -and ($Vault -notcontains $property.Name)) { continue }
  if ($property.Value.readOnly -eq $true) {
    Write-Warning "Skipping read-only vault $($property.Name)"
    continue
  }
  $targets += [pscustomobject]@{ Name = $property.Name; Path = [string]$property.Value.path }
}
if ($targets.Count -eq 0) {
  throw 'No matching writable vaults in the registry.'
}

if (-not $SkipBuild) {
  if ($PSCmdlet.ShouldProcess($pluginSource, 'npm install and npm run build')) {
    Push-Location -LiteralPath $pluginSource
    try {
      if (-not (Test-Path -LiteralPath (Join-Path $pluginSource 'node_modules'))) {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
      }
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }
}

foreach ($target in $targets) {
  $obsidianDir = Join-Path $target.Path '.obsidian'
  $pluginDir = Join-Path $obsidianDir "plugins\$pluginId"
  if (-not (Test-Path -LiteralPath $target.Path -PathType Container)) {
    Write-Warning "Vault folder not found for $($target.Name): $($target.Path)"
    continue
  }

  if ($PSCmdlet.ShouldProcess($pluginDir, "Install $pluginId plugin for vault $($target.Name)")) {
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
    foreach ($file in $artifacts) {
      $source = Join-Path $pluginSource $file
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Build output missing: $source (run without -SkipBuild)"
      }
      Copy-Item -LiteralPath $source -Destination (Join-Path $pluginDir $file) -Force
    }
    Write-Output "Installed $pluginId into $pluginDir"
  }

  $communityPlugins = Join-Path $obsidianDir 'community-plugins.json'
  $enabled = @()
  if (Test-Path -LiteralPath $communityPlugins -PathType Leaf) {
    $raw = Get-Content -LiteralPath $communityPlugins -Raw
    if ($raw.Trim()) {
      # Windows PowerShell emits a JSON array as one object; assign before wrapping.
      $parsed = ConvertFrom-Json -InputObject $raw
      $enabled = @($parsed | ForEach-Object { [string]$_ })
    }
  }
  if ($enabled -notcontains $pluginId) {
    if ($PSCmdlet.ShouldProcess($communityPlugins, "Enable $pluginId")) {
      $enabled = [string[]]($enabled + $pluginId)
      $json = ConvertTo-Json -InputObject $enabled -Compress
      [System.IO.File]::WriteAllText($communityPlugins, $json, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output "Enabled $pluginId in $communityPlugins"
    }
  } else {
    Write-Output "$pluginId already enabled for $($target.Name)"
  }
}

Write-Output 'Reload Obsidian (or toggle the plugin in Settings > Community plugins) to load the new build.'
