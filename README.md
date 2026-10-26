# National-Route-Conquest-Map(国道制覇マップ)

自分の走行ログを読み込んで、日本の国道をどれだけ走ったか(制覇率)を地図で確認するウェブアプリです。

- 走行ログ(gbowl の CSV / GPX)はブラウザの中だけで処理・保存し、サーバーには送りません
- 国道ごと、種別ごと(現道 / バイパス / 点線国道 / 海上区間 / 重複区間)、総合の制覇率を距離ベースで出します
- 総合制覇率では重複区間を1回だけ数え、国道ごとの制覇率ではそれぞれの国道に数えます

## 使い方(手元で動かす)

```sh
npm install
python3 scripts/build_routes.py --ref 1 --ref 20   # 国道データを作る(全国なら --ref なし。数分かかります)
npm run dev
```

## 判定のしくみ

| 項目 | 内容 |
| --- | --- |
| 判定の単位 | OSM の道路を約200mごとに区切った「区間」 |
| 通過判定 | 区間を20mおきに見て、ログから30m以内を通っていれば通過。8割以上通れば100%、それ未満は割合で記録 |
| ログの途切れ | 点と点が2km以内で、速度が時速200km以下なら、間を直線で補間 |
| トンネル | 中の GPS は見ず、両方の坑口の80m以内を短い時間差で通っていれば、トンネル全体を制覇扱い |

数値は `src/matcher.ts` の `DEFAULT_OPTIONS` で変えられます。

## 国道データ

OpenStreetMap の `network=JP:national` の路線リレーションから作ります。
データは大きいのでリポジトリには入れず、Actions の「国道データを更新」でリリース `route-data` に置き、公開時に取り込みます。
Actions では [Geofabrik](https://download.geofabrik.de/asia/japan.html) の日本全体のファイルから抽出します(`scripts/extract_pbf.py`)。
Overpass API から直接取ることもできますが、混雑で断られることがあります。

種別の判定方法:

- 海上区間: `route=ferry`
- 点線国道: `highway=path / track / footway / steps` など、車道でない区間
- バイパス: 名前に「バイパス」を含む区間
- 重複区間: 複数の国道リレーションに含まれる区間
- 旧道: OSM では国道リレーションから外れていることが多く、未対応

## 公開(GitHub Pages)

main に push すると `.github/workflows/deploy.yml` で GitHub Pages に公開されます。
初回は Settings → Pages の Source を「GitHub Actions」にしてください。
無料プランの場合、GitHub Pages はリポジトリが公開(public)のときだけ使えます。

地図の背景には[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)、道路データには © OpenStreetMap contributors を使っています。
