#!/usr/bin/env python3
"""国道の旧道(バイパスができて国道でなくなった旧ルートなど)を OSM から取り出し、
routes.json に種別 "old" の区間として加える。旧道は今の国道ではないので、アプリでは別枠で数える。

  osmium tags-filter japan-latest.osm.pbf r/network=JP:national -o kokudo.osm.pbf
  osmium tags-filter japan-latest.osm.pbf w/highway -o hw.osm.pbf
  python3 scripts/build_old_roads.py find kokudo.osm.pbf hw.osm.pbf old-ids.txt
  osmium getid -r hw.osm.pbf -i old-ids.txt -o old.osm.pbf
  python3 scripts/build_old_roads.py add old-ids.txt.json old.osm.pbf routes.json

旧道とみなす道(今の国道のリレーションに入っていない道路だけ):
- old_ref が「国道1号」のように国道の番号を指しているもの
- 名前(name・old_name・alt_name など)が「旧国道1号」「旧1号」「国道1号旧道」のように番号付きで旧道を表すもの
- 名前が「旧道」「旧国道」「○○旧道」のように番号のないもの。両端の近くを通る国道の旧道とする

pyosmium が必要です(pip install osmium)。
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_routes import NOT_ROADS, SEGMENT_LENGTH, SIMPLIFY_METERS, dist, rnd, simplify, split_line  # noqa: E402

NAME_KEYS = ("name", "old_name", "alt_name", "official_name", "loc_name", "short_name")
# 車で走れない道は旧道に数えない(旧道の峠道が歩道になっているものなど)
SKIP_HIGHWAYS = NOT_ROADS | {"footway", "steps", "path", "cycleway", "bridleway", "pedestrian", "corridor", "elevator", "platform", "bus_stop", "services", "rest_area", "proposed"}

# 番号付きの旧道の名前
NUMBERED = [
    re.compile(r"旧国道\s*(\d{1,3})\s*号"),
    re.compile(r"旧\s*(?:国道|R)?\s*(\d{1,3})\s*号"),
    re.compile(r"国道\s*(\d{1,3})\s*号線?\s*[(（]?\s*旧道"),
    re.compile(r"旧R\s*(\d{1,3})(?!\d)"),
]
# 番号のない旧道の名前(「旧道」「旧国道」「○○旧道」)
UNNUMBERED = re.compile(r"(旧国道|旧道)(?:[(（].*[)）])?$")
OLD_REF = re.compile(r"(?:国道|R|N)\s*(\d{1,3})\s*号?")
NEAR = 150.0  # m。番号のない旧道の端が、国道からこれ以内なら、その国道の旧道とする
# old_ref が数字だけ("1")のときも国道の番号とみなす
OLD_REF_DIGITS = True
VALID_REFS = {str(n) for n in [*range(1, 59), *range(101, 508)]}


def norm(v: str) -> str:
    return unicodedata.normalize("NFKC", v)


def classify(tags) -> tuple[set[str], bool, str]:
    """(旧道の国道番号, 番号のない旧道か, 表示用の名前)。旧道でなければ番号は空・False"""
    refs: set[str] = set()
    old_ref = norm(tags.get("old_ref", "") or "")
    for part in old_ref.split(";"):
        part = part.strip()
        if re.search(r"(県道|都道|府道|道道|市道|町道|村道|E\d)", part):
            continue
        m = OLD_REF.fullmatch(part) or (re.fullmatch(r"(\d{1,3})", part) if OLD_REF_DIGITS else None)
        if m:
            refs.add(str(int(m.group(1))))
    unnumbered = False
    label = ""
    for k in NAME_KEYS:
        v = norm(tags.get(k, "") or "")
        if "旧" not in v:
            continue
        found = {str(int(m.group(1))) for pat in NUMBERED for m in pat.finditer(v)}
        if found:
            refs |= found
            label = label or v
        elif UNNUMBERED.search(v):
            unnumbered = True
            label = label or v
    refs &= VALID_REFS
    return refs, unnumbered and not refs, label or norm(tags.get("name", "") or "")


class Rels(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.members: set[int] = set()

    def relation(self, r) -> None:
        if r.tags.get("network") == "JP:national" and r.tags.get("type") == "route":
            self.members.update(m.ref for m in r.members if m.type == "w")


class Find(osmium.SimpleHandler):
    """1回目: 位置なしで、旧道の way を探す"""

    def __init__(self, members: set[int]) -> None:
        super().__init__()
        self.members = members
        self.found: dict[int, dict] = {}

    def way(self, w) -> None:
        tags = w.tags
        hw = tags.get("highway")
        if hw is None or hw in SKIP_HIGHWAYS or w.id in self.members:
            return
        if "old_ref" not in tags and not any("旧" in (tags.get(k) or "") for k in NAME_KEYS):
            return
        refs, unnumbered, label = classify(tags)
        if refs or unnumbered:
            self.found[w.id] = {
                "refs": sorted(refs, key=int),
                "unnumbered": unnumbered,
                "name": label,
                "tunnel": tags.get("tunnel") not in (None, "no"),
            }


class Geom(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.ways: dict[int, tuple[list[tuple[float, float]], int, int]] = {}

    def way(self, w) -> None:
        pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(pts) >= 2:
            self.ways[w.id] = (pts, w.nodes[0].ref, w.nodes[len(w.nodes) - 1].ref)


def _point_seg_dist(p, a, b) -> float:
    from build_routes import _point_seg_dist as f

    return f(p, a, b)


class RouteGrid:
    """今の国道の区間を格子に入れて、ある点の近くを通る国道を引けるようにする"""

    CELL = 0.002  # 度(約200m)

    def __init__(self, segments: list[dict]) -> None:
        self.segments = segments
        self.grid: dict[tuple[int, int], list[int]] = {}
        for i, s in enumerate(segments):
            if "old" in s["cats"] or "ferry" in s["cats"]:
                continue
            for p in s["coords"]:
                self.grid.setdefault(self._cell(p), []).append(i)

    def _cell(self, p) -> tuple[int, int]:
        return int(p[0] / self.CELL), int(p[1] / self.CELL)

    def refs_near(self, p) -> set[str]:
        gx, gy = self._cell(p)
        out: set[str] = set()
        seen: set[int] = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.grid.get((gx + dx, gy + dy), []):
                    if i in seen:
                        continue
                    seen.add(i)
                    c = self.segments[i]["coords"]
                    if any(_point_seg_dist(p, c[j - 1], c[j]) <= NEAR for j in range(1, len(c))):
                        out.update(self.segments[i]["routes"])
        return out


def assign_unnumbered(found: dict[int, dict], geom: Geom, grid: RouteGrid) -> int:
    """番号のない旧道を、つながっている道ごとにまとめ、両端の近くを通る国道の旧道とする。番号を付けた本数を返す"""
    ids = [w for w, f in found.items() if f["unnumbered"] and w in geom.ways]
    by_node: dict[int, list[int]] = {}
    for w in ids:
        _, a, b = geom.ways[w]
        by_node.setdefault(a, []).append(w)
        by_node.setdefault(b, []).append(w)
    done: set[int] = set()
    assigned = 0
    for start in ids:
        if start in done:
            continue
        group, stack = [], [start]
        done.add(start)
        while stack:
            w = stack.pop()
            group.append(w)
            _, a, b = geom.ways[w]
            for n in (a, b):
                for x in by_node[n]:
                    if x not in done:
                        done.add(x)
                        stack.append(x)
        # まとまりの端(ほかの旧道とつながっていない端)
        ends = []
        for w in group:
            pts, a, b = geom.ways[w]
            if len(by_node[a]) == 1:
                ends.append(pts[0])
            if len(by_node[b]) == 1:
                ends.append(pts[-1])
        if not ends:  # 輪になっている
            ends = [geom.ways[group[0]][0][0]]
        near = [grid.refs_near(p) for p in ends]
        common = set.intersection(*near) if near else set()
        refs = common or (near[0] if len(ends) == 1 else set())
        refs &= VALID_REFS
        if not refs:
            continue
        for w in group:
            found[w]["refs"] = sorted(refs, key=int)
            assigned += 1
    return assigned


def build_segments(found: dict[int, dict], geom: Geom, routes: dict) -> tuple[list[dict], list[dict]]:
    segments, tunnels = [], []
    for wid, f in found.items():
        refs = [r for r in f["refs"] if r in routes]
        if not refs or wid not in geom.ways:
            continue
        coords = geom.ways[wid][0]
        tunnel_id = None
        if f["tunnel"]:
            tunnel_id = f"t{wid}"
            length = sum(dist(coords[i - 1], coords[i]) for i in range(1, len(coords)))
            tunnels.append({"id": tunnel_id, "a": rnd(coords[0]), "b": rnd(coords[-1]), "len": round(length)})
        for i, piece in enumerate(split_line(coords, SEGMENT_LENGTH)):
            seg = {
                "id": f"w{wid}-{i}",
                "routes": refs,
                "cats": ["old"],
                "len": round(sum(dist(piece[j - 1], piece[j]) for j in range(1, len(piece))), 1),
                "coords": [rnd(p) for p in simplify(piece, SIMPLIFY_METERS)],
            }
            if f["name"]:
                seg["name"] = f["name"]
            if tunnel_id:
                seg["tunnel"] = tunnel_id
            segments.append(seg)
    return segments, tunnels


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("find", "add"):
        sys.exit(__doc__)
    if sys.argv[1] == "find":
        kokudo, hw, ids = sys.argv[2:5]
        rels = Rels()
        rels.apply_file(kokudo)
        finder = Find(rels.members)
        finder.apply_file(hw)
        Path(ids).write_text("".join(f"w{i}\n" for i in finder.found))
        Path(ids + ".json").write_text(json.dumps({str(k): v for k, v in finder.found.items()}, ensure_ascii=False))
        n_num = sum(1 for f in finder.found.values() if f["refs"])
        print(f"旧道の候補 {len(finder.found)} 本(番号あり {n_num} 本)", file=sys.stderr)
        return

    found_path, cand, routes_path = sys.argv[2:5]
    found = {int(k): v for k, v in json.loads(Path(found_path).read_text()).items()}
    geom = Geom()
    geom.apply_file(cand, locations=True, idx="flex_mem")
    data = json.loads(Path(routes_path).read_text())
    # 作り直すときのために、前に加えた旧道(とそのトンネル)は除いておく
    data["segments"] = [s for s in data["segments"] if "old" not in s["cats"]]
    used = {s["tunnel"] for s in data["segments"] if "tunnel" in s}
    data["tunnels"] = [t for t in data["tunnels"] if t["id"] in used]

    grid = RouteGrid(data["segments"])
    assigned = assign_unnumbered(found, geom, grid)
    segments, tunnels = build_segments(found, geom, data["routes"])
    data["segments"] += segments
    have = {t["id"] for t in data["tunnels"]}
    data["tunnels"] += [t for t in tunnels if t["id"] not in have]
    Path(routes_path).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    km = sum(s["len"] for s in segments) / 1000
    per_route: dict[str, float] = {}
    for s in segments:
        for r in s["routes"]:
            per_route[r] = per_route.get(r, 0) + s["len"] / 1000
    print(f"旧道 {len(segments)} 区間 / {km:,.1f} km / {len(per_route)} 路線(番号のない旧道 {assigned} 本に番号を付けた) → {routes_path}", file=sys.stderr)
    top = sorted(per_route.items(), key=lambda kv: -kv[1])[:30]
    print("旧道の長い国道: " + ", ".join(f"{r}号 {v:.1f}km" for r, v in top), file=sys.stderr)


if __name__ == "__main__":
    main()
