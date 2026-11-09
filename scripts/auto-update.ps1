# 新しいコードや国道データが出ていれば取り込んで、サーバーを再起動する。
# install-autoupdate.ps1 が登録するタスク KokudoMapUpdate から1時間ごとに呼ばれる。手で動かしてもよい。
#   powershell -ExecutionPolicy Bypass -File scripts\auto-update.ps1
# git と gh のログイン情報(Windows の資格情報マネージャー)を使うので、サーバーのタスク(S4U)ではなく、
# ログオン中のユーザーとして動かす。記録は data\update.log に残す。
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force data | Out-Null
$log = "data\update.log"
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.old" }

$out = & node scripts/check_update.mjs 2>&1
$code = $LASTEXITCODE
if ($code -eq 0) { exit 0 }  # 最新(毎時の記録は残さない)
Add-Content $log "$(Get-Date -Format s) $($out -join ' ')"
if ($code -ne 10) { exit 1 }

Add-Content $log "$(Get-Date -Format s) 更新を始めます"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update.ps1") *>&1 |
    ForEach-Object { "$_" } | Where-Object { $_ -notmatch "^\s*$" } | Add-Content $log
$ok = $LASTEXITCODE -eq 0
Add-Content $log "$(Get-Date -Format s) 更新$(if ($ok) { 'しました' } else { "に失敗しました(終了コード $LASTEXITCODE)" })"
if (-not $ok) { exit 1 }
