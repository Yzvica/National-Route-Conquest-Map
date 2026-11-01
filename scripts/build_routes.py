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
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# 混んでいて 502/504 を返すことがあるので、順に試す
# (2026-11 時点で kumi.systems・private.coffee は応答せず、osm.ch はスイスのデータしかない。
#  openstreetmap.fr はデータの更新が 2026-08 で止まっているので、overpass-api.de が失敗したときの予備にする。
#  maps.mail.ru は失敗が多く、運営元の懸念もあるので使わない)
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
# 国道の番号は 1〜58 と 101〜507。一度に全部頼むと断られやすいので分けて取る
ALL_REFS = [str(n) for n in [*range(1, 59), *range(101, 508)]]
REFS_PER_QUERY = 25
SEGMENT_LENGTH = 200.0  # m。判定と表示の最小単位
SIMPLIFY_METERS = 3.0  # 区間の形をこの誤差まで間引いてファイルを小さくする
DOTTED_HIGHWAYS = {"path", "track", "footway", "steps", "bridleway", "cycleway", "pedestrian"}
# 車道に沿って別の線で描かれた歩道・自転車道・人道トンネル(関門トンネルなど)は、国道のリレーションに
# 入っていても点線国道ではないので除く。これらの種類で、区間のほとんどが同じ国道の車道のすぐ脇にあるもの
# 工事中・計画中・廃止された道は、国道のリレーションに入っていても走れないので数えない
NOT_ROADS = {"construction", "proposed", "planned", "abandoned", "disused", "razed"}
SIDEWALK_HIGHWAYS = {"footway", "cycleway", "pedestrian", "path", "steps"}
SIDEWALK_DIST = 25.0  # m。車道からこれ以内なら脇を通っているとみなす
SIDEWALK_SHARE = 0.8  # 区間の点のうちこの割合以上が車道の脇なら歩道とみなす
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "routes.json"


def overpass_query(refs: list[str]) -> str:
    ref_filter = f'["ref"~"^({"|".join(refs)})$"]' if refs else ""
    return f"""
[out:json][timeout:900];
rel["type"="route"]["route"~"^(road|ferry)$"]["network"="JP:national"]{ref_filter}->.r;
.r out body;
way(r.r);
out tags geom;
"""


def fetch(endpoints: list[str], query: str, attempts: int = 6) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    for i in range(attempts):
        endpoint = endpoints[i % len(endpoints)]
        req = urllib.request.Request(endpoint, data=body, headers={"User-Agent": "national-route-conquest-map"})
        try:
            with urllib.request.urlopen(req, timeout=1000) as res:
                return json.load(res)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if i == attempts - 1:
                raise
            wait = 15 * (i + 1)
            print(f"  {endpoint} で失敗({e})。{wait}秒後に再試行します", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def fetch_all(endpoints: list[str], refs: list[str]) -> dict:
    """番号を分けて取得し、1つの Overpass 結果にまとめる(重複する要素は1つにする)"""
    elements: dict[tuple[str, int], dict] = {}
    chunks = [refs[i : i + REFS_PER_QUERY] for i in range(0, len(refs), REFS_PER_QUERY)]
    for n, chunk in enumerate(chunks, 1):
        print(f"取得中 {n}/{len(chunks)}: 国道{chunk[0]}〜{chunk[-1]}号", file=sys.stderr)
        for el in fetch(endpoints, overpass_query(chunk))["elements"]:
            elements[(el["type"], el["id"])] = el
    return {"elements": list(elements.values())}


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


def parse_refs(ref: str) -> list[str]:
    """"1;8" のような併記は分け、"E9" のような高速道路の路線記号は除く"""
    parts = (p.strip().replace("号", "") for p in ref.split(";"))
    return [p for p in parts if p.isdigit()]


def build(osm: dict) -> dict:
    routes: dict[str, dict] = {}
    way_routes: dict[int, set[str]] = {}
    # 「国道317号旧道」のような旧道だけのリレーションにしか入っていない way は、今の国道ではなく旧道として数える
    current_ways: set[int] = set()
    for el in osm["elements"]:
        if el["type"] != "relation":
            continue
        tags = el.get("tags", {})
        refs = parse_refs(tags.get("ref", ""))
        old = is_old_relation(tags)
        for ref in refs:
            if not old:
                routes.setdefault(ref, {"name": f"国道{ref}号"})
        for m in el.get("members", []):
            if m["type"] == "way" and refs:
                way_routes.setdefault(m["ref"], set()).update(refs)
                if not old:
                    current_ways.add(m["ref"])

    segments = []
    tunnels = []
    old_segments: list[dict] = []
    skipped_km = 0.0
    for el in osm["elements"]:
        if el["type"] != "way" or el["id"] not in way_routes or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        coords = [(g["lon"], g["lat"]) for g in el["geometry"]]
        if len(coords) < 2:
            continue
        cats = []
        if el["id"] not in current_ways:
            # 旧道のリレーションだけに入っている道。車で走れない道は数えない
            if tags.get("highway") in NOT_ROADS or tags.get("highway") in DOTTED_HIGHWAYS or "highway" not in tags:
                continue
            refs = sorted((r for r in way_routes[el["id"]] if r in routes), key=int)
            if refs:
                old_segments.extend(old_road_segments(el, coords, refs))
            continue
        if tags.get("route") == "ferry":
            cats.append("ferry")
        elif "highway" not in tags or tags["highway"] in NOT_ROADS:
            # highway のない線(廃道や、災害で通れなくなり highway を外した道など)は道路ではないので除く
            skipped_km += sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords))) / 1000
            continue
        elif tags.get("highway") in DOTTED_HIGHWAYS:
            cats.append("dotted")
        elif "バイパス" in tags.get("name", "") or "バイパス" in tags.get("official_name", ""):
            cats.append("bypass")
        else:
            cats.append("main")
        refs = sorted((r for r in way_routes[el["id"]] if r in routes), key=int)
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
            if "dotted" in cats:
                # 点線国道は種類を残して、あとで確認できるようにする
                seg["hw"] = tags.get("highway", "none")
            segments.append(seg)

    if skipped_km:
        print(f"道路でない線(highway なし・工事中・廃道など)を除きました: {skipped_km:.1f} km", file=sys.stderr)
    segments, dropped = drop_sidewalks(segments)
    if dropped:
        print(f"車道沿いの歩道などを点線国道から除きました: {len(dropped)} 区間 / {sum(s['len'] for s in dropped) / 1000:.1f} km", file=sys.stderr)
    if old_segments:
        print(f"旧道のリレーションの道: {sum(s['len'] for s in old_segments) / 1000:.1f} km", file=sys.stderr)
    segments += old_segments
    used_tunnels = {s["tunnel"] for s in segments if "tunnel" in s}
    tunnels = [t for t in tunnels if t["id"] in used_tunnels]

    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "routes": dict(sorted(routes.items(), key=lambda kv: int(kv[0]))),
        "segments": segments,
        "tunnels": tunnels,
    }


