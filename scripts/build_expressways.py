#!/usr/bin/env python3
"""OSM の抽出ファイルから高速道路・都市高速・自動車専用道路・有料道路を取り出し、
アプリ用の public/data/expressways.json を作る。

  osmium tags-filter japan-latest.osm.pbf w/highway=motorway,motorway_link,trunk_link w/motorroad=yes w/toll=yes -o hw.osm.pbf
  python3 scripts/build_expressways.py hw.osm.pbf --out public/data/expressways.json

- 路線は道路の名前ごとにまとめる(OSM の name)
- IC・JCT のランプ(motorway_link)は数えない
- 上下線が別の線で描かれているところは、反対向きの区間を組(pair)にする。
  アプリはどちらかを走れば両方走ったことにし、長さは半分ずつ数える
- IC のランプ(下の道から本線へ / 本線から下の道へ。進む向きの線)と、高速道路に出入りできる場所
  (ランプが本線につながる点・本線の端)も入れる。アプリは高架の高速道路と下の国道を見分ける手がかりにする。
  ランプも取り出すので、osmium では w/highway=motorway_link,trunk_link も絞り込みに入れること
- 路線に数えない高速道路の線(「〜インター線」などの名前の本線は `uncounted`、JCT のランプは `jct`)も入れる。
  アプリはこれも「近くに高速道路がある」とみなす(入れないと、そこを走っている間は下の道にされてしまう)

pyosmium が必要です(pip install osmium)。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_routes import SEGMENT_LENGTH, SIMPLIFY_METERS, dist, rnd, simplify, split_line  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "expressways.json"

# 都市高速を運営する会社・公社と、名前の頭
URBAN_OPERATORS = ("首都高速道路", "阪神高速道路", "名古屋高速道路公社", "福岡北九州高速道路公社", "広島高速道路公社")
URBAN_NAME = re.compile(r"^(首都高速|首都高|阪神高速|名古屋高速|名古屋都市高速|福岡高速|北九州高速|福岡都市高速|北九州都市高速|広島高速)")
# 高速自動車国道(と、それと一体で呼ばれる区間)の名前
EXPRESSWAY_NAME = re.compile(r"(自動車道|高速道路|高速自動車国道)")
# 有料道路として数える一般道の種類(駐車場の通路などは除く)
TOLL_HIGHWAYS = {"trunk", "primary", "secondary", "tertiary", "unclassified"}
# IC のランプとして見る道路の種類(trunk_link は自動車専用道路のランプ。本線につながるものだけ使う)
LINK_HIGHWAYS = {"motorway_link", "trunk_link"}
# ランプをつなげてたどる長さの上限(m)と、短すぎて手がかりにならないランプ(m)
RAMP_MAX, RAMP_MIN = 3000.0, 60.0
# 上下線を組にするときの距離(m)。まず近いもの同士、残りは離れていても組にする
PAIR_NEAR, PAIR_FAR = 80.0, 800.0


def classify(tags: dict) -> str | None:
    hw = tags.get("highway")
    name = tags.get("name", "")
    operator = tags.get("operator", "")
    if hw == "motorway":
        if any(o in operator for o in URBAN_OPERATORS) or URBAN_NAME.search(name):
            return "urban"
        if EXPRESSWAY_NAME.search(name):
            return "expressway"
        return "motorroad"
    if tags.get("motorroad") == "yes" and hw in ("trunk", "primary"):
        return "motorroad"
    if tags.get("toll") == "yes" and hw in TOLL_HIGHWAYS:
        return "toll"
    return None


WEAK_NAME = re.compile(r"(橋|高架橋|トンネル|隧道)$")
SKIP_NAME = re.compile(r"(^国道\d+号線?$|インター線$|専用|^\d+cc|ランプ|JCT|出口|入口)")
MIN_ROUTE_LEN = 500.0  # m。これより短い路線は、ほかの道の切れ端とみなして数えない


def road_name(tags: dict) -> str:
    """路線の名前。「東北中央自動車道;相馬福島道路」のような併記は最初の名前、「(無料区間)」などの注記は除く"""
    name = unicodedata.normalize("NFKC", tags.get("name", "")).split(";")[0]
    name = re.sub(r"\s+", "", name)  # 「アネスト岩田 ターンパイク箱根」と空白なしをそろえる
    name = re.sub(r"[（(][^）)]*[）)]$", "", name)
    name = re.sub(r"(内回り|外回り|上り|下り|[右左]ルート)$", "", name)  # 上下線で名前が違うもの
    name = re.sub(r"(\d+号)線(?=.)", r"\1", name)  # 名古屋高速3号線大高線 → 3号大高線
    name = re.sub(r"^首都高速道路", "首都高速", name)
    return re.sub(r"(\d+号)$", r"\1線", name)  # 広島高速2号 → 2号線


class Ways(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.ways: list[dict] = []
        self.links: list[dict] = []

    def way(self, w: osmium.osm.Way) -> None:
        tags = dict(w.tags)
        valid = [n for n in w.nodes if n.location.valid()]
        coords = [(n.lon, n.lat) for n in valid]
        if len(coords) < 2:
            return
        nodes = [n.ref for n in valid]
        if tags.get("highway") in LINK_HIGHWAYS:
            self.links.append({"id": w.id, "tags": tags, "coords": coords, "nodes": nodes})
            return
        cat = classify(tags)
        if not cat:
            return
        ends = (nodes[0], nodes[-1])
        self.ways.append({"id": w.id, "tags": tags, "cat": cat, "coords": coords, "nodes": nodes, "ends": ends, "name": road_name(tags)})


def inherit_names(ways: list[dict]) -> None:
    """橋やトンネルの名前しか付いていない道は、つながっている道の名前をもらう"""
    by_node: dict[int, list[dict]] = defaultdict(list)
    for w in ways:
        for n in w["ends"]:
            by_node[n].append(w)
    weak = [w for w in ways if not w["name"] or WEAK_NAME.search(w["name"])]
    for _ in range(20):  # 橋とトンネルが続くところは、名前が少しずつ伝わる
        changed = False
        for w in weak:
            for n in w["ends"]:
                for o in by_node[n]:
                    if o is not w and o["name"] and not WEAK_NAME.search(o["name"]):
                        if w["name"] != o["name"]:
                            w["name"], changed = o["name"], True
                        break
                else:
                    continue
                break
        weak = [w for w in weak if not w["name"] or WEAK_NAME.search(w["name"])]
        if not changed:
            break


def bearing_vec(coords: list[tuple[float, float]]) -> tuple[float, float]:
    (x1, y1), (x2, y2) = coords[0], coords[-1]
    dx = (x2 - x1) * math.cos(math.radians((y1 + y2) / 2))
    dy = y2 - y1
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def mid(coords: list[tuple[float, float]]) -> tuple[float, float]:
    return coords[len(coords) // 2]


def find_pairs(segments: list[dict], raw: dict[str, list[tuple[float, float]]], oneway: set[str]) -> None:
    """同じ路線で、向きが逆の一方通行の区間を組にする"""
    cell = PAIR_FAR / 111_000  # 度。ざっくりした格子で近くを探す
    grid: dict[tuple[str, int, int], list[int]] = defaultdict(list)
    info = []
    for i, s in enumerate(segments):
        c = raw[s["id"]]
        m = mid(c)
        info.append((m, bearing_vec(c)))
        if s["id"] in oneway:
            grid[(s["routes"][0], int(m[0] / cell), int(m[1] / cell))].append(i)

    def candidates(i: int, limit: float, free_only: bool) -> int | None:
        s = segments[i]
        (m, v) = info[i]
        gx, gy = int(m[0] / cell), int(m[1] / cell)
        best, best_d = None, limit
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((s["routes"][0], gx + dx, gy + dy), []):
                    if j == i or (free_only and "pair" in segments[j]):
                        continue
                    m2, v2 = info[j]
                    if v[0] * v2[0] + v[1] * v2[1] > -0.5:  # 逆向きでない
                        continue
                    d = dist(m, m2)
                    if d < best_d:
                        best, best_d = j, d
        return best

    for limit, free_only in ((PAIR_NEAR, False), (PAIR_FAR, True)):
        for i, s in enumerate(segments):
            if s["id"] not in oneway or "pair" in s:
                continue
            j = candidates(i, limit, free_only)
            if j is None:
                continue
            s["pair"] = segments[j]["id"]
            segments[j].setdefault("pair", s["id"])


def line_len(coords: list[tuple[float, float]]) -> float:
    return sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords)))


def ramps_and_access(ways: list[dict], links: list[dict]) -> tuple[list[dict], list[list[float]], list[list[list[float]]]]:
    """IC のランプ(進む向きの線と、in: 下の道から本線へ / out: 本線から下の道へ)と、高速道路に出入りできる場所を求める。

    ways は高速道路(本線)、links はランプの候補(motorway_link・trunk_link)。
    名前が「〜インター線」「〜ランプ」などで路線にしない高速道路の線も、本線として扱う
    (松山外環状道路インター線のように、高架の本線そのものがこの名前のことがあるため)。
    ランプのまとまり(つながっている線)のうち、本線にも下の道(抽出に入っていないので、行き止まりに見える端)にも
    つながっているものが IC のランプ。本線どうしだけをつなぐもの(JCT)は、出入りできる場所と jct にだけ入れる。
    戻り値は (IC のランプ, 出入りできる場所, JCT のランプの線)
    """
    mains = ways
    ramps_in = [dict(l, oneway_default=l["tags"].get("highway") == "motorway_link") for l in links]
    main_nodes: set[int] = set()
    for w in mains:
        main_nodes.update(w["nodes"])

    # 進む向きにそろえる(両方向に通れるランプは向きが分からないので、出入りできる場所にだけ使う)
    oriented: list[dict] = []
    for l in ramps_in:
        ow = l["tags"].get("oneway")
        if ow == "-1":
            oriented.append({"nodes": l["nodes"][::-1], "coords": l["coords"][::-1], "dir": True})
        elif ow == "yes" or (ow is None and l["oneway_default"]):
            oriented.append({"nodes": l["nodes"], "coords": l["coords"], "dir": True})
        else:
            oriented.append({"nodes": l["nodes"], "coords": l["coords"], "dir": False})

    node_count: dict[int, int] = defaultdict(int)
    for l in oriented:
        for n in set(l["nodes"]):
            node_count[n] += 1
    # ランプのまとまり
    parent = list(range(len(oriented)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_end: dict[int, list[int]] = defaultdict(list)
    for i, l in enumerate(oriented):
        for n in (l["nodes"][0], l["nodes"][-1]):
            by_end[n].append(i)
    for idx in by_end.values():
        for j in idx[1:]:
            parent[find(j)] = find(idx[0])
    touches_main: set[int] = set()
    has_open_end: set[int] = set()
    for i, l in enumerate(oriented):
        for n in (l["nodes"][0], l["nodes"][-1]):
            if n in main_nodes:
                touches_main.add(find(i))
            elif node_count[n] == 1:
                has_open_end.add(find(i))

    access: dict[int, tuple[float, float]] = {}
    for i, l in enumerate(oriented):
        if find(i) not in touches_main:
            continue
        for n, p in ((l["nodes"][0], l["coords"][0]), (l["nodes"][-1], l["coords"][-1])):
            if n in main_nodes:
                access[n] = p
    # 本線の端(一般道につながるところ)
    main_count: dict[int, int] = defaultdict(int)
    for w in mains:
        for n in set(w["nodes"]):
            main_count[n] += 1
    for w in mains:
        for n, p in ((w["nodes"][0], w["coords"][0]), (w["nodes"][-1], w["coords"][-1])):
            if main_count[n] == 1 and n not in node_count:
                access[n] = p

    starts: dict[int, list[int]] = defaultdict(list)
    ends: dict[int, list[int]] = defaultdict(list)
    for i, l in enumerate(oriented):
        if l["dir"]:
            starts[l["nodes"][0]].append(i)
            ends[l["nodes"][-1]].append(i)

    def walk(i: int, back: bool) -> list[tuple[float, float]]:
        """本線につながるランプから、分かれ道か下の道に着くまでたどる"""
        coords = list(oriented[i]["coords"])
        seen = {i}
        cur = oriented[i]["nodes"][0 if back else -1]
        while cur not in main_nodes and line_len(coords) < RAMP_MAX:
            nxt = ends[cur] if back else starts[cur]
            other = starts[cur] if back else ends[cur]
            if len(nxt) != 1 or len(other) != 1 or nxt[0] in seen:
                break
            j = nxt[0]
            seen.add(j)
            c = oriented[j]["coords"]
            coords = c[:-1] + coords if back else coords + c[1:]
            cur = oriented[j]["nodes"][0 if back else -1]
        return coords

    jct = [[rnd(p) for p in simplify(l["coords"], SIMPLIFY_METERS)]
           for i, l in enumerate(oriented) if find(i) in touches_main and find(i) not in has_open_end]
    ramps: list[dict] = []
    for i, l in enumerate(oriented):
        if not l["dir"] or find(i) not in touches_main or find(i) not in has_open_end:
            continue
        a, b = l["nodes"][0] in main_nodes, l["nodes"][-1] in main_nodes
        if b and not a:
            coords, kind = walk(i, back=True), "in"
        elif a and not b:
            coords, kind = walk(i, back=False), "out"
        else:
            continue
        if line_len(coords) < RAMP_MIN:
            continue
        ramps.append({"c": [rnd(p) for p in simplify(coords, SIMPLIFY_METERS)], "k": kind})
    return ramps, [rnd(p) for p in access.values()], jct


def build(ways: list[dict], links: list[dict] | None = None) -> dict:
    routes: dict[str, dict] = {}
    route_cat: dict[str, defaultdict] = defaultdict(lambda: defaultdict(float))
    segments: list[dict] = []
    tunnels: list[dict] = []
    raw: dict[str, list[tuple[float, float]]] = {}
    oneway: set[str] = set()
    uncounted: list[list[tuple[float, float]]] = []  # 路線に数えない高速道路の線
    for w in ways:
        tags, coords = w["tags"], w["coords"]
        name = w["name"]
        if not name or SKIP_NAME.search(name):
            uncounted.append(coords)
            continue
        routes.setdefault(name, {"name": name})
        is_oneway = tags.get("oneway") in ("yes", "-1") or (tags.get("highway") == "motorway" and tags.get("oneway") != "no")
        if tags.get("oneway") == "-1":
            coords = coords[::-1]
        tunnel_id = None
        if tags.get("tunnel") not in (None, "no"):
            tunnel_id = f"t{w['id']}"
            length = sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords)))
            tunnels.append({"id": tunnel_id, "a": rnd(coords[0]), "b": rnd(coords[-1]), "len": round(length)})
        for i, piece in enumerate(split_line(coords, SEGMENT_LENGTH)):
            sid = f"w{w['id']}-{i}"
            length = round(sum(dist(piece[j - 1], piece[j]) for j in range(1, len(piece))), 1)
            seg = {"id": sid, "routes": [name], "cats": [w["cat"]], "len": length,
                   "coords": [rnd(p) for p in simplify(piece, SIMPLIFY_METERS)]}
            if tunnel_id:
                seg["tunnel"] = tunnel_id
            segments.append(seg)
            raw[sid] = piece
            route_cat[name][w["cat"]] += length
            if is_oneway:
                oneway.add(sid)

    # 短すぎるもの(橋やトンネルの名前のまま残ったものは少し長くても)は、ほかの道の切れ端として数えない
    short = {r for r, c in route_cat.items() if sum(c.values()) < (1500 if WEAK_NAME.search(r) else MIN_ROUTE_LEN)}
    if short:
        uncounted += [raw[s["id"]] for s in segments if s["routes"][0] in short]
        segments = [s for s in segments if s["routes"][0] not in short]
        keep_t = {s.get("tunnel") for s in segments}
        tunnels = [t for t in tunnels if t["id"] in keep_t]
        for r in short:
            routes.pop(r, None)
            route_cat.pop(r, None)

    # 路線の種別は一番長いものにそろえる(高速の一部だけ名前の付き方が違う、などで分かれないように)
    main_cat = {r: max(c.items(), key=lambda kv: kv[1])[0] for r, c in route_cat.items()}
    for s in segments:
        s["cats"] = [main_cat[s["routes"][0]]]

    find_pairs(segments, raw, oneway)
    order = ["expressway", "urban", "motorroad", "toll"]
    ramps, access, jct = ramps_and_access(ways, links or [])
    return {
        "version": 1,
        "kind": "expressway",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "routes": dict(sorted(routes.items(), key=lambda kv: (order.index(main_cat[kv[0]]), kv[0]))),
        "segments": segments,
        "tunnels": tunnels,
        "ramps": ramps,
        "access": access,
        "uncounted": [[rnd(p) for p in simplify(c, SIMPLIFY_METERS)] for c in uncounted],
        "jct": jct,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pbf", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    h = Ways()
    h.apply_file(str(args.pbf), locations=True, idx="flex_mem")
    inherit_names(h.ways)
    data = build(h.ways, h.links)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    segs = data["segments"]
    paired = sum(1 for s in segs if "pair" in s)
    km = sum(s["len"] * (0.5 if "pair" in s else 1) for s in segs) / 1000
    by_cat: dict[str, float] = defaultdict(float)
    for s in segs:
        by_cat[s["cats"][0]] += s["len"] * (0.5 if "pair" in s else 1) / 1000
    print(f"{len(data['routes'])} 路線 / {len(segs)} 区間(上下線の組 {paired}) / 道路として {km:,.0f} km → {args.out}", file=sys.stderr)
    kinds = defaultdict(int)
    for r in data["ramps"]:
        kinds[r["k"]] += 1
    print(f"  ランプ: 入口 {kinds['in']} / 出口 {kinds['out']}、出入りできる場所 {len(data['access'])}、路線に数えない本線 {len(data['uncounted'])} / JCT のランプ {len(data['jct'])}", file=sys.stderr)
    for c, v in sorted(by_cat.items(), key=lambda kv: -kv[1]):
        print(f"  {c}: {v:,.0f} km", file=sys.stderr)


if __name__ == "__main__":
    main()
