#!/usr/bin/env python3
"""国道・高速道路のデータの各区間に、どの都道府県にあるか(pref: 1〜47)を付ける。
あわせて、地図の色分けに使う都道府県の形(prefectures.json)を作る。

都道府県の境界は OSM の行政界(admin_level=4)を使う。
  osmium tags-filter japan-latest.osm.pbf r/admin_level=4 -o pref.osm.pbf
  python3 scripts/add_prefectures.py pref.osm.pbf routes.json expressways.json --out prefectures.json

区間ごとに、どの都道府県にあるかを付ける。都道府県の境をまたぐ区間は、それぞれの都道府県にある割合(prefs)も付け、
県別の距離はその割合で分けて数える。どの都道府県にも入らない区間(海上区間など)は一番近い都道府県にする。
pyosmium と shapely(numpy も入ります)が必要です(pip install osmium shapely)。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy
import osmium
import shapely
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
# 都道府県の境をまたぐ区間は、この間隔(m)の点で、どの都道府県にどれだけあるかを調べる
SPLIT_STEP = 5.0
# 区間のうちこの割合より少ししか入っていない都道府県は数えない(境界のわずかなずれ)
MIN_SHARE = 0.03


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


def load_prefectures(src: str) -> dict[int, shapely.Geometry]:
    h = AreaHandler()
    h.apply_file(src, locations=True, idx="flex_mem")
    shapes = {code: shapely.union_all(gs) for code, gs in h.shapes.items()}
    missing = [PREFS[i] for i in range(47) if i + 1 not in shapes]
    if missing:
        # 抽出ファイルが壊れている・古いときに起きる(ミラーのファイルで東京都が欠けたことがある)。
        # そのまま置くと地図の色分けが欠けるので止める
        sys.exit(f"境界が見つからなかった都道府県があります: {' '.join(missing)}。OSM ファイルを取り直してください")
    return shapes


def midpoint(coords: list[list[float]]) -> tuple[float, float]:
    if len(coords) % 2 == 1:
        return tuple(coords[len(coords) // 2])
    a, b = coords[len(coords) // 2 - 1], coords[len(coords) // 2]
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def locate(tree: shapely.STRtree, points) -> list[int]:
    """各点が入っている都道府県(tree の番号)。どこにも入らなければ -1"""
    found = [-1] * len(points)
    src, dst = tree.query(points, predicate="within")
    for i, j in zip(src.tolist(), dst.tolist()):
        if found[i] < 0:
            found[i] = j
    return found


def assign(shapes: dict[int, shapely.Geometry], data: dict) -> dict[int, int]:
    """data の各区間に pref を付け、都道府県ごとの区間数を返す。

    区間(約200m)の両端と中ほどが同じ都道府県なら、その都道府県にする。
    都道府県の境をまたぐ区間は SPLIT_STEP m おきの点で調べ、それぞれの都道府県にある割合を
    prefs([[コード, 割合], ...])に入れる。県別の距離はこの割合で分ける。pref は割合が一番大きい都道府県。
    どこにも入らない区間(海の上・境界のすき間)は、中ほどの点に一番近い都道府県にする。
    """
    codes = list(shapes)
    tree = shapely.STRtree([shapes[c] for c in codes])
    segs = data["segments"]
    mids = shapely.points([midpoint(s["coords"]) for s in segs])
    ends = locate(tree, shapely.points([p for s in segs for p in (s["coords"][0], s["coords"][-1])]))
    mid_found = locate(tree, mids)

    shares: list[dict[int, float] | None] = [None] * len(segs)
    border = []
    for i in range(len(segs)):
        a, b, m = ends[2 * i], ends[2 * i + 1], mid_found[i]
        if a == b == m and m >= 0:
            shares[i] = {m: 1.0}
        else:
            border.append(i)

    # 境をまたぐ区間は細かく点を取って、それぞれの都道府県にある割合を出す
    if border:
        lines = numpy.array([shapely.LineString(segs[i]["coords"]) for i in border], dtype=object)
        counts = [max(2, math.ceil(segs[i]["len"] / SPLIT_STEP)) for i in border]
        owner = [k for k, n in enumerate(counts) for _ in range(n)]
        fracs = [(j + 0.5) / n for n in counts for j in range(n)]
        pts = shapely.line_interpolate_point(lines[owner], fracs, normalized=True)
        found = locate(tree, pts)
        hits: list[dict[int, int]] = [{} for _ in border]
        for k, f in zip(owner, found):
            if f >= 0:
                hits[k][f] = hits[k].get(f, 0) + 1
        for k, i in enumerate(border):
            n = sum(hits[k].values())
            if n:
                shares[i] = {f: c / n for f, c in hits[k].items()}

    rest = [i for i, sh in enumerate(shares) if sh is None]
    if rest:
        # どこにも入らない(海の上・境界のすき間)ものは一番近い都道府県にする
        src, dst = tree.query_nearest(mids[rest], return_distance=False)
        for k, j in zip(src.tolist(), dst.tolist()):
            if shares[rest[k]] is None:
                shares[rest[k]] = {j: 1.0}

    counts_by_pref: dict[int, int] = {}
    split = 0
    for s, sh in zip(segs, shares):
        parts = split_shares({codes[f]: v for f, v in sh.items()})
        s["pref"] = parts[0][0]
        if len(parts) > 1:
            s["prefs"] = [[c, v] for c, v in parts]
            split += 1
        else:
            s.pop("prefs", None)
        counts_by_pref[s["pref"]] = counts_by_pref.get(s["pref"], 0) + 1
    print(
        f"  {len(segs)} 区間のうち、{split} 区間は都道府県の境で分け、{len(rest)} 区間は境界の外なので近い都道府県にしました",
        file=sys.stderr,
    )
    return counts_by_pref


def split_shares(shares: dict[int, float]) -> list[tuple[int, float]]:
    """割合を大きい順に並べ、MIN_SHARE 未満のものは除いて、合計が1になるよう小数2桁に丸める"""
    items = sorted(shares.items(), key=lambda kv: -kv[1])
    items = [kv for kv in items if kv[1] >= MIN_SHARE] or items[:1]
    total = sum(v for _, v in items)
    out = [(c, round(v / total, 2)) for c, v in items]
    out = [(c, v) for c, v in out if v > 0]
    if len(out) > 1:
        # 丸めの誤差は一番大きいものに寄せる
        out[0] = (out[0][0], round(1 - sum(v for _, v in out[1:]), 2))
    return out if len(out) > 1 else [(out[0][0], 1.0)]


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
    args = ap.parse_args()

    shapes = load_prefectures(args.boundaries)
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
