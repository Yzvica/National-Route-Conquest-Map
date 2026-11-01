#!/usr/bin/env bash
# 日本全体の OSM ファイルを取ってくる。Geofabrik が遅いことがあるので、遅ければほかのミラーを試す
set -u
out="$1"
urls=(
  https://download.geofabrik.de/asia/japan-latest.osm.pbf
  https://download.openstreetmap.fr/extracts/asia/japan-latest.osm.pbf
  https://ftp.fau.de/osm-planet/extracts/geofabrik/asia/japan-latest.osm.pbf
)
for url in "${urls[@]}"; do
  echo "取得: $url"; date
  # 1分間の平均が 3MB/s を下回ったら打ち切って次へ(2.3GB を 15 分以内に取れる速さ)
  if curl -fL --retry 2 --speed-limit 3000000 --speed-time 60 -sS -o "$out" "$url"; then
    ls -lh "$out"; date
    exit 0
  fi
  echo "遅いか失敗したので次を試します"
done
# どれも速くなければ、Geofabrik から遅くても最後まで取る
curl -fL --retry 3 -sS -o "$out" "${urls[0]}"
