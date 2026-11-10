#!/usr/bin/env python3
"""OSM の抽出ファイルから鉄道の線路と駅を取り出し、地図サーバーが電車の記録の途切れを
線路に沿って補うための railways.json.gz を作る(地図には出さない。サーバーの補間だけで使う)。

  osmium tags-filter japan-latest.osm.pbf w/railway=rail,subway,light_rail,monorail,narrow_gauge n/railway=station,halt -o rail.osm.pbf
  python3 scripts/build_railways.py rail.osm.pbf --out railways.json.gz

- 線路は OSM の way ごとに1つの線にする。車両基地・側線・引き込み線(service=yard/siding/spur)は除く
- 複数の way がつながる点(分岐・終点の接続)は、間引いても残す(残さないと線路がつながらなくなる)
- 駅(railway=station/halt)の位置と名前も入れる。サーバーは駅の近くで別の路線への乗り換えをつなぐ
- 座標は小数5桁(約1m)。サーバーの補間は同じ座標を同じ点とみなしてつなぐ

pyosmium が必要です(pip install osmium)。
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_routes import dist, rnd, simplify  # noqa: E402

RAIL_KINDS = {"rail", "subway", "light_rail", "monorail", "narrow_gauge"}
SKIP_SERVICE = {"yard", "siding", "spur"}
# 線路の形を間引くときの許容ずれ(m)。補った点は線路の上に置くので、道路より細かめにする
SIMPLIFY_M = 3.0


class Handler(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.ways: list[tuple[list[int], list[tuple[float, float]], str, bool]] = []
        self.stations: list[tuple[float, float, str]] = []

    def node(self, n: osmium.osm.Node) -> None:
        if n.tags.get("railway") in ("station", "halt") and n.location.valid():
            name = n.tags.get("name", "")
            self.stations.append((n.location.lon, n.location.lat, name))

    def way(self, w: osmium.osm.Way) -> None:
        t = w.tags
        if t.get("railway") not in RAIL_KINDS or t.get("service") in SKIP_SERVICE:
            return
        ids: list[int] = []
        coords: list[tuple[float, float]] = []
        for n in w.nodes:
            if n.location.valid():
                ids.append(n.ref)
                coords.append((n.location.lon, n.location.lat))
        if len(coords) < 2:
            return
        tunnel = t.get("tunnel") in ("yes", "building_passage") or t.get("location") == "underground"
        self.ways.append((ids, coords, t.get("name", ""), tunnel))


def thin(ids: list[int], coords: list[tuple[float, float]], shared: set[int]) -> list[tuple[float, float]]:
    """分岐の点を残して間引く"""
    out: list[tuple[float, float]] = []
    start = 0
    for i in range(1, len(ids)):
        if i == len(ids) - 1 or ids[i] in shared:
            part = simplify(coords[start:i + 1], SIMPLIFY_M)
            out.extend(part if not out else part[1:])
            start = i
    return out


def build(h: Handler) -> dict:
    use = Counter()
    for ids, _, _, _ in h.ways:
        use.update(set(ids))
        # 端の点は、ほかの way とつながるかもしれないので常に残す
        use[ids[0]] += 1
        use[ids[-1]] += 1
    shared = {n for n, c in use.items() if c >= 2}
    lines: list[str] = []
    line_ix: dict[str, int] = {}
    segments = []
    total = 0.0
    for ids, coords, name, tunnel in h.ways:
        c = [tuple(rnd(p)) for p in thin(ids, coords, shared)]
        c = [p for i, p in enumerate(c) if i == 0 or p != c[i - 1]]
        if len(c) < 2:
            continue
        total += sum(dist(c[i - 1], c[i]) for i in range(1, len(c)))
        seg: dict = {"c": [list(p) for p in c]}
        if name:
            if name not in line_ix:
                line_ix[name] = len(lines)
                lines.append(name)
            seg["l"] = line_ix[name]
        if tunnel:
            seg["t"] = 1
        segments.append(seg)
    stations = [[*rnd((lon, lat)), name] for lon, lat, name in h.stations]
    print(f"{len(lines)} 路線 / {len(segments)} 本 / {total / 1000:,.0f} km / 駅 {len(stations)}", file=sys.stderr)
    return {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lines": lines,
        "segments": segments,
        "stations": stations,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="鉄道を絞り込んだ OSM の抽出ファイル(.osm.pbf)")
    ap.add_argument("--out", type=Path, default=Path("railways.json.gz"))
    args = ap.parse_args()
    h = Handler()
    h.apply_file(str(args.input), locations=True)
    data = build(h)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.out, "wb", compresslevel=9) as f:
        f.write(text)
    print(f"{len(text) / 1e6:.1f}MB(gzip {args.out.stat().st_size / 1e6:.1f}MB)→ {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
