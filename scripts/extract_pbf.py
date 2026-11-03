#!/usr/bin/env python3
"""OSM の抽出ファイル(.osm.pbf / .osm)から国道の路線と道路を取り出し、
build_routes.py が読める Overpass 形式の JSON にする。

Overpass API は混雑で断られることがあるので、Actions ではこちらを使う。
  python3 scripts/extract_pbf.py japan-latest.osm.pbf raw.json
  python3 scripts/build_routes.py --input raw.json

pyosmium が必要です(pip install osmium)。大きなファイルは先に
osmium-tool で絞り込むと速くなります:
  osmium tags-filter japan-latest.osm.pbf r/network=JP:national -o kokudo.osm.pbf

3つ目に高速道路の抽出ファイルを渡すと、一般国道の自動車専用道路(西九州自動車道=国道497号、
新湘南バイパス=国道1号など)のうち、国道のリレーションに入っていない道も加える:
  python3 scripts/extract_pbf.py kokudo.osm.pbf raw.json expressway.osm.pbf
OSM の日本では、こうした道の ref に「E35;497」「C4;468」のように国道の番号が入っている(nat_ref のこともある)。
"""
from __future__ import annotations

import json
import re
import unicodedata
import sys
from collections import defaultdict

import osmium

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from build_expressways import URBAN_NAME, URBAN_OPERATORS  # noqa: E402
from build_routes import dist  # noqa: E402


# 国道の番号(1〜58、101〜507。109〜111・214〜216 は欠番)
NATIONAL_REFS = {str(n) for n in [*range(1, 59), *range(101, 508)]} - {"109", "110", "111", "214", "215", "216"}
# build_routes.py がバイパス扱いにする目印。値は、番号のないリレーション(西九州自動車道など)に入っている道が "yes"、
# ref が「E35;497」のように高速道路の記号と一緒のもの・nat_ref のものが "coded"、ref が番号だけのものが "plain"。
# "coded"・"plain" には県道の番号(知多半島道路の ref=55 など)が混じるので、build_routes.py で国道のそばのものだけ残す
MOTORWAY_TAG = "_kokudo_motorway"
CODED_REF = re.compile(r"[A-Za-z]\d")


def national_refs_of(tags: osmium.osm.TagList) -> list[str]:
    """自動車専用道路の ref・nat_ref に入っている国道の番号(「E35;497」→ 497)"""
    out = []
    for key in ("ref", "nat_ref"):
        for r in re.split(r"[;,]", tags.get(key, "")):
            r = r.strip()
            if r in NATIONAL_REFS and r not in out:
                out.append(r)
    return out


class MotorwayHandler(osmium.SimpleHandler):
    """国道のリレーションに入っていない、国道の番号を持つ自動車専用道路(ランプは除く)"""

    def __init__(self, numbered: set[int], members: set[int]) -> None:
        super().__init__()
        self.numbered = numbered  # 番号のある国道のリレーションに入っている道(そのまま国道として数える)
        self.members = members  # 国道のリレーションに入っている道(番号のない「西九州自動車道」のリレーションなども)
        self.by_ref: dict[str, list[int]] = defaultdict(list)
        self.ways: list[dict] = []
        self.marked: set[int] = set()  # リレーションには入っているが番号のない道。形は WayHandler が取る
        self.km: dict[str, float] = defaultdict(float)
        self.names: dict[str, set[str]] = defaultdict(set)

    def way(self, w: osmium.osm.Way) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if w.id in self.numbered or not (hw == "motorway" or (hw == "trunk" and tags.get("motorroad") == "yes")):
            return
        # 首都高・阪神高速などの都市高速の路線番号(「1号羽田線」の 1 など)は国道の番号ではない
        if any(o in tags.get("operator", "") for o in URBAN_OPERATORS) or URBAN_NAME.search(tags.get("name", "")):
            return
        refs = national_refs_of(tags)
        if not refs:
            return
        geometry = [{"lon": n.lon, "lat": n.lat} for n in w.nodes if n.location.valid()]
        length = sum(dist((geometry[i - 1]["lon"], geometry[i - 1]["lat"]), (geometry[i]["lon"], geometry[i]["lat"]))
                     for i in range(1, len(geometry)))
        for r in refs:
            self.by_ref[r].append(w.id)
            self.km[r] += length / 1000
            self.names[r].add(tags.get("name", "(名前なし)"))
        if w.id in self.members:
            self.marked.add(w.id)
            return
        t = dict(tags)
        coded = CODED_REF.search(tags.get("ref", "")) or any(r.strip() in NATIONAL_REFS for r in re.split(r"[;,]", tags.get("nat_ref", "")))
        t[MOTORWAY_TAG] = "coded" if coded else "plain"
        self.ways.append({"type": "way", "id": w.id, "tags": t, "geometry": geometry})


