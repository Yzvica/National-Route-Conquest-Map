#!/usr/bin/env python3
"""OSM の抽出ファイルから都道府県道(東京都道・神奈川県道・北海道道など)を取り出し、
都道府県ごとのファイル(prefroads/01.json 〜 47.json)と一覧(prefroads/index.json)を作る。

  osmium tags-filter japan-latest.osm.pbf r/network=JP:prefectural* w/highway=primary,secondary,tertiary -o prefroad.osm.pbf
  osmium tags-filter japan-latest.osm.pbf r/network=JP:national -o kokudo.osm.pbf
  osmium tags-filter japan-latest.osm.pbf r/admin_level=4 -o pref.osm.pbf
  python3 scripts/build_pref_roads.py prefroad.osm.pbf kokudo.osm.pbf pref.osm.pbf --out-dir prefroads

都道府県道は全国で国道の2倍以上あり、全部を一度に読むと重いので、アプリは選んだ都道府県のファイルだけ読む。

- 路線は都道府県と番号ごと(キーは "13-413" のような「都道府県コード-番号」)
- 都道府県道のリレーション(network=JP:prefectural:<都道府県>)に入っている道を主に使う。
  リレーションのない道は、highway=primary/secondary/tertiary で ref に番号があるもの、
  または名前が「神奈川県道22号…」のようなものを、その場所の都道府県の道として拾う
- 国道のリレーションに入っている道(国道との重複区間)は国道で数えるので除く
- 種別は OSM の格付けから推定する: primary 以上 → 主要地方道(major)、それ以外 → 一般都道府県道(general)。
  路線ごとに長いほうにそろえる。2路線以上が重なる区間には重複(overlap)も付ける
- 区間の ID は "p<wayId>-<番号>"。国道・高速道路のデータ("w…")と記録がまざらないように頭を変えている
- 上下線が別の線になっているところは、高速道路と同じく組(pair)にする
- 区間に通称(「三宿通り」など、OSM の name・loc_name・alt_name)があれば name に入れる

pyosmium と shapely が必要です(pip install osmium shapely)。
"""
from __future__ import annotations

import argparse
import json
import os
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
# 市町村道・区道の名前(「市道3号線」「2級市道〇〇線」「特別区道江147号」など。「坂ノ市道路」のような「道路」は除く)。
# 市道にも県道と同じ数字の ref が付いていることがあるので、リレーションのない道でこの名前なら使わない
MUNICIPAL_NAME = re.compile(r"(市|町|村|区)道(?!路)")
# 道路として数えない種類(歩道・小道・ランプ・工事中など)
SKIP_HIGHWAYS = {
    "footway", "path", "steps", "cycleway", "pedestrian", "bridleway", "track", "corridor", "elevator",
    "platform", "bus_stop", "services", "rest_area", "escape", "raceway", "busway", "via_ferrata",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
} | NOT_ROADS
# OSM の日本の決まりでは、主要地方道は primary、一般都道府県道は secondary(tertiary は主な市町村道)
MAJOR_HIGHWAYS = {"motorway", "trunk", "primary"}
LOOSE_HIGHWAYS = {"primary", "secondary", "tertiary"}
# tertiary(主な市町村道)に数字の ref だけ付いた道は、市道・区道の番号のことが多い。
# 同じ路線がリレーション・primary/secondary・「〇〇県道N号」の名前のどれかでも出てくるときだけ使う
WEAK_HIGHWAYS = {"tertiary"}
# 都道府県道の番号は北海道(4桁がある)以外は3桁まで。それより大きい番号は市町村道とみなす
MAX_REF_EXCEPT_HOKKAIDO = 999
HOKKAIDO = 1
# Wikipedia の県道一覧(fetch_wiki_prefroads.py)で確かめるとき:
# 一覧の路線数が OSM の路線数のこれ以上の割合なら、一覧に無い番号のリレーションのない路線を除く(一覧の読み取り失敗に備える)
WIKI_MIN_COVER = 0.6
# リレーションのない道は、起点と終点を結ぶ線からこれ以上(km。起点・終点の距離の WIKI_SPREAD 倍のほうが大きければそちら)
# 離れていて、同じ路線のリレーションの道からも WIKI_NEAR_REL km 以上離れていたら、その路線の道としない
WIKI_CORRIDOR_KM = 8.0
WIKI_SPREAD = 0.6
WIKI_NEAR_REL_KM = 3.0
# リレーションのない道だけでできた路線は、これより短ければ ref の付け間違いなどの切れ端とみなして除く(m)
MIN_LOOSE_ROUTE = 300.0
# アプリが「このあたりにどの都道府県の道があるか」を調べる格子の大きさ(度)
CELL = 0.1
# 格子に入れるとき、区間の点をこれだけ(度。約100m)広げて、格子の境の近くを取りこぼさないようにする
CELL_PAD = 0.001


