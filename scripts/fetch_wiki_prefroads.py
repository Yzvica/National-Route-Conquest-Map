"""Wikipedia の「〇〇県の県道一覧」から、都道府県道の路線番号・路線名・起点・終点を取り出す。

OSM には市町村道に県道と同じ番号の ref が付いていることがあるので、build_pref_roads.py で
「その番号の県道が本当にあるか」「その道が路線の起点・終点のあたりにあるか」を確かめるのに使う。

  python3 scripts/fetch_wiki_prefroads.py --out wiki_prefroads.json [--raw-dir wiki-raw]

出力: {"13": {"413": {"name": "東京都道413号赤坂杉並線", "from": "港区", "to": "杉並区"}, ...}, ...}
取れなかった都道府県は入れない(build_pref_roads.py はその都道府県では確かめない)。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

PREFS = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]
API = "https://ja.wikipedia.org/w/api.php"
UA = "national-route-conquest-map/1.0 (prefectural road list check)"


def road_kind(pref: str) -> str:
    """都道府県道の呼び方: 東京都→都道、北海道→道道、大阪府→府道、〇〇県→県道"""
    return "道道" if pref == "北海道" else pref[-1] + "道"


def page_titles(pref: str) -> list[str]:
    kind = road_kind(pref)
    return [f"{pref}の{kind}一覧", f"{pref}の{kind}", f"{pref}{kind}一覧"]


def fetch(title: str) -> tuple[str, str] | None:
    """ページの wikitext(転送はたどる)。無ければ None"""
    q = urllib.parse.urlencode({
        "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
        "titles": title, "redirects": 1, "format": "json", "formatversion": 2,
    })
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print(f"  {title}: 取得できません ({e})", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    page = data["query"]["pages"][0]
    if page.get("missing"):
        return None
    return page["title"], page["revisions"][0]["slots"]["main"]["content"]


def strip_markup(s: str) -> str:
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "")
    return unicodedata.normalize("NFKC", s).strip()


# 起点・終点の市町村名(「横浜市」「愛甲郡愛川町」「千代田区」など。郡は取る)
MUNI = re.compile(r"([^\s、,・()（）]+?(?:市|町|村|区))")


def munis(text: str) -> list[str]:
    out = []
    for m in MUNI.finditer(strip_markup(text)):
        name = re.sub(r"^.*郡", "", m.group(1))
        if len(name) >= 2 and name not in out:
            out.append(name)
    return out


def parse(pref: str, text: str) -> dict[str, dict]:
    """一覧の wikitext から 番号 → {name, from, to}。表の行と箇条書きのどちらにも対応する"""
    kind = road_kind(pref)
    head = pref if pref != "北海道" else "北海"
    route = re.compile(rf"(?:{re.escape(head)})?{kind[0]}道\s*(\d+)\s*号\s*([^\]|\n<{{}}]*)")
    routes: dict[str, dict] = {}

    def add(num: str, name: str, rest: str) -> None:
        ref = str(int(num))
        if ref in routes:
            return
        cells = [c for c in re.split(r"\|\||\n\|", rest) if c.strip()]
        names = [munis(c) for c in cells]
        names = [n for n in names if n]
        info = {"name": f"{pref}道{ref}号{strip_markup(name)}".replace(f"{pref}道", f"{pref[:-1] if pref != '北海道' else '北海'}{kind}", 1)}
        if len(names) >= 2:
            info["from"], info["to"] = names[0], names[1]
        elif names:
            info["via"] = names[0]
        routes[ref] = info

    # 表: 行(|- で区切る)ごとに、最初に出てくる路線と、そのあとのセルの市町村名
    if "{|" in text:
        for row in re.split(r"\n\|-[^\n]*", text):
            m = route.search(row)
            if m:
                add(m.group(1), m.group(2), row[m.end():])
    # 箇条書き(* [[神奈川県道1号横浜厚木線]] 横浜市 - 厚木市 など)
    for line in text.splitlines():
        if line.startswith(("*", "#", ":")):
            m = route.search(line)
            if m:
                add(m.group(1), m.group(2), line[m.end():])
    return routes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--raw-dir", type=Path, help="取得した wikitext を置く(確認用)")
    args = ap.parse_args()
    out: dict[str, dict] = {}
    for code, pref in enumerate(PREFS, 1):
        got = None
        for t in page_titles(pref):
            got = fetch(t)
            if got:
                break
            time.sleep(0.5)
        if not got:
            print(f"  {pref}: 一覧のページが見つかりません", file=sys.stderr)
            continue
        title, text = got
        if args.raw_dir:
            args.raw_dir.mkdir(parents=True, exist_ok=True)
            (args.raw_dir / f"{code:02d}.txt").write_text(f"{title}\n{text}", encoding="utf-8")
        routes = parse(pref, text)
        with_ends = sum(1 for r in routes.values() if "from" in r)
        print(f"  {pref}: {title} / {len(routes)} 路線(起点・終点あり {with_ends})", file=sys.stderr)
        if routes:
            out[str(code)] = routes
        time.sleep(0.5)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"{len(out)} 都道府県 → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
