# 1時間ごとに新しいコード・国道データを調べて取り込むタスク KokudoMapUpdate を登録する。管理者でなくてよい。
#   powershell -ExecutionPolicy Bypass -File scripts\install-autoupdate.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autoupdate.ps1 -Remove   # やめる
# git / gh のログイン情報を使うので、ログオン中だけ動く(MiniPC はログオンしたままにしておく)。
param([switch]$Remove, [int]$IntervalMinutes = 60)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$name = "KokudoMapUpdate"
if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "自動更新(タスク $name)をやめました。"
    exit 0
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $root `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\auto-update.ps1`""
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $every -Principal $principal `
    -Settings $settings -Description "国道制覇マップの自動更新(新しいコード・国道データを取り込んで再起動)" -Force | Out-Null
Write-Host "$IntervalMinutes 分ごとに更新を調べます(タスク $name)。記録は $root\data\update.log に残ります。"
