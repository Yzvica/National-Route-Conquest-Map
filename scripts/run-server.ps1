# 国道制覇マップのサーバーを動かし続ける。install-autostart.ps1 が登録するタスクから呼ばれる。
# サーバーが落ちても10秒後(すぐ落ちるときは最大5分後)に立ち上げ直し、終了コードとエラーを data\server.log に残す。
# 動いている間の出力は data\server.out.log / server.err.log で見られる。
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

# すぐ落ちる(ポートがふさがっているなど)ときは、待つ時間を延ばしていく(10秒 → 最大5分)
$quickFails = 0
while ($true) {
    # ログが大きくなりすぎたら1世代だけ残す
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.old" }
    Add-Content $log "$(Get-Date -Format s) 起動"
    $started = Get-Date
    $p = Start-Process -FilePath $Node -ArgumentList "server\server.mjs" -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "data\server.out.log" -RedirectStandardError "data\server.err.log"
    $err = Get-Content "data\server.err.log" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (((Get-Date) - $started).TotalSeconds -lt 30) { $quickFails++ } else { $quickFails = 0 }
    $wait = [Math]::Min(10 * [Math]::Pow(2, [Math]::Max(0, $quickFails - 1)), 300)
    Add-Content $log "$(Get-Date -Format s) 終了(終了コード $($p.ExitCode))。$wait 秒後に再起動します`n$err"
    Start-Sleep -Seconds $wait
}
