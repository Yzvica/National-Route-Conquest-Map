#!/usr/bin/env python3
"""OpenStreetMap から日本の国道を取り出し、アプリ用の public/data/routes.json を作る。

使い方:
  python3 scripts/build_routes.py                # 全国道(Overpass API から取得。数分かかります)
  python3 scripts/build_routes.py --ref 1 --ref 20   # 一部の国道だけ(動作確認用)
  python3 scripts/build_routes.py --input cache.json # 取得済みの Overpass 結果から作る

標準ライブラリだけで動きます。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"
SEGMENT_LENGTH = 200.0  # m。判定と表示の最小単位
SIMPLIFY_METERS = 3.0  # 区間の形をこの誤差まで間引いてファイルを小さくする
DOTTED_HIGHWAYS = {"path", "track", "footway", "steps", "bridleway", "cycleway", "pedestrian"}
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "routes.json"


def overpass_query(refs: list[str]) -> str:
    ref_filter = f'["ref"~"^({"|".join(refs)})$"]' if refs else ""
    return f"""
[out:json][timeout:1800][maxsize:2147483648];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
rel["type"="route"]["route"~"^(road|ferry)$"]["network"="JP:national"]{ref_filter}(area.jp)->.r;
.r out body;
way(r.r);
out tags geom;
"""


def fetch(endpoint: str, query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(endpoint, data=body, headers={"User-Agent": "national-route-conquest-map"})
    with urllib.request.urlopen(req, timeout=2000) as res:
        return json.load(res)


def dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371008.8
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def split_line(coords: list[tuple[float, float]], target: float) -> list[list[tuple[float, float]]]:
    """線を target m 前後の長さに等分する(端数の短い区間を作らない)"""
    total = sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords)))
    n = max(1, round(total / target))
    step = total / n
    pieces: list[list[tuple[float, float]]] = []
    cur = [coords[0]]
    acc = 0.0
    for i in range(1, len(coords)):
        a, b = coords[i - 1], coords[i]
        d = dist(a, b)
        pos = 0.0
        while len(pieces) < n - 1 and acc + (d - pos) >= step:
            f = (pos + step - acc) / d
            p = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            cur.append(p)
            pieces.append(cur)
            cur = [p]
            pos += step - acc
            acc = 0.0
        acc += d - pos
        cur.append(b)
    pieces.append(cur)
    return pieces


def simplify(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas-Peucker 法で、形がほぼ変わらない範囲で点を間引く(eps はメートル)"""
    if len(pts) < 3:
        return pts
    kx = 111_320 * math.cos(math.radians(pts[0][1]))
    ky = 110_540
    xy = [(p[0] * kx, p[1] * ky) for p in pts]

    def perp(i: int, a: int, b: int) -> float:
        (x1, y1), (x2, y2), (x, y) = xy[a], xy[b], xy[i]
        dx, dy = x2 - x1, y2 - y1
        if dx == dy == 0:
            return math.hypot(x - x1, y - y1)
        return abs(dy * x - dx * y + x2 * y1 - y2 * x1) / math.hypot(dx, dy)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            d = perp(i, a, b)
            if d > best:
                best, idx = d, i
        if best > eps:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def normalize_ref(ref: str) -> str:
    return ref.strip().replace("号", "")


def build(osm: dict) -> dict:
    routes: dict[str, dict] = {}
    way_routes: dict[int, set[str]] = {}
    for el in osm["elements"]:
        if el["type"] != "relation":
            continue
        ref = normalize_ref(el.get("tags", {}).get("ref", ""))
        if not ref:
            continue
        routes.setdefault(ref, {"name": f"国道{ref}号"})
        for m in el.get("members", []):
            if m["type"] == "way":
                way_routes.setdefault(m["ref"], set()).add(ref)

    segments = []
    tunnels = []
    for el in osm["elements"]:
        if el["type"] != "way" or el["id"] not in way_routes or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        coords = [(g["lon"], g["lat"]) for g in el["geometry"]]
        if len(coords) < 2:
            continue
        cats = []
        if tags.get("route") == "ferry":
            cats.append("ferry")
        elif tags.get("highway") in DOTTED_HIGHWAYS or "highway" not in tags:
            cats.append("dotted")
        elif "バイパス" in tags.get("name", "") or "バイパス" in tags.get("official_name", ""):
            cats.append("bypass")
        else:
            cats.append("main")
        refs = sorted(way_routes[el["id"]], key=lambda r: (len(r), r))
        if len(refs) > 1:
            cats.append("overlap")

        tunnel_id = None
        if tags.get("tunnel") not in (None, "no"):
            tunnel_id = f"t{el['id']}"
            length = sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords)))
            tunnels.append({"id": tunnel_id, "a": rnd(coords[0]), "b": rnd(coords[-1]), "len": round(length)})

        for i, piece in enumerate(split_line(coords, SEGMENT_LENGTH)):
            seg = {
                "id": f"w{el['id']}-{i}",
                "routes": refs,
                "cats": cats,
                "len": round(sum(dist(piece[j - 1], piece[j]) for j in range(1, len(piece))), 1),
                "coords": [rnd(p) for p in simplify(piece, SIMPLIFY_METERS)],
            }
            if tunnel_id:
                seg["tunnel"] = tunnel_id
            segments.append(seg)

    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "routes": dict(sorted(routes.items(), key=lambda kv: (len(kv[0]), kv[0]))),
        "segments": segments,
        "tunnels": tunnels,
    }


def rnd(p: tuple[float, float]) -> list[float]:
    # 小数5桁 ≒ 1m。ファイルサイズを抑えるため
    return [round(p[0], 5), round(p[1], 5)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", action="append", default=[], help="対象の国道番号(複数指定可)")
    ap.add_argument("--input", type=Path, help="取得済みの Overpass JSON")
    ap.add_argument("--save-raw", type=Path, help="取得した Overpass JSON の保存先")
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    if args.input:
        osm = json.loads(args.input.read_text())
    else:
        print("Overpass API から取得中…", file=sys.stderr)
        osm = fetch(args.endpoint, overpass_query(args.ref))
        if args.save_raw:
            args.save_raw.write_text(json.dumps(osm))

    data = build(osm)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    km = sum(s["len"] for s in data["segments"]) / 1000
    print(f"{len(data['routes'])} 路線 / {len(data['segments'])} 区間 / {km:,.0f} km → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
