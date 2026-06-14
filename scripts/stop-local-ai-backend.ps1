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

$port = $processes.port
if ($port) {
  $listeners = netstat -ano | Select-String ":$port\s+.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
  } | Sort-Object -Unique

  foreach ($id in $listeners) {
    $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    $commandLine = $processInfo.CommandLine
    $isSkipCastServer = $commandLine -and $commandLine.Contains($root.Path) -and $commandLine.Contains("server/index.ts")
    if ($process -and $process.ProcessName -in @("node", "tsx") -and $isSkipCastServer) {
      Stop-Process -Id ([int]$id) -Force
      Write-Host "Stopped process $id listening on port $port"
    }
  }
}

Remove-Item -LiteralPath $processFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped local SkipCast AI backend."
