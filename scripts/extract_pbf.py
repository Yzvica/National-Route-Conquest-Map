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
import sys
from collections import defaultdict

import osmium


# 国道の番号(1〜58、101〜507)
NATIONAL_REFS = {str(n) for n in [*range(1, 59), *range(101, 508)]}
# build_routes.py がバイパス扱いにする目印
MOTORWAY_TAG = "_kokudo_motorway"


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

    def __init__(self, known: set[int]) -> None:
        super().__init__()
        self.known = known
        self.by_ref: dict[str, list[int]] = defaultdict(list)
        self.ways: list[dict] = []

    def way(self, w: osmium.osm.Way) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if w.id in self.known or not (hw == "motorway" or (hw == "trunk" and tags.get("motorroad") == "yes")):
            return
        refs = national_refs_of(tags)
        if not refs:
            return
        for r in refs:
            self.by_ref[r].append(w.id)
        geometry = [{"lon": n.lon, "lat": n.lat} for n in w.nodes if n.location.valid()]
        t = dict(tags)
        t[MOTORWAY_TAG] = "yes"
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

    def relation(self, r: osmium.osm.Relation) -> None:
        if not is_national_route(r.tags):
            return
        members = [{"type": "way", "ref": m.ref} for m in r.members if m.type == "w"]
        self.way_ids.update(m["ref"] for m in members)
        self.relations.append({"type": "relation", "id": r.id, "tags": dict(r.tags), "members": members})


class WayHandler(osmium.SimpleHandler):
    def __init__(self, wanted: set[int]) -> None:
        super().__init__()
        self.wanted = wanted
        self.ways: list[dict] = []

    def way(self, w: osmium.osm.Way) -> None:
        if w.id not in self.wanted:
            return
        geometry = [{"lon": n.lon, "lat": n.lat} for n in w.nodes if n.location.valid()]
        self.ways.append({"type": "way", "id": w.id, "tags": dict(w.tags), "geometry": geometry})


def main() -> None:
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]

    rels = RelationHandler()
    rels.apply_file(src)
    ways = WayHandler(rels.way_ids)
    ways.apply_file(src, locations=True, idx="flex_mem")

    extra_rels: list[dict] = []
    extra_ways: list[dict] = []
    if len(sys.argv) == 4:
        mw = MotorwayHandler(rels.way_ids)
        mw.apply_file(sys.argv[3], locations=True, idx="flex_mem")
        # 番号ごとに、その道だけをまとめたリレーションを作る(build_routes.py はリレーションから路線を読む)
        for i, (ref, ids) in enumerate(sorted(mw.by_ref.items(), key=lambda kv: int(kv[0])), 1):
            extra_rels.append({"type": "relation", "id": -i, "members": [{"type": "way", "ref": w} for w in ids],
                               "tags": {"type": "route", "route": "road", "network": "JP:national", "ref": ref}})
        extra_ways = mw.ways
        print(f"国道のリレーションに入っていない自動車専用道路: {len(extra_ways)} 本"
              f"(国道 {', '.join(sorted(mw.by_ref, key=int))} 号)", file=sys.stderr)

    with open(out, "w") as f:
        json.dump({"elements": rels.relations + extra_rels + ways.ways + extra_ways}, f)
    print(f"路線 {len(rels.relations)} 件 / 道路 {len(ways.ways)} 本 → {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
