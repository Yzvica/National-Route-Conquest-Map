import { describe, expect, it } from "vitest";
import { RoadGraph, dist, planNavi, type NaviPlan } from "./navi";
import { buildGuide, simplify, turnAngle, turnWord } from "./naviGuide";
import type { LonLat, Segment } from "./types";

const seg = (id: string, routes: string[], coords: LonLat[]): Segment => ({
  id,
  routes,
  cats: ["main"],
  len: coords.slice(1).reduce((s, c, i) => s + dist(coords[i], c), 0),
  coords,
});
const ok = (r: ReturnType<typeof planNavi>): NaviPlan => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
const name = (ref: string) => `国道${ref}号`;

describe("turnWord / turnAngle", () => {
  it("角度を言葉にする(右がプラス)", () => {
    expect(turnWord(5)).toBe("直進");
    expect(turnWord(-40)).toBe("斜め左");
    expect(turnWord(90)).toBe("右折");
    expect(turnWord(-170)).toBe("Uターン");
  });
  it("東へ進んでから北へ曲がると左に約90度", () => {
    const path: LonLat[] = [
      [140.0, 38.0],
      [140.01, 38.0],
      [140.01, 38.01],
    ];
    const acc = [0, dist(path[0], path[1]), dist(path[0], path[1]) + dist(path[1], path[2])];
    expect(turnAngle(path, acc, acc[1])).toBeCloseTo(-90, 0);
  });
});

describe("simplify", () => {
  it("まっすぐな点は間引き、残す点は残す", () => {
    const path: LonLat[] = Array.from({ length: 11 }, (_, i) => [140 + i * 0.001, 38] as LonLat);
    expect(simplify(path, 3, new Set())).toEqual([0, 10]);
    expect(simplify(path, 3, new Set([4]))).toEqual([0, 4, 10]);
  });
});

describe("buildGuide", () => {
  // 国道1号を東へ 2km → 交差点で国道2号へ左折して北へ 2km。1号は交差点の先へも続く
  const r1 = [seg("a1", ["1"], [[140.0, 38.0], [140.0228, 38.0]]), seg("a2", ["1"], [[140.0228, 38.0], [140.04, 38.0]])];
  const r2 = [seg("b1", ["2"], [[140.0228, 38.0], [140.0228, 38.018]])];
  // 国道3号: 同じ道のまま交差点で右折する(交差点の先へは別の国道4号が続く)
  const r3 = [seg("c1", ["3"], [[140.1, 38.0], [140.12, 38.0]]), seg("c2", ["3"], [[140.12, 38.0], [140.12, 37.98]])];
  const r4 = [seg("d1", ["4"], [[140.12, 38.0], [140.14, 38.0]])];

  it("道が変わる所で、曲がる向きと先の道を案内する。最後は目的地", () => {
    const plan = ok(planNavi(new RoadGraph([...r1, ...r2]), [{ lon: 140.0, lat: 38.0 }, { lon: 140.0228, lat: 38.018 }]));
    const g = buildGuide(plan, "テスト", name);
    expect(g.man.map((m) => [m.kind, m.text])).toEqual([
      ["road", "左折、国道2号"],
      ["arrive", "目的地"],
    ]);
    expect(g.man[0].at).toBeGreaterThan(1900);
    expect(g.man[0].at).toBeLessThan(2100);
    // 道筋は角の3点まで間引ける。案内の点は角
    expect(g.pts.length).toBe(6);
    expect(g.man[0].i).toBe(1);
    expect(g.roads.map((r) => r.name)).toEqual(["国道1号", "国道2号"]);
  });

  it("同じ道のまま交差点で曲がる所も案内する", () => {
    const plan = ok(planNavi(new RoadGraph([...r3, ...r4]), [{ lon: 140.1, lat: 38.0 }, { lon: 140.12, lat: 37.98 }]));
    expect(plan.junctions.length).toBeGreaterThan(0);
    const g = buildGuide(plan, "テスト", name);
    expect(g.man.map((m) => [m.kind, m.text])).toEqual([
      ["turn", "右折、国道3号"],
      ["arrive", "目的地"],
    ]);
  });

  it("交差点のないカーブは案内しない", () => {
    const curve = [seg("e1", ["5"], [[140.2, 38.0], [140.22, 38.0], [140.22, 38.02]])];
    const plan = ok(planNavi(new RoadGraph(curve), [{ lon: 140.2, lat: 38.0 }, { lon: 140.22, lat: 38.02 }]));
    const g = buildGuide(plan, "テスト", name);
    expect(g.man.map((m) => m.kind)).toEqual(["arrive"]);
  });
});
