#!/usr/bin/env bash
# 日本全体の OSM ファイルを取ってくる。Geofabrik が遅いことがあるので、遅ければほかのミラーを試す。
# ミラーはデータの更新が止まっていることがあるので、MAX_AGE_DAYS 日より古いものは使わない
set -u
out="$1"
MAX_AGE_DAYS=${MAX_AGE_DAYS:-21}
# openstreetmap.fr のファイルでは東京都の境界が作れないことがある(add_prefectures.py が前回の形で補う)
urls=(
  https://download.geofabrik.de/asia/japan-latest.osm.pbf
  https://download.openstreetmap.fr/extracts/asia/japan-latest.osm.pbf
)

fresh() {
  # ファイルの中に書かれたデータの時刻(osmosis_replication_timestamp など)を見る
  local ts
  ts=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$out" 2>/dev/null)
  [ -n "$ts" ] || ts=$(osmium fileinfo -g header.option.timestamp "$out" 2>/dev/null)
  echo "データの時刻: ${ts:-不明}"
  [ -n "$ts" ] || return 0
  local age=$(( ( $(date +%s) - $(date -d "$ts" +%s) ) / 86400 ))
  if [ "$age" -gt "$MAX_AGE_DAYS" ]; then
    echo "${age} 日前のデータで古いので使いません"
    return 1
  fi
}

for url in "${urls[@]}"; do
  echo "取得: $url"; date
  # 1分間の平均が 3MB/s を下回ったら打ち切って次へ(2.7GB を 15 分ほどで取れる速さ)
  if curl -fL --retry 2 --speed-limit 3000000 --speed-time 60 -sS -o "$out" "$url"; then
    ls -lh "$out"; date
    fresh && exit 0
  fi
  echo "遅いか失敗したか古いので次を試します"
done
# どれもだめなら、Geofabrik から遅くても最後まで取る
echo "取得: ${urls[0]}(時間がかかっても最後まで)"
curl -fL --retry 3 -sS -o "$out" "${urls[0]}" && fresh
