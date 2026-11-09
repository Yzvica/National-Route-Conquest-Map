# 国道制覇マップのサーバーを再起動する(update.ps1 から使う。管理者でなくてよい)。
#   powershell -ExecutionPolicy Bypass -File scripts\restart-server.ps1
# タスク KokudoMap の中のループ(server-once.ps1)に data\restart.request で頼み、
# 新しいサーバーが 8080 番で待ち受けるまで待つ。
param([int]$Port = 8080, [int]$TimeoutSec = 180)
Set-Location (Join-Path $PSScriptRoot "..")
$stateFile = "data\server.state.json"
$request = "data\restart.request"

function Read-State {
    try { Get-Content $stateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

$before = Read-State
$loop = if ($before) { Get-Process -Id $before.supervisor -ErrorAction SilentlyContinue }
if ($loop -and $loop.ProcessName -in "powershell", "pwsh") {
    Set-Content $request "$env:USERNAME $(Get-Date -Format s)" -Encoding UTF8
    $until = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $until) {
        Start-Sleep -Seconds 2
        $now = Read-State
        if ($now -and $now.node -ne $before.node) {
            $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.OwningProcess -eq $now.node }
            if ($listen) {
                Write-Host "サーバーを再起動しました(PID $($before.node) → $($now.node))。"
                exit 0
            }
        }
    }
    Write-Host "再起動を頼みましたが、$TimeoutSec 秒たっても新しいサーバーが $Port 番で待ち受けていません。data\server.log を見てください。"
    exit 1
}

# まだ restart.request に対応していない古いループ(または止まっている)
if (-not (Get-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue)) {
    Write-Host "自動起動(タスク KokudoMap)がありません。npm run serve で起動するか、管理者で scripts\install-autostart.ps1 を実行してください。"
    exit 1
}
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Start-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue
    Write-Host "サーバーが止まっていたので、タスク KokudoMap を起動しました。"
    exit 0
}
& (Join-Path $PSScriptRoot "stop-server.ps1") $Port
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "古い形で動いているサーバーを止められませんでした(権限が足りません)。一度だけ、管理者の PowerShell で"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1"
    Write-Host "を実行するか、MiniPC を再起動してください。以後は管理者なしで再起動できます。"
    exit 1
}
Start-ScheduledTask -TaskName "KokudoMap"
Write-Host "サーバーを再起動しました。"
