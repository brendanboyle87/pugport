# One-time setup on Windows: copies your Node.js 24 into .runtime\ (global Node is left untouched),
# installs locked dependencies, then runs typecheck, tests and build.
param([switch]$WithLocalComponents)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.runtime\node.exe')) {
  $studioNode = (Get-Command node.exe -ErrorAction Stop).Source
  $studioVersion = & $studioNode -p 'process.versions.node'
  if ($LASTEXITCODE -ne 0 -or [version]$studioVersion -lt [version]'24.21.0') { throw 'Install Node.js 24.21.0 or newer, then run this setup script again.' }
  New-Item -ItemType Directory -Path '.runtime' -Force | Out-Null
  Copy-Item -LiteralPath $studioNode -Destination '.runtime\node.exe'
}
# Validate an existing private runtime too; a previous setup may have copied an older Node.
$studioRuntime = Join-Path $PSScriptRoot '.runtime\node.exe'
$studioRuntimeVersion = & $studioRuntime -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$studioRuntimeVersion -lt [version]'24.21.0') {
  throw 'The local .runtime\node.exe must be Node.js 24.21.0 or newer. Replace this private runtime before setup.'
}
$env:PATH = (Join-Path $PSScriptRoot '.runtime') + ';' + $env:PATH
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
# The default setup is lightweight: CLI/API chat and keyword search work without local models.
# Use -WithLocalComponents only when deliberately preparing a fully offline environment.
if ($WithLocalComponents) {
  # Optional: reading PDF/Word/Excel/PowerPoint needs Python 3.10+.
  & npm.cmd run setup:markitdown
  if ($LASTEXITCODE -ne 0) { Write-Warning 'MarkItDown was not installed; office documents cannot be read as text.' }
  # Voice input: the local speech-recognition model (about 240 MB installed).
  & npm.cmd run setup:voice
  if ($LASTEXITCODE -ne 0) { Write-Warning 'The voice model was not downloaded; voice input stays off until it is installed in Extensions.' }
  # Earlier conversation by meaning: the local text-embedding model (about 590 MB).
  & npm.cmd run setup:memory-search
  if ($LASTEXITCODE -ne 0) { Write-Warning 'The memory search model was not downloaded; history is searched by keywords until it is installed in Extensions.' }
  # Image search: the local picture and OCR models (about 210 MB installed).
  & npm.cmd run setup:image-search
  if ($LASTEXITCODE -ne 0) { Write-Warning 'The image search model was not downloaded; only exact and near-duplicate matching works until it is installed in Extensions.' }
} else {
  Write-Host 'Local models and optional tools were not downloaded. Add them from Extensions when needed.'
}
& '.\.runtime\node.exe' node_modules/electron/install.js
if ($LASTEXITCODE -ne 0) { throw 'Electron runtime installation failed.' }
# PugPort's icon and name on the development Electron (taskbar, notifications, Start).
& '.\.runtime\node.exe' scripts/brand-electron.mjs
if ($LASTEXITCODE -ne 0) { throw 'Electron branding failed.' }
& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
& npm.cmd run test:ci
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
& '.\.runtime\node.exe' scripts/create-windows-launcher.mjs
if ($LASTEXITCODE -ne 0) { throw 'Hidden Windows launcher generation failed.' }
Write-Host 'Ready. Double-click Start-PugPort.cmd.'
