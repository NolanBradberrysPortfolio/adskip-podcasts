param(
  [int]$Port = 4300,
  [string]$Repo = "NolanBradberrysPortfolio/adskip-podcasts",
  [switch]$NoDeploy
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runDir = Join-Path $root ".skipcast-local"
$serverLog = Join-Path $runDir "server.log"
$tunnelLog = Join-Path $runDir "cloudflared.log"
$origin = "https://nolanbradberrysportfolio.github.io"

New-Item -ItemType Directory -Force -Path $runDir | Out-Null
Remove-Item -LiteralPath $serverLog, $tunnelLog -Force -ErrorAction SilentlyContinue

if (-not $env:OPENAI_API_KEY) {
  Write-Host "OPENAI_API_KEY is not set. Starting local Whisper transcription instead."
  if (-not $env:LOCAL_WHISPER_TRANSCRIBE) {
    $env:LOCAL_WHISPER_TRANSCRIBE = "true"
  }
  if (-not $env:LOCAL_WHISPER_MODEL) {
    $env:LOCAL_WHISPER_MODEL = "Xenova/whisper-tiny.en"
  }
  if (-not $env:LOCAL_WHISPER_MAX_AUDIO_MB) {
    $env:LOCAL_WHISPER_MAX_AUDIO_MB = "20"
  }
  if (-not $env:LOCAL_WHISPER_MAX_SECONDS) {
    $env:LOCAL_WHISPER_MAX_SECONDS = "180"
  }
}

$cloudflared = Join-Path $root "tools\cloudflared-386.exe"
if (-not (Test-Path $cloudflared)) {
  $cloudflared = Join-Path $root "tools\cloudflared.exe"
}

if (-not (Test-Path $cloudflared)) {
  throw "Cloudflared was not found in tools\."
}

$env:PORT = "$Port"
$env:CORS_ORIGINS = $origin
if (-not $env:OPENAI_TRANSCRIBE_MODEL) {
  $env:OPENAI_TRANSCRIBE_MODEL = "whisper-1"
}
if (-not $env:OPENAI_AD_DETECTION_MODEL) {
  $env:OPENAI_AD_DETECTION_MODEL = "gpt-4o-mini"
}
$env:ALLOW_UNAUTHENTICATED_ANALYZE = "true"
if (-not $env:ANALYZE_RATE_LIMIT_MAX_REQUESTS) {
  $env:ANALYZE_RATE_LIMIT_MAX_REQUESTS = "3"
}
if (-not $env:ANALYZE_MAX_CONCURRENT) {
  $env:ANALYZE_MAX_CONCURRENT = "1"
}

$serverCommand = @"
Set-Location '$root'
npm run server:start *> '$serverLog'
"@

Write-Host "Starting SkipCast API on http://localhost:$Port ..."
$serverProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCommand) -WindowStyle Hidden -PassThru

Write-Host "Starting Cloudflare tunnel ..."
$tunnelArgs = "/c ""`"$cloudflared`" tunnel --url http://localhost:$Port --no-autoupdate 1> `"$tunnelLog`" 2>&1"""
$tunnelProcess = Start-Process -FilePath "cmd.exe" -ArgumentList $tunnelArgs -WindowStyle Hidden -PassThru

$apiUrl = $null
for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
  Start-Sleep -Seconds 2
  if (Test-Path $tunnelLog) {
    $log = Get-Content -LiteralPath $tunnelLog -Raw -ErrorAction SilentlyContinue
    if ($log -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
      $apiUrl = $Matches[0]
      break
    }
  }
}

if (-not $apiUrl) {
  Write-Host "Server log: $serverLog"
  Write-Host "Tunnel log: $tunnelLog"
  throw "Could not find the trycloudflare URL in the tunnel log."
}

Write-Host "Tunnel URL: $apiUrl"

@{
  apiUrl = $apiUrl
  port = $Port
  serverProcessId = $serverProcess.Id
  tunnelProcessId = $tunnelProcess.Id
  startedAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDir "processes.json")

for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri "$apiUrl/api/health" -TimeoutSec 15
    Write-Host "Health: ok=$($health.ok) openai=$($health.openai) localWhisper=$($health.localWhisper) adModel=$($health.adDetectionModel)"
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}

if ($NoDeploy) {
  Write-Host "Skipped GitHub Pages redeploy. To deploy manually:"
  Write-Host "gh workflow run pages.yml --repo $Repo --ref main --field api_url=`"$apiUrl`""
} else {
  Write-Host "Redeploying GitHub Pages to point at $apiUrl ..."
  gh workflow run pages.yml --repo $Repo --ref main --field api_url="$apiUrl"
  Write-Host "Deploy started. Keep this computer awake while testing from your phone."
}

Write-Host "API process id: $($serverProcess.Id)"
Write-Host "Tunnel process id: $($tunnelProcess.Id)"
Write-Host "Logs: $runDir"