def prefs_of_network(network: str) -> set[int]:
    """network の値の都道府県コード。「JP:prefectural:tokyo;JP:prefectural:kanagawa」のように2つ以上のこともある"""
    codes = set()
    for part in network.split(";"):
        bits = part.strip().split(":")
        if len(bits) >= 3:
            key = bits[2].strip().lower().replace("ō", "o").replace("ū", "u")
            if key in ROMAJI:
                codes.add(ROMAJI.index(key) + 1)
    return codes


def pref_of_network(network: str) -> int | None:
    codes = prefs_of_network(network)
    return next(iter(codes)) if len(codes) == 1 else None


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
        official = norm(tags.get("official_name", ""))
        ref = unicodedata.normalize("NFKC", tags.get("ref", "")).strip()
        m = ROAD_NAME.match(name)
        if not NUMERIC_REF.match(ref):
            ref = m.group(3) if m else ""
        if not ref:
            return
        # 2つの都道府県にまたがる路線(「東京都道・神奈川県道3号」など、network に2つ書いてあるもの)は、
        # 区間ごとに場所で都道府県を決める。名前の頭だけで決めると、神奈川県側も東京都道にしてしまう
        multi = len(prefs_of_network(network)) > 1 or bool(re.match(rf"^(?:{PREF_PREFIX})(?:都|道|府|県)道・", name))
        code = None if multi else (pref_of_network(network) or pref_of_name(name))
        self.count += 1
        if DETAIL and any(d in name or d in tags.get("official_name", "") or d in tags.get("alt_name", "") for d in DETAIL):
            print(f"  [確認] リレーション {r.id}: {dict(tags)} / 道 {sum(1 for m in r.members if m.type == 'w')} 本 / 都道府県 {code}",
                  file=sys.stderr)
        # 「東京都道・神奈川県道3号」+ official_name「世田谷町田線」のように、路線名が別に書いてあればつなげる
        full = name + official if official and official not in name and name.endswith("号") else name
        for mem in r.members:
            if mem.type == "w":
                self.members[mem.ref].append((code, str(int(ref)), full))


# 確認用: 名前にこの言葉を含むリレーションと道を、どう扱ったかログに出す(例: PREFROAD_DETAIL="津久井道 世田谷町田")
DETAIL = os.environ.get("PREFROAD_DETAIL", "").split()


class Ways(osmium.SimpleHandler):
    def __init__(self, rel_members: dict, national: set[int]) -> None:
        super().__init__()
        self.rel_members = rel_members
        self.national = national
        self.ways: list[dict] = []
        self.skipped_national = 0
        self.detail_count = 0

    def detail(self, w: osmium.osm.Way) -> None:
        if self.detail_count >= 60:
            return
        self.detail_count += 1
        t = w.tags
        keys = ("highway", "ref", "name", "official_name", "alt_name")
        info = {k: t.get(k) for k in keys if t.get(k)}
        print(f"  [確認] 道 {w.id}: {info} / リレーション {self.rel_members.get(w.id)} / 国道 {w.id in self.national}",
              file=sys.stderr)

    def way(self, w: osmium.osm.Way) -> None:
        tags = w.tags
        if DETAIL and any(d in tags.get("name", "") for d in DETAIL):
            self.detail(w)
        hw = tags.get("highway")
        if not hw or hw in SKIP_HIGHWAYS or tags.get("area") == "yes":
            return
        entries = self.rel_members.get(w.id)
        name = norm(tags.get("name", ""))
        weak = False
        if not entries:
            if "国道" in name or (MUNICIPAL_NAME.search(name) and not ROAD_NAME.search(name)):
                return
            refs = [r.strip() for r in unicodedata.normalize("NFKC", tags.get("ref", "")).split(";")]
            refs = [str(int(r)) for r in refs if NUMERIC_REF.match(r)]
            m = ROAD_NAME.match(name)
            if m:
                entries = [(pref_of_name(name), str(int(m.group(3))), "")]
            elif refs and hw in LOOSE_HIGHWAYS:
                entries = [(pref_of_name(name), r, "") for r in refs]
                weak = hw in WEAK_HIGHWAYS
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
            "weak": weak,
            "oneway": oneway in ("yes", "-1"),
            "tunnel": tags.get("tunnel") not in (None, "no"),
            "name": name,
            "nick": nickname(tags),
        })


class Places(osmium.SimpleHandler):
    """市町村の点(place=city/town/village)の名前 → 場所の一覧"""

    def __init__(self) -> None:
        super().__init__()
        self.points: dict[str, list] = defaultdict(list)

    def node(self, n: osmium.osm.Node) -> None:
        if n.tags.get("place") in ("city", "town", "village") and n.location.valid():
            name = norm(n.tags.get("name", ""))
            if name:
                self.points[name].append((n.location.lon, n.location.lat))


