#!/usr/bin/env python3
"""OSM の抽出ファイルから都道府県道(東京都道・神奈川県道・北海道道など)を取り出し、
都道府県ごとのファイル(prefroads/01.json 〜 47.json)と一覧(prefroads/index.json)を作る。

  osmium tags-filter japan-latest.osm.pbf r/network=JP:prefectural* w/highway=secondary,tertiary -o prefroad.osm.pbf
  osmium tags-filter japan-latest.osm.pbf r/network=JP:national -o kokudo.osm.pbf
  osmium tags-filter japan-latest.osm.pbf r/admin_level=4 -o pref.osm.pbf
  python3 scripts/build_pref_roads.py prefroad.osm.pbf kokudo.osm.pbf pref.osm.pbf --out-dir prefroads

都道府県道は全国で国道の2倍以上あり、全部を一度に読むと重いので、アプリは選んだ都道府県のファイルだけ読む。

- 路線は都道府県と番号ごと(キーは "13-413" のような「都道府県コード-番号」)
- 都道府県道のリレーション(network=JP:prefectural:<都道府県>)に入っている道を主に使う。
  リレーションのない道は、highway=secondary/tertiary で ref に番号があるもの、
  または名前が「神奈川県道22号…」のようなものを、その場所の都道府県の道として拾う
- 国道のリレーションに入っている道(国道との重複区間)は国道で数えるので除く
- 種別は OSM の格付けから推定する: secondary 以上 → 主要地方道(major)、それ以外 → 一般都道府県道(general)。
  路線ごとに長いほうにそろえる。2路線以上が重なる区間には重複(overlap)も付ける
- 区間の ID は "p<wayId>-<番号>"。国道・高速道路のデータ("w…")と記録がまざらないように頭を変えている
- 上下線が別の線になっているところは、高速道路と同じく組(pair)にする
- 区間に通称(「三宿通り」など、OSM の name・loc_name・alt_name)があれば name に入れる

pyosmium と shapely が必要です(pip install osmium shapely)。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import osmium
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parent))
from add_prefectures import PREFS, load_prefectures, locate  # noqa: E402
from build_expressways import find_pairs  # noqa: E402
from build_routes import NOT_ROADS, SEGMENT_LENGTH, SIMPLIFY_METERS, dist, rnd, simplify, split_line  # noqa: E402

# network=JP:prefectural:<ローマ字> のローマ字 → 都道府県コード
ROMAJI = [
    "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima",
    "ibaraki", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa",
    "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu", "shizuoka", "aichi",
    "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama",
    "tottori", "shimane", "okayama", "hiroshima", "yamaguchi",
    "tokushima", "kagawa", "ehime", "kochi",
    "fukuoka", "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa",
]
# 「神奈川県道22号横浜伊勢原線」「都道413号」のような名前
PREF_PREFIX = "|".join(sorted({p[:-1] if p != "北海道" else "北海" for p in PREFS}, key=len, reverse=True))
ROAD_NAME = re.compile(rf"^(?:({PREF_PREFIX})?(都|道|府|県))道(\d+)号")
NUMERIC_REF = re.compile(r"^\d{1,4}$")
# 通称として出さない名前(橋・トンネルの名前、国道や路線番号だけの名前)
NOT_NICKNAME = re.compile(r"(橋|高架橋|トンネル|隧道)$|国道")
# 道路として数えない種類(歩道・小道・ランプ・工事中など)
SKIP_HIGHWAYS = {
    "footway", "path", "steps", "cycleway", "pedestrian", "bridleway", "track", "corridor", "elevator",
    "platform", "bus_stop", "services", "rest_area", "escape", "raceway", "busway", "via_ferrata",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
} | NOT_ROADS
MAJOR_HIGHWAYS = {"motorway", "trunk", "primary", "secondary"}
# リレーションのない道だけでできた路線は、これより短ければ ref の付け間違いなどの切れ端とみなして除く(m)
MIN_LOOSE_ROUTE = 300.0
# アプリが「このあたりにどの都道府県の道があるか」を調べる格子の大きさ(度)
CELL = 0.1
# 格子に入れるとき、区間の点をこれだけ(度。約100m)広げて、格子の境の近くを取りこぼさないようにする
CELL_PAD = 0.001


def pref_of_network(network: str) -> int | None:
    parts = network.split(":")
    if len(parts) >= 3:
        key = parts[2].strip().lower().replace("ō", "o").replace("ū", "u")
        if key in ROMAJI:
            return ROMAJI.index(key) + 1
    return None


def pref_of_name(name: str) -> int | None:
    """「神奈川県道…」「東京都道…」のような名前から都道府県コード。わからなければ None"""
    for i, p in enumerate(PREFS):
        if name.startswith(p + "道"):
            return i + 1
    return None


def nickname(tags) -> str:
    """区間の通称(「三宿通り」など)。name・loc_name・alt_name のうち、路線の正式な名前や橋の名前でない最初のもの"""
    for key in ("name", "loc_name", "alt_name"):
        n = norm(tags.get(key, ""))
        if n and not ROAD_NAME.match(n) and not NOT_NICKNAME.search(n):
            return n
    return ""


def norm(s: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or "")).split(";")[0]


class NationalWays(osmium.SimpleHandler):
    """国道のリレーションに入っている道"""

    def __init__(self) -> None:
        super().__init__()
        self.ways: set[int] = set()

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.tags.get("network") == "JP:national" and r.tags.get("type") == "route":
            self.ways.update(m.ref for m in r.members if m.type == "w")


class PrefRelations(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        # way ID → [(都道府県コードか None, 番号, 名前)]
        self.members: dict[int, list[tuple[int | None, str, str]]] = defaultdict(list)
        self.networks: Counter = Counter()
        self.count = 0

    def relation(self, r: osmium.osm.Relation) -> None:
        tags = r.tags
        network = tags.get("network", "")
        if not network.startswith("JP:prefectural") or tags.get("type") != "route" or tags.get("route") != "road":
            return
        self.networks[network] += 1
        name = norm(tags.get("name", ""))
        ref = unicodedata.normalize("NFKC", tags.get("ref", "")).strip()
        m = ROAD_NAME.match(name)
        if not NUMERIC_REF.match(ref):
            ref = m.group(3) if m else ""
        if not ref:
            return
        code = pref_of_network(network) or pref_of_name(name)
        self.count += 1
        for mem in r.members:
            if mem.type == "w":
                self.members[mem.ref].append((code, str(int(ref)), name))


class Ways(osmium.SimpleHandler):
    def __init__(self, rel_members: dict, national: set[int]) -> None:
        super().__init__()
        self.rel_members = rel_members
        self.national = national
        self.ways: list[dict] = []
        self.skipped_national = 0

    def way(self, w: osmium.osm.Way) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if not hw or hw in SKIP_HIGHWAYS or tags.get("area") == "yes":
            return
        entries = self.rel_members.get(w.id)
        name = norm(tags.get("name", ""))
        if not entries:
            if "国道" in name:
                return
            refs = [r.strip() for r in unicodedata.normalize("NFKC", tags.get("ref", "")).split(";")]
            refs = [str(int(r)) for r in refs if NUMERIC_REF.match(r)]
            m = ROAD_NAME.match(name)
            if refs and hw in ("secondary", "tertiary"):
                entries = [(pref_of_name(name), r, "") for r in refs]
            elif m:
                entries = [(pref_of_name(name), str(int(m.group(3))), "")]
            else:
                return
        if w.id in self.national:
            self.skipped_national += 1
            return
        coords = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(coords) < 2:
            return
        oneway = tags.get("oneway")
        if oneway == "-1":
            coords = coords[::-1]
        self.ways.append({
            "id": w.id,
            "hw": hw,
            "coords": coords,
            "entries": entries,
            "rel": w.id in self.rel_members,
            "oneway": oneway in ("yes", "-1"),
            "tunnel": tags.get("tunnel") not in (None, "no"),
            "name": name,
            "nick": nickname(tags),
        })


def build(ways: list[dict], shapes: dict[int, shapely.Geometry]) -> dict[int, dict]:
    codes = list(shapes)
    tree = shapely.STRtree([shapes[c] for c in codes])

    pieces = []  # (way, 番号, 区間の点)
    for w in ways:
        for i, piece in enumerate(split_line(w["coords"], SEGMENT_LENGTH)):
            pieces.append((w, i, piece))
    mids = shapely.points([p[len(p) // 2] for _, _, p in pieces])
    found = locate(tree, mids)
    rest = [i for i, f in enumerate(found) if f < 0]
    if rest:
        src, dst = tree.query_nearest(mids[rest], return_distance=False)
        for k, j in zip(src.tolist(), dst.tolist()):
            found[rest[k]] = j

    segments: list[dict] = []
    raw: dict[str, list] = {}
    oneway: set[str] = set()
    tunnels: dict[str, dict] = {}
    route_len: dict[str, defaultdict] = defaultdict(lambda: defaultdict(float))
    rel_routes: set[str] = set()
    way_names: dict[str, Counter] = defaultdict(Counter)
    rel_names: dict[str, Counter] = defaultdict(Counter)
    for (w, i, piece), f in zip(pieces, found):
        here = codes[f]
        keys = []
        for code, ref, rname in w["entries"]:
            key = f"{code or here}-{ref}"
            if key in keys:
                continue
            keys.append(key)
            if rname:
                rel_names[key][rname] += 1
            if w["rel"]:
                rel_routes.add(key)
            m = ROAD_NAME.match(w["name"])
            if m and str(int(m.group(3))) == ref:
                way_names[key][w["name"]] += 1
        sid = f"p{w['id']}-{i}"
        length = round(sum(dist(piece[j - 1], piece[j]) for j in range(1, len(piece))), 1)
        seg = {"id": sid, "routes": keys, "len": length, "coords": [rnd(p) for p in simplify(piece, SIMPLIFY_METERS)]}
        if w["nick"]:
            seg["name"] = w["nick"]
        if w["tunnel"]:
            tid = f"pt{w['id']}"
            seg["tunnel"] = tid
            if tid not in tunnels:
                c = w["coords"]
                tl = sum(dist(c[j - 1], c[j]) for j in range(1, len(c)))
                tunnels[tid] = {"id": tid, "a": rnd(c[0]), "b": rnd(c[-1]), "len": round(tl)}
        seg["_major"] = w["hw"] in MAJOR_HIGHWAYS
        segments.append(seg)
        raw[sid] = piece
        if w["oneway"]:
            oneway.add(sid)
        for k in keys:
            route_len[k]["major" if seg["_major"] else "general"] += length

    # リレーションのない道だけでできた短い路線は除く
    drop = {k for k, c in route_len.items() if k not in rel_routes and sum(c.values()) < MIN_LOOSE_ROUTE}
    kept = []
    for s in segments:
        s["routes"] = [k for k in s["routes"] if k not in drop]
        if s["routes"]:
            kept.append(s)
    segments = kept
    print(f"  短い切れ端として除いた路線: {len(drop)}", file=sys.stderr)

    main_cat = {k: max(c.items(), key=lambda kv: kv[1])[0] for k, c in route_len.items() if k not in drop}
    for s in segments:
        s.pop("_major")
        s["cats"] = [main_cat[s["routes"][0]]] + (["overlap"] if len(s["routes"]) > 1 else [])
    find_pairs(segments, raw, oneway)

    def route_name(key: str) -> str:
        code, ref = key.split("-")
        for names in (rel_names[key], way_names[key]):
            if names:
                return names.most_common(1)[0][0]
        return f"{PREFS[int(code) - 1]}道{ref}号"

    now = datetime.now(timezone.utc).isoformat()
    out: dict[int, dict] = {}
    for s in segments:
        by_code: dict[int, list[str]] = defaultdict(list)
        for k in s["routes"]:
            by_code[int(k.split("-")[0])].append(k)
        for code, keys in by_code.items():
            d = out.setdefault(code, {"version": 1, "kind": "prefroad", "generatedAt": now, "pref": code,
                                      "routes": {}, "segments": [], "tunnels": [], "_t": set()})
            seg = dict(s, routes=keys, pref=code)
            if len(keys) < 2 and "overlap" in seg["cats"]:
                seg["cats"] = [c for c in seg["cats"] if c != "overlap"]
            seg["cats"] = [main_cat[keys[0]]] + [c for c in seg["cats"] if c == "overlap"]
            d["segments"].append(seg)
            for k in keys:
                d["routes"].setdefault(k, {"name": route_name(k)})
            if "tunnel" in s and s["tunnel"] not in d["_t"]:
                d["_t"].add(s["tunnel"])
                d["tunnels"].append(tunnels[s["tunnel"]])
    for d in out.values():
        d.pop("_t")
        d["routes"] = dict(sorted(d["routes"].items(), key=lambda kv: int(kv[0].split("-")[1])))
    return out


def cells_of(segments: list[dict]) -> list[int]:
    cells = set()
    for s in segments:
        for lon, lat in s["coords"]:
            for dx in (-CELL_PAD, CELL_PAD):
                for dy in (-CELL_PAD, CELL_PAD):
                    cells.add(int((lon + dx) / CELL) * 1000 + int((lat + dy) / CELL))
    return sorted(cells)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("roads", help="都道府県道のリレーションと secondary/tertiary の道を含む .osm.pbf")
    ap.add_argument("national", help="国道のリレーションを含む .osm.pbf(重複区間を除くため)")
    ap.add_argument("boundaries", help="行政界(admin_level=4)を含む .osm.pbf")
    ap.add_argument("--fallback", type=Path, help="境界が作れなかった都道府県に使う、前回の prefectures.json")
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    nat = NationalWays()
    nat.apply_file(args.national)
    rels = PrefRelations()
    rels.apply_file(args.roads)
    print(f"都道府県道のリレーション {rels.count} 件(network の値: {dict(rels.networks.most_common(60))})", file=sys.stderr)
    unknown = sum(1 for es in rels.members.values() for c, _, _ in es if c is None)
    if unknown:
        print(f"  都道府県がわからないリレーションの道 {unknown} 本は、場所で決めます", file=sys.stderr)
    h = Ways(rels.members, nat.ways)
    h.apply_file(args.roads, locations=True, idx="flex_mem")
    print(f"道 {len(h.ways)} 本(うちリレーション {sum(1 for w in h.ways if w['rel'])} 本)/ 国道と重なるため除いた道 {h.skipped_national} 本",
          file=sys.stderr)

    shapes = load_prefectures(args.boundaries, args.fallback)
    files = build(h.ways, shapes)

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    index = {"version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(), "cell": CELL, "prefs": {}}
    total_km = 0.0
    for code in sorted(files):
        d = files[code]
        path = out_dir / f"{code:02d}.json"
        body = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        path.write_text(body)
        km = sum(s["len"] * (0.5 if "pair" in s else 1) for s in d["segments"]) / 1000
        total_km += km
        by_cat = Counter()
        for s in d["segments"]:
            by_cat[s["cats"][0]] += s["len"] * (0.5 if "pair" in s else 1) / 1000
        index["prefs"][str(code)] = {
            "name": PREFS[code - 1], "routes": len(d["routes"]), "km": round(km, 1),
            "bytes": len(body.encode()), "cells": cells_of(d["segments"]),
        }
        print(f"  {PREFS[code - 1]}: {len(d['routes'])} 路線 / {km:,.0f} km(主要地方道 {by_cat['major']:,.0f} km)"
              f" / {len(body.encode()) / 1e6:.1f} MB", file=sys.stderr)
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    print(f"合計 {total_km:,.0f} km → {out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
