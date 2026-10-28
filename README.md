# National-Route-Conquest-Map(国道制覇マップ)

自分の走行ログを読み込んで、日本の国道をどれだけ走ったか(制覇率)を地図で確認するウェブアプリです。

- 走行ログ(gbowl の CSV / GPX)は「走行ログを読み込む」で選ぶか、画面にドラッグ＆ドロップして読み込みます(複数可)
- ログの判定はブラウザの中で行い、MiniPC には判定結果(区間ごとの割合と、初めて/最後に通った日)だけを保存します
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

## MiniPC(Windows 11)で動かして LAN から使う

MiniPC でサーバーを動かし、LAN 内の PC やスマホのブラウザから開きます。
走行記録は MiniPC の `data\record.json` に保存されるので、どの端末から見ても同じ記録になります。

必要なもの: [Node.js](https://nodejs.org/) 22 以上、[Git](https://git-scm.com/)、[GitHub CLI](https://cli.github.com/)

```powershell
git clone https://github.com/Yzvica/National-Route-Conquest-Map.git
cd National-Route-Conquest-Map
gh auth login                                                    # 初回だけ
powershell -ExecutionPolicy Bypass -File scripts\update.ps1      # 国道データの取得とビルド
npm run serve                                                    # http://<MiniPCのIPアドレス>:8080 で開ける
```

起動時に自動で立ち上げるには、管理者の PowerShell で次を実行します(タスクスケジューラへの登録と、ファイアウォールで 8080 番ポートを家庭内ネットワークに開放します)。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

- 新しいコードや国道データを取り込むときは、フォルダ直下の `update.bat` をダブルクリックします(`scripts\update.ps1` を管理者で実行し、自動起動していればサーバーも再起動します)
- `data\record.json` をコピーしておけばバックアップになります。画面の「記録を書き出す」でも保存できます
- `npm run dev` で開いたときなど、サーバーがない場合はブラウザの中に保存します

地図の背景には[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)、道路データには © OpenStreetMap contributors を使っています。
