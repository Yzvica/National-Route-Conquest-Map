#!/usr/bin/env bash
# MiniPC 上で最新のコードと国道データを取り込み、アプリを作り直す。
# 国道データ(リリース route-data)の取得に GitHub CLI(gh)のログインが必要です。
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
gh release download route-data -p routes.json -D public/data --clobber
npm run build
echo "更新しました。起動中なら再起動してください(例: sudo systemctl restart kokudo)"
