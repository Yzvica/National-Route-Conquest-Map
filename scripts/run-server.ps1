# 国道制覇マップのサーバーを動かし続ける。install-autostart.ps1 が登録するタスクから呼ばれる。
# サーバーが落ちても10秒後に立ち上げ直し、終了コードとエラーを data\server.log に残す。
# 動いている間の出力は data\server.out.log / server.err.log で見られる。
param([string]$Node = "node")
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force data | Out-Null
$log = "data\server.log"

while ($true) {
    # ログが大きくなりすぎたら1世代だけ残す
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.old" }
    Add-Content $log "$(Get-Date -Format s) 起動"
    $p = Start-Process -FilePath $Node -ArgumentList "server\server.mjs" -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "data\server.out.log" -RedirectStandardError "data\server.err.log"
    $err = Get-Content "data\server.err.log" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    Add-Content $log "$(Get-Date -Format s) 終了(終了コード $($p.ExitCode))。10秒後に再起動します`n$err"
    Start-Sleep -Seconds 10
}
