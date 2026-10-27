# MiniPC(Windows)で最新のコードと国道データを取り込み、アプリを作り直す。
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
Run npm @("run", "build")

if (Get-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName "KokudoMap"
    Start-ScheduledTask -TaskName "KokudoMap"
    Write-Host "更新して、サーバーを再起動しました。"
} else {
    Write-Host "更新しました。npm run serve で起動してください。"
}