def is_national_route(tags: osmium.osm.TagList) -> bool:
    return (
        tags.get("type") == "route"
        and tags.get("route") in ("road", "ferry")
        and tags.get("network") == "JP:national"
    )


class RelationHandler(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.relations: list[dict] = []
        self.way_ids: set[int] = set()
        self.numbered: set[int] = set()  # 国道の番号のあるリレーションに入っている道

    def relation(self, r: osmium.osm.Relation) -> None:
        if not is_national_route(r.tags):
            return
        members = [{"type": "way", "ref": m.ref} for m in r.members if m.type == "w"]
        self.way_ids.update(m["ref"] for m in members)
        if any(r.strip() in NATIONAL_REFS for r in re.split(r"[;,]", unicodedata.normalize("NFKC", r.tags.get("ref", "")))):
            self.numbered.update(m["ref"] for m in members)
        self.relations.append({"type": "relation", "id": r.id, "tags": dict(r.tags), "members": members})


class WayHandler(osmium.SimpleHandler):
    def __init__(self, wanted: set[int], marked: set[int] | None = None) -> None:
        super().__init__()
        self.wanted = wanted
        self.marked = marked or set()
        self.ways: list[dict] = []

    def way(self, w: osmium.osm.Way) -> None:
        if w.id not in self.wanted:
            return
        geometry = [{"lon": n.lon, "lat": n.lat} for n in w.nodes if n.location.valid()]
        tags = dict(w.tags)
        if w.id in self.marked:
            tags[MOTORWAY_TAG] = "yes"
        self.ways.append({"type": "way", "id": w.id, "tags": tags, "geometry": geometry})


def main() -> None:
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]

    rels = RelationHandler()
    rels.apply_file(src)

    extra_rels: list[dict] = []
    extra_ways: list[dict] = []
    marked: set[int] = set()
    if len(sys.argv) == 4:
        mw = MotorwayHandler(rels.numbered, rels.way_ids)
        mw.apply_file(sys.argv[3], locations=True, idx="flex_mem")
        # 番号ごとに、その道だけをまとめたリレーションを作る(build_routes.py はリレーションから路線を読む)
        for i, (ref, ids) in enumerate(sorted(mw.by_ref.items(), key=lambda kv: int(kv[0])), 1):
            extra_rels.append({"type": "relation", "id": -i, "members": [{"type": "way", "ref": w} for w in ids],
                               "tags": {"type": "route", "route": "road", "network": "JP:national", "ref": ref}})
        extra_ways = mw.ways
        marked = mw.marked
        print(f"国道のリレーションに入っていない(番号のないリレーションだけの)自動車専用道路: {len(extra_ways) + len(marked)} 本",
              file=sys.stderr)
        for ref in sorted(mw.by_ref, key=int):
            print(f"  国道{ref}号: {mw.km[ref]:.1f} km(上下線とも)  {' / '.join(sorted(mw.names[ref])[:6])}", file=sys.stderr)

    ways = WayHandler(rels.way_ids, marked)
    ways.apply_file(src, locations=True, idx="flex_mem")

    with open(out, "w") as f:
        json.dump({"elements": rels.relations + extra_rels + ways.ways + extra_ways}, f)
    print(f"路線 {len(rels.relations)} 件 / 道路 {len(ways.ways)} 本 → {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
