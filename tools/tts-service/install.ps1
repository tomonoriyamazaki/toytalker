# Registers the boot-time supervisor task. Day-to-day changes use switch-api.ps1; this is for (re)registration.
# An existing .local\tts-service\config.json is kept: api_script, public_url and any other key not rebuilt here
# carry over, so re-running does not silently fall back to ngrok and the original engine.
# -ApiScript overrides the kept api_script. -ShowConfig prints the resulting config and changes nothing.
param([switch]$ProbeOnly, [switch]$ShowConfig, [ValidateSet('api_server.py', 'api_server_batch.py')][string]$ApiScript)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$runtime = Join-Path $repo '.local\tts-service'
$configPath = Join-Path $runtime 'config.json'
$previous = $null
if (Test-Path -LiteralPath $configPath) {
    $previous = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
if (-not $PSBoundParameters.ContainsKey('ApiScript')) {
    $ApiScript = if ($previous -and $previous.api_script) { $previous.api_script } else { 'api_server.py' }
}
if (-not $ShowConfig) {
    $existing = Get-ScheduledTask -TaskName 'TTS-AutoStart' -ErrorAction Stop
    if ($existing.State -eq 'Running') {
        throw 'TTS-AutoStart is running. Schedule a maintenance window and stop the task before reinstalling.'
    }
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
}
$config = @{
    root = 'C:\Users\exodj\projects\tts-models\faster-qwen3-tts'
    profile = 'C:\Users\exodj'
    python = (Get-Command python -ErrorAction Stop).Source
    ngrok = (Get-Command ngrok -ErrorAction Stop).Source
    aws = (Get-Command aws -ErrorAction Stop).Source
    ngrok_config = 'C:\Users\exodj\AppData\Local\ngrok\ngrok.yml'
    logs = (Join-Path $runtime 'logs')
    api_script = $ApiScript
}
if ($previous) {
    foreach ($property in $previous.PSObject.Properties) {
        if (-not $config.ContainsKey($property.Name)) { $config[$property.Name] = $property.Value }
    }
}
foreach ($path in @($config.root, $config.python, $config.ngrok, $config.aws, $config.ngrok_config, (Join-Path $config.root $ApiScript))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $path" }
}
if ($ShowConfig) {
    $source = if ($previous) { "kept from $configPath" } else { 'no existing config.json; defaults' }
    Write-Output "Resulting config ($source). Nothing was changed."
    $config | ConvertTo-Json
    exit
}
if ($previous) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
}
$identity = $existing.Principal.UserId
$backup = Join-Path $runtime 'TTS-AutoStart.before.xml'
if (-not (Test-Path -LiteralPath $backup)) {
    Export-ScheduledTask -TaskName 'TTS-AutoStart' | Set-Content -LiteralPath $backup -Encoding Unicode
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
Write-Host "config.json api_script = $($config.api_script); public_url = $($config.public_url)"
Copy-Item -LiteralPath "$PSScriptRoot\supervisor.py" -Destination "$runtime\supervisor.py" -Force
$argument = '-u "{0}\supervisor.py" --config "{0}\config.json"' -f $runtime
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
if ($ProbeOnly) {
    $action = New-ScheduledTaskAction -Execute $config.python -Argument "$argument --probe" -WorkingDirectory $config.root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    Register-ScheduledTask -TaskName 'TTS-BootProbe' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'TTS-BootProbe'
    Write-Host "Probe started. Check $runtime\logs\probe.log and task result before installing."
    exit
}
$probe = Get-ScheduledTaskInfo -TaskName 'TTS-BootProbe' -ErrorAction Stop
if ($probe.LastTaskResult -ne 0 -or $probe.LastRunTime -lt (Get-Date).AddHours(-1)) {
    throw 'Run install.ps1 -ProbeOnly and verify a successful recent probe first.'
}
$action = New-ScheduledTaskAction -Execute $config.python -Argument $argument -WorkingDirectory $config.root
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'TTS-AutoStart' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'Boot-time TTS and ngrok supervisor; no interactive logon required' -Force | Out-Null
Start-ScheduledTask -TaskName 'TTS-AutoStart'
Write-Host "Installed and started. Previous task XML: $backup"
