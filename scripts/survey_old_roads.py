#!/usr/bin/env python3
"""OSM で旧道(国道の旧ルート)がどう書かれているかを調べて表にする(調査用)。

  手順は .github/workflows/update-data.yml の target=survey-old を参照
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


OTHER_KEYS = ("old_ref", "was:ref", "historic", "old_highway", "was:highway")


class Ways(osmium.SimpleHandler):
    """1回目: 位置なしで、旧道らしい way を探す(速くするため決まったキーだけ見る)"""

    def __init__(self, members: set[int]) -> None:
        super().__init__()
        self.members = members
        self.found: dict[int, tuple[bool, str, list[tuple[str, str]]]] = {}

    def way(self, w) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if hw is None or hw in NOT_ROADS:
            return
        hits = []
        for k in OTHER_KEYS:
            v = tags.get(k)
            if v:
                hits.append(("key", f"{k}={v}"))
        for k in KEYS:
            v = tags.get(k)
            if v and "旧" in v and OLD_WORD.search(v):
                hits.append(("name", f"{k}={v}"))
        if hits:
            self.found[w.id] = (w.id in self.members, hw, hits)


class Lengths(osmium.SimpleHandler):
    """2回目: 見つけた way だけを含むファイルで長さを測る"""

    def __init__(self) -> None:
        super().__init__()
        self.km: dict[int, float] = {}

    def way(self, w) -> None:
        pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        self.km[w.id] = sum(dist(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000


def main() -> None:
    # 使い方: survey_old_roads.py kokudo.osm.pbf hw.osm.pbf ids.txt  → ids.txt を osmium getid に渡す
    #         survey_old_roads.py --report found.json cand.osm.pbf
    import json
    if sys.argv[1] != "--report":
        kokudo, hw, ids = sys.argv[1:4]
        rels = Rels()
        rels.apply_file(kokudo)
        ways = Ways(rels.members)
        ways.apply_file(hw)
        with open(ids, "w") as f:
            f.writelines(f"w{i}\n" for i in ways.found)
        with open(ids + ".json", "w") as f:
            json.dump({"found": {str(k): v for k, v in ways.found.items()}, "rel_tags": rels.rel_tags.most_common(50)}, f, ensure_ascii=False)
        print(f"候補 {len(ways.found)} 本", file=sys.stderr)
        return
    found_path, cand = sys.argv[2:4]
    j = json.load(open(found_path))
    lens = Lengths()
    lens.apply_file(cand, locations=True, idx="flex_mem")
    km_ = defaultdict(float)
    n = Counter()

    def add(table: str, value: str, km: float) -> None:
        km_[(table, value[:60])] += km
        n[(table, value[:60])] += 1

    for wid, (current, hw, hits) in j["found"].items():
        km = lens.km.get(int(wid), 0.0)
        suffix = "(現国道)" if current else ""
        for table, v in hits:
            add(table + suffix, v, km)
            add("highway" + suffix, f"{table}:{hw}", km)
            if not current:
                k, _, val = v.partition("=")
                if table == "key":
                    add(f"{k} の値", val, km)
                else:
                    add("名前の形", re.sub(r"\d+", "N", val), km)

    print("== 旧・old 系のタグを持つリレーション(上位50)")
    for v, c in j["rel_tags"]:
        print(f"{c:6d}  {v}")
    for table in sorted({t for t, _ in km_}):
        rows = sorted(((km, v) for (t, v), km in km_.items() if t == table), reverse=True)
        total = sum(km for km, _ in rows)
        print(f"\n== {table}: {len(rows)} 種類 / 計 {total:,.1f} km(上位80)")
        for km, v in rows[:80]:
            print(f"{km:9.1f} km {n[(table, v)]:6d} 本  {v}")


if __name__ == "__main__":
    main()
