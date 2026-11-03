"""確認用: 国道データ(routes.json)を Wikipedia の各国道の記事(延長・通過する都道府県)と比べ、大きく違う路線をログに出す。"""
import json
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, "scripts")
from fetch_wiki_prefroads import PREFS, fetch_many  # noqa: E402

d = json.load(open(sys.argv[1]))
km = defaultdict(Counter)
pref_km = defaultdict(Counter)
for s in d["segments"]:
    f = 0.5 if "pair" in s else 1
    for r in s["routes"]:
        km[r][s["cats"][0]] += s["len"] * f / 1000
        if s["cats"][0] != "old":
            pref_km[r][s.get("pref")] += s["len"] * f / 1000
refs = sorted(d["routes"], key=int)
arts = fetch_many([f"国道{r}号" for r in refs])
num = re.compile(r"([\d,]+(?:\.\d+)?)\s*(?:km|キロメートル)")
rows = []
for r in refs:
    art = arts.get(f"国道{r}号")
    if not art:
        print(f"国道{r}号: 記事なし")
        continue
    text = art[1]
    vals = {}
    for key in ("総延長", "実延長", "現道", "陸上区間"):
        m = re.search(rf"\|\s*{key}\s*=\s*([^\n]*)", text)
        if m:
            n = num.search(m.group(1))
            if n:
                vals[key] = float(n.group(1).replace(",", ""))
    real = vals.get("実延長") or vals.get("現道") or vals.get("総延長")
    ours = km[r]["main"] + km[r]["bypass"] + km[r]["dotted"]
    mentioned = {i + 1 for i, p in enumerate(PREFS) if p in text or p[:-1] + "府" in text}
    extra = {p: round(v, 1) for p, v in pref_km[r].items() if p and p not in mentioned and v > 0.5}
    rows.append((r, ours, km[r]["main"], real, vals, extra))
    if real is None:
        print(f"国道{r}号: 延長が読めない {vals}")
bad = [x for x in rows if x[3] and not (0.7 <= x[1] / x[3] <= 1.6)]
print(f"延長を比べた路線 {sum(1 for x in rows if x[3])} / {len(refs)}、大きく違う路線 {len(bad)}")
for r, ours, main, real, vals, extra in sorted(bad, key=lambda x: -abs(x[1] - x[3])):
    print(f"  [延長] 国道{r}号: データ {ours:.1f}km(現道 {main:.1f}) / Wikipedia {vals}")
odd = [x for x in rows if x[5]]
print(f"記事に出てこない都道府県に区間がある路線 {len(odd)}")
for r, ours, main, real, vals, extra in sorted(odd, key=lambda x: -sum(x[5].values())):
    print(f"  [都道府県] 国道{r}号: {{{', '.join(f'{PREFS[p - 1]} {v}km' for p, v in extra.items())}}}")
