# 国道制覇マップのサーバーを止める(update.ps1 / install-autostart.ps1 から使う)。
# タスクを止めても run-server.ps1 のループが残ることがあり、新しいループと2つ並んでしまうので、
# ループ(powershell)を止めてから、8080 番で待ち受けている node も止める。
param([int]$Port = 8080)
Stop-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue
# 8080 を待ち受けている node の親が powershell なら、それが run-server.ps1 のループ。
# タスクのプロセスは別セッションなので、権限によってはコマンドラインが見えないが、親子関係は見える
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $child = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $child) { return }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and $parent.Name -in "powershell.exe", "pwsh.exe" -and $parent.ProcessId -ne $PID) {
        Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -like "*run-server.ps1*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& (Join-Path $PSScriptRoot "stop-port.ps1") $Port
