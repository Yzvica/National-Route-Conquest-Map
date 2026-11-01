#!/usr/bin/env python3
"""OSM で旧道(国道の旧ルート)がどう書かれているかを調べて表にする(調査用)。

  osmium tags-filter japan-latest.osm.pbf r/network=JP:national w/old_ref w/old_name w/name w/alt_name -o named.osm.pbf
  python3 scripts/survey_old_roads.py named.osm.pbf
"""
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict

import osmium

sys.path.insert(0, __import__("os").path.dirname(__file__))
from build_routes import NOT_ROADS, dist  # noqa: E402

KEYS = ("name", "old_name", "alt_name", "official_name", "loc_name", "short_name", "note", "description")
OLD_WORD = re.compile(r"旧(国道|道|\d|R|街道|県道|.*号)")


class Rels(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.members: set[int] = set()
        self.rel_tags: Counter = Counter()

    def relation(self, r) -> None:
        tags = dict(r.tags)
        if tags.get("network") == "JP:national" and tags.get("type") == "route":
            self.members.update(m.ref for m in r.members if m.type == "w")
        for k, v in tags.items():
            if k.startswith(("old_", "was:", "disused:", "former")) or "旧" in v:
                self.rel_tags[f"{k}={v}"[:80]] += 1


class Ways(osmium.SimpleHandler):
    def __init__(self, members: set[int]) -> None:
        super().__init__()
        self.members = members
        self.km = defaultdict(float)  # (表, 値) -> km
        self.n = Counter()

    def add(self, table: str, value: str, km: float) -> None:
        self.km[(table, value[:60])] += km
        self.n[(table, value[:60])] += 1

    def way(self, w) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if hw is None or hw in NOT_ROADS:
            return
        hits = []
        for k, v in tags:
            if k.startswith(("old_ref", "was:", "historic", "old_highway")):
                hits.append(("key", f"{k}={v}"))
            if k in KEYS and OLD_WORD.search(v):
                hits.append(("name", f"{k}={v}"))
        if not hits:
            return
        pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        km = sum(dist(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000
        current = w.id in self.members
        for table, v in hits:
            self.add(table + ("(現国道)" if current else ""), v, km)
            self.add("highway" + ("(現国道)" if current else ""), f"{table}:{hw}", km)
        if not current and tags.get("old_ref"):
            self.add("old_ref の値", tags["old_ref"], km)
        if not current:
            for k in KEYS:
                v = tags.get(k, "")
                if OLD_WORD.search(v):
                    # 「旧国道1号」「国道1号旧道」「旧1号」などの形を数える
                    shape = re.sub(r"\d+", "N", v)
                    self.add("名前の形", shape, km)


def main() -> None:
    src = sys.argv[1]
    rels = Rels()
    rels.apply_file(src)
    ways = Ways(rels.members)
    ways.apply_file(src, locations=True, idx="flex_mem")

    print("== 旧・old 系のタグを持つリレーション(上位50)")
    for v, n in rels.rel_tags.most_common(50):
        print(f"{n:6d}  {v}")
    tables = sorted({t for t, _ in ways.km})
    for table in tables:
        rows = sorted(((km, v) for (t, v), km in ways.km.items() if t == table), reverse=True)
        total = sum(km for km, _ in rows)
        print(f"\n== {table}: {len(rows)} 種類 / 計 {total:,.1f} km(上位80)")
        for km, v in rows[:80]:
            print(f"{km:9.1f} km {ways.n[(table, v)]:6d} 本  {v}")


if __name__ == "__main__":
    main()
