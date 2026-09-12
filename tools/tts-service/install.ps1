param([switch]$ProbeOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$existing = Get-ScheduledTask -TaskName 'TTS-AutoStart' -ErrorAction Stop
if ($existing.State -eq 'Running') {
    throw 'TTS-AutoStart is running. Schedule a maintenance window and stop the task before reinstalling.'
}
$runtime = Join-Path $repo '.local\tts-service'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$config = @{
    root = 'C:\Users\exodj\projects\tts-models\faster-qwen3-tts'
    profile = 'C:\Users\exodj'
    python = (Get-Command python -ErrorAction Stop).Source
    ngrok = (Get-Command ngrok -ErrorAction Stop).Source
    aws = (Get-Command aws -ErrorAction Stop).Source
    ngrok_config = 'C:\Users\exodj\AppData\Local\ngrok\ngrok.yml'
    logs = (Join-Path $runtime 'logs')
}
foreach ($path in @($config.root, $config.python, $config.ngrok, $config.aws, $config.ngrok_config)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $path" }
}
$identity = $existing.Principal.UserId
$backup = Join-Path $runtime 'TTS-AutoStart.before.xml'
if (-not (Test-Path -LiteralPath $backup)) {
    Export-ScheduledTask -TaskName 'TTS-AutoStart' | Set-Content -LiteralPath $backup -Encoding Unicode
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'config.json') -Encoding UTF8
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
