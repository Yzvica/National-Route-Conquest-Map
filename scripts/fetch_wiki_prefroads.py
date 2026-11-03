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
import urllib.error
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


def fetch_many(titles: list[str]) -> dict[str, tuple[str, str]]:
    """ページの wikitext をまとめて取る(転送はたどる)。頼んだ題名 → (本当の題名, wikitext)。無いページは入らない"""
    out: dict[str, tuple[str, str]] = {}
    for k in range(0, len(titles), 50):
        chunk = titles[k:k + 50]
        q = urllib.parse.urlencode({
            "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
            "titles": "|".join(chunk), "redirects": 1, "format": "json", "formatversion": 2,
        })
        req = urllib.request.Request(API, data=q.encode(), headers={"User-Agent": UA})
        data = None
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.load(r)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 5:
                    print(f"  {chunk[0]} ほか: 取得できません ({e})", file=sys.stderr)
                    break
                # 続けて取りすぎると 429 が返るので、待ってからやり直す
                wait = 5 * 2 ** attempt
                if isinstance(e, urllib.error.HTTPError) and e.headers.get("Retry-After", "").isdigit():
                    wait = max(wait, int(e.headers["Retry-After"]))
                time.sleep(wait)
        time.sleep(1.5)
        if not data:
            continue
        q = data.get("query", {})
        back: dict[str, str] = {t: t for t in chunk}
        for key in ("normalized", "redirects"):
            for n in q.get(key, []):
                for orig, cur in list(back.items()):
                    if cur == n["from"]:
                        back[orig] = n["to"]
        pages = {pg["title"]: pg for pg in q.get("pages", []) if not pg.get("missing") and pg.get("revisions")}
        for orig, cur in back.items():
            pg = pages.get(cur)
            if pg:
                out[orig] = (cur, pg["revisions"][0]["slots"]["main"]["content"])
    return out


def strip_markup(s: str) -> str:
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "")
    return unicodedata.normalize("NFKC", s).strip()


# 起点・終点の市町村名(「横浜市中区」→横浜市、「愛甲郡愛川町」→愛川町、「千代田区」など)
TOKEN = re.compile(r"[^\s、,・()（）「」\[\]|]+")
PREF_HEAD = re.compile("^(?:" + "|".join(PREFS) + ")")
MUNI_ORDER = [re.compile(r"^.+?市(?!市)"), re.compile(r"^.+?[町村]"), re.compile(r"^.+?区")]


def first_muni(text: str) -> str | None:
    for tok in TOKEN.findall(strip_markup(text)):
        tok = PREF_HEAD.sub("", tok)
        tok = re.sub(r"^.+?郡", "", tok)
        for pat in MUNI_ORDER:
            m = pat.match(tok)
            if m and len(m.group(0)) >= 2:
                return m.group(0)
    return None


# 路線の名前に出てくる都道府県道の呼び方(「神奈川県道」「北海道道」)
ROADS = "|".join(re.escape("北海道道" if p == "北海道" else p + "道") for p in PREFS)
ROUTE = re.compile(rf"((?:{ROADS})(?:・(?:{ROADS}))*)\s*(\d+)\s*号")
LINK = re.compile(r"\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]")
ENDS = re.compile(r"(起点|終点|主な経由都市)\s*[=:：]\s*([^\n]+)")
COORD = re.compile(r"\{\{\s*[Cc]oord\s*\|([^}]*)\}\}")


def coord(text: str) -> list[float] | None:
    """{{Coord|43|3|50.4|N|141|21|58.7|E|…}} や {{Coord|35.1|139.2|…}} → [経度, 緯度]"""
    m = COORD.search(text)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split("|")]
    try:
        if "N" in parts or "S" in parts:
            i = parts.index("N") if "N" in parts else parts.index("S")
            j = next(k for k in range(i + 1, len(parts)) if parts[k] in ("E", "W"))
            dms = lambda xs: sum(float(x) / 60 ** n for n, x in enumerate(xs) if x)  # noqa: E731
            lat, lon = dms(parts[:i]), dms(parts[i + 1:j])
        else:
            lat, lon = float(parts[0]), float(parts[1])
    except (ValueError, StopIteration, IndexError):
        return None
    if 20 < lat < 46 and 122 < lon < 154:
        return [round(lon, 5), round(lat, 5)]
    return None


def route_in(pref: str, text: str) -> tuple[str, str] | None:
    """text の中で最初に出てくる、この都道府県の路線 → (番号, 名前)"""
    own = "北海道道" if pref == "北海道" else pref + "道"
    for m in ROUTE.finditer(text):
        if own in m.group(1).split("・"):
            rest = re.match(r"[^\]|\n<{}（(、。]*", text[m.end():]).group(0).strip()
            return str(int(m.group(2))), f"{own}{int(m.group(2))}号{rest}"
    return None


