"""確認用: 一般国道の自動車専用道路(西九州道・三陸道など)が OSM でどう書かれているかをログに出す。"""
import sys
from collections import Counter

import osmium

NAMES = ("西九州自動車道", "三陸沿岸道路", "神戸淡路鳴門自動車道", "山陰自動車道", "東九州自動車道", "南阪奈道路",
         "第二神明道路", "小田原厚木道路", "新湘南バイパス", "名四国道", "首都圏中央連絡自動車道", "京葉道路")
keys = Counter()
ex = {}


class W(osmium.SimpleHandler):
    def way(self, w):
        t = dict(w.tags)
        if t.get("highway") != "motorway":
            return
        for k in t:
            keys[k] += 1
        n = t.get("name", "")
        for name in NAMES:
            if name in n and name not in ex:
                ex[name] = (w.id, t)


class R(osmium.SimpleHandler):
    def relation(self, r):
        t = dict(r.tags)
        n = t.get("name", "") + t.get("official_name", "")
        if t.get("type") in ("route", "route_master") and any(x in n for x in NAMES):
            print("  [relation]", r.id, {k: v for k, v in t.items() if not k.startswith("name:")}, "members", len(r.members))


W().apply_file(sys.argv[1])
print("motorway のタグ:", keys.most_common(40))
for k, v in ex.items():
    print("  [way]", k, v)
R().apply_file(sys.argv[2])
