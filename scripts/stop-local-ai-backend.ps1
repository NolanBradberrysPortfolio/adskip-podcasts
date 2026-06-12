$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runDir = Join-Path $root ".skipcast-local"
$processFile = Join-Path $runDir "processes.json"

if (-not (Test-Path $processFile)) {
  Write-Host "No local SkipCast process file found at $processFile"
  return
}

$processes = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json

foreach ($id in @($processes.serverProcessId, $processes.tunnelProcessId)) {
  if (-not $id) {
    continue
  }

  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $id -Force
    Write-Host "Stopped process $id"
  }
}

Remove-Item -LiteralPath $processFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped local SkipCast AI backend."