def parse(pref: str, text: str) -> dict[str, dict]:
    """一覧の wikitext から 番号 → {name, title(記事), from, to}。表の行と箇条書きのどちらにも対応する"""
    routes: dict[str, dict] = {}

    def add(unit: str, cells: list[str]) -> None:
        if re.match(r"^[*#:]{2}", unit) or re.search(r"^[*#:]?\s*\(?\d*\)?\s*(?:旧・|元・)", unit):
            return  # 下の階層(「旧・〇〇線 廃止」など)は今の路線ではない
        found = None
        for t in LINK.findall(unit):
            r = route_in(pref, t)
            if r:
                found = (*r, t)
                break
        if not found:
            r = route_in(pref, strip_markup(unit))
            if not r:
                return
            found = (*r, None)
        ref, name, title = found
        if ref in routes:
            return
        info: dict = {"name": name}
        if title:
            info["title"] = title
        ends = [m for m in (first_muni(c) for c in cells) if m]
        if len(ends) >= 2:
            info["from"], info["to"] = ends[0], ends[1]
        routes[ref] = info

    # 表: 行(|- で区切る)ごとに、最初に出てくる路線と、そのあとのセルの市町村名(起点・終点の順に並んでいる)
    if "{|" in text:
        for row in re.split(r"\n\|-[^\n]*", text):
            cells = [c for c in re.split(r"\|\||\n[|!]", row) if c.strip()]
            for j, c in enumerate(cells):
                if route_in(pref, c) or any(route_in(pref, t) for t in LINK.findall(c)):
                    add(c, cells[j + 1:])
                    break
    # 箇条書き(* 3 [[東京都道・神奈川県道3号世田谷町田線|神奈川県道3号世田谷町田線]] など)
    for line in text.splitlines():
        if line.startswith(("*", "#", ":")):
            add(line, [])
    return routes


def ends_of_article(text: str) -> dict | None:
    """路線の記事(基本情報の表など)から 起点・終点の市町村(と、あれば座標)、主な経由地"""
    got: dict = {}
    for m in ENDS.finditer(text):
        key = {"起点": "from", "終点": "to", "主な経由都市": "via"}[m.group(1)]
        if key in got:
            continue
        if key == "via":
            vias = [v for v in (first_muni(t) for t in re.split(r"[、,・]|\]\]\s*\[\[", m.group(2))) if v]
            if vias:
                got["via"] = list(dict.fromkeys(vias))
            continue
        muni = first_muni(m.group(2))
        if muni:
            got[key] = muni
            pt = coord(m.group(2))
            if pt:
                got[key + "_pt"] = pt
    return got if "from" in got and "to" in got else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--raw-dir", type=Path, help="取得した一覧の wikitext を置く(確認用)")
    ap.add_argument("--sample", action="store_true", help="記事の書き方の確認用に、一部をログに出す")
    ap.add_argument("--no-articles", action="store_true", help="路線ごとの記事は読まない(一覧だけ)")
    args = ap.parse_args()
    lists = fetch_many([t for p in PREFS for t in page_titles(p)])
    out: dict[str, dict] = {}
    for code, pref in enumerate(PREFS, 1):
        got = next((lists[t] for t in page_titles(pref) if t in lists), None)
        if not got:
            print(f"  {pref}: 一覧のページが見つかりません", file=sys.stderr)
            continue
        title, text = got
        if args.raw_dir:
            args.raw_dir.mkdir(parents=True, exist_ok=True)
            (args.raw_dir / f"{code:02d}.txt").write_text(f"{title}\n{text}", encoding="utf-8")
        routes = parse(pref, text)
        if routes:
            out[str(code)] = routes

    # 一覧に起点・終点が無い路線は、路線の記事から取る
    if not args.no_articles:
        want = sorted({r["title"] for rs in out.values() for r in rs.values() if "title" in r and "from" not in r})
        print(f"  路線の記事 {len(want)} 件を読みます", file=sys.stderr)
        arts = fetch_many(want)
        shown = 0
        for rs in out.values():
            for r in rs.values():
                art = arts.get(r.get("title", ""))
                if "from" in r or not art:
                    continue
                ends = ends_of_article(art[1])
                if ends:
                    r.update(ends)
                if args.sample and shown < 6:
                    shown += 1
                    print(f"    [{art[0]}] → {ends}", file=sys.stderr)
                    for line in art[1].splitlines()[:40]:
                        if "点" in line or "経由" in line:
                            print(f"    | {line[:200]}", file=sys.stderr)
    for code, rs in out.items():
        with_ends = sum(1 for r in rs.values() if "from" in r)
        print(f"  {PREFS[int(code) - 1]}: {len(rs)} 路線(起点・終点あり {with_ends})", file=sys.stderr)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"{len(out)} 都道府県 → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