def place_point(name: str, code: int, places: dict[str, list], shapes: dict[int, shapely.Geometry]):
    """市町村名の場所。同じ名前がいくつもあれば、その都道府県にいちばん近いもの"""
    cands = places.get(name)
    if not cands:
        return None
    shape = shapes.get(code)
    if shape is None or len(cands) == 1:
        return cands[0]
    return min(cands, key=lambda p: shape.distance(shapely.Point(p)))


def wiki_check(segments: list[dict], route_len: dict, rel_routes: set[str], drop: set[str], wiki: dict,
               places: dict[str, list], shapes: dict[int, shapely.Geometry]) -> set[str]:
    """Wikipedia の県道一覧で確かめる。一覧に無い番号の路線(リレーションのないもの)は返して除かせ、
    起点・終点から離れたリレーションのない道は、その路線から外す"""
    by_code: dict[str, set[str]] = defaultdict(set)
    for k in route_len:
        if k not in drop:
            by_code[k.split("-")[0]].add(k.split("-")[1])
    missing: set[str] = set()
    for code, refs in by_code.items():
        listed = wiki.get(code)
        if not listed or len(listed) < WIKI_MIN_COVER * len(refs):
            continue
        missing |= {f"{code}-{r}" for r in refs if r not in listed and f"{code}-{r}" not in rel_routes}
    km = sum(sum(route_len[k].values()) for k in missing) / 1000
    print(f"  Wikipedia の一覧に無い番号として除いた路線: {len(missing)} ({km:.0f}km)"
          f" {sorted(missing, key=lambda k: tuple(map(int, k.split('-'))))[:40]}", file=sys.stderr)

    # 起点・終点を結ぶ線
    corridor: dict[str, tuple[shapely.Geometry, float]] = {}
    for k in route_len:
        code, ref = k.split("-")
        info = wiki.get(code, {}).get(ref)
        if not info or "from" not in info:
            continue
        # 起点・終点は記事の座標があればそれを、無ければ市町村の点を使う。主な経由地があれば間に入れる
        a = tuple(info["from_pt"]) if "from_pt" in info else place_point(info["from"], int(code), places, shapes)
        b = tuple(info["to_pt"]) if "to_pt" in info else place_point(info["to"], int(code), places, shapes)
        if a is None or b is None:
            continue
        vias = [v for v in (place_point(n, int(code), places, shapes) for n in info.get("via", [])) if v is not None]
        pts = list(dict.fromkeys([a, *vias, b]))
        line = shapely.LineString(pts) if len(pts) > 1 else shapely.Point(a)
        span = max(dist(p, q) for p in pts for q in pts)
        corridor[k] = (line, max(WIKI_CORRIDOR_KM, WIKI_SPREAD * span / 1000))
    rel_pts: dict[str, list] = defaultdict(list)
    for s in segments:
        if s["_rel"]:
            for k in s["routes"]:
                if k in corridor:
                    rel_pts[k].append(s["coords"][len(s["coords"]) // 2])
    rel_geom = {k: shapely.MultiPoint(v) for k, v in rel_pts.items()}
    km_per_deg = 100.0  # 日本あたりの、1度のおおよその距離(km)。ゆるい判定なので緯度による違いは気にしない
    moved = Counter()
    example: dict[str, tuple] = {}
    for s in segments:
        if s["_rel"]:
            continue
        mid = shapely.Point(s["coords"][len(s["coords"]) // 2])
        keep = []
        for k in s["routes"]:
            if k in corridor:
                line, limit = corridor[k]
                near_line = line.distance(mid) * km_per_deg <= limit
                near_rel = k in rel_geom and rel_geom[k].distance(mid) * km_per_deg <= WIKI_NEAR_REL_KM
                if not near_line and not near_rel:
                    moved[k] += s["len"]
                    example.setdefault(k, (s["id"], s["coords"][len(s["coords"]) // 2],
                                           round(line.distance(mid) * km_per_deg, 1), round(limit, 1)))
                    route_len[k]["major" if s["_major"] else "general"] -= s["len"]
                    continue
            keep.append(k)
        s["routes"] = keep
    print(f"  起点・終点から離れているため外した道: {len(moved)} 路線 ({sum(moved.values()) / 1000:.0f}km)"
          f" {[k for k, _ in moved.most_common(30)]}", file=sys.stderr)
    print(f"  起点・終点で確かめた路線: {len(corridor)} / {len(route_len)}", file=sys.stderr)
    for k, m in moved.most_common(40):
        code, ref = k.split("-")
        info = wiki[code][ref]
        total = sum(route_len[k].values()) + m
        print(f"    [外した道] {k} {info.get('name', '')}: {m / 1000:.1f}/{total / 1000:.1f}km"
              f" 起点 {info['from']}{info.get('from_pt', '')} 終点 {info['to']}{info.get('to_pt', '')}"
              f" 経由 {info.get('via', [])} リレーション {'あり' if k in rel_geom else 'なし'} 例 {example[k]}",
              file=sys.stderr)
    return missing


def build(ways: list[dict], shapes: dict[int, shapely.Geometry], wiki: dict | None = None,
          places: dict[str, list] | None = None) -> dict[int, dict]:
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
    strong_routes: set[str] = set()
    big_refs: set[str] = set()
    way_names: dict[str, Counter] = defaultdict(Counter)
    rel_names: dict[str, Counter] = defaultdict(Counter)
    for (w, i, piece), f in zip(pieces, found):
        here = codes[f]
        keys = []
        for code, ref, rname in w["entries"]:
            key = f"{code or here}-{ref}"
            if key in keys:
                continue
            if int(ref) > MAX_REF_EXCEPT_HOKKAIDO and (code or here) != HOKKAIDO:
                big_refs.add(key)
                continue
            keys.append(key)
            if not w["weak"]:
                strong_routes.add(key)
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
        seg["_rel"] = w["rel"]
        segments.append(seg)
        raw[sid] = piece
        if w["oneway"]:
            oneway.add(sid)
        for k in keys:
            route_len[k]["major" if seg["_major"] else "general"] += length

    # リレーションのない道だけでできた短い路線は除く
    drop = {k for k, c in route_len.items() if k not in rel_routes and sum(c.values()) < MIN_LOOSE_ROUTE}
    print(f"  短い切れ端として除いた路線: {len(drop)}", file=sys.stderr)
    weak_only = {k for k in route_len if k not in strong_routes}
    print(f"  市町村道とみなして除いた路線: 番号が4桁 {len(big_refs)} / tertiary の ref だけ {len(weak_only)}"
          f" ({sum(sum(route_len[k].values()) for k in weak_only - drop) / 1000:.0f}km)", file=sys.stderr)
    drop |= weak_only
    if wiki:
        drop |= wiki_check(segments, route_len, rel_routes, drop, wiki, places or {}, shapes)
    kept = []
    for s in segments:
        s["routes"] = [k for k in s["routes"] if k not in drop]
        if s["routes"]:
            kept.append(s)
    segments = kept

    main_cat = {k: max(c.items(), key=lambda kv: kv[1])[0] for k, c in route_len.items() if k not in drop}
    for s in segments:
        s.pop("_major")
        s.pop("_rel")
        s["cats"] = [main_cat[s["routes"][0]]] + (["overlap"] if len(s["routes"]) > 1 else [])
    find_pairs(segments, raw, oneway)

    def route_name(key: str) -> str:
        """路線の名前。番号の入っていない名前(「世田谷町田線」「津久井道」など)には「神奈川県道3号」のような番号を前に付ける"""
        code, ref = key.split("-")
        base = f"{PREFS[int(code) - 1]}道{ref}号"
        for names in (rel_names[key], way_names[key]):
            if names:
                name = names.most_common(1)[0][0]
                hit = re.search(rf"(?<!\d){ref}号", name)
                if not hit:
                    return f"{base} {name}"
                # 「東京都道・神奈川県道3号世田谷町田線」は、その都道府県の名前にする(神奈川県道3号世田谷町田線)
                return base + name[hit.end():] if "・" in name[: hit.start()] else name
        return base

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
    ap.add_argument("roads", help="都道府県道のリレーションと primary/secondary/tertiary の道を含む .osm.pbf")
    ap.add_argument("national", help="国道のリレーションを含む .osm.pbf(重複区間を除くため)")
    ap.add_argument("boundaries", help="行政界(admin_level=4)を含む .osm.pbf")
    ap.add_argument("--fallback", type=Path, help="境界が作れなかった都道府県に使う、前回の prefectures.json")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--wiki", type=Path, help="fetch_wiki_prefroads.py で作った Wikipedia の県道一覧(確かめに使う)")
    ap.add_argument("--places", help="市町村の場所(place=city/town/village の点)を含む .osm.pbf。起点・終点の確かめに使う")
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
    wiki = None
    if args.wiki and args.wiki.exists():
        wiki = json.loads(args.wiki.read_text(encoding="utf-8"))
    places: dict[str, list] = {}
    if wiki and args.places:
        ph = Places()
        ph.apply_file(args.places)
        places = ph.points
        print(f"市町村の場所 {sum(map(len, places.values()))} か所", file=sys.stderr)
    files = build(h.ways, shapes, wiki, places)

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
