import { describe, expect, it } from "vitest";
import { RoadGraph, dist, planNavi, type NaviPlan } from "./navi";
import { courseCardInfo, courseLines } from "./naviView";
import type { LonLat, Segment } from "./types";

const seg = (id: string, routes: string[], coords: LonLat[]): Segment => ({
  id,
  routes,
  cats: ["main"],
  len: coords.slice(1).reduce((s, c, i) => s + dist(coords[i], c), 0),
  coords,
});

describe("コースの画像", () => {
  // 国道1号(走行済み)→ 国道2号(未走行)
  const segs = [seg("a", ["1"], [[140.0, 38.0], [140.05, 38.0]]), seg("b", ["2"], [[140.05, 38.0], [140.1, 38.0]])];
  const p = planNavi(new RoadGraph(segs), [{ lon: 140.0, lat: 38.0 }, { lon: 140.1, lat: 38.0 }], { fresh: (s) => (s.id === "b" ? 1 : 0) }) as NaviPlan;

  it("道筋を、まだ通っていない所で色を分けた線にする", () => {
    const lines = courseLines(p);
    expect(lines.map((l) => l.color)).toEqual(["#7b1fa2", "#ef6c00"]);
    expect(lines.every((l) => !l.dashed)).toBe(true);
    // 線はつながっている
    expect(lines[0].coords[lines[0].coords.length - 1]).toEqual(lines[1].coords[0]);
  });

  it("距離・未走行・通る国道を文字にする", () => {
    const info = courseCardInfo(p, { title: "テスト", mode: "国道だけ", fresh: true, avoidReuse: true, points: 2, routeName: (r) => `国道${r}号` });
    expect(info.subtitle).toBe("国道だけ・未走行を優先・行き帰りの重複を避ける");
    expect(info.tiles[0]).toMatchObject({ label: "距離", unit: "km" });
    expect(Number(info.tiles[1].value)).toBeCloseTo(p.freshLength / 1000, 1);
    expect(info.routes).toEqual([{ label: "通る国道", count: 2, names: ["国道1号", "国道2号"] }]);
  });
});
