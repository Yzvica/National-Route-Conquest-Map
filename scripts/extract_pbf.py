#!/usr/bin/env python3
"""OSM の抽出ファイル(.osm.pbf / .osm)から国道の路線と道路を取り出し、
build_routes.py が読める Overpass 形式の JSON にする。

Overpass API は混雑で断られることがあるので、Actions ではこちらを使う。
  python3 scripts/extract_pbf.py japan-latest.osm.pbf raw.json
  python3 scripts/build_routes.py --input raw.json

pyosmium が必要です(pip install osmium)。大きなファイルは先に
osmium-tool で絞り込むと速くなります:
  osmium tags-filter japan-latest.osm.pbf r/network=JP:national -o kokudo.osm.pbf
"""
from __future__ import annotations

import json
import sys

import osmium


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
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]

    rels = RelationHandler()
    rels.apply_file(src)
    ways = WayHandler(rels.way_ids)
    ways.apply_file(src, locations=True, idx="flex_mem")

    with open(out, "w") as f:
        json.dump({"elements": rels.relations + ways.ways}, f)
    print(f"路線 {len(rels.relations)} 件 / 道路 {len(ways.ways)} 本 → {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
