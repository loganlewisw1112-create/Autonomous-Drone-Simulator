# Windows instructor launcher for the classroom desktop shell (Electron).
# Builds the classroom UI, then opens the Yes/No Classroom Server splash.
# Requires Node 20+ and a prior `npm install` in the repo root.
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $RepoRoot

if (-not $SkipBuild) {
  Write-Host "Building classroom UI (vite --mode classroom)..."
  npm run classroom:desktop
  if ($LASTEXITCODE -ne 0) { throw "classroom:desktop failed." }
  exit $LASTEXITCODE
}

Write-Host "Launching classroom desktop (existing dist/)..."
npx electron desktop/classroom/main.mjs
exit $LASTEXITCODE
