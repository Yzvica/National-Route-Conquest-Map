# 国道制覇マップのサーバーを動かし続ける。install-autostart.ps1 が登録するタスク KokudoMap から呼ばれる。
# 1回分の起動・終了・再起動の待ちは server-once.ps1 がする。それを毎回ファイルから読み直して呼ぶので、
# update.ps1 で server-once.ps1 が新しくなっても、このループを止めずに次の起動から新しいものになる。
# このファイル自体はなるべく変えない(変えたときは MiniPC の再起動か、管理者で install-autostart.ps1)。
param([string]$Node = "node")
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force data | Out-Null
$log = "data\server.log"

# 二重に動かさない。前のループが残っていると、新しいループと2つ並び、片方が 8080 を取れずに
# 10秒ごとの起動・終了を何時間も繰り返したことがある(2026-11-01)。
# 前のループが強制終了されていれば、持ち主のいない Mutex になるので取り直せる
$mutex = New-Object System.Threading.Mutex($false, "Global\KokudoMapServer")
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Add-Content $log "$(Get-Date -Format s) すでにサーバーが動いているので、起動せずに終わります"
    exit 0
}

# 起動をくり返しても覚えておくこと(すぐ落ちた回数)
$state = @{ QuickFails = 0 }
while ($true) {
    try {
        & (Join-Path $PSScriptRoot "server-once.ps1") -Node $Node -State $state
    } catch {
        # server-once.ps1 が壊れていても、ループは止めずに待ってからやり直す
        Add-Content $log "$(Get-Date -Format s) server-once.ps1 でエラー: $_。60 秒後にやり直します"
        Start-Sleep -Seconds 60
    }
}
