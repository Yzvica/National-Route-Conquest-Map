#!/usr/bin/env python3
"""国道・高速道路のデータの各区間に、どの都道府県にあるか(pref: 1〜47)を付ける。
あわせて、地図の色分けに使う都道府県の形(prefectures.json)を作る。

都道府県の境界は OSM の行政界(admin_level=4)を使う。
  osmium tags-filter japan-latest.osm.pbf r/admin_level=4 -o pref.osm.pbf
  python3 scripts/add_prefectures.py pref.osm.pbf routes.json expressways.json --out prefectures.json

区間の中ほどの点で判定し、どの都道府県にも入らない区間(海上区間など)は一番近い都道府県にする。
pyosmium と shapely が必要です(pip install osmium shapely)。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import osmium
import shapely
import shapely.geometry
from shapely.geometry import mapping

# JIS X 0401 の都道府県コード順
PREFS = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
    "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]
# 地図の色分け用の形は、この誤差(度。約0.005度 ≒ 500m)まで間引いて軽くする
SIMPLIFY_DEG = 0.005


def pref_code(tags: osmium.osm.TagList) -> int | None:
    iso = tags.get("ISO3166-2", "")
    if iso.startswith("JP-") and iso[3:].isdigit():
        code = int(iso[3:])
        if 1 <= code <= 47:
            return code
    name = tags.get("name", "")
    return PREFS.index(name) + 1 if name in PREFS else None


class AreaHandler(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.wkb = osmium.geom.WKBFactory()
        self.shapes: dict[int, list] = {}

    def area(self, a: osmium.osm.Area) -> None:
        tags = a.tags
        if tags.get("boundary") != "administrative" or tags.get("admin_level") != "4":
            return
        code = pref_code(tags)
        if code is None:
            return
        try:
            geom = shapely.from_wkb(self.wkb.create_multipolygon(a))
        except (RuntimeError, shapely.errors.GEOSException) as e:  # 境界が閉じていないなど
            print(f"  {PREFS[code - 1]} の形を作れませんでした: {e}", file=sys.stderr)
            return
        self.shapes.setdefault(code, []).append(geom)


def load_prefectures(src: str, fallback: Path | None = None) -> dict[int, shapely.Geometry]:
    h = AreaHandler()
    h.apply_file(src, locations=True, idx="flex_mem")
    shapes = {code: shapely.union_all(gs) for code, gs in h.shapes.items()}
    missing = [i + 1 for i in range(47) if i + 1 not in shapes]
    if missing and fallback and fallback.exists():
        # OSM の行政界が一時的に壊れていることがある(2026-11-01 に東京都の境界が作れなかった)。
        # そのときは前回作った形(約500mまで間引いたもの)で代わりにする
        prev = json.loads(fallback.read_text())
        for f in prev.get("features", []):
            code = f["properties"]["code"]
            if code in missing:
                shapes[code] = shapely.geometry.shape(f["geometry"])
                print(f"  {PREFS[code - 1]} は前回の形を使います", file=sys.stderr)
        missing = [c for c in missing if c not in shapes]
    if missing:
        # そのまま置くと地図の色分けや都道府県の判定が欠けるので止める
        names = " ".join(PREFS[c - 1] for c in missing)
        sys.exit(f"境界が見つからなかった都道府県があります: {names}。OSM ファイルを取り直してください")
    return shapes


def midpoint(coords: list[list[float]]) -> tuple[float, float]:
    if len(coords) % 2 == 1:
        return tuple(coords[len(coords) // 2])
    a, b = coords[len(coords) // 2 - 1], coords[len(coords) // 2]
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def assign(shapes: dict[int, shapely.Geometry], data: dict) -> dict[int, int]:
    """data の各区間に pref を付け、都道府県ごとの区間数を返す"""
    codes = list(shapes)
    tree = shapely.STRtree([shapes[c] for c in codes])
    segs = data["segments"]
    points = shapely.points([midpoint(s["coords"]) for s in segs])
    found = [-1] * len(segs)
    src, dst = tree.query(points, predicate="within")
    for i, j in zip(src.tolist(), dst.tolist()):
        if found[i] < 0:
            found[i] = j
    rest = [i for i, f in enumerate(found) if f < 0]
    if rest:
        # どこにも入らない(海の上・境界のすき間)ものは一番近い都道府県にする
        src, dst = tree.query_nearest(points[rest], return_distance=False)
        for i, j in zip(src.tolist(), dst.tolist()):
            if found[rest[i]] < 0:
                found[rest[i]] = j
    counts: dict[int, int] = {}
    for s, f in zip(segs, found):
        code = codes[f]
        s["pref"] = code
        counts[code] = counts.get(code, 0) + 1
    print(f"  {len(segs)} 区間のうち {len(rest)} 区間は境界の外なので近い都道府県にしました", file=sys.stderr)
    return counts


def rnd(x):
    if isinstance(x, (list, tuple)):
        if x and isinstance(x[0], float):
            return [round(x[0], 4), round(x[1], 4)]
        return [rnd(v) for v in x]
    return x


def outline(shapes: dict[int, shapely.Geometry]) -> dict:
    features = []
    for code in sorted(shapes):
        g = shapely.simplify(shapes[code], SIMPLIFY_DEG, preserve_topology=True)
        geo = mapping(g)
        features.append({
            "type": "Feature",
            "properties": {"code": code, "name": PREFS[code - 1]},
            "geometry": {"type": geo["type"], "coordinates": rnd(json.loads(json.dumps(geo["coordinates"])))},
        })
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("boundaries", help="行政界(admin_level=4)を含む .osm.pbf / .osm")
    ap.add_argument("data", nargs="*", type=Path, help="pref を付ける routes.json / expressways.json(上書きします)")
    ap.add_argument("--out", type=Path, help="都道府県の形(prefectures.json)の出力先")
    ap.add_argument("--fallback", type=Path, help="境界が作れなかった都道府県に使う、前回の prefectures.json")
    args = ap.parse_args()

    shapes = load_prefectures(args.boundaries, args.fallback)
    if not shapes:
        sys.exit("都道府県の境界が1つも見つかりませんでした")
    for path in args.data:
        print(f"{path} に都道府県を付けています", file=sys.stderr)
        data = json.loads(path.read_text())
        assign(shapes, data)
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    if args.out:
        args.out.write_text(json.dumps(outline(shapes), ensure_ascii=False, separators=(",", ":")))
        print(f"都道府県の形 {len(shapes)} 件 → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
