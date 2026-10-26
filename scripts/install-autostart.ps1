# MiniPC(Windows)の起動時に国道制覇マップのサーバーを自動で立ち上げ、
# LAN の他の端末から 8080 番ポートに入れるようにする。管理者の PowerShell で実行する。
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node).Source
$port = 8080

$action = New-ScheduledTaskAction -Execute $node -Argument "server\server.mjs" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: ログインしていなくても、パスワードを保存せずに自分のユーザーで動かす
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "KokudoMap" -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description "国道制覇マップ(LAN 用サーバー)" -Force | Out-Null

if (-not (Get-NetFirewallRule -DisplayName "KokudoMap" -ErrorAction SilentlyContinue)) {
    # 家庭内ネットワーク(プライベート)からだけ受け付ける
    New-NetFirewallRule -DisplayName "KokudoMap" -Direction Inbound -Protocol TCP -LocalPort $port `
        -Action Allow -Profile Private | Out-Null
}

Start-ScheduledTask -TaskName "KokudoMap"
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in "Dhcp", "Manual" -and $_.IPAddress -notlike "169.*" } |
    Select-Object -First 1).IPAddress
Write-Host "起動しました。LAN の端末から http://${ip}:$port/ を開いてください。"
Write-Host "走行記録は $root\data\record.json に保存されます。"
