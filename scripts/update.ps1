# MiniPC(Windows)で最新のコードと国道・高速道路のデータを取り込み、アプリを作り直す。
# 国道データ(リリース route-data)の取得に GitHub CLI(gh)のログインが必要です。
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Run($exe, [string[]]$argList) {
    & $exe @argList
    if ($LASTEXITCODE -ne 0) { throw "$exe $argList が失敗しました(終了コード $LASTEXITCODE)" }
}

Run git @("pull", "--ff-only")
Run npm @("ci")
Run gh @("release", "download", "route-data", "-p", "routes.json", "-D", "public/data", "--clobber")
# 高速道路のデータ。まだ作っていなければ国道だけで動く
& gh release download route-data -p expressways.json -D public/data --clobber
if ($LASTEXITCODE -ne 0) { Write-Host "高速道路のデータ(expressways.json)はまだありません。国道だけで続けます。" }
# 都道府県の形(地図の色分け用)。なくても動く
& gh release download route-data -p prefectures.json -D public/data --clobber
if ($LASTEXITCODE -ne 0) { Write-Host "都道府県のデータ(prefectures.json)はまだありません。都道府県別の表示なしで続けます。" }
Run npm @("run", "build")

if (Get-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName "KokudoMap"
    & (Join-Path $PSScriptRoot "stop-port.ps1") 8080
    Start-ScheduledTask -TaskName "KokudoMap"
    Write-Host "更新して、サーバーを再起動しました。"
} else {
    Write-Host "更新しました。npm run serve で起動してください。"
}
