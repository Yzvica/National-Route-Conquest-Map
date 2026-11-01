# MiniPC(Windows)で最新のコードと国道・高速道路のデータを取り込み、アプリを作り直す。
# 国道データ(リリース route-data)の取得に GitHub CLI(gh)のログインが必要です。
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Run($exe, [string[]]$argList) {
    & $exe @argList
    if ($LASTEXITCODE -ne 0) { throw "$exe $argList が失敗しました(終了コード $LASTEXITCODE)" }
}

# git の後片付け(gc)で「Deletion of directory ... failed. Should I try again? (y/n)」と何度も聞かれて
# 止まることがあるので、自動で「いいえ」と答える。後片付けはこの更新では行わない(gc.auto=0)
$env:GIT_ASK_YESNO = "false"
Run git @("-c", "gc.auto=0", "pull", "--ff-only")
Run npm @("ci")
# 国道データ。回線によっては1本で取ると極端に遅いので、分けて同時に取る(scripts/download_release.mjs)
Run node @("scripts/download_release.mjs", "public/data", "routes.json")
# 高速道路のデータ。まだ作っていなければ国道だけで動く
& node scripts/download_release.mjs public/data expressways.json
if ($LASTEXITCODE -ne 0) { Write-Host "高速道路のデータ(expressways.json)を取れませんでした。今あるもの(なければ国道だけ)で続けます。" }
# 都道府県の形(地図の色分け用)。なくても動く
& node scripts/download_release.mjs public/data prefectures.json
if ($LASTEXITCODE -ne 0) { Write-Host "都道府県のデータ(prefectures.json)を取れませんでした。今あるもの(なければ都道府県別の表示なし)で続けます。" }
Run npm @("run", "build")

if (Get-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue) {
    & (Join-Path $PSScriptRoot "stop-server.ps1") 8080
    Start-ScheduledTask -TaskName "KokudoMap"
    Write-Host "更新して、サーバーを再起動しました。"
} else {
    Write-Host "更新しました。npm run serve で起動してください。"
}
