# サーバー(node server\server.mjs)を1回起動し、終わるまで見守る。run-server.ps1 のループから毎回呼ばれる。
# - 落ちたら 10 秒後(すぐ落ちるときは最大5分後)に戻り、ループがまた起動する。終了コードとエラーは data\server.log に残す
# - data\restart.request ができたら(restart-server.ps1 / update.ps1 が作る)、サーバーを止めてすぐ戻る。
#   サーバーはタスク(S4U)の中で動いていて、ほかのユーザー画面の PowerShell からは止められない(Access denied)ので、
#   止めるのは同じタスクの中にいるこのスクリプトの役目
# - 動いている間の出力は data\server.out.log / server.err.log で見られる
param([string]$Node = "node", [hashtable]$State = @{ QuickFails = 0 })
$log = "data\server.log"
$request = "data\restart.request"
$stateFile = "data\server.state.json"

# ログが大きくなりすぎたら1世代だけ残す
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.old" }
# 起動する前の依頼は、この起動で満たされる
Remove-Item $request -Force -ErrorAction SilentlyContinue
Add-Content $log "$(Get-Date -Format s) 起動"
$started = Get-Date
$p = Start-Process -FilePath $Node -ArgumentList "server\server.mjs" -NoNewWindow -PassThru `
    -RedirectStandardOutput "data\server.out.log" -RedirectStandardError "data\server.err.log"
$null = $p.Handle  # これを取っておかないと、終わったあと ExitCode が読めない
# restart-server.ps1 が「新しいサーバーに入れ替わったか」を見るためのもの
[ordered]@{ supervisor = $PID; node = $p.Id; started = $started.ToString("o") } | ConvertTo-Json |
    Set-Content $stateFile -Encoding UTF8

function Wait-Request([int]$Seconds) {
    # 待つ間も再起動の依頼を見る。依頼があれば $true
    $until = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $until) {
        if (Test-Path $request) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

while (-not $p.HasExited) {
    if (Test-Path $request) {
        $who = Get-Content $request -Raw -ErrorAction SilentlyContinue
        Add-Content $log "$(Get-Date -Format s) 再起動の依頼($("$who".Trim()))。サーバーを止めて立ち上げ直します"
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $null = $p.WaitForExit(30000)
        $State.QuickFails = 0
        return
    }
    Start-Sleep -Seconds 2
}

$err = Get-Content "data\server.err.log" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if (((Get-Date) - $started).TotalSeconds -lt 30) { $State.QuickFails++ } else { $State.QuickFails = 0 }
$wait = [Math]::Min(10 * [Math]::Pow(2, [Math]::Max(0, $State.QuickFails - 1)), 300)
Add-Content $log "$(Get-Date -Format s) 終了(終了コード $($p.ExitCode))。$wait 秒後に再起動します`n$err"
if (Wait-Request $wait) {
    Add-Content $log "$(Get-Date -Format s) 再起動の依頼があったので、待たずに起動します"
    $State.QuickFails = 0
}
