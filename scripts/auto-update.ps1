# 新しいコードや国道データが出ていれば取り込んで、サーバーを再起動する。
# install-autoupdate.ps1 が登録するタスク KokudoMapUpdate から5分ごとに呼ばれる。手で動かしてもよい。
#   powershell -ExecutionPolicy Bypass -File scripts\auto-update.ps1
# 調べるだけなら GitHub に2回問い合わせるだけで軽い。取り込むのは新しいものがあるときだけで、
# 国道データは変わっていなければ取り直さない(download_release.mjs)。
# git と gh のログイン情報(Windows の資格情報マネージャー)を使うので、サーバーのタスク(S4U)ではなく、
# ログオン中のユーザーとして動かす。記録は data\update.log(UTF-8)に残す。
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force data | Out-Null
$log = "data\update.log"
# node の出力(UTF-8)をそのまま読む。既定(シフトJIS)のままだと記録が文字化けする
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Log([string[]]$Lines) { Add-Content $log $Lines -Encoding UTF8 }
if (Test-Path $log) {
    $head = [System.IO.File]::ReadAllBytes((Resolve-Path $log)) | Select-Object -First 3
    # 大きくなりすぎたとき、または以前の文字コード(BOM なし)の記録は1世代だけ残して分ける
    if ((Get-Item $log).Length -gt 1MB -or ($head -join ",") -ne "239,187,191") { Move-Item -Force $log "$log.old" }
}

$out = & node scripts/check_update.mjs 2>&1
$code = $LASTEXITCODE
if ($code -eq 0) { exit 0 }  # 最新(5分ごとの記録は残さない)
# 同じ更新で失敗したばかりなら、1時間は試し直さない(5分ごとに失敗を繰り返して記録が埋まらないように)
$failed = "data\update.failed"
$what = $out -join ' '
if ((Test-Path $failed) -and ((Get-Date) - (Get-Item $failed).LastWriteTime).TotalMinutes -lt 60 -and
    (Get-Content $failed -Raw -Encoding UTF8).Trim() -eq $what.Trim()) { exit 1 }
Write-Log "$(Get-Date -Format s) $what"
if ($code -ne 10) { Set-Content $failed $what -Encoding UTF8; exit 1 }

Write-Log "$(Get-Date -Format s) 更新を始めます"
$ok = $true
try {
    # 別の powershell.exe で動かす。同じ PowerShell の中で *>&1 を付けて呼ぶと、update.ps1 の
    # $ErrorActionPreference = "Stop" のもとで git pull が標準エラーに出す普通の行(From https://...)まで
    # エラー扱いになり、pull のあと止まってビルドされなかった(2026-11-10)。
    # 出力は UTF-8 にそろえる(そろえないと、記録が文字化けする)
    $update = Join-Path $PSScriptRoot "update.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -Command `
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '$update'; exit `$LASTEXITCODE" 2>&1 |
        ForEach-Object { "$_" } |
        Where-Object { $_ -notmatch "^\s*$" } | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) { $ok = $false; $why = "終了コード $LASTEXITCODE" }
} catch {
    $ok = $false; $why = "$_"
}
Write-Log "$(Get-Date -Format s) 更新$(if ($ok) { 'しました' } else { "に失敗しました($why)" })"
if (-not $ok) {
    Set-Content $failed $what -Encoding UTF8
    exit 1
}
Remove-Item $failed -ErrorAction SilentlyContinue
