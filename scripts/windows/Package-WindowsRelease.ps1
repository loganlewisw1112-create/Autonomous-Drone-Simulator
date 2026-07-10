# Builds the app and stages a self-contained Windows offline package under outputs/.
# Usage: pwsh scripts/windows/Package-WindowsRelease.ps1 [-Version 1.0.0]
param(
  [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PackageName = "autonomous-drone-simulator-v$Version-windows"
$StageRoot = Join-Path $RepoRoot "outputs\windows-release\staging\$PackageName"

Push-Location $RepoRoot
try {
  # Local-relative base so the package serves from any folder (no Pages base path).
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }

  if (Test-Path $StageRoot) { Remove-Item -Recurse -Force $StageRoot }
  New-Item -ItemType Directory -Force -Path (Join-Path $StageRoot 'app') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $StageRoot 'server') | Out-Null

  Copy-Item -Recurse -Force (Join-Path $RepoRoot 'dist\*') (Join-Path $StageRoot 'app')
  Copy-Item -Force (Join-Path $PSScriptRoot 'Start-DroneSimulator.ps1') (Join-Path $StageRoot 'server\Start-DroneSimulator.ps1')

  $zipPath = Join-Path $RepoRoot "outputs\windows-release\$PackageName.zip"
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  Compress-Archive -Path $StageRoot -DestinationPath $zipPath

  Write-Host "Packaged: $zipPath"
} finally {
  Pop-Location
}
