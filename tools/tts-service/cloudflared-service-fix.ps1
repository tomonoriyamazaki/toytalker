# Run as Administrator. Points the cloudflared Windows service at the user's config/credentials and a log file,
# then restarts it. Used because "cloudflared service install --config" does not persist the config path on Windows.
$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$config = 'C:\Users\exodj\.cloudflared\config.yml'
$logfile = 'C:\Users\exodj\projects\toytalker\.local\tts-service\logs\cloudflared-service.log'
$imagePath = ('"{0}" --config "{1}" --logfile "{2}" tunnel run' -f $exe, $config, $logfile)
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared' -Name ImagePath -Value $imagePath
$out = 'C:\Users\exodj\projects\toytalker\.local\tts-service\logs\cloudflared-install.log'
"ImagePath set: $imagePath" | Out-File -Append $out
Stop-Service cloudflared -ErrorAction SilentlyContinue
Start-Sleep 2
Start-Service cloudflared
Start-Sleep 10
("service {0} {1}" -f (Get-Date -Format HH:mm:ss), (Get-Service cloudflared).Status) | Out-File -Append $out
