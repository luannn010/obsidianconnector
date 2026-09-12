[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$Registry = '192.168.0.164:5000',
  [string]$Repository = 'project-knowledge-worker'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$docker = (Get-Command docker.exe -ErrorAction Stop).Source
$inputs = @('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'services/queue-worker/Dockerfile')
$files = foreach ($input in $inputs) {
  $full = Join-Path $repoRoot $input
  if (Test-Path -LiteralPath $full -PathType Container) { Get-ChildItem -LiteralPath $full -File -Recurse } else { Get-Item -LiteralPath $full }
}
$manifest = $files | Sort-Object FullName | ForEach-Object {
  "$([IO.Path]::GetRelativePath($repoRoot, $_.FullName).Replace('\', '/'))`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $release = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($manifest -join "`n"))))).Replace('-', '').ToLowerInvariant().Substring(0, 24) }
finally { $sha.Dispose() }
$tag = "$Registry/${Repository}:$release"
if (-not $PSCmdlet.ShouldProcess($tag, 'Build and push linux/amd64 worker image')) {
  [ordered]@{ release = $release; tag = $tag; platform = 'linux/amd64'; action = 'what-if' } | ConvertTo-Json -Compress
  return
}
$buildOutput = & $docker buildx build --platform linux/amd64 --file (Join-Path $repoRoot 'services\queue-worker\Dockerfile') --tag $tag --push $repoRoot 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Worker image build or push failed' }
foreach ($line in $buildOutput) { Write-Verbose $line }
$inspection = & $docker buildx imagetools inspect $tag 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the pushed image digest' }
$digestLine = $inspection | Where-Object { $_ -match '^Digest:\s+(sha256:[0-9a-f]{64})$' } | Select-Object -First 1
if (-not $digestLine -or $digestLine -notmatch '(sha256:[0-9a-f]{64})') { throw 'Registry did not return an image digest' }
[ordered]@{ release = $release; tag = $tag; image = "$Registry/${Repository}@$($matches[1])"; platform = 'linux/amd64' } | ConvertTo-Json -Compress
