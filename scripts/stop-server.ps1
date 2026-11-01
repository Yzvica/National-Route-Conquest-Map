# 国道制覇マップのサーバーを止める(update.ps1 / install-autostart.ps1 から使う)。
# タスクを止めても run-server.ps1 のループが残ることがあり、新しいループと2つ並んでしまうので、
# ループ(powershell)を止めてから、8080 番で待ち受けている node も止める。
param([int]$Port = 8080)
Stop-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -like "*run-server.ps1*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& (Join-Path $PSScriptRoot "stop-port.ps1") $Port
