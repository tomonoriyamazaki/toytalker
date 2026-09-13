# Switch the supervised TTS API between api_server.py (original) and api_server_batch.py (batched engine).
# Run in an ADMIN PowerShell from the repository root:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\tts-service\switch-api.ps1 -ApiScript api_server_batch.py
# Roll back with -ApiScript api_server.py. The public ngrok URL is kept (ngrok is adopted, not restarted).
# -PublicUrl sets config.json "public_url" (fixed hostname such as https://tts.zakicorp.com served by the
# cloudflared Windows service); the supervisor then publishes that URL to the Lambdas instead of the ngrok URL.
# Pass -PublicUrl '' to clear it and go back to the dynamic ngrok URL.
param([Parameter(Mandatory = $true)][ValidateSet('api_server.py', 'api_server_batch.py')][string]$ApiScript,
      [string]$PublicUrl = $null)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$runtime = Join-Path $repo '.local\tts-service'
$configPath = Join-Path $runtime 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath (Join-Path $config.root $ApiScript))) { throw "Missing $ApiScript in $($config.root)" }

function Wait-Health([string]$url, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try { $h = Invoke-RestMethod $url -TimeoutSec 3 -Headers @{ 'ngrok-skip-browser-warning' = '1' }; if ($h.status -eq 'ok') { return $h } } catch {}
        Start-Sleep -Seconds 2
    }
    throw "No healthy response from $url within $seconds seconds"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $configPath -Destination "$runtime\config.json.$stamp.bak"
Copy-Item -LiteralPath "$runtime\supervisor.py" -Destination "$runtime\supervisor.py.$stamp.bak"
Write-Output "Backups: config.json.$stamp.bak, supervisor.py.$stamp.bak"

# 1) stop the supervisor so it does not relaunch the old script
Disable-ScheduledTask -TaskName 'TTS-AutoStart' | Out-Null
Stop-ScheduledTask -TaskName 'TTS-AutoStart'
Start-Sleep -Seconds 2

try {
    # 2) stop the API listening on 8000 (ngrok on 4040/8000 tunnel stays up and is adopted afterwards)
    $listeners = @(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)
    foreach ($l in $listeners) {
        $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
        if ($p) { Write-Output "Stopping API pid=$($p.Id) ($($p.ProcessName))"; Stop-Process -Id $p.Id -Force; $p.WaitForExit() }
    }
    Start-Sleep -Seconds 2
    if (@(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Port 8000 is still in use' }

    # 3) deploy supervisor and select the script
    Copy-Item -LiteralPath "$PSScriptRoot\supervisor.py" -Destination "$runtime\supervisor.py" -Force
    $config | Add-Member -NotePropertyName api_script -NotePropertyValue $ApiScript -Force
    if ($PSBoundParameters.ContainsKey('PublicUrl')) {
        $config | Add-Member -NotePropertyName public_url -NotePropertyValue $PublicUrl -Force
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-Output "config.json api_script = $ApiScript; public_url = $($config.public_url)"
} finally {
    # 4) restart the supervisor; it launches the selected script and re-adopts ngrok
    Enable-ScheduledTask -TaskName 'TTS-AutoStart' | Out-Null
    Start-ScheduledTask -TaskName 'TTS-AutoStart'
}

$h = Wait-Health 'http://127.0.0.1:8000/health' 240
$mode = if ($h.PSObject.Properties.Name -contains 'engine' -and $h.engine) { 'batch engine' } else { 'original' }
Write-Output "Local health OK ($mode)"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.public_url) {
    # Fixed public hostname (Cloudflare Tunnel). The edge rule needs the passphrase header from scripts/.env.
    $url = $config.public_url
    $edgeLine = Get-Content -LiteralPath (Join-Path $config.root 'scripts\.env') | Where-Object { $_ -match '^ZAKICORP_EDGE_KEY=' } | Select-Object -First 1
    $headers = @{ 'User-Agent' = 'toytalker-switch/1.0' }
    if ($edgeLine) { $headers['X-Zakicorp-Edge-Key'] = ($edgeLine -split '=', 2)[1].Trim() }
    $deadline = (Get-Date).AddSeconds(60)
    $ok = $false
    while ((Get-Date) -lt $deadline -and -not $ok) {
        try { $ok = ((Invoke-RestMethod "$url/health" -TimeoutSec 5 -Headers $headers).status -eq 'ok') } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ok) { throw "No healthy response from $url/health" }
} else {
    $tunnels = (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 10).tunnels
    $url = ($tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1).public_url
    Wait-Health "$url/health" 60 | Out-Null
}
Write-Output "Public health OK: $url"
Get-Content -LiteralPath "$runtime\logs\supervisor.log" -Tail 6