def is_old_relation(tags: dict) -> bool:
    """「国道317号旧道」「○○バイパス旧道区間」のような、旧道だけをまとめたリレーションか"""
    # 「復旧道路」は旧道ではない
    return re.search(r"(?<!復)旧道", tags.get("name", "")) is not None


def old_road_segments(el: dict, coords: list[tuple[float, float]], refs: list[str]) -> list[dict]:
    """旧道の way を区間に切る(種別 old)。build_old_roads.py と同じ形"""
    name = el.get("tags", {}).get("name", "")
    out = []
    for i, piece in enumerate(split_line(coords, SEGMENT_LENGTH)):
        seg = {
            "id": f"w{el['id']}-{i}",
            "routes": refs,
            "cats": ["old"],
            "len": round(sum(dist(piece[j - 1], piece[j]) for j in range(1, len(piece))), 1),
            "coords": [rnd(p) for p in simplify(piece, SIMPLIFY_METERS)],
            # 旧道のリレーションから作ったもの。build_old_roads.py で作り直すときに消さない
            "src": "rel",
        }
        if name:
            seg["name"] = name
        out.append(seg)
    return out


def _point_seg_dist(p, a, b) -> float:
    kx = 111_320 * math.cos(math.radians(p[1]))
    ky = 110_540
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length))
    return math.hypot(ax + t * dx, ay + t * dy)


def drop_sidewalks(segments: list[dict]) -> tuple[list[dict], list[dict]]:
    """点線国道のうち、同じ国道の車道のすぐ脇を通る歩道などを除く。(残す区間, 除いた区間) を返す"""
    cell = 0.002  # 度(約200m)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, s in enumerate(segments):
        if "dotted" in s["cats"] or "ferry" in s["cats"]:
            continue
        for p in s["coords"]:
            grid.setdefault((int(p[0] / cell), int(p[1] / cell)), []).append(i)

    def near_road(p, routes: set[str]) -> bool:
        gx, gy = int(p[0] / cell), int(p[1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in grid.get((gx + dx, gy + dy), []):
                    road = segments[i]
                    if not routes.intersection(road["routes"]):
                        continue
                    c = road["coords"]
                    if any(_point_seg_dist(p, c[j - 1], c[j]) <= SIDEWALK_DIST for j in range(1, len(c))):
                        return True
        return False

    keep, dropped = [], []
    for s in segments:
        if "dotted" not in s["cats"] or s.get("hw") not in SIDEWALK_HIGHWAYS:
            keep.append(s)
            continue
        c = s["coords"]
        # 頂点と各辺の中点で見る
        pts = list(c) + [((c[j - 1][0] + c[j][0]) / 2, (c[j - 1][1] + c[j][1]) / 2) for j in range(1, len(c))]
        routes = set(s["routes"])
        near = sum(1 for p in pts if near_road(p, routes))
        (dropped if near >= len(pts) * SIDEWALK_SHARE else keep).append(s)
    return keep, dropped


def rnd(p: tuple[float, float]) -> list[float]:
    # 小数5桁 ≒ 1m。ファイルサイズを抑えるため
    return [round(p[0], 5), round(p[1], 5)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", action="append", default=[], help="対象の国道番号(複数指定可)")
    ap.add_argument("--input", type=Path, help="取得済みの Overpass JSON")
    ap.add_argument("--save-raw", type=Path, help="取得した Overpass JSON の保存先")
    ap.add_argument("--endpoint", action="append", help="Overpass API の URL(複数指定可。省略時は公開サーバーを順に使う)")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    if args.input:
        osm = json.loads(args.input.read_text())
    else:
        osm = fetch_all(args.endpoint or ENDPOINTS, args.ref or ALL_REFS)
        if args.save_raw:
            args.save_raw.write_text(json.dumps(osm))

    data = build(osm)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    km = sum(s["len"] for s in data["segments"]) / 1000
    print(f"{len(data['routes'])} 路線 / {len(data['segments'])} 区間 / {km:,.0f} km → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
