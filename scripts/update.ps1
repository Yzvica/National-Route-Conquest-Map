# MiniPC(Windows)で最新のコードと国道・高速道路・都道府県道のデータを取り込み、アプリを作り直す。
# 国道データ(リリース route-data)の取得に GitHub CLI(gh)のログインが必要です。
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1              # 取り込んでサーバーを再起動
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -NoRestart   # 再起動はしない
# 管理者でなくてよい。サーバーの再起動は scripts\restart-server.ps1 がタスクの中のループに頼む。
# 国道データは前回から変わっていなければ取り直さない(scripts/download_release.mjs)。
param([switch]$NoRestart)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# 手で動かした更新と自動更新(auto-update.ps1)が重ならないようにする
$mutex = New-Object System.Threading.Mutex($false, "Global\KokudoMapUpdate")
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-Host "ほかで更新中なので、終わってからもう一度実行してください。"
    exit 1
}

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
# 終了コード 3 は「前回と同じなので取らなかった」
& node scripts/download_release.mjs public/data routes.json
if ($LASTEXITCODE -notin 0, 3) { throw "国道データ(routes.json)を取れませんでした(終了コード $LASTEXITCODE)" }
# 高速道路のデータ。まだ作っていなければ国道だけで動く
& node scripts/download_release.mjs public/data expressways.json
if ($LASTEXITCODE -notin 0, 3) { Write-Host "高速道路のデータ(expressways.json)を取れませんでした。今あるもの(なければ国道だけ)で続けます。" }
# 都道府県の形(地図の色分け用)。なくても動く
& node scripts/download_release.mjs public/data prefectures.json
if ($LASTEXITCODE -notin 0, 3) { Write-Host "都道府県のデータ(prefectures.json)を取れませんでした。今あるもの(なければ都道府県別の表示なし)で続けます。" }
# 都道府県道(都道府県ごとのファイルを1つにまとめたもの)。なくても国道・高速道路は動く
# 展開したあとは tar.gz を消すので、展開先 public/data/prefroads があれば取得済みとみなす
& node scripts/download_release.mjs public/data prefroads.tar.gz public/data/prefroads
if ($LASTEXITCODE -eq 3) {
    # 前回と同じ
} elseif ($LASTEXITCODE -eq 0) {
    if (Test-Path public/data/prefroads) { Remove-Item -Recurse -Force public/data/prefroads }
    Run tar @("-xzf", "public/data/prefroads.tar.gz", "-C", "public/data")
    Remove-Item public/data/prefroads.tar.gz
} else {
    Write-Host "都道府県道のデータ(prefroads.tar.gz)を取れませんでした。今あるもの(なければ都道府県道なし)で続けます。"
}
Run npm @("run", "build")

if ($NoRestart) {
    Write-Host "更新しました(サーバーは再起動していません)。"
} elseif (Get-ScheduledTask -TaskName "KokudoMap" -ErrorAction SilentlyContinue) {
    & (Join-Path $PSScriptRoot "restart-server.ps1") 8080
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "更新しました。npm run serve で起動してください。"
}
